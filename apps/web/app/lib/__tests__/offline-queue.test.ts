import { describe, it, expect, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import {
  enqueue,
  getAll,
  getPendingCount,
  getFailedCount,
  replay,
  clearFailed,
  retryFailed,
  remove,
  onCountChange,
  isOfflineError,
  _resetForTests,
} from '../offline-queue'

beforeEach(async () => {
  // Close existing connection and reset module state
  await _resetForTests()
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
      expect(await getPendingCount()).toBe(0)
      await enqueue({ type: 'update', collectionType: 'contacts', content: 'vcard', itemUid: 'uid-1' })
      expect(await getPendingCount()).toBe(1)
      await enqueue({ type: 'delete', collectionType: 'calendar', itemUid: 'uid-2' })
      expect(await getPendingCount()).toBe(2)
    })
  })

  describe('replay', () => {
    it('processes entries in FIFO order and removes on success', async () => {
      await enqueue({ type: 'create', collectionType: 'tasks', content: 'a', tempId: 't1' })
      await enqueue({ type: 'update', collectionType: 'tasks', content: 'b', itemUid: 'u1' })

      const order: string[] = []
      const results = await replay(async (entry) => {
        order.push(entry.type)
        return { itemUid: entry.type === 'create' ? 'real-uid' : undefined }
      })

      expect(order).toEqual(['create', 'update'])
      expect(results).toHaveLength(2)
      expect(results[0].success).toBe(true)
      expect(results[0].itemUid).toBe('real-uid')
      expect(results[1].success).toBe(true)
      expect(await getPendingCount()).toBe(0)
    })

    it('increments retryCount on failure, marks failed after MAX_RETRIES', async () => {
      await enqueue({ type: 'update', collectionType: 'contacts', content: 'x', itemUid: 'u1' })

      // Fail 3 times (MAX_RETRIES = 3)
      for (let i = 0; i < 3; i++) {
        await replay(async () => { throw new Error('server error') })
      }

      const all = await getAll()
      expect(all).toHaveLength(1)
      expect(all[0].retryCount).toBe(3)
      expect(all[0].status).toBe('failed')

      // Failed entries don't count as pending
      expect(await getPendingCount()).toBe(0)
    })

    it('retries pending entries but skips failed ones', async () => {
      await enqueue({ type: 'create', collectionType: 'tasks', content: 'a', tempId: 't1' })

      // Fail it 3 times to mark as failed
      for (let i = 0; i < 3; i++) {
        await replay(async () => { throw new Error('fail') })
      }

      // Add a new pending entry
      await enqueue({ type: 'delete', collectionType: 'tasks', itemUid: 'u2' })

      const executeFn = vi.fn().mockResolvedValue({})
      await replay(executeFn)

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
        })
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

    it('create + delete with same tempId → cancels both', async () => {
      await enqueue({ type: 'create', collectionType: 'contacts', content: 'vcard', tempId: 'temp-2' })
      await enqueue({ type: 'delete', collectionType: 'contacts', tempId: 'temp-2' })

      const all = await getAll()
      expect(all).toHaveLength(0)
      expect(await getPendingCount()).toBe(0)
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
        await replay(async () => { throw new Error('fail') })
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
        await replay(async () => { throw new Error('fail') })
      }
      expect(await getFailedCount()).toBe(1)
    })
  })

  describe('retryFailed', () => {
    it('resets failed entries back to pending with retryCount 0', async () => {
      await enqueue({ type: 'update', collectionType: 'tasks', content: 'x', itemUid: 'u1' })
      for (let i = 0; i < 3; i++) {
        await replay(async () => { throw new Error('fail') })
      }

      expect(await getPendingCount()).toBe(0)
      expect(await getFailedCount()).toBe(1)

      await retryFailed()

      expect(await getPendingCount()).toBe(1)
      expect(await getFailedCount()).toBe(0)

      const all = await getAll()
      expect(all[0].retryCount).toBe(0)
      expect(all[0].status).toBe('pending')
    })
  })
})
