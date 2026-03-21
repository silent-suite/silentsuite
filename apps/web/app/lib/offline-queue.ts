/**
 * Offline mutation queue backed by IndexedDB.
 * Catches failed Etebase mutations when offline, persists them,
 * and replays them in FIFO order when connectivity returns.
 */

type CollectionTypeKey = 'calendar' | 'tasks' | 'contacts'
type MutationType = 'create' | 'update' | 'delete'

export interface QueueEntry {
  id: string
  type: MutationType
  collectionType: CollectionTypeKey
  content?: string
  itemUid?: string
  tempId?: string
  createdAt: number
  retryCount: number
  status: 'pending' | 'failed'
}

export interface ReplayResult {
  entry: QueueEntry
  success: boolean
  /** For create replays, the real UID returned by Etebase */
  itemUid?: string
  error?: string
}

const DB_NAME = 'silentsuite-offline-queue'
const DB_VERSION = 1
const STORE_NAME = 'mutations'
const MAX_RETRIES = 3

type CountListener = (count: number) => void

let dbPromise: Promise<IDBDatabase> | null = null
const listeners = new Set<CountListener>()

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return dbPromise
}

let counter = 0
function generateId(): string {
  return `${Date.now()}-${++counter}-${Math.random().toString(36).slice(2, 9)}`
}

function notifyListeners(): void {
  // Read count async then notify — fire and forget
  getPendingCount().then((count) => {
    for (const fn of listeners) {
      try { fn(count) } catch {}
    }
  })
}

// --- Public API ---

/**
 * Compact the queue by merging or cancelling redundant entries.
 * Called automatically before each enqueue.
 *
 * Rules:
 * - create + update (same tempId) → merge: update content in the create entry
 * - create + delete (same tempId) → cancel both: remove from queue
 * - update + update (same itemUid) → merge: keep latest content
 * - update + delete (same itemUid) → replace update with delete
 *
 * Returns the id of a compacted entry if the new entry was absorbed, or null.
 */
async function compact(
  incoming: Omit<QueueEntry, 'id' | 'createdAt' | 'retryCount' | 'status'>,
): Promise<string | null> {
  const entries = await getAll()
  const pending = entries.filter((e) => e.status === 'pending')

  // Match by tempId (for items created offline that haven't synced yet)
  if (incoming.tempId) {
    const existing = pending.find(
      (e) => e.tempId === incoming.tempId && e.collectionType === incoming.collectionType,
    )
    if (existing) {
      if (existing.type === 'create' && incoming.type === 'update') {
        // Merge: update content in the existing create entry
        await updateEntry({ ...existing, content: incoming.content })
        return existing.id
      }
      if (existing.type === 'create' && incoming.type === 'delete') {
        // Cancel both: the item was created and deleted offline
        await remove(existing.id)
        return 'cancelled'
      }
    }
  }

  // Match by itemUid (for items that already exist on server)
  if (incoming.itemUid) {
    const existing = pending.find(
      (e) => e.itemUid === incoming.itemUid && e.collectionType === incoming.collectionType,
    )
    if (existing) {
      if (existing.type === 'update' && incoming.type === 'update') {
        // Merge: keep latest content
        await updateEntry({ ...existing, content: incoming.content })
        return existing.id
      }
      if (existing.type === 'update' && incoming.type === 'delete') {
        // Replace update with delete
        await updateEntry({ ...existing, type: 'delete', content: undefined })
        return existing.id
      }
    }
  }

  return null
}

export async function enqueue(
  entry: Omit<QueueEntry, 'id' | 'createdAt' | 'retryCount' | 'status'>,
): Promise<string> {
  // Try compaction first
  const compactedId = await compact(entry)
  if (compactedId) return compactedId

  const db = await openDB()
  const record: QueueEntry = {
    ...entry,
    id: generateId(),
    createdAt: Date.now(),
    retryCount: 0,
    status: 'pending',
  }
  return new Promise<string>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(record)
    tx.oncomplete = () => {
      notifyListeners()
      resolve(record.id)
    }
    tx.onerror = () => reject(tx.error)
  })
}

export async function getAll(): Promise<QueueEntry[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const request = tx.objectStore(STORE_NAME).getAll()
    request.onsuccess = () => {
      const entries = (request.result as QueueEntry[]).sort(
        (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
      )
      resolve(entries)
    }
    request.onerror = () => reject(request.error)
  })
}

export async function getPendingCount(): Promise<number> {
  const entries = await getAll()
  return entries.filter((e) => e.status === 'pending').length
}

export async function remove(id: string): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(id)
    tx.oncomplete = () => {
      notifyListeners()
      resolve()
    }
    tx.onerror = () => reject(tx.error)
  })
}

async function updateEntry(entry: QueueEntry): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(entry)
    tx.oncomplete = () => {
      notifyListeners()
      resolve()
    }
    tx.onerror = () => reject(tx.error)
  })
}

export async function getFailedCount(): Promise<number> {
  const entries = await getAll()
  return entries.filter((e) => e.status === 'failed').length
}

export async function clearFailed(): Promise<void> {
  const entries = await getAll()
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    for (const entry of entries) {
      if (entry.status === 'failed') {
        store.delete(entry.id)
      }
    }
    tx.oncomplete = () => {
      notifyListeners()
      resolve()
    }
    tx.onerror = () => reject(tx.error)
  })
}

/** Reset failed entries back to pending so they can be retried */
export async function retryFailed(): Promise<void> {
  const entries = await getAll()
  for (const entry of entries) {
    if (entry.status === 'failed') {
      await updateEntry({ ...entry, status: 'pending', retryCount: 0 })
    }
  }
}

/**
 * Replay all pending entries in FIFO order.
 * Calls `executeMutation` for each entry. On failure, increments retryCount;
 * after MAX_RETRIES, marks as 'failed'.
 */
export async function replay(
  executeMutation: (entry: QueueEntry) => Promise<{ itemUid?: string }>,
): Promise<ReplayResult[]> {
  const entries = await getAll()
  const pending = entries.filter((e) => e.status === 'pending')
  const results: ReplayResult[] = []

  for (const entry of pending) {
    try {
      const result = await executeMutation(entry)
      await remove(entry.id)
      results.push({ entry, success: true, itemUid: result.itemUid })
    } catch (err) {
      const retryCount = entry.retryCount + 1
      const status = retryCount >= MAX_RETRIES ? 'failed' : 'pending'
      await updateEntry({ ...entry, retryCount, status })
      results.push({
        entry,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      })
      // If we've hit a network error, stop trying remaining entries
      if (!navigator.onLine) break
    }
  }

  return results
}

export function onCountChange(fn: CountListener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** Helper: returns true if an error looks like a network/offline error */
export function isOfflineError(err: unknown): boolean {
  if (!navigator.onLine) return true
  if (err instanceof TypeError && err.message.includes('fetch')) return true
  if (err instanceof DOMException && err.name === 'NetworkError') return true
  const msg = err instanceof Error ? err.message : String(err)
  return /network|offline|failed to fetch|net::ERR_/i.test(msg)
}

/** Reset module state — for testing only */
export async function _resetForTests(): Promise<void> {
  if (dbPromise) {
    try {
      const db = await dbPromise
      db.close()
    } catch {}
  }
  dbPromise = null
  listeners.clear()
  counter = 0
}
