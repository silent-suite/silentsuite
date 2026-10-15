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
import { AccountBoundaryChangedError, assertCurrentAccountEpoch } from '@/app/lib/account-epoch'

export type CollectionTypeKey = 'calendar' | 'tasks' | 'contacts' | 'notes' | 'preferences'

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
    throw err
  }
}

async function putStoredEnvelopeKey(key: CryptoKey, accountEpoch?: number): Promise<CryptoKey> {
  if (accountEpoch === undefined) {
    const db = await openDB()
    return new Promise<CryptoKey>((resolve, reject) => {
      const tx = db.transaction(STORE_CRYPTO, 'readwrite')
      const store = tx.objectStore(STORE_CRYPTO)
      const getReq = store.get(ENVELOPE_KEY)
      let adopted = key
      let settled = false
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        reject(error)
      }
      getReq.onsuccess = () => {
        const existing = getReq.result as CryptoKey | undefined
        if (existing) adopted = existing
        else store.put(key, ENVELOPE_KEY)
      }
      getReq.onerror = () => fail(getReq.error)
      tx.oncomplete = () => {
        if (settled) return
        settled = true
        resolve(adopted)
      }
      tx.onerror = () => fail(tx.error)
      tx.onabort = () => fail(tx.error ?? new DOMException('Transaction aborted', 'AbortError'))
    })
  }
  const expectedFingerprint = (await getMeta())?.accountFingerprint
  assertCurrentAccountEpoch(accountEpoch)
  if (!expectedFingerprint) throw new AccountBoundaryChangedError()
  const db = await openDB()
  assertCurrentAccountEpoch(accountEpoch)
  return new Promise<CryptoKey>((resolve, reject) => {
    const tx = db.transaction([STORE_CRYPTO, STORE_META], 'readwrite')
    const cryptoStore = tx.objectStore(STORE_CRYPTO)
    const metaStore = tx.objectStore(STORE_META)
    const metaReq = metaStore.get(META_KEY)
    let settled = false
    let adopted = key
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const abortForBoundary = () => {
      fail(new AccountBoundaryChangedError())
      try { tx.abort() } catch { /* transaction already finished */ }
    }
    metaReq.onsuccess = () => {
      if ((metaReq.result as CacheMeta | undefined)?.accountFingerprint !== expectedFingerprint) {
        abortForBoundary()
        return
      }
      const existingReq = cryptoStore.get(ENVELOPE_KEY)
      existingReq.onsuccess = () => {
        const existing = existingReq.result as CryptoKey | undefined
        if (existing) adopted = existing
        else cryptoStore.put(key, ENVELOPE_KEY)
        const commitGuard = metaStore.get(META_KEY)
        commitGuard.onsuccess = () => {
          try { assertCurrentAccountEpoch(accountEpoch) } catch { abortForBoundary() }
        }
        commitGuard.onerror = () => fail(commitGuard.error)
      }
      existingReq.onerror = () => fail(existingReq.error)
    }
    metaReq.onerror = () => fail(metaReq.error)
    tx.oncomplete = () => {
      if (settled) return
      settled = true
      resolve(adopted)
    }
    tx.onerror = () => fail(tx.error)
    tx.onabort = () => fail(tx.error ?? new DOMException('Transaction aborted', 'AbortError'))
  })
}

/**
 * Ensure the encrypted cache envelope is ready for this browser session.
 * Returns false instead of throwing so cache enablement always fails closed.
 */
