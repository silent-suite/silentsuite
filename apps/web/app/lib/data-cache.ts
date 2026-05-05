/**
 * Local data cache for instant reload — IndexedDB-backed, plain JSON values.
 *
 * Stores already-decrypted item content (iCal/vCard/vTodo strings) plus
 * per-collection sync cursors (stokens) so that on the next page load the
 * UI can paint from the cache before the network sync completes.
 *
 * SCOPE: This module follows the same raw-IDB pattern as `secure-storage.ts`
 * and `offline-queue.ts` — no `idb` / Dexie dependency.
 *
 * AT-REST ENCRYPTION: NOT applied. Decrypted item content sits in plain
 * IndexedDB. This is consistent with the bridge's behavior (it stores its
 * cache in plain SQLite, not sqlcipher) and with the wider PWA ecosystem
 * (Slack, Linear, Notion all do the same). Encrypting the cache at rest is
 * tracked in a separate follow-up that covers webapp + bridge + Android
 * together.
 *
 * Gated by the `NEXT_PUBLIC_LOCAL_CACHE_ENABLED` feature flag in callers.
 * This module itself does not check the flag — the flag is checked at the
 * caller boundaries (sync-provider, etebase-store, auth-store) so this
 * module stays pure and easy to test.
 */
import { logger } from '@/app/lib/logger'

export type CollectionTypeKey = 'calendar' | 'tasks' | 'contacts'

export interface CachedItem {
  itemUid: string
  collectionType: CollectionTypeKey
  collectionUid: string
  /** Already-decrypted iCal / vCard / vTodo string */
  content: string
  /** Last time we wrote this record to the cache (ms epoch) */
  lastModified: number
}

export interface CachedCollection {
  collectionType: CollectionTypeKey
  collectionUid: string
  stoken: string | null
  lastFullSyncAt: number | null
}

export interface CacheMeta {
  /** Hash or username of the Etebase account this cache belongs to */
  accountFingerprint: string | null
  /** Schema version of the cache; bumped when shapes change to force re-sync */
  cacheSchemaVersion: number
  /** Last time the cache was wholesale invalidated (logout, schema bump) */
  lastInvalidatedAt: number | null
}

/** Bumped on shape changes to the cached records. */
export const CACHE_SCHEMA_VERSION = 1

const DB_NAME = 'silentsuite-data-cache'
const DB_VERSION = 1
const STORE_ITEMS = 'items'
const STORE_COLLECTIONS = 'collections'
const STORE_META = 'meta'

const META_KEY = 'singleton'

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_ITEMS)) {
        const items = db.createObjectStore(STORE_ITEMS, { keyPath: 'itemUid' })
        items.createIndex('byCollectionType', 'collectionType', { unique: false })
        items.createIndex('byCollectionUid', 'collectionUid', { unique: false })
      }
      if (!db.objectStoreNames.contains(STORE_COLLECTIONS)) {
        db.createObjectStore(STORE_COLLECTIONS, { keyPath: 'collectionType' })
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      dbPromise = null
      reject(request.error)
    }
  })
  return dbPromise
}

function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode)
        const store = tx.objectStore(storeName)
        const req = fn(store)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

// ── Items ──

/**
 * Read all cached items for a collection type.
 * Returns an empty array if the cache is empty or unavailable.
 */
export async function getItemsByType(type: CollectionTypeKey): Promise<CachedItem[]> {
  try {
    const db = await openDB()
    return await new Promise<CachedItem[]>((resolve, reject) => {
      const tx = db.transaction(STORE_ITEMS, 'readonly')
      const idx = tx.objectStore(STORE_ITEMS).index('byCollectionType')
      const req = idx.getAll(type)
      req.onsuccess = () => resolve((req.result as CachedItem[]) ?? [])
      req.onerror = () => reject(req.error)
    })
  } catch (err) {
    logger.warn('[data-cache] getItemsByType failed', err)
    return []
  }
}

/** Insert/update a single item. Failures are logged and swallowed. */
export async function putItem(item: CachedItem): Promise<void> {
  try {
    await withStore(STORE_ITEMS, 'readwrite', (store) => store.put(item))
  } catch (err) {
    logger.warn('[data-cache] putItem failed', err)
  }
}

/** Bulk insert/update — single transaction for efficiency. */
export async function putItems(items: CachedItem[]): Promise<void> {
  if (items.length === 0) return
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_ITEMS, 'readwrite')
      const store = tx.objectStore(STORE_ITEMS)
      for (const item of items) store.put(item)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (err) {
    logger.warn('[data-cache] putItems failed', err)
  }
}

export async function deleteItem(itemUid: string): Promise<void> {
  try {
    await withStore(STORE_ITEMS, 'readwrite', (store) => store.delete(itemUid))
  } catch (err) {
    logger.warn('[data-cache] deleteItem failed', err)
  }
}

/**
 * Replace all cached items for a collection type with the given list.
 * Used after a full refresh so removed-on-server items don't linger.
 */
