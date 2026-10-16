// An explicit logout in another tab, seen from an already-open signed-in tab.
// The real AuthProvider, auth store, Etebase store, account epoch, secure
// storage, offline queue and data cache run on fake-indexeddb. Only the
// external Etebase SDK calls of the restore, billing fetches and the toast
// module are stubbed. All data is synthetic.
import 'fake-indexeddb/auto'
import { StrictMode } from 'react'
import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const coreMock = vi.hoisted(() => ({
  restoreSession: vi.fn(),
  getAccountFingerprint: vi.fn(),
  listCollections: vi.fn(),
  createItem: vi.fn(),
  updateItem: vi.fn(),
  deleteItem: vi.fn(),
  updateItemIfUnchanged: vi.fn(),
  deleteItemIfUnchanged: vi.fn(),
  updateCollectionMeta: vi.fn(),
  deleteCollection: vi.fn(),
  removeCollectionMember: vi.fn(),
}))

vi.mock('@silentsuite/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@silentsuite/core')>(),
  ...coreMock,
}))
vi.mock('@/app/stores/use-toast-store', () => ({ showErrorToast: vi.fn() }))

import { AuthProvider } from '@/app/providers/auth-provider'
import { useAuthStore } from '../use-auth-store'
import { useEtebaseStore } from '../use-etebase-store'
import { useNoteStore } from '../use-note-store'
import { getAccountEpoch } from '@/app/lib/account-epoch'
import { secureClear, secureGet, secureSet } from '@/app/lib/secure-storage'
import { clearAll as clearQueue, enqueue, getAll, _resetForTests as resetQueue } from '@/app/lib/offline-queue'
import {
  clearAll as clearCache,
  getMeta,
  putMeta,
  _setEncryptedCacheAvailableForTests,
  _setEnvelopeKeyForTests,
} from '@/app/lib/data-cache'

const GENERATION = 'silentsuite-logout-generation'
const OLD_GENERATION = 'synthetic-generation-old'
const NEW_GENERATION = 'synthetic-generation-new'
const CUSTOM = 'https://synthetic-selfhost.invalid'
const SESSION_A = 'SYNTHETIC-ETEBASE-SESSION-A'
const SESSION_B = 'SYNTHETIC-ETEBASE-SESSION-B'
const FP_A = 'synthetic-fingerprint-A'
const FP_B = 'synthetic-fingerprint-B'
const itemManager = { batch: vi.fn() }
const ACCOUNT_A = { synthetic: 'account-A', getCollectionManager: () => ({ getItemManager: () => itemManager }) }

/** Browser keys a newer account in another tab owns; a receiving tab must leave them alone. */
const NEWER_KEYS: Record<string, string> = {
  'silentsuite-server-url': CUSTOM,
  'silentsuite-notebooks': '{"state":{"owner":"synthetic-account-B"},"version":0}',
  'silentsuite-calendar-lists': '{"state":{"owner":"synthetic-account-B"},"version":0}',
  'silentsuite-task-lists': '{"state":{"owner":"synthetic-account-B"},"version":0}',
  'silentsuite-contact-lists': '{"state":{"owner":"synthetic-account-B"},"version":0}',
  'silentsuite-label-colors': '{"state":{"owner":"synthetic-account-B"},"version":0}',
}

const billingFetch = vi.fn()
const realFetch = globalThis.fetch
// Billing is never expected here; module and WASM loading keep the real loader.
vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  return url.includes('/auth/') || url.endsWith('/subscription') ? billingFetch(input, init) : realFetch(input, init)
})
vi.stubGlobal('BroadcastChannel', undefined)

vi.setConfig({ testTimeout: 15_000 })

/** Shared persistence as another tab's newer account B left it. */
async function seedNewerAccount() {
  await secureSet('etebase_session', SESSION_B)
  await enqueue({ type: 'delete', collectionType: 'notes', collectionUid: 'nb-b', itemUid: 'note-b' }, { accountEpoch: getAccountEpoch(), accountFingerprint: FP_B })
  await putMeta({ accountFingerprint: FP_B, cacheSchemaVersion: 1, lastInvalidatedAt: null })
  for (const [key, value] of Object.entries(NEWER_KEYS)) localStorage.setItem(key, value)
  document.cookie = 'is_admin=true; path=/'
}