export async function ensureEncryptedEnvelope(accountEpoch?: number): Promise<boolean> {
  if (accountEpoch !== undefined) assertCurrentAccountEpoch(accountEpoch)
  if (!hasWebCrypto()) {
    envelopeKey = null
    envelopeReady = false
    return false
  }

  if (envelopeKey && envelopeReady) return true

  try {
    const existing = await getStoredEnvelopeKey()
    if (accountEpoch !== undefined) assertCurrentAccountEpoch(accountEpoch)
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
    if (accountEpoch !== undefined) assertCurrentAccountEpoch(accountEpoch)
    const adopted = await putStoredEnvelopeKey(generated, accountEpoch)
    if (accountEpoch !== undefined) assertCurrentAccountEpoch(accountEpoch)
    envelopeKey = adopted
    envelopeReady = true
    return true
  } catch (err) {
    if (err instanceof AccountBoundaryChangedError) throw err
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

/**
 * Seal offline-queue custody (#744 K4) under the freshly re-read stored
 * envelope key, with the record identity as AES-GCM associated data. Returns
 * null when no stored key exists; a key-read error throws to the caller.
 */
export async function sealQueuePayload(
  plaintext: string,
  associatedData: string,
  accountEpoch?: number,
): Promise<{ iv: number[]; ct: number[] } | null> {
  if (!hasWebCrypto()) return null
  const key = await getStoredEnvelopeKey()
  if (accountEpoch !== undefined) assertCurrentAccountEpoch(accountEpoch)
  if (!key) return null
  const iv = new Uint8Array(12)
  globalThis.crypto.getRandomValues(iv)
  const encrypted = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(associatedData) },
    key,
    encoder.encode(plaintext),
  )
  if (accountEpoch !== undefined) assertCurrentAccountEpoch(accountEpoch)
  return { iv: Array.from(iv), ct: Array.from(new Uint8Array(encrypted)) }
}

export type OpenedQueuePayload =
  | { kind: 'opened'; plaintext: string; resealed: { iv: number[]; ct: number[] } | null }
  | { kind: 'not-ready' }
  | { kind: 'unreadable' }

async function tryOpen(key: CryptoKey, iv: number[], ct: number[], associatedData: string): Promise<string | null> {
  try {
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: Uint8Array.from(iv), additionalData: encoder.encode(associatedData) },
      key,
      Uint8Array.from(ct),
    )
    return decoder.decode(plain)
  } catch {
    return null
  }
}

/**
 * Open offline-queue custody (#744 K3) with a freshly re-read stored key and
 * the in-memory key. When only an old in-memory key opens it, the identical
 * plaintext is re-sealed under the stored key for the caller to CAS back.
 * No usable key is `not-ready` (keep pending); keys that all fail are
 * `unreadable` (hold the ciphertext, never drop it).
 */
export async function openQueuePayload(
  sealed: { iv: unknown; ct: unknown } | undefined,
  associatedData: string,
  accountEpoch?: number,
): Promise<OpenedQueuePayload> {
  if (!hasWebCrypto()) return { kind: 'not-ready' }
  if (!sealed || !Array.isArray(sealed.iv) || !Array.isArray(sealed.ct)) return { kind: 'unreadable' }
  const iv = sealed.iv as number[]
  const ct = sealed.ct as number[]
  const inMemory = envelopeKey
  let stored: CryptoKey | null
  try {
    stored = await getStoredEnvelopeKey()
  } catch {
    return { kind: 'not-ready' }
  }
  if (accountEpoch !== undefined) assertCurrentAccountEpoch(accountEpoch)
  if (!inMemory && !stored) return { kind: 'not-ready' }
  if (stored) {
    const plaintext = await tryOpen(stored, iv, ct, associatedData)
    if (plaintext !== null) return { kind: 'opened', plaintext, resealed: null }
  }
  if (inMemory) {
    const plaintext = await tryOpen(inMemory, iv, ct, associatedData)
    if (plaintext !== null) {
      if (accountEpoch !== undefined) assertCurrentAccountEpoch(accountEpoch)
      const resealed = stored ? await sealQueuePayload(plaintext, associatedData, accountEpoch) : null
      return { kind: 'opened', plaintext, resealed }
    }
  }
  return { kind: 'unreadable' }
}

/** Lowercase-hex SHA-256 of a JSON canonical form. Only ever stored inside sealed payloads. */
export async function sealedPayloadDigest(parts: readonly unknown[]): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(parts)))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
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

