/**
 * Etebase adapter for the Birthdays transport (#738).
 *
 * Lists and item writes go through the account's collection manager. Item
 * transactions depend on the collection root read in this run. Retirement,
 * enable, disable, post-check and overlapping-run coalescing are not here.
 */
import { COLLECTION_TYPE_CALENDAR, COLLECTION_TYPE_CONTACTS, savedRevisionOf } from '@silentsuite/core'
import type {
  BirthdayApplyInput,
  BirthdayGates,
  BirthdayItemChange,
  BirthdayListedCollection,
  BirthdayListedItem,
  BirthdayTransport,
} from './reconcile'

const MAX_PAGES = 1000
const WRITE_CHUNK = 50
/** Etebase.OutputFormat.String. Kept numeric so this module does not import the SDK package. */
const CONTENT_AS_STRING = 1
const ACCESS_ADMIN = 1
const ACCESS_READ_WRITE = 2

export class BirthdayTransportGateError extends Error {
  constructor() {
    super('Birthday transport gate closed')
    this.name = 'BirthdayTransportGateError'
  }
}

export class BirthdayTransportClosedError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'BirthdayTransportClosedError'
  }
}

interface ItemLike {
  uid: string
  etag: string
  isDeleted?: boolean
  encryptedItem?: { lastEtag?: string | null }
  collectionUid?: string
  getContent(format?: number): Promise<string | Uint8Array>
  setContent(content: string): Promise<void>
  delete(): void
  _clone(): ItemLike
}

interface CollectionLike {
  uid: string
  isDeleted?: boolean
  accessLevel: number
  item: ItemLike
  encryptedCollection?: { item: unknown }
  getCollectionType(): string
  getContent(format?: number): Promise<string | Uint8Array>
  setContent?(content: string): Promise<void>
}

interface ListPage<T> {
  data: T[]
  stoken?: string | null
  done?: boolean
}

interface AccountLike {
  user: { username: string }
  getCollectionManager(): {
    list(types: string | string[], options?: { stoken?: string }): Promise<ListPage<CollectionLike>>
    getItemManager(collection: CollectionLike): {
      list(options?: { stoken?: string }): Promise<ListPage<ItemLike>>
      create(meta: { mtime?: number }, content: string): Promise<ItemLike>
      transaction(items: ItemLike[], deps?: ItemLike[] | null): Promise<void>
    }
    getMemberManager(collection: CollectionLike): {
      list(options?: { iterator?: string | null }): Promise<{
        data: Array<{ username: string }>
        iterator?: string | null
        done?: boolean
      }>
    }
    upload?(collection: CollectionLike): Promise<void>
    create?(collectionType: string, meta: { name?: string }, content: string): Promise<CollectionLike>
  }
}

function gateClosed(gates: BirthdayGates): boolean {
  return !gates.isCurrentEpoch() || !gates.canWrite() || !gates.isOnline()
}

function assertGate(gates: BirthdayGates): void {
  if (gateClosed(gates)) throw new BirthdayTransportGateError()
}

function isNamed(err: unknown, name: string): boolean {
  return err instanceof Error && err.name === name
}

function writeOutcome(err: unknown): 'conflict' | 'uncertain' | null {
  if (isNamed(err, 'ConflictError')) return 'conflict'
  if (isNamed(err, 'NetworkError') || isNamed(err, 'TemporaryServerError')) return 'uncertain'
  return null
}

async function readText(entity: { getContent(format?: number): Promise<string | Uint8Array> }): Promise<string | null> {
  try {
    const raw = await entity.getContent(CONTENT_AS_STRING)
    if (typeof raw === 'string') return raw
    return new TextDecoder().decode(raw)
  } catch {
    return null
  }
}

function accessLevel(level: number): BirthdayListedCollection['accessLevel'] {
  if (level === ACCESS_ADMIN) return 'admin'
  if (level === ACCESS_READ_WRITE) return 'readWrite'
  return 'readOnly'
}

function sameRoot(root: unknown, collection: CollectionLike): root is ItemLike {
  if (!root || typeof root !== 'object') return false
  const encrypted = (root as ItemLike).encryptedItem
  const collectionEncrypted = collection.encryptedCollection?.item
  if (encrypted && collectionEncrypted) return encrypted === collectionEncrypted
  return root === collection.item
}

async function pageUntilDone<T>(
  gates: BirthdayGates,
  first: () => Promise<ListPage<T>>,
  next: (stoken: string) => Promise<ListPage<T>>,
): Promise<{ complete: true; token: string; rows: T[] } | { complete: false }> {
  assertGate(gates)
  const seen = new Set<string>()
  let page = await first()
  assertGate(gates)
  const byKey = new Map<string, T>()
  const keyOf = (row: T, index: number) => {
    const uid = (row as { uid?: string }).uid
    return uid ?? String(index)
  }
  const take = (rows: T[]) => {
    rows.forEach((row, index) => byKey.set(keyOf(row, byKey.size + index), row))
  }
  take(page.data ?? [])
  let pages = 1
  while (page.done !== true) {
    if (pages >= MAX_PAGES) return { complete: false }
    const stoken = page.stoken
    if (!stoken || seen.has(stoken)) return { complete: false }
    seen.add(stoken)
    pages += 1
    assertGate(gates)
    page = await next(stoken)
    assertGate(gates)
    take(page.data ?? [])
  }
  if (!page.stoken) return { complete: false }
  return { complete: true, token: page.stoken, rows: [...byKey.values()] }
}

