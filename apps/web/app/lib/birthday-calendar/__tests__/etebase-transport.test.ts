// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { birthdayMarkerContent, parseBirthdayMarker } from '@silentsuite/core'
import { createEtebaseBirthdayTransport, BirthdayTransportGateError } from '../etebase-transport'
import { reconcileBirthdays } from '../reconcile'
import type { BirthdayGates } from '../reconcile'

function gates(current = () => true): BirthdayGates {
  return {
    accountEpoch: 3,
    isCurrentEpoch: current,
    canWrite: () => true,
    isOnline: () => true,
    hasSubtleCrypto: () => true,
  }
}

function rootItem(uid: string) {
  return {
    uid,
    etag: `etag-${uid}`,
    encryptedItem: { lastEtag: `etag-${uid}` },
    getContent: vi.fn(async () => ''),
    setContent: vi.fn(async () => {}),
    delete: vi.fn(),
    _clone() { return this },
  }
}

function collection(input: {
  uid: string
  type: string
  accessLevel: number
  content?: string | Error
  members?: Array<Array<{ username: string }>>
  items?: Array<Array<{ uid: string; content: string | Error; deleted?: boolean }>>
}) {
  const item = rootItem(input.uid)
  const memberPages = input.members ?? [[{ username: 'me' }]]
  let memberCall = 0
  const itemPages = input.items ?? [[]]
  let itemCall = 0
  const transaction = vi.fn(async () => {})
  const create = vi.fn(async (_meta: unknown, content: string) => ({
    uid: `created-${create.mock.calls.length}`,
    etag: '',
    encryptedItem: { lastEtag: null },
    content,
    getContent: async () => content,
    setContent: async () => {},
    delete() {},
    _clone() { return this },
  }))
  return {
    uid: input.uid,
    accessLevel: input.accessLevel,
    isDeleted: false,
    item,
    getCollectionType: () => input.type,
    getContent: vi.fn(async () => {
      if (input.content instanceof Error) throw input.content
      return input.content ?? ''
    }),
    itemManager: {
      transaction,
      create,
      list: vi.fn(async () => {
        const page = itemPages[Math.min(itemCall, itemPages.length - 1)] ?? []
        const last = itemCall >= itemPages.length - 1
        itemCall += 1
        return {
          data: page.map((row) => ({
            uid: row.uid,
            etag: `etag-${row.uid}`,
            encryptedItem: { lastEtag: `etag-${row.uid}` },
            isDeleted: row.deleted ?? false,
            getContent: vi.fn(async () => {
              if (row.content instanceof Error) throw row.content
              return row.content
            }),
            setContent: vi.fn(async () => {}),
            delete: vi.fn(),
            _clone() {
              return {
                setContent: vi.fn(async () => {}),
                delete: vi.fn(),
              }
            },
          })),
          stoken: last ? `items-end-${input.uid}` : `items-${input.uid}-${itemCall}`,
          done: last,
        }
      }),
    },
    memberManager: {
      list: vi.fn(async () => {
        const page = memberPages[Math.min(memberCall, memberPages.length - 1)] ?? []
        const last = memberCall >= memberPages.length - 1
        memberCall += 1
        return {
          data: page,
          iterator: last ? null : `members-${input.uid}-${memberCall}`,
          done: last,
        }
      }),
    },
    transaction,
    create,
  }
}

function account(rows: ReturnType<typeof collection>[], pages = [rows]) {
  let call = 0
  const list = vi.fn(async () => {
    const page = pages[Math.min(call, pages.length - 1)] ?? []
    const last = call >= pages.length - 1
    call += 1
    return { data: page, stoken: last ? 'inv-end' : `inv-${call}`, done: last }
  })
  return {
    user: { username: 'me' },
    getCollectionManager: () => ({
      list,
      getItemManager: (candidate: { itemManager: unknown }) => candidate.itemManager,
      getMemberManager: (candidate: { memberManager: unknown }) => candidate.memberManager,
    }),
    list,
  }
}