async function sharedPersistence() {
  return {
    session: await secureGet('etebase_session'),
    queue: (await getAll()).map((entry) => [entry.itemUid, entry.accountFingerprint]),
    meta: (await getMeta())?.accountFingerprint ?? null,
    keys: Object.fromEntries(Object.keys(NEWER_KEYS).map((key) => [key, localStorage.getItem(key)])),
    adminCookie: document.cookie.includes('is_admin=true'),
  }
}

const NEWER_PERSISTED = {
  session: SESSION_B,
  queue: [['note-b', FP_B]],
  meta: FP_B,
  keys: NEWER_KEYS,
  adminCookie: true,
}

/** Another tab's write of the logout generation, as the browser delivers it here. */
function storageEvent(key: string, oldValue: string | null, newValue: string | null) {
  window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue, storageArea: localStorage }))
}

/** Tab B: signed in through the rendered AuthProvider, account A restored through the real initialize. */
async function openSignedInTab() {
  render(<AuthProvider><div>protected app</div></AuthProvider>)
  await waitFor(() => expect(useAuthStore.getState().user).not.toBeNull())
  await useEtebaseStore.getState().initialize()
  expect(useEtebaseStore.getState().account).toBe(ACCOUNT_A)
  expect(useEtebaseStore.getState().accountFingerprint).toBe(FP_A)
}

const EVENT_TEXT = 'BEGIN:VCALENDAR\r\nUID:synthetic-event\r\nEND:VCALENDAR'
const calendarItem = { uid: 'ev-1', isDeleted: false, getMeta: () => ({}), delete: () => {} }

/** Account A's calendar with one event and a running engine, as a restored tab holds them. */
function withCalendar() {
  const engine = { stop: vi.fn(), untrackCollection: vi.fn() }
  useEtebaseStore.setState({
    collections: { calendar: [{ uid: 'cal-1', getMeta: () => ({}) }], tasks: [], contacts: [], notes: [], preferences: [] },
    itemCache: new Map([['ev-1', calendarItem]]),
    itemTypeMap: new Map([['ev-1', 'calendar']]),
    itemCollectionMap: new Map([['ev-1', 'cal-1']]),
    syncEngine: engine,
  } as any)
  return engine
}

const contactItem = { uid: 'ct-1', isDeleted: false, getMeta: () => ({}), getContent: async () => 'BEGIN:VCARD\r\nEND:VCARD' }

/** Two calendars, both loaded, so collection writes are allowed. */
function withTwoCalendars() {
  const engine = withCalendar()
  useEtebaseStore.setState({
    collections: { calendar: [{ uid: 'cal-1', getMeta: () => ({}) }, { uid: 'cal-2', getMeta: () => ({}) }], tasks: [], contacts: [], notes: [], preferences: [] },
    domainLoadState: { calendar: 'loaded', tasks: 'loaded', contacts: 'loaded', notes: 'loaded', preferences: 'unknown' },
  } as any)
  return engine
}

type Sdk = 'createItem' | 'updateItem' | 'deleteItem'
const DISPATCHES: [string, () => Promise<unknown>, Sdk][] = [
  ['a create', () => useEtebaseStore.getState().createItem('calendar', EVENT_TEXT, 'tmp-1', 'cal-1'), 'createItem'],
  ['an update', () => useEtebaseStore.getState().updateItem('calendar', 'ev-1', EVENT_TEXT), 'updateItem'],
  ['a delete', () => useEtebaseStore.getState().deleteItem('calendar', 'ev-1'), 'deleteItem'],
]
const DISPATCHED: Record<string, unknown> = { 'a create': 'ev-new', 'an update': 'remote', 'a delete': 'remote' }
const REFUSED: Record<string, unknown> = { 'a create': null, 'an update': false, 'a delete': false }

