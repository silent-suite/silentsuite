import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import {
  getItemsByType,
  putItem,
  putItems,
  deleteItem,
  replaceItemsForType,
  getCollection,
  putCollection,
  getStoken,
  setStoken,
  clearStoken,
  getMeta,
  putMeta,
  clearAll,
  ensureFingerprint,
  CACHE_SCHEMA_VERSION,
  _resetForTests,
  type CachedItem,
} from '../data-cache'

beforeEach(async () => {
  await _resetForTests()
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('silentsuite-data-cache')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
})

function makeItem(uid: string, type: 'tasks' | 'contacts' | 'calendar' = 'tasks', content = 'CONTENT'): CachedItem {
  return {
    itemUid: uid,
    collectionType: type,
    collectionUid: 'col-1',
    content,
    lastModified: Date.now(),
  }
}

describe('data-cache', () => {
  describe('items CRUD', () => {
    it('starts empty', async () => {
      const items = await getItemsByType('tasks')
      expect(items).toEqual([])
    })

    it('persists and reads back a single item', async () => {
      await putItem(makeItem('task-1', 'tasks', 'A'))
      const items = await getItemsByType('tasks')
      expect(items).toHaveLength(1)
      expect(items[0]!.itemUid).toBe('task-1')
      expect(items[0]!.content).toBe('A')
    })

    it('bulk-inserts via putItems', async () => {
      await putItems([
        makeItem('a', 'tasks'),
        makeItem('b', 'tasks'),
        makeItem('c', 'contacts'),
      ])
      const tasks = await getItemsByType('tasks')
      const contacts = await getItemsByType('contacts')
      expect(tasks).toHaveLength(2)
      expect(contacts).toHaveLength(1)
    })

    it('separates items by collection type via the index', async () => {
      await putItem(makeItem('a', 'tasks'))
      await putItem(makeItem('b', 'contacts'))
      await putItem(makeItem('c', 'calendar'))

      expect(await getItemsByType('tasks')).toHaveLength(1)
      expect(await getItemsByType('contacts')).toHaveLength(1)
      expect(await getItemsByType('calendar')).toHaveLength(1)
    })

    it('overwrites by uid on put', async () => {
      await putItem(makeItem('x', 'tasks', 'old'))
      await putItem(makeItem('x', 'tasks', 'new'))
      const items = await getItemsByType('tasks')
      expect(items).toHaveLength(1)
      expect(items[0]!.content).toBe('new')
    })

    it('deletes a single item by uid', async () => {
      await putItem(makeItem('x', 'tasks'))
      await putItem(makeItem('y', 'tasks'))
      await deleteItem('x')
      const items = await getItemsByType('tasks')
      expect(items.map((i) => i.itemUid)).toEqual(['y'])
    })

    it('replaceItemsForType drops existing of that type and inserts the new set', async () => {
      await putItems([
        makeItem('a', 'tasks'),
        makeItem('b', 'tasks'),
        makeItem('c', 'contacts'),
      ])
      await replaceItemsForType('tasks', [makeItem('z', 'tasks', 'fresh')])

      const tasks = await getItemsByType('tasks')
      expect(tasks).toHaveLength(1)
      expect(tasks[0]!.itemUid).toBe('z')

      // Other types untouched
      const contacts = await getItemsByType('contacts')
      expect(contacts).toHaveLength(1)
      expect(contacts[0]!.itemUid).toBe('c')
    })
  })

  describe('collections / stokens', () => {
    it('returns null for an unknown collection', async () => {
      expect(await getCollection('tasks')).toBeNull()
      expect(await getStoken('tasks')).toBeNull()
    })

    it('persists a collection record', async () => {
      await putCollection({
        collectionType: 'tasks',
        collectionUid: 'col-tasks',
        stoken: 'stk-1',
        lastFullSyncAt: 12345,
      })
      const col = await getCollection('tasks')
      expect(col).not.toBeNull()
      expect(col!.stoken).toBe('stk-1')
      expect(col!.collectionUid).toBe('col-tasks')
    })

    it('setStoken creates and updates the cursor', async () => {
      await setStoken('tasks', 'col-tasks', 'stk-a')
      expect(await getStoken('tasks')).toBe('stk-a')
      await setStoken('tasks', 'col-tasks', 'stk-b')
      expect(await getStoken('tasks')).toBe('stk-b')
    })

    it('clearStoken nulls the stoken but preserves the row', async () => {
      await setStoken('tasks', 'col-tasks', 'stk-a')
      await clearStoken('tasks')
      expect(await getStoken('tasks')).toBeNull()
      const col = await getCollection('tasks')
      expect(col).not.toBeNull()
      expect(col!.collectionUid).toBe('col-tasks')
    })
  })

  describe('meta / fingerprint', () => {
    it('returns null when meta is missing', async () => {
      expect(await getMeta()).toBeNull()
    })

    it('persists meta', async () => {
      await putMeta({
        accountFingerprint: 'alice@example.com',
        cacheSchemaVersion: CACHE_SCHEMA_VERSION,
        lastInvalidatedAt: null,
      })
      const meta = await getMeta()
      expect(meta?.accountFingerprint).toBe('alice@example.com')
    })

    it('ensureFingerprint seeds meta on first run', async () => {
      const ok = await ensureFingerprint('alice@example.com')
      expect(ok).toBe(true)
      const meta = await getMeta()
      expect(meta?.accountFingerprint).toBe('alice@example.com')
      expect(meta?.cacheSchemaVersion).toBe(CACHE_SCHEMA_VERSION)
    })

    it('ensureFingerprint wipes when accounts differ', async () => {
      await setStoken('tasks', 'col-tasks', 'stk-a')
      await ensureFingerprint('alice@example.com')

      const ok = await ensureFingerprint('bob@example.com')
      expect(ok).toBe(false)

      // Cache should be wiped for the new account.
      expect(await getStoken('tasks')).toBeNull()
      const meta = await getMeta()
      expect(meta?.accountFingerprint).toBe('bob@example.com')
      expect(meta?.lastInvalidatedAt).not.toBeNull()
    })

    it('ensureFingerprint accepts the same account on subsequent calls', async () => {
      await ensureFingerprint('alice@example.com')
      await setStoken('tasks', 'col-tasks', 'stk-a')

      const ok = await ensureFingerprint('alice@example.com')
      expect(ok).toBe(true)
      expect(await getStoken('tasks')).toBe('stk-a')
    })
  })

  describe('clearAll', () => {
    it('wipes items, collections, and meta', async () => {
      await putItem(makeItem('x', 'tasks'))
      await setStoken('tasks', 'col-tasks', 'stk')
      await putMeta({
        accountFingerprint: 'a',
        cacheSchemaVersion: CACHE_SCHEMA_VERSION,
        lastInvalidatedAt: null,
      })

      await clearAll()

      expect(await getItemsByType('tasks')).toEqual([])
      expect(await getStoken('tasks')).toBeNull()
      expect(await getMeta()).toBeNull()
    })

    it('is safe to call repeatedly', async () => {
      await clearAll()
      await clearAll()
      expect(await getItemsByType('tasks')).toEqual([])
    })
  })
})
