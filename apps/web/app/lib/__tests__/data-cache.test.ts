import { describe, it, expect, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import {
  getItemsByType,
  putItem,
  getMeta,
  putMeta,
  clearAll,
  ensureFingerprint,
  ensureEncryptedEnvelope,
  CACHE_SCHEMA_VERSION,
  _resetForTests,
  _setEncryptedCacheAvailableForTests,
  _setEnvelopeKeyForTests,
  type CachedItem,
} from '../data-cache'
import { AccountBoundaryChangedError, bumpAccountEpoch, getAccountEpoch } from '@/app/lib/account-epoch'

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

function openRawDb(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('silentsuite-data-cache')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Writes a sync-cursor row as a build with the removed instant-reload cache did. */
async function seedLeftoverStoken(collectionUid: string, stoken: string): Promise<void> {
  await getMeta() // opens and, on a fresh database, creates the v5 schema
  const db = await openRawDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('collections', 'readwrite')
      tx.objectStore('collections').put({ collectionType: 'tasks', collectionUid, stoken, lastFullSyncAt: 1 })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

async function rawCollections(): Promise<unknown[]> {
  const db = await openRawDb()
  try {
    return await new Promise<unknown[]>((resolve, reject) => {
      const tx = db.transaction('collections', 'readonly')
      const req = tx.objectStore('collections').getAll()
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
    it('refuses plaintext item writes without an encrypted cache envelope', async () => {
      _setEncryptedCacheAvailableForTests(false)
      _setEnvelopeKeyForTests(null)

      await putItem(makeItem('plain-1', 'tasks', 'PRIVATE TASK SUMMARY'))

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
      await putItem(makeItem('good', 'tasks', 'PRIVATE GOOD TASK'))
      await putItem(makeItem('bad', 'tasks', 'PRIVATE BAD TASK'))

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

    it('aborts a queued single-item put when the account epoch changes', async () => {
      await ensureFingerprint('current-account')
      const putEpoch = getAccountEpoch()
      const originalPut = IDBObjectStore.prototype.put
      const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (value, key) {
        const request = key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key)
        if ((value as { itemUid?: string }).itemUid === 'stale-put') bumpAccountEpoch()
        return request
      })
      await expect(putItem(makeItem('stale-put'), putEpoch)).rejects.toBeInstanceOf(AccountBoundaryChangedError)
      expect((await getItemsByType('tasks')).some((item) => item.itemUid === 'stale-put')).toBe(false)
      putSpy.mockRestore()
    })

    it('serializes an account fingerprint switch after a queued stale cache write', async () => {
      await ensureFingerprint('old-account')
      const accountEpoch = getAccountEpoch()
      const originalPut = IDBObjectStore.prototype.put
      let accountSwitch: Promise<boolean> | null = null
      const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (value, key) {
        const request = key === undefined
          ? originalPut.call(this, value)
          : originalPut.call(this, value, key)
        if (!accountSwitch && (value as { itemUid?: string }).itemUid === 'stale') {
          bumpAccountEpoch()
          accountSwitch = ensureFingerprint('new-account')
        }
        return request
      })

      await expect(putItem(makeItem('stale', 'tasks', 'old account cache', 'col-a'), accountEpoch))
        .rejects.toBeInstanceOf(AccountBoundaryChangedError)
      await accountSwitch!

      expect(await getItemsByType('tasks')).toEqual([])
      expect((await getMeta())?.accountFingerprint).toBe('new-account')
      putSpy.mockRestore()
    })
  })

  describe('sync cursors left by the removed instant-reload cache', () => {
    it('opens a database a cache-era build wrote without a schema upgrade and leaves queued payloads intact', async () => {
      const key = await makeTestKey()
      _setEnvelopeKeyForTests(key)
      await ensureFingerprint('alice@example.com')
      await putItem(makeItem('queued-payload', 'tasks', 'QUEUED OFFLINE EDIT'))
      await seedLeftoverStoken('col-tasks', 'stk-left-behind')
      await _resetForTests()
      _setEnvelopeKeyForTests(key)
      _setEncryptedCacheAvailableForTests(true)

      // A later session for the same account: the payload a queued update replays from survives.
      expect(await ensureFingerprint('alice@example.com')).toBe(true)
      expect((await getItemsByType('tasks')).map((item) => item.content)).toEqual(['QUEUED OFFLINE EDIT'])

      const db = await openRawDb()
      expect(db.version).toBe(5)
      expect(Array.from(db.objectStoreNames).sort()).toEqual(['collections', 'crypto', 'items', 'meta'])
      db.close()
      // Never read again; the row stays until logout or an account change empties the store.
      expect(await rawCollections()).toHaveLength(1)
    })

    it('empties leftover sync cursors on an account change', async () => {
      await ensureFingerprint('alice@example.com')
      await seedLeftoverStoken('col-tasks', 'stk-a')

      expect(await ensureFingerprint('bob@example.com')).toBe(false)

      expect(await rawCollections()).toEqual([])
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
      await seedLeftoverStoken('col-tasks', 'stk-a')
      await putItem(makeItem('cached-task', 'tasks', 'PRIVATE TASK'))
      await ensureEncryptedEnvelope()
      await ensureFingerprint('alice@example.com')

      const ok = await ensureFingerprint('bob@example.com')
      expect(ok).toBe(false)

      // Cache should be wiped for the new account.
      expect(await rawCollections()).toEqual([])
      expect(await getItemsByType('tasks')).toEqual([])
      expect(await rawCryptoKeys()).toEqual([])
      const meta = await getMeta()
      expect(meta?.accountFingerprint).toBe('bob@example.com')
      expect(meta?.lastInvalidatedAt).not.toBeNull()
    })

    it('ensureFingerprint accepts the same account on subsequent calls', async () => {
      await ensureFingerprint('alice@example.com')
      await putItem(makeItem('kept', 'tasks', 'PRIVATE KEPT'))

      const ok = await ensureFingerprint('alice@example.com')
      expect(ok).toBe(true)
      expect((await getItemsByType('tasks')).map((item) => item.itemUid)).toEqual(['kept'])
    })

    it('aborts a stale destructive fingerprint switch without touching the new account cache', async () => {
      await ensureFingerprint('account-b')
      await seedLeftoverStoken('b-collection', 'b-stoken')
      await putItem(makeItem('b-item', 'tasks', 'B PRIVATE', 'b-collection'))
      const cryptoKeys = await rawCryptoKeys()
      const accountEpoch = getAccountEpoch()
      const originalClear = IDBObjectStore.prototype.clear
      const clearSpy = vi.spyOn(IDBObjectStore.prototype, 'clear').mockImplementation(function (this: IDBObjectStore) {
        if (this.name === 'items') bumpAccountEpoch()
        return originalClear.call(this)
      })

      await expect(ensureFingerprint('account-a', accountEpoch)).rejects.toBeInstanceOf(AccountBoundaryChangedError)
      clearSpy.mockRestore()

      expect((await getMeta())?.accountFingerprint).toBe('account-b')
      expect(await rawCollections()).toHaveLength(1)
      expect((await getItemsByType('tasks')).map((item) => item.content)).toEqual(['B PRIVATE'])
      expect(await rawCryptoKeys()).toEqual(cryptoKeys)
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
      await seedLeftoverStoken('col-tasks', 'stk')
      await ensureEncryptedEnvelope()
      await putMeta({
        accountFingerprint: 'a',
        cacheSchemaVersion: CACHE_SCHEMA_VERSION,
        lastInvalidatedAt: null,
      })

      await clearAll()

      expect(await getItemsByType('tasks')).toEqual([])
      expect(await rawCollections()).toEqual([])
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
