/**
 * Secure storage module — keeps sensitive data out of localStorage.
 *
 * The Etebase session blob comes from the SDK's `account.save()` without a key,
 * so it is sealed with the SDK's built-in all-zero key: anyone with a copy of
 * the blob can open it. It holds the account's main key and sync token. Where
 * it is stored therefore decides who can take over the account:
 *
 * - "Keep me signed in" off (hosted): only this tab's sessionStorage, never
 *   IndexedDB (see session-scope.ts).
 * - Remembered hosted devices and self-hosted servers: IndexedDB, until logout.
 *   That copy is wrapped with AES-GCM under a non-extractable WebCrypto key
 *   stored next to it (a fresh key and IV per write). A copied value on its own
 *   is useless; the key's bytes cannot be exported. It does not protect against
 *   script running in this origin (it can ask the browser to decrypt) or a copy
 *   of the whole browser profile (the key travels with it). Without WebCrypto
 *   (an insecure http origin) or when IndexedDB fails, the session is not
 *   remembered: it works in the tab until the page reloads or the next session
 *   check resets this tab's copy.
 *
 * IndexedDB and sessionStorage are both readable by any script in this origin.
 */
import { getSafeErrorDetails } from '@/app/lib/privacy-safe-errors'
import { readLogoutGeneration } from '@/app/lib/account-epoch'
import { getDeviceOwner, getSessionScope, readTabSession, removeTabSession, setSessionScope, tabSessionChangeCount, writeTabSession } from '@/app/lib/session-scope'

const DB_NAME = 'silentsuite-secure'
const DB_VERSION = 1
const STORE_NAME = 'keyval'
const SESSION_KEY = 'etebase_session'
/** The Billing user a durable hosted session was saved for (absent for self-hosted). */
export const SESSION_OWNER_KEY = 'etebase_session_owner'
/** The non-extractable AES-GCM key the durable session copy is wrapped with. */
const SESSION_WRAP_KEY = 'etebase_session_key'

/** The durable session as stored: AES-GCM ciphertext of the `account.save()` string. */
interface WrappedSession {
  v: 1
  iv: Uint8Array<ArrayBuffer>
  ct: ArrayBuffer
}

/** One consistent read of the durable session, its key and its owner. */
interface StoredSessionSnapshot {
  record: unknown
  key: unknown
  owner: unknown
}

/** Sensitive localStorage keys that were migrated — cleared on first load. */
const LEGACY_KEYS = [
  'etebase_session',
  'silentsuite-calendar',
  'silentsuite-tasks',
  'silentsuite-contacts',
]

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
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
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
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode)
        const store = tx.objectStore(STORE_NAME)
        const req = fn(store)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

/**
 * A readwrite change that settles only when its transaction has committed. If
 * the callback throws (e.g. a value that cannot be cloned), the transaction is
 * aborted, so none of the changes it queued commit.
 */
function withCommittedStore(fn: (store: IDBObjectStore) => void): Promise<void> {
  return openDB().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'))
        try {
          fn(tx.objectStore(STORE_NAME))
        } catch (err) {
          try { tx.abort() } catch { /* already finished */ }
          reject(err)
        }
      }),
  )
}

export interface StoredOnlyOptions {
  /** Etebase session only: act on the IndexedDB copy and ignore this tab's copy. */
  storedOnly?: boolean
}

/** The built-in type of a value; unlike instanceof, it survives structured clones across realms. */
function typeTag(value: unknown): string {
  return Object.prototype.toString.call(value)
}

function isWrappedSession(value: unknown): value is WrappedSession {
  const record = value as Partial<WrappedSession> | null
  return typeof record === 'object' && record !== null && record.v === 1
    && typeTag(record.iv) === '[object Uint8Array]' && record.iv!.byteLength === 12
    && typeTag(record.ct) === '[object ArrayBuffer]'
}

/**
 * Whether a stored value is still the write `seen`: a wrapped write by its IV
 * (12 random bytes, fresh per write), a plain copy from an older version by
 * equality. Anything else never matches, so it is only ever overwritten or
 * removed as a whole.
 */
function isSameWrite(stored: unknown, seen: WrappedSession | string): boolean {
  if (typeof seen === 'string') return stored === seen
  return isWrappedSession(stored) && stored.iv.every((byte, i) => byte === seen.iv[i])
}

