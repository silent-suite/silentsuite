/**
 * Local data cache for instant reload — IndexedDB-backed values.
 *
 * Stores already-decrypted item content (iCal/vCard/vTodo strings) plus
 * per-collection sync cursors (stokens) so that on the next page load the
 * UI can paint from the cache before the network sync completes.
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

export type CollectionTypeKey = 'calendar' | 'tasks' | 'contacts' | 'preferences' | 'labelIndex'

export interface CachedItem {
  itemUid: string
  collectionType: CollectionTypeKey
  collectionUid: string
  /** Already-decrypted iCal / vCard / vTodo string */
  content: string
  /** Last time we wrote this record to the cache (ms epoch) */
  lastModified: number
}

type StoredCachedItem = Omit<CachedItem, 'content'> & {
  /** AES-GCM encrypted JSON envelope for CachedItem.content. */
  content: string
}

interface EncryptedContentEnvelope {
  v: 1
  alg: 'AES-GCM'
  iv: string
  data: string
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

/** Bumped when item content moved from plaintext records to AES-GCM envelopes. */
export const CACHE_SCHEMA_VERSION = 3

const DB_NAME = 'silentsuite-data-cache'
const DB_VERSION = 3
const STORE_ITEMS = 'items'
const STORE_COLLECTIONS = 'collections'
const STORE_META = 'meta'
const STORE_CRYPTO = 'crypto'

const META_KEY = 'singleton'
const CONTENT_KEY_ID = 'content-key'

let dbPromise: Promise<IDBDatabase> | null = null
let encryptedCacheAvailableForTests: boolean | null = null
let contentKeyPromise: Promise<CryptoKey | null> | null = null

function isWebCryptoAvailable(): boolean {
  if (encryptedCacheAvailableForTests !== null) return encryptedCacheAvailableForTests
  return typeof indexedDB !== 'undefined' &&
    typeof crypto !== 'undefined' &&
    typeof crypto.getRandomValues === 'function' &&
    !!crypto.subtle &&
    typeof crypto.subtle.generateKey === 'function'
}

function hasEncryptedCacheEnvelope(): boolean {
  return isWebCryptoAvailable()
}

function isLocalCacheFeatureEnabled(): boolean {
  // The encrypted cache is now safe-by-default once WebCrypto is available.
  // Keep an explicit opt-out for preview/debugging or emergency rollback.
  return process.env.NEXT_PUBLIC_LOCAL_CACHE_ENABLED !== 'false'
}

function createItemsStore(db: IDBDatabase): void {
  const items = db.createObjectStore(STORE_ITEMS, { keyPath: 'itemUid' })
  items.createIndex('byCollectionType', 'collectionType', { unique: false })
  items.createIndex('byCollectionUid', 'collectionUid', { unique: false })
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
      // v3 moves cached item content to encrypted envelopes. Drop any legacy
      // plaintext records instead of attempting in-place migration.
      if (db.objectStoreNames.contains(STORE_ITEMS) && event.oldVersion < 3) {
        db.deleteObjectStore(STORE_ITEMS)
      }
      if (!db.objectStoreNames.contains(STORE_ITEMS)) createItemsStore(db)
      if (db.objectStoreNames.contains(STORE_COLLECTIONS) && event.oldVersion < 2) {
        db.deleteObjectStore(STORE_COLLECTIONS)
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

async function getOrCreateContentKey(): Promise<CryptoKey | null> {
  if (!isCacheEnabled()) return null
  if (contentKeyPromise) return contentKeyPromise
  contentKeyPromise = (async () => {
    try {
      const existing = await withStore<CryptoKey | undefined>(STORE_CRYPTO, 'readonly', (store) => store.get(CONTENT_KEY_ID))
      if (existing) return existing
      const key = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      )
      await withStore(STORE_CRYPTO, 'readwrite', (store) => store.put(key, CONTENT_KEY_ID))
      return key
    } catch (err) {
      logger.warn('[data-cache] encrypted content key unavailable', err)
      contentKeyPromise = null
      return null
    }
  })()
  return contentKeyPromise
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function encryptContent(content: string): Promise<string | null> {
  const key = await getOrCreateContentKey()
  if (!key) return null
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(content)
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)
  const envelope: EncryptedContentEnvelope = {
    v: 1,
    alg: 'AES-GCM',
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(encrypted)),
  }
  return JSON.stringify(envelope)
}

async function decryptContent(envelopeJson: string): Promise<string | null> {
  const key = await getOrCreateContentKey()
  if (!key) return null
  try {
    const envelope = JSON.parse(envelopeJson) as EncryptedContentEnvelope
    if (envelope.v !== 1 || envelope.alg !== 'AES-GCM') return null
    const iv = base64ToBytes(envelope.iv) as Uint8Array<ArrayBuffer>
    const data = base64ToBytes(envelope.data) as Uint8Array<ArrayBuffer>
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data)
    return new TextDecoder().decode(decrypted)
  } catch (err) {
    logger.warn('[data-cache] decrypt cached item failed', err)
    return null
  }
}

