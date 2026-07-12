/**
 * Offline mutation queue backed by IndexedDB.
 * Catches failed Etebase mutations when offline, persists them,
 * and replays them in FIFO order when connectivity returns.
 */
import { logger } from '@/app/lib/logger'
import { AccountBoundaryChangedError, assertCurrentAccountEpoch } from '@/app/lib/account-epoch'

type CollectionTypeKey = 'calendar' | 'tasks' | 'contacts' | 'preferences'
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
  accountFingerprint?: string
  /** Durable, non-plaintext replay progress. Older records omit these fields. */
  replayPhase?: 'target-confirmed'
  confirmedTargetUid?: string
}

export interface OfflineQueueAccountGuard {
  accountEpoch: number
  accountFingerprint: string
}

export interface ReplayResult {
  entry: QueueEntry
  success: boolean
  /** For create replays, the real UID returned by Etebase */
  itemUid?: string
  error?: string
}

/** A replay executor may acknowledge an entry only after the remote mutation succeeded. */
export interface ConfirmedRemoteMutation {
  remoteMutationConfirmed: true
  itemUid?: string
}

export type ReplayCheckpoint = (progress: Pick<QueueEntry, 'replayPhase' | 'confirmedTargetUid'>) => Promise<void>

/** The remote mutation was not attempted or could not be affirmatively confirmed. */
export class ReplayNotConfirmedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReplayNotConfirmedError'
  }
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

function assertGuard(guard?: OfflineQueueAccountGuard): void {
  if (!guard) return
  if (!guard.accountFingerprint) throw new AccountBoundaryChangedError()
  assertCurrentAccountEpoch(guard.accountEpoch)
}

function queueCommitGuard(store: IDBObjectStore, tx: IDBTransaction, guard?: OfflineQueueAccountGuard): void {
  if (!guard) return
  const request = store.get('__account_boundary_commit_guard__')
  request.onsuccess = () => {
    try { assertGuard(guard) } catch { tx.abort() }
  }
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

function notifyListeners(guard?: OfflineQueueAccountGuard): void {
  // Snapshot subscribers at commit notification time so listeners registered
  // later cannot observe an earlier account transaction.
  const subscribers = [...listeners]
  const entriesPromise = guard ? getAll(guard) : getAll()
  entriesPromise.then((entries) => entries.filter((entry) => entry.status === 'pending').length).then((count) => {
    for (const fn of subscribers) {
      try { fn(count) } catch (err) { logger.warn('OfflineQueue', 'Listener callback failed', err) }
    }
  }).catch((err) => {
    if (err instanceof AccountBoundaryChangedError) return
    logger.warn('OfflineQueue', 'Listener count refresh failed', {
      errorName: err instanceof Error ? err.name : 'UnknownError',
    })
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
  guard?: OfflineQueueAccountGuard,
): Promise<string | null> {
  assertCanPersistEntry(incoming)
  assertGuard(guard)
  const entries = await getAll(guard)
  assertGuard(guard)
  const pending = entries.filter((e) => e.status === 'pending' && (!guard || e.accountFingerprint === guard.accountFingerprint))

  // Match by tempId (for items created offline that haven't synced yet)
  if (incoming.tempId) {
    const existing = pending.find(
      (e) => e.tempId === incoming.tempId && e.collectionType === incoming.collectionType,
    )
    if (existing) {
      if (existing.type === 'create' && incoming.type === 'update') {
        // Merge: update content and target collection in the existing create entry.
        await updateEntry({ ...existing, collectionUid: incoming.collectionUid ?? existing.collectionUid, content: incoming.content }, guard)
        return existing.id
      }
      if (existing.type === 'create' && incoming.type === 'create') {
        // Merge duplicate creates for the same optimistic item, keeping latest content.
        await updateEntry({ ...existing, collectionUid: incoming.collectionUid ?? existing.collectionUid, content: incoming.content }, guard)
        return existing.id
      }
      if (existing.type === 'create' && incoming.type === 'delete') {
        // Cancel both: the item was created and deleted offline
        await remove(existing.id, guard)
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
        }, guard)
        return moveRelated.id
      }
      if (moveRelated.type === 'move' && incoming.type === 'update') {
        if (incoming.collectionUid && incoming.collectionUid === moveRelated.collectionUid) {
          await updateEntry({ ...moveRelated, type: 'update', targetCollectionUid: undefined, content: incoming.content }, guard)
          return moveRelated.id
        }
        await updateEntry({ ...moveRelated, content: incoming.content ?? moveRelated.content }, guard)
        return moveRelated.id
      }
      if (moveRelated.type === 'move' && incoming.type === 'move') {
        await updateEntry({
          ...moveRelated,
          collectionUid: incoming.collectionUid ?? moveRelated.collectionUid,
          targetCollectionUid: incoming.targetCollectionUid ?? moveRelated.targetCollectionUid,
          content: incoming.content ?? moveRelated.content,
        }, guard)
        return moveRelated.id
      }
      if (moveRelated.type === 'move' && incoming.type === 'delete') {
        await updateEntry({ ...moveRelated, type: 'delete', targetCollectionUid: undefined, content: undefined }, guard)
        return moveRelated.id
      }
    }

    const existing = pending.find(
      (e) => e.itemUid === incoming.itemUid && e.collectionType === incoming.collectionType && e.collectionUid === incoming.collectionUid,
    )
    if (existing) {
      if (existing.type === 'update' && incoming.type === 'update') {
        // Merge: keep latest content
        await updateEntry({ ...existing, content: incoming.content }, guard)
        return existing.id
      }
      if (existing.type === 'update' && incoming.type === 'delete') {
        // Replace update with delete
        await updateEntry({ ...existing, type: 'delete', content: undefined }, guard)
        return existing.id
      }
    }
  }

  return null
}

async function enqueueInternal(
  entry: Omit<QueueEntry, 'id' | 'createdAt' | 'retryCount' | 'status'>,
  guard: OfflineQueueAccountGuard,
): Promise<string> {
  assertGuard(guard)
  // Try compaction first
  const compactedId = await compact(entry, guard)
  assertGuard(guard)
  if (compactedId) return compactedId

  // Enforce queue size limit (count only pending entries)
  if (await isQueueFull(guard)) {
    throw new Error(`Offline queue is full (max ${MAX_QUEUE_SIZE} pending entries). Connect to the internet to sync your changes.`)
  }
  assertGuard(guard)

  const db = await openDB()
  assertGuard(guard)
  const record: QueueEntry = {
    ...entry,
    id: generateId(),
    createdAt: Date.now(),
    retryCount: 0,
    status: 'pending',
    accountFingerprint: guard.accountFingerprint,
  }
  assertCanPersistEntry(record)
  return new Promise<string>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    store.put(record)
    queueCommitGuard(store, tx, guard)
    tx.oncomplete = () => {
      notifyListeners(guard)
      notifyEnqueueListeners()
      resolve(record.id)
    }
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(guard ? new AccountBoundaryChangedError() : tx.error)
  })
}