export function createEtebaseBirthdayTransport(account: AccountLike, gates: BirthdayGates): BirthdayTransport {
  const collections = new Map<string, CollectionLike>()
  const items = new Map<string, ItemLike>()

  return {
    async listInventory() {
      collections.clear()
      items.clear()
      if (gateClosed(gates)) return { complete: false, inventoryToken: null, collections: [] }
      const manager = account.getCollectionManager()
      const types = [COLLECTION_TYPE_CALENDAR, COLLECTION_TYPE_CONTACTS]
      const listed = await pageUntilDone(
        gates,
        () => manager.list(types),
        (stoken) => manager.list(types, { stoken }),
      )
      if (!listed.complete) return { complete: false, inventoryToken: null, collections: [] }

      const result: BirthdayListedCollection[] = []
      for (const collection of listed.rows) {
        if (collection.isDeleted) continue
        assertGate(gates)
        const type = collection.getCollectionType()
        const kind = type === COLLECTION_TYPE_CALENDAR ? 'calendar' : type === COLLECTION_TYPE_CONTACTS ? 'address-book' : null
        if (!kind) continue
        const content = await readText(collection)
        assertGate(gates)
        let members: string[] = []
        let membersComplete = true
        if (kind === 'calendar' && collection.accessLevel === ACCESS_ADMIN && content !== null) {
          const memberPage = await listMembers(account, collection, gates)
          members = memberPage.members
          membersComplete = memberPage.complete
        }
        collections.set(collection.uid, collection)
        const root = collection.item
        result.push({
          uid: collection.uid,
          kind,
          accessLevel: accessLevel(collection.accessLevel),
          content,
          members,
          membersComplete,
          rootRevision: savedRevisionOf(root as never) ?? '',
          root,
        })
      }
      return { complete: true, inventoryToken: listed.token, collections: result }
    },

    async listItems(collectionUid) {
      const collection = collections.get(collectionUid)
      if (!collection) return { complete: false, stoken: null, items: [] }
      if (gateClosed(gates)) return { complete: false, stoken: null, items: [] }
      const manager = account.getCollectionManager().getItemManager(collection)
      const listed = await pageUntilDone(
        gates,
        () => manager.list(),
        (stoken) => manager.list({ stoken }),
      )
      if (!listed.complete) return { complete: false, stoken: null, items: [] }
      const rows: BirthdayListedItem[] = []
      for (const item of listed.rows) {
        if (item.isDeleted) {
          items.delete(`${collectionUid}/${item.uid}`)
          continue
        }
        assertGate(gates)
        const content = await readText(item)
        assertGate(gates)
        items.set(`${collectionUid}/${item.uid}`, item)
        rows.push({ itemUid: item.uid, content, revision: savedRevisionOf(item as never) ?? '' })
      }
      return { complete: true, stoken: listed.token, items: rows }
    },

    async applyChanges(input) {
      const collection = collections.get(input.collectionUid)
      if (!collection) throw new BirthdayTransportClosedError('missing-collection')
      if (!sameRoot(input.root, collection)) throw new BirthdayTransportClosedError('missing-root')
      const root = input.root
      const revision = savedRevisionOf(root as never)
      if (!revision || revision !== input.rootRevision) throw new BirthdayTransportClosedError('missing-root')
      const manager = account.getCollectionManager().getItemManager(collection)
      for (let offset = 0; offset < input.changes.length; offset += WRITE_CHUNK) {
        assertGate(gates)
        const prepared = await prepareChunk(manager, items, input.collectionUid, input.changes.slice(offset, offset + WRITE_CHUNK), gates)
        assertGate(gates)
        try {
          await manager.transaction(prepared, [root])
        } catch (err) {
          const outcome = writeOutcome(err)
          if (outcome) return outcome
          throw err
        }
        assertGate(gates)
      }
      return 'saved'
    },

    async retireCalendar(input) {
      const collection = collections.get(input.collectionUid)
      if (!collection || !sameRoot(input.root, collection)) throw new BirthdayTransportClosedError('missing-root')
      const previous = savedRevisionOf(input.root as never)
      if (!previous || previous !== input.rootRevision) throw new BirthdayTransportClosedError('missing-root')
      if (!collection.setContent) throw new BirthdayTransportClosedError('missing-root')
      assertGate(gates)
      await collection.setContent(input.content)
      assertGate(gates)
      const manager = account.getCollectionManager()
      if (!manager.upload) throw new BirthdayTransportClosedError('missing-root')
      try {
        await manager.upload(collection)
      } catch (err) {
        const outcome = writeOutcome(err)
        if (outcome) return { kind: outcome }
        throw err
      }
      assertGate(gates)
      const root = collection.item
      const rootRevision = savedRevisionOf(root as never)
      if (!rootRevision || rootRevision === previous) throw new BirthdayTransportClosedError('missing-root')
      return { kind: 'retired', rootRevision, root }
    },

    async checkSourceTokens(tokens) {
      if (gateClosed(gates)) return { complete: false, inventoryChanged: false, changedBooks: [] }
      const manager = account.getCollectionManager()
      const types = [COLLECTION_TYPE_CALENDAR, COLLECTION_TYPE_CONTACTS]
      let inventoryChanged = false
      try {
        const listed = await pageUntilDone(
          gates,
          () => manager.list(types, { stoken: tokens.inventoryToken }),
          (stoken) => manager.list(types, { stoken }),
        )
        if (!listed.complete) return { complete: false, inventoryChanged: false, changedBooks: [] }
        inventoryChanged = listed.rows.length > 0
      } catch {
        return { complete: false, inventoryChanged: false, changedBooks: [] }
      }
      const changedBooks: string[] = []
      for (const book of tokens.books) {
        if (gateClosed(gates)) return { complete: false, inventoryChanged, changedBooks }
        const collection = collections.get(book.bookUid)
        if (!collection) return { complete: false, inventoryChanged, changedBooks }
        try {
          const listed = await pageUntilDone(
            gates,
            () => manager.getItemManager(collection).list({ stoken: book.stoken }),
            (stoken) => manager.getItemManager(collection).list({ stoken }),
          )
          if (!listed.complete) return { complete: false, inventoryChanged, changedBooks }
          if (listed.rows.length > 0) changedBooks.push(book.bookUid)
        } catch {
          return { complete: false, inventoryChanged, changedBooks }
        }
      }
      return { complete: true, inventoryChanged, changedBooks }
    },

    async createBirthdayCalendar(input) {
      assertGate(gates)
      const manager = account.getCollectionManager()
      if (!manager.create || !manager.upload) throw new BirthdayTransportClosedError('missing-root')
      const collection = await manager.create(COLLECTION_TYPE_CALENDAR, { name: input.name }, input.content)
      assertGate(gates)
      try {
        await manager.upload(collection)
      } catch (err) {
        const outcome = writeOutcome(err)
        if (outcome) return { kind: outcome }
        throw err
      }
      assertGate(gates)
      const root = collection.item
      const rootRevision = savedRevisionOf(root as never)
      if (!rootRevision) throw new BirthdayTransportClosedError('missing-root')
      collections.set(collection.uid, collection)
      return { kind: 'created', collectionUid: collection.uid, rootRevision, root }
    },
  }
}

