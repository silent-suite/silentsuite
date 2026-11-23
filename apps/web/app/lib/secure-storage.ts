/**
 * Secure storage module — keeps sensitive data out of localStorage.
 *
 * The Etebase session blob is NOT protected by encryption here: the SDK's
 * `account.save()` is called without a key, so it uses its built-in all-zero
 * key and anyone with a copy of the blob can open it. The blob holds the
 * account's main key and sync token. Where it is stored therefore decides who
 * can take over the account:
 *
 * - "Keep me signed in" off (hosted): only this tab's sessionStorage, never
 *   IndexedDB (see session-scope.ts).
 * - Remembered hosted devices and self-hosted servers: IndexedDB, until logout.
 *
 * IndexedDB and sessionStorage are both readable by any script in this origin.
 */
import { getSafeErrorDetails } from '@/app/lib/privacy-safe-errors'
import { getSessionScope, readTabSession, removePersistentNames, removeTabSession, setSessionScope, writeTabSession } from '@/app/lib/session-scope'

const DB_NAME = 'silentsuite-secure'
const DB_VERSION = 1
const STORE_NAME = 'keyval'
const SESSION_KEY = 'etebase_session'

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

/** A readwrite change that settles only when its transaction has committed. */
function withCommittedStore(fn: (store: IDBObjectStore) => void): Promise<void> {
  return openDB().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        fn(tx.objectStore(STORE_NAME))
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      }),
  )
}

export interface StoredOnlyOptions {
  /** Etebase session only: act on the IndexedDB copy and ignore this tab's copy. */
  storedOnly?: boolean
}

/**
 * Get a value from secure storage. The Etebase session is read only from the
 * place this tab's session scope allows (see session-scope.ts): IndexedDB for
 * 'device'; otherwise this tab's valid copy, never IndexedDB. Returns null if
 * the key doesn't exist or storage is unavailable.
 */
export async function secureGet(key: string, options: StoredOnlyOptions = {}): Promise<string | null> {
  if (key === SESSION_KEY && !options.storedOnly && getSessionScope() !== 'device') return readTabSession()
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
   * session in this tab only and deletes any IndexedDB copy.
   */
  persist?: boolean
}

async function setSession(value: string, persist: boolean): Promise<void> {
  if (persist) {
    // Write before removing the tab copy, so a concurrent read always finds one.
    try {
      await withCommittedStore((store) => { store.put(value, SESSION_KEY) })
    } catch (err) {
      console.error('[secure-storage] Failed to write to IndexedDB', getSafeErrorDetails(err))
      return
    }
    setSessionScope('device')
    removeTabSession()
    return
  }
  // Decide the scope first: reads now never reach IndexedDB, even if the tab
  // write fails (then the session simply isn't kept and unlock asks again).
  setSessionScope('tab')
  try {
    writeTabSession(value)
  } catch (err) {
    console.error('[secure-storage] Failed to write the tab session', getSafeErrorDetails(err))
  }
  removePersistentNames()
  try {
    await withCommittedStore((store) => { store.delete(SESSION_KEY) })
  } catch (err) {
    // The next restore deletes it again.
    console.error('[secure-storage] Failed to delete the stored session', getSafeErrorDetails(err))
  }
}

/**
 * Set a value in secure storage (IndexedDB; for the Etebase session see
 * SecureSetOptions).
 */
export async function secureSet(key: string, value: string, options: SecureSetOptions = {}): Promise<void> {
  if (key === SESSION_KEY) return setSession(value, options.persist === true)
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
  try {
    await withStore('readwrite', (store) => store.delete(key))
  } catch {
    // Ignore errors on removal
  }
}

/**
 * Remove a value only while it still equals `expected`. The read and the delete share one
 * readwrite transaction, so a value written by a later operation is never removed, and it
 * settles after commit. For the session, this tab's copy is compared and removed the same way
 * unless `storedOnly` is set.
 */
export async function secureRemoveIfEqual(key: string, expected: string, options: StoredOnlyOptions = {}): Promise<void> {
  if (key === SESSION_KEY && !options.storedOnly && readTabSession() === expected) removeTabSession()
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
 * Clear all data from secure storage, including this tab's session copy.
 */
export async function secureClear(): Promise<void> {
  removeTabSession()
  setSessionScope(null)
  try {
    await withStore('readwrite', (store) => store.clear())
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
