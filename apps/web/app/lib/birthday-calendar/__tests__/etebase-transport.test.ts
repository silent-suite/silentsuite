// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { birthdayMarkerContent } from '@silentsuite/core'
import { createEtebaseBirthdayTransport, BirthdayTransportGateError } from '../etebase-transport'
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
})