async function listMembers(
  account: AccountLike,
  collection: CollectionLike,
  gates: BirthdayGates,
): Promise<{ complete: boolean; members: string[] }> {
  const manager = account.getCollectionManager().getMemberManager(collection)
  const members: string[] = []
  const seen = new Set<string>()
  let iterator: string | null | undefined
  let done = false
  let pages = 0
  while (!done) {
    pages += 1
    if (pages > MAX_PAGES) return { complete: false, members }
    assertGate(gates)
    let page: { data: Array<{ username: string }>; iterator?: string | null; done?: boolean }
    try {
      page = await manager.list(iterator ? { iterator } : undefined)
    } catch {
      return { complete: false, members }
    }
    assertGate(gates)
    members.push(...(page.data ?? []).map((member) => member.username))
    if (page.done === true) {
      done = true
      break
    }
    if (!page.iterator || seen.has(page.iterator)) return { complete: false, members }
    seen.add(page.iterator)
    iterator = page.iterator
  }
  return { complete: true, members }
}

async function prepareChunk(
  manager: { create(meta: { mtime?: number }, content: string): Promise<ItemLike> },
  items: Map<string, ItemLike>,
  collectionUid: string,
  changes: BirthdayItemChange[],
  gates: BirthdayGates,
): Promise<ItemLike[]> {
  const prepared: ItemLike[] = []
  for (const change of changes) {
    assertGate(gates)
    if (change.op === 'create') {
      const created = await manager.create({ mtime: 1 }, change.content)
      assertGate(gates)
      prepared.push(created)
      continue
    }
    const existing = items.get(`${collectionUid}/${change.itemUid}`)
    if (!existing) throw new BirthdayTransportClosedError('missing-item')
    const clone = existing._clone()
    if (change.op === 'update') {
      await clone.setContent(change.content)
      assertGate(gates)
    } else {
      clone.delete()
      assertGate(gates)
    }
    prepared.push(clone)
  }
  return prepared
}

export type { BirthdayApplyInput }
