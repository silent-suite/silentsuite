import { describe, expect, it } from 'vitest'
import { birthdayEventContent, birthdayEventsFromSource } from '@silentsuite/core'
import { runBirthdayCalendar } from '../orchestrate'
import type { BirthdayTransport } from '../reconcile'

const OLD_CARD = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Ada Lovelace', 'BDAY:18151210', 'END:VCARD'].join('\r\n')
const NEW_CARD = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Ada Lovelace', 'BDAY:18151211', 'END:VCARD'].join('\r\n')

function deferred() {
  let release: () => void = () => {}
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

function gates() {
  return {
    accountEpoch: 1,
    isCurrentEpoch: () => true,
    canWrite: () => true,
    isOnline: () => true,
    hasSubtleCrypto: () => true,
  }
}

describe('birthday post-check orchestrator', () => {
  it('corrects a stale overwrite after the source token changes', async () => {
    const oldSource = await birthdayEventsFromSource({
      inventoryComplete: true,
      books: [{ bookUid: 'book-1', complete: true, items: [{ itemUid: 'contact-1', content: OLD_CARD }] }],
    })
    const newSource = await birthdayEventsFromSource({
      inventoryComplete: true,
      books: [{ bookUid: 'book-1', complete: true, items: [{ itemUid: 'contact-1', content: NEW_CARD }] }],
    })
    expect(oldSource.ok && newSource.ok).toBe(true)
    if (!oldSource.ok || !newSource.ok) return
    const oldEvent = birthdayEventContent(oldSource.events[0]!)
    const newEvent = birthdayEventContent(newSource.events[0]!)
    expect(oldEvent).not.toBe(newEvent)

    let card = OLD_CARD
    let bookStoken = 'book-1'
    let calendar: Array<{ itemUid: string; content: string }> = []
    const aReadBook = deferred()
    const bFinished = deferred()
    const writes: string[] = []

    function transport(pauseBeforeCalendar: boolean): BirthdayTransport {
      return {
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
                content: '{"type":"silentsuite.birthdays","v":1,"state":"active"}',
                members: ['me'],
                membersComplete: true,
                rootRevision: 'root-1',
                root: { uid: 'cal-1', etag: 'root-1' },
              },
            ],
          }
        },
        async listItems(collectionUid) {
          if (collectionUid === 'book-1') {
            const content = card
            const stoken = bookStoken
            if (pauseBeforeCalendar) aReadBook.release()
            return { complete: true, stoken, items: [{ itemUid: 'contact-1', content, revision: stoken }] }
          }
          if (pauseBeforeCalendar) await bFinished.promise
          return {
            complete: true,
            stoken: 'cal-1',
            items: calendar.map((item) => ({ ...item, revision: 'item-rev' })),
          }
        },
        async applyChanges(input) {
          const created = input.changes.find((change) => change.op === 'create')
          const updated = input.changes.find((change) => change.op === 'update')
          const content = created && created.op === 'create' ? created.content : updated && updated.op === 'update' ? updated.content : ''
          writes.push(content)
          calendar = [{ itemUid: 'gen-1', content }]
          return 'saved'
        },
        async checkSourceTokens(tokens) {
          const book = tokens.books.find((entry) => entry.bookUid === 'book-1')
          return {
            complete: true,
            inventoryChanged: false,
            changedBooks: book?.stoken !== bookStoken ? ['book-1'] : [],
          }
        },
      }
    }

    const a = runBirthdayCalendar({
      accountKey: 'client-a',
      username: 'me',
      gates: gates(),
      transport: transport(true),
    })
    await aReadBook.promise
    card = NEW_CARD
    bookStoken = 'book-2'
    const b = await runBirthdayCalendar({
      accountKey: 'client-b',
      username: 'me',
      gates: gates(),
      transport: transport(false),
    })
    bFinished.release()
    const aResult = await a

    expect(b.status).toBe('done')
    expect(aResult.status).toBe('done')
    expect(writes.map((content) => content === newEvent ? 'new' : content === oldEvent ? 'old' : 'other')).toEqual(['new', 'old', 'new'])
    expect(calendar[0]?.content).toBe(newEvent)
  })

  it('does not create again after an uncertain write that the server kept', async () => {
    const source = await birthdayEventsFromSource({
      inventoryComplete: true,
      books: [{ bookUid: 'book-1', complete: true, items: [{ itemUid: 'contact-1', content: OLD_CARD }] }],
    })
    expect(source.ok).toBe(true)
    if (!source.ok) return
    const event = birthdayEventContent(source.events[0]!)
    let stored = ''
    let creates = 0
    const transport: BirthdayTransport = {
      async listInventory() {
        return {
          complete: true,
          inventoryToken: 'inv-1',
          collections: [
            {
              uid: 'book-1', kind: 'address-book', accessLevel: 'readOnly', content: '', members: [], membersComplete: true,
              rootRevision: 'book-root', root: { uid: 'book-1' },
            },
            {
              uid: 'cal-1', kind: 'calendar', accessLevel: 'admin',
              content: '{"type":"silentsuite.birthdays","v":1,"state":"active"}',
              members: ['me'], membersComplete: true, rootRevision: 'root-1', root: { uid: 'cal-1' },
            },
          ],
        }
      },
      async listItems(collectionUid) {
        if (collectionUid === 'book-1') {
          return { complete: true, stoken: 'book-1', items: [{ itemUid: 'contact-1', content: OLD_CARD, revision: 'c1' }] }
        }
        return {
          complete: true,
          stoken: 'cal-1',
          items: stored ? [{ itemUid: 'gen-1', content: stored, revision: 'g1' }] : [],
        }
      },
      async applyChanges(input) {
        const created = input.changes.find((change) => change.op === 'create')
        if (created && created.op === 'create') {
          creates += 1
          stored = created.content
          return 'uncertain'
        }
        return 'saved'
      },
      async checkSourceTokens() {
        return { complete: true, inventoryChanged: false, changedBooks: [] }
      },
    }

    const result = await runBirthdayCalendar({ accountKey: 'acct', username: 'me', gates: gates(), transport })

    expect(creates).toBe(1)
    expect(stored).toBe(event)
    expect(result.status).toBe('done')
  })

  it('runs one follow-up for an overlapping trigger and keeps another account separate', async () => {
    let lists = 0
    let active = 0
    let maxActive = 0
    const hold = deferred()
    const started = deferred()
    const transport: BirthdayTransport = {
      async listInventory() {
        lists += 1
        active += 1
        maxActive = Math.max(maxActive, active)
        if (lists === 1) {
          started.release()
          await hold.promise
        }
        active -= 1
        return { complete: true, inventoryToken: 'inv', collections: [] }
      },
      async listItems() {
        return { complete: true, stoken: 's', items: [] }
      },
      async applyChanges() {
        return 'saved'
      },
      async checkSourceTokens() {
        return { complete: true, inventoryChanged: false, changedBooks: [] }
      },
    }
    const first = runBirthdayCalendar({ accountKey: 'acct', username: 'me', gates: gates(), transport })
    await started.promise
    const second = runBirthdayCalendar({ accountKey: 'acct', username: 'me', gates: gates(), transport })
    expect(lists).toBe(1)
    hold.release()
    await first
    await second
    expect(lists).toBe(2)
    expect(maxActive).toBe(1)

    const otherHold = deferred()
    let otherListed = false
    const otherStarted = deferred()
    const shared = deferred()
    const firstAccount = runBirthdayCalendar({
      accountKey: 'acct-1',
      username: 'me',
      gates: gates(),
      transport: {
        async listInventory() {
          shared.release()
          await otherHold.promise
          return { complete: true, inventoryToken: 'inv', collections: [] }
        },
        async listItems() { return { complete: true, stoken: null, items: [] } },
        async applyChanges() { return 'saved' },
      },
    })
    await shared.promise
    const secondAccount = runBirthdayCalendar({
      accountKey: 'acct-2',
      username: 'me',
      gates: { ...gates(), accountEpoch: 2 },
      transport: {
        async listInventory() {
          otherListed = true
          otherStarted.release()
          return { complete: true, inventoryToken: 'inv', collections: [] }
        },
        async listItems() { return { complete: true, stoken: null, items: [] } },
        async applyChanges() { return 'saved' },
      },
    })
    await otherStarted.promise
    expect(otherListed).toBe(true)
    otherHold.release()
    await firstAccount
    await secondAccount
  })

  it('does not call a rejected token check done, and stops after two fresh reruns', async () => {
    let rejectedLists = 0
    const rejected = await runBirthdayCalendar({
      accountKey: 'rejected',
      username: 'me',
      gates: gates(),
      transport: {
        async listInventory() {
          rejectedLists += 1
          return {
            complete: true,
            inventoryToken: 'inv',
            collections: [{
              uid: 'cal-1', kind: 'calendar', accessLevel: 'admin',
              content: '{"type":"silentsuite.birthdays","v":1,"state":"active"}',
              members: ['me'], membersComplete: true, rootRevision: 'root', root: { uid: 'cal-1' },
            }],
          }
        },
        async listItems() { return { complete: true, stoken: 'cal', items: [] } },
        async applyChanges() { return 'saved' },
        async checkSourceTokens() { throw new Error('rejected') },
      },
    })
    expect(rejected).toMatchObject({ status: 'pending', reason: 'post-check' })
    expect(rejectedLists).toBe(1)

    let boundedLists = 0
    const bounded = await runBirthdayCalendar({
      accountKey: 'bounded',
      username: 'me',
      gates: gates(),
      transport: {
        async listInventory() {
          boundedLists += 1
          return {
            complete: true,
            inventoryToken: `inv-${boundedLists}`,
            collections: [{
              uid: 'cal-1', kind: 'calendar', accessLevel: 'admin',
              content: '{"type":"silentsuite.birthdays","v":1,"state":"active"}',
              members: ['me'], membersComplete: true, rootRevision: 'root', root: { uid: 'cal-1' },
            }],
          }
        },
        async listItems() { return { complete: true, stoken: 'cal', items: [] } },
        async applyChanges() { return 'saved' },
        async checkSourceTokens() { return { complete: true, inventoryChanged: true, changedBooks: [] } },
      },
    })
    expect(bounded).toMatchObject({ status: 'pending', reason: 'post-check' })
    expect(boundedLists).toBe(3)

    let current = true
    let epochLists = 0
    const quiet = await runBirthdayCalendar({
      accountKey: 'epoch',
      username: 'me',
      gates: { ...gates(), isCurrentEpoch: () => current },
      transport: {
        async listInventory() {
          epochLists += 1
          return {
            complete: true,
            inventoryToken: 'inv',
            collections: [{
              uid: 'cal-1', kind: 'calendar', accessLevel: 'admin',
              content: '{"type":"silentsuite.birthdays","v":1,"state":"active"}',
              members: ['me'], membersComplete: true, rootRevision: 'root', root: { uid: 'cal-1' },
            }],
          }
        },
        async listItems() { return { complete: true, stoken: 'cal', items: [] } },
        async applyChanges() { return 'saved' },
        async checkSourceTokens() {
          current = false
          return { complete: true, inventoryChanged: true, changedBooks: [] }
        },
      },
    })
    expect(quiet).toMatchObject({ status: 'skipped', reason: 'stale-account' })
    expect(epochLists).toBe(1)
  })
})
