/**
 * Local data cache for instant reload — IndexedDB-backed values.
 *
 * Stores decrypted item content at the public call boundary, but encrypts item
 * content before it reaches IndexedDB. Collection/type indexes and stokens stay
 * plaintext client-local metadata so cache reads can be efficient; item PIM
 * content must never be stored as raw iCal/vCard/vTodo text.
 *
 * SCOPE: This module follows the same raw-IDB pattern as `secure-storage.ts`
 * and `offline-queue.ts` — no `idb` / Dexie dependency.
 *
 * AT-REST ENCRYPTION: required before item content writes are allowed. Until
 * an encrypted cache envelope exists, decrypted item content writes fail
 * closed even if the public feature flag is accidentally enabled.
 *
 * Gated by both the `NEXT_PUBLIC_LOCAL_CACHE_ENABLED` feature flag and the
 * encrypted-envelope availability check.
 */
import { logger } from '@/app/lib/logger'

export type CollectionTypeKey = 'calendar' | 'tasks' | 'contacts' | 'preferences'

export interface CachedItem {
  itemUid: string
  collectionType: CollectionTypeKey
  collectionUid: string
  /** Already-decrypted iCal / vCard / vTodo string */
  content: string
  /** Last time we wrote this record to the cache (ms epoch) */
  lastModified: number
}

interface StoredItem {
  itemUid: string
  collectionType: CollectionTypeKey
  collectionUid: string
  /** AES-GCM IV bytes */
  iv: number[]
  /** AES-GCM ciphertext bytes */
  ct: number[]
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
export const CACHE_SCHEMA_VERSION = 5

const DB_NAME = 'silentsuite-data-cache'
const DB_VERSION = 5
const STORE_ITEMS = 'items'
const STORE_COLLECTIONS = 'collections'
const STORE_META = 'meta'
const STORE_CRYPTO = 'crypto'

const META_KEY = 'singleton'
const ENVELOPE_KEY = 'envelope-key'

let dbPromise: Promise<IDBDatabase> | null = null
let encryptedCacheAvailableForTests: boolean | null = null
let envelopeKey: CryptoKey | null = null
let envelopeReady = false

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function hasWebCrypto(): boolean {
  return Boolean(globalThis.crypto?.subtle && globalThis.crypto?.getRandomValues)
}

function hasEncryptedCacheEnvelope(): boolean {
  if (encryptedCacheAvailableForTests !== null) {
    return encryptedCacheAvailableForTests && envelopeKey !== null
  }
  return hasWebCrypto() && envelopeReady && envelopeKey !== null
}

function canWriteItemContent(operation: string): boolean {
  if (hasEncryptedCacheEnvelope()) return true
  logger.warn(`[data-cache] ${operation} skipped; encrypted cache envelope is unavailable`)
  return false
}

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = (event) => {
      const db = request.result
      // v5 stores item content as ciphertext and reintroduces the crypto key
      // store after the v4 rollback. Wipe earlier local-cache schemas rather
      // than trying to reinterpret plaintext/v3 crypto records.
      if (event.oldVersion > 0 && event.oldVersion < 5) {
        for (const storeName of [STORE_ITEMS, STORE_COLLECTIONS, STORE_META, STORE_CRYPTO]) {
          if (db.objectStoreNames.contains(storeName)) db.deleteObjectStore(storeName)
        }
      }
      if (!db.objectStoreNames.contains(STORE_ITEMS)) {
        const items = db.createObjectStore(STORE_ITEMS, { keyPath: 'itemUid' })
        items.createIndex('byCollectionType', 'collectionType', { unique: false })
        items.createIndex('byCollectionUid', 'collectionUid', { unique: false })
      }
      if (!db.objectStoreNames.contains(STORE_COLLECTIONS)) {
        db.createObjectStore(STORE_COLLECTIONS, { keyPath: 'collectionUid' })
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META)
      }
      if (!db.objectStoreNames.contains(STORE_CRYPTO)) {
        db.createObjectStore(STORE_CRYPTO)
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

async function getStoredEnvelopeKey(): Promise<CryptoKey | null> {
  try {
    const key = await withStore<CryptoKey | undefined>(STORE_CRYPTO, 'readonly', (store) => store.get(ENVELOPE_KEY))
    return key ?? null
  } catch (err) {
    logger.warn('[data-cache] encrypted envelope key read failed', err)
    return null
  }
}

async function putStoredEnvelopeKey(key: CryptoKey): Promise<void> {
  await withStore<IDBValidKey>(STORE_CRYPTO, 'readwrite', (store) => store.put(key, ENVELOPE_KEY))
}

/**
 * Ensure the encrypted cache envelope is ready for this browser session.
 * Returns false instead of throwing so cache enablement always fails closed.
 */
export async function ensureEncryptedEnvelope(): Promise<boolean> {
  if (!hasWebCrypto()) {
    envelopeKey = null
    envelopeReady = false
    return false
  }

  if (envelopeKey && envelopeReady) return true

  try {
    const existing = await getStoredEnvelopeKey()
    if (existing) {
      envelopeKey = existing
      envelopeReady = true
      return true
    }

    const generated = await globalThis.crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
    await putStoredEnvelopeKey(generated)
    envelopeKey = generated
    envelopeReady = true
    return true
  } catch (err) {
    logger.warn('[data-cache] encrypted envelope unavailable', err)
    envelopeKey = null
    envelopeReady = false
    return false
  }
}

async function encryptContent(content: string): Promise<{ iv: number[]; ct: number[] }> {
  if (!envelopeKey) throw new Error('Encrypted cache envelope is unavailable')
  const iv = new Uint8Array(12)
  globalThis.crypto.getRandomValues(iv)
  const encrypted = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    envelopeKey,
    encoder.encode(content),
  )
  return {
    iv: Array.from(iv),
    ct: Array.from(new Uint8Array(encrypted)),
  }
}

async function decryptStoredItem(item: StoredItem): Promise<CachedItem> {
  if (!envelopeKey) throw new Error('Encrypted cache envelope is unavailable')
  if (!Array.isArray(item.iv) || !Array.isArray(item.ct)) {
    throw new Error('Encrypted cache record is malformed')
  }
  const decrypted = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: Uint8Array.from(item.iv) },
    envelopeKey,
    Uint8Array.from(item.ct),
  )
  return {
    itemUid: item.itemUid,
    collectionType: item.collectionType,
    collectionUid: item.collectionUid,
    content: decoder.decode(decrypted),
    lastModified: item.lastModified,
  }
}

