import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import PendingPaymentPage from '../page'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_BTCPAY_CHECKOUT_ENABLED = 'true'
})

const paymentSessionToken = 'A'.repeat(43)
const paymentSessionRequestKey = '5fd4d86d-34de-4b82-9a66-9598ddf6e02f'
const authState = {
  completeSignup: vi.fn(),
  createEtebaseAccount: vi.fn(),
  finalizePaidSignup: vi.fn(),
  prepareSignupDraft: vi.fn(),
  startAnnualSignupPayment: vi.fn(),
  clearPendingSignupPaymentRecovery: vi.fn(),
  saveSignupStateForRedirect: vi.fn(),
  restoreSignupStateFromRedirect: vi.fn(),
  pendingSignup: null as any,
}

vi.mock('@/app/stores/use-auth-store', () => {
  function useAuthStore<T>(selector: (state: typeof authState) => T): T { return selector(authState) }
  useAuthStore.getState = () => authState
  return { useAuthStore }
})
vi.mock('@/app/lib/config', () => ({ BILLING_API_URL: 'https://billing.test' }))
vi.mock('@/app/lib/signup-return', () => ({ normalizeSignupReturnTo: (value: string | null) => value }))
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: { href: string; children: ReactNode }) => <a href={href} {...props}>{children}</a> }))
vi.mock('../components/step-create-vault', () => ({ StepCreateVault: () => <div data-testid="step-create-vault" /> }))
vi.mock('../../components/step-create-paid-account', () => ({
  StepCreatePaidAccount: ({ email, onNext }: { email: string; onNext: (data: { password: string; confirmPassword: string }) => Promise<void> }) => (
    <div data-testid="step-create-paid-account">
      <span>{email}</span>
      <button type="button" onClick={() => { void onNext({ password: 'RestoredPassword1', confirmPassword: 'RestoredPassword1' }) }}>
        Complete restored account
      </button>
    </div>
  ),
}))

function anonymousRecoverySignup(overrides: Record<string, unknown> = {}) {
  return {
    email: 'customer@example.test',
    billingContractVersion: 2,
    paymentMethod: 'btcpay',
    paymentSessionToken,
    paymentSessionRequestKey,
    ...overrides,
  }
}

const recoveryBody = { contractVersion: 2, email: 'customer@example.test', requestKey: paymentSessionRequestKey, recoverySecret: paymentSessionToken }
const REDIRECT_STATE_KEY = 'silentsuite-signup-redirect-state'

function persistedRedirectSignup(overrides: Record<string, unknown> = {}) {
  return anonymousRecoverySignup({
    serverUrl: 'https://server.silentsuite.io',
    wantsProductUpdates: true,
    rememberDevice: true,
    ...overrides,
  })
}

function persistRedirectState(pendingSignup = persistedRedirectSignup(), selectedInterval: 'monthly' | 'annual' = 'annual') {
  sessionStorage.setItem(REDIRECT_STATE_KEY, JSON.stringify({ pendingSignup, selectedInterval, savedAt: Date.now() }))
}

function configureFullNavigationStore() {
  authState.pendingSignup = null
  authState.clearPendingSignupPaymentRecovery.mockImplementation(() => {})
  authState.saveSignupStateForRedirect.mockImplementation(() => {})
  authState.restoreSignupStateFromRedirect.mockImplementation(() => {
    const raw = sessionStorage.getItem(REDIRECT_STATE_KEY)
    if (!raw) return null
    sessionStorage.removeItem(REDIRECT_STATE_KEY)
    const restored = JSON.parse(raw) as { pendingSignup: typeof authState.pendingSignup; selectedInterval: 'monthly' | 'annual'; savedAt: number }
    authState.pendingSignup = restored.pendingSignup
    return restored
  })
}

