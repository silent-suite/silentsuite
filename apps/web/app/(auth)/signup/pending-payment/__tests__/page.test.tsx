import { useEffect, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import PendingPaymentPage from '../page'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_BTCPAY_CHECKOUT_ENABLED = 'true'
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_recovery'
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
// Render the real StripePaymentForm; replace only the external Stripe SDK.
vi.mock('@stripe/stripe-js/pure', () => {
  const loadStripe = Object.assign(vi.fn(async () => ({})), { setLoadParameters: vi.fn() })
  return { loadStripe }
})
vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: { children: ReactNode }) => <div data-testid="stripe-elements">{children}</div>,
  PaymentElement: ({ onReady }: { onReady: () => void }) => {
    useEffect(() => { onReady() }, [])
    return <input aria-label="Card details" defaultValue="" />
  },
  useStripe: () => ({}), useElements: () => ({}),
}))
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }))
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

const recoveryBody = { contractVersion: 2, email: 'customer@example.test', requestKey: paymentSessionRequestKey, recoverySecret: paymentSessionToken, switchingProfile: 'v1' }
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
    await screen.findByRole('button', { name: 'Back' })
    expect(screen.queryByText(/Your invoice is available/)).not.toBeInTheDocument()
  })
  it.each([null, 'provider_pending', 'unrecognized'])('never claims settlement without invoice evidence (%s)', async (status) => {
    if (!status) authState.pendingSignup = null
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ contractVersion: 2, state: 'open', flow: { provider: 'btcpay', status } }))))
    render(<PendingPaymentPage />)
    await waitFor(() => expect(screen.queryByText('Checking current payment...')).not.toBeInTheDocument())
    expect(screen.queryByText(/Waiting for BTCPay settlement|webhook activates|check your email to continue/i)).not.toBeInTheDocument()
    // Without a capability Back is a plain link; with one it opens the cancellation decision.
    expect(screen.getByRole(status ? 'button' : 'link', { name: 'Back' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Problems with payment?' })).toHaveAttribute('href', 'mailto:support@silentsuite.io')
    expect(screen.queryByText(/Recover pending payment|Reload this payment recovery|Check payment status|Keep this payment/i)).not.toBeInTheDocument()
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
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
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

  it('Back opens the Bitcoin cancellation decision without issuing a cancel request, and Stay resumes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ contractVersion: 2, state: 'open', flow: { provider: 'btcpay', status: 'provider_pending' } }))))
    render(<PendingPaymentPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }))
    const dialog = screen.getByRole('dialog', { name: 'Cancel this Bitcoin payment?' })
    expect(dialog).toHaveTextContent('Only continue if you haven’t sent payment. This checkout will be cancelled. Do not send Bitcoin or Lightning to its old payment details.')
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel and go back' })).toBeEnabled()
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/cancel'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back' })).toBeVisible()
  })

  it('the Back dialog takes focus, hides the page behind it, and Escape dismisses it without a cancel request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ contractVersion: 2, state: 'open', flow: { provider: 'btcpay', status: 'provider_pending' } }))))
    render(<PendingPaymentPage />)
    const back = await screen.findByRole('button', { name: 'Back' })
    fireEvent.click(back)
    const dialog = screen.getByRole('dialog', { name: 'Cancel this Bitcoin payment?' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stay' })).toHaveFocus())
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    // The page behind the dialog is inert: its Back control is no longer accessible.
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Problems with payment?' })).not.toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back' })).toBeVisible()
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/cancel'))).toBe(false)
  })

  it('confirming Back sends the affirmative no-funds acknowledgement and shows cancelled only on an exact release', async () => {
    const pending = anonymousRecoverySignup()
    authState.pendingSignup = pending
    authState.clearPendingSignupPaymentRecovery.mockImplementation(() => { authState.pendingSignup = { ...pending, paymentSessionToken: undefined, paymentSessionRequestKey: undefined } })
    const bodies: Record<string, unknown>[] = []
    let releaseResponse: () => Response = () => new Response(JSON.stringify({ contractVersion: 2, state: 'open', flow: { provider: 'btcpay', status: 'provider_pending' } }))
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/cancel')) { bodies.push(JSON.parse(String(init?.body))); return releaseResponse() }
      return new Response(JSON.stringify({ contractVersion: 2, state: 'open', flow: { provider: 'btcpay', status: 'provider_pending' } }))
    }))
    render(<PendingPaymentPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel and go back' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Cancellation is not confirmed yet')
    expect(bodies).toEqual([{ contractVersion: 2, email: pending.email, requestKey: paymentSessionRequestKey, recoverySecret: paymentSessionToken, switchingProfile: 'v1', confirmNoBitcoinSent: true }])
    expect(authState.clearPendingSignupPaymentRecovery).not.toHaveBeenCalled()
    expect(screen.queryByText('Payment cancelled')).not.toBeInTheDocument()
    releaseResponse = () => new Response(JSON.stringify({ contractVersion: 2, state: 'released', flow: { provider: 'btcpay', status: 'reconciliation_required' }, release: { requestKey: paymentSessionRequestKey, provider: 'btcpay', providerObjectId: 'invoice_exact' } }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry cancellation' }))
    expect(await screen.findByRole('heading', { name: 'Verify email to choose a payment method' })).toBeVisible()
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toEqual(bodies[0])
    expect(authState.clearPendingSignupPaymentRecovery).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('link', { name: 'Verify email again' })).toHaveAttribute('href', '/signup')
  })


  it('restores the exact payable Bitcoin continuation without creating or reconciling another invoice', async () => {
    const pending = anonymousRecoverySignup()
    authState.pendingSignup = pending
    const disclosure = { kind: 'prepaid', annualAmountMinor: 3600, firstChargeAmountMinor: 3600, renewalAmountMinor: null, monthlyEquivalentMinor: 300, currency: 'EUR', trialEndsAt: null, firstChargeAt: null, cancelBy: null, cancelByInclusive: false, autoRenew: false, prepaid: true, refundWindowDays: 30, bonusDays: 0, periodEndRule: 'confirmation_plus_1_utc_calendar_year', renewalAt: null, entitlementEndsAt: null }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ contractVersion: 2, state: 'open', flow: { provider: 'btcpay', status: 'provider_pending' }, continuation: { requestKey: pending.paymentSessionRequestKey, provider: 'btcpay', providerObjectId: 'invoice_exact', checkoutUrl: 'https://btcpay.silentsuite.io/i/exact', disclosure } }))))
    render(<PendingPaymentPage />)
    expect(await screen.findByRole('link', { name: 'Continue this Bitcoin payment' })).toHaveAttribute('href', 'https://btcpay.silentsuite.io/i/exact')
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual(['https://billing.test/auth/signup/payment-session/v2/current'])
  })

  it('does not contact any recovery or authenticated endpoint when the local capability is absent', async () => {
    authState.pendingSignup = { email: 'customer@example.test', billingContractVersion: 2 }
    vi.stubGlobal('fetch', vi.fn())

    render(<PendingPaymentPage />)

    expect(await screen.findByRole('link', { name: 'Back' })).toHaveAttribute('href', '/signup')
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

    expect(await screen.findByRole('button', { name: 'Back' })).toBeInTheDocument()
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
    expect(screen.getByRole('link', { name: 'Back' })).toBeVisible()
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

  it.each(['timeout', 'expired', 'invalid'] as const)('recovers the same authority after %s without restarting or over-polling', async reason => {
    const fetcher = vi.fn(async () => reason === 'timeout' ? openRecovery() : new Response(JSON.stringify({ contractVersion: 2, state: 'closed', flow: { provider: 'btcpay', status: reason } })))
    vi.stubGlobal('fetch', fetcher)
    render(<PendingPaymentPage />)
    await settle()
    if (reason === 'timeout') await advance(4 * 60_000 * 20)
    const stopped = fetcher.mock.calls.length
    await advance(16 * 60_000)
    expect(fetcher).toHaveBeenCalledTimes(stopped)
    expect(stopped).toBe(reason === 'timeout' ? 40 : 1)
    fetcher.mockImplementation(async () => confirmedRecovery())
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await settle()
    expect(screen.getByTestId('step-create-paid-account')).toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledTimes(stopped + 1)
    for (const [url, init] of vi.mocked(fetch).mock.calls) {
      expect(String(url)).toMatch(/payment-session\/v2\/(current|reconcile)$/)
      expect(JSON.parse(String(init?.body))).toEqual(recoveryBody)
    }
    expect(authState.startAnnualSignupPayment).not.toHaveBeenCalled()
  })

  it('re-polls the anonymous recovery sibling while the invoice stays open', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => openRecovery()))
    render(<PendingPaymentPage />)
    await settle()

    expect(fetch).toHaveBeenCalledTimes(REQUESTS_PER_OPEN_POLL)
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /check|retry/i })).not.toBeInTheDocument()

    await advance(4 * 60_000)
    expect(fetch).toHaveBeenCalledTimes(REQUESTS_PER_OPEN_POLL * 2)

    await advance(4 * 60_000)
    expect(fetch).toHaveBeenCalledTimes(REQUESTS_PER_OPEN_POLL * 3)
  })

  it('stops polling as soon as settlement confirms and routes into the account step', async () => {
    const fetchMock = vi.fn(async () => openRecovery())
    vi.stubGlobal('fetch', fetchMock)
    render(<PendingPaymentPage />)
    await settle()
    await advance(4 * 60_000)

    fetchMock.mockImplementation(async () => confirmedRecovery())
    await advance(4 * 60_000)
    expect(screen.getByTestId('step-create-paid-account')).toBeInTheDocument()

    const callsAtSettlement = fetchMock.mock.calls.length
    await advance(120_000)
    expect(fetchMock).toHaveBeenCalledTimes(callsAtSettlement)
  })

  const disclosure = { kind: 'prepaid', annualAmountMinor: 3600, firstChargeAmountMinor: 3600, renewalAmountMinor: null, monthlyEquivalentMinor: 300, currency: 'EUR', trialEndsAt: null, firstChargeAt: null, cancelBy: null, cancelByInclusive: false, autoRenew: false, prepaid: true, refundWindowDays: 30, bonusDays: 0, periodEndRule: 'confirmation_plus_1_utc_calendar_year', renewalAt: null, entitlementEndsAt: null }
  const payableRecovery = (provider: 'stripe' | 'btcpay') => new Response(JSON.stringify({ contractVersion: 2, state: 'open', flow: { provider, status: 'provider_pending' }, continuation: {
    requestKey: paymentSessionRequestKey, provider, providerObjectId: 'exact_payment',
    ...(provider === 'stripe' ? { clientSecret: 'pi_exact_secret_test', disclosure: { ...disclosure, kind: 'charge_now', autoRenew: true, prepaid: false, renewalAmountMinor: 3600 } }
      : { checkoutUrl: 'https://btcpay.silentsuite.io/i/exact', disclosure }),
  } }))

  it.each(['stripe', 'btcpay'] as const)('keeps the same mounted %s controls through transient reads and honors retry timing', async provider => {
    authState.pendingSignup = anonymousRecoverySignup({ paymentMethod: provider })
    const fetchMock = vi.fn(async () => payableRecovery(provider))
    vi.stubGlobal('fetch', fetchMock)
    render(<PendingPaymentPage />)
    await settle()
    const control = provider === 'stripe' ? screen.getByLabelText('Card details') : screen.getByRole('link', { name: 'Continue this Bitcoin payment' })
    if (provider === 'stripe') fireEvent.change(control, { target: { value: 'entered card data' } })
    fetchMock.mockImplementation(async () => new Response('{}', { status: 429, headers: { 'Retry-After': '600' } }))
    await advance(4 * 60_000)
    expect(control).toBeInTheDocument()
    if (provider === 'stripe') expect(control).toHaveValue('entered card data')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled()
    await advance(599_999)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    fetchMock.mockImplementation(async () => { throw new TypeError('Network unavailable') })
    await advance(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(control).toBeInTheDocument()
    fetchMock.mockImplementation(async () => new Response('{}', { status: 503 }))
    await advance(4 * 60_000)
    expect(control).toBeInTheDocument()
    fetchMock.mockImplementation(async () => payableRecovery(provider))
    await advance(4 * 60_000)
    expect(control).toBeInTheDocument()
    if (provider === 'stripe') expect(control).toHaveValue('entered card data')
    fetchMock.mockImplementation(async () => confirmedRecovery())
    if (provider === 'stripe') fetchMock.mockImplementation(async () => new Response(JSON.stringify({ contractVersion: 2, state: 'confirmed', flow: { provider, status: 'provider_confirmed' } })))
    await advance(4 * 60_000)
    expect(control).not.toBeInTheDocument()
  })

  it('stays inside both real route budgets for fifteen minutes, including explicit retries', async () => {
    const calls: { route: string; at: number }[] = []
    // Transient failures expose the inline retry; a healthy read has no manual check.
    vi.stubGlobal('fetch', vi.fn(async url => { calls.push({ route: String(url).split('/').at(-1)!, at: Date.now() }); return new Response('{}', { status: 503 }) }))
    render(<PendingPaymentPage />)
    await settle()
    for (let tick = 0; tick < 15; tick++) {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      await advance(60_000)
    }
    for (const call of calls) {
      const inWindow = calls.filter(other => other.at > call.at - 15 * 60_000 && other.at <= call.at && other.route === call.route)
      expect(inWindow.length).toBeLessThanOrEqual(call.route === 'current' ? 10 : 5)
    }
  })

  it.each(['closed', 'proof-expired', 'identity', 'logout'] as const)('clears payable controls after %s', async outcome => {
    vi.stubGlobal('fetch', vi.fn(async () => payableRecovery('btcpay')))
    const view = render(<PendingPaymentPage />)
    await settle()
    const control = screen.getByRole('link', { name: 'Continue this Bitcoin payment' })
    if (outcome === 'identity' || outcome === 'logout') {
      authState.pendingSignup = outcome === 'logout' ? null : anonymousRecoverySignup({ paymentSessionRequestKey: '6fd4d86d-34de-4b82-9a66-9598ddf6e02f' })
      vi.mocked(fetch).mockImplementation(async () => new Response('{}', { status: 503 }))
      view.rerender(<PendingPaymentPage />)
      await settle()
    } else {
      vi.mocked(fetch).mockImplementation(async () => outcome === 'proof-expired' ? new Response('{}', { status: 401 }) : new Response(JSON.stringify({ contractVersion: 2, state: 'closed', flow: null })))
      await advance(4 * 60_000)
    }
    expect(control).not.toBeInTheDocument()
  })

  it('gives up after the bounded schedule and offers a manual re-check', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => openRecovery()))
    render(<PendingPaymentPage />)
    await settle()

    // 20 bounded attempts, four minutes apart.
    await advance(20 * 4 * 60_000)

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