async function toStoredItem(item: CachedItem): Promise<StoredItem> {
  const encrypted = await encryptContent(item.content)
  return {
    itemUid: item.itemUid,
    collectionType: item.collectionType,
    collectionUid: item.collectionUid,
    iv: encrypted.iv,
    ct: encrypted.ct,
    lastModified: item.lastModified,
  }
}

// ── Items ──

/**
 * Read all cached items for a collection type.
 * Returns an empty array if the cache is empty, unavailable, or undecryptable.
 */
export async function getItemsByType(type: CollectionTypeKey): Promise<CachedItem[]> {
  if (!hasEncryptedCacheEnvelope()) return []
  try {
    const db = await openDB()
    const records = await new Promise<StoredItem[]>((resolve, reject) => {
      const tx = db.transaction(STORE_ITEMS, 'readonly')
      const idx = tx.objectStore(STORE_ITEMS).index('byCollectionType')
      const req = idx.getAll(type)
      req.onsuccess = () => resolve((req.result as StoredItem[]) ?? [])
      req.onerror = () => reject(req.error)
    })

    const items: CachedItem[] = []
    for (const record of records) {
      try {
        items.push(await decryptStoredItem(record))
      } catch (err) {
        logger.warn('[data-cache] cached item decrypt failed', { name: err instanceof Error ? err.name : 'Error' })
      }
    }
    return items
  } catch (err) {
    logger.warn('[data-cache] getItemsByType failed', err)
    return []
  }
}

/** Insert/update a single item. Failures are logged and swallowed. */
export async function putItem(item: CachedItem): Promise<void> {
  if (!canWriteItemContent('putItem')) return
  try {
    const stored = await toStoredItem(item)
    await withStore(STORE_ITEMS, 'readwrite', (store) => store.put(stored))
  } catch (err) {
    logger.warn('[data-cache] putItem failed', err)
  }
}