/** Account-scoped production enqueue. A valid owner is mandatory by type. */
export function enqueue(
  entry: Omit<QueueEntry, 'id' | 'createdAt' | 'retryCount' | 'status'>,
  guard: OfflineQueueAccountGuard,
): Promise<string> {
  // TypeScript cannot protect this runtime boundary from JavaScript callers,
  // `any`, or stale bundles. Reject before compact/openDB can touch IndexedDB.
  if (!guard) return Promise.reject(new AccountBoundaryChangedError())
  return enqueueInternal(entry, guard)
}

export async function getAll(guard?: OfflineQueueAccountGuard): Promise<QueueEntry[]> {
  assertGuard(guard)
  const db = await openDB()
  assertGuard(guard)
  return new Promise((resolve, reject) => {
    // Use a readwrite transaction so legacy plaintext records can be purged
    // atomically before callers observe the queue.
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const request = store.getAll()
    let safeEntries: QueueEntry[] = []
    request.onsuccess = () => {
      const allEntries = (request.result as QueueEntry[]).sort(
        (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
      )
      if (!isEncryptedQueuePersistenceAvailable()) {
        const safeAllEntries = allEntries.filter((entry) => !hasPersistedPlaintextContent(entry))
        for (const entry of allEntries) {
          if (hasPersistedPlaintextContent(entry)) store.delete(entry.id)
        }
        safeEntries = safeAllEntries.filter((entry) => !guard || entry.accountFingerprint === guard.accountFingerprint)
        return
      }
      safeEntries = allEntries.filter((entry) => !guard || entry.accountFingerprint === guard.accountFingerprint)
    }
    request.onerror = () => reject(request.error)
    queueCommitGuard(store, tx, guard)
    tx.oncomplete = () => resolve(safeEntries)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(guard ? new AccountBoundaryChangedError() : tx.error)
  })
}

export async function getPendingCount(guard: OfflineQueueAccountGuard): Promise<number> {
  const entries = await getAll(guard)
  assertGuard(guard)
  return entries.filter((e) => e.status === 'pending').length
}

export async function remove(id: string, guard?: OfflineQueueAccountGuard): Promise<void> {
  assertGuard(guard)
  const db = await openDB()
  assertGuard(guard)
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    if (guard) {
      const lookup = store.get(id)
      lookup.onsuccess = () => {
        try {
          assertGuard(guard)
          const entry = lookup.result as QueueEntry | undefined
          if (entry?.accountFingerprint === guard.accountFingerprint) store.delete(id)
          queueCommitGuard(store, tx, guard)
        } catch { tx.abort() }
      }
      lookup.onerror = () => reject(lookup.error)
    } else {
      store.delete(id)
    }
    tx.oncomplete = () => {
      notifyListeners(guard)
      resolve()
    }
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(guard ? new AccountBoundaryChangedError() : tx.error)
  })
}

