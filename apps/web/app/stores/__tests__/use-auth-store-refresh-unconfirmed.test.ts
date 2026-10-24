import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '../use-auth-store'
// Byte-identical unchanged clients (Git blobs at bfcd47b4 / d7a5867f), copied by
// copy-compat-fixtures.py; they run against the same edge mocks as the new store.
import { useAuthStore as useBfcdAuthStore } from './old-bfcd-auth-store'
import { useAuthStore as useD7AuthStore } from './old-d7-auth-store'
import { secureClear } from '@/app/lib/secure-storage'
import { bumpAccountEpoch } from '@/app/lib/account-epoch'

const { dataCacheClearAll, offlineQueueClearAll } = vi.hoisted(() => ({
  dataCacheClearAll: vi.fn(async () => {}),
  offlineQueueClearAll: vi.fn(async () => {}),
}))
vi.mock('@/app/lib/data-cache', () => ({ clearAll: dataCacheClearAll }))
vi.mock('@/app/lib/offline-queue', () => ({ clearAll: offlineQueueClearAll }))

let secureStore: Record<string, string> = {}
vi.mock('@/app/lib/secure-storage', () => ({
  secureGet: vi.fn(async (key: string) => secureStore[key] ?? null),
  secureSet: vi.fn(async (key: string, value: string) => { secureStore[key] = value }),
  secureRemove: vi.fn(async (key: string) => { delete secureStore[key] }),
  secureClear: vi.fn(async () => { secureStore = {} }),
  migrateFromLocalStorage: vi.fn(async () => {}),
}))
vi.mock('@/app/lib/self-hosted', () => ({
  isSelfHosted: false,
  isCustomServer: (serverUrl?: string) => Boolean(serverUrl && serverUrl !== 'https://server.silentsuite.io'),
}))
vi.mock('@/app/stores/use-etebase-store', async () => {
  const { bumpAccountEpoch } = await import('@/app/lib/account-epoch')
  return {
    EtebaseTeardownError: class extends Error {},
    useEtebaseStore: { getState: () => ({ destroy: vi.fn(() => bumpAccountEpoch()) }) },
  }
})

const USER = { id: 'user-1', email: 'user@example.test', planId: 'pro', isAdmin: false, emailVerified: true, rememberDevice: true, onboardedAt: null }

/** Billing's canonical v4 reply when a refresh outcome cannot be confirmed: no cookies, Retry-After 1. */
function unconfirmed(retryAfter: string | null = '1', type = 'https://api.silentsuite.io/errors/refresh-unconfirmed') {
  return new Response(JSON.stringify({ type, title: 'Refresh Unconfirmed', status: 503 }), {
    status: 503,
    headers: retryAfter === null ? {} : { 'Retry-After': retryAfter },
  })
}
const rotated = () => new Response(JSON.stringify({ id: USER.id, email: USER.email, planId: 'pro', isAdmin: false, emailVerified: true, rememberDevice: true }))

/** Routes Billing calls; refresh replies come from the queue (last repeats). */
function serve(refreshReplies: Array<() => Response>) {
  const calls = { refresh: 0, deleteSession: 0 }
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/auth/refresh')) return refreshReplies[Math.min(calls.refresh++, refreshReplies.length - 1)]!()
    if (url.endsWith('/auth/session') && init?.method === 'DELETE') { calls.deleteSession++; return new Response(null, { status: 204 }) }
    if (url.endsWith('/subscription')) return new Response(JSON.stringify({ status: 'active' }))
    throw new Error('unexpected request')
  })
  return calls
}

type Store = typeof useAuthStore
const CLIENTS: Array<[string, Store]> = [
  ['new client', useAuthStore],
  ['unchanged d7 client', useD7AuthStore as unknown as Store],
  ['unchanged bfcd client', useBfcdAuthStore as unknown as Store],
]

function signedIn(store: Store = useAuthStore) {
  store.setState({ user: { ...USER }, isAuthenticated: true, isLoading: false, error: null, pendingSignup: null, subscriptionStatus: 'active' })
  secureStore = { etebase_session: 'saved-session' }
}

function expectNothingDestroyed(calls: { deleteSession: number }) {
  expect(calls.deleteSession).toBe(0)
  expect(secureClear).not.toHaveBeenCalled()
  expect(dataCacheClearAll).not.toHaveBeenCalled()
  expect(offlineQueueClearAll).not.toHaveBeenCalled()
  expect(secureStore.etebase_session).toBe('saved-session')
}

