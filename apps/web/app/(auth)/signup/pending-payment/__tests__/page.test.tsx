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

  it('uses only the anonymous current then reconcile recovery siblings with capability-only credentials', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 2, state: 'open', flow: { provider: 'btcpay', status: 'provider_pending' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 2, state: 'open', flow: { provider: 'btcpay', status: 'provider_pending' } }), { status: 200 })))

    render(<PendingPaymentPage />)

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(fetch).toHaveBeenNthCalledWith(1, 'https://billing.test/auth/signup/payment-session/v2/current', expect.objectContaining({ method: 'POST', credentials: 'omit', body: JSON.stringify(recoveryBody) }))
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://billing.test/auth/signup/payment-session/v2/reconcile', expect.objectContaining({ method: 'POST', credentials: 'omit', body: JSON.stringify(recoveryBody) }))
    expect(String((fetch as ReturnType<typeof vi.fn>).mock.calls[0][0])).not.toContain('/subscription/')
    expect(screen.getByRole('button', { name: /cancel and start another invoice/i })).toBeInTheDocument()
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

  it('accepts a generic closed response for an unknown or terminal capability and clears it only after that authoritative response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ contractVersion: 2, state: 'closed', flow: null }), { status: 200 })))

    render(<PendingPaymentPage />)

    expect(await screen.findByRole('heading', { name: /invoice not completed/i })).toBeInTheDocument()
    expect(authState.clearPendingSignupPaymentRecovery).toHaveBeenCalledTimes(1)
    expect(authState.clearPendingSignupPaymentRecovery.mock.calls[0]?.[0]).toMatchObject({
      email: 'customer@example.test',
      requestKey: paymentSessionRequestKey,
      recoverySecret: paymentSessionToken,
    })
    expect(fetch).toHaveBeenCalledWith('https://billing.test/auth/signup/payment-session/v2/current', expect.objectContaining({ credentials: 'omit', body: JSON.stringify(recoveryBody) }))
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

  it('uses the exact anonymous cancel route and only releases after its generic closed response', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 2, state: 'open', flow: { provider: 'btcpay', status: 'provider_pending' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 2, state: 'open', flow: { provider: 'btcpay', status: 'provider_pending' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 2, state: 'closed', flow: null }), { status: 200 })))

    render(<PendingPaymentPage />)
    fireEvent.click(await screen.findByRole('button', { name: /cancel and start another invoice/i }))

    await waitFor(() => expect(authState.clearPendingSignupPaymentRecovery).toHaveBeenCalledTimes(1))
    expect(fetch).toHaveBeenLastCalledWith('https://billing.test/auth/signup/payment-session/v2/cancel', expect.objectContaining({ method: 'POST', credentials: 'omit', body: JSON.stringify(recoveryBody) }))
  })

  it('does not contact any recovery or authenticated endpoint when the local capability is absent', async () => {
    authState.pendingSignup = { email: 'customer@example.test', billingContractVersion: 2 }
    vi.stubGlobal('fetch', vi.fn())

    render(<PendingPaymentPage />)

    expect(await screen.findByRole('button', { name: /verify email to start a new invoice/i })).toBeInTheDocument()
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

  it('captures the verified v2 restart context before a closed or unknown recovery clears stale authority', async () => {
    configureFullNavigationStore()
    persistRedirectState()
    sessionStorage.setItem('silentsuite-pending-crypto-invoice', 'stale-invoice')
    sessionStorage.setItem('silentsuite-pending-crypto-token', 'stale-provider-token')
    sessionStorage.setItem('silentsuite-pending-crypto-recovery-context', JSON.stringify({ email: 'customer@example.test', requestKey: paymentSessionRequestKey }))
    sessionStorage.setItem('silentsuite-signup-in-progress', 'true')
    authState.clearPendingSignupPaymentRecovery.mockImplementation(() => { authState.pendingSignup = null })
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 2, state: 'closed', flow: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ requestId: 'request-1' }), { status: 200 })))

    render(<PendingPaymentPage />)

    expect(await screen.findByRole('heading', { name: /invoice not completed/i })).toBeInTheDocument()
    expect(authState.clearPendingSignupPaymentRecovery).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem('silentsuite-pending-crypto-invoice')).toBeNull()
    expect(sessionStorage.getItem('silentsuite-pending-crypto-token')).toBeNull()
    expect(sessionStorage.getItem('silentsuite-pending-crypto-recovery-context')).toBeNull()
    expect(sessionStorage.getItem('silentsuite-signup-in-progress')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /verify email to start a new invoice/i }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(String((fetch as ReturnType<typeof vi.fn>).mock.calls[1][0])).toContain('/auth/signup-email-verifications/v2')
    expect(screen.queryByText(/return to signup to verify your email/i)).not.toBeInTheDocument()
  })

  it('keeps restored v2 authority intact while anonymous recovery remains open', async () => {
    configureFullNavigationStore()
    persistRedirectState()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 2, state: 'open', flow: { provider: 'btcpay', status: 'provider_pending' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 2, state: 'open', flow: { provider: 'btcpay', status: 'provider_pending' } }), { status: 200 })))

    render(<PendingPaymentPage />)

    expect(await screen.findByText(/payment already in progress/i)).toBeInTheDocument()
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