describe('PendingPaymentPage anonymous payment-session recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    configureFullNavigationStore()
    authState.pendingSignup = anonymousRecoverySignup()
    vi.stubGlobal('location', { href: 'https://app.silentsuite.io/signup/pending-payment' })
  })

  it('Stripe recovery must not claim Bitcoin settlement', async () => {
    authState.pendingSignup = anonymousRecoverySignup({ paymentMethod: 'stripe' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ contractVersion: 2, state: 'confirmed', flow: { provider: 'stripe', status: 'provider_confirmed' } }))))
    render(<PendingPaymentPage />)
    await screen.findByTestId('step-create-paid-account')
    expect(screen.queryByText('Bitcoin payment settled')).not.toBeInTheDocument()
  })
  it('stale local invoice must not establish available invoice', async () => {
    sessionStorage.setItem('silentsuite-pending-crypto-invoice', 'stale-unbound-invoice')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ contractVersion: 2, state: 'open', flow: { provider: 'btcpay', status: 'provider_pending' } }))))
    render(<PendingPaymentPage />)
    await screen.findByRole('button', { name: /check payment status again/i })
    expect(screen.queryByText(/Your invoice is available/)).not.toBeInTheDocument()
  })
  it.each([null, 'provider_pending', 'unrecognized'])('never claims settlement without invoice evidence (%s)', async (status) => {
    if (!status) authState.pendingSignup = null
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ contractVersion: 2, state: 'open', flow: { provider: 'btcpay', status } }))))
    render(<PendingPaymentPage />)
    await waitFor(() => expect(screen.queryByText('Checking current payment...')).not.toBeInTheDocument())
    expect(screen.queryByText(/Waiting for BTCPay settlement|webhook activates|check your email to continue/i)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /reload this payment recovery/i })).toBeVisible()
    expect(screen.queryByRole('button', { name: /start a new invoice|cancel and start/i })).not.toBeInTheDocument()
  })

  it('uses only the anonymous current then reconcile recovery siblings with capability-only credentials', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 2, state: 'open', flow: { provider: 'btcpay', status: 'provider_pending' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 2, state: 'open', flow: { provider: 'btcpay', status: 'provider_pending' } }), { status: 200 })))

    render(<PendingPaymentPage />)

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(fetch).toHaveBeenNthCalledWith(1, 'https://billing.test/auth/signup/payment-session/v2/current', expect.objectContaining({ method: 'POST', credentials: 'omit', body: JSON.stringify(recoveryBody) }))
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://billing.test/auth/signup/payment-session/v2/reconcile', expect.objectContaining({ method: 'POST', credentials: 'omit', body: JSON.stringify(recoveryBody) }))
    expect(String((fetch as ReturnType<typeof vi.fn>).mock.calls[0][0])).not.toContain('/subscription/')
    expect(screen.queryByRole('button', { name: /cancel and start another invoice/i })).not.toBeInTheDocument()
  })

  it('fails closed for 404 and 401 recovery responses without releasing local recovery or calling authenticated subscription endpoints', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'not found', type: 'not-found' }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'unauthorized', type: 'authentication-failed' }), { status: 401 })))

    render(<PendingPaymentPage />)
    fireEvent.click(await screen.findByRole('button', { name: /retry payment status/i }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(authState.clearPendingSignupPaymentRecovery).not.toHaveBeenCalled()
    for (const [url] of (fetch as ReturnType<typeof vi.fn>).mock.calls) expect(String(url)).not.toContain('/subscription/')
  })

  it('retains exact recovery after generic closed, which is not a release receipt', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ contractVersion: 2, state: 'closed', flow: null }))))
    render(<PendingPaymentPage />)
    expect(await screen.findByRole('heading', { name: /payment release not confirmed/i })).toBeVisible()
    expect(authState.clearPendingSignupPaymentRecovery).not.toHaveBeenCalled()
    expect(authState.pendingSignup.paymentSessionToken).toBe(paymentSessionToken)
    expect(screen.queryByRole('button', { name: /new invoice/i })).not.toBeInTheDocument()
  })


  it('routes an authoritative confirmed recovery into the account continuation without polling invoice or authenticated endpoints', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ contractVersion: 2, state: 'confirmed', flow: { provider: 'btcpay', status: 'provider_confirmed' } }), { status: 200 })))

    render(<PendingPaymentPage />)

    expect(await screen.findByTestId('step-create-paid-account')).toBeInTheDocument()
    expect(authState.clearPendingSignupPaymentRecovery).not.toHaveBeenCalled()
    for (const [url] of (fetch as ReturnType<typeof vi.fn>).mock.calls) {
      expect(String(url)).not.toContain('/subscription/')
      expect(String(url)).not.toContain('/crypto/invoice/')
    }
  })

  it('does not offer unsafe live Bitcoin cancellation or issue a cancel request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ contractVersion: 2, state: 'open', flow: { provider: 'btcpay', status: 'provider_pending' } }))))
    render(<PendingPaymentPage />)
    await screen.findByRole('button', { name: /check payment status again/i })
    expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument()
    expect(screen.getByText(/Cancellation and switching payment methods are not available here/)).toBeVisible()
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/cancel'))).toBe(false)
  })


  it('does not contact any recovery or authenticated endpoint when the local capability is absent', async () => {
    authState.pendingSignup = { email: 'customer@example.test', billingContractVersion: 2 }
    vi.stubGlobal('fetch', vi.fn())

    render(<PendingPaymentPage />)

    expect(await screen.findByRole('link', { name: /reload this payment recovery/i })).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('restores the complete persisted v2 authority before confirmed recovery and finalizes with its original token', async () => {
    configureFullNavigationStore()
    persistRedirectState()
    let finalizedPending: Record<string, unknown> | null = null
    authState.finalizePaidSignup.mockImplementation(async () => {
      finalizedPending = { ...authState.pendingSignup }
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ contractVersion: 2, state: 'confirmed', flow: { provider: 'btcpay', status: 'provider_confirmed' } }), { status: 200 })))

    render(<PendingPaymentPage />)

    expect(await screen.findByTestId('step-create-paid-account')).toBeInTheDocument()
    expect(authState.restoreSignupStateFromRedirect).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem(REDIRECT_STATE_KEY)).toBeNull()
    expect(fetch).toHaveBeenCalledWith(
      'https://billing.test/auth/signup/payment-session/v2/current',
      expect.objectContaining({ body: JSON.stringify(recoveryBody) }),
    )
    fireEvent.click(screen.getByRole('button', { name: /complete restored account/i }))
    await waitFor(() => expect(authState.finalizePaidSignup).toHaveBeenCalledTimes(1))
    expect(authState.createEtebaseAccount).toHaveBeenCalledWith('customer@example.test', 'RestoredPassword1')
    expect(finalizedPending).toMatchObject({
      paymentSessionToken,
      paymentSessionRequestKey,
      billingContractVersion: 2,
      paymentMethod: 'btcpay',
      wantsProductUpdates: true,
      rememberDevice: true,
    })
  })

  it('retains restored v2 authority and invoice on closed or unknown recovery', async () => {
    configureFullNavigationStore()
    persistRedirectState()
    sessionStorage.setItem('silentsuite-pending-crypto-invoice', 'retained-invoice')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ contractVersion: 2, state: 'closed', flow: null }))))
    render(<PendingPaymentPage />)
    await screen.findByRole('heading', { name: /payment release not confirmed/i })
    expect(authState.clearPendingSignupPaymentRecovery).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('silentsuite-pending-crypto-invoice')).toBe('retained-invoice')
    expect(authState.pendingSignup.paymentSessionToken).toBe(paymentSessionToken)
    expect(authState.prepareSignupDraft).not.toHaveBeenCalled()
  })


  it('keeps restored v2 authority intact while anonymous recovery remains open', async () => {
    configureFullNavigationStore()
    persistRedirectState()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 2, state: 'open', flow: { provider: 'btcpay', status: 'provider_pending' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 2, state: 'open', flow: { provider: 'btcpay', status: 'provider_pending' } }), { status: 200 })))

    render(<PendingPaymentPage />)

    expect(await screen.findByRole('button', { name: /check payment status again/i })).toBeInTheDocument()
    expect(authState.pendingSignup).toMatchObject({
      paymentSessionToken,
      paymentSessionRequestKey,
      billingContractVersion: 2,
      paymentMethod: 'btcpay',
    })
    expect(authState.clearPendingSignupPaymentRecovery).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(REDIRECT_STATE_KEY)).toBeNull()
  })

  it('continues an exact historical v1 redirect without translating it into anonymous v2 recovery', async () => {
    configureFullNavigationStore()
    const historicalToken = 'B'.repeat(43)
    persistRedirectState(persistedRedirectSignup({
      paymentSessionToken: historicalToken,
      paymentSessionRequestKey: undefined,
      paymentMethod: undefined,
      billingContractVersion: 1,
      wantsProductUpdates: false,
      rememberDevice: false,
    }), 'monthly')
    let finalizedPending: Record<string, unknown> | null = null
    authState.finalizePaidSignup.mockImplementation(async () => {
      finalizedPending = { ...authState.pendingSignup }
    })
    vi.stubGlobal('fetch', vi.fn())

    render(<PendingPaymentPage />)

    expect(await screen.findByTestId('step-create-paid-account')).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /complete restored account/i }))
    await waitFor(() => expect(authState.finalizePaidSignup).toHaveBeenCalledTimes(1))
    expect(finalizedPending).toMatchObject({
      paymentSessionToken: historicalToken,
      billingContractVersion: 1,
      wantsProductUpdates: false,
      rememberDevice: false,
    })
  })
})

