import { describe, expect, it } from 'vitest'
import { birthdayEventContent, birthdayEventsFromSource, birthdayMarkerContent } from '@silentsuite/core'
import { reconcileBirthdays, type BirthdayTransport } from '../reconcile'

const VCARD = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Ada Lovelace',
  'BDAY:18151210',
  'END:VCARD',
].join('\r\n')

const ROOT = { uid: 'cal-1', etag: 'root-etag-1' }

function openGates() {
  return {
    accountEpoch: 7,
    isCurrentEpoch: () => true,
    canWrite: () => true,
    isOnline: () => true,
    hasSubtleCrypto: () => true,
  }
}

describe('birthday reconcile tracer', () => {
  it('writes one birthday event fenced on the current destination root', async () => {
    const writes: Parameters<BirthdayTransport['applyChanges']>[0][] = []
    const transport: BirthdayTransport = {
      async listInventory() {
        return {
          complete: true,
          inventoryToken: 'inv-1',
          collections: [
            {
              uid: 'book-1',
              kind: 'address-book',
              accessLevel: 'readOnly',
              content: '',
              members: ['me', 'other'],
              membersComplete: true,
              rootRevision: 'book-root',
              root: { uid: 'book-1' },
            },
            {
              uid: 'cal-1',
              kind: 'calendar',
              accessLevel: 'admin',
              content: birthdayMarkerContent('active'),
              members: ['me'],
              membersComplete: true,
              rootRevision: 'root-etag-1',
              root: ROOT,
            },
          ],
        }
      },
      async listItems(collectionUid) {
        if (collectionUid === 'book-1') {
          return {
            complete: true,
            stoken: 'book-stoken-1',
            items: [{ itemUid: 'contact-1', content: VCARD, revision: 'c1' }],
          }
        }
        return { complete: true, stoken: 'cal-stoken-1', items: [] }
      },
      async applyChanges(input) {
        writes.push(input)
        return 'saved'
      },
    }

    const source = await birthdayEventsFromSource({
      inventoryComplete: true,
      books: [{ bookUid: 'book-1', complete: true, items: [{ itemUid: 'contact-1', content: VCARD }] }],
    })
    expect(source.ok).toBe(true)
    if (!source.ok) return

    const result = await reconcileBirthdays({
      accountKey: 'acct-1',
      username: 'me',
      gates: openGates(),
      transport,
    })

    expect(writes).toEqual([
      {
        collectionUid: 'cal-1',
        rootRevision: 'root-etag-1',
        root: ROOT,
        changes: [{ op: 'create', content: birthdayEventContent(source.events[0]!) }],
      },
    ])
    expect(result.status).toBe('done')
    expect(result.sourceTokens).toEqual({
      inventoryToken: 'inv-1',
      books: [{ bookUid: 'book-1', stoken: 'book-stoken-1' }],
    })
  })

  it('does not write when an address-book page is incomplete', async () => {
    const writes: unknown[] = []
    const transport: BirthdayTransport = {
      async listInventory() {
        return {
          complete: true,
          inventoryToken: 'inv-1',
          collections: [
            {
              uid: 'book-1',
              kind: 'address-book',
              accessLevel: 'readWrite',
              content: '',
              members: ['me'],
              membersComplete: true,
              rootRevision: 'book-root',
              root: { uid: 'book-1' },
            },
            {
              uid: 'cal-1',
              kind: 'calendar',
              accessLevel: 'admin',
              content: birthdayMarkerContent('active'),
              members: ['me'],
              membersComplete: true,
              rootRevision: 'root-etag-1',
              root: ROOT,
            },
          ],
        }
      },
      async listItems(collectionUid) {
        if (collectionUid === 'book-1') return { complete: false, stoken: null, items: [] }
        return { complete: true, stoken: 'cal-stoken-1', items: [] }
      },
      async applyChanges(input) {
        writes.push(input)
        return 'saved'
      },
    }

    const result = await reconcileBirthdays({
      accountKey: 'acct-1',
      username: 'me',
      gates: openGates(),
      transport,
    })

    expect(writes).toEqual([])
    expect(result.status).toBe('failed')
    expect(result.reason).toBe('incomplete-book')
  })

  it('does not write when a source page fails', async () => {
    const writes: unknown[] = []
    const transport: BirthdayTransport = {
      async listInventory() {
        return {
          complete: true,
          inventoryToken: 'inv-1',
          collections: [
            {
              uid: 'book-1',
              kind: 'address-book',
              accessLevel: 'admin',
              content: '',
              members: ['me'],
              membersComplete: true,
              rootRevision: 'book-root',
              root: { uid: 'book-1' },
            },
          ],
        }
      },
      async listItems() {
        throw new Error('page failed')
      },
      async applyChanges(input) {
        writes.push(input)
        return 'saved'
      },
    }

    const result = await reconcileBirthdays({
      accountKey: 'acct-1',
      username: 'me',
      gates: openGates(),
      transport,
    })

    expect(writes).toEqual([])
    expect(result).toEqual({ status: 'failed', reason: 'reconcile-failed', sourceTokens: null })
  })

  it('does not write after the account epoch changes', async () => {
    let current = true
    const writes: unknown[] = []
    const transport: BirthdayTransport = {
      async listInventory() {
        return {
          complete: true,
          inventoryToken: 'inv-1',
          collections: [
            {
              uid: 'book-1',
              kind: 'address-book',
              accessLevel: 'readOnly',
              content: '',
              members: [],
              membersComplete: true,
              rootRevision: 'book-root',
              root: { uid: 'book-1' },
            },
            {
              uid: 'cal-1',
              kind: 'calendar',
              accessLevel: 'admin',
              content: birthdayMarkerContent('active'),
              members: ['me'],
              membersComplete: true,
              rootRevision: 'root-etag-1',
              root: ROOT,
            },
          ],
        }
      },
      async listItems(collectionUid) {
        if (collectionUid === 'cal-1') current = false
        if (collectionUid === 'book-1') {
          return {
            complete: true,
            stoken: 'book-stoken-1',
            items: [{ itemUid: 'contact-1', content: VCARD, revision: 'c1' }],
          }
        }
        return { complete: true, stoken: 'cal-stoken-1', items: [] }
      },
      async applyChanges(input) {
        writes.push(input)
        return 'saved'
      },
    }
    const gates = { ...openGates(), isCurrentEpoch: () => current }

    const result = await reconcileBirthdays({ accountKey: 'acct-1', username: 'me', gates, transport })

    expect(writes).toEqual([])
    expect(result.status).toBe('skipped')
    expect(result.reason).toBe('stale-account')
  })

  it('does not write when write access or the network drops before the mutation', async () => {
    let writable = true
    let online = true
    const writes: unknown[] = []
    const transport: BirthdayTransport = {
      async listInventory() {
        return {
          complete: true,
          inventoryToken: 'inv-1',
          collections: [
            {
              uid: 'book-1',
              kind: 'address-book',
              accessLevel: 'readOnly',
              content: '',
              members: [],
              membersComplete: true,
              rootRevision: 'book-root',
              root: { uid: 'book-1' },
            },
            {
              uid: 'cal-1',
              kind: 'calendar',
              accessLevel: 'admin',
              content: birthdayMarkerContent('active'),
              members: ['me'],
              membersComplete: true,
              rootRevision: 'root-etag-1',
              root: ROOT,
            },
          ],
        }
      },
      async listItems(collectionUid) {
        if (collectionUid === 'cal-1') {
          writable = false
          online = false
        }
        if (collectionUid === 'book-1') {
          return {
            complete: true,
            stoken: 'book-stoken-1',
            items: [{ itemUid: 'contact-1', content: VCARD, revision: 'c1' }],
          }
        }
        return { complete: true, stoken: 'cal-stoken-1', items: [] }
      },
      async applyChanges(input) {
        writes.push(input)
        return 'saved'
      },
    }

    const readOnly = await reconcileBirthdays({
      accountKey: 'acct-1',
      username: 'me',
      gates: { ...openGates(), canWrite: () => writable, isOnline: () => true },
      transport,
    })
    expect(writes).toEqual([])
    expect(readOnly).toMatchObject({ status: 'skipped', reason: 'read-only' })

    writable = true
    const offline = await reconcileBirthdays({
      accountKey: 'acct-1',
      username: 'me',
      gates: { ...openGates(), canWrite: () => true, isOnline: () => online },
      transport,
    })
    expect(writes).toEqual([])
    expect(offline).toMatchObject({ status: 'skipped', reason: 'offline' })
  })

  it('removes a stale generated event when a complete inventory has no address books', async () => {
    const source = await birthdayEventsFromSource({
      inventoryComplete: true,
      books: [{ bookUid: 'book-1', complete: true, items: [{ itemUid: 'contact-1', content: VCARD }] }],
    })
    expect(source.ok).toBe(true)
    if (!source.ok) return
    const generated = birthdayEventContent(source.events[0]!)
    const writes: Parameters<BirthdayTransport['applyChanges']>[0][] = []
    const transport: BirthdayTransport = {
      async listInventory() {
        return {
          complete: true,
          inventoryToken: 'inv-empty',
          collections: [
            {
              uid: 'cal-1',
              kind: 'calendar',
              accessLevel: 'admin',
              content: birthdayMarkerContent('active'),
              members: ['me'],
              membersComplete: true,
              rootRevision: 'root-etag-1',
              root: ROOT,
            },
          ],
        }
      },
      async listItems() {
        return {
          complete: true,
          stoken: 'cal-stoken-1',
          items: [
            { itemUid: 'user-item', content: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:user-kept\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n', revision: 'u1' },
            { itemUid: 'gen-item', content: generated, revision: 'g1' },
          ],
        }
      },
      async applyChanges(input) {
        writes.push(input)
        return 'saved'
      },
    }

    const result = await reconcileBirthdays({
      accountKey: 'acct-1',
      username: 'me',
      gates: openGates(),
      transport,
    })

    expect(writes).toEqual([
      {
        collectionUid: 'cal-1',
        rootRevision: 'root-etag-1',
        root: ROOT,
        changes: [{ op: 'remove', itemUid: 'gen-item' }],
      },
    ])
    expect(result).toEqual({
      status: 'done',
      sourceTokens: { inventoryToken: 'inv-empty', books: [] },
    })
  })

  it('skips without reading or writing when crypto.subtle is missing', async () => {
    let used = false
    const transport: BirthdayTransport = {
      async listInventory() {
        used = true
        return { complete: true, inventoryToken: 'inv-1', collections: [] }
      },
      async listItems() {
        used = true
        return { complete: true, stoken: 'stoken', items: [] }
      },
      async applyChanges() {
        used = true
        return 'saved'
      },
    }

    const result = await reconcileBirthdays({
      accountKey: 'acct-1',
      username: 'me',
      gates: { ...openGates(), hasSubtleCrypto: () => false },
      transport,
    })

    expect(used).toBe(false)
    expect(result).toEqual({ status: 'skipped', reason: 'no-subtle-crypto', sourceTokens: null })
  })

  it('retires the extra active calendar before deleting only its generated items', async () => {
    const source = await birthdayEventsFromSource({
      inventoryComplete: true,
      books: [{ bookUid: 'book-1', complete: true, items: [{ itemUid: 'contact-1', content: VCARD }] }],
    })
    expect(source.ok).toBe(true)
    if (!source.ok) return
    const generated = birthdayEventContent(source.events[0]!)
    const oldRoot = { uid: 'cal-b', etag: 'root-b-old' }
    const newRoot = { uid: 'cal-b', etag: 'root-b-new' }
    const calls: string[] = []
    const writes: Parameters<BirthdayTransport['applyChanges']>[0][] = []
    const transport: BirthdayTransport = {
      async listInventory() {
        return {
          complete: true,
          inventoryToken: 'inv-1',
          collections: [
            {
              uid: 'cal-b',
              kind: 'calendar',
              accessLevel: 'admin',
              content: birthdayMarkerContent('active'),
              members: ['me'],
              membersComplete: true,
              rootRevision: 'root-b-old',
              root: oldRoot,
            },
            {
              uid: 'cal-a',
              kind: 'calendar',
              accessLevel: 'admin',
              content: birthdayMarkerContent('active'),
              members: ['me'],
              membersComplete: true,
              rootRevision: 'root-a',
              root: { uid: 'cal-a', etag: 'root-a' },
            },
          ],
        }
      },
      async listItems(collectionUid) {
        calls.push(`list:${collectionUid}`)
        if (collectionUid === 'cal-b') {
          return {
            complete: true,
            stoken: 'cal-b-items',
            items: [
              { itemUid: 'user-b', content: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:user-kept\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n', revision: 'u1' },
              { itemUid: 'gen-b', content: generated, revision: 'g1' },
            ],
          }
        }
        return { complete: true, stoken: 'cal-a-items', items: [] }
      },
      async retireCalendar(input) {
        calls.push(`retire:${input.collectionUid}`)
        expect(input.root).toBe(oldRoot)
        expect(input.content).toBe(birthdayMarkerContent('retired'))
        return { kind: 'retired', rootRevision: 'root-b-new', root: newRoot }
      },
      async applyChanges(input) {
        calls.push(`apply:${input.collectionUid}`)
        writes.push(input)
        return 'saved'
      },
    }

    const result = await reconcileBirthdays({
      accountKey: 'acct-1',
      username: 'me',
      gates: openGates(),
      transport,
    })

    expect(calls.filter((call) => call.startsWith('list:')).sort()).toEqual(['list:cal-a', 'list:cal-b'])
    expect(calls.filter((call) => !call.startsWith('list:'))).toEqual(['retire:cal-b', 'apply:cal-b'])
    expect(writes).toEqual([
      {
        collectionUid: 'cal-b',
        rootRevision: 'root-b-new',
        root: newRoot,
        changes: [{ op: 'remove', itemUid: 'gen-b' }],
      },
    ])
    expect(result.status).toBe('done')
  })

  it('deletes leftover generated items from an already-retired calendar without retiring it again', async () => {
    const source = await birthdayEventsFromSource({
      inventoryComplete: true,
      books: [{ bookUid: 'book-1', complete: true, items: [{ itemUid: 'contact-1', content: VCARD }] }],
    })
    expect(source.ok).toBe(true)
    if (!source.ok) return
    const generated = birthdayEventContent(source.events[0]!)
    const retiredRoot = { uid: 'cal-r', etag: 'root-r' }
    const calls: string[] = []
    const writes: Parameters<BirthdayTransport['applyChanges']>[0][] = []
    const transport: BirthdayTransport = {
      async listInventory() {
        return {
          complete: true,
          inventoryToken: 'inv-retired',
          collections: [
            {
              uid: 'cal-a',
              kind: 'calendar',
              accessLevel: 'admin',
              content: birthdayMarkerContent('active'),
              members: ['me'],
              membersComplete: true,
              rootRevision: 'root-a',
              root: { uid: 'cal-a', etag: 'root-a' },
            },
            {
              uid: 'cal-r',
              kind: 'calendar',
              accessLevel: 'admin',
              content: birthdayMarkerContent('retired'),
              members: ['me'],
              membersComplete: true,
              rootRevision: 'root-r',
              root: retiredRoot,
            },
          ],
        }
      },
      async listItems(collectionUid) {
        calls.push(`list:${collectionUid}`)
        if (collectionUid === 'cal-r') {
          return {
            complete: true,
            stoken: 'cal-r-items',
            items: [
              { itemUid: 'user-r', content: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:user-kept\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n', revision: 'u1' },
              { itemUid: 'gen-r', content: generated, revision: 'g1' },
            ],
          }
        }
        return { complete: true, stoken: 'cal-a-items', items: [] }
      },
      async retireCalendar() {
        calls.push('retire')
        return { kind: 'conflict' }
      },
      async applyChanges(input) {
        calls.push(`apply:${input.collectionUid}`)
        writes.push(input)
        return 'saved'
      },
    }

    const result = await reconcileBirthdays({
      accountKey: 'acct-1',
      username: 'me',
      gates: openGates(),
      transport,
    })

    expect(calls).toEqual(['list:cal-a', 'list:cal-r', 'apply:cal-r'])
    expect(writes).toEqual([
      {
        collectionUid: 'cal-r',
        rootRevision: 'root-r',
        root: retiredRoot,
        changes: [{ op: 'remove', itemUid: 'gen-r' }],
      },
    ])
    expect(result.status).toBe('done')
  })

  it('does not clean a duplicate when retirement conflicts, and ignores a shared calendar', async () => {
    const calls: string[] = []
    const transport: BirthdayTransport = {
      async listInventory() {
        return {
          complete: true,
          inventoryToken: 'inv-1',
          collections: [
            {
              uid: 'cal-shared',
              kind: 'calendar',
              accessLevel: 'admin',
              content: birthdayMarkerContent('active'),
              members: ['me', 'other'],
              membersComplete: true,
              rootRevision: 'root-shared',
              root: { uid: 'cal-shared' },
            },
            {
              uid: 'cal-a',
              kind: 'calendar',
              accessLevel: 'admin',
              content: birthdayMarkerContent('active'),
              members: ['me'],
              membersComplete: true,
              rootRevision: 'root-a',
              root: { uid: 'cal-a' },
            },
            {
              uid: 'cal-b',
              kind: 'calendar',
              accessLevel: 'admin',
              content: birthdayMarkerContent('active'),
              members: ['me'],
              membersComplete: true,
              rootRevision: 'root-b',
              root: { uid: 'cal-b' },
            },
          ],
        }
      },
      async listItems(collectionUid) {
        calls.push(`list:${collectionUid}`)
        return { complete: true, stoken: `${collectionUid}-items`, items: [] }
      },
      async retireCalendar(input) {
        calls.push(`retire:${input.collectionUid}`)
        return { kind: 'conflict' }
      },
      async applyChanges(input) {
        calls.push(`apply:${input.collectionUid}`)
        return 'saved'
      },
    }

    const conflicted = await reconcileBirthdays({
      accountKey: 'acct-1',
      username: 'me',
      gates: openGates(),
      transport,
    })

    expect(calls).toEqual(['list:cal-a', 'list:cal-b', 'retire:cal-b'])
    expect(conflicted).toMatchObject({ status: 'pending', reason: 'conflict' })
  })

  it('reads a received sole-member calendar and does not touch a read-only one', async () => {
    const calls: string[] = []
    const transport: BirthdayTransport = {
      async listInventory() {
        return {
          complete: true,
          inventoryToken: 'inv-1',
          collections: [
            {
              uid: 'received',
              kind: 'calendar',
              accessLevel: 'admin',
              content: birthdayMarkerContent('active'),
              members: ['me'],
              membersComplete: true,
              rootRevision: 'root-received',
              root: { uid: 'received' },
            },
            {
              uid: 'read-only',
              kind: 'calendar',
              accessLevel: 'readOnly',
              content: birthdayMarkerContent('active'),
              members: ['me'],
              membersComplete: true,
              rootRevision: 'root-ro',
              root: { uid: 'read-only' },
            },
          ],
        }
      },
      async listItems(collectionUid) {
        calls.push(`list:${collectionUid}`)
        return { complete: true, stoken: 'items', items: [] }
      },
      async retireCalendar() {
        calls.push('retire')
        return { kind: 'retired', rootRevision: 'nope', root: {} }
      },
      async applyChanges(input) {
        calls.push(`apply:${input.collectionUid}`)
        return 'saved'
      },
    }

    const result = await reconcileBirthdays({
      accountKey: 'acct-1',
      username: 'me',
      gates: openGates(),
      transport,
    })

    expect(calls).toEqual(['list:received'])
    expect(result.status).toBe('done')
  })
})
