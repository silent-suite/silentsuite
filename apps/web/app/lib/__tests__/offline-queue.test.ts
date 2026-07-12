import { describe, it, expect, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { AccountBoundaryChangedError, bumpAccountEpoch, getAccountEpoch } from '@/app/lib/account-epoch'
import {
  enqueue as guardedEnqueue,
  getAll,
  getPendingCount,
  getFailedCount,
  replay,
  clearFailed,
  clearAll,
  retryFailed,
  remove,
  onCountChange,
  onEnqueue,
  isOfflineError,
  isQueueFull,
  getStaleEntries,
  MAX_QUEUE_SIZE,
  STALE_THRESHOLD_MS,
  _resetForTests,
  _setEncryptedQueuePersistenceAvailableForTests,
} from '../offline-queue'

const TEST_FINGERPRINT = 'offline-queue-unit-test-account'
function testGuard(accountFingerprint = TEST_FINGERPRINT) {
  return { accountEpoch: getAccountEpoch(), accountFingerprint }
}
function enqueue(
  entry: Parameters<typeof guardedEnqueue>[0],
  guard = testGuard(),
) {
  return guardedEnqueue(entry, guard)
}

beforeEach(async () => {
  process.env.NEXT_PUBLIC_LOCAL_CACHE_ENABLED = 'true'
  // Close existing connection and reset module state
  await _resetForTests()
  _setEncryptedQueuePersistenceAvailableForTests(true)
  // Clear all IndexedDB databases
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('silentsuite-offline-queue')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
})

describe('offline-queue', () => {
  describe('enqueue', () => {
    it('adds an entry and assigns id, createdAt, retryCount', async () => {
      const id = await enqueue({
        type: 'create',
        collectionType: 'tasks',
        content: 'VTODO content',
        tempId: 'temp-1',
      })

      expect(id).toBeTruthy()
      const all = await getAll()
      expect(all).toHaveLength(1)
      expect(all[0].id).toBe(id)
      expect(all[0].type).toBe('create')
      expect(all[0].collectionType).toBe('tasks')
      expect(all[0].content).toBe('VTODO content')
      expect(all[0].tempId).toBe('temp-1')
      expect(all[0].retryCount).toBe(0)
      expect(all[0].status).toBe('pending')
      expect(all[0].createdAt).toBeGreaterThan(0)
    })

    it('increments pending count', async () => {
      expect(await getPendingCount(testGuard())).toBe(0)
      await enqueue({ type: 'update', collectionType: 'contacts', content: 'vcard', itemUid: 'uid-1' })
      expect(await getPendingCount(testGuard())).toBe(1)
      await enqueue({ type: 'delete', collectionType: 'calendar', itemUid: 'uid-2' })
      expect(await getPendingCount(testGuard())).toBe(2)
    })
  })

  describe('privacy guard', () => {
    async function readRawMutations(): Promise<unknown[]> {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('silentsuite-offline-queue', 1)
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains('mutations')) {
            req.result.createObjectStore('mutations', { keyPath: 'id' })
          }
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      try {
        if (!db.objectStoreNames.contains('mutations')) return []
        return await new Promise<unknown[]>((resolve, reject) => {
          const tx = db.transaction('mutations', 'readonly')
          const req = tx.objectStore('mutations').getAll()
          req.onsuccess = () => resolve(req.result ?? [])
          req.onerror = () => reject(req.error)
        })
      } finally {
        db.close()
      }
    }

    it('refuses to persist plaintext PIM content without encrypted local persistence', async () => {
      _setEncryptedQueuePersistenceAvailableForTests(false)
      const sentinel = 'BEGIN:VCALENDAR\nSUMMARY:PRIVATE_SENTINEL_CALENDAR_EVENT\nEND:VCALENDAR'

      await expect(
        enqueue({ type: 'create', collectionType: 'calendar', content: sentinel, tempId: 'temp-private' }),
      ).rejects.toThrow(/refuses to persist plaintext calendar create content/)

      expect(JSON.stringify(await readRawMutations())).not.toContain('PRIVATE_SENTINEL_CALENDAR_EVENT')
      expect(await getAll()).toHaveLength(0)
    })

    it('still persists content-free deletes without encrypted local persistence', async () => {
      _setEncryptedQueuePersistenceAvailableForTests(false)

      await enqueue({ type: 'delete', collectionType: 'contacts', collectionUid: 'address-book', itemUid: 'contact-1' })

      const all = await getAll()
      expect(all).toHaveLength(1)
      expect(all[0].type).toBe('delete')
      expect(all[0].content).toBeUndefined()
    })

    it('purges legacy plaintext content already present in IndexedDB', async () => {
      await clearAll()
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('silentsuite-offline-queue', 1)
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains('mutations')) {
            req.result.createObjectStore('mutations', { keyPath: 'id' })
          }
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('mutations', 'readwrite')
        tx.objectStore('mutations').put({
          id: 'legacy-plaintext',
          type: 'update',
          collectionType: 'tasks',
          collectionUid: 'tasks',
          itemUid: 'task-1',
          content: 'BEGIN:VTODO\nSUMMARY:PRIVATE_SENTINEL_TASK\nEND:VTODO',
          createdAt: Date.now(),
          retryCount: 0,
          status: 'pending',
        })
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      db.close()

      _setEncryptedQueuePersistenceAvailableForTests(false)

      expect(await getAll({ accountEpoch: getAccountEpoch(), accountFingerprint: 'different-account' })).toHaveLength(0)
      expect(JSON.stringify(await readRawMutations())).not.toContain('PRIVATE_SENTINEL_TASK')
    })

    it('clearAll removes queued mutations for logout/account switch cleanup', async () => {
      await enqueue({ type: 'delete', collectionType: 'tasks', collectionUid: 'tasks', itemUid: 'task-1' })
      expect(await getPendingCount(testGuard())).toBe(1)

      await clearAll()

      expect(await getAll()).toHaveLength(0)
      expect(await getPendingCount(testGuard())).toBe(0)
    })
  })

  describe('transactional account boundary', () => {
    const guard = (fingerprint: string) => ({ accountEpoch: getAccountEpoch(), accountFingerprint: fingerprint })

    it('aborts an enqueue after the actual put is issued without records or listeners', async () => {
      const counts: number[] = []
      const enqueues: number[] = []
      onCountChange((count) => counts.push(count))
      onEnqueue(() => enqueues.push(1))
      const originalPut = IDBObjectStore.prototype.put
      const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (...args: Parameters<IDBObjectStore['put']>) {
        const request = originalPut.apply(this, args)
        bumpAccountEpoch()
        return request
      })

      await expect(enqueue({ type: 'delete', collectionType: 'tasks', collectionUid: 'same', itemUid: 'same' }, guard('old')))
        .rejects.toBeInstanceOf(AccountBoundaryChangedError)
      putSpy.mockRestore()
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(await getAll()).toEqual([])
      expect(counts).toEqual([])
      expect(enqueues).toEqual([])
    })

    it('aborts a guarded removal after the actual delete is issued', async () => {
      const owner = guard('old')
      const id = await enqueue({ type: 'delete', collectionType: 'calendar', collectionUid: 'same', itemUid: 'same' }, owner)
      await new Promise((resolve) => setTimeout(resolve, 0))
      const counts: number[] = []
      onCountChange((count) => counts.push(count))
      const originalDelete = IDBObjectStore.prototype.delete
      const deleteSpy = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (...args: Parameters<IDBObjectStore['delete']>) {
        const request = originalDelete.apply(this, args)
        bumpAccountEpoch()
        return request
      })

      await expect(remove(id, owner)).rejects.toBeInstanceOf(AccountBoundaryChangedError)
      deleteSpy.mockRestore()
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect((await getAll()).map((entry) => entry.id)).toEqual([id])
      expect(counts).toEqual([])
    })

    it('aborts a compaction update after its actual put is issued', async () => {
      const owner = guard('old')
      const id = await enqueue({ type: 'update', collectionType: 'tasks', collectionUid: 'same', itemUid: 'same', content: 'before' }, owner)
      await new Promise((resolve) => setTimeout(resolve, 0))
      const counts: number[] = []
      onCountChange((count) => counts.push(count))
      const originalPut = IDBObjectStore.prototype.put
      const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (...args: Parameters<IDBObjectStore['put']>) {
        const request = originalPut.apply(this, args)
        bumpAccountEpoch()
        return request
      })

      await expect(enqueue({ type: 'update', collectionType: 'tasks', collectionUid: 'same', itemUid: 'same', content: 'after' }, owner))
        .rejects.toBeInstanceOf(AccountBoundaryChangedError)
      putSpy.mockRestore()
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(await getAll()).toEqual([expect.objectContaining({ id, content: 'before' })])
      expect(counts).toEqual([])
    })

    it('isolates compaction for different fingerprints sharing collection and item UIDs', async () => {
      await enqueue({ type: 'update', collectionType: 'tasks', collectionUid: 'same', itemUid: 'same', content: 'account A' }, guard('A'))
      await enqueue({ type: 'delete', collectionType: 'tasks', collectionUid: 'same', itemUid: 'same' }, guard('B'))

      const entries = await getAll()
      expect(entries).toHaveLength(2)
      expect(entries.find((entry) => entry.accountFingerprint === 'A')).toMatchObject({ type: 'update', content: 'account A' })
      expect(entries.find((entry) => entry.accountFingerprint === 'B')).toMatchObject({ type: 'delete' })
    })

    it('notifies listeners with only the committing account queue count', async () => {
      await enqueue({ type: 'delete', collectionType: 'tasks', itemUid: 'a' }, guard('A'))
      await new Promise((resolve) => setTimeout(resolve, 0))
      const counts: number[] = []
      onCountChange((count) => counts.push(count))

      await enqueue({ type: 'delete', collectionType: 'tasks', itemUid: 'b' }, guard('B'))
      await vi.waitFor(() => expect(counts).toEqual([1]))
    })

    it('fails closed before IndexedDB work when the exported enqueue guard is undefined', async () => {
      const counts: number[] = []
      const enqueues: number[] = []
      const openSpy = vi.spyOn(indexedDB, 'open')
      onCountChange((count) => counts.push(count))
      onEnqueue(() => enqueues.push(1))

      await expect(guardedEnqueue(
        { type: 'delete', collectionType: 'tasks', itemUid: 'x' },
        undefined as any,
      )).rejects.toBeInstanceOf(AccountBoundaryChangedError)
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(openSpy).not.toHaveBeenCalled()
      expect(await getAll()).toEqual([])
      expect(counts).toEqual([])
      expect(enqueues).toEqual([])
      openSpy.mockRestore()
    })

    it('fails closed when a guarded operation has no fingerprint', async () => {
      await expect(enqueue({ type: 'delete', collectionType: 'tasks', itemUid: 'x' }, {
        accountEpoch: getAccountEpoch(),
        accountFingerprint: '',
      })).rejects.toBeInstanceOf(AccountBoundaryChangedError)
    })
  })

  describe('replay', () => {
    it('fails closed before IndexedDB or remote work when the exported replay guard is undefined', async () => {
      const id = await enqueue({ type: 'delete', collectionType: 'tasks', itemUid: 'guard-required' })
      await new Promise((resolve) => setTimeout(resolve, 0))
      const counts: number[] = []
      const enqueues: number[] = []
      const execute = vi.fn(async () => ({ remoteMutationConfirmed: true as const }))
      // Force the next queue access to open IndexedDB while preserving the record.
      await _resetForTests()
      _setEncryptedQueuePersistenceAvailableForTests(true)
      const openSpy = vi.spyOn(indexedDB, 'open')
      const unsubscribeCount = onCountChange((count) => counts.push(count))
      const unsubscribeEnqueue = onEnqueue(() => enqueues.push(1))

      await expect(replay(execute, undefined as any)).rejects.toBeInstanceOf(AccountBoundaryChangedError)
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(openSpy).not.toHaveBeenCalled()
      expect(execute).not.toHaveBeenCalled()
      expect((await getAll()).map((entry) => entry.id)).toEqual([id])
      expect(counts).toEqual([])
      expect(enqueues).toEqual([])
      unsubscribeCount()
      unsubscribeEnqueue()
      openSpy.mockRestore()
    })

    it('processes entries in FIFO order and removes on success', async () => {
      await enqueue({ type: 'create', collectionType: 'tasks', content: 'a', tempId: 't1' })
      await enqueue({ type: 'update', collectionType: 'tasks', content: 'b', itemUid: 'u1' })

      const order: string[] = []
      const results = await replay(async (entry) => {
        order.push(entry.type)
        return { remoteMutationConfirmed: true, itemUid: entry.type === 'create' ? 'real-uid' : undefined }
      }, testGuard())

      expect(order).toEqual(['create', 'update'])
      expect(results).toHaveLength(2)
      expect(results[0].success).toBe(true)
      expect(results[0].itemUid).toBe('real-uid')
      expect(results[1].success).toBe(true)
      expect(await getPendingCount(testGuard())).toBe(0)
    })

    it('increments retryCount on failure, marks failed after MAX_RETRIES', async () => {
      await enqueue({ type: 'update', collectionType: 'contacts', content: 'x', itemUid: 'u1' })

      // Fail 3 times (MAX_RETRIES = 3)
      for (let i = 0; i < 3; i++) {
        await replay(async () => { throw new Error('server error') }, testGuard())
      }

      const all = await getAll()
      expect(all).toHaveLength(1)
      expect(all[0].retryCount).toBe(3)
      expect(all[0].status).toBe('failed')

      // Failed entries don't count as pending
      expect(await getPendingCount(testGuard())).toBe(0)
    })

    it('retries pending entries but skips failed ones', async () => {
      await enqueue({ type: 'create', collectionType: 'tasks', content: 'a', tempId: 't1' })

      // Fail it 3 times to mark as failed
      for (let i = 0; i < 3; i++) {
        await replay(async () => { throw new Error('fail') }, testGuard())
      }

      // Add a new pending entry
      await enqueue({ type: 'delete', collectionType: 'tasks', itemUid: 'u2' })

      const executeFn = vi.fn().mockResolvedValue({})
      await replay(executeFn, testGuard())

      // Only the new pending entry should be replayed
      expect(executeFn).toHaveBeenCalledTimes(1)
      expect(executeFn.mock.calls[0][0].type).toBe('delete')
    })
  })

  describe('clearFailed', () => {
    it('removes failed entries but keeps pending ones', async () => {
      await enqueue({ type: 'create', collectionType: 'tasks', content: 'a', tempId: 't1' })
      await enqueue({ type: 'update', collectionType: 'contacts', content: 'b', itemUid: 'u1' })

      // Fail the first one 3 times
      // We need to carefully control which entry gets replayed
      let callCount = 0
      for (let i = 0; i < 3; i++) {
        await replay(async () => {
          callCount++
          // First entry (create) always fails; second (update) succeeds
          if (callCount % 2 === 1) throw new Error('fail')
          return {}
        }, testGuard())
      }

      // After 3 rounds: create should be failed (3 retries), update should be gone (succeeded)
      await clearFailed()
      const all = await getAll()
      // Only pending entries remain (none in this case since update succeeded and create was cleared)
      expect(all.filter((e) => e.status === 'failed')).toHaveLength(0)
    })
  })

  describe('remove', () => {
    it('removes a specific entry by id', async () => {
      const id1 = await enqueue({ type: 'create', collectionType: 'tasks', content: 'a' })
      const id2 = await enqueue({ type: 'delete', collectionType: 'tasks', itemUid: 'u1' })

      await remove(id1)
      const all = await getAll()
      expect(all).toHaveLength(1)
      expect(all[0].id).toBe(id2)
    })
  })

  describe('onCountChange', () => {
    it('notifies listeners when count changes', async () => {
      const counts: number[] = []
      const unsub = onCountChange((count) => counts.push(count))

      await enqueue({ type: 'create', collectionType: 'tasks', content: 'a' })
      // Allow async notification to settle
      await new Promise((r) => setTimeout(r, 10))

      await enqueue({ type: 'delete', collectionType: 'tasks', itemUid: 'u1' })
      await new Promise((r) => setTimeout(r, 10))

      expect(counts).toEqual([1, 2])
      unsub()

      await enqueue({ type: 'update', collectionType: 'tasks', content: 'b', itemUid: 'u2' })
      await new Promise((r) => setTimeout(r, 10))
      // Should not receive notification after unsubscribe
      expect(counts).toEqual([1, 2])
    })
  })

  describe('isOfflineError', () => {
    it('returns true for TypeError with fetch message', () => {
      expect(isOfflineError(new TypeError('Failed to fetch'))).toBe(true)
    })

    it('returns true for NetworkError DOMException', () => {
      const err = new DOMException('Network request failed', 'NetworkError')
      expect(isOfflineError(err)).toBe(true)
    })

    it('returns false for unrelated errors', () => {
      expect(isOfflineError(new Error('Invalid JSON'))).toBe(false)
    })
  })

  describe('persistence', () => {
    it('entries survive module reset (simulating browser restart)', async () => {
      await enqueue({ type: 'create', collectionType: 'tasks', content: 'persist-me', tempId: 't1' })

      // Close the connection and clear cached promise (simulates a new page load)
      await _resetForTests()
      _setEncryptedQueuePersistenceAvailableForTests(true)

      // Re-read from IndexedDB — this opens a fresh connection
      const all = await getAll()
      expect(all).toHaveLength(1)
      expect(all[0].content).toBe('persist-me')
    })
  })

  describe('compaction', () => {
    it('create + update with same tempId → merges content into create entry', async () => {
      await enqueue({ type: 'create', collectionType: 'tasks', content: 'original', tempId: 'temp-1' })
      await enqueue({ type: 'update', collectionType: 'tasks', content: 'updated', tempId: 'temp-1' })

      const all = await getAll()
      expect(all).toHaveLength(1)
      expect(all[0].type).toBe('create')
      expect(all[0].content).toBe('updated')
      expect(all[0].tempId).toBe('temp-1')
    })

    it('create + create with same tempId → keeps one create with latest content', async () => {
      await enqueue({ type: 'create', collectionType: 'preferences', content: 'original', tempId: 'prefs' })
      await enqueue({ type: 'create', collectionType: 'preferences', content: 'updated', tempId: 'prefs' })

      const all = await getAll()
      expect(all).toHaveLength(1)
      expect(all[0].type).toBe('create')
      expect(all[0].content).toBe('updated')
      expect(all[0].tempId).toBe('prefs')
    })

    it('create + delete with same tempId → cancels both', async () => {
      await enqueue({ type: 'create', collectionType: 'contacts', content: 'vcard', tempId: 'temp-2' })
      await enqueue({ type: 'delete', collectionType: 'contacts', tempId: 'temp-2' })

      const all = await getAll()
      expect(all).toHaveLength(0)
      expect(await getPendingCount(testGuard())).toBe(0)
    })

    it('update + update with same itemUid → merges to latest content', async () => {
      await enqueue({ type: 'update', collectionType: 'calendar', content: 'v1', itemUid: 'uid-1' })
      await enqueue({ type: 'update', collectionType: 'calendar', content: 'v2', itemUid: 'uid-1' })

      const all = await getAll()
      expect(all).toHaveLength(1)
      expect(all[0].type).toBe('update')
      expect(all[0].content).toBe('v2')
      expect(all[0].itemUid).toBe('uid-1')
    })

    it('update + delete with same itemUid → replaces update with delete', async () => {
      await enqueue({ type: 'update', collectionType: 'tasks', content: 'updated', itemUid: 'uid-2' })
      await enqueue({ type: 'delete', collectionType: 'tasks', itemUid: 'uid-2' })

      const all = await getAll()
      expect(all).toHaveLength(1)
      expect(all[0].type).toBe('delete')
      expect(all[0].itemUid).toBe('uid-2')
      expect(all[0].content).toBeUndefined()
    })

    it('does not compact entries of different collection types', async () => {
      await enqueue({ type: 'update', collectionType: 'tasks', content: 'v1', itemUid: 'uid-1' })
      await enqueue({ type: 'update', collectionType: 'contacts', content: 'v2', itemUid: 'uid-1' })

      const all = await getAll()
      expect(all).toHaveLength(2)
    })

    it('does not compact entries in different collections of the same type', async () => {
      await enqueue({ type: 'update', collectionType: 'tasks', collectionUid: 'col-a', content: 'v1', itemUid: 'uid-1' })
      await enqueue({ type: 'update', collectionType: 'tasks', collectionUid: 'col-b', content: 'v2', itemUid: 'uid-1' })

      const all = await getAll()
      expect(all).toHaveLength(2)
    })

    it('persists collectionUid for replay routing', async () => {
      await enqueue({ type: 'create', collectionType: 'calendar', collectionUid: 'cal-b', content: 'ics', tempId: 'temp-1' })

      const all = await getAll()
      expect(all[0].collectionUid).toBe('cal-b')
    })

    it('retargets a queued temp create when an offline-created event is moved before replay', async () => {
      await enqueue({ type: 'create', collectionType: 'calendar', collectionUid: 'cal-a', content: 'original', tempId: 'temp-1' })
      await enqueue({ type: 'update', collectionType: 'calendar', collectionUid: 'cal-b', content: 'updated', tempId: 'temp-1' })

      const all = await getAll()
      expect(all).toHaveLength(1)
      expect(all[0].type).toBe('create')
      expect(all[0].collectionUid).toBe('cal-b')
      expect(all[0].content).toBe('updated')
      expect(all[0].tempId).toBe('temp-1')
    })

    it('merges an update followed by a move into one move entry', async () => {
      await enqueue({ type: 'update', collectionType: 'calendar', collectionUid: 'cal-a', content: 'updated', itemUid: 'item-1' })
      await enqueue({ type: 'move', collectionType: 'calendar', collectionUid: 'cal-a', targetCollectionUid: 'cal-b', content: 'moved', itemUid: 'item-1' })

      const all = await getAll()
      expect(all).toHaveLength(1)
      expect(all[0].type).toBe('move')
      expect(all[0].collectionUid).toBe('cal-a')
      expect(all[0].targetCollectionUid).toBe('cal-b')
      expect(all[0].content).toBe('moved')
    })

    it('turns a queued move into a source delete if the item is deleted before replay', async () => {
      await enqueue({ type: 'move', collectionType: 'calendar', collectionUid: 'cal-a', targetCollectionUid: 'cal-b', content: 'moved', itemUid: 'item-1' })
      await enqueue({ type: 'delete', collectionType: 'calendar', collectionUid: 'cal-a', itemUid: 'item-1' })

      const all = await getAll()
      expect(all).toHaveLength(1)
      expect(all[0].type).toBe('delete')
      expect(all[0].collectionUid).toBe('cal-a')
      expect(all[0].targetCollectionUid).toBeUndefined()
      expect(all[0].content).toBeUndefined()
    })

    it('turns a queued move back into an update when the item is moved back to its source collection', async () => {
      await enqueue({ type: 'move', collectionType: 'calendar', collectionUid: 'cal-a', targetCollectionUid: 'cal-b', content: 'moved', itemUid: 'item-1' })
      await enqueue({ type: 'update', collectionType: 'calendar', collectionUid: 'cal-a', content: 'back home', itemUid: 'item-1' })

      const all = await getAll()
      expect(all).toHaveLength(1)
      expect(all[0].type).toBe('update')
      expect(all[0].collectionUid).toBe('cal-a')
      expect(all[0].targetCollectionUid).toBeUndefined()
      expect(all[0].content).toBe('back home')
    })

    it('does not compact entries with different tempIds', async () => {
      await enqueue({ type: 'create', collectionType: 'tasks', content: 'a', tempId: 'temp-a' })
      await enqueue({ type: 'update', collectionType: 'tasks', content: 'b', tempId: 'temp-b' })

      const all = await getAll()
      expect(all).toHaveLength(2)
    })

    it('does not compact failed entries', async () => {
      // Enqueue and fail an update 3 times to mark it as failed
      await enqueue({ type: 'update', collectionType: 'tasks', content: 'v1', itemUid: 'uid-3' })
      for (let i = 0; i < 3; i++) {
        await replay(async () => { throw new Error('fail') }, testGuard())
      }
      // Now enqueue another update for the same uid — should NOT compact with failed entry
      await enqueue({ type: 'update', collectionType: 'tasks', content: 'v2', itemUid: 'uid-3' })

      const all = await getAll()
      expect(all).toHaveLength(2)
      expect(all[0].status).toBe('failed')
      expect(all[1].status).toBe('pending')
      expect(all[1].content).toBe('v2')
    })
  })

  describe('getFailedCount', () => {
    it('returns count of failed entries', async () => {
      await enqueue({ type: 'update', collectionType: 'tasks', content: 'x', itemUid: 'u1' })
      expect(await getFailedCount()).toBe(0)

      for (let i = 0; i < 3; i++) {
        await replay(async () => { throw new Error('fail') }, testGuard())
      }
      expect(await getFailedCount()).toBe(1)
    })
  })

  describe('retryFailed', () => {
    it('resets failed entries back to pending with retryCount 0', async () => {
      await enqueue({ type: 'update', collectionType: 'tasks', content: 'x', itemUid: 'u1' })
      for (let i = 0; i < 3; i++) {
        await replay(async () => { throw new Error('fail') }, testGuard())
      }

      expect(await getPendingCount(testGuard())).toBe(0)
      expect(await getFailedCount()).toBe(1)

      await retryFailed()

      expect(await getPendingCount(testGuard())).toBe(1)
      expect(await getFailedCount()).toBe(0)

      const all = await getAll()
      expect(all[0].retryCount).toBe(0)
      expect(all[0].status).toBe('pending')
    })
  })

  describe('queue size limit', () => {
    it('isQueueFull returns false when under limit', async () => {
      await enqueue({ type: 'create', collectionType: 'tasks', content: 'a', tempId: 't1' })
      expect(await isQueueFull()).toBe(false)
    })

    it('isQueueFull returns true when at MAX_QUEUE_SIZE', async () => {
      for (let i = 0; i < MAX_QUEUE_SIZE; i++) {
        await enqueue({ type: 'create', collectionType: 'tasks', content: `item-${i}`, tempId: `t-${i}` })
      }
      expect(await isQueueFull()).toBe(true)
      const all = await getAll()
      expect(all).toHaveLength(MAX_QUEUE_SIZE)
    })

    it('MAX_QUEUE_SIZE is 100', () => {
      expect(MAX_QUEUE_SIZE).toBe(100)
    })

    it('enqueue throws when queue is full (101st entry)', async () => {
      for (let i = 0; i < MAX_QUEUE_SIZE; i++) {
        await enqueue({ type: 'create', collectionType: 'tasks', content: `item-${i}`, tempId: `t-${i}` })
      }

      await expect(
        enqueue({ type: 'create', collectionType: 'tasks', content: 'overflow', tempId: 't-overflow' }),
      ).rejects.toThrow(/Offline queue is full/)
    })
  })

  describe('stale entry detection', () => {
    it('getStaleEntries returns entries older than threshold', async () => {
      // Enqueue an entry then manually backdate it
      await enqueue({ type: 'update', collectionType: 'tasks', content: 'old', itemUid: 'u1' })
      const all = await getAll()
      const entry = all[0]

      // Manually update createdAt to 25 hours ago
      const staleTime = Date.now() - 25 * 60 * 60 * 1000
      const db = await new Promise<IDBDatabase>((resolve) => {
        const req = indexedDB.open('silentsuite-offline-queue', 1)
        req.onsuccess = () => resolve(req.result)
      })
      await new Promise<void>((resolve) => {
        const tx = db.transaction('mutations', 'readwrite')
        tx.objectStore('mutations').put({ ...entry, createdAt: staleTime })
        tx.oncomplete = () => resolve()
      })
      db.close()

      const stale = await getStaleEntries()
      expect(stale).toHaveLength(1)
      expect(stale[0].itemUid).toBe('u1')
    })

    it('getStaleEntries returns empty for fresh entries', async () => {
      await enqueue({ type: 'create', collectionType: 'contacts', content: 'fresh', tempId: 't1' })
      const stale = await getStaleEntries()
      expect(stale).toHaveLength(0)
    })

    it('getStaleEntries excludes failed entries', async () => {
      await enqueue({ type: 'update', collectionType: 'tasks', content: 'x', itemUid: 'u1' })

      // Fail it to mark as failed
      for (let i = 0; i < 3; i++) {
        await replay(async () => { throw new Error('fail') }, testGuard())
      }

      // Backdate createdAt
      const all = await getAll()
      const entry = all[0]
      const staleTime = Date.now() - 25 * 60 * 60 * 1000
      const db = await new Promise<IDBDatabase>((resolve) => {
        const req = indexedDB.open('silentsuite-offline-queue', 1)
        req.onsuccess = () => resolve(req.result)
      })
      await new Promise<void>((resolve) => {
        const tx = db.transaction('mutations', 'readwrite')
        tx.objectStore('mutations').put({ ...entry, createdAt: staleTime })
        tx.oncomplete = () => resolve()
      })
      db.close()

      const stale = await getStaleEntries()
      expect(stale).toHaveLength(0) // failed entries excluded
    })

    it('STALE_THRESHOLD_MS is 24 hours', () => {
      expect(STALE_THRESHOLD_MS).toBe(24 * 60 * 60 * 1000)
    })
  })

  describe('onEnqueue', () => {
    it('fires when a new entry is enqueued (not compacted)', async () => {
      const calls: number[] = []
      const unsub = onEnqueue(() => calls.push(1))

      await enqueue({ type: 'create', collectionType: 'tasks', content: 'a', tempId: 't1' })
      await new Promise((r) => setTimeout(r, 10))
      expect(calls).toHaveLength(1)

      // Compacted entry (update merges into create) should NOT fire onEnqueue
      await enqueue({ type: 'update', collectionType: 'tasks', content: 'b', tempId: 't1' })
      await new Promise((r) => setTimeout(r, 10))
      expect(calls).toHaveLength(1) // still 1, not 2

      unsub()
    })
  })

  describe('cold-start replay', () => {
    it('replays pending entries that exist when app loads online', async () => {
      // Simulate entries persisted from a previous session
      await enqueue({ type: 'create', collectionType: 'tasks', content: 'offline-1', tempId: 't1' })
      await enqueue({ type: 'update', collectionType: 'contacts', content: 'offline-2', itemUid: 'u1' })

      // Simulate module reset (like a page reload)
      await _resetForTests()
      _setEncryptedQueuePersistenceAvailableForTests(true)

      // Verify entries persist across resets
      const count = await getPendingCount(testGuard())
      expect(count).toBe(2)

      // Replay all pending entries (simulates cold-start replay)
      const executeFn = vi.fn().mockResolvedValue({ remoteMutationConfirmed: true, itemUid: 'new-uid' })
      const results = await replay(executeFn, testGuard())

      expect(executeFn).toHaveBeenCalledTimes(2)
      expect(results).toHaveLength(2)
      expect(results.every((r) => r.success)).toBe(true)
      expect(await getPendingCount(testGuard())).toBe(0)
    })
  })

  describe('account-bound replay', () => {
    it('never executes or removes entries owned by another account fingerprint', async () => {
      const oldGuard = { accountEpoch: getAccountEpoch(), accountFingerprint: 'old-account' }
      const id = await enqueue({ type: 'delete', collectionType: 'calendar', collectionUid: 'shared', itemUid: 'same-id' }, oldGuard)
      const newGuard = { accountEpoch: getAccountEpoch(), accountFingerprint: 'new-account' }
      const execute = vi.fn().mockResolvedValue({})

      expect(await replay(execute, newGuard)).toEqual([])
      expect(execute).not.toHaveBeenCalled()
      expect((await getAll()).map((entry) => entry.id)).toContain(id)
    })

    it('quietly stops when the boundary changes during execute without retry mutation or publication', async () => {
      const guard = { accountEpoch: getAccountEpoch(), accountFingerprint: 'current-account' }
      const id = await enqueue({ type: 'delete', collectionType: 'tasks', collectionUid: 'tasks', itemUid: 'task-1' }, guard)
      await new Promise((resolve) => setTimeout(resolve, 0))
      const listener = vi.fn()
      const unsubscribe = onCountChange(listener)
      const results = await replay(async () => {
        bumpAccountEpoch()
        return { remoteMutationConfirmed: true, itemUid: 'must-not-publish' }
      }, guard)
      unsubscribe()

      expect(results).toEqual([])
      const entry = (await getAll()).find((candidate) => candidate.id === id)
      expect(entry).toMatchObject({ retryCount: 0, status: 'pending' })
      expect(listener).not.toHaveBeenCalled()
    })
  })
})
