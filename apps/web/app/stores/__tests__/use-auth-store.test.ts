import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAuthStore } from '../use-auth-store'

// Mock fetch globally
vi.stubGlobal('fetch', vi.fn())

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

    it('restoreSession enters degraded mode on network error with etebase session', async () => {
      secureStore['etebase_session'] = 'fake-session-data'
      vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'))

      await useAuthStore.getState().restoreSession()

      const state = useAuthStore.getState()
      expect(state.isAuthenticated).toBe(true)
      expect(state.subscriptionStatus).toBe('billing_unavailable')
      expect(state.user).toEqual({ id: 'degraded', email: '', planId: 'unknown', isAdmin: false })
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
          json: async () => ({ id: 'u1', email: 'test@x.com', planId: 'pro', isAdmin: false }),
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

    it('retryBillingConnection returns false on continued network failure', async () => {
      useAuthStore.setState({ subscriptionStatus: 'billing_unavailable' })
      vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'))

      const result = await useAuthStore.getState().retryBillingConnection()

      expect(result).toBe(false)
    })
  })
})
