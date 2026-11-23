// The durable Etebase session copy is AES-GCM ciphertext under a non-extractable
// WebCrypto key, on fake-indexeddb with the real secure-storage module. All data
// is synthetic.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { secureClear, secureGet, secureRemove, secureRemoveIfEqual, secureSet } from '../secure-storage'
import { TAB_SESSION_KEY, getSessionScope, setSessionScope } from '../session-scope'
import { LOGOUT_GENERATION_KEY } from '../account-epoch'

const KEY = 'etebase_session'
const OWNER_KEY = 'etebase_session_owner'
const WRAP_KEY = 'etebase_session_key'
const SESSION = 'SYNTHETIC-SAVED-SESSION-0123456789'

function rawStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('silentsuite-secure', 1)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction('keyval', mode)
      const req = fn(tx.objectStore('keyval'))
      tx.oncomplete = () => { db.close(); resolve(req ? req.result : undefined) }
      tx.onerror = () => { db.close(); reject(tx.error) }
    }
    open.onerror = () => reject(open.error)
  })
}

const rawGet = (key: string) => rawStore<unknown>('readonly', (s) => s.get(key))
const rawPut = (key: string, value: unknown) => rawStore('readwrite', (s) => { s.put(value, key) })
const rawDelete = (key: string) => rawStore('readwrite', (s) => { s.delete(key) })

const typeTag = (value: unknown) => Object.prototype.toString.call(value)

/** Holds the next encrypt call until released. */
function pauseNextEncrypt() {
  const original = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let started!: () => void
  const entered = new Promise<void>((resolve) => { started = resolve })
  vi.spyOn(globalThis.crypto.subtle, 'encrypt').mockImplementationOnce(async (...args) => {
    started()
    await gate
    return original(...args)
  })
  return { release, entered }
}

