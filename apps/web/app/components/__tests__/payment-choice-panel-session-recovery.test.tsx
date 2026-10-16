import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PaymentChoicePanel from '../payment-choice-panel'
import LoginPage from '../../(auth)/login/page'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { bumpAccountEpoch, getAccountEpoch } from '@/app/lib/account-epoch'
import { checkoutIntentToken as signedCheckoutIntent } from '@/src/__tests__/fixtures/annual-authority'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_BTCPAY_CHECKOUT_ENABLED = 'true'
  process.env.NEXT_PUBLIC_BTCPAY_CHECKOUT_ORIGIN = 'https://btcpay.test'
})
vi.mock('@/app/lib/config', () => ({ BILLING_API_URL: 'https://billing.example.test', ETEBASE_SERVER_URL: 'https://server.example.test' }))
// External Stripe checkout is outside session recovery; the real panel owns
// whether a verified continuation can reach it.
vi.mock('next/dynamic', () => ({ default: () => () => <div data-testid="stripe-payment-form" /> }))
const navigation = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), query: '' }))
vi.mock('next/navigation', () => ({
  useRouter: () => navigation,
  useSearchParams: () => new URLSearchParams(navigation.query),
}))

const ACCOUNT = { id: 'account-a', email: 'a@example.invalid', planId: 'early_annual', rememberDevice: true, emailVerified: true }
const OTHER = { ...ACCOUNT, id: 'account-b', email: 'b@example.invalid', planId: 'standard_annual' }
const AUTHORITY = '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607'
const OFFER = '/subscription/offers/v2'
const CURRENT = '/subscription/payment-flows/current'
const RESUME = '/subscription/payment-flows/v2/resume'
const CANCEL = '/subscription/payment-flows/cancel'
const PROFILE = 'account_confirmation_rules_v1'
const terms = {
  kind: 'charge_now', annualAmountMinor: 3600, firstChargeAmountMinor: 3600, renewalAmountMinor: 3600, monthlyEquivalentMinor: 300,
  currency: 'EUR', trialEndsAt: null, firstChargeAt: null, cancelBy: null, cancelByInclusive: false, autoRenew: true, prepaid: false,
  refundWindowDays: 30, bonusDays: 0, periodEndRule: PROFILE, renewalAt: null, entitlementEndsAt: null,
}
const offer = {
  contractVersion: 2, requestId: 'e91a6d70-0d4e-4352-9bdc-426d1f76d771',
  offer: { planId: 'early_annual', customerClass: 'early', billingInterval: 'annual', annualAmountMinor: 3600, monthlyEquivalentMinor: 300,
    currency: 'EUR', providers: ['stripe', 'btcpay'], offerRevision: 1, offerToken: 'signed-offer', expiresAt: '2026-08-10T12:10:00Z' },
  accountTermsProfile: PROFILE,
  accountDisclosures: { stripe: terms, btcpay: { ...terms, kind: 'prepaid', renewalAmountMinor: null, autoRenew: false, prepaid: true } },
}
const retainedFlow = {
  flowKind: 'stripe_pay_now', provider: 'stripe', status: 'provider_creation_reconciling', createdAt: '2026-08-10T12:00:00Z',
  cancellable: true, authorityId: AUTHORITY, disclosure: terms,
}
const continuation = { contractVersion: 2, kind: 'stripe', authorityId: AUTHORITY, clientSecret: 'retained-secret', disclosure: terms }
const rejected = () => Response.json({ type: 'invalid-access-token', detail: 'Invalid or expired access token' }, { status: 401 })
function barrier<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const originalRefresh = useAuthStore.getState().refreshSession
let refresh: ReturnType<typeof vi.fn<() => Promise<boolean>>>
type Call = { path: string; method: string; body: string | null; account: string | null; epoch: number; credentials: RequestCredentials | undefined }
let calls: Call[]
function installTransport(input: { flow?: typeof retainedFlow | null; reject?: string[] } = {}) {
  let flow = input.flow ?? null
  const rejectedPaths = new Set(input.reject ?? [])
  const effects = { resume: 0, cancel: 0 }
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname
    calls.push({ path, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : null,
      account: useAuthStore.getState().user?.id ?? null, epoch: getAccountEpoch(), credentials: init?.credentials })
    if (rejectedPaths.delete(path)) return rejected() // middleware rejected before any business effect
    if (path === OFFER) return Response.json(offer)
    if (path === CURRENT) return Response.json({ flow })
    if (path === '/auth/session') return Response.json(ACCOUNT)
    if (path === RESUME) { effects.resume++; return Response.json(continuation) }
    if (path === CANCEL) { effects.cancel++; flow = null; return Response.json({ cancelled: true, flowKind: 'stripe_pay_now' }) }
    throw new Error(`unexpected test transport path ${path}`)
  })
  return effects
}
const at = (path: string) => calls.filter(call => call.path === path)
const renderPanel = () => render(<PaymentChoicePanel onSuccess={vi.fn()} />)

