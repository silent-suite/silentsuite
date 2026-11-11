import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SubscriptionPage from '@/app/(app)/settings/subscription/page'
import AccountPage from '@/app/(app)/settings/account/page'
import { useAuthStore } from '@/app/stores/use-auth-store'

vi.mock('next/dynamic', () => ({ default: () => function MockStripePaymentForm() { return null } }))
vi.mock('@/app/lib/date', () => ({ formatDate: (date: Date) => date.toISOString().slice(0, 10) }))
vi.mock('@/app/lib/self-hosted', () => ({ isSelfHosted: false, isCustomServer: () => false }))
vi.mock('@/app/lib/config', () => ({ BILLING_API_URL: 'https://billing.test', ETEBASE_SERVER_URL: 'https://server.example.test' }))
vi.mock('@/app/stores/use-preferences-sync-store', () => ({
  usePreferencesSyncStore: (selector: (value: { pushNow: () => Promise<boolean> }) => unknown) => selector({ pushNow: async () => true }),
}))

const user = { id: 'acct-1', email: 'u@example.com', planId: 'early_annual', isAdmin: false }
const subscription = {
  plan: 'early_annual', planLabel: 'Early annual', billingInterval: 'annual', status: 'trialing', renewalDate: null,
  trial: { active: true, endsAt: '2099-01-08T00:00:00.000Z', daysRemaining: 7 }, cancelAtPeriodEnd: false,
  trialPath: '7day', earlyAdopter: true,
}
const account = { id: 'acct-1', email: 'u@example.com', isAdmin: false, provisioningStatus: 'trialing_no_card', createdAt: '2026-11-11T08:53:11.000Z' }

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body, clone() { return this } }) as unknown as Response
const flush = () => act(async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve() })
const calls = (url: string) => vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === url).length

/** The resource answers 401 until a refresh succeeds; the refresh outcome is the test's choice. */
function routeBilling(resource: string, body: unknown, refreshSucceeds: boolean) {
  let refreshed = false
  const refreshSession = vi.fn(async () => { refreshed = refreshSucceeds; return refreshSucceeds })
  useAuthStore.setState({ refreshSession } as unknown as Partial<ReturnType<typeof useAuthStore.getState>>)
  vi.mocked(fetch).mockImplementation((async (input: string) => {
    if (input === `https://billing.test${resource}`) return refreshed ? json(200, body) : json(401, { status: 401 })
    if (input === 'https://billing.test/auth/session') return json(200, { id: user.id, email: user.email })
    return json(404, {})
  }) as unknown as typeof fetch)
  return refreshSession
}

describe('Settings billing reads after the 15-minute access token expires', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn())
    useAuthStore.setState({ user, isAuthenticated: true, subscriptionStatus: 'trialing', hostedAccess: 'entitled' } as unknown as Partial<ReturnType<typeof useAuthStore.getState>>)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('Subscription refreshes once and shows the plan instead of the unavailable view', async () => {
    const refreshSession = routeBilling('/subscription', subscription, true)
    render(<SubscriptionPage />)
    await flush()
    expect(refreshSession).toHaveBeenCalledTimes(1)
    expect(calls('https://billing.test/subscription')).toBe(2)
    expect(screen.queryByText('Unable to load subscription details.')).not.toBeInTheDocument()
    expect(screen.getByText('Early annual')).toBeInTheDocument()
  })

  it('Subscription keeps the unavailable view without a retry when the refresh fails', async () => {
    const refreshSession = routeBilling('/subscription', subscription, false)
    render(<SubscriptionPage />)
    await flush()
    expect(refreshSession).toHaveBeenCalledTimes(1)
    expect(calls('https://billing.test/subscription')).toBe(1)
    expect(screen.getByText('Unable to load subscription details.')).toBeInTheDocument()
  })

  it('Account refreshes once and shows the billing account details', async () => {
    const refreshSession = routeBilling('/account', account, true)
    render(<AccountPage />)
    await flush()
    expect(refreshSession).toHaveBeenCalledTimes(1)
    expect(calls('https://billing.test/account')).toBe(2)
    expect(screen.getByText('trialing no card')).toBeInTheDocument()
  })
})

// Captured at import, before any test replaces it, so the wired cases run the store's real refresh.
const realRefreshSession = useAuthStore.getState().refreshSession

/**
 * Wired reproducer: only the network is simulated. Billing answers 401 to every protected read
 * while the 15-minute access cookie is expired, and /auth/refresh renews it from the refresh
 * cookie, as production does. The page and the store's real refreshSession run unmodified.
 */
function billingWithExpiredAccessToken(rememberDevice: boolean) {
  let accessValid = false
  const identity = { id: user.id, email: user.email, planId: user.planId, isAdmin: false, emailVerified: true, rememberDevice, onboardedAt: null }
  vi.mocked(fetch).mockImplementation((async (input: string, init?: RequestInit) => {
    if (input === 'https://billing.test/auth/refresh' && init?.method === 'POST') { accessValid = true; return json(200, identity) }
    if (!accessValid) return json(401, { status: 401, title: 'Unauthorized' })
    if (input === 'https://billing.test/subscription') return json(200, subscription)
    if (input === 'https://billing.test/account') return json(200, account)
    if (input === 'https://billing.test/auth/session') return json(200, identity)
    return json(404, {})
  }) as unknown as typeof fetch)
}

describe('wired: a 7-day no-card trial opens Settings after its access token expired', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    vi.stubGlobal('fetch', vi.fn())
    useAuthStore.setState({ user: { ...user, rememberDevice: true }, isAuthenticated: true, subscriptionStatus: 'trialing', hostedAccess: 'entitled', refreshSession: realRefreshSession } as unknown as Partial<ReturnType<typeof useAuthStore.getState>>)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it.each([
    ['remembered device', true],
    ['session-only sign-in', false],
  ])('Subscription loads the trial instead of "Unable to load subscription details." (%s)', async (_label, rememberDevice) => {
    if (!rememberDevice) {
      sessionStorage.setItem('silentsuite-hosted-validation-session', JSON.stringify({ userId: user.id, rememberDevice: false, validatedAt: Date.now() }))
    }
    billingWithExpiredAccessToken(rememberDevice)
    render(<SubscriptionPage />)
    await flush()
    await flush()
    expect(calls('https://billing.test/auth/refresh')).toBe(1)
    expect(screen.queryByText('Unable to load subscription details.')).not.toBeInTheDocument()
    expect(screen.getByText('Early annual')).toBeInTheDocument()
    expect(useAuthStore.getState().user?.id).toBe(user.id)
  })

  it('Account shows the billing account details', async () => {
    billingWithExpiredAccessToken(true)
    render(<AccountPage />)
    await flush()
    await flush()
    expect(calls('https://billing.test/auth/refresh')).toBe(1)
    expect(screen.getByText('trialing no card')).toBeInTheDocument()
  })
})
