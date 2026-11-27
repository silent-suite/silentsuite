/**
 * Encrypted local storage for offline edits — IndexedDB-backed values.
 *
 * Holds the browser-local AES-GCM envelope key, the account fingerprint meta
 * record, the sealed offline-queue payload helpers, and the encrypted replay
 * payloads of content-free queued updates (the `items` store). Item content is
 * decrypted at the public call boundary but encrypted before it reaches
 * IndexedDB; PIM content is never stored as raw iCal/vCard/vTodo text.
 *
 * SCOPE: This module follows the same raw-IDB pattern as `secure-storage.ts`
 * and `offline-queue.ts` — no `idb` / Dexie dependency.
 *
 * AT-REST ENCRYPTION: item content writes are skipped until the encrypted
 * envelope is ready.
 *
 * The `collections` store held sync cursors for a removed instant-reload
 * cache. It stays in the v5 schema, unread, so builds that still expect it can
 * open this database; logout and account changes empty it with the rest.
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

async function commitItemPut(item: StoredItem, accountEpoch: number | undefined): Promise<void> {
  try {
    if (accountEpoch === undefined) {
      const db = await openDB()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_ITEMS, 'readwrite')
        tx.objectStore(STORE_ITEMS).put(item)
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
        itemStore.put(item)
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
    logger.warn('[data-cache] putItem failed', err)
  }
}

/**
 * Insert/update a single item. Skipped while the encrypted envelope is not
 * ready; other failures are logged and swallowed.
 */
export async function putItem(item: CachedItem, accountEpoch?: number): Promise<void> {
  if (!hasEncryptedCacheEnvelope()) return
  try {
    const stored = await toStoredItem(item)
    if (accountEpoch !== undefined) assertCurrentAccountEpoch(accountEpoch)
    await commitItemPut(stored, accountEpoch)
  } catch (err) {
    if (err instanceof AccountBoundaryChangedError) throw err
    logger.warn('[data-cache] putItem failed', err)
  }
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