describe('PendingPaymentPage Bitcoin restart across the email navigation', () => {
  const emailOwnershipToken = 'C'.repeat(43)
  const rotatedRequestKey = '7c3f1a52-9a1e-4a1e-8b7c-2f4d6e8a0b12'
  const checkoutUrl = 'https://btcpay.silentsuite.io/i/restarted-invoice'
  const prepaidDisclosure = {
    kind: 'prepaid', annualAmountMinor: 3600, firstChargeAmountMinor: 3600, renewalAmountMinor: null,
    monthlyEquivalentMinor: 300, currency: 'EUR', trialEndsAt: null, firstChargeAt: null,
    cancelBy: null, cancelByInclusive: false, autoRenew: false, prepaid: true, refundWindowDays: 30,
    bonusDays: 14, periodEndRule: 'confirmation_bonus_then_1_utc_calendar_year', renewalAt: null, entitlementEndsAt: null,
  }
  const restartOffer = {
    contractVersion: 2,
    requestId: 'e91a6d70-0d4e-4352-9bdc-426d1f76d771',
    offer: {
      planId: 'early_annual', customerClass: 'early', billingInterval: 'annual', annualAmountMinor: 3600,
      monthlyEquivalentMinor: 300, currency: 'EUR', providers: ['stripe', 'btcpay'], offerRevision: 1,
      offerToken: 'signed-offer', expiresAt: '2026-08-11T12:10:00Z',
    },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    localStorage.clear()
    configureFullNavigationStore()
    authState.prepareSignupDraft.mockImplementation((email: string, wantsProductUpdates?: boolean, rememberDevice?: boolean) => {
      authState.pendingSignup = { email, wantsProductUpdates, rememberDevice: rememberDevice === true }
    })
    // Mirrors the store: a fresh recovery identity is minted for the new invoice.
    authState.startAnnualSignupPayment.mockImplementation(async () => {
      authState.pendingSignup = {
        ...authState.pendingSignup,
        billingContractVersion: 2,
        paymentMethod: 'btcpay',
        paymentSessionToken: 'D'.repeat(43),
        paymentSessionRequestKey: rotatedRequestKey,
      }
      return {
        clientSecret: null,
        cryptoCheckoutUrl: checkoutUrl,
        cryptoInvoiceId: 'invoice-restarted',
        cryptoInvoiceLookupToken: 'E'.repeat(43),
        paymentSessionToken: 'D'.repeat(43),
      }
    })
  })

  it('completes a restart whose email link lands in a new page load with no redirect snapshot', async () => {
    // --- First page load: the invoice is terminal and the user asks for a link.
    authState.pendingSignup = anonymousRecoverySignup({ wantsProductUpdates: true, rememberDevice: true })
    vi.stubGlobal('location', { href: 'https://app.silentsuite.io/signup/pending-payment?return_to=silentsuite%3A%2F%2Fsignup-complete', search: '?return_to=silentsuite%3A%2F%2Fsignup-complete' })
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ contractVersion: 2, state: 'closed', flow: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 })))

    const firstLoad = render(<PendingPaymentPage />)
    expect(await screen.findByRole('heading', { name: /invoice not completed/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /verify email to start a new invoice/i }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(String(vi.mocked(fetch).mock.calls[1]![0])).toContain('/auth/signup-email-verifications/v2')

    // The continuation has to outlive the tab, not just the page.
    const persistedByRequest = JSON.parse(localStorage.getItem('silentsuite-signup-email-proof') ?? 'null')
    const persisted = persistedByRequest[Object.keys(persistedByRequest)[0]!]
    expect(persisted).toMatchObject({ email: 'customer@example.test', wantsProductUpdates: true, rememberDevice: true })
    firstLoad.unmount()

    // --- Second page load: a fresh browsing context opened from the mail app.
    // No sessionStorage, no pendingSignup, and the one-time redirect snapshot
    // was already consumed by the previous load.
    sessionStorage.clear()
    authState.pendingSignup = null
    vi.stubGlobal('location', { href: `https://app.silentsuite.io/signup/pending-payment?email_verification_token=link-token&request_id=${persisted.requestId}`, search: `?email_verification_token=link-token&request_id=${persisted.requestId}` })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/auth/signup-email-verifications/v2/consume')) {
        return new Response(JSON.stringify({ contractVersion: 2, emailOwnershipToken, expiresAt: '2026-08-11T12:05:00Z' }), { status: 200 })
      }
      if (url.endsWith('/auth/offers/v2')) return new Response(JSON.stringify({ ...restartOffer, requestId: persisted.requestId }), { status: 200 })
      if (url.endsWith('/auth/offers/v2/activate')) {
        return new Response(JSON.stringify({ contractVersion: 2, checkoutIntentToken: emailOwnershipToken, expiresAt: '2026-08-11T12:05:00Z', disclosure: prepaidDisclosure }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }))

    render(<PendingPaymentPage />)

    const restart = await screen.findByRole('button', { name: /start new cryptocurrency invoice/i })
    // The verified continuation was rebuilt from the persisted proof context.
    expect(authState.prepareSignupDraft).toHaveBeenCalledWith('customer@example.test', true, true)
    fireEvent.click(restart)

    expect(await screen.findByRole('heading', { name: /confirm prepaid annual terms/i })).toBeInTheDocument()
    expect(screen.getAllByText(/€36\.00/i)).not.toHaveLength(0)
    expect(screen.getByText(/€3\.00.*month/i)).toBeInTheDocument()
    expect(screen.getByText(/first charge amount.*€36\.00/i)).toBeInTheDocument()
    expect(screen.getByText(/first charge.*immediate/i)).toBeInTheDocument()
    expect(screen.getByText(/access through.*provider confirmation/i)).toBeInTheDocument()
    expect(screen.getByText(/period end rule.*confirmation bonus then 1 utc calendar year/i)).toBeInTheDocument()
    expect(screen.getByText(/does not renew automatically/i)).toBeInTheDocument()
    expect(authState.startAnnualSignupPayment).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /agree.*create cryptocurrency invoice/i }))
    await waitFor(() => expect(authState.startAnnualSignupPayment).toHaveBeenCalledWith(emailOwnershipToken, 'btcpay', 'https://app.silentsuite.io/signup/pending-payment'))
    expect(screen.queryByText(/return to signup to verify your email/i)).not.toBeInTheDocument()
    expect(window.location.href).toBe(checkoutUrl)
    expect(sessionStorage.getItem('silentsuite-pending-crypto-invoice')).toBe('invoice-restarted')
    expect(sessionStorage.getItem('silentsuite-pending-crypto-return-to')).toBe(persisted.returnTo)
    expect(authState.saveSignupStateForRedirect).toHaveBeenCalledWith('annual')
    // Rotated lineage: the replacement invoice never reuses the released key.
    expect(JSON.parse(sessionStorage.getItem('silentsuite-pending-crypto-recovery-context') ?? 'null')).toEqual({
      email: 'customer@example.test',
      requestKey: rotatedRequestKey,
    })
    expect(rotatedRequestKey).not.toBe(paymentSessionRequestKey)
    // Spent continuations must not linger in browser-profile storage.
    expect(localStorage.getItem('silentsuite-signup-email-proof')).toBeNull()
  })

  it('reports a recoverable error when the link opens without any persisted continuation', async () => {
    authState.pendingSignup = null
    localStorage.clear()
    vi.stubGlobal('location', { href: 'https://app.silentsuite.io/signup/pending-payment?email_verification_token=link-token', search: '?email_verification_token=link-token' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))

    render(<PendingPaymentPage />)

    expect(await screen.findByText(/verification link could not be matched/i)).toBeInTheDocument()
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('/consume'))).toBe(false)
  })

  it('removes a consumed flat legacy continuation', async () => {
    const requestId = '7823121e-8f4a-45ac-a217-82ba93209ca2'
    localStorage.setItem('silentsuite-signup-email-proof', JSON.stringify({
      email: 'legacy@example.test', requestId, wantsProductUpdates: false,
      rememberDevice: false, returnTo: null, expiresAt: Date.now() + 60_000,
    }))
    authState.pendingSignup = null
    vi.stubGlobal('location', { href: `https://app.silentsuite.io/signup/pending-payment?email_verification_token=link-token&request_id=${requestId}`, search: `?email_verification_token=link-token&request_id=${requestId}` })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/auth/signup-email-verifications/v2/consume')) return new Response(JSON.stringify({ contractVersion: 2, emailOwnershipToken, expiresAt: '2026-08-11T12:05:00Z' }))
      if (url.endsWith('/auth/offers/v2')) return new Response(JSON.stringify({ ...restartOffer, requestId }))
      if (url.endsWith('/auth/offers/v2/activate')) return new Response(JSON.stringify({ contractVersion: 2, checkoutIntentToken: emailOwnershipToken, expiresAt: '2026-08-11T12:05:00Z', disclosure: prepaidDisclosure }))
      return new Response('{}', { status: 404 })
    }))

    render(<PendingPaymentPage />)

    expect(await screen.findByRole('button', { name: /start new cryptocurrency invoice/i })).toBeInTheDocument()
    expect(localStorage.getItem('silentsuite-signup-email-proof')).toBeNull()
  })

  it('rejects a malformed request-id restart continuation before consuming its token', async () => {
    const malformedRequestId = 'not-a-uuid'
    localStorage.setItem('silentsuite-signup-email-proof', JSON.stringify({
      [malformedRequestId]: { email: 'customer@example.test', requestId: malformedRequestId, wantsProductUpdates: false, rememberDevice: false, returnTo: null, expiresAt: Date.now() + 60_000 },
    }))
    vi.stubGlobal('location', { href: `https://app.silentsuite.io/signup/pending-payment?email_verification_token=link-token&request_id=${malformedRequestId}`, search: `?email_verification_token=link-token&request_id=${malformedRequestId}` })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))

    render(<PendingPaymentPage />)

    expect(await screen.findByText(/verification link could not be matched/i)).toBeInTheDocument()
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('/consume'))).toBe(false)
  })

  it('rejects a non-expiring restart continuation without deleting another lineage', async () => {
    const requestId = restartOffer.requestId
    const otherRequestId = '7823121e-8f4a-45ac-a217-82ba93209ca2'
    localStorage.setItem('silentsuite-signup-email-proof', JSON.stringify({
      [requestId]: { email: 'customer@example.test', requestId, wantsProductUpdates: false, rememberDevice: false, returnTo: null },
      [otherRequestId]: { email: 'other@example.test', requestId: otherRequestId, wantsProductUpdates: false, rememberDevice: false, returnTo: null, expiresAt: Date.now() + 60_000 },
    }))
    vi.stubGlobal('location', { href: `https://app.silentsuite.io/signup/pending-payment?email_verification_token=link-token&request_id=${requestId}`, search: `?email_verification_token=link-token&request_id=${requestId}` })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ contractVersion: 2, state: 'closed', flow: null }), { status: 200 })))

    render(<PendingPaymentPage />)

    expect(await screen.findByText(/verification link could not be matched/i)).toBeInTheDocument()
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('/consume'))).toBe(false)
    expect(JSON.parse(localStorage.getItem('silentsuite-signup-email-proof') ?? '{}')).toHaveProperty(otherRequestId)
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
    expect(screen.getByText(/payment already in progress/i)).toBeInTheDocument()

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

    expect(screen.getByRole('heading', { name: /still waiting for settlement/i })).toBeInTheDocument()
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