beforeEach(async () => {
  await secureClear()
  localStorage.clear()
  sessionStorage.clear()
  setSessionScope(null)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('wrapped durable session', () => {
  it('stores no plaintext and a non-extractable key, with a fresh IV per write', async () => {
    await secureSet(KEY, SESSION, { persist: true, owner: 'user-1' })
    const first = await rawGet(KEY) as { iv: Uint8Array }
    expect(typeof first).not.toBe('string')
    expect(JSON.stringify(first)).not.toContain('SYNTHETIC')
    expect(new TextDecoder().decode((first as unknown as { ct: ArrayBuffer }).ct)).not.toContain('SYNTHETIC')
    const key = await rawGet(WRAP_KEY) as CryptoKey
    expect(typeTag(key)).toBe('[object CryptoKey]')
    expect(key.extractable).toBe(false)
    expect(await rawGet(OWNER_KEY)).toBe('user-1')
    expect(await secureGet(KEY)).toBe(SESSION)

    await secureSet(KEY, SESSION, { persist: true, owner: 'user-1' })
    const second = await rawGet(KEY) as { iv: Uint8Array }
    expect(Array.from(second.iv)).not.toEqual(Array.from(first.iv))
    expect(await secureGet(KEY)).toBe(SESSION)
  })

  it('a logout issued during a pending save always ends with nothing stored', async () => {
    const { release, entered } = pauseNextEncrypt()
    const save = secureSet(KEY, SESSION, { persist: true, owner: 'user-1' })
    await entered
    const clear = secureClear()
    release()
    await Promise.all([save, clear])
    expect(await rawGet(KEY)).toBeUndefined()
    expect(await rawGet(OWNER_KEY)).toBeUndefined()
    expect(await rawGet(WRAP_KEY)).toBeUndefined()
    expect(await secureGet(KEY, { storedOnly: true })).toBeNull()
    expect(await secureGet(KEY)).toBeNull()
    expect(getSessionScope()).toBeNull()
  })

  it('a clear issued during a pending save that then fails leaves no tab copy either', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let started!: () => void
    const entered = new Promise<void>((resolve) => { started = resolve })
    vi.spyOn(globalThis.crypto.subtle, 'encrypt').mockImplementationOnce(async () => {
      started()
      await gate
      throw new Error('synthetic encrypt failure')
    })
    const save = secureSet(KEY, SESSION, { persist: true, owner: 'user-1' })
    await entered
    const clear = secureClear()
    release()
    await Promise.all([save, clear])
    expect(getSessionScope()).toBeNull()
    expect(sessionStorage.getItem(TAB_SESSION_KEY)).toBeNull()
    expect(await secureGet(KEY)).toBeNull()
  })

  it('a session removal issued during a pending save wins', async () => {
    const { release, entered } = pauseNextEncrypt()
    const save = secureSet(KEY, SESSION, { persist: true, owner: 'user-1' })
    await entered
    const removal = secureRemove(KEY)
    release()
    await Promise.all([save, removal])
    expect(getSessionScope()).toBeNull()
    expect(await rawGet(KEY)).toBeUndefined()
  })

  it('a later save always wins over a pending earlier one', async () => {
    const { release, entered } = pauseNextEncrypt()
    const earlier = secureSet(KEY, 'SYNTHETIC-EARLIER', { persist: true, owner: 'user-1' })
    await entered
    const later = secureSet(KEY, 'SYNTHETIC-LATER', { persist: true, owner: 'user-2' })
    release()
    await Promise.all([earlier, later])
    expect(await rawGet(OWNER_KEY)).toBe('user-2')
    expect(getSessionScope()).toBe('device')
    expect(await secureGet(KEY)).toBe('SYNTHETIC-LATER')
  })

  it('an earlier save completing never makes a later save in the same tab discard itself', async () => {
    await secureSet(KEY, 'SYNTHETIC-TAB', { persist: false, owner: 'user-1' })
    const earlier = secureSet(KEY, 'SYNTHETIC-EARLIER', { persist: true, owner: 'user-1' })
    const later = secureSet(KEY, 'SYNTHETIC-LATER', { persist: true, owner: 'user-1' })
    await Promise.all([earlier, later])
    expect(getSessionScope()).toBe('device')
    expect(sessionStorage.getItem(TAB_SESSION_KEY)).toBeNull()
    expect(await secureGet(KEY)).toBe('SYNTHETIC-LATER')
  })

  it('an earlier save falling back to the tab never overrides a later successful save', async () => {
    await secureSet(KEY, 'SYNTHETIC-TAB', { persist: false, owner: 'user-1' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(globalThis.crypto.subtle, 'encrypt').mockRejectedValueOnce(new Error('synthetic encrypt failure'))
    const earlier = secureSet(KEY, 'SYNTHETIC-EARLIER', { persist: true, owner: 'user-1' })
    const later = secureSet(KEY, 'SYNTHETIC-LATER', { persist: true, owner: 'user-1' })
    await Promise.all([earlier, later])
    expect(getSessionScope()).toBe('device')
    expect(sessionStorage.getItem(TAB_SESSION_KEY)).toBeNull()
    expect(await secureGet(KEY)).toBe('SYNTHETIC-LATER')
  })

  it('a save that started before a logout elsewhere never overwrites the sign-in that followed it', async () => {
    localStorage.setItem(LOGOUT_GENERATION_KEY, 'generation-1')
    const encrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle)
    const { release, entered } = pauseNextEncrypt()
    const save = secureSet(KEY, SESSION, { persist: true, owner: 'user-1' })
    await entered
    // Another tab logs out, then signs in and saves its own wrapped session.
    localStorage.setItem(LOGOUT_GENERATION_KEY, 'generation-2')
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)))
    const ct = await encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('SYNTHETIC-SUCCESSOR'))
    await rawStore('readwrite', (s) => { s.put({ v: 1, iv, ct }, KEY); s.put(key, WRAP_KEY); s.put('user-2', OWNER_KEY) })
    release()
    await save
    expect(getSessionScope()).not.toBe('device')
    expect(await rawGet(OWNER_KEY)).toBe('user-2')
    expect(await secureGet(KEY, { storedOnly: true })).toBe('SYNTHETIC-SUCCESSOR')
  })

  it('a key that cannot be stored commits nothing: the previous copy still restores', async () => {
    await secureSet(KEY, 'SYNTHETIC-PREVIOUS', { persist: true, owner: 'user-1' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const original = IDBObjectStore.prototype.put
    let failDelete = true
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      if (args[1] === WRAP_KEY) throw new DOMException('synthetic clone failure', 'DataCloneError')
      return original.apply(this, args)
    })
    // Keep the fallback cleanup from hiding a partial commit.
    const originalDelete = IDBObjectStore.prototype.delete
    vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['delete']>) {
      if (failDelete) throw new DOMException('synthetic', 'InvalidStateError')
      return originalDelete.apply(this, args)
    })
    await secureSet(KEY, 'SYNTHETIC-NEW', { persist: true, owner: 'user-2' })
    failDelete = false
    vi.mocked(IDBObjectStore.prototype.put).mockRestore()
    vi.mocked(IDBObjectStore.prototype.delete).mockRestore()
    expect(await rawGet(OWNER_KEY)).toBe('user-1')
    expect(await secureGet(KEY, { storedOnly: true })).toBe('SYNTHETIC-PREVIOUS')
    // The new session still works in this tab only.
    expect(getSessionScope()).toBe('tab')
    expect(await secureGet(KEY)).toBe('SYNTHETIC-NEW')
  })

  it('without WebCrypto the session works in this tab only and the previous copy is removed', async () => {
    await secureSet(KEY, 'SYNTHETIC-OTHER-ACCOUNT', { persist: true })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(globalThis.crypto.subtle, 'generateKey').mockRejectedValue(new Error('synthetic: no WebCrypto'))
    await secureSet(KEY, SESSION, { persist: true })
    expect(await rawGet(KEY)).toBeUndefined()
    expect(await rawGet(WRAP_KEY)).toBeUndefined()
    expect(getSessionScope()).toBe('tab')
    expect(await secureGet(KEY)).toBe(SESSION)
    expect(sessionStorage.getItem(TAB_SESSION_KEY)).toContain(SESSION)
    // A reload that reads the device copy finds nothing, never the other account.
    setSessionScope('device')
    expect(await secureGet(KEY)).toBeNull()
  })

  it('a failed save never removes a save another tab made meanwhile', async () => {
    await secureSet(KEY, 'SYNTHETIC-REPLACED', { persist: true, owner: 'user-1' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const original = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let started!: () => void
    const entered = new Promise<void>((resolve) => { started = resolve })
    vi.spyOn(globalThis.crypto.subtle, 'encrypt').mockImplementationOnce(async () => {
      started()
      await gate
      throw new Error('synthetic encrypt failure')
    })
    const failing = secureSet(KEY, 'SYNTHETIC-FAILING', { persist: true, owner: 'user-1' })
    await entered
    // Another tab's save: a separate connection, written straight to IndexedDB.
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)))
    const ct = await original({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('SYNTHETIC-OTHER-TAB'))
    await rawStore('readwrite', (s) => { s.put({ v: 1, iv, ct }, KEY); s.put(key, WRAP_KEY); s.put('user-2', OWNER_KEY) })
    release()
    await failing
    expect(await rawGet(OWNER_KEY)).toBe('user-2')
    expect(await secureGet(KEY, { storedOnly: true })).toBe('SYNTHETIC-OTHER-TAB')
  })

  it('without WebCrypto on a clean profile nothing durable is written', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(globalThis.crypto.subtle, 'encrypt').mockRejectedValue(new Error('synthetic encrypt failure'))
    await secureSet(KEY, SESSION, { persist: true, owner: 'user-1' })
    expect(await rawGet(KEY)).toBeUndefined()
    expect(await secureGet(KEY)).toBe(SESSION)
    expect(getSessionScope()).toBe('tab')
  })
})

