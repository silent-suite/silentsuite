import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrateFromLocalStorage, secureClear, secureGet, secureRemoveIfEqual, secureSet } from '../secure-storage'
import {
  NAME_STORE_KEYS,
  TAB_SESSION_KEY,
  getSessionScope,
  setSessionScope,
  tabScopedStateStorage,
} from '../session-scope'
import { LOGOUT_GENERATION_KEY } from '../account-epoch'

const KEY = 'etebase_session'

async function storedCopy() {
  return secureGet(KEY, { storedOnly: true })
}

describe('Etebase session storage scope', () => {
  beforeEach(async () => {
    await secureClear()
    localStorage.clear()
    sessionStorage.clear()
    setSessionScope(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps a session that is not persisted out of IndexedDB entirely', async () => {
    const put = vi.spyOn(IDBObjectStore.prototype, 'put')
    await secureSet(KEY, 'tab-session', { persist: false })
    expect(put).not.toHaveBeenCalled()
    expect(await storedCopy()).toBeNull()
    expect(getSessionScope()).toBe('tab')
    expect(await secureGet(KEY)).toBe('tab-session')
    expect(sessionStorage.getItem(TAB_SESSION_KEY)).toContain('tab-session')
  })

  it('treats an omitted persist flag as tab-only', async () => {
    const put = vi.spyOn(IDBObjectStore.prototype, 'put')
    await secureSet(KEY, 'tab-session')
    expect(put).not.toHaveBeenCalled()
    expect(getSessionScope()).toBe('tab')
  })

  it('deletes an existing IndexedDB copy when a session is saved tab-only', async () => {
    await secureSet(KEY, 'old-remembered', { persist: true })
    expect(await storedCopy()).toBe('old-remembered')
    await secureSet(KEY, 'new-tab-only', { persist: false })
    expect(await storedCopy()).toBeNull()
    expect(await secureGet(KEY)).toBe('new-tab-only')
  })

  it('stores a persisted session in IndexedDB and drops the tab copy after the write commits', async () => {
    await secureSet(KEY, 'tab-session', { persist: false })
    await secureSet(KEY, 'device-session', { persist: true })
    expect(sessionStorage.getItem(TAB_SESSION_KEY)).toBeNull()
    expect(getSessionScope()).toBe('device')
    expect(await secureGet(KEY)).toBe('device-session')
  })

  it('never reads IndexedDB unless the tab scope is device', async () => {
    await secureSet(KEY, 'device-session', { persist: true })
    setSessionScope(null)
    expect(await secureGet(KEY)).toBeNull()
    setSessionScope('tab')
    expect(await secureGet(KEY)).toBeNull()
    setSessionScope('device')
    expect(await secureGet(KEY)).toBe('device-session')
  })

  it('voids the tab copy after any logout since it was written, with its names', async () => {
    localStorage.setItem(LOGOUT_GENERATION_KEY, 'generation-1')
    await secureSet(KEY, 'tab-session', { persist: false })
    sessionStorage.setItem(NAME_STORE_KEYS[0], '{"state":{}}')
    localStorage.setItem(LOGOUT_GENERATION_KEY, 'generation-2')
    expect(await secureGet(KEY)).toBeNull()
    expect(sessionStorage.getItem(TAB_SESSION_KEY)).toBeNull()
    expect(sessionStorage.getItem(NAME_STORE_KEYS[0])).toBeNull()
  })

  it('rejects an unreadable tab copy', async () => {
    sessionStorage.setItem(TAB_SESSION_KEY, 'not-json')
    expect(await secureGet(KEY)).toBeNull()
    expect(sessionStorage.getItem(TAB_SESSION_KEY)).toBeNull()
  })

  it('does not fall back to IndexedDB when the tab write fails', async () => {
    await secureSet(KEY, 'old-remembered', { persist: true })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await secureSet(KEY, 'new-tab-only', { persist: false })
    vi.mocked(Storage.prototype.setItem).mockRestore()
    expect(getSessionScope()).toBe('tab')
    expect(await secureGet(KEY)).toBeNull()
    expect(await storedCopy()).toBeNull()
  })

  it('removes only the stored copy it was asked to, keeping a newer value', async () => {
    await secureSet(KEY, 'newer-remembered', { persist: true })
    await secureRemoveIfEqual(KEY, 'stale-copy', { storedOnly: true })
    expect(await storedCopy()).toBe('newer-remembered')
    await secureRemoveIfEqual(KEY, 'newer-remembered', { storedOnly: true })
    expect(await storedCopy()).toBeNull()
  })

  it('leaves the tab copy alone for a stored-only removal', async () => {
    await secureSet(KEY, 'same-value', { persist: false })
    await secureRemoveIfEqual(KEY, 'same-value', { storedOnly: true })
    expect(await secureGet(KEY)).toBe('same-value')
  })

  it('clears the tab copy and the scope on secureClear', async () => {
    await secureSet(KEY, 'tab-session', { persist: false })
    await secureClear()
    expect(sessionStorage.getItem(TAB_SESSION_KEY)).toBeNull()
    expect(getSessionScope()).toBeNull()
  })

  it('discards a legacy localStorage session instead of persisting it', async () => {
    const put = vi.spyOn(IDBObjectStore.prototype, 'put')
    localStorage.setItem(KEY, 'legacy-session')
    await migrateFromLocalStorage()
    expect(put).not.toHaveBeenCalled()
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(await storedCopy()).toBeNull()
  })
})

describe('decrypted names follow the session scope', () => {
  const NAME = NAME_STORE_KEYS[3]

  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    setSessionScope(null)
  })

  it('stays in tab storage while the scope is undecided or tab', () => {
    tabScopedStateStorage.setItem(NAME, 'undecided')
    expect(sessionStorage.getItem(NAME)).toBe('undecided')
    expect(localStorage.getItem(NAME)).toBeNull()
    setSessionScope('tab')
    localStorage.setItem(NAME, 'legacy')
    tabScopedStateStorage.setItem(NAME, 'tab')
    expect(sessionStorage.getItem(NAME)).toBe('tab')
    expect(localStorage.getItem(NAME)).toBeNull()
    expect(tabScopedStateStorage.getItem(NAME)).toBe('tab')
  })

  it('uses localStorage only for a device scope', () => {
    setSessionScope('device')
    sessionStorage.setItem(NAME, 'old-tab')
    tabScopedStateStorage.setItem(NAME, 'device')
    expect(localStorage.getItem(NAME)).toBe('device')
    expect(sessionStorage.getItem(NAME)).toBeNull()
  })

  it('removes legacy names from localStorage when a session is saved tab-only', async () => {
    localStorage.setItem(NAME, 'legacy')
    await secureSet(KEY, 'tab-session', { persist: false })
    expect(localStorage.getItem(NAME)).toBeNull()
  })
})
