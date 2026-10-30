import { createElement } from 'react'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useAuthStore } from '../use-auth-store'
import { secureClear, secureSet } from '@/app/lib/secure-storage'
import { logger } from '@/app/lib/logger'
import { bumpAccountEpoch, establishLogoutGeneration, getAccountEpoch, LOGOUT_GENERATION_KEY, releaseLogoutGeneration, writeLogoutGeneration } from '@/app/lib/account-epoch'

// Mock fetch globally
vi.stubGlobal('fetch', vi.fn())

// Mock data-cache (used on logout). We use vi.hoisted so the mock fn is
// declared before vi.mock factory runs (vi.mock is hoisted to the top).
const {
  dataCacheClearAll,
  offlineQueueClearAll,
  calendarSetState,
  taskSetState,
  contactSetState,
  noteSetState,
  noteLifecycleReset,
  contactLifecycleReset,
  calendarListSetState,
  taskListSetState,
  contactListSetState,
  notebookSetState,
  labelSuggestionsReset,
  labelColorSetState,
  preferencesReset,
  preferencesSyncDestroy,
} = vi.hoisted(() => ({
  dataCacheClearAll: vi.fn(async () => {}),
  offlineQueueClearAll: vi.fn(async () => {}),
  calendarSetState: vi.fn(),
  taskSetState: vi.fn(),
  contactSetState: vi.fn(),
  noteSetState: vi.fn(),
  noteLifecycleReset: vi.fn(),
  contactLifecycleReset: vi.fn(),
  calendarListSetState: vi.fn(),
  taskListSetState: vi.fn(),
  contactListSetState: vi.fn(),
  notebookSetState: vi.fn(),
  labelSuggestionsReset: vi.fn(),
  labelColorSetState: vi.fn(),
  preferencesReset: vi.fn(),
  preferencesSyncDestroy: vi.fn(),
}))
vi.mock('@/app/lib/data-cache', () => ({
  clearAll: dataCacheClearAll,
}))
vi.mock('@/app/lib/offline-queue', () => ({
  clearAll: offlineQueueClearAll,
}))

// In-memory store for secure storage mock
let secureStore: Record<string, string> = {}

// Mock secure storage (IndexedDB wrapper)
vi.mock('@/app/lib/secure-storage', () => ({
  secureGet: vi.fn(async (key: string) => secureStore[key] ?? null),
  secureSet: vi.fn(async (key: string, value: string) => { secureStore[key] = value }),
  secureRemove: vi.fn(async (key: string) => { delete secureStore[key] }),
  // In-memory stand-in for one IndexedDB transaction (see secure-storage.test.ts for the real one).
  secureRemoveIfEqual: vi.fn(async (key: string, expected: string) => {
    if (secureStore[key] === expected) delete secureStore[key]
  }),
  secureClear: vi.fn(async () => { secureStore = {} }),
  migrateFromLocalStorage: vi.fn(async () => {}),
}))

// Mock etebase-auth (dynamically imported by login)
vi.mock('@/app/lib/etebase-auth', () => ({
  etebaseSignUp: vi.fn().mockResolvedValue({
    authToken: 'mock-auth-token',
    savedSession: 'mock-saved-session',
  }),
  etebaseLogIn: vi.fn().mockResolvedValue({
    authToken: 'mock-auth-token',
    savedSession: 'mock-saved-session',
  }),
  issueBillingLinkProof: vi.fn().mockResolvedValue('mock-link-proof-value-with-at-least-43-characters'),
}))

// Mock self-hosted checks. `isSelfHosted` stays false except inside the
// self-hosted newsletter test, which flips it in place: resetting the module
// registry instead would hand later dynamic imports a second store instance.
const selfHostedMode = vi.hoisted(() => ({ enabled: false }))
vi.mock('@/app/lib/self-hosted', () => ({
  get isSelfHosted() { return selfHostedMode.enabled },
  isCustomServer: (serverUrl?: string) => Boolean(serverUrl && serverUrl !== 'https://server.silentsuite.io'),
}))

// Mock etebase store (used by logout). Like the real destroy(), teardown
// invalidates the account epoch and returns the token it produced.
vi.mock('@/app/stores/use-etebase-store', async () => {
  const { bumpAccountEpoch } = await import('@/app/lib/account-epoch')
  return {
    EtebaseTeardownError: class extends Error {},
    useEtebaseStore: {
      getState: () => ({ destroy: vi.fn(() => bumpAccountEpoch()) }),
    },
  }
})

vi.mock('@/app/stores/use-calendar-store', () => ({ useCalendarStore: { setState: calendarSetState } }))
vi.mock('@/app/stores/use-task-store', () => ({ useTaskStore: { setState: taskSetState } }))
vi.mock('@/app/stores/use-contact-store', () => ({ useContactStore: { setState: contactSetState }, resetContactLifecycle: contactLifecycleReset }))
vi.mock('@/app/stores/use-note-store', () => ({ useNoteStore: { setState: noteSetState }, resetNoteLifecycle: noteLifecycleReset }))
vi.mock('@/app/stores/use-calendar-list-store', () => ({ useCalendarListStore: { setState: calendarListSetState } }))
vi.mock('@/app/stores/use-task-list-store', () => ({ useTaskListStore: { setState: taskListSetState } }))
vi.mock('@/app/stores/use-contact-list-store', () => ({ useContactListStore: { setState: contactListSetState } }))
vi.mock('@/app/stores/use-notebook-store', () => ({ useNotebookStore: { setState: notebookSetState } }))
vi.mock('@/app/stores/use-label-suggestions-store', () => ({
  useLabelSuggestionsStore: { getState: () => ({ reset: labelSuggestionsReset }) },
}))
vi.mock('@/app/stores/use-label-color-store', () => ({ useLabelColorStore: { setState: labelColorSetState } }))
vi.mock('@/app/stores/use-preferences-store', () => ({
  usePreferencesStore: { getState: () => ({ resetSyncedPreferences: preferencesReset }) },
}))
vi.mock('@/app/stores/use-preferences-sync-store', () => ({
  usePreferencesSyncStore: { getState: () => ({ destroy: preferencesSyncDestroy }) },
}))

// S2b: `hostedAccess` is not declared on the store yet. Test-local casts only
// seed/read it; no application stub exists for it.
type StoreState = ReturnType<typeof useAuthStore.getState>
type WithHostedAccess = Partial<StoreState> & { hostedAccess?: unknown }
const seedStore = (state: WithHostedAccess) => useAuthStore.setState(state as Partial<StoreState>)
const readHostedAccess = () => (useAuthStore.getState() as StoreState & { hostedAccess?: unknown }).hostedAccess

function resetStore() {
  seedStore({
    user: null,
    isAuthenticated: false,
    isLoading: false,
    error: null,
    pendingSignup: null,
    subscriptionStatus: null,
    hostedAccess: null,
  })
}

function deferredValue<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

/** A /subscription response whose JSON body is released only when the test says so. */
function delayedJsonResponse() {
  const body = deferredValue<unknown>()
  return { response: { ok: true, status: 200, json: () => body.promise } as unknown as Response, body }
}

/** Records every store notification's (status, hostedAccess, user id) tuple. */
function recordTuples() {
  const seen: Array<[unknown, unknown, unknown]> = []
  const unsubscribe = useAuthStore.subscribe((state) => {
    seen.push([state.subscriptionStatus, (state as StoreState & { hostedAccess?: unknown }).hostedAccess, state.user?.id ?? null])
  })
  return { seen, unsubscribe }
}

function mockSignupBillingSession(id: string, email: string, isAdmin = false, emailVerified = true) {
  vi.mocked(fetch)
    .mockImplementationOnce(async (url, init) => {
      expect(String(url)).toContain('/auth/token-exchange')
      expect(init?.credentials).toBe('include')
      return new Response(JSON.stringify({ id, email, isAdmin, emailVerified, rememberDevice: false }))
    })
    .mockImplementationOnce(async (url, init) => {
      expect(String(url)).toContain('/auth/session')
      expect(init?.credentials).toBe('include')
      return new Response(JSON.stringify({ id, email, emailVerified }))
    })
}

function paidSignupRequestBody(callIndex = 0) {
  const [, init] = vi.mocked(fetch).mock.calls[callIndex]
  return JSON.parse(init?.body as string) as Record<string, unknown>
}

function persistedPaidSignupIdentities() {
  const raw = sessionStorage.getItem('silentsuite-paid-signup-recovery')
  if (!raw) return []
  const registry = JSON.parse(raw) as { identities?: Record<string, Record<string, unknown>> }
  return Object.values(registry.identities ?? {})
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const RECOVERY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

// C1 W3: self-hosted signup subscribes only for a stored historical opt-in;
// new drafts (no checkbox: absent or explicit false) never call the newsletter.
describe('self-hosted signup newsletter consent', () => {
  it.each([
    ['an absent preference', undefined, 0],
    ['an explicit false', false, 0],
    ['a stored historical opt-in', true, 1],
  ] as const)('%s sends %i newsletter requests', async (_label, wantsProductUpdates, expected) => {
    selfHostedMode.enabled = true
    try {
      resetStore()
      vi.mocked(fetch).mockReset()
      vi.mocked(fetch).mockImplementation(async () => new Response('{}'))
      useAuthStore.setState({ pendingSignup: { email: 'selfhost@example.com', ...(wantsProductUpdates === undefined ? {} : { wantsProductUpdates }) } })
      await useAuthStore.getState().signup('self-hosted', '')
      expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith('/newsletter/subscribe'))).toHaveLength(expected)
    } finally {
      selfHostedMode.enabled = false
      resetStore()
      vi.mocked(fetch).mockReset()
    }
  })
})