describe('unusable stored copies', () => {
  beforeEach(async () => {
    await secureSet(KEY, SESSION, { persist: true, owner: 'user-1' })
  })

  it('a missing key reads as no session and leaves the entry; a new save works', async () => {
    await rawDelete(WRAP_KEY)
    expect(await secureGet(KEY)).toBeNull()
    expect(await secureGet(KEY, { storedOnly: true })).toBeNull()
    expect(await rawGet(KEY)).toBeDefined()
    await secureSet(KEY, 'SYNTHETIC-FRESH', { persist: true, owner: 'user-1' })
    expect(await secureGet(KEY)).toBe('SYNTHETIC-FRESH')
  })

  it('another key, damaged ciphertext or a malformed record never fall back to anything', async () => {
    const otherKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const record = await rawGet(KEY) as { v: 1; iv: Uint8Array; ct: ArrayBuffer }
    await rawPut(WRAP_KEY, otherKey)
    expect(await secureGet(KEY)).toBeNull()

    await secureSet(KEY, SESSION, { persist: true, owner: 'user-1' })
    const fresh = await rawGet(KEY) as { v: 1; iv: Uint8Array; ct: ArrayBuffer }
    const damaged = new Uint8Array(fresh.ct.slice(0))
    damaged[0] ^= 0xff
    await rawPut(KEY, { ...fresh, ct: damaged.buffer })
    expect(await secureGet(KEY)).toBeNull()

    await rawPut(KEY, { v: 1, ct: record.ct })
    expect(await secureGet(KEY)).toBeNull()
    expect(await rawGet(KEY)).toBeDefined()
  })

  it('a failed decrypt is not treated as proof: the next read still restores', async () => {
    vi.spyOn(globalThis.crypto.subtle, 'decrypt').mockRejectedValueOnce(new DOMException('synthetic', 'OperationError'))
    expect(await secureGet(KEY)).toBeNull()
    expect(await secureGet(KEY)).toBe(SESSION)
  })
})

