import { describe, it, expect, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import {
  getItemsByType,
  putItem,
  putItems,
  deleteItem,
  replaceItemsForType,
  replaceItemsForCollection,
  getCollection,
  putCollection,
  getStoken,
  setStoken,
  clearStoken,
  getMeta,
  putMeta,
  clearAll,
  ensureFingerprint,
  ensureEncryptedEnvelope,
  getCacheCapabilityStatus,
  isCacheEnabled,
  CACHE_SCHEMA_VERSION,
  _resetForTests,
  _setEncryptedCacheAvailableForTests,
  _setEnvelopeKeyForTests,
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
  await installTestEnvelope()
})

function makeItem(uid: string, type: 'tasks' | 'contacts' | 'calendar' = 'tasks', content = 'CONTENT', collectionUid = 'col-1'): CachedItem {
  return {
    itemUid: uid,
    collectionType: type,
    collectionUid,
    content,
    lastModified: Date.now(),
  }
}

async function makeTestKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

async function installTestEnvelope(): Promise<void> {
  _setEnvelopeKeyForTests(await makeTestKey())
  _setEncryptedCacheAvailableForTests(true)
}

async function rawItems(): Promise<unknown[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('silentsuite-data-cache')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  try {
    if (!db.objectStoreNames.contains('items')) return []
    return await new Promise<unknown[]>((resolve, reject) => {
      const tx = db.transaction('items', 'readonly')
      const req = tx.objectStore('items').getAll()
      req.onsuccess = () => resolve(req.result ?? [])
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

async function rawCryptoKeys(): Promise<unknown[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('silentsuite-data-cache')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  try {
    if (!db.objectStoreNames.contains('crypto')) return []
    return await new Promise<unknown[]>((resolve, reject) => {
      const tx = db.transaction('crypto', 'readonly')
      const req = tx.objectStore('crypto').getAll()
      req.onsuccess = () => resolve(req.result ?? [])
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

async function corruptRawItem(itemUid: string): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('silentsuite-data-cache')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('items', 'readwrite')
      const store = tx.objectStore('items')
      const getReq = store.get(itemUid)
      getReq.onsuccess = () => {
        const value = getReq.result as { ct?: number[] } | undefined
        if (value?.ct) {
          value.ct = [...value.ct]
          value.ct[0] = (value.ct[0] ?? 0) ^ 255
          store.put(value)
        }
      }
      getReq.onerror = () => reject(getReq.error)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

describe('data-cache', () => {
  describe('encryption guard', () => {
    it('reports cache capability without touching IndexedDB', () => {
      const previous = process.env.NEXT_PUBLIC_LOCAL_CACHE_ENABLED
      process.env.NEXT_PUBLIC_LOCAL_CACHE_ENABLED = 'true'
      const openSpy = vi.spyOn(indexedDB, 'open')

      expect(getCacheCapabilityStatus()).toEqual({
        featureFlagEnabled: true,
        encryptedEnvelopeAvailable: true,
        enabled: true,
      })
      expect(openSpy).not.toHaveBeenCalled()

      process.env.NEXT_PUBLIC_LOCAL_CACHE_ENABLED = previous
      openSpy.mockRestore()
    })

    it('does not enable cache when the env flag is true but encryption is unavailable', () => {
      const previous = process.env.NEXT_PUBLIC_LOCAL_CACHE_ENABLED
      process.env.NEXT_PUBLIC_LOCAL_CACHE_ENABLED = 'true'
      _setEncryptedCacheAvailableForTests(false)
      _setEnvelopeKeyForTests(null)

      expect(isCacheEnabled()).toBe(false)

      process.env.NEXT_PUBLIC_LOCAL_CACHE_ENABLED = previous
    })

    it('refuses plaintext item writes without an encrypted cache envelope', async () => {
      _setEncryptedCacheAvailableForTests(false)
      _setEnvelopeKeyForTests(null)

      await putItem(makeItem('plain-1', 'tasks', 'PRIVATE TASK SUMMARY'))
      await putItems([makeItem('plain-2', 'tasks', 'PRIVATE BULK TASK')])
      await replaceItemsForType('tasks', [makeItem('plain-3', 'tasks', 'PRIVATE REPLACE TYPE')])
      await replaceItemsForCollection('col-1', [makeItem('plain-4', 'tasks', 'PRIVATE REPLACE COLLECTION')])

      expect(await getItemsByType('tasks')).toEqual([])
      expect(await rawItems()).toEqual([])
    })

    it('stores item content encrypted at rest and round-trips through the public API', async () => {
      const sentinel = 'PRIVATE SENTINEL VEVENT SUMMARY 2026-07-09'

      await putItem(makeItem('encrypted-1', 'calendar', sentinel))

      const raw = await rawItems()
      expect(raw).toHaveLength(1)
      const serialized = JSON.stringify(raw[0])
      expect(serialized).toContain('"iv"')
      expect(serialized).toContain('"ct"')
      expect(serialized).not.toContain(sentinel)
      expect(serialized).not.toContain('content')

      const items = await getItemsByType('calendar')
      expect(items).toHaveLength(1)
      expect(items[0]!.content).toBe(sentinel)
    })

    it('skips a corrupt cached item without poisoning other cached items', async () => {
      await putItems([
        makeItem('good', 'tasks', 'PRIVATE GOOD TASK'),
        makeItem('bad', 'tasks', 'PRIVATE BAD TASK'),
      ])

      await corruptRawItem('bad')

      const items = await getItemsByType('tasks')
      expect(items.map((item) => item.itemUid)).toEqual(['good'])
      expect(items[0]!.content).toBe('PRIVATE GOOD TASK')
      expect(await rawItems()).toHaveLength(2)
    })
  })

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

    it('replaceItemsForCollection only drops items in that collection', async () => {
      await putItems([
        makeItem('a', 'tasks', 'old-a', 'col-a'),
        makeItem('b', 'tasks', 'old-b', 'col-b'),
      ])
      await replaceItemsForCollection('col-a', [makeItem('z', 'tasks', 'fresh', 'col-a')])

      const tasks = await getItemsByType('tasks')
      expect(tasks.map((item) => item.itemUid).sort()).toEqual(['b', 'z'])
      expect(tasks.find((item) => item.itemUid === 'b')!.collectionUid).toBe('col-b')
    })
  })

  describe('collections / stokens', () => {
    it('returns null for an unknown collection', async () => {
      expect(await getCollection('col-tasks')).toBeNull()
      expect(await getStoken('col-tasks')).toBeNull()
    })

    it('persists a collection record', async () => {
      await putCollection({
        collectionType: 'tasks',
        collectionUid: 'col-tasks',
        stoken: 'stk-1',
        lastFullSyncAt: 12345,
      })
      const col = await getCollection('col-tasks')
      expect(col).not.toBeNull()
      expect(col!.stoken).toBe('stk-1')
      expect(col!.collectionUid).toBe('col-tasks')
    })

    it('setStoken creates and updates the cursor', async () => {
      await setStoken('tasks', 'col-tasks', 'stk-a')
      expect(await getStoken('col-tasks')).toBe('stk-a')
      await setStoken('tasks', 'col-tasks', 'stk-b')
      expect(await getStoken('col-tasks')).toBe('stk-b')
    })

    it('stokens are keyed by collectionUid, not collectionType', async () => {
      await setStoken('tasks', 'col-a', 'stk-a')
      await setStoken('tasks', 'col-b', 'stk-b')
      expect(await getStoken('col-a')).toBe('stk-a')
      expect(await getStoken('col-b')).toBe('stk-b')
    })

    it('clearStoken nulls the stoken but preserves the row', async () => {
      await setStoken('tasks', 'col-tasks', 'stk-a')
      await clearStoken('col-tasks')
      expect(await getStoken('col-tasks')).toBeNull()
      const col = await getCollection('col-tasks')
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
      await putItem(makeItem('cached-task', 'tasks', 'PRIVATE TASK'))
      await ensureEncryptedEnvelope()
      await ensureFingerprint('alice@example.com')

      const ok = await ensureFingerprint('bob@example.com')
      expect(ok).toBe(false)

      // Cache should be wiped for the new account.
      expect(await getStoken('col-tasks')).toBeNull()
      expect(await getItemsByType('tasks')).toEqual([])
      expect(await rawCryptoKeys()).toEqual([])
      const meta = await getMeta()
      expect(meta?.accountFingerprint).toBe('bob@example.com')
      expect(meta?.lastInvalidatedAt).not.toBeNull()
    })

    it('ensureFingerprint accepts the same account on subsequent calls', async () => {
      await ensureFingerprint('alice@example.com')
      await setStoken('tasks', 'col-tasks', 'stk-a')

      const ok = await ensureFingerprint('alice@example.com')
      expect(ok).toBe(true)
      expect(await getStoken('col-tasks')).toBe('stk-a')
    })

    it('upgrades and clears the rolled-back v4 encrypted cache schema', async () => {
      await _resetForTests()
      const v4Db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('silentsuite-data-cache', 4)
        req.onupgradeneeded = () => {
          const db = req.result
          const items = db.createObjectStore('items', { keyPath: 'itemUid' })
          items.createIndex('byCollectionType', 'collectionType', { unique: false })
          items.createIndex('byCollectionUid', 'collectionUid', { unique: false })
          db.createObjectStore('collections', { keyPath: 'collectionUid' })
          db.createObjectStore('meta')
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      v4Db.close()
      await installTestEnvelope()

      await ensureFingerprint('alice@example.com')
      await _resetForTests()

      const upgradedDb = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('silentsuite-data-cache')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })

      expect(upgradedDb.version).toBe(5)
      expect(upgradedDb.objectStoreNames.contains('crypto')).toBe(true)
      expect(upgradedDb.objectStoreNames.contains('items')).toBe(true)
      upgradedDb.close()
    })

    it('uses cache schema version 5 for encrypted records', () => {
      expect(CACHE_SCHEMA_VERSION).toBe(5)
    })
  })

  describe('clearAll', () => {
    it('wipes items, collections, meta, and crypto', async () => {
      await putItem(makeItem('x', 'tasks'))
      await setStoken('tasks', 'col-tasks', 'stk')
      await ensureEncryptedEnvelope()
      await putMeta({
        accountFingerprint: 'a',
        cacheSchemaVersion: CACHE_SCHEMA_VERSION,
        lastInvalidatedAt: null,
      })

      await clearAll()

      expect(await getItemsByType('tasks')).toEqual([])
      expect(await getStoken('col-tasks')).toBeNull()
      expect(await getMeta()).toBeNull()
      expect(await rawCryptoKeys()).toEqual([])
    })

    it('is safe to call repeatedly', async () => {
      await clearAll()
      await clearAll()
      expect(await getItemsByType('tasks')).toEqual([])
    })
  })
})