beforeEach(() => {
  calls = []
  localStorage.clear()
  sessionStorage.clear()
  bumpAccountEpoch()
  navigation.query = ''
  navigation.replace.mockClear()
  navigation.push.mockClear()
  // This replaces only the existing session boundary. Store subscription,
  // identity and account epoch are real; separate real-store tests cover its
  // asynchronous refresh publication and logout behavior.
  refresh = vi.fn(async () => true)
  useAuthStore.setState({ user: ACCOUNT, isAuthenticated: true, isLoading: false, error: null, pendingSignup: null,
    subscriptionStatus: 'cancelled', refreshSession: refresh })
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => {
  useAuthStore.setState({ refreshSession: originalRefresh, user: null, isAuthenticated: false })
  vi.unstubAllGlobals()
})

describe('rendered Billing session recovery', () => {
  // Requested: "Billing rejecting the current sign-in token, with no clear recovery."
  it('retains a fresh sign-in and uses existing payment options without unnecessary refresh', async () => {
    installTransport()
    renderPanel()
    expect(await screen.findByRole('button', { name: /continue to card payment/i })).toBeEnabled()
    expect(at(OFFER)).toHaveLength(1)
    expect(at(CURRENT)).toHaveLength(1)
    expect(refresh).not.toHaveBeenCalled()
    expect(useAuthStore.getState().user).toEqual(ACCOUNT)
  })

  it('keeps existing login usable before authentication and returns a newly signed-in account to subscription settings', async () => {
    useAuthStore.setState({ user: null, isAuthenticated: false })
    navigation.query = 'returnTo=%2Fsettings%2Fsubscription'
    render(<LoginPage />)
    expect(await screen.findByLabelText('Email address')).toBeInTheDocument()
    expect(navigation.replace).not.toHaveBeenCalled()
    await act(async () => { useAuthStore.setState({ user: ACCOUNT, isAuthenticated: true }) })
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith('/settings/subscription'))
  })

  it.each([OFFER, CURRENT])('refreshes once and retries explicit authentication refusal on %s', async path => {
    installTransport({ reject: [path] })
    renderPanel()
    await waitFor(() => expect(at(path)).toHaveLength(1))
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    await screen.findByRole('button', { name: /continue to card payment/i })
    expect(at(path)).toHaveLength(2)
    expect(at(path)[1]).toEqual(at(path)[0])
    expect(useAuthStore.getState().user).toEqual(ACCOUNT)
    expect(useAuthStore.getState().isAuthenticated).toBe(true)
    expect(calls.filter(call => call.method !== 'GET')).toEqual([])
  })

  it('coalesces concurrent offer/current authentication refusals into one existing session refresh', async () => {
    installTransport({ reject: [OFFER, CURRENT] })
    const gate = barrier<boolean>()
    refresh.mockImplementation(() => gate.promise)
    renderPanel()
    try {
      await waitFor(() => expect(at(OFFER)).toHaveLength(1))
      await waitFor(() => expect(at(CURRENT)).toHaveLength(1))
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
      expect(at(OFFER).concat(at(CURRENT))).toHaveLength(2)
      await act(async () => { gate.resolve(true) })
      await screen.findByRole('button', { name: /continue to card payment/i })
      expect(at(OFFER)).toHaveLength(2)
      expect(at(CURRENT)).toHaveLength(2)
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(useAuthStore.getState().user).toEqual(ACCOUNT)
    } finally { gate.resolve(false) }
  })

  it.each([RESUME, CANCEL])('retries only the explicitly auth-rejected %s POST with the same account, authority and body', async path => {
    const effects = installTransport({ flow: retainedFlow, reject: [path] })
    renderPanel()
    const button = await screen.findByRole('button', { name: path === RESUME ? /resume card payment/i : /cancel card payment/i })
    expect(button).toBeEnabled()
    fireEvent.click(button)
    await waitFor(() => expect(at(path)).toHaveLength(1))
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(at(path)).toHaveLength(2))
    expect(at(path)[1]).toEqual(at(path)[0])
    expect(JSON.parse(at(path)[0].body!)).toEqual(path === RESUME
      ? { contractVersion: 2, authorityId: AUTHORITY } : { expectedAuthorityId: AUTHORITY })
    expect(effects).toEqual({ resume: path === RESUME ? 1 : 0, cancel: path === CANCEL ? 1 : 0 })
    expect(useAuthStore.getState().user).toEqual(ACCOUNT)
    expect(calls.some(call => /activate$|payment-flows\/v2$/.test(call.path))).toBe(false)
    if (path === RESUME) expect(await screen.findByTestId('stripe-payment-form')).toBeInTheDocument()
    else expect(await screen.findByRole('button', { name: /continue to card payment/i })).toBeEnabled()
  })

  it.each([401, 403])('offers existing login with safe subscription return after definitive refresh %s, without stale-auth redirect', async status => {
    installTransport({ reject: [OFFER] })
    refresh.mockImplementation(async () => {
      expect([401, 403]).toContain(status)
      useAuthStore.setState({ user: null, isAuthenticated: false })
      return false
    })
    const panel = renderPanel()
    const link = await screen.findByRole('link', { name: /sign in/i })
    expect(refresh).toHaveBeenCalledTimes(1)
    const destination = new URL(link.getAttribute('href')!, window.location.origin)
    expect(destination.origin).toBe(window.location.origin)
    expect(destination.pathname).toBe('/login')
    expect(destination.searchParams.get('returnTo')).toBe('/settings/subscription')
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    panel.unmount()
    navigation.query = destination.searchParams.toString()
    render(<LoginPage />)
    expect(await screen.findByLabelText('Email address')).toBeInTheDocument()
    expect(navigation.replace).not.toHaveBeenCalled()
  })

  it.each(['network', '5xx'])('keeps a transient %s refresh failure retryable without logout or authority loss', async failure => {
    installTransport({ flow: retainedFlow, reject: [OFFER] })
    refresh.mockImplementation(async () => { if (failure === 'network') throw new TypeError('Failed to fetch'); return false })
    renderPanel()
    expect(await screen.findByRole('button', { name: /resume card payment/i })).toBeInTheDocument()
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(useAuthStore.getState().user).toEqual(ACCOUNT)
    expect(useAuthStore.getState().isAuthenticated).toBe(true)
    expect(calls.filter(call => call.method === 'POST')).toEqual([])
    const retry = screen.getByRole('button', { name: /retry.*(offer|sign-in|session)/i })
    expect(retry).toBeEnabled()
    refresh.mockResolvedValue(true)
    fireEvent.click(retry)
    await waitFor(() => expect(at(OFFER)).toHaveLength(2))
    expect(screen.getByRole('button', { name: /resume card payment/i })).toBeInTheDocument()
  })

  it.each(['logout', 'replacement'] as const)('does not publish an old account offer after %s changes the epoch', async transition => {
    installTransport()
    const base = vi.mocked(fetch).getMockImplementation()!
    const entered = barrier<void>()
    const gate = barrier<Response>()
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname === OFFER) { entered.resolve(); return gate.promise }
      return base(input, init)
    })
    renderPanel()
    await entered.promise
    const epoch = getAccountEpoch()
    await act(async () => {
      bumpAccountEpoch()
      useAuthStore.setState({ user: transition === 'logout' ? null : OTHER, isAuthenticated: transition !== 'logout' })
      gate.resolve(Response.json(offer))
    })
    expect(getAccountEpoch()).toBeGreaterThan(epoch)
    await waitFor(() => expect(screen.queryByText('Loading payment options...')).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /continue to card payment.*early/i })).not.toBeInTheDocument()
    expect(useAuthStore.getState().user).toEqual(transition === 'logout' ? null : OTHER)
  })

  it.each(['logout', 'replacement'] as const)('does not show an old authority continuation after %s while resume awaits', async transition => {
    installTransport({ flow: retainedFlow })
    const base = vi.mocked(fetch).getMockImplementation()!
    const entered = barrier<void>()
    const gate = barrier<Response>()
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname === RESUME) { entered.resolve(); return gate.promise }
      return base(input, init)
    })
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /resume card payment/i }))
    await entered.promise
    await act(async () => {
      bumpAccountEpoch()
      useAuthStore.setState({ user: transition === 'logout' ? null : OTHER, isAuthenticated: transition !== 'logout' })
      gate.resolve(Response.json(continuation))
    })
    expect(screen.queryByTestId('stripe-payment-form')).not.toBeInTheDocument()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('does not retry an old-account resume POST when the account epoch changes during refresh', async () => {
    installTransport({ flow: retainedFlow, reject: [RESUME] })
    const gate = barrier<boolean>()
    refresh.mockImplementation(() => gate.promise)
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /resume card payment/i }))
    try {
      await waitFor(() => expect(at(RESUME)).toHaveLength(1))
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
      await act(async () => {
        bumpAccountEpoch()
        useAuthStore.setState({ user: OTHER, isAuthenticated: true })
        gate.resolve(true)
      })
      await waitFor(() => expect(screen.queryByText('Resuming payment...')).not.toBeInTheDocument())
      expect(at(RESUME)).toHaveLength(1)
      expect(screen.queryByTestId('stripe-payment-form')).not.toBeInTheDocument()
      expect(useAuthStore.getState().user).toEqual(OTHER)
    } finally { gate.resolve(false) }
  })

  it.each(['network', '5xx', 'malformed'])('recovers current status after an ambiguous %s first-start without refreshing or allocating another authority', async failure => {
    installTransport()
    const base = vi.mocked(fetch).getMockImplementation()!
    let starts = 0
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path === `${OFFER}/activate` || path === '/subscription/payment-flows/v2') {
        calls.push({ path, method: init?.method ?? 'GET', body: String(init?.body), account: useAuthStore.getState().user?.id ?? null,
          epoch: getAccountEpoch(), credentials: init?.credentials })
        if (path.endsWith('/activate')) return Response.json({ contractVersion: 2, checkoutIntentToken: signedCheckoutIntent,
          expiresAt: '2026-08-10T12:05:00Z', disclosure: terms })
        starts++ // the invocation may already have claimed this one authority
        if (failure === 'network') throw new TypeError('Failed to fetch')
        if (failure === 'malformed') return new Response('lost-response', { status: 200 })
        return Response.json({ type: 'unavailable' }, { status: 503 })
      }
      const response = await base(input, init)
      return path === CURRENT && starts ? Response.json({ flow: retainedFlow }) : response
    })
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /continue to card payment/i }))
    expect(await screen.findByRole('button', { name: /resume card payment/i })).toBeEnabled()
    expect(starts).toBe(1)
    expect(at(`${OFFER}/activate`)).toHaveLength(1)
    expect(at('/subscription/payment-flows/v2')).toHaveLength(1)
    expect(JSON.parse(at('/subscription/payment-flows/v2')[0].body!)).toEqual({ contractVersion: 2,
      checkoutIntentToken: signedCheckoutIntent, returnUrl: `${window.location.origin}/settings/subscription` })
    expect(at(CURRENT)).toHaveLength(2)
    expect(refresh).not.toHaveBeenCalled()
    expect(useAuthStore.getState().user).toEqual(ACCOUNT)
  })

  it.each([
    [RESUME, 'network'], [RESUME, '5xx'], [RESUME, 'malformed'],
    [CANCEL, 'network'], [CANCEL, '5xx'], [CANCEL, 'malformed'],
  ])('does not refresh or replay ambiguous %s mutation after %s', async (path, failure) => {
    installTransport({ flow: retainedFlow })
    const base = vi.mocked(fetch).getMockImplementation()!
    let invocations = 0
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (new URL(String(input)).pathname === path) {
        invocations++
        if (failure === 'network') throw new TypeError('Failed to fetch')
        if (failure === 'malformed') return new Response('lost-body', { status: 200 })
        return Response.json({ type: 'unavailable' }, { status: 503 })
      }
      return base(input, init)
    })
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: path === RESUME ? /resume card payment/i : /cancel card payment/i }))
    await screen.findByText(path === CANCEL ? /could not cancel the pending payment flow/i : /Failed to fetch|Billing request failed|Billing returned an invalid response/i)
    expect(invocations).toBe(1)
    expect(refresh).not.toHaveBeenCalled()
    expect(screen.getByText('Payment already in progress')).toBeInTheDocument()
    expect(screen.queryByTestId('stripe-payment-form')).not.toBeInTheDocument()
    expect(calls.some(call => /activate$|payment-flows\/v2$/.test(call.path))).toBe(false)
    expect(useAuthStore.getState().user).toEqual(ACCOUNT)
  })
})
