import 'fake-indexeddb/auto'
import { expect, vi } from 'vitest'
import { bumpAccountEpoch, getAccountEpoch } from '@/app/lib/account-epoch'
import {
  _resetForTests,
  _setEncryptedQueuePersistenceAvailableForTests,
  clearAll,
  enqueue,
  getAll,
  getPendingCount,
  replay,
  type OfflineQueueAccountGuard,
  type QueueEntry,
} from '@/app/lib/offline-queue'

export const TEST_FINGERPRINT = 'store-regression-account'

export function queueGuard(fingerprint = TEST_FINGERPRINT): OfflineQueueAccountGuard {
  return { accountEpoch: getAccountEpoch(), accountFingerprint: fingerprint }
}

export async function resetRealOfflineQueue(): Promise<void> {
  await _resetForTests()
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('silentsuite-offline-queue')
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
  _setEncryptedQueuePersistenceAvailableForTests(true)
}

export async function enqueueCreateFromStore(
  collectionType: QueueEntry['collectionType'],
  collectionUid: string | undefined,
  content: string,
  tempId: string,
): Promise<null> {
  await enqueue({ type: 'create', collectionType, collectionUid, content, tempId }, queueGuard())
  return null
}

export async function expectOwnedQueueEntry(type: QueueEntry['type'], collectionType: QueueEntry['collectionType']): Promise<QueueEntry> {
  const guard = queueGuard()
  const entries = await getAll(guard)
  if (entries.length !== 1) throw new Error(`Expected one guarded queue entry, got ${entries.length}`)
  const entry = entries[0]!
  if (!entry.accountFingerprint) throw new Error('Queue entry has no account fingerprint')
  if (entry.accountFingerprint !== TEST_FINGERPRINT || entry.type !== type || entry.collectionType !== collectionType) {
    throw new Error(`Unexpected queue entry: ${JSON.stringify(entry)}`)
  }
  if (await getPendingCount(guard) !== 1) throw new Error('Guarded pending count did not include entry')
  return entry
}

export async function replayOwnedEntry(entry: QueueEntry): Promise<void> {
  const execute = vi.fn(async () => ({}))
  const results = await replay(execute, queueGuard())
  if (results.length !== 1 || !results[0]!.success) throw new Error('Guarded replay did not execute entry')
  if (execute.mock.calls[0]?.[0].id !== entry.id) throw new Error('Replay executed a different entry')
  if ((await getAll(queueGuard())).length !== 0) throw new Error('Replay did not remove guarded entry')
}

export async function clearQueue(): Promise<void> {
  await clearAll()
}

export function bumpEpochWhenQueuePutRuns(onBoundary: () => void): ReturnType<typeof vi.spyOn> {
  const originalPut = IDBObjectStore.prototype.put
  let bumped = false
  return vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (...args: Parameters<IDBObjectStore['put']>) {
    const request = originalPut.apply(this, args)
    if (!bumped) {
      bumped = true
      bumpAccountEpoch()
      onBoundary()
    }
    return request
  })
}

export async function expectQuietQueueCommitCancellation(
  mutate: () => Promise<unknown>,
  onBoundary: () => void,
  assertNoStaleState: () => void,
  toast: { showErrorToast: ReturnType<typeof vi.fn> },
): Promise<void> {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const putSpy = bumpEpochWhenQueuePutRuns(onBoundary)
  try {
    await expect(mutate()).resolves.not.toThrow()
    assertNoStaleState()
    expect(await getAll()).toEqual([])
    expect(await getAll(queueGuard('new-account'))).toEqual([])
    expect(errorSpy).not.toHaveBeenCalled()
    expect(toast.showErrorToast).not.toHaveBeenCalled()
  } finally {
    putSpy.mockRestore()
    errorSpy.mockRestore()
  }
}
