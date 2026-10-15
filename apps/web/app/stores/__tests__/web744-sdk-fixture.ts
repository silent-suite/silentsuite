import { createRequire } from 'node:module'
import path from 'node:path'
import { useEtebaseStore } from '../use-etebase-store'
import { getAccountEpoch } from '@/app/lib/account-epoch'

// The pinned Etebase 0.43.1 CJS build, resolved the way @silentsuite/core resolves it.
// Resolved from the file path, which holds in both node and jsdom test environments.
const requireFromCore = createRequire(path.resolve(__dirname, '../../../../../packages/core/package.json'))
export const Etebase = requireFromCore('etebase')
export const EtebaseRequest = requireFromCore('etebase/dist/lib-cjs/Request')
const { msgpackEncode, msgpackDecode } = requireFromCore('etebase/dist/lib-cjs/Helpers')

export const FINGERPRINT = 'web744-sdk-fixture-account'

export function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
}

function stored(item: any) {
  return { uid: item.uid, version: item.version, encryptionKey: item.encryptionKey ?? null, content: item.content }
}

function respond(status: number, body: unknown) {
  return { type: 'default', status, statusText: '', ok: status >= 200 && status < 300, body: msgpackEncode(body) }
}

/**
 * External transport following the reference server's item rules: a
 * transaction checks each supplied dependency and each submitted item's etag,
 * and nothing else. A child write is not rejected just because its collection
 * was deleted; only a supplied main-item dependency does that.
 */
export class ReferenceServer {
  offline = false
  /** After the next 409, every later request fails like an unreachable server. */
  offlineAfterConflict = false
  transactions: { items: any[]; deps: any[] | undefined }[] = []
  unregistered: string[] = []
  private stoken = 1
  private held: { arrived: () => void; gate: Promise<boolean>; match?: (method: string, path: string) => boolean } | null = null
  private collections = new Map<string, { collectionType: unknown; collectionKey: unknown; main: any; items: Map<string, any> }>()

  seed(collection: any, items: any[]) {
    const serialized = collection.encryptedCollection.serialize()
    this.collections.set(collection.uid, {
      collectionType: serialized.collectionType,
      collectionKey: serialized.collectionKey,
      main: stored(serialized.item),
      items: new Map(items.map((item) => [item.uid, stored(item.encryptedItem.serialize())])),
    })
  }

  /**
   * Hold the next request (or the next one `match` accepts) until
   * `release(networkFailure)`; `arrived` resolves once it has arrived.
   */
  holdNext(match?: (method: string, path: string) => boolean): { arrived: Promise<void>; release: (networkFailure: boolean) => void } {
    let arrived = () => {}
    const arrivedPromise = new Promise<void>((resolve) => { arrived = resolve })
    let release = (_networkFailure: boolean) => {}
    const gate = new Promise<boolean>((resolve) => { release = resolve })
    this.held = { arrived, gate, match }
    return { arrived: arrivedPromise, release }
  }

  /** Stores a collection's main item as another device's upload would, such as a tombstone. */
  replaceCollection(collection: any) {
    const col = this.collections.get(collection.uid)
    if (!col) throw new Error('unknown collection')
    col.main = stored(collection.encryptedCollection.serialize().item)
    this.stoken += 1
  }

  private lookup(col: { main: any; items: Map<string, any> }, uid: string) {
    return uid === col.main.uid ? col.main : col.items.get(uid)
  }

