import { describe, expect, it } from 'vitest'
import { birthdayEventContent, birthdayEventsFromSource, birthdayMarkerContent } from '@silentsuite/core'
import { disableBirthdayCalendar, enableBirthdayCalendar } from '../lifecycle'
import type { BirthdayTransport } from '../reconcile'

function gates() {
  return {
    accountEpoch: 1,
    isCurrentEpoch: () => true,
    canWrite: () => true,
    isOnline: () => true,
    hasSubtleCrypto: () => true,
  }
}

describe('birthday enable', () => {
  it('creates one private Birthdays calendar when no active one exists', async () => {
    const creates: Array<{ name: string; content: string }> = []
    const transport: BirthdayTransport = {
      async listInventory() {
        return {
          complete: true,
          inventoryToken: 'inv',
          collections: creates.length === 0 ? [] : [{
            uid: 'cal-new',
            kind: 'calendar' as const,
            accessLevel: 'admin' as const,
            content: birthdayMarkerContent('active'),
            members: ['me'],
            membersComplete: true,
            rootRevision: 'root-new',
            root: { uid: 'cal-new' },
          }],
        }
      },
      async listItems() {
        return { complete: true, stoken: 's', items: [] }
      },
      async applyChanges() {
        return 'saved'
      },
      async createBirthdayCalendar(input) {
        creates.push(input)
        return { kind: 'created', collectionUid: 'cal-new', rootRevision: 'root-new', root: { uid: 'cal-new' } }
      },
      async checkSourceTokens() {
        return { complete: true, inventoryChanged: false, changedBooks: [] }
      },
    }

    const result = await enableBirthdayCalendar({
      accountKey: 'acct',
      username: 'me',
      gates: gates(),
      transport,
    })

    expect(creates).toEqual([{ name: 'Birthdays', content: birthdayMarkerContent('active') }])
    expect(result.status).toBe('done')
  })

  it('does not create when an active sole-member calendar already exists', async () => {
    const creates: unknown[] = []
    const transport: BirthdayTransport = {
      async listInventory() {
        return {
          complete: true,
          inventoryToken: 'inv',
          collections: [{
            uid: 'cal-1', kind: 'calendar', accessLevel: 'admin', content: birthdayMarkerContent('active'),
            members: ['me'], membersComplete: true, rootRevision: 'root', root: { uid: 'cal-1' },
          }],
        }
      },
      async listItems() { return { complete: true, stoken: 's', items: [] } },
      async applyChanges() { return 'saved' },
      async createBirthdayCalendar(input) { creates.push(input); return { kind: 'created', collectionUid: 'x', rootRevision: 'r', root: {} } },
      async checkSourceTokens() { return { complete: true, inventoryChanged: false, changedBooks: [] } },
    }
    const result = await enableBirthdayCalendar({ accountKey: 'existing', username: 'me', gates: gates(), transport })
    expect(creates).toEqual([])
    expect(result.status).toBe('done')
  })

  it('creates a new calendar instead of reactivating a retired one', async () => {
    const calls: string[] = []
    const transport: BirthdayTransport = {
      async listInventory() {
        return {
          complete: true,
          inventoryToken: 'inv',
          collections: calls.includes('create') ? [{
            uid: 'cal-new', kind: 'calendar', accessLevel: 'admin', content: birthdayMarkerContent('active'),
            members: ['me'], membersComplete: true, rootRevision: 'root-new', root: { uid: 'cal-new' },
          }] : [{
            uid: 'cal-old', kind: 'calendar', accessLevel: 'admin', content: birthdayMarkerContent('retired'),
            members: ['me'], membersComplete: true, rootRevision: 'root-old', root: { uid: 'cal-old' },
          }],
        }
      },
      async listItems() { return { complete: true, stoken: 's', items: [] } },
      async applyChanges() { return 'saved' },
      async retireCalendar() { calls.push('retire'); return { kind: 'conflict' } },
      async createBirthdayCalendar() {
        calls.push('create')
        return { kind: 'created', collectionUid: 'cal-new', rootRevision: 'root-new', root: { uid: 'cal-new' } }
      },
      async checkSourceTokens() { return { complete: true, inventoryChanged: false, changedBooks: [] } },
    }
    const result = await enableBirthdayCalendar({ accountKey: 'retired-only', username: 'me', gates: gates(), transport })
    expect(calls).toEqual(['create'])
    expect(result.status).toBe('done')
  })

  it('does not upload again when calendar creation is uncertain', async () => {
    let visible = false
    let creates = 0
    const transport: BirthdayTransport = {
      async listInventory() {
        return {
          complete: true,
          inventoryToken: 'inv',
          collections: visible ? [{
            uid: 'cal-new', kind: 'calendar', accessLevel: 'admin', content: birthdayMarkerContent('active'),
            members: ['me'], membersComplete: true, rootRevision: 'root-new', root: { uid: 'cal-new' },
          }] : [],
        }
      },
      async listItems() { return { complete: true, stoken: 's', items: [] } },
      async applyChanges() { return 'saved' },
      async createBirthdayCalendar() {
        creates += 1
        visible = true
        return { kind: 'uncertain' }
      },
      async checkSourceTokens() { return { complete: true, inventoryChanged: false, changedBooks: [] } },
    }
    const input = { accountKey: 'lost', username: 'me', gates: gates(), transport }
    const first = await enableBirthdayCalendar(input)
    const second = await enableBirthdayCalendar(input)
    expect(first).toMatchObject({ status: 'pending', reason: 'uncertain' })
    expect(creates).toBe(1)
    expect(second.status).toBe('done')
    expect(creates).toBe(1)
  })

  it('does not create when an active calendar membership list is incomplete', async () => {
    const creates: unknown[] = []
    const transport: BirthdayTransport = {
      async listInventory() {
        return {
          complete: true,
          inventoryToken: 'inv',
          collections: [{
            uid: 'cal-maybe', kind: 'calendar', accessLevel: 'admin', content: birthdayMarkerContent('active'),
            members: ['me'], membersComplete: false, rootRevision: 'root', root: { uid: 'cal-maybe' },
          }],
        }
      },
      async listItems() { return { complete: true, stoken: 's', items: [] } },
      async applyChanges() { return 'saved' },
      async createBirthdayCalendar(input) { creates.push(input); return { kind: 'created', collectionUid: 'x', rootRevision: 'r', root: {} } },
    }
    const result = await enableBirthdayCalendar({ accountKey: 'incomplete-members', username: 'me', gates: gates(), transport })
    expect(creates).toEqual([])
    expect(result.status).toBe('failed')
  })
})

