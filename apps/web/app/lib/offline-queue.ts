/**
 * Offline mutation queue backed by IndexedDB.
 * Catches failed Etebase mutations when offline, persists them,
 * and replays them in FIFO order when connectivity returns.
 */
import { logger } from '@/app/lib/logger'

type CollectionTypeKey = 'calendar' | 'tasks' | 'contacts' | 'preferences' | 'labelIndex'
type MutationType = 'create' | 'update' | 'delete' | 'move'

export interface QueueEntry {
  id: string
  type: MutationType
  collectionType: CollectionTypeKey
  collectionUid?: string
  targetCollectionUid?: string
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

/** Maximum number of entries allowed in the queue before warning the user */
export const MAX_QUEUE_SIZE = 100

/** Entries older than this threshold (ms) are considered stale (24 hours) */
export const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000

type CountListener = (count: number) => void

let dbPromise: Promise<IDBDatabase> | null = null
const listeners = new Set<CountListener>()
let encryptedQueuePersistenceAvailableForTests = false

function isEncryptedQueuePersistenceAvailable(): boolean {
  // Production has no encrypted offline-queue content store yet. Keep content
  // persistence fail-closed until a real encrypted queue envelope exists.
  return encryptedQueuePersistenceAvailableForTests
}

function hasPersistedPlaintextContent(entry: Pick<QueueEntry, 'content'>): boolean {
  return typeof entry.content === 'string'
}

function assertCanPersistEntry(
  entry: Pick<QueueEntry, 'type' | 'collectionType' | 'content'>,
): void {
  if (!hasPersistedPlaintextContent(entry)) return
  if (isEncryptedQueuePersistenceAvailable()) return
  throw new Error(
    `Offline queue refuses to persist plaintext ${entry.collectionType} ${entry.type} content without encrypted local persistence.`,
  )
}

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
      try { fn(count) } catch (err) { logger.warn('OfflineQueue', 'Listener callback failed', err) }
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
 * - update + move / move + update (same itemUid) → merge into move with latest content
 *   (unless the update returns to the source collection, then revert to update)
 * - move + delete (same itemUid) → replace move with source delete
 *
 * Returns the id of a compacted entry if the new entry was absorbed, or null.
 */
async function compact(
  incoming: Omit<QueueEntry, 'id' | 'createdAt' | 'retryCount' | 'status'>,
): Promise<string | null> {
  assertCanPersistEntry(incoming)
  const entries = await getAll()
  const pending = entries.filter((e) => e.status === 'pending')

  // Match by tempId (for items created offline that haven't synced yet)
  if (incoming.tempId) {
    const existing = pending.find(
      (e) => e.tempId === incoming.tempId && e.collectionType === incoming.collectionType,
    )
    if (existing) {
      if (existing.type === 'create' && incoming.type === 'update') {
        // Merge: update content and target collection in the existing create entry.
        await updateEntry({ ...existing, collectionUid: incoming.collectionUid ?? existing.collectionUid, content: incoming.content })
        return existing.id
      }
      if (existing.type === 'create' && incoming.type === 'create') {
        // Merge duplicate creates for the same optimistic item, keeping latest content.
        await updateEntry({ ...existing, collectionUid: incoming.collectionUid ?? existing.collectionUid, content: incoming.content })
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
    const moveRelated = pending.find(
      (e) => e.itemUid === incoming.itemUid && e.collectionType === incoming.collectionType && (e.type === 'move' || incoming.type === 'move'),
    )
    if (moveRelated) {
      if (moveRelated.type === 'update' && incoming.type === 'move') {
        await updateEntry({
          ...moveRelated,
          type: 'move',
          collectionUid: incoming.collectionUid ?? moveRelated.collectionUid,
          targetCollectionUid: incoming.targetCollectionUid,
          content: incoming.content,
        })
        return moveRelated.id
      }
      if (moveRelated.type === 'move' && incoming.type === 'update') {
        if (incoming.collectionUid && incoming.collectionUid === moveRelated.collectionUid) {
          await updateEntry({ ...moveRelated, type: 'update', targetCollectionUid: undefined, content: incoming.content })
          return moveRelated.id
        }
        await updateEntry({ ...moveRelated, content: incoming.content ?? moveRelated.content })
        return moveRelated.id
      }
      if (moveRelated.type === 'move' && incoming.type === 'move') {
        await updateEntry({
          ...moveRelated,
          collectionUid: incoming.collectionUid ?? moveRelated.collectionUid,
          targetCollectionUid: incoming.targetCollectionUid ?? moveRelated.targetCollectionUid,
          content: incoming.content ?? moveRelated.content,
        })
        return moveRelated.id
      }
      if (moveRelated.type === 'move' && incoming.type === 'delete') {
        await updateEntry({ ...moveRelated, type: 'delete', targetCollectionUid: undefined, content: undefined })
        return moveRelated.id
      }
    }

    const existing = pending.find(
      (e) => e.itemUid === incoming.itemUid && e.collectionType === incoming.collectionType && e.collectionUid === incoming.collectionUid,
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

  // Enforce queue size limit (count only pending entries)
  if (await isQueueFull()) {
    throw new Error(`Offline queue is full (max ${MAX_QUEUE_SIZE} pending entries). Connect to the internet to sync your changes.`)
  }

  const db = await openDB()
  const record: QueueEntry = {
    ...entry,
    id: generateId(),
    createdAt: Date.now(),
    retryCount: 0,
    status: 'pending',
  }
  assertCanPersistEntry(record)
  return new Promise<string>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(record)
    tx.oncomplete = () => {
      notifyListeners()
      notifyEnqueueListeners()
      resolve(record.id)
    }
    tx.onerror = () => reject(tx.error)
  })
}

export async function getAll(): Promise<QueueEntry[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    // Use a readwrite transaction so legacy plaintext records can be purged
    // atomically before callers observe the queue.
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const request = store.getAll()
    let safeEntries: QueueEntry[] = []
    request.onsuccess = () => {
      const entries = (request.result as QueueEntry[]).sort(
        (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
      )
      if (!isEncryptedQueuePersistenceAvailable()) {
        safeEntries = entries.filter((entry) => !hasPersistedPlaintextContent(entry))
        for (const entry of entries) {
          if (hasPersistedPlaintextContent(entry)) store.delete(entry.id)
        }
        return
      }
      safeEntries = entries
    }
    request.onerror = () => reject(request.error)
    tx.oncomplete = () => resolve(safeEntries)
    tx.onerror = () => reject(tx.error)
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
  assertCanPersistEntry(entry)
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

export async function clearAll(): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).clear()
    tx.oncomplete = () => {
      notifyListeners()
      resolve()
    }
    tx.onerror = () => reject(tx.error)
  })
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

/** Returns true if pending entries have reached or exceeded MAX_QUEUE_SIZE */
export async function isQueueFull(): Promise<boolean> {
  const entries = await getAll()
  return entries.filter((e) => e.status === 'pending').length >= MAX_QUEUE_SIZE
}

/** Returns pending entries older than the given threshold (defaults to 24h) */
export async function getStaleEntries(thresholdMs: number = STALE_THRESHOLD_MS): Promise<QueueEntry[]> {
  const entries = await getAll()
  const cutoff = Date.now() - thresholdMs
  return entries.filter((e) => e.status === 'pending' && e.createdAt < cutoff)
}

type EnqueueListener = () => void
const enqueueListeners = new Set<EnqueueListener>()

/** Subscribe to enqueue events (fired each time a new entry is added) */
export function onEnqueue(fn: EnqueueListener): () => void {
  enqueueListeners.add(fn)
  return () => { enqueueListeners.delete(fn) }
}

function notifyEnqueueListeners(): void {
  for (const fn of enqueueListeners) {
    try { fn() } catch (err) { logger.warn('OfflineQueue', 'Enqueue listener failed', err) }
  }
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
    } catch (err) { logger.warn('OfflineQueue', 'Failed to close DB during test reset', err) }
  }
  dbPromise = null
  listeners.clear()
  enqueueListeners.clear()
  counter = 0
  encryptedQueuePersistenceAvailableForTests = false
}

export function _setEncryptedQueuePersistenceAvailableForTests(available: boolean): void {
  encryptedQueuePersistenceAvailableForTests = available
}