async function updateEntry(entry: QueueEntry, guard?: OfflineQueueAccountGuard): Promise<void> {
  assertCanPersistEntry(entry)
  assertGuard(guard)
  if (guard && entry.accountFingerprint !== guard.accountFingerprint) throw new AccountBoundaryChangedError()
  const db = await openDB()
  assertGuard(guard)
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    store.put(entry)
    queueCommitGuard(store, tx, guard)
    tx.oncomplete = () => {
      notifyListeners(guard)
      resolve()
    }
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(guard ? new AccountBoundaryChangedError() : tx.error)
  })
}

export async function getFailedCount(guard: OfflineQueueAccountGuard): Promise<number> {
  const entries = await getAll(guard)
  assertGuard(guard)
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

export async function clearFailed(guard: OfflineQueueAccountGuard): Promise<void> {
  const entries = await getAll(guard)
  assertGuard(guard)
  for (const entry of entries) {
    if (entry.status !== 'failed') continue
    assertGuard(guard)
    await remove(entry.id, guard)
    assertGuard(guard)
  }
}

/** Reset failed entries back to pending so they can be retried */
export async function retryFailed(guard: OfflineQueueAccountGuard): Promise<void> {
  const entries = await getAll(guard)
  assertGuard(guard)
  for (const entry of entries) {
    if (entry.status === 'failed') {
      assertGuard(guard)
      await updateEntry({ ...entry, status: 'pending', retryCount: 0 }, guard)
      assertGuard(guard)
    }
  }
}

/**
 * Replay all pending entries in FIFO order.
 * Calls `executeMutation` for each entry. On failure, increments retryCount;
 * after MAX_RETRIES, marks as 'failed'.
 */
export async function replay(
  executeMutation: (entry: QueueEntry, checkpoint: ReplayCheckpoint) => Promise<ConfirmedRemoteMutation>,
  guard: OfflineQueueAccountGuard,
): Promise<ReplayResult[]> {
  try {
  assertGuard(guard)
  const entries = await getAll(guard)
  assertGuard(guard)
  const pending = entries.filter((e) => e.status === 'pending')
  const results: ReplayResult[] = []

  for (const entry of pending) {
    let currentEntry = entry
    let remoteMutationConfirmed = false
    try {
      assertGuard(guard)
      const checkpoint: ReplayCheckpoint = async (progress) => {
        const updated = { ...currentEntry, ...progress }
        await updateEntry(updated, guard)
        currentEntry = updated
      }
      const result = await executeMutation(currentEntry, checkpoint)
      assertGuard(guard)
      if (!result || result.remoteMutationConfirmed !== true) {
        throw new ReplayNotConfirmedError('Replay mutation did not receive affirmative remote confirmation')
      }
      remoteMutationConfirmed = true
      await remove(entry.id, guard)
      assertGuard(guard)
      results.push({ entry, success: true, itemUid: result.itemUid })
    } catch (err) {
      if (err instanceof AccountBoundaryChangedError) return []
      assertGuard(guard)
      if (remoteMutationConfirmed) {
        // The server mutation is complete. A local checkpoint/removal failure
        // must not consume the remote retry budget or mark completed work failed.
        results.push({ entry, success: false, error: err instanceof Error ? err.message : String(err) })
        continue
      }
      if (err instanceof ReplayNotConfirmedError || isOfflineError(err)) {
        results.push({
          entry,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })
        if (isOfflineError(err)) break
        continue
      }
      const retryCount = currentEntry.retryCount + 1
      const status = retryCount >= MAX_RETRIES ? 'failed' : 'pending'
      await updateEntry({ ...currentEntry, retryCount, status }, guard)
      assertGuard(guard)
      results.push({
        entry,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      })
      // If we've hit a network error, stop trying remaining entries
      if (!navigator.onLine) break
    }
  }

  assertGuard(guard)
  return results
  } catch (err) {
    if (err instanceof AccountBoundaryChangedError) return []
    throw err
  }
}

export function onCountChange(fn: CountListener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** Returns true if pending entries have reached or exceeded MAX_QUEUE_SIZE */
export async function isQueueFull(guard?: OfflineQueueAccountGuard): Promise<boolean> {
  const entries = await getAll(guard)
  assertGuard(guard)
  return entries.filter((e) => e.status === 'pending').length >= MAX_QUEUE_SIZE
}

/** Returns pending entries older than the given threshold (defaults to 24h) */
export async function getStaleEntries(guard: OfflineQueueAccountGuard, thresholdMs: number = STALE_THRESHOLD_MS): Promise<QueueEntry[]> {
  const entries = await getAll(guard)
  assertGuard(guard)
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
