// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import {
  CACHE_SCHEMA_VERSION,
  clearAll,
  ensureEncryptedEnvelope,
  ensureFingerprint,
  getItemsByType,
  getMeta,
  getStoken,
  putItem,
  putMeta,
  setStoken,
  _resetForTests,
  type CachedItem,
} from '../data-cache'
import { AccountBoundaryChangedError, bumpAccountEpoch, getAccountEpoch } from '@/app/lib/account-epoch'

const DB_NAME = 'silentsuite-data-cache'

const extraModules: Array<{ _resetForTests: () => Promise<void> }> = []

beforeEach(async () => {
  await Promise.all(extraModules.splice(0).map((mod) => mod._resetForTests().catch(() => undefined)))
  await _resetForTests()
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
})

function makeItem(uid: string, content: string): CachedItem {
  return {
    itemUid: uid,
    collectionType: 'tasks',
    collectionUid: 'col-744',
    content,
    lastModified: Date.now(),
  }
}

interface RawStoredItem {
  itemUid: string
  collectionType: 'tasks'
  collectionUid: string
  iv: number[]
  ct: number[]
  lastModified: number
}

function openCacheDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function rawCryptoKeys(): Promise<unknown[]> {
  const db = await openCacheDb()
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

async function rawItems(): Promise<RawStoredItem[]> {
  const db = await openCacheDb()
  try {
    if (!db.objectStoreNames.contains('items')) return []
    return await new Promise<RawStoredItem[]>((resolve, reject) => {
      const tx = db.transaction('items', 'readonly')
      const req = tx.objectStore('items').getAll()
      req.onsuccess = () => resolve((req.result ?? []) as RawStoredItem[])
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

async function restoreAcceptedCiphertext(record: RawStoredItem): Promise<void> {
  const db = await openCacheDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('items', 'readwrite')
      tx.objectStore('items').put(record)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

describe('#744 schema-only cache reset retains the crypto key', () => {
  it('keeps the persisted and in-memory key when only the schema version changes for the same fingerprint', async () => {
    const fingerprint = 'alice@example.com'
    const plaintext = '744 SCHEMA KEY ACCEPTED CIPHERTEXT'

    expect(await ensureFingerprint(fingerprint)).toBe(true)
    expect(await ensureEncryptedEnvelope()).toBe(true)
    await setStoken('tasks', 'col-744', 'stk-744')
    await putItem(makeItem('schema-item', plaintext))

    const acceptedItems = await rawItems()
    expect(acceptedItems).toHaveLength(1)
    const accepted = acceptedItems[0]!
    expect(JSON.stringify(accepted)).not.toContain(plaintext)
    expect(accepted.iv.length).toBeGreaterThan(0)
    expect(accepted.ct.length).toBeGreaterThan(0)
    expect(await rawCryptoKeys()).toHaveLength(1)
    expect(await getStoken('col-744')).toBe('stk-744')

    await putMeta({
      accountFingerprint: fingerprint,
      cacheSchemaVersion: CACHE_SCHEMA_VERSION - 1,
      lastInvalidatedAt: null,
    })
    const stale = await getMeta()
    expect(stale?.accountFingerprint).toBe(fingerprint)
    expect(stale?.cacheSchemaVersion).toBe(CACHE_SCHEMA_VERSION - 1)

    // 744 schema-only boundary
    const survived = await ensureFingerprint(fingerprint)

    expect(await rawCryptoKeys()).toHaveLength(1)
    expect(survived).toBe(false)
    expect(await rawItems()).toEqual([])
    expect(await getStoken('col-744')).toBeNull()
    const meta = await getMeta()
    expect(meta?.accountFingerprint).toBe(fingerprint)
    expect(meta?.cacheSchemaVersion).toBe(CACHE_SCHEMA_VERSION)
    expect(meta?.lastInvalidatedAt).not.toBeNull()

    await restoreAcceptedCiphertext(accepted)
    const opened = await getItemsByType('tasks')
    expect(opened.map((item) => item.content)).toEqual([plaintext])

    const persisted = await rawCryptoKeys()
    expect(persisted[0]).toBeInstanceOf(CryptoKey)
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: Uint8Array.from(accepted.iv) },
      persisted[0] as CryptoKey,
      Uint8Array.from(accepted.ct),
    )
    expect(new TextDecoder().decode(decrypted)).toBe(plaintext)
  })

  it('still erases the crypto key when the fingerprint changes', async () => {
    const plaintext = '744 OTHER FINGERPRINT CIPHERTEXT'
    expect(await ensureFingerprint('alice@example.com')).toBe(true)
    expect(await ensureEncryptedEnvelope()).toBe(true)
    await putItem(makeItem('other-fp', plaintext))
    const accepted = (await rawItems())[0]!
    expect(await rawCryptoKeys()).toHaveLength(1)

    const survived = await ensureFingerprint('bob@example.com')

    expect(survived).toBe(false)
    expect(await rawCryptoKeys()).toEqual([])
    expect((await getMeta())?.accountFingerprint).toBe('bob@example.com')
    await restoreAcceptedCiphertext(accepted)
    expect(await getItemsByType('tasks')).toEqual([])
  })

  it('still erases the crypto key on explicit clearAll', async () => {
    const plaintext = '744 CLEAR ALL CIPHERTEXT'
    expect(await ensureFingerprint('alice@example.com')).toBe(true)
    expect(await ensureEncryptedEnvelope()).toBe(true)
    await putItem(makeItem('clear-all', plaintext))
    const accepted = (await rawItems())[0]!
    expect(await rawCryptoKeys()).toHaveLength(1)

    await clearAll()

    expect(await rawCryptoKeys()).toEqual([])
    expect(await getMeta()).toBeNull()
    await restoreAcceptedCiphertext(accepted)
    expect(await getItemsByType('tasks')).toEqual([])
  })
})

describe('#744 K1 stored-key read error is not key absence', () => {
  it('fails closed and keeps the persisted key when the crypto-store read throws', async () => {
    const plaintext = '744 K1 ACCEPTED CIPHERTEXT'
    expect(await ensureFingerprint('alice@example.com')).toBe(true)
    const epoch = getAccountEpoch()
    expect(await ensureEncryptedEnvelope(epoch)).toBe(true)
    await putItem(makeItem('k1-item', plaintext))
    const accepted = (await rawItems())[0]!
    expect(JSON.stringify(accepted)).not.toContain(plaintext)
    expect(await rawCryptoKeys()).toHaveLength(1)
    expect((await getItemsByType('tasks')).map((item) => item.content)).toEqual([plaintext])

    await _resetForTests()

    const originalGet = IDBObjectStore.prototype.get
    let readFaults = 0
    const getSpy = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, query) {
      if (this.name === 'crypto') {
        readFaults += 1
        throw new DOMException('IndexedDB crypto key read failed', 'UnknownError')
      }
      return originalGet.call(this, query)
    })
    let ready = true
    try {
      // 744 key-read error boundary
      ready = await ensureEncryptedEnvelope(epoch)
    } finally {
      getSpy.mockRestore()
    }

    expect(readFaults).toBeGreaterThan(0)
    expect(ready).toBe(false)
    const persistedAfterFault = await rawCryptoKeys()
    expect(persistedAfterFault).toHaveLength(1)
    let reopened: string | null = null
    if (persistedAfterFault[0] instanceof CryptoKey) {
      try {
        reopened = new TextDecoder().decode(await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: Uint8Array.from(accepted.iv) },
          persistedAfterFault[0],
          Uint8Array.from(accepted.ct),
        ))
      } catch {
        reopened = null
      }
    }
    expect(reopened).toBe(plaintext)

    expect(await ensureEncryptedEnvelope(epoch)).toBe(true)
    expect((await getItemsByType('tasks')).map((item) => item.content)).toEqual([plaintext])
  })

  it('creates one valid key when the stored envelope key is absent', async () => {
    const plaintext = '744 K1 ABSENT KEY CIPHERTEXT'
    expect(await ensureFingerprint('alice@example.com')).toBe(true)
    const epoch = getAccountEpoch()
    expect(await rawCryptoKeys()).toEqual([])

    expect(await ensureEncryptedEnvelope(epoch)).toBe(true)

    expect(await rawCryptoKeys()).toHaveLength(1)
    await putItem(makeItem('k1-absent', plaintext))
    await _resetForTests()
    expect(await ensureEncryptedEnvelope(epoch)).toBe(true)
    expect(await rawCryptoKeys()).toHaveLength(1)
    expect((await getItemsByType('tasks')).map((item) => item.content)).toEqual([plaintext])
  })
})