describe('PendingPaymentPage legacy restart links fail closed', () => {
  it.each(['link-token', 'malformed'])('does not consume %s or replace an uncertain payment via an email link', async (token) => {
    vi.clearAllMocks()
    sessionStorage.clear()
    configureFullNavigationStore()
    authState.pendingSignup = null
    vi.stubGlobal('location', { href: 'https://app.silentsuite.io/signup/pending-payment', search: `?email_verification_token=${token}` })
    vi.stubGlobal('fetch', vi.fn())
    render(<PendingPaymentPage />)
    expect(await screen.findByText(/verification link could not be matched/i)).toBeVisible()
    expect(screen.getByRole('link', { name: /reload this payment recovery/i })).toBeVisible()
    expect(fetch).not.toHaveBeenCalled()
    expect(authState.prepareSignupDraft).not.toHaveBeenCalled()
    expect(authState.startAnnualSignupPayment).not.toHaveBeenCalled()
  })
})

describe('PendingPaymentPage BTCPay settlement polling', () => {
  const openRecovery = () => new Response(JSON.stringify({ contractVersion: 2, state: 'open', flow: { provider: 'btcpay', status: 'provider_pending' } }), { status: 200 })
  const confirmedRecovery = () => new Response(JSON.stringify({ contractVersion: 2, state: 'confirmed', flow: { provider: 'btcpay', status: 'provider_confirmed' } }), { status: 200 })
  // Each poll issues the `current` sibling and, while open, its `reconcile` sibling.
  const REQUESTS_PER_OPEN_POLL = 2

  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    configureFullNavigationStore()
    authState.pendingSignup = anonymousRecoverySignup()
    vi.stubGlobal('location', { href: 'https://app.silentsuite.io/signup/pending-payment' })
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function settle() {
    await act(async () => {})
  }

  async function advance(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
  }

  it('re-polls the anonymous recovery sibling while the invoice stays open', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => openRecovery()))
    render(<PendingPaymentPage />)
    await settle()

    expect(fetch).toHaveBeenCalledTimes(REQUESTS_PER_OPEN_POLL)
    expect(screen.getByRole('button', { name: /check payment status again/i })).toBeInTheDocument()

    await advance(10_000)
    expect(fetch).toHaveBeenCalledTimes(REQUESTS_PER_OPEN_POLL * 2)

    await advance(10_000)
    expect(fetch).toHaveBeenCalledTimes(REQUESTS_PER_OPEN_POLL * 3)
  })

  it('stops polling as soon as settlement confirms and routes into the account step', async () => {
    const fetchMock = vi.fn(async () => openRecovery())
    vi.stubGlobal('fetch', fetchMock)
    render(<PendingPaymentPage />)
    await settle()
    await advance(10_000)

    fetchMock.mockImplementation(async () => confirmedRecovery())
    await advance(10_000)
    expect(screen.getByTestId('step-create-paid-account')).toBeInTheDocument()

    const callsAtSettlement = fetchMock.mock.calls.length
    await advance(120_000)
    expect(fetchMock).toHaveBeenCalledTimes(callsAtSettlement)
  })

  it('gives up after the bounded schedule and offers a manual re-check', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => openRecovery()))
    render(<PendingPaymentPage />)
    await settle()

    // 180 attempts: 10s apart for the first 30, then 30s apart.
    await advance(30 * 10_000 + 150 * 30_000)

    expect(screen.getByRole('heading', { name: /payment status is still unconfirmed/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /check again/i })).toBeInTheDocument()
    expect(sessionStorage.getItem('silentsuite-signup-in-progress')).toBeNull()

    const callsAtTimeout = vi.mocked(fetch).mock.calls.length
    await advance(300_000)
    expect(fetch).toHaveBeenCalledTimes(callsAtTimeout)
  })

  it('cancels the scheduled poll when the page unmounts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => openRecovery()))
    const { unmount } = render(<PendingPaymentPage />)
    await settle()
    const callsBeforeUnmount = vi.mocked(fetch).mock.calls.length

    unmount()
    await advance(300_000)

    expect(fetch).toHaveBeenCalledTimes(callsBeforeUnmount)
  })

  it('does not schedule a settlement poll when no recovery capability exists', async () => {
    authState.pendingSignup = { email: 'customer@example.test', billingContractVersion: 2 }
    vi.stubGlobal('fetch', vi.fn())
    render(<PendingPaymentPage />)
    await settle()
    await advance(300_000)

    expect(fetch).not.toHaveBeenCalled()
  })
})