async function commitItemMutations(
  puts: StoredItem[],
  deletes: string[],
  accountEpoch: number | undefined,
  operation: 'putItem' | 'putItems' | 'deleteItem',
): Promise<void> {
  try {
    if (accountEpoch === undefined) {
      const db = await openDB()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_ITEMS, 'readwrite')
        const store = tx.objectStore(STORE_ITEMS)
        for (const itemUid of deletes) store.delete(itemUid)
        for (const item of puts) store.put(item)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      return
    }

    const expectedFingerprint = (await getMeta())?.accountFingerprint
    assertCurrentAccountEpoch(accountEpoch)
    if (!expectedFingerprint) throw new AccountBoundaryChangedError()
    const db = await openDB()
    assertCurrentAccountEpoch(accountEpoch)
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_ITEMS, STORE_META], 'readwrite')
      const itemStore = tx.objectStore(STORE_ITEMS)
      const metaReq = tx.objectStore(STORE_META).get(META_KEY)
      let settled = false
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        reject(error)
      }
      const abortForBoundary = () => {
        fail(new AccountBoundaryChangedError())
        try { tx.abort() } catch { /* transaction already finished */ }
      }
      metaReq.onsuccess = () => {
        const currentFingerprint = (metaReq.result as CacheMeta | undefined)?.accountFingerprint
        if (currentFingerprint !== expectedFingerprint) {
          abortForBoundary()
          return
        }
        for (const itemUid of deletes) itemStore.delete(itemUid)
        for (const item of puts) itemStore.put(item)
        const commitGuard = itemStore.get('__account-epoch-commit-guard__')
        commitGuard.onsuccess = () => {
          try {
            assertCurrentAccountEpoch(accountEpoch)
          } catch {
            abortForBoundary()
          }
        }
        commitGuard.onerror = () => fail(commitGuard.error)
      }
      metaReq.onerror = () => fail(metaReq.error)
      tx.oncomplete = () => {
        if (settled) return
        settled = true
        resolve()
      }
      tx.onerror = () => fail(tx.error)
      tx.onabort = () => fail(tx.error ?? new DOMException('Transaction aborted', 'AbortError'))
    })
  } catch (err) {
    if (err instanceof AccountBoundaryChangedError) throw err
    logger.warn(`[data-cache] ${operation} failed`, err)
  }
}

/** Insert/update a single item. Failures are logged and swallowed. */
export async function putItem(
  item: CachedItem,
  accountEpoch?: number,
  options?: { allowWithoutFeatureFlag?: boolean },
): Promise<void> {
  if (options?.allowWithoutFeatureFlag) {
    if (!hasEncryptedCacheEnvelope()) return
  } else if (!canWriteItemContent('putItem')) return
  try {
    const stored = await toStoredItem(item)
    if (accountEpoch !== undefined) assertCurrentAccountEpoch(accountEpoch)
    await commitItemMutations([stored], [], accountEpoch, 'putItem')
  } catch (err) {
    if (err instanceof AccountBoundaryChangedError) throw err
    logger.warn('[data-cache] putItem failed', err)
  }
}

/** Bulk insert/update — single transaction for efficiency. */
export async function putItems(items: CachedItem[], accountEpoch?: number): Promise<void> {
  if (items.length === 0) return
  if (!canWriteItemContent('putItems')) return
  try {
    const storedItems = await Promise.all(items.map(toStoredItem))
    if (accountEpoch !== undefined) assertCurrentAccountEpoch(accountEpoch)
    await commitItemMutations(storedItems, [], accountEpoch, 'putItems')
  } catch (err) {
    if (err instanceof AccountBoundaryChangedError) throw err
    logger.warn('[data-cache] putItems failed', err)
  }
}

export async function deleteItem(itemUid: string, accountEpoch?: number): Promise<void> {
  await commitItemMutations([], [itemUid], accountEpoch, 'deleteItem')
}