describe('useAuthStore', () => {
  beforeEach(() => {
    resetStore()
    vi.mocked(fetch).mockReset()
    dataCacheClearAll.mockClear()
    offlineQueueClearAll.mockClear()
    calendarSetState.mockClear()
    taskSetState.mockClear()
    contactSetState.mockClear()
    noteSetState.mockClear()
    calendarListSetState.mockClear()
    taskListSetState.mockClear()
    contactListSetState.mockClear()
    notebookSetState.mockClear()
    labelSuggestionsReset.mockClear()
    labelColorSetState.mockClear()
    preferencesReset.mockClear()
    preferencesSyncDestroy.mockClear()
    vi.mocked(secureClear).mockClear()
    vi.mocked(secureClear).mockImplementation(async () => { secureStore = {} })
    vi.stubGlobal('BroadcastChannel', undefined)
    secureStore = {}
    localStorage.clear()
    sessionStorage.clear()
  })

  it('login sets user and auth state', async () => {
    // login calls etebaseLogIn (mocked above), then fetch for token-exchange
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: 'user-1', email: 'test@example.com', planId: 'pro', isAdmin: false }),
    } as Response)

    await useAuthStore.getState().login('test@example.com', 'password123')

    const state = useAuthStore.getState()
    expect(state.isAuthenticated).toBe(true)
    expect(state.user).not.toBeNull()
    expect(state.user!.email).toBe('test@example.com')
    expect(state.isLoading).toBe(false)
    const [, init] = vi.mocked(fetch).mock.calls[0]
    expect(JSON.parse(init?.body as string)).toEqual({
      etebaseLinkProof: 'mock-link-proof-value-with-at-least-43-characters',
      rememberDevice: false,
    })
    expect(init?.body).not.toContain('authToken')
    expect(init?.body).not.toContain('savedSession')
  })

  it('unlockEtebaseSession restores only the local session for the signed-in account', async () => {
    useAuthStore.setState({
      user: { id: 'user-1', email: 'test@example.com', planId: 'pro', isAdmin: false, onboardedAt: null },
      isAuthenticated: true,
    })

    await useAuthStore.getState().unlockEtebaseSession('TEST@example.com', 'password123')

    expect(secureStore.etebase_session).toBe('mock-saved-session')
    expect(fetch).not.toHaveBeenCalled()
    expect(offlineQueueClearAll).not.toHaveBeenCalled()
    expect(useAuthStore.getState().error).toBeNull()
  })

  it('unlockEtebaseSession refuses to mix a different Etebase account with the hosted session', async () => {
    useAuthStore.setState({
      user: { id: 'user-1', email: 'test@example.com', planId: 'pro', isAdmin: false, onboardedAt: null },
      isAuthenticated: true,
    })

    await useAuthStore.getState().unlockEtebaseSession('other@example.com', 'password123')

    expect(secureStore.etebase_session).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
    expect(useAuthStore.getState().error).toMatch(/already signed in/i)
  })

  it('rejects a replacement password for a retained encrypted account rather than pretending it changed', async () => {
    const { etebaseSignUp, etebaseLogIn } = await import('@/app/lib/etebase-auth')
    useAuthStore.getState().prepareSignupDraft('identity@example.test')
    await useAuthStore.getState().createEtebaseAccount('identity@example.test', 'OriginalPass1')
    vi.mocked(etebaseLogIn).mockRejectedValueOnce(new Error('Invalid original credentials'))
    await expect(useAuthStore.getState().createEtebaseAccount('identity@example.test', 'DifferentPass2')).rejects.toThrow('Invalid original credentials')
    expect(etebaseLogIn).toHaveBeenCalledWith('identity@example.test', 'DifferentPass2', undefined)
    expect(etebaseSignUp).toHaveBeenCalledTimes(1)
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
    await useAuthStore.getState().createEtebaseAccount('identity@example.test', 'OriginalPass1')
    expect(etebaseLogIn).toHaveBeenLastCalledWith('identity@example.test', 'OriginalPass1', undefined)
    // A later login must not treat the rejected replacement as the account password.
    await useAuthStore.getState().logout()
    vi.mocked(etebaseLogIn).mockRejectedValueOnce(new Error('Invalid original credentials'))
    await useAuthStore.getState().login('identity@example.test', 'DifferentPass2')
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(useAuthStore.getState().user).toBeNull()
  })

  it('reuses an Etebase account created by an ambiguous prior signup attempt', async () => {
    const { etebaseSignUp, etebaseLogIn } = await import('@/app/lib/etebase-auth')
    vi.mocked(etebaseSignUp).mockRejectedValueOnce(new Error('409 conflict'))

    useAuthStore.getState().prepareSignupDraft('recover@example.com', true, true)
    await useAuthStore.getState().createEtebaseAccount('recover@example.com', 'password123')

    expect(etebaseLogIn).toHaveBeenCalledWith('recover@example.com', 'password123', undefined)
    expect(useAuthStore.getState().pendingSignup).toMatchObject({
      email: 'recover@example.com', wantsProductUpdates: true, rememberDevice: true,
    })
    expect(secureStore.etebase_session).toBe('mock-saved-session')
  })

  describe('owner signup cancelled while the session write is pending', () => {
    const serverUrl = 'https://sync.example.test'

    // Like IndexedDB, the put is queued when issued; only its completion is deferred.
    function deferNextSessionWrite() {
      let started!: () => void
      let release!: () => void
      const writeStarted = new Promise<void>((resolve) => { started = resolve })
      const writeDone = new Promise<void>((resolve) => { release = resolve })
      vi.mocked(secureSet).mockImplementationOnce(async (key: string, value: string) => {
        secureStore[key] = value
        started()
        await writeDone
      })
      return { writeStarted, release }
    }

    function startOwnerSignup(signal: AbortSignal) {
      return useAuthStore.getState().createEtebaseAccount('owner@example.test', 'OwnerPass1', serverUrl, {
        ownerPassword: 'installation-password', signal,
      })
    }

    function expectNothingPublished() {
      expect(localStorage.getItem('silentsuite-server-url')).toBeNull()
      expect(sessionStorage.getItem('silentsuite-signup-in-progress')).toBeNull()
      expect(useAuthStore.getState().pendingSignup).toBeNull()
      expect(useAuthStore.getState().isLoading).toBe(false)
    }

    it('leaves no session, endpoint, signup marker or ready signup', async () => {
      const controller = new AbortController()
      const write = deferNextSessionWrite()
      const signup = startOwnerSignup(controller.signal)
      await write.writeStarted
      controller.abort()
      write.release()
      await expect(signup).rejects.toMatchObject({ name: 'AbortError' })
      expect(secureStore.etebase_session).toBeUndefined()
      expectNothingPublished()
    })

    it('never removes or replaces a newer session written meanwhile', async () => {
      const controller = new AbortController()
      const write = deferNextSessionWrite()
      const signup = startOwnerSignup(controller.signal)
      await write.writeStarted
      await secureSet('etebase_session', 'newer-session')
      controller.abort()
      write.release()
      await expect(signup).rejects.toMatchObject({ name: 'AbortError' })
      expect(secureStore.etebase_session).toBe('newer-session')
      expectNothingPublished()
    })

    it('still persists and publishes when not aborted', async () => {
      const controller = new AbortController()
      const write = deferNextSessionWrite()
      const signup = startOwnerSignup(controller.signal)
      await write.writeStarted
      expect(useAuthStore.getState().pendingSignup).toBeNull()
      write.release()
      await signup
      expect(secureStore.etebase_session).toBe('mock-saved-session')
      expect(localStorage.getItem('silentsuite-server-url')).toBe(serverUrl)
      expect(sessionStorage.getItem('silentsuite-signup-in-progress')).toBe('true')
      expect(useAuthStore.getState().pendingSignup).toMatchObject({
        email: 'owner@example.test', serverUrl, etebaseAccountReady: true,
      })
    })
  })

  it('keeps custom-server signup and finalization out of hosted Billing', async () => {
    const customServerUrl = 'https://sync.example.test'
    const { issueBillingLinkProof } = await import('@/app/lib/etebase-auth')
    vi.mocked(issueBillingLinkProof).mockClear()

    useAuthStore.getState().prepareSignupDraft('custom@example.com', false)
    await useAuthStore.getState().createEtebaseAccount(
      'custom@example.com',
      'password123',
      customServerUrl,
    )
    const result = await useAuthStore.getState().signup('early_monthly', '7day')

    expect(result).toEqual({
      clientSecret: null,
      cryptoCheckoutUrl: null,
      cryptoInvoiceId: null,
      cryptoInvoiceLookupToken: null,
      paymentSessionToken: null,
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(issueBillingLinkProof).not.toHaveBeenCalled()
    expect(localStorage.getItem('silentsuite-server-url')).toBe(customServerUrl)
    expect(useAuthStore.getState().pendingSignup).toMatchObject({
      serverUrl: customServerUrl,
      provisionedUser: { id: 'self-hosted', planId: 'self-hosted', isAdmin: true },
    })

    useAuthStore.setState({
      pendingSignup: {
        ...useAuthStore.getState().pendingSignup!,
        paymentSessionToken: 'must-not-be-sent',
      },
    })
    await expect(useAuthStore.getState().finalizePaidSignup())
      .rejects.toThrow('Paid signup is not available for custom servers')
    expect(fetch).not.toHaveBeenCalled()
    expect(issueBillingLinkProof).not.toHaveBeenCalled()
  })

  describe('annual v2 paid-signup recovery', () => {
    const checkoutIntentToken = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
    const stripePayment = (recoveryToken: string) => ({
      contractVersion: 2,
      kind: 'stripe',
      clientSecret: 'pi_secret',
      paymentSessionToken: recoveryToken,
    })
    const bitcoinPayment = (recoveryToken: string) => ({
      contractVersion: 2,
      kind: 'btcpay',
      cryptoCheckoutUrl: 'https://btcpay.silentsuite.io/i/inv_123',
      cryptoInvoiceId: 'inv_123',
      cryptoInvoiceLookupToken: recoveryToken,
      paymentSessionToken: recoveryToken,
    })

    function startAnnualPayment(provider: 'stripe' | 'btcpay' = 'stripe') {
      return useAuthStore.getState().startAnnualSignupPayment(
        checkoutIntentToken,
        provider,
        'http://localhost:3000/signup/return', 'annual',
      )
    }

    it('uses a closed v2 Stripe payment request and keeps the recovery capability out of client pricing input', async () => {
      useAuthStore.getState().prepareSignupDraft('paid@example.com', false, true)
      vi.mocked(fetch).mockImplementation(async (_input, init) => {
        const body = JSON.parse(String(init?.body))
        return new Response(JSON.stringify(stripePayment(body.recoverySecret)))
      })

      const result = await startAnnualPayment()
      const body = paidSignupRequestBody()

      expect(result).toEqual({
        clientSecret: 'pi_secret',
        cryptoCheckoutUrl: null,
        cryptoInvoiceId: null,
        cryptoInvoiceLookupToken: null,
        paymentSessionToken: body.recoverySecret,
      })
      expect(body).toEqual({
        contractVersion: 2,
        checkoutIntentToken,
        email: 'paid@example.com',
        requestKey: expect.stringMatching(UUID_PATTERN),
        recoverySecret: expect.stringMatching(RECOVERY_TOKEN_PATTERN),
        wantsProductUpdates: false,
        rememberDevice: true,
        returnUrl: 'http://localhost:3000/signup/return',
      })
      expect(JSON.stringify(body)).not.toMatch(/planId|amount|customerClass|promo|trialPath/)
      expect(useAuthStore.getState().pendingSignup).toMatchObject({
        billingContractVersion: 2,
        paymentMethod: 'stripe',
        paymentSessionToken: body.recoverySecret,
        paymentSessionRequestKey: body.requestKey,
      })
    })

    it.each(['stripe', 'btcpay'] as const)('retains exact %s recovery before dispatch and after a lost start response', async (provider) => {
      useAuthStore.getState().prepareSignupDraft('lost@example.com')
      vi.mocked(fetch).mockImplementation(async (_input, init) => {
        const body = JSON.parse(String(init?.body))
        expect(useAuthStore.getState().pendingSignup).toMatchObject({
          billingContractVersion: 2, paymentMethod: provider,
          paymentSessionToken: body.recoverySecret, paymentSessionRequestKey: body.requestKey,
        })
        throw new TypeError('Network response lost')
      })
      await expect(startAnnualPayment(provider)).rejects.toThrow('Network response lost')
      const first = paidSignupRequestBody()
      expect(useAuthStore.getState().pendingSignup).toMatchObject({
        email: 'lost@example.com', paymentMethod: provider,
        paymentSessionToken: first.recoverySecret, paymentSessionRequestKey: first.requestKey,
      })
      expect(useAuthStore.getState().pendingSignup?.provisionedUser).toBeUndefined()
      await expect(startAnnualPayment(provider)).rejects.toThrow('Network response lost')
      expect(paidSignupRequestBody(1)).toEqual(first)
      expect(persistedPaidSignupIdentities()).toHaveLength(1)
    })

    it('rejects cross-origin annual return URLs before contacting Billing', async () => {
      useAuthStore.getState().prepareSignupDraft('origin@example.com')
      await expect(useAuthStore.getState().startAnnualSignupPayment(
        checkoutIntentToken, 'stripe', 'https://attacker.example/return', 'annual',
      )).rejects.toThrow('must stay on this origin')
      expect(fetch).not.toHaveBeenCalled()
    })

    it('cannot resurrect a logged-out attempt from a late payment response', async () => {
      useAuthStore.getState().prepareSignupDraft('logout@example.test')
      let deliver!: (response: Response) => void
      let recoverySecret = ''
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        if (String(input).endsWith('/auth/session')) return new Response('{}')
        recoverySecret = JSON.parse(String(init?.body)).recoverySecret
        return new Promise<Response>((resolve) => { deliver = resolve })
      })
      const pending = startAnnualPayment().catch((error) => error as Error)
      expect(sessionStorage.getItem('silentsuite-signup-redirect-state')).not.toBeNull()
      await useAuthStore.getState().logout()
      deliver(new Response(JSON.stringify(stripePayment(recoverySecret))))
      expect(await pending).toBeInstanceOf(Error)
      expect(useAuthStore.getState().pendingSignup).toBeNull()
      expect(sessionStorage.getItem('silentsuite-signup-redirect-state')).toBeNull()
      expect(persistedPaidSignupIdentities()).toHaveLength(0)
    })

    it('does not commit an in-flight authority into a superseding signup draft', async () => {
      useAuthStore.getState().prepareSignupDraft('first@example.com', false, false)
      let resolvePayment!: (response: Response) => void
      vi.mocked(fetch).mockImplementation(async () => new Promise<Response>((resolve) => { resolvePayment = resolve }))
      const payment = startAnnualPayment()
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
      useAuthStore.getState().prepareSignupDraft('second@example.com', true, true)
      const body = paidSignupRequestBody()
      resolvePayment(new Response(JSON.stringify(stripePayment(String(body.recoverySecret)))))

      await expect(payment).rejects.toThrow('Signup was superseded')
      expect(useAuthStore.getState().pendingSignup).toMatchObject({ email: 'second@example.com' })
      expect(useAuthStore.getState().pendingSignup?.paymentSessionToken).toBeUndefined()
    })

    it('does not let an older same-scope payment response replace a newer attempt', async () => {
      useAuthStore.getState().prepareSignupDraft('same@example.com', false, false)
      const resolvers: Array<(response: Response) => void> = []
      vi.mocked(fetch).mockImplementation(async () => new Promise<Response>((resolve) => { resolvers.push(resolve) }))
      const first = startAnnualPayment()
      await vi.waitFor(() => expect(resolvers).toHaveLength(1))
      const second = startAnnualPayment()
      await vi.waitFor(() => expect(resolvers).toHaveLength(2))
      const secondBody = paidSignupRequestBody(1)
      resolvers[1](new Response(JSON.stringify(stripePayment(String(secondBody.recoverySecret)))))
      await second
      const firstBody = paidSignupRequestBody(0)
      resolvers[0](new Response(JSON.stringify(stripePayment(String(firstBody.recoverySecret)))))
      await expect(first).rejects.toThrow('Signup was superseded')
      expect(useAuthStore.getState().pendingSignup?.paymentSessionToken).toBe(secondBody.recoverySecret)
    })

    it('accepts only a complete v2 BTCPay continuation bound to the recovery capability', async () => {
      useAuthStore.getState().prepareSignupDraft('bitcoin@example.com')
      vi.mocked(fetch).mockImplementation(async (_input, init) => {
        const body = JSON.parse(String(init?.body))
        return new Response(JSON.stringify(bitcoinPayment(body.recoverySecret)))
      })

      const result = await startAnnualPayment('btcpay')
      const body = paidSignupRequestBody()

      expect(result).toEqual({
        clientSecret: null,
        cryptoCheckoutUrl: 'https://btcpay.silentsuite.io/i/inv_123',
        cryptoInvoiceId: 'inv_123',
        cryptoInvoiceLookupToken: body.recoverySecret,
        paymentSessionToken: body.recoverySecret,
      })
      expect(body).not.toHaveProperty('provider')
      expect(useAuthStore.getState().pendingSignup?.paymentMethod).toBe('btcpay')
    })

    it('fails closed on an incomplete provider response and reuses the same v2 capability on a retry', async () => {
      useAuthStore.getState().prepareSignupDraft('retry@example.com')
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 2, kind: 'stripe', clientSecret: 'pi_secret' })))
        .mockImplementationOnce(async (_input, init) => {
          const body = JSON.parse(String(init?.body))
          return new Response(JSON.stringify(stripePayment(body.recoverySecret)))
        })

      await expect(startAnnualPayment()).rejects.toThrow('valid payment session')
      const first = paidSignupRequestBody(0)
      expect(persistedPaidSignupIdentities()).toHaveLength(1)

      await startAnnualPayment()
      const retry = paidSignupRequestBody(1)
      expect(retry.requestKey).toBe(first.requestKey)
      expect(retry.recoverySecret).toBe(first.recoverySecret)
    })

    it('retains a retry capability for an ambiguous transport failure but isolates distinct email scopes', async () => {
      useAuthStore.getState().prepareSignupDraft('first@example.com')
      vi.mocked(fetch)
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockImplementation(async (_input, init) => {
          const body = JSON.parse(String(init?.body))
          return new Response(JSON.stringify(stripePayment(body.recoverySecret)))
        })

      await expect(startAnnualPayment()).rejects.toThrow('Failed to fetch')
      const first = paidSignupRequestBody(0)

      useAuthStore.getState().prepareSignupDraft('second@example.com')
      await startAnnualPayment()
      const second = paidSignupRequestBody(1)

      useAuthStore.getState().prepareSignupDraft('first@example.com')
      await startAnnualPayment()
      const recovered = paidSignupRequestBody(2)

      expect(second.requestKey).not.toBe(first.requestKey)
      expect(second.recoverySecret).not.toBe(first.recoverySecret)
      expect(recovered.requestKey).toBe(first.requestKey)
      expect(recovered.recoverySecret).toBe(first.recoverySecret)
    })

    it('rotates the capability when privacy preferences change its v2 recovery scope', async () => {
      useAuthStore.getState().prepareSignupDraft('preferences@example.com', true, false)
      vi.mocked(fetch).mockImplementation(async (_input, init) => {
        const body = JSON.parse(String(init?.body))
        return new Response(JSON.stringify(stripePayment(body.recoverySecret)))
      })

      await startAnnualPayment()
      const optedIn = paidSignupRequestBody(0)

      useAuthStore.getState().prepareSignupDraft('preferences@example.com', false, false)
      await startAnnualPayment()
      const optedOut = paidSignupRequestBody(1)

      expect(optedOut.wantsProductUpdates).toBe(false)
      expect(optedOut.requestKey).not.toBe(optedIn.requestKey)
      expect(optedOut.recoverySecret).not.toBe(optedIn.recoverySecret)
    })

    // C1 W3: with the opt-in removed, a draft never becomes an implicit opt-in
    // on the wire, while paidSignupRecoveryScope stays byte-identical (an
    // absent preference keeps its historical `true` scope).
    it('never sends an implicit product-updates opt-in and keeps the historical recovery scope', async () => {
      vi.mocked(fetch).mockImplementation(async (_input, init) => {
        const body = JSON.parse(String(init?.body))
        return new Response(JSON.stringify(stripePayment(body.recoverySecret)))
      })
      useAuthStore.getState().prepareSignupDraft('implicit@example.com')
      await startAnnualPayment()
      useAuthStore.getState().prepareSignupDraft('explicit@example.com', false, false)
      await startAnnualPayment()
      useAuthStore.getState().prepareSignupDraft('historical@example.com', true, false)
      await startAnnualPayment()

      expect([0, 1, 2].map(index => paidSignupRequestBody(index).wantsProductUpdates)).toEqual([false, false, true])
      const scopes = Object.keys(JSON.parse(sessionStorage.getItem('silentsuite-paid-signup-recovery')!).identities).map(scope => JSON.parse(scope))
      expect(scopes).toEqual(expect.arrayContaining([
        { email: 'implicit@example.com', contractVersion: 2, wantsProductUpdates: true, rememberDevice: false },
        { email: 'explicit@example.com', contractVersion: 2, wantsProductUpdates: false, rememberDevice: false },
        { email: 'historical@example.com', contractVersion: 2, wantsProductUpdates: true, rememberDevice: false },
      ]))
    })

    it('clears a completed payment recovery capability before a new signup attempt', async () => {
      useAuthStore.getState().prepareSignupDraft('completed@example.com')
      vi.mocked(fetch)
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockImplementation(async (_input, init) => {
          const body = JSON.parse(String(init?.body))
          return new Response(JSON.stringify(stripePayment(body.recoverySecret)))
        })

      await expect(startAnnualPayment()).rejects.toThrow('Failed to fetch')
      const oldAttempt = paidSignupRequestBody(0)
      useAuthStore.setState({
        pendingSignup: {
          email: 'completed@example.com',
          billingSessionUserId: 'user-1',
          provisionedUser: { id: 'user-1', planId: 'early_annual', isAdmin: false },
          provisionedSubscriptionStatus: 'active',
        },
      })
      useAuthStore.getState().completeSignup()

      useAuthStore.getState().prepareSignupDraft('completed@example.com')
      await startAnnualPayment()
      const nextAttempt = paidSignupRequestBody(1)

      expect(nextAttempt.requestKey).not.toBe(oldAttempt.requestKey)
      expect(nextAttempt.recoverySecret).not.toBe(oldAttempt.recoverySecret)
    })

    it.each(['stripe', 'btcpay'] as const)('switches %s only after an exact release using the real store and client', async provider => {
      useAuthStore.getState().prepareSignupDraft('switch@example.com')
      vi.mocked(fetch).mockImplementation(async (_input, init) => {
        const body = JSON.parse(String(init?.body))
        return new Response(JSON.stringify(provider === 'stripe' ? stripePayment(body.recoverySecret) : bitcoinPayment(body.recoverySecret)))
      })
      await startAnnualPayment(provider)
      const pending = useAuthStore.getState().pendingSignup!
      const originalToken = pending.paymentSessionToken
      const onReleased = vi.fn()
      const { PaymentBackModal } = await import('../../(auth)/signup/components/payment-back-modal')
      render(createElement(PaymentBackModal, { provider, onReleased, onStay: vi.fn() }))
      vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 2, state: 'closed', flow: null })))
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Cancel and go back' }))
      await screen.findByRole('alert')
      // The destructive choice itself is the affirmative no-funds acknowledgement for Bitcoin.
      const cancelBody = JSON.parse(String(vi.mocked(fetch).mock.calls.at(-1)![1]?.body))
      expect(cancelBody).toMatchObject({ switchingProfile: 'v1', requestKey: pending.paymentSessionRequestKey, ...(provider === 'btcpay' ? { confirmNoBitcoinSent: true } : {}) })
      if (provider === 'stripe') expect(cancelBody).not.toHaveProperty('confirmNoBitcoinSent')
      expect(useAuthStore.getState().pendingSignup?.paymentSessionToken).toBe(originalToken)
      expect(onReleased).not.toHaveBeenCalled()
      vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 2, state: 'released', flow: { provider, status: 'reconciliation_required' }, release: { requestKey: pending.paymentSessionRequestKey, provider, providerObjectId: 'exact' } })))
      fireEvent.click(screen.getByRole('button', { name: 'Retry cancellation' }))
      await waitFor(() => expect(onReleased).toHaveBeenCalledTimes(1))
      expect(useAuthStore.getState().pendingSignup?.paymentSessionToken).toBeUndefined()
      expect(sessionStorage.getItem('silentsuite-signup-redirect-state') ?? '').not.toContain(originalToken!)
      expect(useAuthStore.getState().pendingSignup?.email).toBe(pending.email)
      cleanup()
    })

    it('atomically releases only a verified terminal Bitcoin identity before a fresh invoice claim', async () => {
      useAuthStore.getState().prepareSignupDraft('bitcoin-terminal@example.com')
      vi.mocked(fetch).mockImplementation(async (_input, init) => {
        const body = JSON.parse(String(init?.body))
        return new Response(JSON.stringify(bitcoinPayment(body.recoverySecret)))
      })

      await startAnnualPayment('btcpay')
      const closedAttempt = paidSignupRequestBody(0)
      const pending = useAuthStore.getState().pendingSignup!

      ;(useAuthStore.getState().clearPendingSignupPaymentRecovery as unknown as (identity: {
        email: string
        requestKey: string
        recoverySecret: string
        wantsProductUpdates?: boolean
        rememberDevice?: boolean
      }) => void)({
        email: pending.email,
        requestKey: String(pending.paymentSessionRequestKey),
        recoverySecret: String(pending.paymentSessionToken),
        wantsProductUpdates: pending.wantsProductUpdates,
        rememberDevice: pending.rememberDevice,
      })

      expect(useAuthStore.getState().pendingSignup).toMatchObject({
        email: 'bitcoin-terminal@example.com',
        paymentSessionToken: undefined,
        paymentSessionRequestKey: undefined,
        paymentMethod: undefined,
      })
      expect(persistedPaidSignupIdentities()).toEqual([])

      await startAnnualPayment('btcpay')
      const restartedAttempt = paidSignupRequestBody(1)
      expect(restartedAttempt.requestKey).not.toBe(closedAttempt.requestKey)
      expect(restartedAttempt.recoverySecret).not.toBe(closedAttempt.recoverySecret)
    })

    it('will not let a stale terminal caller erase a replacement paid-signup identity', async () => {
      useAuthStore.getState().prepareSignupDraft('racing-bitcoin@example.com')
      vi.mocked(fetch).mockImplementation(async (_input, init) => {
        const body = JSON.parse(String(init?.body))
        return new Response(JSON.stringify(bitcoinPayment(body.recoverySecret)))
      })

      await startAnnualPayment('btcpay')
      const staleAttempt = paidSignupRequestBody(0)
      const replacement = {
        requestKey: '5fd4d86d-34de-4b82-9a66-9598ddf6e02f',
        recoverySecret: 'B'.repeat(43),
      }
      const scope = JSON.stringify({
        email: 'racing-bitcoin@example.com',
        contractVersion: 2,
        wantsProductUpdates: true,
        rememberDevice: false,
      })
      sessionStorage.setItem('silentsuite-paid-signup-recovery', JSON.stringify({
        version: 1,
        identities: { [scope]: { scope, ...replacement } },
      }))
      useAuthStore.setState({
        pendingSignup: {
          ...useAuthStore.getState().pendingSignup!,
          paymentSessionToken: replacement.recoverySecret,
          paymentSessionRequestKey: replacement.requestKey,
        },
      })

      ;(useAuthStore.getState().clearPendingSignupPaymentRecovery as unknown as (identity: {
        email: string
        requestKey: string
        recoverySecret: string
      }) => void)({
        email: 'racing-bitcoin@example.com',
        requestKey: String(staleAttempt.requestKey),
        recoverySecret: String(staleAttempt.recoverySecret),
      })

      expect(useAuthStore.getState().pendingSignup).toMatchObject({
        paymentSessionToken: replacement.recoverySecret,
        paymentSessionRequestKey: replacement.requestKey,
      })
      expect(persistedPaidSignupIdentities()).toEqual([expect.objectContaining(replacement)])
    })

    it('finalizes a v2 payment only from an exact annual completion response', async () => {
      secureStore.etebase_session = 'mock-saved-session'
      useAuthStore.setState({
        pendingSignup: {
          email: 'finalize@example.com',
          paymentSessionToken: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
          billingContractVersion: 2,
        },
      })
      vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
        contractVersion: 2,
        id: '5fd4d86d-34de-4b82-9a66-9598ddf6e02f',
        email: 'finalize@example.com',
        planId: 'early_annual',
        provisioningStatus: 'active',
        emailVerified: true,
        isAdmin: false,
        earlyAdopter: true,
        rememberDevice: false,
        createdAt: '2026-08-11T00:00:00Z',
        clientSecret: null,
        cryptoCheckoutUrl: null,
        cryptoInvoiceId: null,
        cryptoInvoiceLookupToken: null,
      })))

      mockSignupBillingSession('5fd4d86d-34de-4b82-9a66-9598ddf6e02f', 'finalize@example.com')
      await useAuthStore.getState().finalizePaidSignup()

      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/auth/signup/finalize-payment/v2'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            contractVersion: 2,
            etebaseLinkProof: 'mock-link-proof-value-with-at-least-43-characters',
            paymentSessionToken: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
          }),
        }),
      )
      expect(useAuthStore.getState().pendingSignup?.provisionedUser).toEqual({
        id: '5fd4d86d-34de-4b82-9a66-9598ddf6e02f',
        planId: 'early_annual',
        isAdmin: false,
      })
    })

    it('does not commit delayed finalization into a replacement payment capability', async () => {
      secureStore.etebase_session = 'mock-saved-session'
      useAuthStore.setState({ pendingSignup: { email: 'race@example.com', paymentSessionToken: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', paymentSessionRequestKey: '5fd4d86d-34de-4b82-9a66-9598ddf6e02f', billingContractVersion: 2 } })
      let resolveFinalize!: (response: Response) => void
      vi.mocked(fetch).mockImplementation(async () => new Promise<Response>((resolve) => { resolveFinalize = resolve }))
      const finalization = useAuthStore.getState().finalizePaidSignup()
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
      useAuthStore.setState({ pendingSignup: { email: 'race@example.com', paymentSessionToken: 'replacementabcdefghijklmnopqrstuvwxyz012345', paymentSessionRequestKey: 'e91a6d70-0d4e-4352-9bdc-426d1f76d771' } })
      resolveFinalize(new Response(JSON.stringify({ contractVersion: 2, id: '5fd4d86d-34de-4b82-9a66-9598ddf6e02f', email: 'race@example.com', planId: 'early_annual', provisioningStatus: 'active', emailVerified: true, isAdmin: false, earlyAdopter: true, rememberDevice: false, createdAt: '2026-08-11T00:00:00Z', clientSecret: null, cryptoCheckoutUrl: null, cryptoInvoiceId: null, cryptoInvoiceLookupToken: null })))
      await expect(finalization).rejects.toThrow('Signup was superseded')
      expect(useAuthStore.getState().pendingSignup?.paymentSessionToken).toContain('replacement')
      expect(useAuthStore.getState().pendingSignup?.provisionedUser).toBeUndefined()
    })
  })


  it('clears stale payment state when the signup draft email changes', () => {
    useAuthStore.setState({
      pendingSignup: {
        email: 'old@example.com',
        paymentSessionToken: 'old-payment-token',
      },
    })

    useAuthStore.getState().prepareSignupDraft('new@example.com', true)

    expect(useAuthStore.getState().pendingSignup).toEqual({
      email: 'new@example.com',
      wantsProductUpdates: true,
      rememberDevice: false,
    })
  })

  it('finalizes a paid signup payment session after Etebase signup completes', async () => {
    secureStore.etebase_session = 'mock-saved-session'
    useAuthStore.setState({
      pendingSignup: {
        email: 'paid@example.com',
        paymentSessionToken: 'payment-session-token',
      },
    })

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'user-1',
        email: 'paid@example.com',
        planId: 'early_monthly',
        provisioningStatus: 'active',
        isAdmin: true,
        earlyAdopter: false,
        createdAt: '2026-05-20T00:00:00.000Z',
        clientSecret: null,
        cryptoCheckoutUrl: null,
        cryptoInvoiceId: null,
        cryptoInvoiceLookupToken: null,
        emailVerified: false,
      }),
    } as Response)

    mockSignupBillingSession('user-1', 'paid@example.com', true, false)
    await useAuthStore.getState().finalizePaidSignup()

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/auth/signup/finalize-payment'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          etebaseLinkProof: 'mock-link-proof-value-with-at-least-43-characters',
          paymentSessionToken: 'payment-session-token',
        }),
      }),
    )
    expect(useAuthStore.getState().pendingSignup?.provisionedUser).toEqual({
      id: 'user-1',
      planId: 'early_monthly',
      isAdmin: true,
    })
    expect(useAuthStore.getState().pendingSignup?.provisionedSubscriptionStatus).toBe('active')
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
  })

  it('does not finalize paid signup without both session tokens', async () => {
    useAuthStore.setState({
      pendingSignup: {
        email: 'paid@example.com',
      },
    })

    await expect(useAuthStore.getState().finalizePaidSignup()).rejects.toThrow('No completed payment session')
    expect(fetch).not.toHaveBeenCalled()
  })

  // --- onboardedAt hydration (issue #113) ---

  it('refuses fresh hosted v1 signup before any Billing request', async () => {
    useAuthStore.getState().prepareSignupDraft('customer@example.test')
    await expect(useAuthStore.getState().signup('early_annual', '30day')).rejects.toThrow('fresh annual offer')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('starts a v2 annual signup payment without client plan, amount, class, or promotion', async () => {
    useAuthStore.getState().prepareSignupDraft('customer@example.test', true, false)
    vi.mocked(fetch).mockImplementationOnce(async (_input, init) => {
      const request = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
        contractVersion: 2,
        kind: 'stripe',
        clientSecret: 'pi_secret',
        paymentSessionToken: request.recoverySecret,
      }))
    })
    const result = await useAuthStore.getState().startAnnualSignupPayment('abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', 'stripe', 'http://localhost:3000/signup/success', 'annual')
    expect(result.clientSecret).toBe('pi_secret')
    const [, init] = vi.mocked(fetch).mock.calls[0]
    expect(JSON.parse(String(init?.body))).toMatchObject({ contractVersion: 2, checkoutIntentToken: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', email: 'customer@example.test' })
    expect(JSON.parse(String(init?.body))).not.toHaveProperty('provider')
    expect(String(init?.body)).not.toMatch(/planId|amount|customerClass|promo/)
  })

  it('recovers no-card provisioning after account creation and an ambiguous Billing failure', async () => {
    const { etebaseSignUp, etebaseLogIn } = await import('@/app/lib/etebase-auth')
    useAuthStore.getState().prepareSignupDraft('recover-no-card@example.test', true, false)
    await useAuthStore.getState().createEtebaseAccount('recover-no-card@example.test', 'password123')
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'temporary failure' }), { status: 503 }))
    await expect(useAuthStore.getState().provisionAnnualNoCard('abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG')).rejects.toMatchObject({ billingStatus: 503 })

    const signupCalls = vi.mocked(etebaseSignUp).mock.calls.length
    const loginCalls = vi.mocked(etebaseLogIn).mock.calls.length
    await useAuthStore.getState().createEtebaseAccount('recover-no-card@example.test', 'password123')
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      contractVersion: 2, id: '5fd4d86d-34de-4b82-9a66-9598ddf6e02f', email: 'recover-no-card@example.test',
      provisioningStatus: 'trialing_no_card', emailVerified: true, earlyAdopter: true, rememberDevice: false,
      createdAt: '2026-08-11T00:00:00Z', clientSecret: null, cryptoCheckoutUrl: null,
      cryptoInvoiceId: null, cryptoInvoiceLookupToken: null,
    })))
    mockSignupBillingSession('5fd4d86d-34de-4b82-9a66-9598ddf6e02f', 'recover-no-card@example.test')
    await useAuthStore.getState().provisionAnnualNoCard('abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG')

    expect(etebaseSignUp).toHaveBeenCalledTimes(signupCalls)
    expect(etebaseLogIn).toHaveBeenCalledTimes(loginCalls + 1)
    expect(useAuthStore.getState().pendingSignup?.provisionedUser?.id).toBe('5fd4d86d-34de-4b82-9a66-9598ddf6e02f')
  })

  it('recovers paid finalization after account creation and an ambiguous Billing failure', async () => {
    const { etebaseSignUp, etebaseLogIn } = await import('@/app/lib/etebase-auth')
    useAuthStore.setState({ pendingSignup: {
      email: 'recover-paid@example.test', billingContractVersion: 2,
      paymentSessionToken: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
      paymentSessionRequestKey: '7823121e-8f4a-45ac-a217-82ba93209ca2',
    } })
    await useAuthStore.getState().createEtebaseAccount('recover-paid@example.test', 'password123')
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'temporary failure' }), { status: 503 }))
    await expect(useAuthStore.getState().finalizePaidSignup()).rejects.toThrow('temporary failure')

    const signupCalls = vi.mocked(etebaseSignUp).mock.calls.length
    const loginCalls = vi.mocked(etebaseLogIn).mock.calls.length
    await useAuthStore.getState().createEtebaseAccount('recover-paid@example.test', 'password123')
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      contractVersion: 2, id: '5fd4d86d-34de-4b82-9a66-9598ddf6e02f', email: 'recover-paid@example.test',
      planId: 'early_annual', provisioningStatus: 'active', emailVerified: true, earlyAdopter: true,
      rememberDevice: false, isAdmin: false, createdAt: '2026-08-11T00:00:00Z', clientSecret: null,
      cryptoCheckoutUrl: null, cryptoInvoiceId: null, cryptoInvoiceLookupToken: null,
    })))
    mockSignupBillingSession('5fd4d86d-34de-4b82-9a66-9598ddf6e02f', 'recover-paid@example.test')
    await useAuthStore.getState().finalizePaidSignup()

    expect(etebaseSignUp).toHaveBeenCalledTimes(signupCalls)
    expect(etebaseLogIn).toHaveBeenCalledTimes(loginCalls + 1)
    expect(useAuthStore.getState().pendingSignup?.provisionedUser?.planId).toBe('early_annual')
  })

  it('claims a no-card v2 authority without a client plan fallback', async () => {
    secureStore.etebase_session = 'session'
    useAuthStore.getState().prepareSignupDraft('customer@example.test')
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      contractVersion: 2,
      id: '5fd4d86d-34de-4b82-9a66-9598ddf6e02f',
      email: 'customer@example.test',
      provisioningStatus: 'trialing_no_card',
      emailVerified: true,
      earlyAdopter: true,
      rememberDevice: false,
      createdAt: '2026-08-11T00:00:00Z',
      clientSecret: null,
      cryptoCheckoutUrl: null,
      cryptoInvoiceId: null,
      cryptoInvoiceLookupToken: null,
    })))
    mockSignupBillingSession('5fd4d86d-34de-4b82-9a66-9598ddf6e02f', 'customer@example.test')
    await useAuthStore.getState().provisionAnnualNoCard('abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG')
    expect(useAuthStore.getState().pendingSignup?.provisionedUser?.planId).toBeNull()
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toMatchObject({ contractVersion: 2, checkoutIntentToken: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG' })
  })

  it('preserves renewable no-card Problem Details and ignores a stale completion', async () => {
    secureStore.etebase_session = 'session'
    useAuthStore.getState().prepareSignupDraft('first@example.test')
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ type: 'https://api.silentsuite.io/errors/plan-not-purchasable', detail: 'Offer expired' }), { status: 409 }))
    await expect(useAuthStore.getState().provisionAnnualNoCard('abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG')).rejects.toMatchObject({ billingStatus: 409, billingProblemType: 'https://api.silentsuite.io/errors/plan-not-purchasable' })

    let resolveProvision!: (response: Response) => void
    vi.mocked(fetch).mockImplementationOnce(async () => new Promise<Response>((resolve) => { resolveProvision = resolve }))
    const stale = useAuthStore.getState().provisionAnnualNoCard('abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    useAuthStore.getState().prepareSignupDraft('second@example.test')
    resolveProvision(new Response(JSON.stringify({ contractVersion: 2, id: '5fd4d86d-34de-4b82-9a66-9598ddf6e02f', email: 'first@example.test', provisioningStatus: 'trialing_no_card', emailVerified: true, earlyAdopter: true, rememberDevice: false, createdAt: '2026-08-11T00:00:00Z', clientSecret: null, cryptoCheckoutUrl: null, cryptoInvoiceId: null, cryptoInvoiceLookupToken: null })))
    await expect(stale).rejects.toThrow('Signup was superseded')
    expect(useAuthStore.getState().pendingSignup).toMatchObject({ email: 'second@example.test' })
  })

  describe('onboardedAt hydration', () => {
    it('login hydrates onboardedAt from token-exchange response', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'user-1',
          email: 'a@b.com',
          planId: 'pro',
          isAdmin: false,
          onboardedAt: '2025-01-01T00:00:00.000Z',
        }),
      } as Response)

      await useAuthStore.getState().login('a@b.com', 'pw')

      expect(useAuthStore.getState().user!.onboardedAt).toBe('2025-01-01T00:00:00.000Z')
    })

    it('login defaults onboardedAt to null when omitted', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'user-1', email: 'a@b.com', planId: 'pro', isAdmin: false }),
      } as Response)

      await useAuthStore.getState().login('a@b.com', 'pw')

      expect(useAuthStore.getState().user!.onboardedAt).toBeNull()
    })


    it('login clears unvalidated local auth material when token exchange is rate limited', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 429 } as Response)

      await useAuthStore.getState().login('a@b.com', 'pw')

      expect(useAuthStore.getState().isAuthenticated).toBe(false)
      expect(useAuthStore.getState().error).toBe(
        'Too many sign-in attempts. Please wait a few minutes before trying again. Your encrypted data is safe.',
      )
      expect(secureStore['etebase_session']).toBeUndefined()
      expect(localStorage.getItem('silentsuite-hosted-validation-initialized')).toBeNull()
    })

    it('refreshSession hydrates onboardedAt', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'u1',
          email: 'x@y.com',
          planId: 'free',
          isAdmin: false,
          rememberDevice: true,
          onboardedAt: '2024-12-01T00:00:00.000Z',
        }),
      } as Response)

      await useAuthStore.getState().refreshSession()

      expect(useAuthStore.getState().user!.onboardedAt).toBe('2024-12-01T00:00:00.000Z')
    })

    it('restoreSession hydrates onboardedAt', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'u1',
          email: 'x@y.com',
          planId: 'free',
          isAdmin: false,
          rememberDevice: true,
          onboardedAt: null,
        }),
      } as Response)

      await useAuthStore.getState().restoreSession()

      expect(useAuthStore.getState().user!.onboardedAt).toBeNull()
    })

    it('restoreSession rejects restored session-cookie refresh when the session marker is missing', async () => {
      secureStore['etebase_session'] = 'fake-session-data'
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: 'u1', email: 'x@y.com', planId: 'free', isAdmin: false, rememberDevice: false }),
        } as Response)
        .mockResolvedValueOnce({ ok: true, status: 204 } as Response)

      await useAuthStore.getState().restoreSession()

      const state = useAuthStore.getState()
      expect(state.isAuthenticated).toBe(false)
      expect(state.user).toBeNull()
      expect(secureStore['etebase_session']).toBeUndefined()
      expect(fetch).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('/auth/session'),
        expect.objectContaining({ method: 'DELETE', credentials: 'include' }),
      )
    })


    it('restoreSession accepts a session-cookie refresh when the session marker matches', async () => {
      secureStore['etebase_session'] = 'fake-session-data'
      sessionStorage.setItem('silentsuite-hosted-validation-session', JSON.stringify({ userId: 'u1', rememberDevice: false, validatedAt: Date.now() }))
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'u1', email: 'x@y.com', planId: 'free', isAdmin: false, rememberDevice: false }),
      } as Response)

      await useAuthStore.getState().restoreSession()

      expect(useAuthStore.getState().user).toMatchObject({ id: 'u1', rememberDevice: false })
      expect(fetch).toHaveBeenCalledTimes(1)
    })


    it('restoreSession clears local auth material on unexpected invalid refresh responses', async () => {
      secureStore['etebase_session'] = 'fake-session-data'
      sessionStorage.setItem('silentsuite-hosted-validation-session', JSON.stringify({ userId: 'u1', rememberDevice: false, validatedAt: Date.now() }))
      localStorage.setItem('silentsuite-hosted-validation-initialized', 'true')
      vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 400 } as Response)

      await useAuthStore.getState().restoreSession()

      const state = useAuthStore.getState()
      expect(state.isAuthenticated).toBe(false)
      expect(state.user).toBeNull()
      expect(secureStore['etebase_session']).toBeUndefined()
      expect(sessionStorage.getItem('silentsuite-hosted-validation-session')).toBeNull()
      expect(localStorage.getItem('silentsuite-hosted-validation-initialized')).toBeNull()
    })


    it('restoreSession skips online refresh when local auth is tombstoned', async () => {
      secureStore['etebase_session'] = 'fake-session-data'
      localStorage.setItem('silentsuite-hosted-auth-invalidated', String(Date.now()))

      await useAuthStore.getState().restoreSession()

      expect(useAuthStore.getState().isAuthenticated).toBe(false)
      expect(fetch).not.toHaveBeenCalled()
    })

    it('restoreSession clears unmarked local auth material when restore is rate limited', async () => {
      secureStore['etebase_session'] = 'fake-session-data'
      vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 429 } as Response)

      await useAuthStore.getState().restoreSession()

      expect(useAuthStore.getState().isAuthenticated).toBe(false)
      expect(useAuthStore.getState().subscriptionStatus).toBeNull()
      expect(secureStore['etebase_session']).toBeUndefined()
    })

    it('clearLocalAuthMaterial clears hosted markers even if secure storage clear fails', async () => {
      secureStore['etebase_session'] = 'fake-session-data'
      localStorage.setItem('silentsuite-hosted-validation-initialized', 'true')
      vi.mocked(secureClear).mockRejectedValueOnce(new Error('idb clear failed'))
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: 'u1', email: 'x@y.com', planId: 'free', isAdmin: false, rememberDevice: false }),
        } as Response)
        .mockResolvedValueOnce({ ok: true, status: 204 } as Response)

      await useAuthStore.getState().restoreSession()

      expect(sessionStorage.getItem('silentsuite-hosted-validation-session')).toBeNull()
      expect(localStorage.getItem('silentsuite-hosted-validation-initialized')).toBeNull()
      expect(localStorage.getItem('silentsuite-hosted-validation-active-tabs')).toBeNull()
      expect(localStorage.getItem('silentsuite-hosted-auth-invalidated')).toBeTruthy()
      expect(vi.mocked(secureClear)).toHaveBeenCalled()

      resetStore()
      vi.mocked(fetch).mockReset()
      vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'))
      await useAuthStore.getState().restoreSession()

      expect(useAuthStore.getState().isAuthenticated).toBe(false)
      expect(useAuthStore.getState().subscriptionStatus).not.toBe('billing_unavailable')
    })


    it('restoreSession accepts a session-cookie refresh in a new tab when another active tab is present', async () => {
      secureStore['etebase_session'] = 'fake-session-data'
      sessionStorage.setItem('silentsuite-hosted-tab-id', 'tab-current')
      localStorage.setItem('silentsuite-hosted-validation-active-tabs', JSON.stringify({
        'tab-existing': { userId: 'u1', validatedAt: Date.now() },
      }))
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'u1', email: 'x@y.com', planId: 'free', isAdmin: false, rememberDevice: false }),
      } as Response)

      await useAuthStore.getState().restoreSession()

      const state = useAuthStore.getState()
      expect(state.isAuthenticated).toBe(true)
      expect(state.user).toMatchObject({ id: 'u1', rememberDevice: false })
      expect(secureStore['etebase_session']).toBe('fake-session-data')
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('completeSignup sets onboardedAt to null for fresh accounts', () => {
      useAuthStore.setState({
        pendingSignup: {
          email: 'new@user.com',
          billingSessionUserId: 'new-1',
          provisionedUser: { id: 'new-1', planId: 'pro', isAdmin: false },
          provisionedSubscriptionStatus: 'trialing',
        },
      })

      useAuthStore.getState().completeSignup()

      expect(useAuthStore.getState().user!.onboardedAt).toBeNull()
    })
  })

  // --- markOnboarded action (issue #113) ---

  describe('markOnboarded', () => {
    it('POSTs to /account/onboarded and updates user.onboardedAt on success', async () => {
      useAuthStore.setState({
        user: { id: 'u1', email: 'x@y.com', planId: 'pro', onboardedAt: null },
        isAuthenticated: true,
      })

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ onboardedAt: '2026-05-04T12:00:00.000Z' }),
      } as Response)

      const result = await useAuthStore.getState().markOnboarded()

      expect(result).toBe(true)
      expect(useAuthStore.getState().user!.onboardedAt).toBe('2026-05-04T12:00:00.000Z')
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/account/onboarded'),
        expect.objectContaining({ method: 'POST', credentials: 'include' }),
      )
    })

    it('returns false and leaves onboardedAt null on network failure', async () => {
      useAuthStore.setState({
        user: { id: 'u1', email: 'x@y.com', planId: 'pro', onboardedAt: null },
        isAuthenticated: true,
      })

      vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'))

      const result = await useAuthStore.getState().markOnboarded()

      expect(result).toBe(false)
      // onboardedAt stays null when legacy metadata update fails.
      expect(useAuthStore.getState().user!.onboardedAt).toBeNull()
    })

    it('returns false and leaves onboardedAt null on non-OK response', async () => {
      useAuthStore.setState({
        user: { id: 'u1', email: 'x@y.com', planId: 'pro', onboardedAt: null },
        isAuthenticated: true,
      })

      vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500 } as Response)

      const result = await useAuthStore.getState().markOnboarded()

      expect(result).toBe(false)
      expect(useAuthStore.getState().user!.onboardedAt).toBeNull()
    })

    it('is idempotent: returns true without a network call when already onboarded', async () => {
      useAuthStore.setState({
        user: { id: 'u1', email: 'x@y.com', planId: 'pro', onboardedAt: '2025-01-01T00:00:00.000Z' },
        isAuthenticated: true,
      })

      const result = await useAuthStore.getState().markOnboarded()

      expect(result).toBe(true)
      expect(fetch).not.toHaveBeenCalled()
      // Existing timestamp untouched.
      expect(useAuthStore.getState().user!.onboardedAt).toBe('2025-01-01T00:00:00.000Z')
    })

    it('returns false when there is no user to mark', async () => {
      useAuthStore.setState({ user: null, isAuthenticated: false })

      const result = await useAuthStore.getState().markOnboarded()

      expect(result).toBe(false)
      expect(fetch).not.toHaveBeenCalled()
    })

    it('skips network for self-hosted user and stamps onboardedAt locally', async () => {
      useAuthStore.setState({
        user: { id: 'self-hosted', email: '', planId: 'self-hosted', isAdmin: true, onboardedAt: null },
        isAuthenticated: true,
      })

      const result = await useAuthStore.getState().markOnboarded()

      expect(result).toBe(true)
      expect(fetch).not.toHaveBeenCalled()
      expect(useAuthStore.getState().user!.onboardedAt).toEqual(expect.any(String))
    })
  })

  it('logout clears state and the retained tab payment checkpoint', async () => {
    // Set up logged-in state
    useAuthStore.setState({
      user: { id: 'user-1', email: 'test@example.com', planId: 'pro' },
      isAuthenticated: true,
      pendingSignup: { email: 'test@example.com', paymentSessionToken: 'r'.repeat(43), billingContractVersion: 2 },
    })
    useAuthStore.getState().saveSignupStateForRedirect('annual')
    sessionStorage.setItem('silentsuite-pending-crypto-token', 'r'.repeat(43))
    sessionStorage.setItem('silentsuite-pending-crypto-recovery-context', JSON.stringify({ email: 'test@example.com', requestKey: '5fd4d86d-34de-4b82-9a66-9598ddf6e02f' }))
    expect(sessionStorage.getItem('silentsuite-signup-redirect-state')).not.toBeNull()

    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response)

    await useAuthStore.getState().logout()

    const state = useAuthStore.getState()
    expect(state.user).toBeNull()
    expect(state.isAuthenticated).toBe(false)
    expect(state.pendingSignup).toBeNull()
    expect(state.signupRecoveryDurability).toBe('none')
    expect(sessionStorage.getItem('silentsuite-signup-redirect-state')).toBeNull()
    expect(state.restoreSignupStateFromRedirect({ retainForRecovery: true })).toBeNull()
    expect(sessionStorage.getItem('silentsuite-pending-crypto-token')).toBeNull()
    expect(sessionStorage.getItem('silentsuite-pending-crypto-recovery-context')).toBeNull()
  })

  it('logout clears decrypted account stores before another account can authenticate', async () => {
    useAuthStore.setState({
      user: { id: 'user-1', email: 'test@example.com', planId: 'pro' },
      isAuthenticated: true,
    })
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response)

    await useAuthStore.getState().logout()

    expect(calendarSetState).toHaveBeenCalledWith(expect.objectContaining({ events: [] }))
    expect(taskSetState).toHaveBeenCalledWith(expect.objectContaining({ tasks: [] }))
    expect(contactSetState).toHaveBeenCalledWith(expect.objectContaining({ contacts: [] }))
    expect(noteSetState).toHaveBeenCalledWith(expect.objectContaining({ notes: [] }))
    expect(calendarListSetState).toHaveBeenCalledWith(expect.objectContaining({ defaultCalendarId: 'default' }))
    expect(taskListSetState).toHaveBeenCalledWith(expect.objectContaining({ activeListId: 'all' }))
    expect(contactListSetState).toHaveBeenCalledWith(expect.objectContaining({ activeListId: 'all' }))
    expect(notebookSetState).toHaveBeenCalledWith(expect.objectContaining({ activeListId: 'all' }))
    expect(labelSuggestionsReset).toHaveBeenCalledTimes(1)
    expect(labelColorSetState).toHaveBeenCalledWith({ colors: {} })
    expect(preferencesReset).toHaveBeenCalled()
    expect(preferencesSyncDestroy).toHaveBeenCalled()
  })

  it('logout wipes the local data cache', async () => {
    useAuthStore.setState({
      user: { id: 'user-1', email: 'test@example.com', planId: 'pro' },
      isAuthenticated: true,
    })
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response)

    await useAuthStore.getState().logout()

    expect(dataCacheClearAll).toHaveBeenCalledTimes(1)
  })

  it('logout clears the offline queue', async () => {
    useAuthStore.setState({
      user: { id: 'user-1', email: 'test@example.com', planId: 'pro' },
      isAuthenticated: true,
    })
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response)

    await useAuthStore.getState().logout()

    expect(offlineQueueClearAll).toHaveBeenCalledTimes(1)
  })

  it('logout removes every persisted list store, including notebooks', async () => {
    const persistedKeys = [
      'silentsuite-calendar-lists',
      'silentsuite-task-lists',
      'silentsuite-contact-lists',
      'silentsuite-notebooks',
      'silentsuite-label-colors',
    ]
    for (const key of persistedKeys) localStorage.setItem(key, '{"state":{"lists":[{"id":"private"}]}}')
    useAuthStore.setState({
      user: { id: 'user-1', email: 'test@example.com', planId: 'pro' },
      isAuthenticated: true,
    })
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response)

    await useAuthStore.getState().logout()

    for (const key of persistedKeys) expect(localStorage.getItem(key)).toBeNull()
  })

  it('removes persisted notebooks even when the in-memory reset fails', async () => {
    localStorage.setItem('silentsuite-notebooks', '{"state":{"lists":[{"id":"private"}]}}')
    notebookSetState.mockImplementationOnce(() => {
      throw new Error('notebook reset failed')
    })
    useAuthStore.setState({
      user: { id: 'user-1', email: 'test@example.com', planId: 'pro' },
      isAuthenticated: true,
    })
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response)

    await useAuthStore.getState().logout()

    expect(localStorage.getItem('silentsuite-notebooks')).toBeNull()
  })

  it('login clears the offline queue after Etebase credentials succeed but before storing a new session', async () => {
    const { secureSet } = await import('@/app/lib/secure-storage')
    vi.mocked(secureSet).mockClear()
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: 'user-1', email: 'test@example.com', planId: 'pro', isAdmin: false }),
    } as Response)

    await useAuthStore.getState().login('test@example.com', 'password123')

    expect(offlineQueueClearAll).toHaveBeenCalledTimes(1)
    expect(secureSet).toHaveBeenCalledWith('etebase_session', 'mock-saved-session')
    expect(offlineQueueClearAll.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(secureSet).mock.invocationCallOrder[0],
    )
    expect(secureStore.etebase_session).toBe('mock-saved-session')
  })

  it('login records a redacted Etebase session persistence diagnostic after storing the session', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: 'user-1', email: 'test@example.com', planId: 'pro', isAdmin: false }),
    } as Response)

    await useAuthStore.getState().login('test@example.com', 'password123')

    const raw = sessionStorage.getItem('silentsuite.restore-diagnostics.v1') ?? ''
    expect(raw).toContain('"phase":"sessionPersistence"')
    expect(raw).toContain('"roundtripMatch":true')
    expect(raw).not.toContain('mock-saved-session')
    expect(raw).not.toContain('test@example.com')
  })

  it('login still succeeds if the best-effort persistence diagnostic read fails', async () => {
    const { secureGet } = await import('@/app/lib/secure-storage')
    vi.mocked(secureGet).mockRejectedValueOnce(new Error('diagnostic read failed'))
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: 'user-1', email: 'test@example.com', planId: 'pro', isAdmin: false }),
    } as Response)

    await useAuthStore.getState().login('test@example.com', 'password123')

    expect(useAuthStore.getState().isAuthenticated).toBe(true)
    expect(useAuthStore.getState().error).toBeNull()
  })

  it('login does not clear the current offline queue when Etebase authentication fails', async () => {
    const { etebaseLogIn } = await import('@/app/lib/etebase-auth')
    vi.mocked(etebaseLogIn).mockRejectedValueOnce(new Error('unauthorized'))

    await useAuthStore.getState().login('test@example.com', 'wrong-password')

    expect(offlineQueueClearAll).not.toHaveBeenCalled()
    expect(secureStore.etebase_session).toBeUndefined()
    expect(useAuthStore.getState().error).toBe('Invalid email or password. Please try again.')
  })

  it('login gives calm retry guidance when Etebase throttles sign-in', async () => {
    const { etebaseLogIn } = await import('@/app/lib/etebase-auth')
    vi.mocked(etebaseLogIn).mockRejectedValueOnce(new Error('Too many attempts'))

    await useAuthStore.getState().login('test@example.com', 'password123')

    expect(fetch).not.toHaveBeenCalled()
    expect(useAuthStore.getState().error).toBe(
      'Too many sign-in attempts. Please wait a few minutes before trying again. Your encrypted data is safe.',
    )
  })

  it('login does not surface unmapped raw Etebase errors', async () => {
    const { etebaseLogIn } = await import('@/app/lib/etebase-auth')
    vi.mocked(etebaseLogIn).mockRejectedValueOnce(new Error('internal provider detail: req-123'))

    await useAuthStore.getState().login('test@example.com', 'password123')

    expect(fetch).not.toHaveBeenCalled()
    expect(useAuthStore.getState().error).toBe('Login failed. Please try again.')
  })

  it('unlock gives calm retry guidance when Etebase sign-in is temporarily unavailable', async () => {
    const { etebaseLogIn } = await import('@/app/lib/etebase-auth')
    vi.mocked(etebaseLogIn).mockRejectedValueOnce(new Error('network timeout'))
    useAuthStore.setState({
      user: { id: 'user-1', email: 'test@example.com', planId: 'pro', isAdmin: false, onboardedAt: null },
      isAuthenticated: true,
    })

    await useAuthStore.getState().unlockEtebaseSession('test@example.com', 'password123')

    expect(secureStore.etebase_session).toBeUndefined()
    expect(useAuthStore.getState().error).toBe(
      'Sign-in is temporarily unavailable. Please wait a minute and try again. Your encrypted data is safe.',
    )
  })

  it('logout still completes when the data-cache wipe throws', async () => {
    useAuthStore.setState({
      user: { id: 'user-1', email: 'test@example.com', planId: 'pro' },
      isAuthenticated: true,
    })
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response)
    dataCacheClearAll.mockRejectedValueOnce(new Error('idb went sideways'))

    await useAuthStore.getState().logout()

    const state = useAuthStore.getState()
    expect(state.user).toBeNull()
    expect(state.isAuthenticated).toBe(false)
  })

  it('isReadOnly returns true when subscription is cancelled', () => {
    useAuthStore.setState({ subscriptionStatus: 'cancelled' })
    expect(useAuthStore.getState().isReadOnly()).toBe(true)
  })

  it('isReadOnly returns true when subscription is expired', () => {
    useAuthStore.setState({ subscriptionStatus: 'expired' })
    expect(useAuthStore.getState().isReadOnly()).toBe(true)
  })

  it('isReadOnly returns true when subscription is none', () => {
    useAuthStore.setState({ subscriptionStatus: 'none' })
    expect(useAuthStore.getState().isReadOnly()).toBe(true)
  })

  it('isReadOnly returns false when subscription is active', () => {
    useAuthStore.setState({ subscriptionStatus: 'active' })
    expect(useAuthStore.getState().isReadOnly()).toBe(false)
  })

  it('canWrite is inverse of isReadOnly', () => {
    useAuthStore.setState({ subscriptionStatus: 'active' })
    expect(useAuthStore.getState().canWrite()).toBe(true)

    useAuthStore.setState({ subscriptionStatus: 'cancelled' })
    expect(useAuthStore.getState().canWrite()).toBe(false)
  })

  it('setUser sets user and isAuthenticated', () => {
    useAuthStore.getState().setUser({ id: '1', email: 'a@b.com', planId: 'free' })
    expect(useAuthStore.getState().isAuthenticated).toBe(true)

    useAuthStore.getState().setUser(null)
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(useAuthStore.getState().user).toBeNull()
  })

  // --- Degraded mode tests ---

  describe('degraded mode (billing_unavailable)', () => {
    it('isReadOnly returns false when billing_unavailable', () => {
      useAuthStore.setState({ subscriptionStatus: 'billing_unavailable' })
      expect(useAuthStore.getState().isReadOnly()).toBe(false)
    })

    it('canWrite returns true when billing_unavailable', () => {
      useAuthStore.setState({ subscriptionStatus: 'billing_unavailable' })
      expect(useAuthStore.getState().canWrite()).toBe(true)
    })

    it('isDegraded returns true when billing_unavailable', () => {
      useAuthStore.setState({ subscriptionStatus: 'billing_unavailable' })
      expect(useAuthStore.getState().isDegraded()).toBe(true)
    })

    it('isDegraded returns false when active', () => {
      useAuthStore.setState({ subscriptionStatus: 'active' })
      expect(useAuthStore.getState().isDegraded()).toBe(false)
    })

    it('restoreSession enters degraded mode on network error with etebase session and validation marker', async () => {
      secureStore['etebase_session'] = 'fake-session-data'
      sessionStorage.setItem('silentsuite-hosted-validation-session', JSON.stringify({ userId: 'user-1', rememberDevice: false, validatedAt: Date.now() }))
      vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'))

      await useAuthStore.getState().restoreSession()

      const state = useAuthStore.getState()
      expect(state.isAuthenticated).toBe(true)
      expect(state.subscriptionStatus).toBe('billing_unavailable')
      // Degraded users keep a non-null legacy onboardedAt timestamp for
      // backward compatibility with existing account metadata expectations.
      expect(state.user).toMatchObject({ id: 'user-1', email: '', planId: 'unknown', isAdmin: false })
      expect(state.user!.onboardedAt).toEqual(expect.any(String))
    })


    it('restoreSession does not trust unmarked legacy local sessions on first offline load', async () => {
      secureStore['etebase_session'] = 'fake-session-data'
      vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'))

      await useAuthStore.getState().restoreSession()

      const state = useAuthStore.getState()
      expect(state.isAuthenticated).toBe(false)
      expect(state.user).toBeNull()
      expect(state.subscriptionStatus).toBeNull()
      expect(secureStore['etebase_session']).toBeUndefined()
    })

    it('restoreSession preserves local data in an offline new tab while another session tab is active', async () => {
      secureStore['etebase_session'] = 'fake-session-data'
      sessionStorage.setItem('silentsuite-hosted-tab-id', 'tab-current')
      localStorage.setItem('silentsuite-hosted-validation-initialized', 'true')
      localStorage.setItem('silentsuite-hosted-validation-active-tabs', JSON.stringify({
        'tab-existing': { userId: 'u1', validatedAt: Date.now() },
      }))
      vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'))

      await useAuthStore.getState().restoreSession()

      const state = useAuthStore.getState()
      expect(state.isAuthenticated).toBe(true)
      expect(state.subscriptionStatus).toBe('billing_unavailable')
      expect(state.user).toMatchObject({ id: 'u1', rememberDevice: false })
      expect(secureStore['etebase_session']).toBe('fake-session-data')
    })

    it('restoreSession clears stale local auth after validation has initialized and no marker is present', async () => {
      secureStore['etebase_session'] = 'fake-session-data'
      localStorage.setItem('silentsuite-hosted-validation-initialized', 'true')
      vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'))

      await useAuthStore.getState().restoreSession()

      const state = useAuthStore.getState()
      expect(state.isAuthenticated).toBe(false)
      expect(state.user).toBeNull()
      expect(state.subscriptionStatus).not.toBe('billing_unavailable')
      expect(secureStore['etebase_session']).toBeUndefined()
    })

    it('restoreSession does not enter degraded mode on network error without etebase session', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'))

      await useAuthStore.getState().restoreSession()

      const state = useAuthStore.getState()
      expect(state.isAuthenticated).toBe(false)
      expect(state.user).toBeNull()
    })

    it('restoreSession does NOT enter degraded mode on 401 response', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 401 } as Response)

      await useAuthStore.getState().restoreSession()

      const state = useAuthStore.getState()
      expect(state.isAuthenticated).toBe(false)
      expect(state.subscriptionStatus).not.toBe('billing_unavailable')
    })

    it('fetchSubscription sets billing_unavailable on network error when no existing status', async () => {
      // fetchSubscription only sets billing_unavailable when current status is null/falsy
      useAuthStore.setState({ subscriptionStatus: null })
      vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'))

      await useAuthStore.getState().fetchSubscription()

      expect(useAuthStore.getState().subscriptionStatus).toBe('billing_unavailable')
    })

    it('fetchSubscription preserves existing good status on network error', async () => {
      // When there's already a good status, network errors don't override it
      useAuthStore.setState({ subscriptionStatus: 'active' })
      vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'))

      await useAuthStore.getState().fetchSubscription()

      expect(useAuthStore.getState().subscriptionStatus).toBe('active')
    })

    it('retryBillingConnection restores normal status on success', async () => {
      useAuthStore.setState({ subscriptionStatus: 'billing_unavailable', isAuthenticated: true })

      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 'u1', email: 'test@x.com', planId: 'pro', isAdmin: false, rememberDevice: true }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ status: 'active' }),
        } as Response)

      const result = await useAuthStore.getState().retryBillingConnection()

      expect(result).toBe(true)
      expect(useAuthStore.getState().subscriptionStatus).toBe('active')
      expect(useAuthStore.getState().isDegraded()).toBe(false)
    })


    // S2b (FINISH-PLAN-v3 §4): these two retry auth-failure tests are rerouted by
    // endpoint and method instead of call index. Old order: refresh ∥ subscription,
    // then DELETE as call #3. New order: refresh, then exactly one DELETE /auth/session,
    // with zero GET /subscription after the refresh is rejected. Business assertions
    // (result, signed out, session cleared, invalidation marker) are unchanged.
    function routeRetryAuthFailure(refresh: () => Response) {
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url.endsWith('/auth/refresh') && method === 'POST') return refresh()
        if (url.endsWith('/subscription') && method === 'GET') return { ok: true, json: async () => ({ status: 'active' }) } as Response
        if (url.endsWith('/auth/session') && method === 'DELETE') return { ok: true, status: 204 } as Response
        throw new Error(`unexpected billing request ${method} ${url}`)
      })
    }
    const callsTo = (suffix: string, method: string) => vi.mocked(fetch).mock.calls
      .filter(([input, init]) => String(input).endsWith(suffix) && (init?.method ?? 'GET') === method)

    it('retryBillingConnection rejects non-remembered refresh when the session marker is missing', async () => {
      secureStore['etebase_session'] = 'fake-session-data'
      useAuthStore.setState({ subscriptionStatus: 'billing_unavailable', isAuthenticated: true })
      routeRetryAuthFailure(() => ({
        ok: true,
        json: async () => ({ id: 'u1', email: 'test@x.com', planId: 'pro', isAdmin: false, rememberDevice: false }),
      } as Response))

      const result = await useAuthStore.getState().retryBillingConnection()

      expect(result).toBe(false)
      expect(useAuthStore.getState().isAuthenticated).toBe(false)
      expect(secureStore['etebase_session']).toBeUndefined()
      expect(callsTo('/auth/session', 'DELETE')).toEqual([
        [expect.stringContaining('/auth/session'), expect.objectContaining({ method: 'DELETE', credentials: 'include' })],
      ])
      // S2b RED (ordering): the rejected refresh never leads to a subscription request.
      expect(callsTo('/subscription', 'GET')).toHaveLength(0)
    })


    it('retryBillingConnection clears local auth on explicit refresh auth failure', async () => {
      secureStore['etebase_session'] = 'fake-session-data'
      useAuthStore.setState({ subscriptionStatus: 'billing_unavailable', isAuthenticated: true })
      routeRetryAuthFailure(() => ({ ok: false, status: 401 } as Response))

      const result = await useAuthStore.getState().retryBillingConnection()

      expect(result).toBe(false)
      expect(useAuthStore.getState().isAuthenticated).toBe(false)
      expect(secureStore['etebase_session']).toBeUndefined()
      expect(localStorage.getItem('silentsuite-hosted-auth-invalidated')).toBeTruthy()
      expect(callsTo('/auth/session', 'DELETE')).toEqual([
        [expect.stringContaining('/auth/session'), expect.objectContaining({ method: 'DELETE', credentials: 'include' })],
      ])
      // S2b RED (ordering): the rejected refresh never leads to a subscription request.
      expect(callsTo('/subscription', 'GET')).toHaveLength(0)
    })

    it('retryBillingConnection returns false on continued network failure', async () => {
      useAuthStore.setState({ subscriptionStatus: 'billing_unavailable' })
      vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'))

      const result = await useAuthStore.getState().retryBillingConnection()

      expect(result).toBe(false)
    })
  })

  // --- S2b hostedAccess store contract (FINISH-PLAN-v2 §2 + v3; tests only) ---
  // [RED] expects behaviour the current store lacks; [CTRL] already holds today.

  describe('S2b hostedAccess (store)', () => {
    const userU = { id: 'user-u', email: 'u@example.com', planId: 'early_annual', isAdmin: false }

    afterEach(() => {
      releaseLogoutGeneration()
      localStorage.removeItem(LOGOUT_GENERATION_KEY)
    })

    it('[RED] isReadOnly is true for trialing with hostedAccess trial_ended', () => {
      seedStore({ user: userU, subscriptionStatus: 'trialing', hostedAccess: 'trial_ended' })
      expect(useAuthStore.getState().isReadOnly()).toBe(true)
    })

    it.each(['unknown', 'entitled', null, 'unrecognized-value'])('[CTRL] isReadOnly stays false for trialing with hostedAccess %s', (access) => {
      seedStore({ user: userU, subscriptionStatus: 'trialing', hostedAccess: access })
      expect(useAuthStore.getState().isReadOnly()).toBe(false)
    })

    it('[CTRL] self-hosted, admin and billing_unavailable stay writable with trial_ended', () => {
      seedStore({ user: { ...userU, isAdmin: true }, subscriptionStatus: 'trialing', hostedAccess: 'trial_ended' })
      expect(useAuthStore.getState().isReadOnly()).toBe(false)
      seedStore({ user: userU, subscriptionStatus: 'billing_unavailable', hostedAccess: 'trial_ended' })
      expect(useAuthStore.getState().isReadOnly()).toBe(false)
      selfHostedMode.enabled = true
      try {
        seedStore({ user: userU, subscriptionStatus: 'trialing', hostedAccess: 'trial_ended' })
        expect(useAuthStore.getState().isReadOnly()).toBe(false)
      } finally {
        selfHostedMode.enabled = false
      }
    })

    it('[RED] fetchSubscription publishes status and hostedAccess in one store notification', async () => {
      seedStore({ user: userU, isAuthenticated: true })
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'trialing', hostedAccess: 'trial_ended' }) } as Response)
      const recorder = recordTuples()
      try {
        await useAuthStore.getState().fetchSubscription()
      } finally {
        recorder.unsubscribe()
      }
      expect(recorder.seen.filter(([status]) => status === 'trialing')).toEqual([['trialing', 'trial_ended', userU.id]])
    })

    it.each([
      ['absent', {}],
      ['unrecognized', { hostedAccess: 'restricted' }],
    ])('[RED] a response with %s hostedAccess clears an earlier trial_ended', async (_label, extra) => {
      seedStore({ user: userU, isAuthenticated: true, subscriptionStatus: 'trialing', hostedAccess: 'trial_ended' })
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'trialing', ...extra }) } as Response)
      await useAuthStore.getState().fetchSubscription()
      expect(useAuthStore.getState().subscriptionStatus).toBe('trialing')
      expect(readHostedAccess()).toBeNull()
      expect(useAuthStore.getState().isReadOnly()).toBe(false)
    })

    it('[RED] an older fetchSubscription with delayed JSON cannot overwrite a newer completed one', async () => {
      seedStore({ user: userU, isAuthenticated: true })
      const older = delayedJsonResponse()
      vi.mocked(fetch)
        .mockResolvedValueOnce(older.response)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'active', hostedAccess: 'entitled' }) } as Response)
      const first = useAuthStore.getState().fetchSubscription()
      await useAuthStore.getState().fetchSubscription()
      older.body.resolve({ status: 'trialing', hostedAccess: 'trial_ended' })
      await first
      expect(useAuthStore.getState().subscriptionStatus).toBe('active')
      expect(readHostedAccess()).toBe('entitled')
    })

    it('[RED] an older fetchSubscription network error while the newest is still pending publishes nothing', async () => {
      seedStore({ user: userU, isAuthenticated: true, subscriptionStatus: null })
      const olderRequest = deferredValue<Response>()
      const newestRequest = deferredValue<Response>()
      vi.mocked(fetch)
        .mockImplementationOnce(() => olderRequest.promise)
        .mockImplementationOnce(() => newestRequest.promise)
      const first = useAuthStore.getState().fetchSubscription()
      const second = useAuthStore.getState().fetchSubscription()
      olderRequest.reject(new TypeError('Failed to fetch'))
      await first
      expect(useAuthStore.getState().subscriptionStatus).toBeNull()
      newestRequest.resolve({ ok: true, json: async () => ({ status: 'active', hostedAccess: 'entitled' }) } as Response)
      await second
      expect(useAuthStore.getState().subscriptionStatus).toBe('active')
    })

    it('[CTRL] a stale error after a newer success keeps the newer status', async () => {
      seedStore({ user: userU, isAuthenticated: true, subscriptionStatus: null })
      const olderRequest = deferredValue<Response>()
      vi.mocked(fetch)
        .mockImplementationOnce(() => olderRequest.promise)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'active' }) } as Response)
      const first = useAuthStore.getState().fetchSubscription()
      await useAuthStore.getState().fetchSubscription()
      olderRequest.reject(new TypeError('Failed to fetch'))
      await first
      expect(useAuthStore.getState().subscriptionStatus).toBe('active')
    })

    it('[RED] a lost logout generation (another tab) blocks publication with equal user and numeric epoch', async () => {
      seedStore({ user: userU, isAuthenticated: true, subscriptionStatus: null })
      establishLogoutGeneration(writeLogoutGeneration())
      const epoch = getAccountEpoch()
      const request = deferredValue<Response>()
      vi.mocked(fetch).mockImplementationOnce(() => request.promise)
      const run = useAuthStore.getState().fetchSubscription()
      // Another tab logs out: only the shared generation changes.
      localStorage.setItem(LOGOUT_GENERATION_KEY, 'synthetic-other-tab-generation')
      request.resolve({ ok: true, json: async () => ({ status: 'cancelled', hostedAccess: 'unknown' }) } as Response)
      await run
      expect(getAccountEpoch()).toBe(epoch)
      expect(useAuthStore.getState().subscriptionStatus).toBeNull()
      expect(readHostedAccess()).toBeNull()
    })

    it('[RED] login as a different account clears the previous tuple in the same notification that publishes the new user', async () => {
      seedStore({ user: { ...userU, id: 'user-a' }, isAuthenticated: true, subscriptionStatus: 'trialing', hostedAccess: 'trial_ended' })
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ id: 'user-b', email: 'b@example.com', planId: 'pro', isAdmin: false }),
      } as Response)
      const recorder = recordTuples()
      try {
        await useAuthStore.getState().login('b@example.com', 'password123')
      } finally {
        recorder.unsubscribe()
      }
      expect(useAuthStore.getState().user?.id).toBe('user-b')
      // The first notification that shows account B already carries no tuple of A.
      expect(recorder.seen.find(([, , id]) => id === 'user-b')).toEqual([null, null, 'user-b'])
      expect(useAuthStore.getState().isReadOnly()).toBe(false)
    })

    it('[CTRL] onboarding metadata updates for the same account preserve the tuple', async () => {
      seedStore({ user: { ...userU, onboardedAt: null }, isAuthenticated: true, subscriptionStatus: 'trialing', hostedAccess: 'trial_ended' })
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ onboardedAt: '2026-10-28T00:00:00.000Z' }) } as Response)
      expect(await useAuthStore.getState().markOnboarded()).toBe(true)
      expect(useAuthStore.getState().subscriptionStatus).toBe('trialing')
      expect(readHostedAccess()).toBe('trial_ended')
    })

    // Final-review correction (D): every identity-ending publication clears the tuple in the same update.
    describe('identity-ending publications', () => {
      const seededTuple = () => seedStore({ user: userU, isAuthenticated: true, subscriptionStatus: 'trialing', hostedAccess: 'trial_ended' })
      async function firstSignedOutTuple(run: () => Promise<unknown>) {
        const recorder = recordTuples()
        try {
          await run()
        } finally {
          recorder.unsubscribe()
        }
        expect(useAuthStore.getState().user).toBeNull()
        return recorder.seen.find(([, , id]) => id === null)
      }

      it('[RED] restoreSession with a signup in progress clears the tuple with the user', async () => {
        seededTuple()
        sessionStorage.setItem('silentsuite-signup-in-progress', 'true')
        try {
          expect(await firstSignedOutTuple(() => useAuthStore.getState().restoreSession())).toEqual([null, null, null])
        } finally {
          sessionStorage.removeItem('silentsuite-signup-in-progress')
        }
      })

      it('[RED] restoreSession on a self-hosted build without a session clears the tuple with the user', async () => {
        seededTuple()
        selfHostedMode.enabled = true
        try {
          expect(await firstSignedOutTuple(() => useAuthStore.getState().restoreSession())).toEqual([null, null, null])
        } finally {
          selfHostedMode.enabled = false
        }
      })

      it('[RED] restoreSession after a non-auth refresh server error clears the tuple with the user', async () => {
        seededTuple()
        vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500 } as Response)
        expect(await firstSignedOutTuple(() => useAuthStore.getState().restoreSession())).toEqual([null, null, null])
      })

      it('[RED] refreshSession on a self-hosted build without a session clears the tuple with the user', async () => {
        seededTuple()
        selfHostedMode.enabled = true
        try {
          expect(await firstSignedOutTuple(() => useAuthStore.getState().refreshSession())).toEqual([null, null, null])
        } finally {
          selfHostedMode.enabled = false
        }
      })
    })
  })

  // --- refreshSession non-destructive on transient errors ---
  it('does not resurrect authentication while logout server deletion is still pending', async () => {
    const user = { id: 'payment-account-a', email: 'a@example.invalid', planId: 'early_annual', rememberDevice: true }
    useAuthStore.setState({ user, isAuthenticated: true })
    let releaseRefresh!: (response: Response) => void
    const refreshReply = new Promise<Response>(resolve => { releaseRefresh = resolve })
    let releaseDelete!: () => void
    const deleteReply = new Promise<void>(resolve => { releaseDelete = resolve })
    let entered!: () => void
    const refreshEntered = new Promise<void>(resolve => { entered = resolve })
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith('/auth/refresh')) { entered(); return refreshReply }
      expect(init?.method).toBe('DELETE')
      await deleteReply
      return new Response(null, { status: 204 })
    })
    const refresh = useAuthStore.getState().refreshSession()
    await refreshEntered
    const logout = useAuthStore.getState().logout()
    expect(useAuthStore.getState().user).toBeNull()
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    try {
      releaseRefresh(new Response(JSON.stringify(user)))
      await refresh
      expect(useAuthStore.getState().user).toBeNull()
      expect(useAuthStore.getState().isAuthenticated).toBe(false)
    } finally {
      releaseDelete()
      await logout
    }
  })

  // Payment recovery must use this real refresh boundary without allowing a
  // late response to resurrect logout or overwrite a replacement identity.
  it.each(['logout', 'replacement', 'replacement-rejection'] as const)('ignores a refresh response after %s changes the account boundary', async transition => {
    const original = { id: 'payment-account-a', email: 'a@example.invalid', planId: 'early_annual', rememberDevice: true }
    const replacement = { id: 'payment-account-b', email: 'b@example.invalid', planId: 'standard_annual', rememberDevice: true }
    useAuthStore.setState({ user: original, isAuthenticated: true, subscriptionStatus: 'cancelled' })
    let release!: (response: Response) => void
    const pendingResponse = new Promise<Response>(resolve => { release = resolve })
    let entered!: () => void
    const requestEntered = new Promise<void>(resolve => { entered = resolve })
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith('/auth/refresh')) {
        expect(init?.method).toBe('POST')
        expect(init?.credentials).toBe('include')
        entered()
        return pendingResponse
      }
      return new Response(null, { status: 204 }) // existing logout/delete boundary
    })
    const epoch = getAccountEpoch()
    const refresh = useAuthStore.getState().refreshSession()
    await requestEntered
    if (transition === 'logout') await useAuthStore.getState().logout()
    else {
      bumpAccountEpoch()
      useAuthStore.setState({ user: replacement, isAuthenticated: true, subscriptionStatus: 'active' })
    }
    expect(getAccountEpoch()).toBeGreaterThan(epoch)
    const afterTransition = useAuthStore.getState()
    release(transition === 'replacement-rejection'
      ? new Response(JSON.stringify({ type: 'invalid-access-token' }), { status: 401 })
      : new Response(JSON.stringify({ ...original, emailVerified: true })))
    await refresh
    expect(useAuthStore.getState().user).toEqual(afterTransition.user)
    expect(useAuthStore.getState().isAuthenticated).toBe(afterTransition.isAuthenticated)
    expect(useAuthStore.getState().subscriptionStatus).toBe(afterTransition.subscriptionStatus)
  })

  // Regression: the EmailVerificationBanner re-checks the session on every
  // tab focus while the user is unverified. A transient billing 5xx or a
  // network blip used to null the session, silently logging out users who
  // had only alt-tabbed away.

  it('refreshSession clears account-scoped stores before publishing a different hosted user', async () => {
    useAuthStore.setState({
      user: { id: 'account-a', email: 'a@example.com', planId: 'pro' },
      isAuthenticated: true,
    })
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: 'account-b', email: 'b@example.com', planId: 'pro', rememberDevice: true }),
    } as Response)

    await useAuthStore.getState().refreshSession()

    expect(useAuthStore.getState().user?.id).toBe('account-b')
    expect(calendarSetState).toHaveBeenCalledWith(expect.objectContaining({ events: [] }))
    expect(labelSuggestionsReset).toHaveBeenCalledTimes(1)
    expect(preferencesReset).toHaveBeenCalledTimes(1)
  })

  it('refreshSession hides protected data before invalid-session deletion completes', async () => {
    let resolveDelete!: (response: Response) => void
    const pendingDelete = new Promise<Response>((resolve) => { resolveDelete = resolve })
    useAuthStore.setState({
      user: { id: 'account-a', email: 'a@example.com', planId: 'pro' },
      isAuthenticated: true,
    })
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false, status: 401 } as Response)
      .mockReturnValueOnce(pendingDelete)

    const refresh = useAuthStore.getState().refreshSession()
    await vi.waitFor(() => expect(useAuthStore.getState().isAuthenticated).toBe(false))
    resolveDelete({ ok: true, status: 204 } as Response)
    await refresh
  })

  describe('refreshSession on transient errors', () => {
    function loggedIn() {
      useAuthStore.setState({
        user: { id: 'u1', email: 'x@y.com', planId: 'pro', emailVerified: false, onboardedAt: null },
        isAuthenticated: true,
      })
    }

    it('leaves the session intact on a 5xx response', async () => {
      loggedIn()
      vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 502 } as Response)

      const result = await useAuthStore.getState().refreshSession()

      expect(result).toBe(false)
      const state = useAuthStore.getState()
      expect(state.isAuthenticated).toBe(true)
      expect(state.user).not.toBeNull()
    })

    it('leaves the session intact on a network error', async () => {
      loggedIn()
      vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'))

      const result = await useAuthStore.getState().refreshSession()

      expect(result).toBe(false)
      const state = useAuthStore.getState()
      expect(state.isAuthenticated).toBe(true)
      expect(state.user).not.toBeNull()
    })

    it('nulls the session on 401 (auth genuinely invalid)', async () => {
      loggedIn()
      vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 401 } as Response)

      const result = await useAuthStore.getState().refreshSession()

      expect(result).toBe(false)
      const state = useAuthStore.getState()
      expect(state.isAuthenticated).toBe(false)
      expect(state.user).toBeNull()
    })

    it('nulls the session on 403', async () => {
      loggedIn()
      vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 403 } as Response)

      const result = await useAuthStore.getState().refreshSession()

      expect(result).toBe(false)
      expect(useAuthStore.getState().user).toBeNull()
    })
  })

  describe('restoreSession refresh-unconfirmed compatibility', () => {
    const problemType =
      'https://api.silentsuite.io/errors/refresh-unconfirmed'
    const originalUser = {
      id: 'u1',
      email: 'session@example.invalid',
      planId: 'early_annual',
      rememberDevice: true,
      isAdmin: false,
    }
    const replacementUser = {
      id: 'u2',
      email: 'replacement@example.invalid',
      planId: 'standard_annual',
      rememberDevice: true,
      isAdmin: false,
    }

    beforeEach(() => {
      contactLifecycleReset.mockClear()
      noteLifecycleReset.mockClear()
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-10-23T12:00:00Z'))
    })

    afterEach(() => {
      vi.clearAllTimers()
      vi.useRealTimers()
    })

    function transient(
      retryAfter: string | null = '1',
      type = problemType,
    ): Response {
      const body = { type, status: 503 }
      const response = new Response(JSON.stringify(body), {
        status: 503,
        headers: retryAfter === null ? {} : { 'Retry-After': retryAfter },
      })
      // Keep body parsing deterministic under fake timers without stream tasks.
      response.clone = () => ({
        json: async () => body,
      }) as Response
      return response
    }

    function success() {
      return new Response(JSON.stringify({
        ...originalUser,
        emailVerified: true,
        onboardedAt: null,
      }))
    }

    function startWarm() {
      useAuthStore.setState({
        user: originalUser,
        isAuthenticated: true,
        subscriptionStatus: 'active',
      })
    }

    function storageBytes(storage: Storage) {
      return JSON.stringify(Object.keys(storage).sort()
        .map(key => [key, storage.getItem(key)]))
    }

    function expectNoAccountCleanup() {
      expect(secureClear).not.toHaveBeenCalled()
      expect(dataCacheClearAll).not.toHaveBeenCalled()
      expect(offlineQueueClearAll).not.toHaveBeenCalled()
      expect(calendarSetState).not.toHaveBeenCalled()
      expect(taskSetState).not.toHaveBeenCalled()
      expect(contactLifecycleReset).not.toHaveBeenCalled()
      expect(noteLifecycleReset).not.toHaveBeenCalled()
      expect(preferencesSyncDestroy).not.toHaveBeenCalled()
      expect(vi.mocked(fetch).mock.calls.some(([, init]) =>
        init?.method === 'DELETE')).toBe(false)
    }

    it('retries with browser-managed current cookies and clears the retry error on success', async () => {
      startWarm()
      useAuthStore.setState({ error: 'an earlier retry failure' })
      let browserCookie = 'original-cookie'
      const attachedAtDispatch: string[] = []

      vi.mocked(fetch).mockImplementation(async (input, init) => {
        expect(String(input)).toContain('/auth/refresh')
        expect(init?.method).toBe('POST')
        expect(init?.credentials).toBe('include')
        expect(new Headers(init?.headers).get('cookie')).toBeNull()
        attachedAtDispatch.push(browserCookie)
        return attachedAtDispatch.length === 1 ? transient() : success()
      })

      const pending = useAuthStore.getState().restoreSession()
      await vi.advanceTimersByTimeAsync(0)
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(useAuthStore.getState().isLoading).toBe(true)
      expect(useAuthStore.getState().user).toBe(originalUser)

      // Simulate the winner's browser-cookie update between dispatches.
      browserCookie = 'winner-cookie'
      await vi.advanceTimersByTimeAsync(999)
      expect(fetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      await pending

      expect(attachedAtDispatch)
        .toEqual(['original-cookie', 'winner-cookie'])
      expect(useAuthStore.getState()).toMatchObject({
        user: { id: 'u1', emailVerified: true },
        isAuthenticated: true,
        isLoading: false,
        error: null,
        subscriptionStatus: 'active',
      })
      expectNoAccountCleanup()
    })

    it.each(['warm', 'cold'] as const)(
      'exhausts after three requests and retains material for a %s tab',
      async mode => {
        secureStore.etebase_session = 'retained-encrypted-session'
        secureStore.account_key = 'retained-account-material'
        localStorage.setItem(
          'silentsuite-hosted-validation-remembered',
          JSON.stringify({
            userId: 'u1',
            rememberDevice: true,
            validatedAt: Date.now(),
          }),
        )
        sessionStorage.setItem('retained-checkpoint', 'retain-this')
        if (mode === 'warm') startWarm()

        const beforeLocal = storageBytes(localStorage)
        const beforeSession = storageBytes(sessionStorage)
        const beforeSecure = { ...secureStore }
        vi.mocked(fetch).mockImplementation(async () => transient())

        const pending = useAuthStore.getState().restoreSession()
        await vi.advanceTimersByTimeAsync(0)
        expect(fetch).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1_000)
        expect(fetch).toHaveBeenCalledTimes(2)
        await vi.advanceTimersByTimeAsync(1_000)
        await pending

        expect(fetch).toHaveBeenCalledTimes(3)
        expect(useAuthStore.getState().isLoading).toBe(false)
        expect(useAuthStore.getState().error).toMatch(/retry/i)
        expect(useAuthStore.getState().user)
          .toBe(mode === 'warm' ? originalUser : null)
        expect(useAuthStore.getState().isAuthenticated)
          .toBe(mode === 'warm')
        expect(useAuthStore.getState().subscriptionStatus)
          .toBe(mode === 'warm' ? 'active' : null)
        expect(secureStore).toEqual(beforeSecure)
        expect(storageBytes(localStorage)).toBe(beforeLocal)
        expect(storageBytes(sessionStorage)).toBe(beforeSession)
        expectNoAccountCleanup()

        await vi.advanceTimersByTimeAsync(10_000)
        expect(fetch).toHaveBeenCalledTimes(3)
      },
    )

    it.each([
      ['large delay', '999999', 2_000],
      ['zero delay', '0', 250],
      ['missing delay', null, 1_000],
      ['invalid delay', 'nonsense', 1_000],
      ['negative delay', '-1', 1_000],
      ['fractional delay', '0.1', 1_000],
      ['HTTP date', 'Fri, 23 Oct 2026 12:00:02 GMT', 2_000],
    ] as const)(
      'bounds Retry-After for %s',
      async (_label, header, expectedDelay) => {
        startWarm()
        vi.mocked(fetch)
          .mockResolvedValueOnce(transient(header))
          .mockResolvedValueOnce(success())

        const pending = useAuthStore.getState().restoreSession()
        await vi.advanceTimersByTimeAsync(0)
        expect(fetch).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(expectedDelay - 1)
        expect(fetch).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1)
        await pending

        expect(fetch).toHaveBeenCalledTimes(2)
        expect(useAuthStore.getState().isAuthenticated).toBe(true)
        expectNoAccountCleanup()
      },
    )

    it.each(['replacement', 'logout'] as const)(
      'does not dispatch a retry after %s changes the account boundary',
      async transition => {
        startWarm()
        vi.mocked(fetch).mockImplementation(async (input, init) => {
          if (String(input).endsWith('/auth/refresh')) return transient()
          expect(init?.method).toBe('DELETE')
          return new Response(null, { status: 204 })
        })

        const pending = useAuthStore.getState().restoreSession()
        await vi.advanceTimersByTimeAsync(0)
        expect(vi.mocked(fetch).mock.calls.filter(([input]) =>
          String(input).endsWith('/auth/refresh'))).toHaveLength(1)

        if (transition === 'logout') {
          await useAuthStore.getState().logout()
        } else {
          bumpAccountEpoch()
          useAuthStore.setState({
            user: replacementUser,
            isAuthenticated: true,
            subscriptionStatus: 'cancelled',
            isLoading: false,
            error: 'replacement owns this state',
          })
        }
        const afterTransition = useAuthStore.getState()
        const callsAfterTransition = vi.mocked(fetch).mock.calls.length
        const clearsAfterTransition = vi.mocked(secureClear).mock.calls.length

        await vi.advanceTimersByTimeAsync(2_000)
        await pending
        expect(fetch).toHaveBeenCalledTimes(callsAfterTransition)
        expect(secureClear).toHaveBeenCalledTimes(clearsAfterTransition)
        expect(useAuthStore.getState().user).toBe(afterTransition.user)
        expect(useAuthStore.getState().isAuthenticated)
          .toBe(afterTransition.isAuthenticated)
        expect(useAuthStore.getState().subscriptionStatus)
          .toBe(afterTransition.subscriptionStatus)
        expect(useAuthStore.getState().error).toBe(afterTransition.error)
      },
    )

    it.each([200, 401] as const)(
      'ignores a late retry response with status %s after replacement',
      async status => {
        startWarm()
        let release!: (response: Response) => void
        const delayed = new Promise<Response>(resolve => { release = resolve })
        vi.mocked(fetch)
          .mockResolvedValueOnce(transient())
          .mockReturnValueOnce(delayed)

        const pending = useAuthStore.getState().restoreSession()
        await vi.advanceTimersByTimeAsync(1_000)
        expect(fetch).toHaveBeenCalledTimes(2)

        bumpAccountEpoch()
        useAuthStore.setState({
          user: replacementUser,
          isAuthenticated: true,
          subscriptionStatus: 'active',
          isLoading: false,
          error: 'replacement state',
        })
        release(status === 200
          ? success()
          : new Response('{}', { status }))
        await pending

        expect(useAuthStore.getState()).toMatchObject({
          user: replacementUser,
          isAuthenticated: true,
          subscriptionStatus: 'active',
          isLoading: false,
          error: 'replacement state',
        })
        expect(fetch).toHaveBeenCalledTimes(2)
        expectNoAccountCleanup()
      },
    )

    it('rechecks account ownership after parsing the transient problem', async () => {
      startWarm()
      let release!: (value: unknown) => void
      const body = new Promise<unknown>(resolve => { release = resolve })
      const response = transient()
      response.clone = () => ({ json: () => body }) as Response
      vi.mocked(fetch).mockResolvedValueOnce(response)

      const pending = useAuthStore.getState().restoreSession()
      await vi.advanceTimersByTimeAsync(0)
      expect(fetch).toHaveBeenCalledTimes(1)

      bumpAccountEpoch()
      useAuthStore.setState({
        user: replacementUser,
        isAuthenticated: true,
        isLoading: false,
        error: 'new boundary',
      })
      release({ type: problemType, status: 503 })
      await pending
      await vi.advanceTimersByTimeAsync(5_000)

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(useAuthStore.getState().user).toBe(replacementUser)
      expect(useAuthStore.getState().error).toBe('new boundary')
      expectNoAccountCleanup()
    })

    it('preserves cold-tab material when the retry transport fails', async () => {
      secureStore.etebase_session = 'retained-cold-session'
      vi.mocked(fetch)
        .mockResolvedValueOnce(transient())
        .mockRejectedValueOnce(new TypeError('retry transport failed'))

      const pending = useAuthStore.getState().restoreSession()
      await vi.advanceTimersByTimeAsync(1_000)
      await pending

      expect(fetch).toHaveBeenCalledTimes(2)
      expect(useAuthStore.getState()).toMatchObject({
        user: null,
        isAuthenticated: false,
        isLoading: false,
        subscriptionStatus: null,
      })
      expect(useAuthStore.getState().error).toMatch(/retry/i)
      expect(secureStore.etebase_session).toBe('retained-cold-session')
      expectNoAccountCleanup()
    })

    it.each(['warm', 'marked-cold', 'unmarked-cold'] as const)(
      'preserves state and material after interrupted retry body: %s',
      async mode => {
        secureStore.etebase_session = 'retained-encrypted-session'
        secureStore.account_key = 'retained-account-material'
        sessionStorage.setItem('retained-checkpoint', 'retain-this')

        if (mode !== 'unmarked-cold') {
          localStorage.setItem(
            'silentsuite-hosted-validation-remembered',
            JSON.stringify({
              userId: originalUser.id,
              rememberDevice: true,
              validatedAt: Date.now(),
            }),
          )
        }
        if (mode === 'warm') startWarm()

        const before = useAuthStore.getState()
        const beforeSecure = { ...secureStore }
        const beforeLocal = storageBytes(localStorage)
        const beforeSession = storageBytes(sessionStorage)
        const beforeEpoch = getAccountEpoch()

        let rejectBody!: (error: unknown) => void
        const interruptedBody = new Promise<never>((_resolve, reject) => {
          rejectBody = reject
        })

        // Headers succeed. Body consumption remains pending until interrupted.
        const retryResponse = success()
        const readBody = vi.fn(() => interruptedBody)
        retryResponse.json = readBody

        vi.mocked(fetch)
          .mockResolvedValueOnce(transient())
          .mockResolvedValueOnce(retryResponse)

        const pending = useAuthStore.getState().restoreSession()
        await vi.advanceTimersByTimeAsync(1_000)

        expect(fetch).toHaveBeenCalledTimes(2)
        expect(readBody).toHaveBeenCalledTimes(1)
        expect(useAuthStore.getState().isLoading).toBe(true)
        expect(useAuthStore.getState().user).toBe(before.user)
        expect(useAuthStore.getState().isAuthenticated)
          .toBe(before.isAuthenticated)

        rejectBody(new TypeError('response body transport interrupted'))
        await pending

        const after = useAuthStore.getState()
        expect(after.user).toBe(before.user)
        expect(after.isAuthenticated).toBe(before.isAuthenticated)
        expect(after.subscriptionStatus).toBe(before.subscriptionStatus)
        expect(after.pendingSignup).toBe(before.pendingSignup)
        expect(after.isLoading).toBe(false)
        expect(after.error).toMatch(/retry/i)
        expect(getAccountEpoch()).toBe(beforeEpoch)

        expect(secureStore).toEqual(beforeSecure)
        expect(storageBytes(localStorage)).toBe(beforeLocal)
        expect(storageBytes(sessionStorage)).toBe(beforeSession)
        expectNoAccountCleanup()

        if (mode !== 'warm') {
          expect(after.user).toBeNull()
          expect(after.isAuthenticated).toBe(false)
          expect(after.subscriptionStatus).toBeNull()
        }

        await vi.advanceTimersByTimeAsync(5_000)
        expect(fetch).toHaveBeenCalledTimes(2)
      },
    )

    it('does not retry an unrelated 503 problem', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        transient('1', 'https://api.silentsuite.io/errors/unrelated'),
      )
      const pending = useAuthStore.getState().restoreSession()
      await vi.advanceTimersByTimeAsync(0)
      await pending
      await vi.advanceTimersByTimeAsync(5_000)

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(useAuthStore.getState().isAuthenticated).toBe(false)
      expect(useAuthStore.getState().isLoading).toBe(false)
      expect(useAuthStore.getState().error).toBeNull()
    })

    it('keeps refreshSession cookie-neutral 503 handling without adding retries', async () => {
      startWarm()
      vi.mocked(fetch).mockResolvedValueOnce(transient())

      expect(await useAuthStore.getState().refreshSession()).toBe(false)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(useAuthStore.getState().user).toBe(originalUser)
      expect(useAuthStore.getState().isAuthenticated).toBe(true)
      expectNoAccountCleanup()
    })
  })

  // --- Stripe redirect signup state (issue #20) ---

  describe('signup redirect state storage', () => {
    const pending = {
      email: 'user@example.com',
      paymentSessionToken: 'payment-session-token',
    }

    it('retains a recovery snapshot across document resets without persisting credentials or renewing its TTL', () => {
      useAuthStore.setState({ pendingSignup: {
        email: 'customer@example.test', password: 'NeverPersistThis1',
        serverUrl: 'https://server.silentsuite.io', billingContractVersion: 2,
        paymentMethod: 'btcpay', paymentSessionToken: 'A'.repeat(43),
        paymentSessionRequestKey: '5fd4d86d-34de-4b82-9a66-9598ddf6e02f',
      } })
      useAuthStore.getState().saveSignupStateForRedirect('annual')
      const original = sessionStorage.getItem('silentsuite-signup-redirect-state')!
      expect(original).not.toContain('NeverPersistThis1')
      for (let document = 0; document < 3; document += 1) {
        useAuthStore.setState({ pendingSignup: null })
        const restored = useAuthStore.getState().restoreSignupStateFromRedirect({ retainForRecovery: true })
        expect(restored?.pendingSignup).toMatchObject({ email: 'customer@example.test', paymentSessionToken: 'A'.repeat(43), paymentSessionRequestKey: '5fd4d86d-34de-4b82-9a66-9598ddf6e02f' })
        expect(restored?.pendingSignup).not.toHaveProperty('password')
        expect(JSON.parse(sessionStorage.getItem('silentsuite-signup-redirect-state')!)).toEqual(JSON.parse(original))
        expect(useAuthStore.getState().isAuthenticated).toBe(false)
      }
    })

    it('saves redirect state to sessionStorage, not localStorage', () => {
      useAuthStore.setState({ pendingSignup: pending })
      useAuthStore.getState().saveSignupStateForRedirect('monthly')

      expect(sessionStorage.getItem('silentsuite-signup-redirect-state')).not.toBeNull()
      expect(localStorage.getItem('silentsuite-signup-redirect-state')).toBeNull()
    })

    it('restores from sessionStorage and clears the key', () => {
      useAuthStore.setState({ pendingSignup: pending })
      useAuthStore.getState().saveSignupStateForRedirect('annual')

      const restored = useAuthStore.getState().restoreSignupStateFromRedirect()

      expect(restored?.selectedInterval).toBe('annual')
      expect(restored?.pendingSignup.email).toBe('user@example.com')
      expect(sessionStorage.getItem('silentsuite-signup-redirect-state')).toBeNull()
    })

    it('persists only the permitted full-navigation continuation fields and restores the exact v2 authority', () => {
      useAuthStore.setState({
        pendingSignup: {
          email: 'customer@example.test',
          serverUrl: 'https://server.silentsuite.io',
          paymentSessionToken: 'v2-payment-session-token',
          paymentSessionRequestKey: '5fd4d86d-34de-4b82-9a66-9598ddf6e02f',
          paymentMethod: 'btcpay',
          billingContractVersion: 2,
          earlyAdopter: true,
          wantsProductUpdates: true,
          rememberDevice: true,
          provisionedUser: { id: 'user-1', planId: 'early_annual', isAdmin: false },
          provisionedSubscriptionStatus: 'active',
          password: 'must-not-persist',
          cardNumber: '4242424242424242',
          cvc: '123',
          recoverySecret: 'must-not-persist',
          clientSecret: 'must-not-persist',
        } as any,
      })

      useAuthStore.getState().saveSignupStateForRedirect('annual')

      const raw = sessionStorage.getItem('silentsuite-signup-redirect-state')!
      expect(raw).not.toContain('must-not-persist')
      expect(raw).not.toContain('4242424242424242')
      expect(raw).not.toContain('"cvc"')
      expect(JSON.parse(raw)).toEqual({
        pendingSignup: {
          email: 'customer@example.test',
          serverUrl: 'https://server.silentsuite.io',
          paymentSessionToken: 'v2-payment-session-token',
          paymentSessionRequestKey: '5fd4d86d-34de-4b82-9a66-9598ddf6e02f',
          paymentMethod: 'btcpay',
          billingContractVersion: 2,
          earlyAdopter: true,
          wantsProductUpdates: true,
          rememberDevice: true,
          provisionedUser: { id: 'user-1', planId: 'early_annual', isAdmin: false },
          provisionedSubscriptionStatus: 'active',
        },
        selectedInterval: 'annual',
        savedAt: expect.any(Number),
      })

      useAuthStore.setState({ pendingSignup: null })
      const restored = useAuthStore.getState().restoreSignupStateFromRedirect()

      expect(restored?.pendingSignup).toEqual({
        email: 'customer@example.test',
        serverUrl: 'https://server.silentsuite.io',
        paymentSessionToken: 'v2-payment-session-token',
        paymentSessionRequestKey: '5fd4d86d-34de-4b82-9a66-9598ddf6e02f',
        paymentMethod: 'btcpay',
        billingContractVersion: 2,
        earlyAdopter: true,
        wantsProductUpdates: true,
        rememberDevice: true,
        provisionedUser: { id: 'user-1', planId: 'early_annual', isAdmin: false },
        provisionedSubscriptionStatus: 'active',
      })
      expect(sessionStorage.getItem('silentsuite-signup-redirect-state')).toBeNull()
    })

    it('keeps an explicit historical v1 redirect version exact through restore', () => {
      sessionStorage.setItem('silentsuite-signup-redirect-state', JSON.stringify({
        pendingSignup: {
          email: 'legacy@example.test',
          paymentSessionToken: 'historical-v1-payment-token',
          billingContractVersion: 1,
          wantsProductUpdates: false,
          rememberDevice: false,
        },
        selectedInterval: 'monthly',
        savedAt: Date.now(),
      }))

      const restored = useAuthStore.getState().restoreSignupStateFromRedirect()

      expect(restored).toEqual({
        pendingSignup: {
          email: 'legacy@example.test',
          paymentSessionToken: 'historical-v1-payment-token',
          billingContractVersion: 1,
          wantsProductUpdates: false,
          rememberDevice: false,
        },
        selectedInterval: 'monthly',
        savedAt: expect.any(Number),
      })
      expect(useAuthStore.getState().pendingSignup).toEqual(restored?.pendingSignup)
    })

    it('ignores legacy localStorage entries left behind by older builds', () => {
      // Simulate a tab that saved redirect state under the old localStorage key.
      localStorage.setItem(
        'silentsuite-signup-redirect-state',
        JSON.stringify({ pendingSignup: pending, selectedInterval: 'monthly', savedAt: Date.now() }),
      )

      const restored = useAuthStore.getState().restoreSignupStateFromRedirect()

      expect(restored).toBeNull()
    })
  })
})