type Entry = 'refreshSession' | 'restoreSession' | 'retryBillingConnection'
const ENTRIES: Entry[] = ['refreshSession', 'restoreSession', 'retryBillingConnection']
const run = (entry: Entry, store: Store = useAuthStore) => (store.getState()[entry] as () => Promise<unknown>)()
const expired = () => new Response(JSON.stringify({ type: 'https://api.silentsuite.io/errors/authentication-failed', status: 401 }), { status: 401 })

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
  vi.stubGlobal('BroadcastChannel', undefined)
  vi.mocked(secureClear).mockClear()
  dataCacheClearAll.mockClear()
  offlineQueueClearAll.mockClear()
  localStorage.clear()
  sessionStorage.clear()
  vi.useFakeTimers()
  signedIn()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe.each(CLIENTS)('%s: refresh-unconfirmed 503 is never destructive', (_client, store) => {
  beforeEach(() => signedIn(store))

  it.each(ENTRIES)('%s keeps the session material when every refresh is unconfirmed', async (entry) => {
    const calls = serve([() => unconfirmed()])
    const result = run(entry, store)
    await vi.advanceTimersByTimeAsync(5_000)
    const value = await result
    if (entry !== 'restoreSession') expect(value).toBe(false)
    expectNothingDestroyed(calls)
  })

  it.each(ENTRIES)('%s does not retry a 503 that is not the canonical refresh-unconfirmed reply', async (entry) => {
    for (const reply of [() => unconfirmed(null), () => unconfirmed('1', 'https://api.silentsuite.io/errors/service-unavailable')]) {
      signedIn(store)
      const calls = serve([reply, rotated])
      const result = run(entry, store)
      await vi.advanceTimersByTimeAsync(5_000)
      await result
      expect(calls.refresh).toBe(1)
      expectNothingDestroyed(calls)
    }
  })

  it.each(ENTRIES)('%s keeps the session when the boundary changes while a 503 is handled', async (entry) => {
    const calls = serve([() => unconfirmed(), rotated])
    const result = run(entry, store)
    await vi.advanceTimersByTimeAsync(500)
    bumpAccountEpoch()
    await vi.advanceTimersByTimeAsync(5_000)
    await result
    expect(calls.refresh).toBe(1)
    expectNothingDestroyed(calls)
  })

  // Controls: an ordinary valid refresh adopts the session; a certain 401 keeps its existing destructive path.
  it.each(ENTRIES)('%s adopts a valid refresh with one request', async (entry) => {
    const calls = serve([rotated])
    const value = await run(entry, store)
    expect(calls.refresh).toBe(1)
    if (entry !== 'restoreSession') expect(value).toBe(true)
    expect(store.getState().isAuthenticated).toBe(true)
    expectNothingDestroyed(calls)
  })

  it.each(ENTRIES)('%s still signs out and deletes the server session on a certain 401', async (entry) => {
    const calls = serve([expired])
    const value = await run(entry, store)
    expect(calls.refresh).toBe(1)
    if (entry !== 'restoreSession') expect(value).toBe(false)
    expect(calls.deleteSession).toBe(1)
    expect(store.getState().user).toBeNull()
  })
})

describe('new client: exactly one bounded re-request after Retry-After', () => {
  it.each(ENTRIES)('%s re-requests once after Retry-After and adopts the confirmed session', async (entry) => {
    const calls = serve([() => unconfirmed(), rotated])
    const result = run(entry)
    await vi.advanceTimersByTimeAsync(999)
    expect(calls.refresh).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    const value = await result
    expect(calls.refresh).toBe(2)
    if (entry !== 'restoreSession') expect(value).toBe(true)
    expect(useAuthStore.getState().user?.id).toBe(USER.id)
    expect(useAuthStore.getState().isAuthenticated).toBe(true)
    expectNothingDestroyed(calls)
  })

  it.each(ENTRIES)('%s stops after the second unconfirmed reply without DELETE or local clear', async (entry) => {
    const calls = serve([() => unconfirmed()])
    const result = run(entry)
    await vi.advanceTimersByTimeAsync(10_000)
    const value = await result
    expect(calls.refresh).toBe(2)
    if (entry !== 'restoreSession') expect(value).toBe(false)
    expectNothingDestroyed(calls)
  })

  it.each(ENTRIES)('%s abandons the re-request when the account boundary changes during the wait', async (entry) => {
    const calls = serve([() => unconfirmed(), rotated])
    const result = run(entry)
    await vi.advanceTimersByTimeAsync(500)
    bumpAccountEpoch()
    await vi.advanceTimersByTimeAsync(5_000)
    const value = await result
    expect(calls.refresh).toBe(1)
    if (entry !== 'restoreSession') expect(value).toBe(false)
    expectNothingDestroyed(calls)
  })
})
