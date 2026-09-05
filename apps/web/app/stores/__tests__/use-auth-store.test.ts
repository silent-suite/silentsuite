import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAuthStore } from '../use-auth-store'
import { secureClear } from '@/app/lib/secure-storage'
import { logger } from '@/app/lib/logger'

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

// Mock self-hosted checks
vi.mock('@/app/lib/self-hosted', () => ({
  isSelfHosted: false,
  isCustomServer: (serverUrl?: string) => Boolean(serverUrl && serverUrl !== 'https://server.silentsuite.io'),
}))

// Mock etebase store (used by logout)
vi.mock('@/app/stores/use-etebase-store', () => ({
  useEtebaseStore: {
    getState: () => ({ destroy: vi.fn() }),
  },
}))

vi.mock('@/app/stores/use-calendar-store', () => ({ useCalendarStore: { setState: calendarSetState } }))
vi.mock('@/app/stores/use-task-store', () => ({ useTaskStore: { setState: taskSetState } }))
vi.mock('@/app/stores/use-contact-store', () => ({ useContactStore: { setState: contactSetState } }))
vi.mock('@/app/stores/use-note-store', () => ({ useNoteStore: { setState: noteSetState } }))
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

function resetStore() {
  useAuthStore.setState({
    user: null,
    isAuthenticated: false,
    isLoading: false,
    error: null,
    pendingSignup: null,
    subscriptionStatus: null,
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
        'http://localhost:3000/signup/return',
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

    it('rejects cross-origin annual return URLs before contacting Billing', async () => {
      useAuthStore.getState().prepareSignupDraft('origin@example.com')
      await expect(useAuthStore.getState().startAnnualSignupPayment(
        checkoutIntentToken, 'stripe', 'https://attacker.example/return',
      )).rejects.toThrow('must stay on this origin')
      expect(fetch).not.toHaveBeenCalled()
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
    const result = await useAuthStore.getState().startAnnualSignupPayment('abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', 'stripe', 'http://localhost:3000/signup/success')
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

    vi.mocked(etebaseSignUp).mockRejectedValueOnce(new Error('409 conflict'))
    await useAuthStore.getState().createEtebaseAccount('recover-no-card@example.test', 'password123')
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      contractVersion: 2, id: '5fd4d86d-34de-4b82-9a66-9598ddf6e02f', email: 'recover-no-card@example.test',
      provisioningStatus: 'trialing_no_card', emailVerified: true, earlyAdopter: true, rememberDevice: false,
      createdAt: '2026-08-11T00:00:00Z', clientSecret: null, cryptoCheckoutUrl: null,
      cryptoInvoiceId: null, cryptoInvoiceLookupToken: null,
    })))
    await useAuthStore.getState().provisionAnnualNoCard('abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG')

    expect(etebaseLogIn).toHaveBeenCalledWith('recover-no-card@example.test', 'password123', undefined)
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

    vi.mocked(etebaseSignUp).mockRejectedValueOnce(new Error('409 conflict'))
    await useAuthStore.getState().createEtebaseAccount('recover-paid@example.test', 'password123')
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      contractVersion: 2, id: '5fd4d86d-34de-4b82-9a66-9598ddf6e02f', email: 'recover-paid@example.test',
      planId: 'early_annual', provisioningStatus: 'active', emailVerified: true, earlyAdopter: true,
      rememberDevice: false, isAdmin: false, createdAt: '2026-08-11T00:00:00Z', clientSecret: null,
      cryptoCheckoutUrl: null, cryptoInvoiceId: null, cryptoInvoiceLookupToken: null,
    })))
    await useAuthStore.getState().finalizePaidSignup()

    expect(etebaseLogIn).toHaveBeenCalledWith('recover-paid@example.test', 'password123', undefined)
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

  it('logout clears state', async () => {
    // Set up logged-in state
    useAuthStore.setState({
      user: { id: 'user-1', email: 'test@example.com', planId: 'pro' },
      isAuthenticated: true,
    })

    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response)

    await useAuthStore.getState().logout()

    const state = useAuthStore.getState()
    expect(state.user).toBeNull()
    expect(state.isAuthenticated).toBe(false)
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


    it('retryBillingConnection rejects non-remembered refresh when the session marker is missing', async () => {
      secureStore['etebase_session'] = 'fake-session-data'
      useAuthStore.setState({ subscriptionStatus: 'billing_unavailable', isAuthenticated: true })
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 'u1', email: 'test@x.com', planId: 'pro', isAdmin: false, rememberDevice: false }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ status: 'active' }),
        } as Response)
        .mockResolvedValueOnce({ ok: true, status: 204 } as Response)

      const result = await useAuthStore.getState().retryBillingConnection()

      expect(result).toBe(false)
      expect(useAuthStore.getState().isAuthenticated).toBe(false)
      expect(secureStore['etebase_session']).toBeUndefined()
      expect(fetch).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining('/auth/session'),
        expect.objectContaining({ method: 'DELETE', credentials: 'include' }),
      )
    })


    it('retryBillingConnection clears local auth on explicit refresh auth failure', async () => {
      secureStore['etebase_session'] = 'fake-session-data'
      useAuthStore.setState({ subscriptionStatus: 'billing_unavailable', isAuthenticated: true })
      vi.mocked(fetch)
        .mockResolvedValueOnce({ ok: false, status: 401 } as Response)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'active' }) } as Response)
        .mockResolvedValueOnce({ ok: true, status: 204 } as Response)

      const result = await useAuthStore.getState().retryBillingConnection()

      expect(result).toBe(false)
      expect(useAuthStore.getState().isAuthenticated).toBe(false)
      expect(secureStore['etebase_session']).toBeUndefined()
      expect(localStorage.getItem('silentsuite-hosted-auth-invalidated')).toBeTruthy()
      expect(fetch).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining('/auth/session'),
        expect.objectContaining({ method: 'DELETE', credentials: 'include' }),
      )
    })

    it('retryBillingConnection returns false on continued network failure', async () => {
      useAuthStore.setState({ subscriptionStatus: 'billing_unavailable' })
      vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'))

      const result = await useAuthStore.getState().retryBillingConnection()

      expect(result).toBe(false)
    })
  })

  // --- refreshSession non-destructive on transient errors ---
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

  // --- Stripe redirect signup state (issue #20) ---

  describe('signup redirect state storage', () => {
    const pending = {
      email: 'user@example.com',
      paymentSessionToken: 'payment-session-token',
    }

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
