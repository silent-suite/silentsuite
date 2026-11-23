// "Keep me signed in" decides where the Etebase session may live, with the real
// auth store and real secure-storage on fake-indexeddb. Billing and Etebase
// network calls are stubbed. All data is synthetic.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/app/lib/self-hosted', () => ({
  isSelfHosted: false,
  isCustomServer: (serverUrl?: string) => Boolean(serverUrl && serverUrl !== 'https://server.silentsuite.io'),
}))
vi.mock('@/app/stores/use-toast-store', () => ({ showErrorToast: vi.fn() }))
vi.mock('@/app/lib/etebase-auth', () => ({
  etebaseLogIn: vi.fn(async () => ({ authToken: 'synthetic-token', savedSession: 'SYNTHETIC-SESSION-LOGIN' })),
  etebaseSignUp: vi.fn(),
  issueBillingLinkProof: vi.fn(async () => 'synthetic-link-proof-value-with-at-least-43-characters'),
}))

import { useAuthStore } from '../use-auth-store'
import { secureClear, secureGet, secureSet } from '@/app/lib/secure-storage'
import { TAB_SESSION_KEY, getSessionScope, setSessionScope } from '@/app/lib/session-scope'

const KEY = 'etebase_session'
const SESSION_MARKER = 'silentsuite-hosted-validation-session'
const ACTIVE_TABS = 'silentsuite-hosted-validation-active-tabs'
const TAB_ID = 'silentsuite-hosted-tab-id'
const user = { id: 'synthetic-user-A', email: 'a@synthetic.invalid', planId: 'pro', isAdmin: false }

const billing = vi.fn<(url: string) => Promise<Response>>()
const realFetch = globalThis.fetch
vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  return url.includes('/auth/') || url.endsWith('/subscription') ? billing(url) : realFetch(input, init)
})
vi.stubGlobal('BroadcastChannel', undefined)

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** A tab copy written by an earlier sign-in in this tab (no logout since). */
function writeStaleTabCopy(session: string) {
  sessionStorage.setItem(TAB_SESSION_KEY, JSON.stringify({ generation: null, session }))
}

async function storedCopy() {
  return secureGet(KEY, { storedOnly: true })
}

beforeEach(async () => {
  billing.mockReset()
  localStorage.clear()
  sessionStorage.clear()
  await secureClear()
  setSessionScope(null)
  useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false, error: null, pendingSignup: null, subscriptionStatus: null })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('login', () => {
  it('never writes the session to IndexedDB without "Keep me signed in"', async () => {
    const put = vi.spyOn(IDBObjectStore.prototype, 'put')
    billing.mockResolvedValue(json({ ...user, rememberDevice: false }))
    await useAuthStore.getState().login(user.email, 'synthetic-password', undefined, false)

    expect(useAuthStore.getState().user?.id).toBe(user.id)
    expect(put.mock.calls.some(([, key]) => key === KEY)).toBe(false)
    expect(await storedCopy()).toBeNull()
    expect(getSessionScope()).toBe('tab')
    expect(await secureGet(KEY)).toBe('SYNTHETIC-SESSION-LOGIN')
  })

  it('keeps the session on the device only after Billing confirms "Keep me signed in"', async () => {
    billing.mockResolvedValue(json({ ...user, rememberDevice: true }))
    await useAuthStore.getState().login(user.email, 'synthetic-password', undefined, true)

    expect(await storedCopy()).toBe('SYNTHETIC-SESSION-LOGIN')
    expect(sessionStorage.getItem(TAB_SESSION_KEY)).toBeNull()
    expect(getSessionScope()).toBe('device')
  })

  it('keeps the session in the tab when Billing does not confirm the remembered device', async () => {
    billing.mockResolvedValue(json({ ...user, rememberDevice: false }))
    await useAuthStore.getState().login(user.email, 'synthetic-password', undefined, true)

    expect(await storedCopy()).toBeNull()
    expect(getSessionScope()).toBe('tab')
  })

  it('stores nothing durable when the token exchange fails', async () => {
    billing.mockRejectedValue(new TypeError('synthetic Failed to fetch'))
    await useAuthStore.getState().login(user.email, 'synthetic-password', undefined, true)

    expect(await storedCopy()).toBeNull()
  })
})