describe('#744 K2 concurrent envelope create adopts the persisted winner', () => {
  function installGenerateBarrier() {
    const originalGenerate = crypto.subtle.generateKey.bind(crypto.subtle)
    let entered = 0
    let releaseGenerate = () => {}
    const generateGate = new Promise<void>((resolve) => {
      releaseGenerate = resolve
    })
    let markBothEntered = () => {}
    const bothEntered = new Promise<void>((resolve) => {
      markBothEntered = resolve
    })
    const generateSpy = vi.spyOn(crypto.subtle, 'generateKey').mockImplementation((algorithm, extractable, keyUsages) => {
      entered += 1
      if (entered >= 2) markBothEntered()
      return generateGate.then(() => originalGenerate(algorithm, extractable, keyUsages))
    })
    return {
      bothEntered,
      entered: () => entered,
      release: releaseGenerate,
      restore: () => generateSpy.mockRestore(),
    }
  }

  it('adopts one persisted key when two unguarded creates overlap in real generateKey', async () => {
    const plainA = '744 K2 RACE A'
    const plainB = '744 K2 RACE B'
    const a = await import('../data-cache?k2=race-a')
    const b = await import('../data-cache?k2=race-b')
    extraModules.push(a, b)
    expect(a.ensureEncryptedEnvelope).not.toBe(b.ensureEncryptedEnvelope)
    expect(await rawCryptoKeys()).toEqual([])

    const barrier = installGenerateBarrier()
    const pendingA = a.ensureEncryptedEnvelope()
    const pendingB = b.ensureEncryptedEnvelope()
    let readyA = false
    let readyB = false
    try {
      const arrived = await Promise.race([
        barrier.bothEntered.then(() => 'both' as const),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1000)),
      ])
      barrier.release()
      ;[readyA, readyB] = await Promise.all([pendingA, pendingB])
      expect(arrived).toBe('both')
    } finally {
      barrier.release()
      barrier.restore()
    }

    expect(barrier.entered()).toBe(2)
    expect(readyA).toBe(true)
    expect(readyB).toBe(true)
    await a.putItem(makeItem('race-a', plainA))
    await b.putItem(makeItem('race-b', plainB))
    // 744 concurrent key-adopt boundary
    expect((await a.getItemsByType('tasks')).map((item) => item.content).sort()).toEqual([plainA, plainB].sort())
    expect((await b.getItemsByType('tasks')).map((item) => item.content).sort()).toEqual([plainA, plainB].sort())
    expect(await rawCryptoKeys()).toHaveLength(1)
  })

  it('adopts one persisted key when two guarded creates overlap in real generateKey', async () => {
    const plainA = '744 K2 GUARD A'
    const plainB = '744 K2 GUARD B'
    const a = await import('../data-cache?k2=guard-a')
    const b = await import('../data-cache?k2=guard-b')
    extraModules.push(a, b)
    expect(a.ensureEncryptedEnvelope).not.toBe(b.ensureEncryptedEnvelope)
    expect(await a.ensureFingerprint('alice@example.com')).toBe(true)
    const epoch = getAccountEpoch()
    expect(await rawCryptoKeys()).toEqual([])

    const barrier = installGenerateBarrier()
    const pendingA = a.ensureEncryptedEnvelope(epoch)
    const pendingB = b.ensureEncryptedEnvelope(epoch)
    let readyA = false
    let readyB = false
    try {
      const arrived = await Promise.race([
        barrier.bothEntered.then(() => 'both' as const),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1000)),
      ])
      barrier.release()
      ;[readyA, readyB] = await Promise.all([pendingA, pendingB])
      expect(arrived).toBe('both')
    } finally {
      barrier.release()
      barrier.restore()
    }

    expect(barrier.entered()).toBe(2)
    expect(readyA).toBe(true)
    expect(readyB).toBe(true)
    await a.putItem(makeItem('guard-a', plainA))
    await b.putItem(makeItem('guard-b', plainB))
    // 744 guarded key-adopt boundary
    expect((await a.getItemsByType('tasks')).map((item) => item.content).sort()).toEqual([plainA, plainB].sort())
    expect(await rawCryptoKeys()).toHaveLength(1)
  })

  it('creates one key, adopts an existing key, and reloads two cache writes', async () => {
    const first = '744 K2 FRESH WRITE'
    const second = '744 K2 SECOND WRITE'
    expect(await rawCryptoKeys()).toEqual([])
    expect(await ensureEncryptedEnvelope()).toBe(true)
    expect(await rawCryptoKeys()).toHaveLength(1)
    await putItem(makeItem('fresh-1', first))
    await putItem(makeItem('fresh-2', second))
    await _resetForTests()
    expect(await ensureEncryptedEnvelope()).toBe(true)
    expect(await rawCryptoKeys()).toHaveLength(1)
    expect((await getItemsByType('tasks')).map((item) => item.content).sort()).toEqual([first, second].sort())
  })

  it('writes nothing new when the account epoch changes before the envelope put commits', async () => {
    expect(await ensureFingerprint('alice@example.com')).toBe(true)
    const epoch = getAccountEpoch()
    expect(await rawCryptoKeys()).toEqual([])
    const originalPut = IDBObjectStore.prototype.put
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key)
      if (this.name === 'crypto' && key === 'envelope-key') bumpAccountEpoch()
      return request
    })
    try {
      await expect(ensureEncryptedEnvelope(epoch)).rejects.toBeInstanceOf(AccountBoundaryChangedError)
    } finally {
      putSpy.mockRestore()
    }
    expect(await rawCryptoKeys()).toEqual([])
  })
})