  async handle(url: string, options: any = {}) {
    const method = String(options.method ?? 'get').toLowerCase()
    const parts = new URL(url).pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (this.held && (!this.held.match || this.held.match(method, parts.join('/')))) {
      const held = this.held
      this.held = null
      held.arrived()
      if (await held.gate) throw new TypeError('Network request failed')
    }
    if (this.offline) throw new TypeError('Network request failed')
    // A supplied stoken that is no longer the collection's latest is refused with a 409
    // (reference server stale_stoken rule). This fixture keeps one stoken for all collections,
    // so any later write anywhere makes it stale: stricter than the server, never looser.
    const staleStoken = () => {
      const wanted = new URL(url).searchParams.get('stoken')
      return wanted !== null && wanted !== String(this.stoken)
    }
    if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'collection' && parts.length === 3 && method === 'post') {
      // First upload of a newly created collection.
      const body = msgpackDecode(options.body)
      this.collections.set(body.item.uid, { collectionType: body.collectionType, collectionKey: body.collectionKey, main: stored(body.item), items: new Map() })
      this.stoken += 1
      return respond(201, {})
    }
    if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'collection' && parts[3] === 'list_multi' && method === 'post') {
      // Collection listing by encrypted type, tombstones included as the server returns them.
      const body = msgpackDecode(options.body)
      const wanted = (type: any) => (body.collectionTypes ?? []).some((candidate: any) => Buffer.from(candidate).equals(Buffer.from(type)))
      const data = [...this.collections.values()]
        .filter((col) => wanted(col.collectionType))
        .map((col) => ({ item: col.main, collectionType: col.collectionType, collectionKey: col.collectionKey, accessLevel: 2, stoken: String(this.stoken) }))
      return respond(200, { data, stoken: String(this.stoken), done: true })
    }
    if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'collection' && parts[3]) {
      const col = this.collections.get(parts[3])
      if (!col) return respond(404, { detail: 'Not found.' })
      const rest = parts.slice(4)
      if (method === 'get' && rest.length === 0) {
        return respond(200, { item: col.main, collectionType: col.collectionType, collectionKey: col.collectionKey, accessLevel: 2, stoken: String(this.stoken) })
      }
      if (method === 'get' && rest.length === 1 && rest[0] === 'item') {
        return respond(200, { data: [...col.items.values()], stoken: String(this.stoken), done: true })
      }
      if (method === 'get' && rest.length === 2 && rest[0] === 'item') {
        const found = col.items.get(rest[1]!)
        return found ? respond(200, found) : respond(404, { detail: 'Not found.' })
      }
      if (method === 'post' && rest.join('/') === 'item/batch') {
        // Reference batch: dependencies are checked, item etags are not.
        const body = msgpackDecode(options.body)
        if (staleStoken()) return respond(409, { code: 'stale_stoken', detail: 'Stoken is too old' })
        for (const dep of body.deps ?? []) {
          const current = this.lookup(col, dep.uid)
          if (!current || current.content.uid !== dep.etag) return respond(409, { code: 'wrong_etag', detail: 'Wrong etag' })
        }
        for (const item of body.items) {
          if (item.uid === col.main.uid) col.main = stored(item)
          else col.items.set(item.uid, stored(item))
        }
        this.stoken += 1
        return respond(200, {})
      }
      if (method === 'post' && rest.join('/') === 'item/transaction') {
        const body = msgpackDecode(options.body)
        this.transactions.push({ items: body.items, deps: body.deps ?? undefined })
        const conflict = () => {
          if (this.offlineAfterConflict) this.offline = true
          return respond(409, { code: 'wrong_etag', detail: 'Wrong etag' })
        }
        if (staleStoken()) return conflict()
        for (const dep of body.deps ?? []) {
          const current = this.lookup(col, dep.uid)
          if (!current || current.content.uid !== dep.etag) return conflict()
        }
        for (const item of body.items) {
          const current = this.lookup(col, item.uid)
          if (current ? current.content.uid !== item.etag : item.etag != null) return conflict()
        }
        for (const item of body.items) {
          if (item.uid === col.main.uid) col.main = stored(item)
          else col.items.set(item.uid, stored(item))
        }
        this.stoken += 1
        return respond(200, {})
      }
    }
    this.unregistered.push(`${method} ${url}`)
    return respond(500, { detail: 'unregistered request' })
  }
}