describe('birthday disable', () => {
  it('retires every qualifying active calendar before deleting only generated items', async () => {
    const source = await birthdayEventsFromSource({
      inventoryComplete: true,
      books: [{ bookUid: 'book-1', complete: true, items: [{ itemUid: 'contact-1', content: 'BEGIN:VCARD\r\nFN:Ada Lovelace\r\nBDAY:18151210\r\nEND:VCARD' }] }],
    })
    expect(source.ok).toBe(true)
    if (!source.ok) return
    const generated = birthdayEventContent(source.events[0]!)
    const oldRoot = { uid: 'cal-a', etag: 'old' }
    const newRoot = { uid: 'cal-a', etag: 'new' }
    const calls: string[] = []
    const writes: Array<{ root: unknown; changes: unknown }> = []
    const transport: BirthdayTransport = {
      async listInventory() {
        return {
          complete: true,
          inventoryToken: 'inv',
          collections: [
            {
              uid: 'cal-shared', kind: 'calendar', accessLevel: 'admin', content: birthdayMarkerContent('active'),
              members: ['me', 'other'], membersComplete: true, rootRevision: 'shared', root: { uid: 'cal-shared' },
            },
            {
              uid: 'cal-a', kind: 'calendar', accessLevel: 'admin', content: birthdayMarkerContent('active'),
              members: ['me'], membersComplete: true, rootRevision: 'old', root: oldRoot,
            },
          ],
        }
      },
      async listItems(collectionUid) {
        calls.push(`list:${collectionUid}`)
        return {
          complete: true,
          stoken: 'items',
          items: [
            { itemUid: 'user-1', content: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:user-kept\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n', revision: 'u' },
            { itemUid: 'gen-1', content: generated, revision: 'g' },
          ],
        }
      },
      async applyChanges(input) {
        calls.push(`apply:${input.collectionUid}`)
        writes.push({ root: input.root, changes: input.changes })
        return 'saved'
      },
      async retireCalendar(input) {
        calls.push(`retire:${input.collectionUid}`)
        return { kind: 'retired', rootRevision: 'new', root: newRoot }
      },
    }

    const result = await disableBirthdayCalendar({ accountKey: 'off', username: 'me', gates: gates(), transport })

    expect(calls).toEqual(['list:cal-a', 'retire:cal-a', 'apply:cal-a'])
    expect(writes).toEqual([{ root: newRoot, changes: [{ op: 'remove', itemUid: 'gen-1' }] }])
    expect(result.status).toBe('done')
  })

  it('does not clean generated items when retirement conflicts', async () => {
    const calls: string[] = []
    const transport: BirthdayTransport = {
      async listInventory() {
        return {
          complete: true,
          inventoryToken: 'inv',
          collections: [{
            uid: 'cal-a', kind: 'calendar', accessLevel: 'admin', content: birthdayMarkerContent('active'),
            members: ['me'], membersComplete: true, rootRevision: 'old', root: { uid: 'cal-a' },
          }],
        }
      },
      async listItems() {
        calls.push('list')
        return { complete: true, stoken: 'items', items: [] }
      },
      async applyChanges() {
        calls.push('apply')
        return 'saved'
      },
      async retireCalendar() {
        calls.push('retire')
        return { kind: 'conflict' }
      },
    }
    const result = await disableBirthdayCalendar({ accountKey: 'conflict', username: 'me', gates: gates(), transport })
    expect(calls).toEqual(['list', 'retire'])
    expect(result).toMatchObject({ status: 'pending', reason: 'conflict' })
  })

  it('does not report turn-off done when a calendar could not be read', async () => {
    const calls: string[] = []
    const transport: BirthdayTransport = {
      async listInventory() {
        return {
          complete: true,
          inventoryToken: 'inv',
          collections: [{
            uid: 'cal-hidden', kind: 'calendar', accessLevel: 'admin', content: null,
            members: [], membersComplete: false, rootRevision: 'root', root: { uid: 'cal-hidden' },
          }],
        }
      },
      async listItems() { calls.push('list'); return { complete: true, stoken: 's', items: [] } },
      async applyChanges() { calls.push('apply'); return 'saved' },
      async retireCalendar() { calls.push('retire'); return { kind: 'retired', rootRevision: 'n', root: {} } },
    }
    const result = await disableBirthdayCalendar({ accountKey: 'unreadable', username: 'me', gates: gates(), transport })
    expect(calls).toEqual([])
    expect(result.status).toBe('failed')
  })
})