// Subscription clarity: accountNotice travels with the existing owned tuple. Test-local casts
// keep these compiling before the field and the claim action exist.
describe('accountNotice (store)', () => {
  const userU = { id: 'notice-u', email: 'u@example.com', planId: 'early_annual', isAdmin: false }
  const userV = { id: 'notice-v', email: 'v@example.com', planId: 'early_annual', isAdmin: false }
  const trialEndsAt = '2026-11-02T12:00:00.000Z'
  const daysLeft = { kind: 'trial_days_left', trialEndsAt, daysRemaining: 3 }
  type NoticeState = { accountNotice?: unknown; claimTrialExpiryRefresh?: (end: string) => boolean }
  const readNotice = () => (useAuthStore.getState() as unknown as NoticeState).accountNotice
  const claim = (end: string) => (useAuthStore.getState() as unknown as NoticeState).claimTrialExpiryRefresh?.(end)
  const ok = (body: Record<string, unknown>) => ({ ok: true, status: 200, json: async () => body }) as Response
  const subscriptionCalls = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/subscription')).length

  beforeEach(() => {
    resetStore()
    seedStore({ accountNotice: null, trialExpiryRefreshClaim: null } as WithHostedAccess)
    vi.mocked(fetch).mockReset()
    localStorage.clear()
  })

  it('[RED] an owned successful read publishes the notice with the status tuple', async () => {
    seedStore({ user: userU, isAuthenticated: true })
    vi.mocked(fetch).mockResolvedValueOnce(ok({ status: 'trialing', hostedAccess: 'entitled', accountNotice: daysLeft }))
    const seen: unknown[] = []
    const unsubscribe = useAuthStore.subscribe((state) => { seen.push([state.subscriptionStatus, (state as unknown as NoticeState).accountNotice]) })
    try {
      await useAuthStore.getState().fetchSubscription()
    } finally {
      unsubscribe()
    }
    expect(seen).toEqual([['trialing', daysLeft]])
  })

  it.each([
    ['absent', undefined],
    ['unknown kind', { kind: 'upsell' }],
    ['zero days', { ...daysLeft, daysRemaining: 0 }],
    ['fractional days', { ...daysLeft, daysRemaining: 1.5 }],
    ['invalid date', { ...daysLeft, trialEndsAt: 'soon' }],
    ['non-ISO date', { ...daysLeft, trialEndsAt: 'November 2, 2026' }],
    ['offset-less date', { ...daysLeft, trialEndsAt: '2026-11-02T12:00:00' }],
    ['extra key', { ...daysLeft, price: 3600 }],
    ['ended without date key', { kind: 'trial_ended' }],
  ])('[RED] a %s notice publishes null and replaces an earlier notice', async (_label, notice) => {
    seedStore({ user: userU, isAuthenticated: true, subscriptionStatus: 'trialing', accountNotice: daysLeft } as WithHostedAccess)
    vi.mocked(fetch).mockResolvedValueOnce(ok({ status: 'trialing', ...(notice === undefined ? {} : { accountNotice: notice }) }))
    await useAuthStore.getState().fetchSubscription()
    expect(useAuthStore.getState().subscriptionStatus).toBe('trialing')
    expect(readNotice()).toBeNull()
  })

  it.each([
    ['non-leap February 29', '2026-02-29T12:00:00Z'],
    ['February 30', '2026-02-30T12:00:00Z'],
    ['April 31', '2026-04-31T12:00:00.000Z'],
    ['month 13', '2026-13-01T12:00:00Z'],
    ['hour 24', '2026-11-02T24:00:00Z'],
  ])('rejects an impossible calendar date (%s) in every notice date field', async (_label, date) => {
    seedStore({ user: userU, isAuthenticated: true })
    for (const notice of [
      { kind: 'trial_days_left', trialEndsAt: date, daysRemaining: 3 },
      { kind: 'trial_ended', endedAt: date },
      { kind: 'access_ended', endedAt: date },
    ]) {
      seedStore({ accountNotice: daysLeft } as WithHostedAccess)
      vi.mocked(fetch).mockResolvedValueOnce(ok({ status: 'trialing', accountNotice: notice }))
      await useAuthStore.getState().fetchSubscription()
      expect(readNotice()).toBeNull()
    }
  })

  it.each([
    ['leap day', '2028-02-29T12:00:00Z'],
    ['one fractional digit', '2026-11-02T12:00:00.5Z'],
    ['three fractional digits', '2026-11-02T12:00:00.123Z'],
  ])('accepts a real UTC date with %s', async (_label, date) => {
    seedStore({ user: userU, isAuthenticated: true })
    vi.mocked(fetch).mockResolvedValueOnce(ok({ status: 'trialing', accountNotice: { kind: 'trial_ended', endedAt: date } }))
    await useAuthStore.getState().fetchSubscription()
    expect(readNotice()).toEqual({ kind: 'trial_ended', endedAt: date })
  })

  it('[RED] accepts the ended notices, including access_ended without a date', async () => {
    seedStore({ user: userU, isAuthenticated: true })
    vi.mocked(fetch).mockResolvedValueOnce(ok({ status: 'expired', accountNotice: { kind: 'access_ended', endedAt: null } }))
    await useAuthStore.getState().fetchSubscription()
    expect(readNotice()).toEqual({ kind: 'access_ended', endedAt: null })
    vi.mocked(fetch).mockResolvedValueOnce(ok({ status: 'trialing', accountNotice: { kind: 'trial_ended', endedAt: trialEndsAt } }))
    await useAuthStore.getState().fetchSubscription()
    expect(readNotice()).toEqual({ kind: 'trial_ended', endedAt: trialEndsAt })
  })

  it.each([
    ['non-ok response', () => vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) } as Response)],
    ['network error', () => vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'))],
    ['unreadable body', () => vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json') } } as unknown as Response)],
  ])('[RED] an owned %s after success clears only the notice', async (_label, failNext) => {
    seedStore({ user: userU, isAuthenticated: true })
    vi.mocked(fetch).mockResolvedValueOnce(ok({ status: 'trialing', hostedAccess: 'entitled', accountNotice: daysLeft }))
    await useAuthStore.getState().fetchSubscription()
    expect(readNotice()).toEqual(daysLeft)
    failNext()
    await useAuthStore.getState().fetchSubscription()
    expect(readNotice()).toBeNull()
    expect(useAuthStore.getState().subscriptionStatus).toBe('trialing')
    expect(readHostedAccess()).toBe('entitled')
  })

  it('[RED] an older failure after a newer success keeps the newer notice', async () => {
    seedStore({ user: userU, isAuthenticated: true })
    const older = deferredValue<Response>()
    vi.mocked(fetch)
      .mockImplementationOnce(() => older.promise)
      .mockResolvedValueOnce(ok({ status: 'trialing', accountNotice: daysLeft }))
    const first = useAuthStore.getState().fetchSubscription()
    await useAuthStore.getState().fetchSubscription()
    older.reject(new TypeError('Failed to fetch'))
    await first
    expect(readNotice()).toEqual(daysLeft)
  })

  it('[CTRL] an older success after a newer success cannot restore its notice', async () => {
    seedStore({ user: userU, isAuthenticated: true })
    const older = delayedJsonResponse()
    vi.mocked(fetch)
      .mockResolvedValueOnce(older.response)
      .mockResolvedValueOnce(ok({ status: 'active', accountNotice: null }))
    const first = useAuthStore.getState().fetchSubscription()
    await useAuthStore.getState().fetchSubscription()
    older.body.resolve({ status: 'trialing', accountNotice: daysLeft })
    await first
    expect(readNotice()).toBeNull()
  })

  it('[RED] a response arriving after the account changes is dropped and the replacement starts clear', async () => {
    seedStore({ user: userU, isAuthenticated: true, accountNotice: daysLeft } as WithHostedAccess)
    const pending = deferredValue<Response>()
    vi.mocked(fetch).mockImplementationOnce(() => pending.promise)
    const run = useAuthStore.getState().fetchSubscription()
    useAuthStore.getState().setUser(userV)
    expect(readNotice()).toBeNull()
    pending.resolve(ok({ status: 'trialing', accountNotice: daysLeft }))
    await run
    expect(readNotice()).toBeNull()
  })

  it('[RED] logout clears the notice', async () => {
    seedStore({ user: userU, isAuthenticated: true, subscriptionStatus: 'trialing', accountNotice: daysLeft } as WithHostedAccess)
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }))
    await useAuthStore.getState().logout()
    expect(readNotice()).toBeNull()
  })

  it('[RED] self-hosted and custom-server reads publish no notice', async () => {
    seedStore({ user: userU, isAuthenticated: true, accountNotice: daysLeft } as WithHostedAccess)
    localStorage.setItem('silentsuite-server-url', 'https://dav.example.test')
    await useAuthStore.getState().fetchSubscription()
    expect(readNotice()).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('never settles an account expiry claim from a billing retry that identifies another account', async () => {
    seedStore({ user: userU, isAuthenticated: true, accountNotice: daysLeft } as WithHostedAccess)
    const claimRead = deferredValue<Response>()
    const endedBody = { status: 'trialing', hostedAccess: 'trial_ended', accountNotice: { kind: 'trial_ended', endedAt: trialEndsAt } }
    vi.mocked(fetch).mockImplementation(async (url) => {
      const path = String(url)
      if (path.endsWith('/auth/refresh')) return ok({ id: userV.id, email: userV.email, planId: userV.planId, isAdmin: false, rememberDevice: true })
      if (path.endsWith('/subscription')) return subscriptionCalls() === 1 ? claimRead.promise : ok(endedBody)
      return new Response(null, { status: 204 })
    })
    expect(claim(trialEndsAt)).toBe(true)
    await useAuthStore.getState().retryBillingConnection()
    claimRead.resolve(ok({ status: 'trialing', accountNotice: daysLeft }))
    await new Promise(resolve => setTimeout(resolve, 0))
    const current = (useAuthStore.getState() as unknown as { trialExpiryRefreshClaim: { userId: string; response: unknown } | null }).trialExpiryRefreshClaim
    expect(current === null || (current.userId === userU.id && current.response === null)).toBe(true)
  })

  it('makes no expiry continuation when a newer read started after the discarded one', async () => {
    seedStore({ user: userU, isAuthenticated: true, accountNotice: daysLeft } as WithHostedAccess)
    const claimRead = deferredValue<Response>()
    const newerRead = deferredValue<Response>()
    vi.mocked(fetch)
      .mockImplementationOnce(() => claimRead.promise)
      .mockImplementationOnce(() => newerRead.promise)
      .mockResolvedValue(ok({ status: 'trialing', accountNotice: daysLeft }))
    expect(claim(trialEndsAt)).toBe(true)
    // A fresh user object for the same account discards the claim's read...
    useAuthStore.getState().setUser({ ...userU })
    claimRead.resolve(ok({ status: 'trialing', accountNotice: daysLeft }))
    // ...and a newer read starts before the claim's continuation would resume.
    queueMicrotask(() => { void useAuthStore.getState().fetchSubscription() })
    await vi.waitFor(() => expect(subscriptionCalls()).toBeGreaterThanOrEqual(2))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(subscriptionCalls()).toBe(2)

    newerRead.resolve(ok({ status: 'trialing', hostedAccess: 'trial_ended', accountNotice: { kind: 'trial_ended', endedAt: trialEndsAt } }))
    await vi.waitFor(() => expect(readNotice()).toEqual({ kind: 'trial_ended', endedAt: trialEndsAt }))
    const settled = (useAuthStore.getState() as unknown as { trialExpiryRefreshClaim: { response: unknown } | null }).trialExpiryRefreshClaim
    expect(settled?.response).toMatchObject({ hostedAccess: 'trial_ended' })
    expect(subscriptionCalls()).toBe(2)
  })

  it('[RED] one expiry claim per account generation and trial end; a replacement account claims afresh', async () => {
    seedStore({ user: userU, isAuthenticated: true, accountNotice: daysLeft } as WithHostedAccess)
    vi.mocked(fetch).mockImplementation(async (url) => (String(url).endsWith('/subscription')
      ? ok({ status: 'trialing', accountNotice: { kind: 'trial_ended', endedAt: trialEndsAt } })
      : new Response(null, { status: 204 })))
    expect(claim(trialEndsAt)).toBe(true)
    expect(claim(trialEndsAt)).toBe(false)
    await vi.waitFor(() => expect(readNotice()).toEqual({ kind: 'trial_ended', endedAt: trialEndsAt }))
    expect(claim(trialEndsAt)).toBe(false)
    expect(subscriptionCalls()).toBe(1)

    await useAuthStore.getState().logout()
    seedStore({ user: userV, isAuthenticated: true, accountNotice: daysLeft } as WithHostedAccess)
    expect(claim(trialEndsAt)).toBe(true)
    await vi.waitFor(() => expect(subscriptionCalls()).toBe(2))
  })
})