async function replaceItemsForIndex(
  indexName: 'byCollectionType' | 'byCollectionUid',
  indexKey: IDBValidKey,
  items: CachedItem[],
  accountEpoch: number | undefined,
  operation: 'replaceItemsForType' | 'replaceItemsForCollection',
): Promise<void> {
  if (!canWriteItemContent(operation)) return
  try {
    const expectedFingerprint = accountEpoch === undefined ? undefined : (await getMeta())?.accountFingerprint
    if (accountEpoch !== undefined) {
      assertCurrentAccountEpoch(accountEpoch)
      if (!expectedFingerprint) throw new AccountBoundaryChangedError()
    }
    const storedItems = await Promise.all(items.map(toStoredItem))
    if (accountEpoch !== undefined) assertCurrentAccountEpoch(accountEpoch)
    const db = await openDB()
    if (accountEpoch !== undefined) assertCurrentAccountEpoch(accountEpoch)
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_ITEMS, STORE_META], 'readwrite')
      const store = tx.objectStore(STORE_ITEMS)
      const metaReq = tx.objectStore(STORE_META).get(META_KEY)

      const abortForBoundary = () => {
        const err = new AccountBoundaryChangedError()
        reject(err)
        tx.abort()
      }

      metaReq.onsuccess = () => {
        const currentFingerprint = (metaReq.result as CacheMeta | undefined)?.accountFingerprint
        if (accountEpoch !== undefined && currentFingerprint !== expectedFingerprint) {
          abortForBoundary()
          return
        }

        const cursorReq = store.index(indexName).openCursor(indexKey)
        cursorReq.onsuccess = () => {
          try {
            if (accountEpoch !== undefined) assertCurrentAccountEpoch(accountEpoch)
          } catch {
            abortForBoundary()
            return
          }
          const cursor = cursorReq.result
          if (cursor) {
            cursor.delete()
            cursor.continue()
          } else {
            for (const item of storedItems) store.put(item)
            const commitGuard = store.get('__account-epoch-commit-guard__')
            commitGuard.onsuccess = () => {
              try {
                if (accountEpoch !== undefined) assertCurrentAccountEpoch(accountEpoch)
              } catch {
                abortForBoundary()
              }
            }
            commitGuard.onerror = () => reject(commitGuard.error)
          }
        }
        cursorReq.onerror = () => reject(cursorReq.error)
      }
      metaReq.onerror = () => reject(metaReq.error)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (err) {
    if (err instanceof AccountBoundaryChangedError) throw err
    logger.warn(`[data-cache] ${operation} failed`, err)
  }
}

/**
 * Replace all cached items for a collection type with the given list.
 * Used after a full refresh so removed-on-server items don't linger.
 */
export async function replaceItemsForType(
  type: CollectionTypeKey,
  items: CachedItem[],
  accountEpoch?: number,
): Promise<void> {
  return replaceItemsForIndex('byCollectionType', type, items, accountEpoch, 'replaceItemsForType')
}

/**
 * Replace all cached items for one concrete collection. Other collections of
 * the same type are intentionally left intact.
 */
