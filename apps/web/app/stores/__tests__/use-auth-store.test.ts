import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAuthStore } from '../use-auth-store'
import { secureClear } from '@/app/lib/secure-storage'

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
  calendarListSetState,
  taskListSetState,
  contactListSetState,
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
  calendarListSetState: vi.fn(),
  taskListSetState: vi.fn(),
  contactListSetState: vi.fn(),
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
  etebaseLogIn: vi.fn().mockResolvedValue({
    authToken: 'mock-auth-token',
    savedSession: 'mock-saved-session',
  }),
}))

// Mock self-hosted checks
vi.mock('@/app/lib/self-hosted', () => ({
  isSelfHosted: false,
  isCustomServer: () => false,
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
vi.mock('@/app/stores/use-calendar-list-store', () => ({ useCalendarListStore: { setState: calendarListSetState } }))
vi.mock('@/app/stores/use-task-list-store', () => ({ useTaskListStore: { setState: taskListSetState } }))
vi.mock('@/app/stores/use-contact-list-store', () => ({ useContactListStore: { setState: contactListSetState } }))
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

describe('useAuthStore', () => {
  beforeEach(() => {
    resetStore()
    vi.mocked(fetch).mockReset()
    dataCacheClearAll.mockClear()
    offlineQueueClearAll.mockClear()
    calendarSetState.mockClear()
    taskSetState.mockClear()
    contactSetState.mockClear()
    calendarListSetState.mockClear()
    taskListSetState.mockClear()
    contactListSetState.mockClear()
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

  it('signup sends a trimmed promo code when provided', async () => {
    useAuthStore.setState({
      pendingSignup: {
        email: 'promo@example.com',
        etebaseAuthToken: 'etebase-token',
        wantsProductUpdates: true,
      },
    })

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'user-1', isAdmin: false, clientSecret: 'cs_test' }),
    } as Response)

    await useAuthStore.getState().signup('early_monthly', '30day', '  beta196  ')

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/auth/provision'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          etebaseSessionToken: 'etebase-token',
          planId: 'early_monthly',
          trialPath: '30day',
          promoCode: 'beta196',
          wantsProductUpdates: true,
          rememberDevice: false,
        }),
      }),
    )
  })

  it('signup omits an empty promo code', async () => {
    useAuthStore.setState({
      pendingSignup: {
        email: 'promo@example.com',
        etebaseAuthToken: 'etebase-token',
      },
    })

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'user-1', isAdmin: false, clientSecret: 'cs_test' }),
    } as Response)

    await useAuthStore.getState().signup('early_monthly', '30day', '   ')

    const [, init] = vi.mocked(fetch).mock.calls[0]
    expect(JSON.parse(init?.body as string)).toEqual({
      etebaseSessionToken: 'etebase-token',
      planId: 'early_monthly',
      trialPath: '30day',
      rememberDevice: false,
    })
  })

  it('starts a paid signup payment session before an Etebase account exists', async () => {
    useAuthStore.setState({
      pendingSignup: {
        email: 'paid@example.com',
        wantsProductUpdates: false,
      },
    })

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        clientSecret: 'seti_secret',
        cryptoCheckoutUrl: null,
        cryptoInvoiceId: null,
        cryptoInvoiceLookupToken: null,
        paymentSessionToken: 'signup-session-token',
      }),
    } as Response)

    const result = await useAuthStore.getState().signup('early_monthly', '30day', ' BETA196 ')

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/auth/signup/payment-session'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          email: 'paid@example.com',
          planId: 'early_monthly',
          trialPath: '30day',
          promoCode: 'BETA196',
          wantsProductUpdates: false,
          rememberDevice: false,
        }),
      }),
    )
    expect(result.paymentSessionToken).toBe('signup-session-token')
    expect(useAuthStore.getState().pendingSignup?.paymentSessionToken).toBe('signup-session-token')
    expect(useAuthStore.getState().pendingSignup?.etebaseAuthToken).toBeUndefined()
  })

  it('clears stale payment state when the signup draft email changes', () => {
    useAuthStore.setState({
      pendingSignup: {
        email: 'old@example.com',
        etebaseAuthToken: 'old-etebase-token',
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
    useAuthStore.setState({
      pendingSignup: {
        email: 'paid@example.com',
        etebaseAuthToken: 'etebase-token',
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
          etebaseSessionToken: 'etebase-token',
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
        etebaseAuthToken: 'etebase-token',
      },
    })

    await expect(useAuthStore.getState().finalizePaidSignup()).rejects.toThrow('No completed payment session')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('signup returns crypto checkout details without authenticating', async () => {
    useAuthStore.setState({
      pendingSignup: {
        email: 'crypto@example.com',
        etebaseAuthToken: 'etebase-token',
      },
    })

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'user-1',
        isAdmin: false,
        clientSecret: null,
        cryptoCheckoutUrl: 'https://btcpay.silentsuite.io/i/inv-123',
        cryptoInvoiceId: 'inv-123',
        cryptoInvoiceLookupToken: 'lookup-token',
      }),
    } as Response)

    const result = await useAuthStore.getState().signup('early_annual', 'crypto_annual')

    expect(result).toEqual({
      clientSecret: null,
      cryptoCheckoutUrl: 'https://btcpay.silentsuite.io/i/inv-123',
      cryptoInvoiceId: 'inv-123',
      cryptoInvoiceLookupToken: 'lookup-token',
      paymentSessionToken: null,
    })
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
  })

  // --- onboardedAt hydration (issue #113) ---

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
          etebaseAuthToken: 'tok',
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
    expect(calendarListSetState).toHaveBeenCalledWith(expect.objectContaining({ defaultCalendarId: 'default' }))
    expect(taskListSetState).toHaveBeenCalledWith(expect.objectContaining({ activeListId: 'all' }))
    expect(contactListSetState).toHaveBeenCalledWith(expect.objectContaining({ activeListId: 'all' }))
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
      etebaseAuthToken: 'auth-token-abc',
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
