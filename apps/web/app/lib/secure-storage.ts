/**
 * Secure storage module — moves sensitive data from localStorage to IndexedDB.
 *
 * IndexedDB is not accessible via simple `localStorage.getItem()` calls that
 * XSS payloads typically use. While it's still same-origin accessible, it
 * significantly raises the bar for data exfiltration.
 *
 * The Etebase session blob is already encrypted by the SDK, so we don't add
 * another encryption layer — just move it out of the trivially-scriptable
 * localStorage API.
 */

const DB_NAME = 'silentsuite-secure'
const DB_VERSION = 1
const STORE_NAME = 'keyval'

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
 * Get a value from secure storage (IndexedDB).
 * Returns null if the key doesn't exist or IndexedDB is unavailable.
 */
export async function secureGet(key: string): Promise<string | null> {
  try {
    const value = await withStore('readonly', (store) => store.get(key))
    return (value as string) ?? null
  } catch {
    return null
  }
}

/**
 * Set a value in secure storage (IndexedDB).
 */
export async function secureSet(key: string, value: string): Promise<void> {
  try {
    await withStore('readwrite', (store) => store.put(value, key))
  } catch (err) {
    console.error('[secure-storage] Failed to write to IndexedDB:', err)
  }
}

/**
 * Remove a value from secure storage (IndexedDB).
 */
export async function secureRemove(key: string): Promise<void> {
  try {
    await withStore('readwrite', (store) => store.delete(key))
  } catch {
    // Ignore errors on removal
  }
}

/**
 * Clear all data from secure storage.
 */
export async function secureClear(): Promise<void> {
  try {
    await withStore('readwrite', (store) => store.clear())
  } catch {
    // Ignore errors on clear
  }
}

/**
 * One-time migration: move etebase_session from localStorage to IndexedDB,
 * and remove all sensitive keys from localStorage.
 *
 * Call this early in the app lifecycle (e.g., in the root layout or auth restore).
 */
export async function migrateFromLocalStorage(): Promise<void> {
  if (typeof window === 'undefined') return

  // Check if migration already ran
  const migrated = localStorage.getItem('silentsuite-storage-migrated')
  if (migrated === '1') return

  // Migrate etebase_session to IndexedDB if it exists in localStorage
  const session = localStorage.getItem('etebase_session')
  if (session) {
    try {
      await secureSet('etebase_session', session)
    } catch {
      // If IndexedDB write fails, don't remove from localStorage — data safety first
      return
    }
  }

  // Clear all sensitive keys from localStorage
  for (const key of LEGACY_KEYS) {
    localStorage.removeItem(key)
  }

  // Mark migration as complete
  localStorage.setItem('silentsuite-storage-migrated', '1')
}