/**
 * Changes to the durable session (writes, rewrites, removals, clear) run one
 * at a time in call order: wrapping is asynchronous, so without this a logout
 * could commit before a save issued earlier. Reads wait for the changes issued
 * before them.
 */
let durableQueue: Promise<unknown> = Promise.resolve()

function serialized<T>(change: () => Promise<T>): Promise<T> {
  const run = durableQueue.then(change, change)
  durableQueue = run.catch(() => undefined)
  return run
}

async function readStoredSessionSnapshot(): Promise<StoredSessionSnapshot> {
  await durableQueue
  return readStoredSnapshotNow()
}

async function readStoredSnapshotNow(): Promise<StoredSessionSnapshot> {
  const db = await openDB()
  return new Promise<StoredSessionSnapshot>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const record = store.get(SESSION_KEY)
    const key = store.get(SESSION_WRAP_KEY)
    const owner = store.get(SESSION_OWNER_KEY)
    tx.oncomplete = () => resolve({ record: record.result, key: key.result, owner: owner.result })
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

/**
 * The session a stored value holds: the plaintext of a wrapped record, or a
 * plain copy written by an older version. Null when it cannot be unwrapped
 * (missing or replaced key, damaged ciphertext, anything malformed).
 */
async function storedPlaintext(record: unknown, key: unknown): Promise<string | null> {
  if (typeof record === 'string') return record
  if (!isWrappedSession(record) || typeTag(key) !== '[object CryptoKey]') return null
  try {
    const plain = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv }, key as CryptoKey, record.ct)
    return new TextDecoder().decode(plain)
  } catch {
    return null
  }
}

/** Delete the durable session, its owner and its key (inside a readwrite transaction). */
function deleteStoredSession(store: IDBObjectStore): void {
  store.delete(SESSION_KEY)
  store.delete(SESSION_OWNER_KEY)
  store.delete(SESSION_WRAP_KEY)
}

/**
 * Delete the durable session (with owner and key) only while it is still the
 * write `seen` and, when `generation` is given, no logout happened anywhere
 * since it was read (checked inside the transaction).
 */
async function removeStoredSessionIfSame(seen: WrappedSession | string, generation?: { value: string | null | undefined }): Promise<void> {
  try {
    await withCommittedStore((store) => {
      if (generation && readLogoutGeneration() !== generation.value) return
      const req = store.get(SESSION_KEY)
      req.onsuccess = () => {
        if (isSameWrite(req.result, seen)) deleteStoredSession(store)
      }
    })
  } catch {
    // Ignore errors on removal
  }
}

/** Wrap `value` under a fresh non-extractable key and IV. Throws without WebCrypto. */
async function wrapSession(value: string): Promise<{ record: WrappedSession; key: CryptoKey }> {
  const webCrypto = globalThis.crypto
  if (!webCrypto?.subtle || !webCrypto.getRandomValues) throw new Error('WebCrypto is not available')
  const key = await webCrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const iv = webCrypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)))
  const ct = await webCrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value))
  return { record: { v: 1, iv, ct }, key }
}

/**
 * Wrap a plain copy left by an older version, replacing it only while it is
 * still that copy (its owner is kept). On failure the plain copy stays as it
 * was and the next read tries again.
 */
function rewrapLegacySession(legacy: string): Promise<void> {
  return serialized(async () => {
    try {
      const { record, key } = await wrapSession(legacy)
      await withCommittedStore((store) => {
        const req = store.get(SESSION_KEY)
        req.onsuccess = () => {
          if (req.result !== legacy) return
          store.put(record, SESSION_KEY)
          store.put(key, SESSION_WRAP_KEY)
        }
      })
    } catch (err) {
      console.error('[secure-storage] Failed to wrap the stored session', getSafeErrorDetails(err))
    }
  })
}

/**
 * The durable session, read in one transaction with its key and owner, and
 * returned only when it belongs to `owner` (null: self-hosted or a stored-only
 * read, no owner to check) and unwraps. A copy saved for anyone else is never
 * handed out, whether or not cleanup managed to delete it. A copy that cannot
 * be unwrapped counts as no session and is left in place (it is inert; the
 * next save overwrites it, logout removes it). A plain copy from an older
 * version is still accepted, and wrapped on the first read with a device scope.
 */