export async function replaceItemsForCollection(
  collectionUid: string,
  items: CachedItem[],
  accountEpoch?: number,
): Promise<void> {
  return replaceItemsForIndex('byCollectionUid', collectionUid, items, accountEpoch, 'replaceItemsForCollection')
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
  accountEpoch?: number,
): Promise<void> {
  if (accountEpoch === undefined) {
    const existing = await getCollection(collectionUid)
    await putCollection({
      collectionType: type,
      collectionUid,
      stoken,
      lastFullSyncAt: existing?.lastFullSyncAt ?? Date.now(),
    })
    return
  }

  try {
    const expectedFingerprint = (await getMeta())?.accountFingerprint
    assertCurrentAccountEpoch(accountEpoch)
    if (!expectedFingerprint) throw new AccountBoundaryChangedError()
    const db = await openDB()
    assertCurrentAccountEpoch(accountEpoch)
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_COLLECTIONS, STORE_META], 'readwrite')
      const collectionStore = tx.objectStore(STORE_COLLECTIONS)
      const metaStore = tx.objectStore(STORE_META)
      const metaReq = metaStore.get(META_KEY)

      let settled = false
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        reject(error)
      }
      const abortForBoundary = () => {
        fail(new AccountBoundaryChangedError())
        try { tx.abort() } catch { /* transaction already finished */ }
      }

      metaReq.onsuccess = () => {
        const currentFingerprint = (metaReq.result as CacheMeta | undefined)?.accountFingerprint
        if (currentFingerprint !== expectedFingerprint) {
          abortForBoundary()
          return
        }
        const collectionReq = collectionStore.get(collectionUid)
        collectionReq.onsuccess = () => {
          const existing = collectionReq.result as CachedCollection | undefined
          collectionStore.put({
            collectionType: type,
            collectionUid,
            stoken,
            lastFullSyncAt: existing?.lastFullSyncAt ?? Date.now(),
          })
          const commitGuard = metaStore.get(META_KEY)
          commitGuard.onsuccess = () => {
            try {
              assertCurrentAccountEpoch(accountEpoch)
            } catch {
              abortForBoundary()
            }
          }
          commitGuard.onerror = () => reject(commitGuard.error)
        }
        collectionReq.onerror = () => reject(collectionReq.error)
      }
      metaReq.onerror = () => reject(metaReq.error)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch (err) {
    if (err instanceof AccountBoundaryChangedError) throw err
    logger.warn('[data-cache] setStoken failed', err)
  }
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
export async function ensureFingerprint(accountFingerprint: string, accountEpoch?: number): Promise<boolean> {
  if (accountEpoch !== undefined) assertCurrentAccountEpoch(accountEpoch)
  const db = await openDB()
  if (accountEpoch !== undefined) assertCurrentAccountEpoch(accountEpoch)

  const result = await new Promise<{ survived: boolean; invalidated: boolean; eraseEnvelope: boolean }>((resolve, reject) => {
    const tx = db.transaction([STORE_ITEMS, STORE_COLLECTIONS, STORE_META, STORE_CRYPTO], 'readwrite')
    const metaStore = tx.objectStore(STORE_META)
    const metaReq = metaStore.get(META_KEY)
    let settled = false
    let survived = true
    let invalidated = false
    let eraseEnvelope = false
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const abortForBoundary = () => {
      fail(new AccountBoundaryChangedError())
      try { tx.abort() } catch { /* transaction already finished */ }
    }

    metaReq.onsuccess = () => {
      try {
        if (accountEpoch !== undefined) assertCurrentAccountEpoch(accountEpoch)
      } catch {
        abortForBoundary()
        return
      }
      const meta = metaReq.result as CacheMeta | undefined
      const fingerprintMismatch = Boolean(meta?.accountFingerprint && meta.accountFingerprint !== accountFingerprint)
      const schemaMismatch = Boolean(meta && meta.cacheSchemaVersion !== CACHE_SCHEMA_VERSION)
      invalidated = fingerprintMismatch || schemaMismatch
      eraseEnvelope = fingerprintMismatch
      survived = !invalidated
      const current: CacheMeta = {
        accountFingerprint,
        cacheSchemaVersion: CACHE_SCHEMA_VERSION,
        lastInvalidatedAt: invalidated ? Date.now() : (meta?.lastInvalidatedAt ?? null),
      }

      if (invalidated) {
        tx.objectStore(STORE_ITEMS).clear()
        tx.objectStore(STORE_COLLECTIONS).clear()
        metaStore.clear()
        if (eraseEnvelope) tx.objectStore(STORE_CRYPTO).clear()
      }
      if (!meta || invalidated || meta.accountFingerprint === null) metaStore.put(current, META_KEY)

      const commitGuard = metaStore.get(META_KEY)
      commitGuard.onsuccess = () => {
        try {
          if (accountEpoch !== undefined) assertCurrentAccountEpoch(accountEpoch)
        } catch {
          abortForBoundary()
        }
      }
      commitGuard.onerror = () => fail(commitGuard.error)
    }
    metaReq.onerror = () => fail(metaReq.error)
    tx.oncomplete = () => {
      if (settled) return
      settled = true
      resolve({ survived, invalidated, eraseEnvelope })
    }
    tx.onerror = () => fail(tx.error)
    tx.onabort = () => fail(tx.error ?? new DOMException('Transaction aborted', 'AbortError'))
  })

  if (result.eraseEnvelope) {
    envelopeKey = null
    envelopeReady = false
  }
  if (result.invalidated) {
    logger.warn('[data-cache] fingerprint or schema mismatch, clearing cache')
  }
  return result.survived
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