/** Bulk insert/update — single transaction for efficiency. */
export async function putItems(items: CachedItem[]): Promise<void> {
  if (items.length === 0) return
  if (!canWriteItemContent('putItems')) return
  try {
    const storedItems = await Promise.all(items.map(toStoredItem))
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_ITEMS, 'readwrite')
      const store = tx.objectStore(STORE_ITEMS)
      for (const item of storedItems) store.put(item)
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
  if (!canWriteItemContent('replaceItemsForType')) return
  try {
    const storedItems = await Promise.all(items.map(toStoredItem))
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
          for (const item of storedItems) store.put(item)
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

/**
 * Replace all cached items for one concrete collection. Other collections of
 * the same type are intentionally left intact.
 */
export async function replaceItemsForCollection(
  collectionUid: string,
  items: CachedItem[],
): Promise<void> {
  if (!canWriteItemContent('replaceItemsForCollection')) return
  try {
    const storedItems = await Promise.all(items.map(toStoredItem))
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_ITEMS, 'readwrite')
      const store = tx.objectStore(STORE_ITEMS)
      const idx = store.index('byCollectionUid')
      const cursorReq = idx.openCursor(collectionUid)
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result
        if (cursor) {
          cursor.delete()
          cursor.continue()
        } else {
          for (const item of storedItems) store.put(item)
        }
      }
      cursorReq.onerror = () => reject(cursorReq.error)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (err) {
    logger.warn('[data-cache] replaceItemsForCollection failed', err)
  }
}

// ── Collections / stokens ──

export async function getCollection(collectionUid: string): Promise<CachedCollection | null> {
  try {
    const value = await withStore(STORE_COLLECTIONS, 'readonly', (store) => store.get(collectionUid))
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

export async function getStoken(collectionUid: string): Promise<string | null> {
  const col = await getCollection(collectionUid)
  return col?.stoken ?? null
}

export async function setStoken(
  type: CollectionTypeKey,
  collectionUid: string,
  stoken: string | null,
): Promise<void> {
  const existing = await getCollection(collectionUid)
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
export async function clearStoken(collectionUid: string): Promise<void> {
  const existing = await getCollection(collectionUid)
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
 * Wipe everything — items, collections, meta, and the crypto envelope. Called
 * on logout, password change, account fingerprint mismatch, or schema bump.
 */
export async function clearAll(): Promise<void> {
  envelopeKey = null
  envelopeReady = false
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_ITEMS, STORE_COLLECTIONS, STORE_META, STORE_CRYPTO], 'readwrite')
      tx.objectStore(STORE_ITEMS).clear()
      tx.objectStore(STORE_COLLECTIONS).clear()
      tx.objectStore(STORE_META).clear()
      tx.objectStore(STORE_CRYPTO).clear()
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

export interface CacheCapabilityStatus {
  featureFlagEnabled: boolean
  encryptedEnvelopeAvailable: boolean
  enabled: boolean
}

/**
 * Privacy-safe cache capability status for timing diagnostics. Synchronous and
 * side-effect-free: no IndexedDB open, schema migration, cache reads, or writes.
 */
export function getCacheCapabilityStatus(): CacheCapabilityStatus {
  const featureFlagEnabled = process.env.NEXT_PUBLIC_LOCAL_CACHE_ENABLED === 'true'
  const encryptedEnvelopeAvailable = hasEncryptedCacheEnvelope()
  return {
    featureFlagEnabled,
    encryptedEnvelopeAvailable,
    enabled: featureFlagEnabled && encryptedEnvelopeAvailable,
  }
}

/**
 * Returns true only when the local cache feature is enabled and encrypted
 * cache storage is available. Off by default, and fail-closed if the flag is
 * enabled before encryption exists.
 */
export function isCacheEnabled(): boolean {
  return getCacheCapabilityStatus().enabled
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
  encryptedCacheAvailableForTests = null
  envelopeKey = null
  envelopeReady = false
}

/** Test-only hook that simulates encrypted cache availability. */
export function _setEncryptedCacheAvailableForTests(value: boolean | null): void {
  encryptedCacheAvailableForTests = value
}

/** Test-only hook that injects a real WebCrypto key without relying on IDB CryptoKey cloning. */
export function _setEnvelopeKeyForTests(key: CryptoKey | null): void {
  envelopeKey = key
  envelopeReady = key !== null
}