export async function replaceItemsForType(
  type: CollectionTypeKey,
  items: CachedItem[],
): Promise<void> {
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_ITEMS, 'readwrite')
      const store = tx.objectStore(STORE_ITEMS)
      const idx = store.index('byCollectionType')
      const cursorReq = idx.openCursor(type)
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result
        if (cursor) {
          cursor.delete()
          cursor.continue()
        } else {
          for (const item of items) store.put(item)
        }
      }
      cursorReq.onerror = () => reject(cursorReq.error)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (err) {
    logger.warn('[data-cache] replaceItemsForType failed', err)
  }
}

// ── Collections / stokens ──

export async function getCollection(type: CollectionTypeKey): Promise<CachedCollection | null> {
  try {
    const value = await withStore(STORE_COLLECTIONS, 'readonly', (store) => store.get(type))
    return (value as CachedCollection | undefined) ?? null
  } catch (err) {
    logger.warn('[data-cache] getCollection failed', err)
    return null
  }
}

export async function putCollection(record: CachedCollection): Promise<void> {
  try {
    await withStore(STORE_COLLECTIONS, 'readwrite', (store) => store.put(record))
  } catch (err) {
    logger.warn('[data-cache] putCollection failed', err)
  }
}

export async function getStoken(type: CollectionTypeKey): Promise<string | null> {
  const col = await getCollection(type)
  return col?.stoken ?? null
}

export async function setStoken(
  type: CollectionTypeKey,
  collectionUid: string,
  stoken: string | null,
): Promise<void> {
  const existing = await getCollection(type)
  await putCollection({
    collectionType: type,
    collectionUid,
    stoken,
    lastFullSyncAt: existing?.lastFullSyncAt ?? Date.now(),
  })
}

/**
 * Mark a collection's stoken as stale (server returned an unknown-stoken error).
 * Caller should fall back to a full refresh.
 */
export async function clearStoken(type: CollectionTypeKey): Promise<void> {
  const existing = await getCollection(type)
  if (!existing) return
  await putCollection({ ...existing, stoken: null })
}

// ── Meta ──

export async function getMeta(): Promise<CacheMeta | null> {
  try {
    const value = await withStore(STORE_META, 'readonly', (store) => store.get(META_KEY))
    return (value as CacheMeta | undefined) ?? null
  } catch (err) {
    logger.warn('[data-cache] getMeta failed', err)
    return null
  }
}

export async function putMeta(meta: CacheMeta): Promise<void> {
  try {
    await withStore(STORE_META, 'readwrite', (store) => store.put(meta, META_KEY))
  } catch (err) {
    logger.warn('[data-cache] putMeta failed', err)
  }
}

// ── Whole-cache operations ──

/**
 * Wipe everything — items, collections, meta. Called on logout, password
 * change, account fingerprint mismatch, or schema bump.
 */
export async function clearAll(): Promise<void> {
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_ITEMS, STORE_COLLECTIONS, STORE_META], 'readwrite')
      tx.objectStore(STORE_ITEMS).clear()
      tx.objectStore(STORE_COLLECTIONS).clear()
      tx.objectStore(STORE_META).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (err) {
    logger.warn('[data-cache] clearAll failed', err)
  }
}

/**
 * Verify the cache belongs to the expected account and is on the current
 * schema version. If not, wipe and reseed the meta record. Returns true if
 * the cache survived the check (callers can use it), false if it was wiped.
 */
export async function ensureFingerprint(accountFingerprint: string): Promise<boolean> {
  const meta = await getMeta()
  const current: CacheMeta = {
    accountFingerprint,
    cacheSchemaVersion: CACHE_SCHEMA_VERSION,
    lastInvalidatedAt: meta?.lastInvalidatedAt ?? null,
  }

  if (!meta) {
    await putMeta(current)
    return true
  }

  const fingerprintMismatch =
    meta.accountFingerprint !== null && meta.accountFingerprint !== accountFingerprint
  const schemaMismatch = meta.cacheSchemaVersion !== CACHE_SCHEMA_VERSION

  if (fingerprintMismatch || schemaMismatch) {
    logger.warn('[data-cache] fingerprint or schema mismatch, clearing cache', {
      fingerprintMismatch,
      schemaMismatch,
    })
    await clearAll()
    await putMeta({ ...current, lastInvalidatedAt: Date.now() })
    return false
  }

  // First-time fingerprint write (e.g. legacy cache without fingerprint)
  if (meta.accountFingerprint === null) {
    await putMeta(current)
  }
  return true
}

// ── Feature flag helper ──

/**
 * Returns true if the local cache feature is enabled via the env flag.
 * Off by default — when false, the cache is never read or written and
 * the app behaves identically to pre-PR.
 */
export function isCacheEnabled(): boolean {
  return process.env.NEXT_PUBLIC_LOCAL_CACHE_ENABLED === 'true'
}

// ── Test helpers ──

/** Reset the module-level DB promise — for tests only. */
export async function _resetForTests(): Promise<void> {
  if (dbPromise) {
    try {
      const db = await dbPromise
      db.close()
    } catch {
      // ignore
    }
  }
  dbPromise = null
}