describe('restoreSession', () => {
  it('a remembered restore ignores and removes a stale tab copy from an earlier account', async () => {
    await secureSet(KEY, 'SYNTHETIC-SESSION-REMEMBERED-B', { persist: true })
    writeStaleTabCopy('SYNTHETIC-SESSION-STALE-A')
    setSessionScope(null)
    billing.mockResolvedValue(json({ ...user, id: 'synthetic-user-B', rememberDevice: true }))

    await useAuthStore.getState().restoreSession()

    expect(useAuthStore.getState().user?.id).toBe('synthetic-user-B')
    expect(sessionStorage.getItem(TAB_SESSION_KEY)).toBeNull()
    expect(await secureGet(KEY)).toBe('SYNTHETIC-SESSION-REMEMBERED-B')
  })

  it('a non-remembered restore with this tab\'s marker keeps the tab copy and deletes an old IndexedDB copy', async () => {
    await secureSet(KEY, 'SYNTHETIC-SESSION-LEGACY', { persist: true })
    writeStaleTabCopy('SYNTHETIC-SESSION-TAB')
    setSessionScope(null)
    sessionStorage.setItem(SESSION_MARKER, JSON.stringify({ userId: user.id, rememberDevice: false, validatedAt: Date.now() }))
    billing.mockResolvedValue(json({ ...user, rememberDevice: false }))

    await useAuthStore.getState().restoreSession()

    expect(useAuthStore.getState().user?.id).toBe(user.id)
    expect(await storedCopy()).toBeNull()
    expect(await secureGet(KEY)).toBe('SYNTHETIC-SESSION-TAB')
  })

  it('a non-remembered restore never adopts an IndexedDB copy when the tab has none', async () => {
    await secureSet(KEY, 'SYNTHETIC-SESSION-LEGACY', { persist: true })
    setSessionScope(null)
    sessionStorage.setItem(SESSION_MARKER, JSON.stringify({ userId: user.id, rememberDevice: false, validatedAt: Date.now() }))
    billing.mockResolvedValue(json({ ...user, rememberDevice: false }))

    await useAuthStore.getState().restoreSession()

    expect(useAuthStore.getState().user?.id).toBe(user.id)
    expect(await secureGet(KEY)).toBeNull()
    expect(await storedCopy()).toBeNull()
  })

  it('a new tab next to a live tab gets no session: its stale copy and any IndexedDB copy are removed', async () => {
    await secureSet(KEY, 'SYNTHETIC-SESSION-LEGACY', { persist: true })
    writeStaleTabCopy('SYNTHETIC-SESSION-OTHER-ACCOUNT')
    setSessionScope(null)
    sessionStorage.setItem(TAB_ID, 'tab-current')
    localStorage.setItem(ACTIVE_TABS, JSON.stringify({ 'tab-live': { userId: user.id, validatedAt: Date.now() } }))
    billing.mockResolvedValue(json({ ...user, rememberDevice: false }))

    await useAuthStore.getState().restoreSession()

    expect(useAuthStore.getState().user?.id).toBe(user.id)
    expect(sessionStorage.getItem(TAB_SESSION_KEY)).toBeNull()
    expect(await secureGet(KEY)).toBeNull()
    expect(await storedCopy()).toBeNull()
  })

  it('offline with this tab\'s non-remembered marker uses only the tab copy', async () => {
    await secureSet(KEY, 'SYNTHETIC-SESSION-LEGACY', { persist: true })
    setSessionScope(null)
    sessionStorage.setItem(SESSION_MARKER, JSON.stringify({ userId: user.id, rememberDevice: false, validatedAt: Date.now() }))
    billing.mockRejectedValue(new TypeError('synthetic Failed to fetch'))

    await useAuthStore.getState().restoreSession()

    // No tab copy: nothing to unlock offline, and the durable copy is gone.
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(await storedCopy()).toBeNull()
  })
})

describe('signup', () => {
  const signupId = 'synthetic-user-S'
  const signupEmail = 's@synthetic.invalid'

  async function establishProvisionedSignup(rememberDevice: boolean) {
    await secureSet(KEY, 'SYNTHETIC-SESSION-SIGNUP', { persist: false })
    useAuthStore.setState({
      pendingSignup: {
        email: signupEmail,
        rememberDevice,
        billingContractVersion: 2,
        provisionedUser: { id: signupId, planId: null, isAdmin: false },
        provisionedSubscriptionStatus: 'trialing_no_card',
      },
    })
    const identity = { id: signupId, email: signupEmail, isAdmin: false, emailVerified: true, rememberDevice }
    billing.mockImplementation(async () => json(identity))
    await useAuthStore.getState().provisionAnnualNoCard('synthetic-checkout-intent')
  }

  it('keeps a confirmed remembered signup on the device before completion can navigate', async () => {
    await establishProvisionedSignup(true)
    // Awaited inside the Billing session step, before completeSignup runs.
    expect(await storedCopy()).toBe('SYNTHETIC-SESSION-SIGNUP')
    useAuthStore.getState().completeSignup()
    expect(useAuthStore.getState().user).toMatchObject({ id: signupId, rememberDevice: true })
  })

  it('keeps a non-remembered signup in the tab', async () => {
    const put = vi.spyOn(IDBObjectStore.prototype, 'put')
    await establishProvisionedSignup(false)
    useAuthStore.getState().completeSignup()
    expect(put.mock.calls.some(([, key]) => key === KEY)).toBe(false)
    expect(await storedCopy()).toBeNull()
    expect(useAuthStore.getState().user).toMatchObject({ id: signupId, rememberDevice: false })
  })
})