describe('etebase birthday transport', () => {
  it('follows every collection, member and item page', async () => {
    const book = collection({
      uid: 'book-1',
      type: 'etebase.vcard',
      accessLevel: 0,
      content: '',
      items: [
        [{ uid: 'c1', content: 'CARD-1' }],
        [{ uid: 'c2', content: 'CARD-2' }],
      ],
    })
    const calendar = collection({
      uid: 'cal-1',
      type: 'etebase.vevent',
      accessLevel: 1,
      content: birthdayMarkerContent('active'),
      members: [[{ username: 'me' }], [{ username: 'ignored-not-used' }]],
    })
    // Second member page is part of the same list; both usernames must be kept.
    calendar.memberManager.list.mockReset()
    calendar.memberManager.list
      .mockResolvedValueOnce({ data: [{ username: 'me' }], iterator: 'm2', done: false })
      .mockResolvedValueOnce({ data: [{ username: 'other' }], iterator: null, done: true })
    const listed = account([book], [[book], [calendar]])
    const transport = createEtebaseBirthdayTransport(listed, gates())

    const inventory = await transport.listInventory()
    const items = await transport.listItems('book-1')

    expect(listed.list).toHaveBeenCalledTimes(2)
    expect(inventory.complete).toBe(true)
    expect(inventory.inventoryToken).toBe('inv-end')
    expect(inventory.collections.map((row) => [row.uid, row.kind, row.accessLevel, row.members])).toEqual([
      ['book-1', 'address-book', 'readOnly', []],
      ['cal-1', 'calendar', 'admin', ['me', 'other']],
    ])
    expect(calendar.memberManager.list).toHaveBeenCalledTimes(2)
    expect(items).toEqual({
      complete: true,
      stoken: 'items-end-book-1',
      items: [
        { itemUid: 'c1', content: 'CARD-1', revision: 'etag-c1' },
        { itemUid: 'c2', content: 'CARD-2', revision: 'etag-c2' },
      ],
    })
    expect(book.itemManager.list).toHaveBeenCalledTimes(2)
  })

  it('fails closed on an incomplete, repeated or failed page and on undecryptable content', async () => {
    const missingToken = account([], [[]])
    missingToken.list.mockReset()
    missingToken.list.mockResolvedValueOnce({ data: [collection({ uid: 'book-1', type: 'etebase.vcard', accessLevel: 2 })], stoken: '', done: false })
    const missing = await createEtebaseBirthdayTransport(missingToken, gates()).listInventory()
    expect(missing).toEqual({ complete: false, inventoryToken: null, collections: [] })
    expect(missingToken.list).toHaveBeenCalledTimes(1)

    const repeated = account([])
    repeated.list.mockReset()
    repeated.list
      .mockResolvedValueOnce({ data: [], stoken: 'again', done: false })
      .mockResolvedValueOnce({ data: [], stoken: 'again', done: false })
    const again = await createEtebaseBirthdayTransport(repeated, gates()).listInventory()
    expect(again.complete).toBe(false)
    expect(repeated.list).toHaveBeenCalledTimes(2)

    const broken = account([])
    broken.list.mockReset()
    broken.list.mockRejectedValueOnce(Object.assign(new Error('page failed'), { name: 'NetworkError' }))
    await expect(createEtebaseBirthdayTransport(broken, gates()).listInventory()).rejects.toThrow('page failed')

    const secret = collection({
      uid: 'book-secret',
      type: 'etebase.vcard',
      accessLevel: 0,
      items: [[{ uid: 'hidden', content: new Error('decrypt') }, { uid: 'plain', content: 'VISIBLE' }]],
    })
    const calendar = collection({
      uid: 'cal-secret',
      type: 'etebase.vevent',
      accessLevel: 1,
      content: new Error('decrypt'),
    })
    const transport = createEtebaseBirthdayTransport(account([secret, calendar]), gates())
    const inventory = await transport.listInventory()
    expect(inventory.collections.find((row) => row.uid === 'cal-secret')?.content).toBeNull()
    expect(calendar.memberManager.list).not.toHaveBeenCalled()
    const listedItems = await transport.listItems('book-secret')
    expect(listedItems.complete).toBe(true)
    expect(listedItems.items).toEqual([
      { itemUid: 'hidden', content: null, revision: 'etag-hidden' },
      { itemUid: 'plain', content: 'VISIBLE', revision: 'etag-plain' },
    ])
    expect(secret.transaction).not.toHaveBeenCalled()
  })

  it('does not send a transaction after the epoch drops during create, content write, or between chunks', async () => {
    let current = true
    const calendar = collection({ uid: 'cal-1', type: 'etebase.vevent', accessLevel: 1, content: birthdayMarkerContent('active') })
    const transport = createEtebaseBirthdayTransport(account([calendar]), gates(() => current))
    await transport.listInventory()
    calendar.create.mockImplementation(async () => {
      current = false
      return rootItem('new-item')
    })

    await expect(transport.applyChanges({
      collectionUid: 'cal-1',
      rootRevision: 'etag-cal-1',
      root: calendar.item,
      changes: [{ op: 'create', content: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' }],
    })).rejects.toBeInstanceOf(BirthdayTransportGateError)
    expect(calendar.transaction).not.toHaveBeenCalled()

    current = true
    const child = {
      uid: 'gen-1',
      etag: 'etag-gen-1',
      encryptedItem: { lastEtag: 'etag-gen-1' },
      isDeleted: false,
      getContent: vi.fn(async () => 'OLD'),
      setContent: vi.fn(async () => {}),
      delete: vi.fn(),
      _clone() {
        return {
          setContent: vi.fn(async () => { current = false }),
          delete: vi.fn(),
        }
      },
    }
    calendar.itemManager.list.mockReset()
    calendar.itemManager.list.mockResolvedValueOnce({ data: [child], stoken: 'items-end', done: true })
    await transport.listItems('cal-1')
    await expect(transport.applyChanges({
      collectionUid: 'cal-1',
      rootRevision: 'etag-cal-1',
      root: calendar.item,
      changes: [{ op: 'update', itemUid: 'gen-1', content: 'NEW' }],
    })).rejects.toBeInstanceOf(BirthdayTransportGateError)
    expect(calendar.transaction).not.toHaveBeenCalled()

    current = true
    calendar.create.mockImplementation(async (_meta: unknown, content: string) => rootItem(`made-${content.length}`))
    calendar.transaction.mockImplementation(async () => { current = false })
    const changes = Array.from({ length: 51 }, () => ({ op: 'create' as const, content: 'X' }))
    await expect(transport.applyChanges({
      collectionUid: 'cal-1',
      rootRevision: 'etag-cal-1',
      root: calendar.item,
      changes,
    })).rejects.toBeInstanceOf(BirthdayTransportGateError)
    expect(calendar.transaction).toHaveBeenCalledTimes(1)
    expect(calendar.transaction.mock.calls[0][0]).toHaveLength(50)
    expect(calendar.transaction.mock.calls[0][1]).toEqual([calendar.item])
  })

  it('maps a saved, conflict or uncertain transaction once and does not send it again', async () => {
    const calendar = collection({ uid: 'cal-1', type: 'etebase.vevent', accessLevel: 1, content: birthdayMarkerContent('active') })
    const transport = createEtebaseBirthdayTransport(account([calendar]), gates())
    await transport.listInventory()
    const input = {
      collectionUid: 'cal-1',
      rootRevision: 'etag-cal-1',
      root: calendar.item,
      changes: [{ op: 'create' as const, content: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' }],
    }

    await expect(transport.applyChanges(input)).resolves.toBe('saved')
    expect(calendar.transaction).toHaveBeenCalledTimes(1)

    calendar.transaction.mockRejectedValueOnce(Object.assign(new Error('conflict'), { name: 'ConflictError' }))
    await expect(transport.applyChanges(input)).resolves.toBe('conflict')
    expect(calendar.transaction).toHaveBeenCalledTimes(2)

    calendar.transaction.mockRejectedValueOnce(Object.assign(new Error('lost'), { name: 'NetworkError' }))
    await expect(transport.applyChanges(input)).resolves.toBe('uncertain')
    expect(calendar.transaction).toHaveBeenCalledTimes(3)
  })

  it('treats a rejected saved-token query as incomplete and does not read contact content', async () => {
    const book = collection({ uid: 'book-1', type: 'etebase.vcard', accessLevel: 0, content: 'SECRET' })
    const listed = account([book])
    listed.list.mockReset()
    listed.list
      .mockResolvedValueOnce({ data: [book], stoken: 'inv-end', done: true })
      .mockResolvedValueOnce({ data: [], stoken: 'inv-2', done: true })
    book.itemManager.list.mockReset()
    book.itemManager.list.mockRejectedValueOnce(new Error('rejected'))
    const transport = createEtebaseBirthdayTransport(listed, gates())
    await transport.listInventory()
    book.getContent.mockClear()

    const check = await transport.checkSourceTokens!({ inventoryToken: 'inv-end', books: [{ bookUid: 'book-1', stoken: 'book-s1' }] })

    expect(check).toEqual({ complete: false, inventoryChanged: false, changedBooks: [] })
    expect(book.itemManager.list).toHaveBeenCalledWith({ stoken: 'book-s1' })
    expect(book.getContent).not.toHaveBeenCalled()
  })

  it('does not upload a new Birthdays calendar after the epoch drops during create', async () => {
    let current = true
    const upload = vi.fn()
    const account = {
      user: { username: 'me' },
      getCollectionManager: () => ({
        list: vi.fn(),
        getItemManager: vi.fn(),
        getMemberManager: vi.fn(),
        upload,
        create: vi.fn(async () => {
          current = false
          return collection({ uid: 'cal-new', type: 'etebase.vevent', accessLevel: 1 })
        }),
      }),
    }
    const transport = createEtebaseBirthdayTransport(account, { ...gates(), isCurrentEpoch: () => current })

    await expect(transport.createBirthdayCalendar!({ name: 'Birthdays', content: '{}' })).rejects.toBeInstanceOf(BirthdayTransportGateError)
    expect(upload).not.toHaveBeenCalled()
  })

  // INTENDED-RED (plan3 F3): every run deletes generated leftovers in EACH retired calendar the user
  // can write to. C3's Admin/exactly-self rule is for the ACTIVE destination only. Runs the real
  // adapter under the real reconcile; the stand-ins are the SDK collection and item managers.
  it('F3: a shared ReadWrite retired calendar loses only its generated event, fenced on its own root', async () => {
    // Events vector 1's canonical text (contracts/birthday-calendar/v1-vectors.json).
    const GENERATED = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//SilentSuite//Birthdays v1//EN\r\nBEGIN:VEVENT\r\n'
      + 'UID:ss-bday1-c8970a5b3457981540f4ee428f84a1f4\r\nDTSTAMP:19720101T000000Z\r\nDTSTART;VALUE=DATE:19720315\r\n'
      + 'DTEND;VALUE=DATE:19720316\r\nRRULE:FREQ=YEARLY\r\nSUMMARY:\u{1F382} Alex Example\r\nTRANSP:TRANSPARENT\r\n'
      + 'END:VEVENT\r\nEND:VCALENDAR\r\n'
    const ORDINARY = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:user-event@example.com\r\n'
      + 'DTSTART;VALUE=DATE:20261031\r\nSUMMARY:Party\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
    const ALEX = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:c1\r\nFN:Alex Example\r\nBDAY:1985-03-15\r\nEND:VCARD\r\n'
    const clones: Array<{ uid: string; setContent: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> }> = []
    const row = (uid: string, content: string) => ({
      uid,
      etag: `etag-${uid}`,
      encryptedItem: { lastEtag: `etag-${uid}` },
      isDeleted: false,
      getContent: vi.fn(async () => content),
      setContent: vi.fn(async () => {}),
      delete: vi.fn(),
      _clone() {
        const clone = { uid, setContent: vi.fn(async () => {}), delete: vi.fn() }
        clones.push(clone)
        return clone
      },
    })
    const retired = collection({ uid: 'cal-retired', type: 'etebase.vevent', accessLevel: 2, content: birthdayMarkerContent('retired') })
    const generatedRow = row('gen-r', GENERATED)
    const ordinaryRow = row('user-r', ORDINARY)
    retired.itemManager.list.mockReset()
    retired.itemManager.list.mockResolvedValue({ data: [generatedRow, ordinaryRow], stoken: 'items-end-cal-retired', done: true })
    // A ReadWrite member cannot list members on the real server; F3 needs only write access.
    retired.memberManager.list.mockReset()
    retired.memberManager.list.mockRejectedValue(Object.assign(new Error('forbidden'), { name: 'PermissionDeniedError' }))
    const book = collection({ uid: 'book-1', type: 'etebase.vcard', accessLevel: 2, items: [[{ uid: 'c1', content: ALEX }]] })
    const transport = createEtebaseBirthdayTransport(account([retired, book]), gates())

    // Preconditions, through the real adapter: what the reconcile will see.
    const inventory = await transport.listInventory()
    const listedRetired = inventory.collections.find((entry) => entry.uid === 'cal-retired')
    expect(inventory.complete).toBe(true)
    expect(listedRetired?.accessLevel).toBe('readWrite')
    expect(parseBirthdayMarker(listedRetired?.content ?? null)).toBe('retired')
    expect(listedRetired?.rootRevision).toBe('etag-cal-retired')
    expect(inventory.collections.some((entry) => entry.kind === 'calendar' && parseBirthdayMarker(entry.content) === 'active')).toBe(false)

    const result = await reconcileBirthdays({ accountKey: 'acct', username: 'me', gates: gates(), transport })

    expect(retired.transaction, 'FEATURE_F3: the shared ReadWrite retired calendar gets one cleanup transaction').toHaveBeenCalledTimes(1)
    const [prepared, deps] = retired.transaction.mock.calls[0] as unknown as [
      Array<{ uid: string; delete: ReturnType<typeof vi.fn>; setContent: ReturnType<typeof vi.fn> }>,
      unknown[],
    ]
    expect(prepared.map((item) => item.uid), 'FEATURE_F3: it deletes only the generated event').toEqual(['gen-r'])
    expect(prepared[0].delete).toHaveBeenCalledTimes(1)
    expect(prepared[0].setContent).not.toHaveBeenCalled()
    expect(deps, 'FEATURE_F3: fenced on that calendar\'s own root as read').toHaveLength(1)
    expect(deps[0]).toBe(retired.item)
    expect(clones.filter((clone) => clone.uid === 'user-r')).toEqual([])
    expect(ordinaryRow.delete).not.toHaveBeenCalled()
    expect(ordinaryRow.setContent).not.toHaveBeenCalled()
    expect(retired.create).not.toHaveBeenCalled()
    expect(book.transaction).not.toHaveBeenCalled()
    expect(book.create).not.toHaveBeenCalled()
    expect(result.status).toBe('done')
  })
})