async function encryptItem(item: CachedItem): Promise<StoredCachedItem | null> {
  const content = await encryptContent(item.content)
  if (!content) return null
  return { ...item, content }
}

async function decryptItem(item: StoredCachedItem): Promise<CachedItem | null> {
  const content = await decryptContent(item.content)
  if (content === null) return null
  return { ...item, content }
}

async function encryptItems(items: CachedItem[]): Promise<StoredCachedItem[]> {
  const encrypted: StoredCachedItem[] = []
  for (const item of items) {
    const stored = await encryptItem(item)
    if (stored) encrypted.push(stored)
  }
  return encrypted
}

async function canWriteItemContent(operation: string): Promise<boolean> {
  if (await getOrCreateContentKey()) return true
  logger.warn(`[data-cache] ${operation} skipped; encrypted cache envelope is unavailable`)
  return false
}

// ── Items ──

/**
 * Read all cached items for a collection type.
 * Returns an empty array if the cache is empty or unavailable.
 */
export async function getItemsByType(type: CollectionTypeKey): Promise<CachedItem[]> {
  if (!isCacheEnabled()) return []
  try {
    const db = await openDB()
    const stored = await new Promise<StoredCachedItem[]>((resolve, reject) => {
      const tx = db.transaction(STORE_ITEMS, 'readonly')
      const idx = tx.objectStore(STORE_ITEMS).index('byCollectionType')
      const req = idx.getAll(type)
      req.onsuccess = () => resolve((req.result as StoredCachedItem[]) ?? [])
      req.onerror = () => reject(req.error)
    })
    const items: CachedItem[] = []
    for (const record of stored) {
      const item = await decryptItem(record)
      if (item) items.push(item)
    }
    return items
  } catch (err) {
    logger.warn('[data-cache] getItemsByType failed', err)
    return []
  }
}

/** Insert/update a single item. Failures are logged and swallowed. */
export async function putItem(item: CachedItem): Promise<void> {
  if (!(await canWriteItemContent('putItem'))) return
  try {
    const stored = await encryptItem(item)
    if (!stored) return
    await withStore(STORE_ITEMS, 'readwrite', (store) => store.put(stored))
  } catch (err) {
    logger.warn('[data-cache] putItem failed', err)
  }
}

/** Bulk insert/update — single transaction for efficiency. */
export async function putItems(items: CachedItem[]): Promise<void> {
  if (items.length === 0) return
  if (!(await canWriteItemContent('putItems'))) return
  try {
    const storedItems = await encryptItems(items)
    if (storedItems.length === 0) return
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
  if (!(await canWriteItemContent('replaceItemsForType'))) return
  try {
    const storedItems = await encryptItems(items)
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
  if (!(await canWriteItemContent('replaceItemsForCollection'))) return
  try {
    const storedItems = await encryptItems(items)
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
 * Wipe everything — items, collections, meta, and the encrypted content key.
 * Called on logout, password change, account fingerprint mismatch, or schema bump.
 */
export async function clearAll(): Promise<void> {
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
    contentKeyPromise = null
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
 * Privacy-safe cache capability status for sync timing diagnostics. Contains
 * only booleans; no account identifiers, item contents, or collection IDs.
 */
export function getCacheCapabilityStatus(): CacheCapabilityStatus {
  const featureFlagEnabled = isLocalCacheFeatureEnabled()
  const encryptedEnvelopeAvailable = hasEncryptedCacheEnvelope()
  return {
    featureFlagEnabled,
    encryptedEnvelopeAvailable,
    enabled: featureFlagEnabled && encryptedEnvelopeAvailable,
  }
}

/**
 * Returns true only when the local cache feature is enabled and encrypted
 * cache storage is available. Fail-closed if WebCrypto is unavailable.
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
  contentKeyPromise = null
  encryptedCacheAvailableForTests = null
}

/** Test-only hook that simulates encrypted cache availability. */
export function _setEncryptedCacheAvailableForTests(value: boolean | null): void {
  encryptedCacheAvailableForTests = value
  contentKeyPromise = null
}