async function readOwnedStoredSession(owner: string | null, rewrapLegacy: boolean): Promise<string | null> {
  try {
    const snapshot = await readStoredSessionSnapshot()
    if (snapshot.record === undefined) return null
    if (owner !== null && snapshot.owner !== owner) return null
    const value = await storedPlaintext(snapshot.record, snapshot.key)
    if (rewrapLegacy && typeof snapshot.record === 'string') await rewrapLegacySession(snapshot.record)
    return value
  } catch {
    return null
  }
}

/**
 * Get a value from secure storage. The Etebase session is read only from the
 * place this tab's session scope allows (see session-scope.ts): IndexedDB for
 * 'device'; otherwise this tab's valid copy, never IndexedDB. A stored-only
 * read returns the IndexedDB copy without an owner check. Returns null if the
 * key doesn't exist or storage is unavailable.
 */
export async function secureGet(key: string, options: StoredOnlyOptions = {}): Promise<string | null> {
  if (key === SESSION_KEY) {
    if (options.storedOnly) return readOwnedStoredSession(null, false)
    if (getSessionScope() !== 'device') return readTabSession()
    return readOwnedStoredSession(getDeviceOwner(), true)
  }
  try {
    const value = await withStore('readonly', (store) => store.get(key))
    return (value as string) ?? null
  } catch {
    return null
  }
}

export interface SecureSetOptions {
  /**
   * Etebase session only. `true` stores it in IndexedDB; use it only when
   * keeping the session is authorized (self-hosted, or a hosted device Billing
   * confirmed as remembered). Anything else, including omitting it, keeps the
   * session in this tab only. A tab-only write never touches IndexedDB; the
   * auth store removes an old durable copy once Billing confirms the device is
   * not remembered.
   */
  persist?: boolean
  /**
   * The Billing user the session was confirmed for, when known. Stored with a
   * tab copy, and with a durable copy (in the same transaction) so a restore
   * can refuse a copy saved for someone else.
   */
  owner?: string | null
}

/**
 * Store the session wrapped, with its key and owner, in one committed
 * transaction. Nothing is written once a logout happened anywhere since
 * `generation` was read: that check runs inside the transaction, so a newer
 * sign-in saved by another tab after its logout is never overwritten. Returns
 * the stored record, or null if nothing was stored. When the save fails, the
 * copy it was meant to replace is deleted as well (best effort, and only while
 * it is still that copy). Never stores plaintext.
 */
function writeWrappedSession(value: string, owner: string | null, generation: string | null | undefined): Promise<WrappedSession | null> {
  return serialized(async () => {
    let replaced: unknown
    try {
      replaced = (await readStoredSnapshotNow()).record
    } catch {
      // Unreadable IndexedDB: the write below fails too, and reads return nothing.
    }
    try {
      const { record, key } = await wrapSession(value)
      let written = false
      await withCommittedStore((store) => {
        if (readLogoutGeneration() !== generation) return
        store.put(record, SESSION_KEY)
        store.put(key, SESSION_WRAP_KEY)
        if (owner) store.put(owner, SESSION_OWNER_KEY)
        else store.delete(SESSION_OWNER_KEY)
        written = true
      })
      return written ? record : null
    } catch (err) {
      console.error('[secure-storage] Failed to write to IndexedDB', getSafeErrorDetails(err))
      // Only the copy this save meant to replace, and only while no logout
      // happened since the save was submitted: a save another tab made
      // meanwhile, or after its logout, is kept.
      if (typeof replaced === 'string' || isWrappedSession(replaced)) await removeStoredSessionIfSame(replaced, { value: generation })
      return null
    }
  })
}

function writeTabOnlySession(value: string, owner: string | null): void {
  // Decide the scope first: reads now never reach IndexedDB, and a failed tab
  // write leaves no readable session (unlock then asks again).
  setSessionScope('tab')
  try {
    writeTabSession(value, owner)
  } catch (err) {
    console.error('[secure-storage] Failed to write the tab session', getSafeErrorDetails(err))
  }
}

/**
 * Changes a durable save makes to this tab's copy when it completes. They are
 * not "later operations" for the saves queued after it.
 */
let ownTabSessionChanges = 0

/** Changes to this tab's copy made by anything other than a durable save completing. */
function laterTabSessionChanges(): number {
  return tabSessionChangeCount() - ownTabSessionChanges
}

function asOwnTabSessionChange(change: () => void): void {
  const before = tabSessionChangeCount()
  try {
    change()
  } finally {
    ownTabSessionChanges += tabSessionChangeCount() - before
  }
}