beforeEach(async () => {
  billingFetch.mockReset()
  coreMock.createItem.mockReset().mockResolvedValue({ uid: 'ev-new', getMeta: () => ({}) })
  coreMock.updateItem.mockReset().mockResolvedValue(calendarItem)
  coreMock.deleteItem.mockReset().mockResolvedValue(undefined)
  coreMock.updateItemIfUnchanged.mockReset().mockResolvedValue({ kind: 'saved', item: contactItem, etag: 'r2' })
  coreMock.deleteItemIfUnchanged.mockReset().mockResolvedValue({ kind: 'deleted' })
  coreMock.updateCollectionMeta.mockReset().mockResolvedValue({ uid: 'cal-1', getMeta: () => ({ name: 'Renamed' }) })
  coreMock.deleteCollection.mockReset().mockResolvedValue(undefined)
  coreMock.removeCollectionMember.mockReset().mockResolvedValue(undefined)
  itemManager.batch.mockReset().mockResolvedValue(undefined)
  coreMock.restoreSession.mockReset().mockResolvedValue(ACCOUNT_A)
  coreMock.getAccountFingerprint.mockReset().mockReturnValue(FP_A)
  // Discovery fails after the account is published: initialize stops there with the account bound.
  coreMock.listCollections.mockReset().mockRejectedValue(new Error('synthetic discovery failure'))
  localStorage.clear()
  sessionStorage.clear()
  document.cookie = 'is_admin=; path=/; max-age=0'
  await resetQueue()
  await clearQueue()
  await clearCache()
  await secureClear()
  useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
  useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false, error: null, pendingSignup: null, subscriptionStatus: null })
  // A self-hosted tab with account A's session, opened after an earlier logout generation.
  localStorage.setItem('silentsuite-server-url', CUSTOM)
  localStorage.setItem(GENERATION, OLD_GENERATION)
  await secureSet('etebase_session', SESSION_A)
})

describe('collection and sharing writes after a logout elsewhere', () => {
  const COLLECTION_WRITES: [string, () => Promise<unknown>, 'updateCollectionMeta' | 'deleteCollection' | 'removeCollectionMember', unknown][] = [
    ['a collection rename', () => useEtebaseStore.getState().updateCollectionMeta('calendar', 'cal-1', { name: 'Renamed' }), 'updateCollectionMeta', true],
    ['a collection delete', () => useEtebaseStore.getState().deleteCollection('calendar', 'cal-1'), 'deleteCollection', true],
    ['a member removal', () => useEtebaseStore.getState().removeCollectionMember('calendar', 'cal-1', 'synthetic-member'), 'removeCollectionMember', true],
  ]

  it.each(COLLECTION_WRITES)('control: an unchanged generation still sends %s', async (_label, run, sdk, sent) => {
    await openSignedInTab()
    withTwoCalendars()

    expect(await run()).toBe(sent)
    expect(coreMock[sdk]).toHaveBeenCalledTimes(1)
  })

  it.each(COLLECTION_WRITES)('a logout elsewhere whose event has not arrived refuses %s before it is sent', async (_label, run, sdk) => {
    await openSignedInTab()
    withTwoCalendars()

    localStorage.setItem(GENERATION, NEW_GENERATION)

    expect(await run()).toBe(false)
    expect(coreMock[sdk]).not.toHaveBeenCalled()
  })
})