describe('plain copies from older versions', () => {
  beforeEach(async () => {
    await rawPut(KEY, 'SYNTHETIC-LEGACY')
    await rawPut(OWNER_KEY, 'user-1')
  })

  it('a device read for the owner returns it and wraps it in place', async () => {
    setSessionScope('device', 'user-1')
    expect(await secureGet(KEY)).toBe('SYNTHETIC-LEGACY')
    const stored = await rawGet(KEY)
    expect(typeof stored).not.toBe('string')
    expect(await rawGet(OWNER_KEY)).toBe('user-1')
    expect(await secureGet(KEY)).toBe('SYNTHETIC-LEGACY')
  })

  it('is refused and left alone for another owner', async () => {
    setSessionScope('device', 'user-2')
    expect(await secureGet(KEY)).toBeNull()
    expect(await rawGet(KEY)).toBe('SYNTHETIC-LEGACY')
  })

  it('a stored-only read reports it without rewriting it', async () => {
    expect(await secureGet(KEY, { storedOnly: true })).toBe('SYNTHETIC-LEGACY')
    expect(await rawGet(KEY)).toBe('SYNTHETIC-LEGACY')
    await secureRemoveIfEqual(KEY, 'SYNTHETIC-LEGACY', { storedOnly: true })
    expect(await rawGet(KEY)).toBeUndefined()
    expect(await rawGet(OWNER_KEY)).toBeUndefined()
  })

  it('a newer save that lands during the rewrap is kept', async () => {
    setSessionScope('device', 'user-1')
    const { release, entered } = pauseNextEncrypt()
    const read = secureGet(KEY)
    await entered
    await rawPut(KEY, 'SYNTHETIC-NEWER-PLAIN')
    release()
    expect(await read).toBe('SYNTHETIC-LEGACY')
    expect(await rawGet(KEY)).toBe('SYNTHETIC-NEWER-PLAIN')
  })
})

describe('removal', () => {
  it('compare-and-remove takes record, owner and key, but never a newer save', async () => {
    await secureSet(KEY, SESSION, { persist: true, owner: 'user-1' })
    await secureRemoveIfEqual(KEY, 'SYNTHETIC-OTHER', { storedOnly: true })
    expect(await secureGet(KEY, { storedOnly: true })).toBe(SESSION)
    await secureRemoveIfEqual(KEY, SESSION, { storedOnly: true })
    expect(await rawGet(KEY)).toBeUndefined()
    expect(await rawGet(OWNER_KEY)).toBeUndefined()
    expect(await rawGet(WRAP_KEY)).toBeUndefined()

    await secureSet(KEY, SESSION, { persist: true, owner: 'user-1' })
    const removal = secureRemoveIfEqual(KEY, SESSION, { storedOnly: true })
    const newer = secureSet(KEY, SESSION, { persist: true, owner: 'user-1' })
    await Promise.all([removal, newer])
    expect(await secureGet(KEY, { storedOnly: true })).toBe(SESSION)
  })

  it('secureRemove and secureClear remove the key too', async () => {
    await secureSet(KEY, SESSION, { persist: true, owner: 'user-1' })
    await secureRemove(KEY)
    expect(await rawGet(KEY)).toBeUndefined()
    expect(await rawGet(WRAP_KEY)).toBeUndefined()
    expect(await rawGet(OWNER_KEY)).toBeUndefined()

    await secureSet(KEY, SESSION, { persist: true, owner: 'user-1' })
    await secureClear()
    expect(await rawGet(KEY)).toBeUndefined()
    expect(await rawGet(WRAP_KEY)).toBeUndefined()
  })
})