async function setSession(value: string, persist: boolean, owner: string | null): Promise<void> {
  if (!persist) return writeTabOnlySession(value, owner)
  // Write before removing the tab copy, so a concurrent read always finds one.
  const changesBefore = laterTabSessionChanges()
  const generationBefore = readLogoutGeneration()
  const record = await writeWrappedSession(value, owner, generationBefore)
  // A later operation on this tab's session (a tab-only sign-in, a clear or
  // removal), or a logout anywhere, while this one was being saved: that one
  // wins, and this save is taken back.
  if (laterTabSessionChanges() !== changesBefore || readLogoutGeneration() !== generationBefore) {
    if (record) await serialized(() => removeStoredSessionIfSame(record))
    return
  }
  if (!record) {
    // Not remembered (no WebCrypto, or IndexedDB failed): the session still
    // works in this tab until the page reloads. The copy this save was meant
    // to replace was deleted if that was possible.
    asOwnTabSessionChange(() => writeTabOnlySession(value, owner))
    return
  }
  setSessionScope('device', owner)
  asOwnTabSessionChange(removeTabSession)
}

/**
 * Set a value in secure storage (IndexedDB; for the Etebase session see
 * SecureSetOptions).
 */
export async function secureSet(key: string, value: string, options: SecureSetOptions = {}): Promise<void> {
  if (key === SESSION_KEY) return setSession(value, options.persist === true, options.owner ?? null)
  try {
    await withStore('readwrite', (store) => store.put(value, key))
  } catch (err) {
    console.error('[secure-storage] Failed to write to IndexedDB', getSafeErrorDetails(err))
  }
}

/**
 * Remove a value from secure storage (IndexedDB, and this tab for the session).
 */
export async function secureRemove(key: string): Promise<void> {
  if (key === SESSION_KEY) {
    removeTabSession()
    setSessionScope(null)
  }
  const remove = () => withCommittedStore((store) => {
    if (key === SESSION_KEY) deleteStoredSession(store)
    else store.delete(key)
  })
  try {
    await (key === SESSION_KEY ? serialized(remove) : remove())
  } catch {
    // Ignore errors on removal
  }
}

/**
 * Remove a value only while it still equals `expected`. The read and the delete share one
 * readwrite transaction, so a value written by a later operation is never removed, and it
 * settles after commit. For the session, this tab's copy is compared and removed the same way
 * unless `storedOnly` is set; the durable copy is unwrapped and compared, then deleted (with
 * its owner and key) only while it is still the same write.
 */
export async function secureRemoveIfEqual(key: string, expected: string, options: StoredOnlyOptions = {}): Promise<void> {
  if (key === SESSION_KEY) {
    if (!options.storedOnly && readTabSession() === expected) removeTabSession()
    await serialized(async () => {
      try {
        const snapshot = await readStoredSnapshotNow()
        const seen = snapshot.record
        if (typeof seen !== 'string' && !isWrappedSession(seen)) return
        if (await storedPlaintext(seen, snapshot.key) === expected) await removeStoredSessionIfSame(seen)
      } catch {
        // Ignore errors on removal
      }
    })
    return
  }
  try {
    await withCommittedStore((store) => {
      const req = store.get(key)
      req.onsuccess = () => {
        if (req.result === expected) store.delete(key)
      }
    })
  } catch {
    // Ignore errors on removal
  }
}

/**
 * Clear all data from secure storage (the session's wrapping key included),
 * including this tab's session copy. Runs after durable session changes issued
 * before it, so an earlier save cannot land after the clear.
 */
export async function secureClear(): Promise<void> {
  removeTabSession()
  setSessionScope(null)
  try {
    await serialized(() => withStore('readwrite', (store) => store.clear()))
  } catch {
    // Ignore errors on clear
  }
}

/**
 * One-time cleanup of very old installs that kept data in localStorage. A
 * session found there is discarded rather than moved: whether it may be kept
 * on this device is unknown, so the user signs in again.
 *
 * Call this early in the app lifecycle (e.g., in the root layout or auth restore).
 */
export async function migrateFromLocalStorage(): Promise<void> {
  if (typeof window === 'undefined') return

  // Check if migration already ran
  const migrated = localStorage.getItem('silentsuite-storage-migrated')
  if (migrated === '1') return

  // Clear all sensitive keys from localStorage
  for (const key of LEGACY_KEYS) {
    localStorage.removeItem(key)
  }

  // Mark migration as complete
  localStorage.setItem('silentsuite-storage-migrated', '1')
}