describe('the receiving tab while it ends its account', () => {
  it('sends nothing from work its own sign-out publication starts while the old account is still bound', async () => {
    await openSignedInTab()
    withCalendar()
    const results: unknown[] = []
    // As an editor unmounting on the signed-out publication flushes its last save.
    const stop = useAuthStore.subscribe((state, previous) => {
      if (previous.user && !state.user) void useEtebaseStore.getState().createItem('calendar', EVENT_TEXT, 'tmp-flush', 'cal-1').then((r) => results.push(r))
    })
    try {
      localStorage.setItem(GENERATION, NEW_GENERATION)
      storageEvent(GENERATION, OLD_GENERATION, NEW_GENERATION)
      await waitFor(() => expect(useEtebaseStore.getState().account).toBeNull(), { timeout: 1500 })
      await waitFor(() => expect(results).toHaveLength(1))
    } finally {
      stop()
    }

    expect(coreMock.createItem).not.toHaveBeenCalled()
    expect(results).toEqual([null])
  })

  it('a Log out pressed in a tab whose account another tab already logged out ends only this tab, never the newer account', async () => {
    await openSignedInTab()
    withCalendar()
    await seedNewerAccount()
    // The other tab logged out and a newer account signed in; this tab has not handled the event yet.
    localStorage.setItem(GENERATION, NEW_GENERATION)

    await useAuthStore.getState().logout()

    await waitFor(() => expect(useEtebaseStore.getState().account).toBeNull(), { timeout: 1500 })
    expect(useAuthStore.getState().user).toBeNull()
    expect(await sharedPersistence()).toEqual(NEWER_PERSISTED)
    expect(localStorage.getItem(GENERATION)).toBe(NEW_GENERATION)
    expect(billingFetch).not.toHaveBeenCalled()
  })

  it('control: the same flush during this tab\'s own logout still behaves as before, and cleanup completes', async () => {
    await openSignedInTab()
    withCalendar()
    const stop = useAuthStore.subscribe((state, previous) => {
      if (previous.user && !state.user) void useEtebaseStore.getState().createItem('calendar', EVENT_TEXT, 'tmp-flush', 'cal-1')
    })
    try {
      await useAuthStore.getState().logout()
    } finally {
      stop()
    }

    expect(await secureGet('etebase_session')).toBeNull()
    expect(await getAll()).toEqual([])
    expect(await getMeta()).toBeNull()
    expect(useEtebaseStore.getState().account).toBeNull()
  })

  it('characterization: a newer account bound while the receiver loads the store is not destroyed', async () => {
    await openSignedInTab()
    withCalendar()
    const newer = { synthetic: 'account-B' }

    localStorage.setItem(GENERATION, NEW_GENERATION)
    storageEvent(GENERATION, OLD_GENERATION, NEW_GENERATION)
    // A login in this tab takes the boundary before the receiver's store import resolves.
    useEtebaseStore.getState().destroy()
    useEtebaseStore.setState({ account: newer, accountFingerprint: FP_B } as any)
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(useEtebaseStore.getState().account).toBe(newer)
    expect(useEtebaseStore.getState().accountFingerprint).toBe(FP_B)
  })

  it('characterization: StrictMode installs one receiver, and an unmounted provider receives nothing', async () => {
    const view = render(<StrictMode><AuthProvider><div>protected app</div></AuthProvider></StrictMode>)
    await waitFor(() => expect(useAuthStore.getState().user).not.toBeNull())
    await useEtebaseStore.getState().initialize()
    const destroy = vi.spyOn(useEtebaseStore.getState(), 'destroy')

    localStorage.setItem(GENERATION, NEW_GENERATION)
    storageEvent(GENERATION, OLD_GENERATION, NEW_GENERATION)
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(useEtebaseStore.getState().account).toBeNull(), { timeout: 1500 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(destroy).toHaveBeenCalledTimes(1)

    // After unmount, a later logout elsewhere reaches no receiver of this provider.
    view.unmount()
    useAuthStore.setState({ user: { id: 'self-hosted', email: '', planId: 'self-hosted', isAdmin: true, onboardedAt: null }, isAuthenticated: true })
    storageEvent(GENERATION, NEW_GENERATION, 'synthetic-generation-later')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(useAuthStore.getState().user).not.toBeNull()
  })

  it('characterization: an offline sealed note save after a logout elsewhere queues nothing and reseeds no cache', async () => {
    await openSignedInTab()
    useEtebaseStore.setState({
      collections: { calendar: [], tasks: [], contacts: [], notes: [{ uid: 'notes-1', getMeta: () => ({}) }], preferences: [] },
      itemCache: new Map(), itemTypeMap: new Map(), itemCollectionMap: new Map([['note-1', 'notes-1']]),
    } as any)
    await clearCache()

    localStorage.setItem(GENERATION, NEW_GENERATION)
    const saved = await useEtebaseStore.getState().updateItem('notes', 'note-1', 'SYNTHETIC OFFLINE BODY', {
      sealIntent: 'note',
      base: { title: 'Synthetic note', content: 'SYNTHETIC BASE', revision: 'r1' },
      meta: { name: 'Synthetic note', mtime: 2 },
      collectionUid: 'notes-1',
    })

    expect(saved).toBe(false)
    expect(await getAll()).toEqual([])
    expect(await getMeta()).toBeNull()
  })

  it.each([
    ['control: an unchanged generation sends', false, 1, 'remote'],
    ['characterization: a logout elsewhere refuses', true, 0, false],
  ] as const)('%s a contact save at its captured base', async (_label, loggedOutElsewhere, calls, result) => {
    await openSignedInTab()
    useEtebaseStore.setState({
      collections: { calendar: [], tasks: [], contacts: [{ uid: 'book-1', getMeta: () => ({}) }], notes: [], preferences: [] },
      itemCache: new Map([['ct-1', contactItem]]), itemTypeMap: new Map([['ct-1', 'contacts']]), itemCollectionMap: new Map([['ct-1', 'book-1']]),
    } as any)
    if (loggedOutElsewhere) localStorage.setItem(GENERATION, NEW_GENERATION)

    expect(await useEtebaseStore.getState().updateItem('contacts', 'ct-1', 'BEGIN:VCARD\r\nFN:Synthetic\r\nEND:VCARD', {
      contactBase: { revision: 'r1', witness: 'BEGIN:VCARD\r\nEND:VCARD' },
    })).toBe(result)
    expect(coreMock.updateItemIfUnchanged).toHaveBeenCalledTimes(calls)
  })
})

describe('a server-acknowledged change whose display-cache write is refused', () => {
  const noteItem = { uid: 'note-1', isDeleted: false, getMeta: () => ({ name: 'Synthetic note', mtime: 1 }) }

  /** Account A with one note, the local cache on, and the cache record cleared by another tab. */
  async function noteTabWithClearedCache() {
    await openSignedInTab()
    useEtebaseStore.setState({
      collections: { calendar: [], tasks: [], contacts: [], notes: [{ uid: 'notes-1', getMeta: () => ({}) }], preferences: [] },
      itemCache: new Map([['note-1', noteItem]]),
      itemTypeMap: new Map([['note-1', 'notes']]),
      itemCollectionMap: new Map([['note-1', 'notes-1']]),
    } as any)
    await clearCache()
    _setEncryptedCacheAvailableForTests(true)
    _setEnvelopeKeyForTests(await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']))
    vi.stubEnv('NEXT_PUBLIC_LOCAL_CACHE_ENABLED', 'true')
  }

  afterEach(() => {
    vi.unstubAllEnvs()
    _setEncryptedCacheAvailableForTests(null)
    _setEnvelopeKeyForTests(null)
  })

  it.each([
    ['a note update', () => useEtebaseStore.getState().updateItem('notes', 'note-1', 'SYNTHETIC BODY', { meta: { name: 'Synthetic note', mtime: 2 } }), 'updateItem'],
    ['a note delete', () => useEtebaseStore.getState().deleteItem('notes', 'note-1'), 'deleteItem'],
  ] as const)('reports %s as saved remotely while this tab still owns the account, and resurrects no cache record', async (_label, run, sdk) => {
    await noteTabWithClearedCache()
    coreMock.updateItem.mockResolvedValue(noteItem)

    expect(await run()).toBe('remote')
    expect(coreMock[sdk]).toHaveBeenCalledTimes(1)
    expect(await getMeta()).toBeNull()
    expect(useAuthStore.getState().user).not.toBeNull()
  })

  it('reports a notebook clear the server acknowledged member by member as cleared, and resurrects no cache record', async () => {
    await noteTabWithClearedCache()
    useEtebaseStore.setState({
      domainLoadState: { calendar: 'loaded', tasks: 'loaded', contacts: 'loaded', notes: 'loaded', preferences: 'unknown' },
    } as any)
    const at = new Date(1000)
    useNoteStore.setState({
      notes: [{ id: 'note-1', uid: 'note-1', title: 'Synthetic note', content: 'SYNTHETIC BODY', notebookId: 'notes-1', created_at: at, updated_at: at, revision: 'r1' }],
    } as any)

    expect(await useEtebaseStore.getState().deleteItemsInCollection('notes', 'notes-1')).toBe(1)
    // The member is deleted only at the revision it was shown with.
    expect(coreMock.deleteItemIfUnchanged).toHaveBeenCalledTimes(1)
    expect(coreMock.deleteItemIfUnchanged.mock.calls[0]![2]).toBe(noteItem)
    expect(coreMock.deleteItemIfUnchanged.mock.calls[0]![3]).toMatchObject({ etagOverride: 'r1' })
    expect(useNoteStore.getState().notes).toEqual([])
    expect(useEtebaseStore.getState().itemCache.has('note-1')).toBe(false)
    expect(await getMeta()).toBeNull()
  })

  it('characterization: reports a cleared calendar as cleared once the server acknowledged it, and resurrects no cache record', async () => {
    await noteTabWithClearedCache()
    withTwoCalendars()

    expect(await useEtebaseStore.getState().deleteItemsInCollection('calendar', 'cal-1')).toBe(1)
    expect(itemManager.batch).toHaveBeenCalledTimes(1)
    expect(await getMeta()).toBeNull()
  })

  it('does not report a change acknowledged after a logout elsewhere, and ends the account', async () => {
    await noteTabWithClearedCache()
    coreMock.updateItem.mockImplementation(async () => {
      // The server acknowledges just as another tab's logout lands.
      localStorage.setItem(GENERATION, NEW_GENERATION)
      return noteItem
    })

    expect(await useEtebaseStore.getState().updateItem('notes', 'note-1', 'SYNTHETIC BODY', { meta: { name: 'Synthetic note', mtime: 2 } })).toBe(false)
    expect(await getMeta()).toBeNull()
    await waitFor(() => expect(useEtebaseStore.getState().account).toBeNull(), { timeout: 1500 })
    expect(useAuthStore.getState().user).toBeNull()
  })
})

describe('explicit logout in another tab', () => {
  it('signs this tab out of account A in memory and leaves the newer shared persistence untouched', async () => {
    await openSignedInTab()
    const epochBefore = getAccountEpoch()
    await seedNewerAccount()

    localStorage.setItem(GENERATION, NEW_GENERATION)
    storageEvent(GENERATION, OLD_GENERATION, NEW_GENERATION)

    await waitFor(() => expect(useAuthStore.getState().user).toBeNull(), { timeout: 1500 })
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(useEtebaseStore.getState().account).toBeNull()
    expect(useEtebaseStore.getState().accountFingerprint).toBeNull()
    expect(getAccountEpoch()).toBeGreaterThan(epochBefore)
    expect(await sharedPersistence()).toEqual(NEWER_PERSISTED)
    expect(billingFetch).not.toHaveBeenCalled()
  })

  it('signs out an open tab whose auth user another path already cleared, and stops its engine', async () => {
    await openSignedInTab()
    const engine = withCalendar()
    // As a hosted refresh on focus does when the hosted marker exists: user cleared, nothing torn down.
    useAuthStore.setState({ user: null, isAuthenticated: false })

    localStorage.setItem(GENERATION, NEW_GENERATION)
    document.dispatchEvent(new Event('visibilitychange'))

    await waitFor(() => expect(useEtebaseStore.getState().account).toBeNull(), { timeout: 1500 })
    expect(engine.stop).toHaveBeenCalled()
    expect(useEtebaseStore.getState().itemCache.size).toBe(0)
  })

  it.each(DISPATCHES)('control: an unchanged generation still dispatches %s', async (_label, run, sdk) => {
    await openSignedInTab()
    withCalendar()

    expect(await run()).toEqual(DISPATCHED[_label])
    expect(coreMock[sdk]).toHaveBeenCalledTimes(1)
    expect(useAuthStore.getState().user).not.toBeNull()
  })

  it.each(DISPATCHES)('a logout elsewhere whose event has not arrived refuses %s before it is sent', async (label, run, sdk) => {
    await openSignedInTab()
    const engine = withCalendar()

    localStorage.setItem(GENERATION, NEW_GENERATION)

    expect(await run()).toEqual(REFUSED[label])
    expect(coreMock[sdk]).not.toHaveBeenCalled()
    await waitFor(() => expect(useAuthStore.getState().user).toBeNull(), { timeout: 1500 })
    expect(useEtebaseStore.getState().account).toBeNull()
    expect(engine.stop).toHaveBeenCalled()
  })

  it('control: a same-account session rewrite, as a password change makes, keeps this tab signed in', async () => {
    await openSignedInTab()
    withCalendar()

    await secureSet('etebase_session', 'SYNTHETIC-ETEBASE-SESSION-A-AFTER-PASSWORD-CHANGE')
    document.dispatchEvent(new Event('visibilitychange'))

    expect(await useEtebaseStore.getState().createItem('calendar', EVENT_TEXT, 'tmp-1', 'cal-1')).toBe('ev-new')
    expect(coreMock.createItem).toHaveBeenCalledTimes(1)
    expect(useAuthStore.getState().user).not.toBeNull()
  })

  it('own logout is not pre-empted: it writes a new generation and still clears its persistent material', async () => {
    await openSignedInTab()
    withCalendar()

    await useAuthStore.getState().logout()

    expect(localStorage.getItem(GENERATION)).not.toBe(OLD_GENERATION)
    expect(localStorage.getItem(GENERATION)).not.toBeNull()
    expect(await secureGet('etebase_session')).toBeNull()
    expect(await getAll()).toEqual([])
    expect(useEtebaseStore.getState().account).toBeNull()
  })

  it('control: switching back to a tab that is still restoring keeps it signed in, and the restore completes', async () => {
    let finishRestore = (_account: unknown) => {}
    coreMock.restoreSession.mockReturnValueOnce(new Promise((resolve) => { finishRestore = resolve }))
    render(<AuthProvider><div>protected app</div></AuthProvider>)
    await waitFor(() => expect(useAuthStore.getState().user).not.toBeNull())
    const restoring = useEtebaseStore.getState().initialize()

    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('pageshow'))
    finishRestore(ACCOUNT_A)
    await restoring

    expect(useAuthStore.getState().user).not.toBeNull()
    expect(useEtebaseStore.getState().account).toBe(ACCOUNT_A)
    expect(useEtebaseStore.getState().isInitialized).toBe(true)
  })

  it('a logout elsewhere that lands while this tab is restoring signs it out once the account is bound', async () => {
    let finishRestore = (_account: unknown) => {}
    coreMock.restoreSession.mockReturnValueOnce(new Promise((resolve) => { finishRestore = resolve }))
    render(<AuthProvider><div>protected app</div></AuthProvider>)
    await waitFor(() => expect(useAuthStore.getState().user).not.toBeNull())
    const restoring = useEtebaseStore.getState().initialize()

    localStorage.setItem(GENERATION, NEW_GENERATION)
    finishRestore(ACCOUNT_A)
    await restoring

    await waitFor(() => expect(useAuthStore.getState().user).toBeNull(), { timeout: 1500 })
    expect(useEtebaseStore.getState().account).toBeNull()
  })

  it.each([
    ['an unchanged generation', GENERATION, OLD_GENERATION],
    ['another key', 'silentsuite-unrelated-key', NEW_GENERATION],
    ['a removed value', GENERATION, null],
  ])('ignores %s', async (_label, key, newValue) => {
    await openSignedInTab()
    const epochBefore = getAccountEpoch()

    storageEvent(key, OLD_GENERATION, newValue)
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(useAuthStore.getState().user).not.toBeNull()
    expect(useEtebaseStore.getState().account).toBe(ACCOUNT_A)
    expect(getAccountEpoch()).toBe(epochBefore)
  })
})