/** A real SDK account, address book and saved vCard item, built locally without any server. */
export async function makeSavedContact(vcard: string) {
  const { account } = await makeSavedNote('unused 744', '')
  const collectionManager = account.getCollectionManager()
  const collection = await collectionManager.create('etebase.vcard', { name: 'Address book 744', mtime: 1 }, '')
  collection.encryptedCollection.__markSaved()
  const item = await collectionManager.getItemManager(collection).create({ mtime: 1 }, vcard)
  item.encryptedItem.__markSaved()
  return { account, collection, item }
}

export function installContactAccount(account: any, collection: any, cachedItem: any) {
  useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
  useEtebaseStore.setState({
    account,
    accountFingerprint: FINGERPRINT,
    collections: { calendar: [], tasks: [], contacts: [collection], notes: [], preferences: [] },
    itemCache: new Map([[cachedItem.uid, cachedItem]]),
    itemTypeMap: new Map([[cachedItem.uid, 'contacts']]),
    itemCollectionMap: new Map([[cachedItem.uid, collection.uid]]),
    domainLoadState: { calendar: 'loaded', tasks: 'loaded', contacts: 'loaded', notes: 'loaded', preferences: 'unknown' },
    isInitialized: true,
    syncEngine: null,
  } as any)
}

/** A real SDK account, notebook and saved note, built locally without any server. */
export async function makeSavedNote(title: string, body: string) {
  await Etebase.ready
  const version = Etebase.CURRENT_VERSION
  const mainKey = Etebase.randomBytes(32)
  // Raw byte inputs use the SDK's own Uint8Array constructor: under jsdom the test
  // realm's constructor differs, and libsodium rejects arrays from another realm.
  const SdkBytes = Etebase.randomBytes(1).constructor as Uint8ArrayConstructor
  const accountContent = new SdkBytes(64)
  accountContent.set(Etebase.randomBytes(32), 0)
  accountContent.set(Etebase.randomBytes(32), 32)
  const account = new Etebase.Account(mainKey, version)
  account.user = {
    username: 'web744',
    email: 'web744@example.invalid',
    pubkey: new SdkBytes(32),
    encryptedContent: Etebase.getMainCryptoManager(mainKey, version).encrypt(accountContent),
  }
  account.serverUrl = 'https://etebase.invalid/'
  account.authToken = 'web744-token'
  const collectionManager = account.getCollectionManager()
  const collection = await collectionManager.create('etebase.md.note', { name: 'Notebook 744', mtime: 1 }, '')
  collection.encryptedCollection.__markSaved()
  const item = await collectionManager.getItemManager(collection).create({ name: title, mtime: 1 }, body)
  item.encryptedItem.__markSaved()
  return { account, collection, item }
}

export function installNoteAccount(account: any, collection: any, cachedItem: any) {
  useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
  useEtebaseStore.setState({
    account,
    accountFingerprint: FINGERPRINT,
    collections: { calendar: [], tasks: [], contacts: [], notes: [collection], preferences: [] },
    itemCache: new Map([[cachedItem.uid, cachedItem]]),
    itemTypeMap: new Map([[cachedItem.uid, 'notes']]),
    itemCollectionMap: new Map([[cachedItem.uid, collection.uid]]),
    domainLoadState: { calendar: 'loaded', tasks: 'loaded', contacts: 'loaded', notes: 'loaded', preferences: 'unknown' },
    isInitialized: true,
    syncEngine: null,
  } as any)
}

export function queueGuard() {
  return { accountEpoch: getAccountEpoch(), accountFingerprint: FINGERPRINT }
}

export async function serverText(account: any, collection: any, uid: string): Promise<string | null> {
  const response = await account.getCollectionManager().getItemManager(collection).list()
  const found = response.data.find((candidate: any) => candidate.uid === uid)
  if (!found) return null
  return new TextDecoder().decode(await found.getContent())
}
