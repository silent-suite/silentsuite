import { emailOwnershipToken as signedEmailProof, checkoutIntentToken as signedCheckoutIntent, signedAuthorityFixture } from '@/src/__tests__/fixtures/annual-authority'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BillingResponseError, type AnnualDisclosure } from '@/app/lib/billing-v2'
import SignupPage from '../page'
import VerificationCallbackPage from '../verify-email/page'
import { StrictMode } from 'react'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_BTCPAY_CHECKOUT_ENABLED = 'true'
})

const requestId = 'e91a6d70-0d4e-4352-9bdc-426d1f76d771'
const ownershipToken = signedEmailProof
const offer = {
  contractVersion: 2,
  requestId,
  offer: {
    planId: 'early_annual', customerClass: 'early', billingInterval: 'annual', annualAmountMinor: 3600,
    monthlyEquivalentMinor: 300, currency: 'EUR', providers: ['stripe', 'btcpay'], offerRevision: 1,
    offerToken: 'signed-offer', expiresAt: '2026-08-11T12:10:00Z',
  },
}
const noCardDisclosure = {
  kind: 'no_auto_charge', annualAmountMinor: 3600, firstChargeAmountMinor: 0, renewalAmountMinor: null,
  monthlyEquivalentMinor: 300, currency: 'EUR', trialEndsAt: '2026-08-18T12:00:00Z', firstChargeAt: null,
  cancelBy: null, cancelByInclusive: false, autoRenew: false, prepaid: false, refundWindowDays: null,
  bonusDays: 0, periodEndRule: 'activation_plus_trial', renewalAt: null, entitlementEndsAt: '2026-08-18T12:00:00Z',
}
const authState = {
  prepareSignupDraft: vi.fn(), createEtebaseAccount: vi.fn(), signup: vi.fn(), provisionAnnualNoCard: vi.fn(),
  startAnnualSignupPayment: vi.fn(), finalizePaidSignup: vi.fn(), completeSignup: vi.fn(),
  // Inline pending-payment continuation dependencies (refresh recovery renders it in place).
  pendingSignup: null as null | Record<string, unknown>,
  saveSignupStateForRedirect: vi.fn(), restoreSignupStateFromRedirect: vi.fn(() => null),
  recoverCompletedSignupSession: vi.fn(), clearPendingSignupPaymentRecovery: vi.fn(),
}
// The imperative store view the Back modal reads and releases through.
const storeState: { pendingSignup: Record<string, unknown> | null } = { pendingSignup: { paymentSessionRequestKey: requestId } }

vi.mock('@/app/stores/use-auth-store', () => {
  function useAuthStore<T>(selector: (state: typeof authState) => T): T { return selector(authState) }
  useAuthStore.getState = () => ({
    ...storeState,
    clearPendingSignupPaymentRecovery: () => { storeState.pendingSignup = { ...storeState.pendingSignup, paymentSessionToken: undefined, paymentSessionRequestKey: undefined } },
  })
  useAuthStore.setState = vi.fn()
  return { useAuthStore }
})

/** Model the real store after a payment start: the modal must find the exact owned capability. */
function ownPayment(provider: 'stripe' | 'btcpay') {
  storeState.pendingSignup = { email: 'expiry@example.test', paymentMethod: provider, paymentSessionToken: 'r'.repeat(43), paymentSessionRequestKey: requestId }
}
vi.mock('@/app/stores/use-etebase-store', () => ({ normalizeServerUrl: (value: string) => value }))
vi.mock('@/app/lib/config', () => ({ BILLING_API_URL: 'https://billing.test' }))
vi.mock('@/app/lib/self-hosted', () => ({ isSelfHosted: false, isCustomServer: () => false }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/app/components/stripe-payment-form', () => ({ default: ({ submitLabel, mode }: { submitLabel: string; mode: string }) => <button data-testid="card-submit" data-mode={mode}>{submitLabel}</button> }))
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }))

describe('email-link seven-day no-card continuation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authState.provisionAnnualNoCard.mockReset()
    authState.startAnnualSignupPayment.mockReset()
    vi.stubGlobal('scrollTo', vi.fn())
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    sessionStorage.clear()
    localStorage.clear()
    storeState.pendingSignup = { paymentSessionRequestKey: requestId }
    window.history.replaceState({}, '', '/signup')
  })

  it('shows a single email field and retires sent-link context on Back', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 202 })))
    render(<SignupPage />)
    expect(screen.queryByLabelText(/confirm email/i)).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: 'first@example.test' } })
    const next = screen.getByRole('button', { name: /^continue$/i })
    await waitFor(() => expect(next).toBeEnabled())
    fireEvent.click(next)
    const message = await screen.findByText('Check your email and open the verification link in this browser. Then choose your password.')
    const panel = screen.getByRole('region', { name: 'Email verification' })
    expect(panel).toContainElement(message)
    expect(panel).toContainElement(screen.getByRole('button', { name: /^back$/i }))
    expect(panel).toHaveClass('flex', 'flex-col', 'items-center', 'justify-center')
    expect(screen.queryByText('Account setup')).not.toBeInTheDocument()
    expect(screen.getAllByText('Finish')).toHaveLength(2)
    expect(screen.queryByLabelText(/^email$/i)).not.toBeInTheDocument()
    expect(localStorage.getItem('silentsuite-signup-email-proof')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
    expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument()
    expect(localStorage.getItem('silentsuite-signup-email-proof')).toBeNull()
  })

  it('updates only the matching waiting tab without granting signup authority', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 202 })))
    render(<SignupPage />)
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: 'first@example.test' } })
    const next = screen.getByRole('button', { name: /^continue$/i })
    await waitFor(() => expect(next).toBeEnabled())
    fireEvent.click(next)
    await screen.findByText(/Check your email and open/)
    const [currentRequest] = Object.keys(JSON.parse(localStorage.getItem('silentsuite-signup-email-proof')!))
    const preparedBeforeMarker = authState.prepareSignupDraft.mock.calls.length
    const warnsOnLeave = () => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }
    expect(warnsOnLeave()).toBe(true)
    const publish = (id: string, expiresAt = Date.now() + 60_000) => act(() => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'silentsuite-signup-email-verified', storageArea: localStorage,
        newValue: JSON.stringify({ requestId: id, verifiedAt: Date.now(), expiresAt }),
      }))
    })
    publish(requestId)
    publish(currentRequest, Date.now() - 1)
    expect(screen.queryByText(/Email confirmed/)).not.toBeInTheDocument()
    expect(warnsOnLeave()).toBe(true)
    publish(currentRequest)
    expect(screen.getByText('Email confirmed. Continue in the other tab. This tab is safe to close.')).toBeVisible()
    expect(warnsOnLeave()).toBe(false)
    expect(screen.queryByLabelText(/^password$/i)).not.toBeInTheDocument()
    expect(authState.prepareSignupDraft).toHaveBeenCalledTimes(preparedBeforeMarker)
    expect(authState.createEtebaseAccount).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
    publish(currentRequest)
    expect(screen.getByLabelText(/^email$/i)).toBeVisible()
    expect(screen.queryByText(/Email confirmed/)).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: 'second@example.test' } })
    const again = screen.getByRole('button', { name: /^continue$/i })
    await waitFor(() => expect(again).toBeEnabled())
    fireEvent.click(again)
    await screen.findByText(/Check your email and open/)
    expect(warnsOnLeave()).toBe(true)
    publish(currentRequest)
    expect(screen.queryByText(/Email confirmed/)).not.toBeInTheDocument()
    const [replacement] = Object.keys(JSON.parse(localStorage.getItem('silentsuite-signup-email-proof')!))
    publish(replacement)
    expect(screen.getByText(/Email confirmed/)).toBeVisible()
  })

  it('requires the password acknowledgement before no-card creation, then does not ask twice', async () => {
    await reachPlanScreen()
    fireEvent.click(screen.getByRole('button', { name: /7 day free trial/i }))
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }))
    const complete = await screen.findByRole('button', { name: /continue to your workspace/i })
    expect(complete).toBeDisabled()
    fireEvent.click(complete)
    expect(authState.createEtebaseAccount).not.toHaveBeenCalled()
    expect(authState.provisionAnnualNoCard).not.toHaveBeenCalled()
    expect(screen.queryByText(/Free until|Start your free trial/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: /cannot recover my password/i }))
    fireEvent.click(complete)
    await waitFor(() => expect(authState.provisionAnnualNoCard).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(authState.completeSignup).toHaveBeenCalledTimes(1), { timeout: 4000 })
    expect(authState.createEtebaseAccount).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('checkbox', { name: /cannot recover my password/i })).not.toBeInTheDocument()
  })

  it('ignores a delayed email response after Back and rejects the retired link', async () => {
    let deliver!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { deliver = resolve })))
    render(<SignupPage />)
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: 'late@example.test' } })
    const next = screen.getByRole('button', { name: /^continue$/i })
    await waitFor(() => expect(next).toBeEnabled())
    fireEvent.click(next)
    await screen.findByText('Sending verification email...')
    const context = JSON.parse(localStorage.getItem('silentsuite-signup-email-proof')!)
    const retiredRequest = Object.keys(context)[0]
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
    await act(async () => deliver(new Response('{}', { status: 202 })))
    expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument()
    expect(screen.queryByText(/Check your email and open/)).not.toBeInTheDocument()
    cleanup()
    window.history.replaceState({}, '', `/signup?token=old-token&request_id=${retiredRequest}`)
    vi.stubGlobal('fetch', vi.fn())
    render(<SignupPage />)
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be matched')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['review', 'setup', 'payment'])('recovers a refreshed %s checkpoint without replay or secrets', async (phase) => {
    vi.stubGlobal('fetch', vi.fn())
    window.history.replaceState({ silentsuiteSignup: { version: 1, journey: 'test-journey', phase, step: 'plan', view: 'confirm' } }, '', '/signup')
    render(<SignupPage />)
    // A payment checkpoint continues the owned payment inline; without a
    // capability in this browser it can only point back to the original tab.
    expect(await screen.findByRole('heading', { name: phase === 'payment' ? /recovery details unavailable/i : 'Continue your signup safely' })).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
    expect(authState.createEtebaseAccount).not.toHaveBeenCalled()
    expect(authState.provisionAnnualNoCard).not.toHaveBeenCalled()
    expect(authState.startAnnualSignupPayment).not.toHaveBeenCalled()
    expect(screen.queryByLabelText(/^password$/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /recover existing payment/i })).not.toBeInTheDocument()
    if (phase === 'review') {
      fireEvent.click(screen.getByRole('button', { name: 'Verify email again' }))
      expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument()
      expect(fetch).not.toHaveBeenCalled()
    } else {
      expect(screen.queryByRole('button', { name: 'Verify email again' })).not.toBeInTheDocument()
    }
  })

  it('keeps setup recovery after Back to a pre-mutation history entry and refresh', async () => {
    vi.stubGlobal('fetch', vi.fn())
    window.history.replaceState({ silentsuiteSignup: { version: 1, journey: 'test-journey', phase: 'review', step: 'plan', view: 'cards' } }, '', '/signup')
    sessionStorage.setItem('silentsuiteSignup:test-journey', 'setup')
    render(<SignupPage />)
    await screen.findByRole('heading', { name: 'Continue your signup safely' })
    expect(screen.queryByRole('button', { name: 'Verify email again' })).not.toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['app', 'browser'] as const)('releases Etebase-only failure using %s Back, requiring fresh consent and rejecting stale Forward', async (back) => {
    const confirm = await openConfirmation()
    const prior = vi.mocked(fetch).getMockImplementation()!
    authState.createEtebaseAccount.mockRejectedValueOnce(new Error('Encrypted account connection failed'))
    fireEvent.click(confirm)
    expect(await screen.findByRole('alert')).toHaveTextContent('Encrypted account connection failed')
    expect(authState.provisionAnnualNoCard).not.toHaveBeenCalled()
    const oldCheckpoint = window.history.state
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/cancel')) return new Response(JSON.stringify({ contractVersion: 2, requestId,
        checkoutIntentJti: 'a2c4f872-01b7-4176-8325-522486b20cae', state: 'released' }))
      return prior(input, init)
    }))
    if (back === 'app') fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
    else await traverseHistory('back')
    await screen.findByRole('heading', { name: /choose your plan/i })
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/cancel'))).toHaveLength(1)
    act(() => window.dispatchEvent(new PopStateEvent('popstate', { state: oldCheckpoint })))
    expect(screen.queryByRole('button', { name: /continue to your workspace/i })).not.toBeInTheDocument()
    expect(authState.provisionAnnualNoCard).not.toHaveBeenCalled()
    await chooseFreeTrial()
    expect(authState.createEtebaseAccount).toHaveBeenCalledTimes(1)
    expect(authState.prepareSignupDraft).toHaveBeenCalledTimes(1)
  })

  it('keeps the exact selection when Back cancellation is not confirmed', async () => {
    await openConfirmation()
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Cancellation is not confirmed')
    expect(screen.queryByRole('button', { name: /30-day free trial/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Continue current selection' }))
    // Returning to the same reservation asks for the acknowledgement afresh; nothing was created.
    expect(await acknowledgePasswordKey()).toBeEnabled()
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/activate'))).toHaveLength(1)
    expect(authState.createEtebaseAccount).not.toHaveBeenCalled()
  })

  it('locks original credentials after encrypted creation, Billing failure and release while allowing fresh plans', async () => {
    const confirm = await openConfirmation()
    authState.provisionAnnualNoCard.mockRejectedValueOnce(new Error('Billing proof unavailable'))
    fireEvent.click(confirm)
    expect(await screen.findByRole('alert')).toHaveTextContent('Billing proof unavailable')
    const prior = vi.mocked(fetch).getMockImplementation()!
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/cancel')) return new Response(JSON.stringify({ contractVersion: 2, requestId,
        checkoutIntentJti: 'a2c4f872-01b7-4176-8325-522486b20cae', state: 'released' }))
      return prior(input, init)
    }))
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
    await screen.findByRole('heading', { name: /choose your plan/i })
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
    expect(screen.queryByLabelText(/^password$/i)).not.toBeInTheDocument()
    expect(screen.getByText(/original password remains unchanged/i)).toBeVisible()
    fireEvent.click(await chooseFreeTrial())
    await waitFor(() => expect(authState.createEtebaseAccount).toHaveBeenCalledTimes(2))
    expect(authState.createEtebaseAccount.mock.calls.every((call) => call[1] === 'ValidPass1')).toBe(true)
  })

  it.each(['acknowledged', 'inflight'] as const)('retires a %s resend on Back and ignores old responses and links', async (mode) => {
    localStorage.setItem('silentsuite-signup-email-proof', JSON.stringify({
      [requestId]: { email: 'retry@example.test', requestId, wantsProductUpdates: false, rememberDevice: false, returnTo: null, expiresAt: Date.now() + 60_000 },
    }))
    let deliver!: (response: Response) => void
    let replacement = ''
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/consume')) return new Response('{}', { status: 400 })
      replacement = JSON.parse(String(init?.body)).requestId
      if (mode === 'inflight') return new Promise<Response>((resolve) => { deliver = resolve })
      return new Response('{}', { status: 202 })
    }))
    window.history.replaceState({}, '', `/signup?token=old&request_id=${requestId}`)
    render(<SignupPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Request a new verification email' }))
    if (mode === 'acknowledged') await screen.findByText(/Check your email and open/)
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
    if (mode === 'inflight') await act(async () => deliver(new Response('{}', { status: 202 })))
    expect(screen.getByLabelText(/^email$/i)).toBeVisible()
    expect(localStorage.getItem('silentsuite-signup-email-proof') ?? '').not.toContain(replacement)
    cleanup()
    window.history.replaceState({}, '', `/signup?token=abandoned&request_id=${replacement}`)
    vi.stubGlobal('fetch', vi.fn())
    render(<SignupPage />)
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be matched')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['card', 'pending', 'error', 'expired'] as const)('shows retained payment Back recovery on the actual %s panel', async (state) => {
    await reachPlanScreen()
    authState.startAnnualSignupPayment.mockResolvedValue(state === 'card' ? { clientSecret: 'seti_retained_secret' } : {
      cryptoCheckoutUrl: 'https://btcpay.silentsuite.io/i/retained', cryptoInvoiceId: 'retained', cryptoInvoiceLookupToken: 'lookup',
    })
    const prior = vi.mocked(fetch).getMockImplementation()!
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/payment-methods')) return new Response(JSON.stringify({ paymentMethods: state === 'error' ? [] : [{ id: 'BTC', address: 'test-address', qrValue: 'bitcoin:test-address' }] }))
      if (String(input).endsWith('/invoice/retained')) return new Response(JSON.stringify({ status: state === 'expired' ? 'expired' : 'new' }))
      return prior(input, init)
    }))
    await choosePaymentMethod(state === 'card' ? 'stripe' : 'btcpay')
    // Dynamic Stripe loading can replace its Suspense subtree. Wait for the
    // actual form before acquiring its live Back control, not a detached node.
    if (state === 'card') await screen.findByTestId('card-submit')
    if (state === 'expired') await screen.findByText(/This Bitcoin invoice expired/)
    if (state === 'error') await screen.findByText('Could not load Bitcoin payment details.')
    // Exactly one Back, one quiet support link, and no recovery section on the payable panel.
    const backs = await screen.findAllByRole('button', { name: /^back$/i })
    expect(backs).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Problems with payment?' })).toHaveAttribute('href', 'mailto:support@silentsuite.io')
    expect(screen.queryByText(/Recover pending payment|Resume pending payment|Recover existing payment|Check this payment|Keep this payment|Cancel .* payment and choose/i)).not.toBeInTheDocument()
    await waitFor(() => expect(backs[0]).toBeEnabled())
    fireEvent.click(backs[0])
    const dialog = await screen.findByRole('dialog', { name: state === 'card' ? 'Leave card checkout?' : 'Cancel this Bitcoin payment?' })
    expect(dialog).toBeVisible()
    expect(screen.getByRole('button', { name: 'Stay' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Cancel and go back' })).toBeEnabled()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByText(/Go back and start a new Bitcoin invoice/)).not.toBeInTheDocument()
    expect(authState.startAnnualSignupPayment).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('heading', { name: /choose your plan/i })).not.toBeInTheDocument()
    // Dismissing resumes the same payable panel.
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    if (state === 'card') expect(screen.getByTestId('card-submit')).toBeVisible()
    expect(authState.startAnnualSignupPayment).toHaveBeenCalledTimes(1)
  })

  it.each(['btcpay', 'stripe'] as const)('Back confirmation releases the %s payment only on an exact receipt and returns to the method choices', async (provider) => {
    await reachPlanScreen()
    ownPayment(provider)
    authState.startAnnualSignupPayment.mockResolvedValue(provider === 'stripe' ? { clientSecret: 'seti_release_secret' } : {
      cryptoCheckoutUrl: 'https://btcpay.silentsuite.io/i/release', cryptoInvoiceId: 'release', cryptoInvoiceLookupToken: 'lookup',
    })
    const cancelBodies: Record<string, unknown>[] = []
    const prior = vi.mocked(fetch).getMockImplementation()!
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/payment-methods')) return new Response(JSON.stringify({ paymentMethods: [{ id: 'BTC', address: 'test-address', qrValue: 'bitcoin:test-address' }] }))
      if (String(input).endsWith('/invoice/release')) return new Response(JSON.stringify({ status: 'new' }))
      if (String(input).endsWith('/cancel')) {
        cancelBodies.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify({ contractVersion: 2, state: 'released', flow: { provider, status: 'reconciliation_required' }, release: { requestKey: requestId, provider, providerObjectId: 'exact' } }))
      }
      return prior(input, init)
    }))
    await choosePaymentMethod(provider)
    if (provider === 'stripe') await screen.findByTestId('card-submit')
    else await screen.findByText('Copy payment details')
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel and go back' }))
    expect(await screen.findByRole('heading', { name: 'Choose how to pay' })).toBeVisible()
    expect(cancelBodies).toEqual([{ contractVersion: 2, email: 'expiry@example.test', requestKey: requestId, recoverySecret: 'r'.repeat(43), switchingProfile: 'v1', ...(provider === 'btcpay' ? { confirmNoBitcoinSent: true } : {}) }])
    // Both methods are offered again; nothing was started for the other provider.
    expect(screen.getByRole('button', { name: /^pay by card for/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /^pay .* with bitcoin for/i })).toBeEnabled()
    expect(screen.queryByTestId('card-submit')).not.toBeInTheDocument()
    expect(screen.queryByText('Copy payment details')).not.toBeInTheDocument()
    expect(authState.startAnnualSignupPayment).toHaveBeenCalledTimes(1)
  })

  it('unconfirmed Bitcoin cancellation allows choices or resuming the same payment, never a payable card attempt', async () => {
    await reachPlanScreen()
    ownPayment('btcpay')
    authState.startAnnualSignupPayment.mockResolvedValue({ cryptoCheckoutUrl: 'https://btcpay.silentsuite.io/i/retained', cryptoInvoiceId: 'retained', cryptoInvoiceLookupToken: 'lookup' })
    let cancels = 0
    const prior = vi.mocked(fetch).getMockImplementation()!
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/payment-methods')) return new Response(JSON.stringify({ paymentMethods: [{ id: 'BTC', address: 'test-address', qrValue: 'bitcoin:test-address' }] }))
      if (String(input).endsWith('/invoice/retained')) return new Response(JSON.stringify({ status: 'new' }))
      if (String(input).endsWith('/cancel')) { cancels++; return new Response(JSON.stringify({ contractVersion: 2, state: 'open', flow: { provider: 'btcpay', status: 'provider_pending' } })) }
      return prior(input, init)
    }))
    await choosePaymentMethod('btcpay')
    await screen.findByText('Copy payment details')
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
    await screen.findByRole('dialog', { name: 'Cancel this Bitcoin payment?' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel and go back' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Cancellation is not confirmed yet')
    expect(cancels).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: 'Retry cancellation' }))
    await waitFor(() => expect(cancels).toBe(2))
    expect(screen.getByRole('alert')).toHaveTextContent('Cancellation is not confirmed yet')
    fireEvent.click(screen.getByRole('button', { name: 'Back without cancelling' }))
    expect(await screen.findByRole('heading', { name: 'Choose how to pay' })).toBeVisible()
    // Card cannot become payable while the Bitcoin payment is still owned.
    fireEvent.click(screen.getByRole('button', { name: /^pay by card for/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Bitcoin payment is still pending')
    expect(screen.queryByTestId('card-submit')).not.toBeInTheDocument()
    expect(authState.startAnnualSignupPayment).toHaveBeenCalledTimes(1)
    // Bitcoin resumes the same invoice without any new payment start.
    fireEvent.click(screen.getByRole('button', { name: /^pay .* with bitcoin for/i }))
    expect(await screen.findByText('Copy payment details')).toBeVisible()
    expect(authState.startAnnualSignupPayment).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/activate'))).toHaveLength(1)
  })

  it('states each method\'s terms on the choice screen, opens the invoice directly and keeps terms beside it', async () => {
    await reachPlanScreen()
    fireEvent.click(screen.getByRole('button', { name: /30-day free trial/i }))
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }))
    const bitcoin = await screen.findByRole('button', { name: /^pay .* with bitcoin for/i })
    expect(bitcoin).toHaveTextContent('Bitcoin, Lightning and Monero')
    expect(bitcoin).toHaveTextContent('Payment has to be made with account creation, but we offer a 30-day, no-questions-asked money-back guarantee.')
    expect(bitcoin).toHaveTextContent('€36.00 for one year, paid now. No automatic renewal.')
    const card = screen.getByRole('button', { name: /^pay by card for/i })
    expect(card).toHaveTextContent('Pay by Card (Powered by Stripe)')
    expect(card).toHaveTextContent('Card gets billed after the 30-day trial. You can cancel anytime.')
    // The repeated plan/price bar is gone; each method states its own terms once.
    expect(screen.queryByText('€36.00/year')).not.toBeInTheDocument()
    expect(screen.queryByText(/Choose a payment method to review|Annual only|Card with Stripe|Bitcoin with BTCPay|billed annually/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Copy payment details')).not.toBeInTheDocument()
    expect(authState.startAnnualSignupPayment).not.toHaveBeenCalled()
    authState.startAnnualSignupPayment.mockResolvedValue({ cryptoCheckoutUrl: 'https://btcpay.silentsuite.io/i/terms', cryptoInvoiceId: 'terms', cryptoInvoiceLookupToken: 'lookup' })
    const prior = vi.mocked(fetch).getMockImplementation()!
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/payment-methods')) return new Response(JSON.stringify({ paymentMethods: [{ id: 'BTC-LN', label: 'Bitcoin Lightning', address: 'lnbc-test' }, { id: 'BTC-CHAIN', label: 'Bitcoin on-chain', address: 'test-address' }] }))
      if (String(input).endsWith('/invoice/terms')) return new Response(JSON.stringify({ status: 'new' }))
      return prior(input, init)
    }))
    fireEvent.click(bitcoin)
    await screen.findByText('Copy payment details')
    expect(screen.queryByText(/Review your Bitcoin payment|Continue to Bitcoin payment|Refund window|Access through/)).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /pay €36\.00 with bitcoin/i })).toBeVisible()
    expect(screen.getByText(/€36.00 now for one year/)).toBeVisible()
    expect(screen.getByText(/€36.00 now for one year/)).toHaveTextContent('No automatic renewal')
    expect(screen.getByText(/30-day full refund, no questions asked/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Bitcoin Lightning' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Bitcoin on-chain' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Monero (soon)' })).toBeDisabled()
    expect(authState.startAnnualSignupPayment).toHaveBeenCalledTimes(1)
    expect(authState.startAnnualSignupPayment).toHaveBeenCalledWith(signedCheckoutIntent, 'btcpay', 'http://localhost:3000/signup/pending-payment', 'annual')
  })

  it('opens an explicit Bitcoin switching decision on browser Back and keeps cancellation errors visible', async () => {
    await reachPlanScreen()
    authState.startAnnualSignupPayment.mockResolvedValue({ clientSecret: null, cryptoCheckoutUrl: 'https://btcpay.silentsuite.io/i/invoice', cryptoInvoiceId: 'invoice', cryptoInvoiceLookupToken: 'r'.repeat(43), paymentSessionToken: 'r'.repeat(43) })
    const prior = vi.mocked(fetch).getMockImplementation()!
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/payment-methods')) return new Response(JSON.stringify({ paymentMethods: [{ id: 'BTC-CHAIN', label: 'Bitcoin on-chain', address: 'test-address' }] }))
      if (String(input).endsWith('/invoice/invoice')) return new Response(JSON.stringify({ status: 'new' }))
      return prior(input, init)
    }))
    await choosePaymentMethod('btcpay')
    await screen.findByText('Copy payment details')
    expect(screen.queryByText(/copied Bitcoin address cannot be revoked/)).not.toBeInTheDocument()
    window.dispatchEvent(new Event('pagehide'))
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/cancel'))).toHaveLength(0)
    await traverseHistory('back')
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this Bitcoin payment?' })
    expect(dialog).toHaveTextContent('Only continue if you haven’t sent payment. This checkout will be cancelled. Do not send Bitcoin or Lightning to its old payment details.')
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    // This store never owns the capability, so cancellation cannot be confirmed and nothing is released.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel and go back' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Cancellation is not confirmed yet')
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/cancel'))).toHaveLength(0)
    expect(screen.queryByRole('heading', { name: 'Choose how to pay' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }))
    expect(await screen.findByText('Copy payment details')).toBeVisible()
    expect(authState.startAnnualSignupPayment).toHaveBeenCalledTimes(1)
  })

  it('retains a usable same-attempt retry after failed Bitcoin start and browser Back/Forward', async () => {
    await reachPlanScreen()
    authState.startAnnualSignupPayment.mockRejectedValue(new BillingResponseError('Payment provider confirmation is pending. Retry with the same recovery secret.', 503, 'https://api.silentsuite.io/errors/provider-unavailable'))
    await choosePaymentMethod('btcpay')
    await screen.findByText(/Payment creation is not yet confirmed/)
    expect(screen.queryByText(/webhook|secret/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Copy payment details')).not.toBeInTheDocument()
    expect(screen.getByText(/€36.00 now for one year/)).toBeVisible()
    await traverseHistory('back')
    expect(screen.queryByLabelText(/^email$/i)).not.toBeInTheDocument()
    await traverseHistory('forward')
    const retry = await screen.findByRole('button', { name: /^retry bitcoin payment$/i })
    fireEvent.click(retry)
    await waitFor(() => expect(authState.startAnnualSignupPayment).toHaveBeenCalledTimes(2))
    expect(authState.startAnnualSignupPayment.mock.calls[0]).toEqual(authState.startAnnualSignupPayment.mock.calls[1])
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/activate'))).toHaveLength(1)
  })

  it('describes Bitcoin settlement separately from unfinished account and vault setup', async () => {
    await reachPlanScreen()
    authState.startAnnualSignupPayment.mockResolvedValue({ cryptoCheckoutUrl: 'https://btcpay.silentsuite.io/i/settled', cryptoInvoiceId: 'settled', cryptoInvoiceLookupToken: 'lookup' })
    const prior = vi.mocked(fetch).getMockImplementation()!
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/payment-methods')) return new Response(JSON.stringify({ paymentMethods: [{ id: 'BTC', address: 'test-address' }] }))
      if (String(input).endsWith('/invoice/settled')) return new Response(JSON.stringify({ status: 'settled' }))
      return prior(input, init)
    }))
    await choosePaymentMethod('btcpay')
    expect(await screen.findByText(/Payment confirmed for your Early Adopter Plan/)).toHaveTextContent('Account and vault setup still need to finish')
    expect(screen.queryByText(/access is active|early_annual|Plan ID/)).not.toBeInTheDocument()
    expect(authState.finalizePaidSignup).not.toHaveBeenCalled()
    expect(authState.completeSignup).not.toHaveBeenCalled()
  })

  async function traverseHistory(direction: 'back' | 'forward') {
    const observed = new Promise<void>((resolve) => window.addEventListener('popstate', () => resolve(), { once: true }))
    await act(async () => { window.history[direction](); await observed })
  }

  /** Mount through a verified email link, choose the password once and reach plan selection. */
  async function reachPlanScreen(checkoutToken = signedCheckoutIntent, selectedDisclosure?: AnnualDisclosure) {
    localStorage.setItem('silentsuite-signup-email-proof', JSON.stringify({
      [requestId]: { email: 'expiry@example.test', requestId, wantsProductUpdates: false, rememberDevice: false, returnTo: null, expiresAt: Date.now() + 60_000 },
    }))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestedProvider = init?.body ? JSON.parse(String(init.body)).provider : undefined
      if (String(input).endsWith('/consume')) return new Response(JSON.stringify({ contractVersion: 2, emailOwnershipToken: ownershipToken, expiresAt: '2099-01-01T00:00:00Z' }))
      if (String(input).endsWith('/activate')) return new Response(JSON.stringify({ contractVersion: 2, checkoutIntentToken: checkoutToken, expiresAt: '2099-01-01T00:00:00Z', disclosure: selectedDisclosure ?? (requestedProvider === 'none' ? noCardDisclosure : requestedProvider === 'btcpay' ? { ...noCardDisclosure, kind: 'prepaid', firstChargeAmountMinor: 3600, trialEndsAt: null, prepaid: true, refundWindowDays: 30, periodEndRule: 'confirmation_plus_1_utc_calendar_year', entitlementEndsAt: null } : { ...noCardDisclosure, kind: 'card_trial', firstChargeAmountMinor: 3600, renewalAmountMinor: 3600, firstChargeAt: noCardDisclosure.trialEndsAt, cancelBy: noCardDisclosure.trialEndsAt, autoRenew: true, refundWindowDays: 30, periodEndRule: 'first_charge_plus_1_utc_calendar_year', renewalAt: '2099-09-10T12:00:00Z', entitlementEndsAt: '2099-09-10T12:00:00Z' }) }))
      return new Response(JSON.stringify(offer))
    }))
    window.history.replaceState({}, '', `/signup?token=link-token&request_id=${requestId}`)
    render(<SignupPage />)
    await screen.findByRole('heading', { name: 'Choose your password' })
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'ValidPass1' } })
    const next = screen.getByRole('button', { name: /continue to trial options/i })
    await waitFor(() => expect(next).toBeEnabled())
    fireEvent.click(next)
    await screen.findByRole('heading', { name: /choose your plan/i })
    expect(screen.queryByText('Annual access only. Exact price and renewal terms are confirmed by Billing before checkout.')).not.toBeInTheDocument()
    // The first choice screen carries no price, annual wording or charge-timing promise.
    expect(screen.queryByText(/before day 30|no charge until|billed annually|annual plan|€36|€48|\/year/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /30-day free trial/i })).toHaveTextContent('Full access to all features')
  }

  /** Tick the password-loss acknowledgement and return its enabled action. */
  async function acknowledgePasswordKey() {
    const action = await screen.findByRole('button', { name: /continue to your workspace/i })
    expect(action).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: /cannot recover my password/i }))
    expect(action).toBeEnabled()
    return action
  }

  /** 7-day + Continue reserves the trial and lands on the acknowledgement without any review screen. */
  async function chooseFreeTrial() {
    fireEvent.click(await screen.findByRole('button', { name: /7 day free trial/i }))
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }))
    const action = await acknowledgePasswordKey()
    expect(screen.queryByText(/Start your free trial|Free until|Create account and start free trial/)).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Your password is your only key' })).toBeVisible()
    return action
  }

  /** 30-day + Continue, then the method click; payment start mocks must already be in place. */
  async function choosePaymentMethod(provider: 'stripe' | 'btcpay') {
    fireEvent.click(await screen.findByRole('button', { name: /30-day free trial/i }))
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }))
    if (provider === 'stripe') fireEvent.click(await screen.findByRole('button', { name: /^pay by card for/i }))
    else fireEvent.click(await screen.findByRole('button', { name: /^pay .* with bitcoin for/i }))
  }

  async function openConfirmation(checkoutToken = signedCheckoutIntent, selectedDisclosure?: AnnualDisclosure) {
    await reachPlanScreen(checkoutToken, selectedDisclosure)
    return chooseFreeTrial()
  }

  it.each(['charge_now', 'card_trial'] as const)('keeps the validated %s disclosure through card confirmation', async (kind) => {
    const disclosure: AnnualDisclosure = {
      kind, annualAmountMinor: 3600, firstChargeAmountMinor: 3600, renewalAmountMinor: 3600,
      monthlyEquivalentMinor: 300, currency: 'EUR', trialEndsAt: null, firstChargeAt: null,
      cancelBy: null, cancelByInclusive: false, autoRenew: true, prepaid: false, refundWindowDays: 30,
      bonusDays: 0, periodEndRule: 'confirmation_plus_1_utc_calendar_year', renewalAt: null, entitlementEndsAt: null,
      ...(kind === 'card_trial' ? { trialEndsAt: '2099-09-10T12:00:00Z', firstChargeAt: '2099-09-10T12:00:00Z', cancelBy: '2099-09-10T12:00:00Z', periodEndRule: 'first_charge_plus_1_utc_calendar_year', renewalAt: '2100-09-10T12:00:00Z', entitlementEndsAt: '2100-09-10T12:00:00Z' } : {}),
    }
    await reachPlanScreen(signedCheckoutIntent, disclosure)
    authState.startAnnualSignupPayment.mockResolvedValue({ clientSecret: kind === 'card_trial' ? 'seti_fixture' : 'pi_fixture' })
    await choosePaymentMethod('stripe')
    const submit = await screen.findByTestId('card-submit')
    expect(screen.queryByText(/early_annual|Plan ID|Confirm annual terms|Review your|Continue to card setup/)).not.toBeInTheDocument()
    expect(submit).toHaveAttribute('data-mode', kind === 'card_trial' ? 'setup' : 'payment')
    expect(submit).toHaveTextContent(kind === 'card_trial' ? 'Start free trial — no charge today' : 'Pay €36.00 now')
    // The plan/price bar is not repeated; the validated disclosure below is the one commitment statement.
    expect(screen.queryByText('€36.00/year')).not.toBeInTheDocument()
    expect(screen.getAllByText(/Secured by Stripe/)).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Problems with payment?' })).toHaveAttribute('href', 'mailto:support@silentsuite.io')
    if (kind === 'charge_now') {
      // The method screen's requested card trial is never repeated once Billing discloses an immediate charge.
      expect(screen.queryByText(/€0 today|No charge today|after.*trial|30-day trial|Start.*free trial/i)).not.toBeInTheDocument()
      expect(screen.getByText(/€36\.00 now by card/)).toHaveTextContent('one year of access')
    } else {
      expect(screen.getByText(/€0 today/)).toHaveTextContent('€36.00 on 2099-09-10 12:00 UTC')
      expect(screen.getByText(/Auto-renews at €36\.00\/year/)).toHaveTextContent('30-day refund window')
    }
    expect(authState.startAnnualSignupPayment).toHaveBeenCalledWith(signedCheckoutIntent, 'stripe', 'http://localhost:3000/signup', offer.offer.billingInterval)
  })

  it.each(['stripe', 'btcpay'] as const)('cancels a reserved %s selection whose payment start never dispatched', async (provider) => {
    await reachPlanScreen()
    const original = Storage.prototype.setItem
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith('silentsuiteSignup:')) throw new DOMException('Full', 'QuotaExceededError')
      original.call(this, key, value)
    })
    try {
      await choosePaymentMethod(provider)
      expect(await screen.findByRole('alert')).toHaveTextContent(/free.*storage.*retry/i)
    } finally { storage.mockRestore() }
    expect(authState.startAnnualSignupPayment).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: provider === 'stripe' ? /^retry card setup$/i : /^retry bitcoin payment$/i })).toBeEnabled()
    const prior = vi.mocked(fetch).getMockImplementation()!
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/cancel')) return new Response(JSON.stringify({ contractVersion: 2, requestId,
        checkoutIntentJti: 'a2c4f872-01b7-4176-8325-522486b20cae', state: 'released' }))
      return prior(input, init)
    }))
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
    await screen.findByRole('heading', { name: /choose your plan/i })
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/cancel'))).toHaveLength(1)
    expect(authState.startAnnualSignupPayment).not.toHaveBeenCalled()
    expect(authState.createEtebaseAccount).not.toHaveBeenCalled()
  })

  it('explicitly cancels the no-card acknowledgement with single-flight response-loss retry and fresh consent', async () => {
    await openConfirmation()
    const previousFetch = vi.mocked(fetch).getMockImplementation()!
    const successorToken = signedAuthorityFixture('checkout-intent', {}, { jti: '885a9c19-3e5e-4462-b4c1-1c32fc7ac612' })
    let release: ((response: Response) => void) | undefined
    let cancels = 0
    const payloads: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/cancel')) {
        payloads.push(JSON.parse(String(init?.body)))
        cancels++
        if (cancels === 1) throw new Error('response lost')
        return new Promise<Response>((resolve) => { release = resolve })
      }
      if (String(input).endsWith('/activate')) {
        expect(JSON.parse(String(init?.body)).requestId).toBe(requestId)
        return new Response(JSON.stringify({ contractVersion: 2, checkoutIntentToken: successorToken,
          expiresAt: '2099-01-01T00:00:00Z', disclosure: noCardDisclosure }))
      }
      return previousFetch(input, init)
    }))
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
    expect(cancels).toBe(1)
    expect(await screen.findByRole('alert')).toHaveTextContent('Cancellation is not confirmed')
    expect(screen.queryByRole('button', { name: 'Return to current selection' })).not.toBeInTheDocument()
    const retry = screen.getByRole('button', { name: 'Retry cancellation' })
    fireEvent.click(retry)
    fireEvent.click(retry)
    expect(cancels).toBe(2)
    expect(payloads[0]).toEqual(payloads[1])
    expect(screen.queryByRole('button', { name: /^back$/i })).not.toBeInTheDocument()
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate', { state: { silentsuiteSignup: { version: 1, journey: 'other', phase: 'review', step: 'verifiedAccount', view: 'cards' } } })) })
    expect(screen.getByRole('heading', { name: 'Cancel this selection?' })).toBeInTheDocument()
    expect(screen.queryByLabelText(/^password$/i)).not.toBeInTheDocument()
    await act(async () => { release!(new Response(JSON.stringify({ contractVersion: 2, requestId,
      checkoutIntentJti: 'a2c4f872-01b7-4176-8325-522486b20cae', state: 'released' }))) })
    expect(screen.queryByRole('button', { name: 'Return to current selection' })).not.toBeInTheDocument()
    expect(authState.createEtebaseAccount).not.toHaveBeenCalled()
    expect(authState.provisionAnnualNoCard).not.toHaveBeenCalled()
    expect(authState.startAnnualSignupPayment).not.toHaveBeenCalled()
    const consent = await chooseFreeTrial()
    expect(authState.createEtebaseAccount).not.toHaveBeenCalled()
    expect(authState.prepareSignupDraft).toHaveBeenCalledTimes(1)
    fireEvent.click(consent)
    await waitFor(() => expect(authState.provisionAnnualNoCard).toHaveBeenCalledWith(successorToken))
    expect(authState.createEtebaseAccount).toHaveBeenCalledWith('expiry@example.test', 'ValidPass1', undefined)
  })

  it('ignores an independently delayed cancellation response from an unmounted predecessor', async () => {
    await openConfirmation()
    let deliverOldResponse!: (response: Response) => void
    const oldFetch = vi.fn(() => new Promise<Response>((resolve) => { deliverOldResponse = resolve }))
    vi.stubGlobal('fetch', oldFetch)
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
    expect(oldFetch).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Checking selection...' })).toBeDisabled()
    cleanup()

    // A separate mounted continuation has acquired a successor. The old request
    // is still unresolved, not a second resolve() on an already-settled promise.
    const successorToken = signedAuthorityFixture('checkout-intent', {}, { jti: '885a9c19-3e5e-4462-b4c1-1c32fc7ac612' })
    const consent = await openConfirmation(successorToken)
    await act(async () => { deliverOldResponse(new Response(JSON.stringify({ contractVersion: 2, requestId,
      checkoutIntentJti: 'a2c4f872-01b7-4176-8325-522486b20cae', state: 'released' }))) })
    expect(consent).toBeEnabled()
    expect(authState.createEtebaseAccount).not.toHaveBeenCalled()
    fireEvent.click(consent)
    await waitFor(() => expect(authState.provisionAnnualNoCard).toHaveBeenCalledExactlyOnceWith(successorToken))
  })

  it('continues cancellation with renewed same-request proof through a mocked email-link remount', async () => {
    await openConfirmation()
    const originalFetch = vi.mocked(fetch).getMockImplementation()!
    const renewedProof = signedAuthorityFixture('email-ownership', {}, { jti: '885a9c19-3e5e-4462-b4c1-1c32fc7ac612' })
    let proofRenewed = false
    const cancellationPayloads: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/cancel')) {
        const payload = JSON.parse(String(init?.body))
        cancellationPayloads.push(payload)
        if (payload.emailOwnershipToken !== renewedProof) return new Response(JSON.stringify({
          type: 'https://api.silentsuite.io/errors/invalid-request',
        }), { status: 400 })
        return new Response(JSON.stringify({ contractVersion: 2, requestId,
          checkoutIntentJti: 'a2c4f872-01b7-4176-8325-522486b20cae', state: 'released' }))
      }
      if (String(input).endsWith('/request')) {
        expect(JSON.parse(String(init?.body)).requestId).toBe(requestId)
        return new Response('{}', { status: 202 })
      }
      if (String(input).endsWith('/consume') && proofRenewed) return new Response(JSON.stringify({
        contractVersion: 2, emailOwnershipToken: renewedProof, expiresAt: '2099-01-01T00:00:00Z',
      }))
      if (String(input).endsWith('/activate') && proofRenewed) {
        expect(JSON.parse(String(init?.body)).emailOwnershipToken).toBe(renewedProof)
        expect(JSON.parse(String(init?.body)).requestId).toBe(requestId)
      }
      return originalFetch(input, init)
    }))
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
    fireEvent.click(await screen.findByRole('button', { name: 'Verify ownership again' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('same signup'))
    const saved = JSON.parse(localStorage.getItem('silentsuite-signup-email-proof')!)
    expect(Object.keys(saved)).toEqual([requestId])
    expect(saved[requestId]).not.toHaveProperty('password')
    expect(saved[requestId]).not.toHaveProperty('checkoutIntentToken')
    // Model following a NEW link; no real email delivery or server release is
    // exercised. No in-memory password or reservation is persisted across mounts.
    cleanup()
    proofRenewed = true
    window.history.replaceState({}, '', `/signup?token=renewed-link-fixture&request_id=${requestId}`)
    render(<SignupPage />)
    await screen.findByRole('heading', { name: 'Choose your password' })
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'ValidPass1' } })
    const next = screen.getByRole('button', { name: /continue to trial options/i })
    await waitFor(() => expect(next).toBeEnabled())
    fireEvent.click(next)
    await chooseFreeTrial()
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
    await screen.findByRole('button', { name: /7 day free trial/i })
    expect(cancellationPayloads).toHaveLength(2)
    expect(cancellationPayloads[1]).toEqual({ ...cancellationPayloads[0], emailOwnershipToken: renewedProof })
    expect(authState.createEtebaseAccount).not.toHaveBeenCalled()
    expect(authState.provisionAnnualNoCard).not.toHaveBeenCalled()
    expect(authState.startAnnualSignupPayment).not.toHaveBeenCalled()
  })

  it.each([400, 409, 503, 'wrong-receipt'] as const)('retains the exact selection on cancellation %s without account/password reset', async (failure) => {
    await openConfirmation()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(failure === 'wrong-receipt'
      ? { contractVersion: 2, requestId, checkoutIntentJti: requestId, state: 'released' }
      : { type: `https://api.silentsuite.io/errors/${failure === 409 ? 'authority-in-progress' : failure === 400 ? 'invalid-request' : 'recovery-unavailable'}` }), { status: typeof failure === 'number' ? failure : 200 })))
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
    await screen.findByRole('alert')
    expect(screen.queryByLabelText(/^password$/i)).not.toBeInTheDocument()
    expect(authState.createEtebaseAccount).not.toHaveBeenCalled()
    expect(authState.prepareSignupDraft).toHaveBeenCalledTimes(1)
    expect(authState.provisionAnnualNoCard).not.toHaveBeenCalled()
    if (failure === 409) {
      fireEvent.click(screen.getByRole('button', { name: 'Continue current selection' }))
      expect(screen.getByRole('button', { name: /continue to your workspace/i })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Cancel this selection and choose again' })).not.toBeInTheDocument()
    } else if (failure === 400) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 202 })))
      fireEvent.click(screen.getByRole('button', { name: 'Verify ownership again' }))
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('same signup'))
      expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).requestId).toBe(requestId)
      expect(screen.getByRole('button', { name: 'Retry cancellation' })).toBeInTheDocument()
    }
  })

  it.each(['none', 'stripe'] as const)('never exposes reservation cancellation after uncertain %s account/payment creation', async (provider) => {
    authState.provisionAnnualNoCard.mockRejectedValue(new Error('Unknown outcome'))
    authState.startAnnualSignupPayment.mockRejectedValue(new Error('Unknown outcome'))
    if (provider === 'none') fireEvent.click(await openConfirmation())
    else { await reachPlanScreen(); await choosePaymentMethod('stripe') }
    await screen.findByRole('alert')
    expect(screen.queryByRole('button', { name: 'Cancel this selection and choose again' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
    expect(screen.queryByRole('button', { name: 'Cancel this selection and choose again' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/^password$/i)).not.toBeInTheDocument()
  })

  it.each(['none', 'stripe'] as const)('renews expired unattempted %s confirmation before any mutation and requires consent again', async (provider) => {
    const rejection = new BillingResponseError('Invalid request', 400, 'https://api.silentsuite.io/errors/invalid-request')
    authState.provisionAnnualNoCard.mockRejectedValue(rejection)
    authState.startAnnualSignupPayment.mockRejectedValue(rejection)
    const confirm = provider === 'none' ? await openConfirmation() : (await reachPlanScreen(), null)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2100-01-01T00:00:00Z'))
    try {
      if (confirm) fireEvent.click(confirm)
      else await choosePaymentMethod('stripe')
      expect(await screen.findByRole('alert')).toHaveTextContent(/review.*choose.*again/i)
      expect(authState.createEtebaseAccount).not.toHaveBeenCalled()
      expect(authState.provisionAnnualNoCard).not.toHaveBeenCalled()
      expect(authState.startAnnualSignupPayment).not.toHaveBeenCalled()
      clock.mockRestore()
      await chooseFreeTrial()
      expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/activate'))).toHaveLength(2)
      expect(authState.createEtebaseAccount).not.toHaveBeenCalled()
    } finally { clock.mockRestore() }
  })

  it.each(['none', 'stripe'] as const)('retains ambiguous 400 after a %s attempt even when its terms expire', async (provider) => {
    const rejection = new BillingResponseError('Invalid request', 400, 'https://api.silentsuite.io/errors/invalid-request')
    authState.provisionAnnualNoCard.mockRejectedValue(rejection)
    authState.startAnnualSignupPayment.mockRejectedValue(rejection)
    if (provider === 'none') fireEvent.click(await openConfirmation())
    else { await reachPlanScreen(); await choosePaymentMethod('stripe') }
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid request')
    expect(authState.createEtebaseAccount).toHaveBeenCalledTimes(provider === 'none' ? 1 : 0)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2100-01-01T00:00:00Z'))
    try {
      fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
      expect(await screen.findByRole('alert')).toHaveTextContent(provider === 'none'
        ? 'Cancellation is not confirmed'
        : 'Payment creation is not yet confirmed')
      expect(screen.queryByRole('button', { name: /7 day free trial/i })).not.toBeInTheDocument()
      expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/activate'))).toHaveLength(1)
    } finally { clock.mockRestore() }
  })

  it('fails navigation-marker quota before mutation, permits account edits, and retries after storage recovery', async () => {
    const confirm = await openConfirmation()
    const original = Storage.prototype.setItem
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith('silentsuiteSignup:')) throw new DOMException('Full', 'QuotaExceededError')
      original.call(this, key, value)
    })
    try {
      fireEvent.click(confirm)
      expect(await screen.findByRole('alert')).toHaveTextContent(/free.*storage.*retry/i)
      expect(authState.createEtebaseAccount).not.toHaveBeenCalled()
      expect(authState.provisionAnnualNoCard).not.toHaveBeenCalled()
      expect(window.history.state.silentsuiteSignup.phase).toBe('review')
      storage.mockRestore()
      // The acknowledgement stays ticked on the same panel, so the retry is one click.
      fireEvent.click(await screen.findByRole('button', { name: /continue to your workspace/i }))
      await waitFor(() => expect(authState.provisionAnnualNoCard).toHaveBeenCalledTimes(1))
      expect(authState.createEtebaseAccount).toHaveBeenCalledTimes(1)
    } finally { storage.mockRestore() }
  })

  it('requests hosted email verification before asking for a password', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 202 })))
    render(<SignupPage />)
    expect(screen.queryByLabelText(/^password$/i)).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: 'fresh@example.test' } })
    const next = screen.getByRole('button', { name: /^continue$/i })
    await waitFor(() => expect(next).toBeEnabled())
    act(() => { fireEvent.click(next); fireEvent.click(next) })
    expect(await screen.findByRole('status')).toHaveTextContent('Check your email')
    expect(authState.createEtebaseAccount).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith('https://billing.test/auth/signup-email-verifications/v2', expect.objectContaining({ body: expect.not.stringContaining('password') }))
  })

  it('shows a failed no-card setup on confirmation and retries without hiding the failure', async () => {
    localStorage.setItem('silentsuite-signup-email-proof', JSON.stringify({
      [requestId]: { email: 'retry@example.test', requestId, wantsProductUpdates: false, rememberDevice: false, returnTo: null, expiresAt: Date.now() + 60_000 },
    }))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/consume')) return new Response(JSON.stringify({ contractVersion: 2, emailOwnershipToken: ownershipToken, expiresAt: '2099-01-01T00:00:00Z' }))
      if (String(input).endsWith('/activate')) return new Response(JSON.stringify({ contractVersion: 2, checkoutIntentToken: signedCheckoutIntent, expiresAt: '2099-01-01T00:00:00Z', disclosure: noCardDisclosure }))
      return new Response(JSON.stringify(offer))
    }))
    authState.provisionAnnualNoCard.mockRejectedValueOnce(new Error('Could not start your trial. Please retry.')).mockResolvedValue(undefined)
    window.history.replaceState({}, '', `/signup?token=link-token&request_id=${requestId}`)
    render(<SignupPage />)
    await screen.findByRole('heading', { name: 'Choose your password' })
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'ValidPass1' } })
    expect(screen.queryByLabelText(/confirm password/i)).not.toBeInTheDocument()
    const next = screen.getByRole('button', { name: /continue to trial options/i })
    await waitFor(() => expect(next).toBeEnabled())
    fireEvent.click(next)
    await screen.findByRole('heading', { name: /choose your plan/i })
    await traverseHistory('back')
    await screen.findByRole('heading', { name: 'Choose your password' })
    await traverseHistory('forward')
    await screen.findByRole('heading', { name: /choose your plan/i })
    expect(authState.createEtebaseAccount).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /back/i }))
    expect(await screen.findByRole('heading', { name: 'Choose your password' })).toBeInTheDocument()
    expect(screen.getByLabelText(/^password$/i)).toHaveValue('ValidPass1')
    fireEvent.click(screen.getByRole('button', { name: /continue to trial options/i }))
    await chooseFreeTrial()
    expect(authState.createEtebaseAccount).not.toHaveBeenCalled()
    await traverseHistory('back')
    expect(await screen.findByRole('alert')).toHaveTextContent('Cancellation is not confirmed')
    fireEvent.click(screen.getByRole('button', { name: 'Continue current selection' }))
    fireEvent.click(await acknowledgePasswordKey())
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not start your trial. Please retry.')
    expect(screen.queryByText('Not applicable')).not.toBeInTheDocument()
    expect(screen.getByText(/No card required. No automatic charge or renewal/)).toBeInTheDocument()
    // The failed attempt stays on the same acknowledgement panel with the box still ticked.
    expect(screen.getByRole('checkbox', { name: /cannot recover my password/i })).toBeChecked()
    expect(screen.getByRole('heading', { name: 'Your password is your only key' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Cancellation is not confirmed')
    fireEvent.click(screen.getByRole('button', { name: 'Continue current selection' }))
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/activate'))).toHaveLength(1)
    const leave = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(leave)
    expect(leave.defaultPrevented).toBe(true)
    act(() => window.dispatchEvent(new PopStateEvent('popstate')))
    expect(screen.getByRole('status')).toHaveTextContent('Finish or recover your current setup')
    await screen.findByRole('button', { name: 'Continue current selection' })
    fireEvent.click(screen.getByRole('button', { name: 'Continue current selection' }))
    expect(authState.provisionAnnualNoCard).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(window.history.state)).not.toContain('ValidPass1')
    expect(JSON.stringify(sessionStorage)).not.toContain('ValidPass1')
    let finish!: () => void
    authState.provisionAnnualNoCard.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const retry = await acknowledgePasswordKey()
    act(() => { fireEvent.click(retry); fireEvent.click(retry) })
    await waitFor(() => expect(authState.provisionAnnualNoCard).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: /^back$/i })).toBeDisabled()
    await act(async () => finish())
    const completedLeave = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(completedLeave)
    expect(completedLeave.defaultPrevented).toBe(false)
  })

  it('retries an offer failure without consuming the email link again', async () => {
    localStorage.setItem('silentsuite-signup-email-proof', JSON.stringify({
      [requestId]: { email: 'retry@example.test', requestId, wantsProductUpdates: false, rememberDevice: false,
        returnTo: null, expiresAt: Date.now() + 60_000 },
    }))
    let consumptions = 0
    let offers = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/consume')) {
        consumptions += 1
        if (consumptions > 1) return new Response('{}', { status: 400 })
        return new Response(JSON.stringify({ contractVersion: 2, emailOwnershipToken: ownershipToken,
          expiresAt: new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z') }))
      }
      if (String(input).endsWith('/auth/offers/v2')) {
        offers += 1
        return offers === 1 ? new Response('{}', { status: 503 }) : new Response(JSON.stringify(offer))
      }
      throw new Error('Unexpected request')
    }))
    window.history.replaceState({}, '', `/signup?token=link-token&request_id=${requestId}`)
    render(<StrictMode><SignupPage /></StrictMode>)

    fireEvent.click(await screen.findByRole('button', { name: 'Retry loading trial options' }))
    expect(await screen.findByRole('heading', { name: 'Choose your password' })).toBeInTheDocument()
    expect(consumptions).toBe(1)
    expect(offers).toBe(2)
    expect(window.location.search).not.toContain('link-token')
    expect(JSON.stringify(localStorage)).not.toContain(ownershipToken)
    expect(JSON.stringify(sessionStorage)).not.toContain(ownershipToken)
  })

  it.each(['expired', 'lost-response'])('requests a fresh lineage after %s without consuming the old link again', async (failure) => {
    localStorage.setItem('silentsuite-signup-email-proof', JSON.stringify({
      [requestId]: { email: 'retry@example.test', requestId, wantsProductUpdates: true, rememberDevice: false,
        returnTo: 'silentsuite://signup-complete', expiresAt: Date.now() + 60_000 },
    }))
    let consumptions = 0
    const requests: { email: string; requestId: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/consume')) {
        consumptions += 1
        if (failure === 'lost-response') throw new TypeError('Network failed after commit')
        return new Response('{}', { status: 400 })
      }
      if (String(input).endsWith('/auth/signup-email-verifications/v2')) {
        requests.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify({ accepted: true }), { status: 202 })
      }
      throw new Error('Unexpected request')
    }))
    window.history.replaceState({}, '', `/signup?token=link-token&request_id=${requestId}`)
    render(<StrictMode><SignupPage /></StrictMode>)
    fireEvent.click(await screen.findByRole('button', { name: 'Request a new verification email' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Check your email'))
    expect(consumptions).toBe(1)
    expect(requests).toHaveLength(1)
    expect(requests[0].email).toBe('retry@example.test')
    expect(requests[0].requestId).not.toBe(requestId)
    const stored = JSON.parse(localStorage.getItem('silentsuite-signup-email-proof') ?? '{}')
    expect(stored).not.toHaveProperty(requestId)
    expect(stored[requests[0].requestId]).toMatchObject({ wantsProductUpdates: true, rememberDevice: false, returnTo: 'silentsuite://signup-complete' })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(window.location.search).not.toContain('link-token')
    expect(authState.createEtebaseAccount).not.toHaveBeenCalled()
    expect(authState.startAnnualSignupPayment).not.toHaveBeenCalled()
  })

  it('does not publish a continuation after the page unmounts', async () => {
    localStorage.setItem('silentsuite-signup-email-proof', JSON.stringify({
      [requestId]: { email: 'retry@example.test', requestId, wantsProductUpdates: false, rememberDevice: false,
        returnTo: null, expiresAt: Date.now() + 60_000 },
    }))
    let resolveOffer!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/consume')) return new Response(JSON.stringify({
        contractVersion: 2, emailOwnershipToken: ownershipToken, expiresAt: '2099-01-01T00:00:00Z',
      }))
      return new Promise<Response>((resolve) => { resolveOffer = resolve })
    }))
    window.history.replaceState({}, '', `/signup?token=link-token&request_id=${requestId}`)
    const view = render(<SignupPage />)
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(screen.queryByLabelText(/^password$/i)).not.toBeInTheDocument()
    view.unmount()
    await act(async () => { resolveOffer(new Response(JSON.stringify(offer))) })
    expect(authState.prepareSignupDraft).not.toHaveBeenCalled()
    expect(localStorage.getItem('silentsuite-signup-email-proof')).toContain(requestId)
    expect(localStorage.getItem('silentsuite-signup-email-verified')).toBeNull()
  })

  it('preserves the new non-secret lineage when a resend acknowledgement is lost', async () => {
    localStorage.setItem('silentsuite-signup-email-proof', JSON.stringify({
      [requestId]: { email: 'retry@example.test', requestId, wantsProductUpdates: false, rememberDevice: false,
        returnTo: null, expiresAt: Date.now() + 60_000 },
    }))
    let nextId = ''
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/consume')) return new Response('{}', { status: 400 })
      nextId = JSON.parse(String(init?.body)).requestId
      // The emailed link may arrive even though this response never does.
      expect(localStorage.getItem('silentsuite-signup-email-proof')).toContain(nextId)
      throw new TypeError('Acknowledgement lost')
    }))
    window.history.replaceState({}, '', `/signup?token=link-token&request_id=${requestId}`)
    render(<SignupPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Request a new verification email' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Check your inbox'))
    expect(nextId).not.toBe(requestId)
    expect(localStorage.getItem('silentsuite-signup-email-proof')).toContain(nextId)
    expect(screen.getByRole('button', { name: 'Request a new verification email' })).toBeEnabled()
    expect(authState.createEtebaseAccount).not.toHaveBeenCalled()
  })

  it.each(['/signup', '/signup/verify-email'])('completes the verified lineage through %s without persisting a password', async (callbackPath) => {
    localStorage.setItem('silentsuite-signup-email-proof', JSON.stringify({
      [requestId]: { email: 'customer@example.test', requestId, wantsProductUpdates: true, rememberDevice: false,
        returnTo: 'silentsuite://signup-complete', expiresAt: Date.now() + 60_000 },
    }))
    expect(localStorage.getItem('silentsuite-signup-email-proof')).not.toContain('password')
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/auth/signup-email-verifications/v2/consume')) {
        return new Response(JSON.stringify({ contractVersion: 2, emailOwnershipToken: ownershipToken, expiresAt: '2026-08-11T12:05:00Z' }))
      }
      if (url.endsWith('/auth/offers/v2')) return new Response(JSON.stringify(offer))
      if (url.endsWith('/auth/offers/v2/activate')) {
        return new Response(JSON.stringify({ contractVersion: 2, checkoutIntentToken: signedCheckoutIntent, expiresAt: new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'), disclosure: noCardDisclosure }))
      }
      return new Response('{}', { status: 404 })
    }))

    const firstMount = render(<SignupPage />)
    firstMount.unmount()
    window.history.replaceState({}, '', `${callbackPath}?token=link-token&request_id=${requestId}`)
    const Page = callbackPath === '/signup' ? SignupPage : VerificationCallbackPage
    render(<Page />)

    expect(await screen.findByRole('heading', { name: 'Choose your password' })).toBeInTheDocument()
    const marker = JSON.parse(localStorage.getItem('silentsuite-signup-email-verified')!)
    expect(marker).toEqual({ requestId, verifiedAt: expect.any(Number), expiresAt: expect.any(Number) })
    expect(JSON.stringify(marker)).not.toMatch(/customer@example|link-token|password|emailOwnershipToken/i)
    expect(screen.queryByText(/Email confirmed/)).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'ValidPass1' } })
    expect(screen.queryByLabelText(/confirm password/i)).not.toBeInTheDocument()
    const continuation = screen.getByRole('button', { name: /continue to trial options/i })
    await waitFor(() => expect(continuation).toBeEnabled())
    fireEvent.click(continuation)
    expect(await screen.findByRole('heading', { name: /choose your plan/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /7 day free trial/i }))
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }))
    fireEvent.click(await acknowledgePasswordKey())

    await waitFor(() => expect(authState.provisionAnnualNoCard).toHaveBeenCalledWith(signedCheckoutIntent))
    expect(authState.createEtebaseAccount).toHaveBeenCalledWith('customer@example.test', 'ValidPass1', undefined)
    expect(window.location.search).toContain('return_to=silentsuite')
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(localStorage.getItem('silentsuite-signup-email-proof') ?? '').not.toContain('ValidPass1')
  })

  it('continues in a browsing context that never held the signup tab, without a prior mount', async () => {
    // A link clicked in a mail client opens a fresh browsing context: no
    // sessionStorage, and no earlier mount of this page to have written any.
    localStorage.setItem('silentsuite-signup-email-proof', JSON.stringify({
      email: 'newtab@example.test', requestId, wantsProductUpdates: true, rememberDevice: false, returnTo: null, expiresAt: Date.now() + 60_000,
    }))
    sessionStorage.clear()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/auth/signup-email-verifications/v2/consume')) {
        return new Response(JSON.stringify({ contractVersion: 2, emailOwnershipToken: ownershipToken, expiresAt: '2026-08-11T12:05:00Z' }))
      }
      if (url.endsWith('/auth/offers/v2')) return new Response(JSON.stringify(offer))
      if (url.endsWith('/auth/offers/v2/activate')) {
        return new Response(JSON.stringify({ contractVersion: 2, checkoutIntentToken: signedCheckoutIntent, expiresAt: new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'), disclosure: noCardDisclosure }))
      }
      return new Response('{}', { status: 404 })
    }))

    window.history.replaceState({}, '', '/signup?email_verification_token=link-token')
    render(<SignupPage />)

    expect(await screen.findByRole('heading', { name: 'Choose your password' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'ValidPass1' } })
    expect(screen.queryByLabelText(/confirm password/i)).not.toBeInTheDocument()
    const continuation = screen.getByRole('button', { name: /continue to trial options/i })
    await waitFor(() => expect(continuation).toBeEnabled())
    fireEvent.click(continuation)
    expect(await screen.findByRole('heading', { name: /choose your plan/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /7 day free trial/i }))
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }))
    fireEvent.click(await acknowledgePasswordKey())

    await waitFor(() => expect(authState.provisionAnnualNoCard).toHaveBeenCalledWith(signedCheckoutIntent))
    expect(authState.createEtebaseAccount).toHaveBeenCalledWith('newtab@example.test', 'ValidPass1', undefined)
    // The consumed continuation must not outlive the funnel it authorized.
    expect(localStorage.getItem('silentsuite-signup-email-proof')).toBeNull()
  })

  it('leaves all continuation lineages intact when a verification URL lacks a request id', async () => {
    const otherRequestId = '7823121e-8f4a-45ac-a217-82ba93209ca2'
    localStorage.setItem('silentsuite-signup-email-proof', JSON.stringify({
      [requestId]: { email: 'first@example.test', requestId, wantsProductUpdates: true, rememberDevice: false, returnTo: null, expiresAt: Date.now() + 60_000 },
      [otherRequestId]: { email: 'other@example.test', requestId: otherRequestId, wantsProductUpdates: false, rememberDevice: false, returnTo: null, expiresAt: Date.now() + 60_000 },
    }))
    vi.stubGlobal('fetch', vi.fn())
    window.history.replaceState({}, '', '/signup?email_verification_token=link-token')

    render(<SignupPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent(/verification link/i)
    expect(fetch).not.toHaveBeenCalled()
    expect(Object.keys(JSON.parse(localStorage.getItem('silentsuite-signup-email-proof') ?? '{}'))).toEqual(expect.arrayContaining([requestId, otherRequestId]))
  })

  it('rejects a non-expiring continuation without deleting another request lineage', async () => {
    const otherRequestId = '7823121e-8f4a-45ac-a217-82ba93209ca2'
    localStorage.setItem('silentsuite-signup-email-proof', JSON.stringify({
      [requestId]: { email: 'newtab@example.test', requestId, wantsProductUpdates: true, rememberDevice: false, returnTo: null },
      [otherRequestId]: { email: 'other@example.test', requestId: otherRequestId, wantsProductUpdates: false, rememberDevice: false, returnTo: null, expiresAt: Date.now() + 60_000 },
    }))
    vi.stubGlobal('fetch', vi.fn())
    window.history.replaceState({}, '', `/signup?email_verification_token=link-token&request_id=${requestId}`)

    render(<SignupPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent(/verification link/i)
    expect(fetch).not.toHaveBeenCalled()
    const remainingContexts = JSON.parse(localStorage.getItem('silentsuite-signup-email-proof') ?? '{}')
    expect(remainingContexts).not.toHaveProperty(requestId)
    expect(remainingContexts).toHaveProperty(otherRequestId)
  })

  it('surfaces a recovery path instead of dead-ending when no signup draft backs the link', async () => {
    localStorage.clear()
    sessionStorage.clear()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))

    window.history.replaceState({}, '', '/signup?email_verification_token=link-token')
    render(<SignupPage />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/verification link/i)
    expect(alert).toHaveTextContent(/request a new/i)
    // No email is known here, so the token must not be spent guessing one.
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('/consume'))).toBe(false)
    // The account form stays available as the recovery path.
    expect(screen.queryByLabelText(/^password$/i)).not.toBeInTheDocument()
    // A spent-looking token must not linger in the address bar or in history.
    expect(window.location.search).not.toContain('link-token')
  })

  it('presents a standard signed offer as €48/year (€4/month) and only starts Stripe', async () => {
    const standardOffer = {
      ...offer,
      offer: {
        ...offer.offer,
        planId: 'standard_annual',
        customerClass: 'standard',
        annualAmountMinor: 4800,
        monthlyEquivalentMinor: 400,
        providers: ['stripe'],
      },
    }
    const standardDisclosure = {
      ...noCardDisclosure,
      annualAmountMinor: 4800,
      monthlyEquivalentMinor: 400,
    }
    authState.startAnnualSignupPayment.mockResolvedValue({ clientSecret: 'seti_standard' })
    localStorage.setItem('silentsuite-signup-email-proof', JSON.stringify({
      email: 'standard@example.test', requestId, wantsProductUpdates: false, rememberDevice: false, returnTo: null, expiresAt: Date.now() + 60_000,
    }))
    window.history.replaceState({}, '', '/signup')
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/auth/signup-email-verifications/v2/consume')) {
        return new Response(JSON.stringify({ contractVersion: 2, emailOwnershipToken: ownershipToken, expiresAt: '2026-08-11T12:05:00Z' }))
      }
      if (url.endsWith('/auth/offers/v2')) return new Response(JSON.stringify(standardOffer))
      if (url.endsWith('/auth/offers/v2/activate')) {
        return new Response(JSON.stringify({
          contractVersion: 2, checkoutIntentToken: signedCheckoutIntent, expiresAt: new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
          disclosure: { ...standardDisclosure, kind: 'card_trial', firstChargeAmountMinor: 4800, renewalAmountMinor: 4800, trialEndsAt: '2026-09-10T12:00:00Z', firstChargeAt: '2026-09-10T12:00:00Z', cancelBy: '2026-09-10T12:00:00Z', autoRenew: true, refundWindowDays: 30, periodEndRule: 'first_charge_plus_1_utc_calendar_year', renewalAt: '2027-09-10T12:00:00Z', entitlementEndsAt: '2027-09-10T12:00:00Z' },
        }))
      }
      return new Response('{}', { status: 404 })
    }))

    const firstMount = render(<SignupPage />)
    firstMount.unmount()
    window.history.replaceState({}, '', '/signup?email_verification_token=link-token')
    render(<SignupPage />)
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      'https://billing.test/auth/offers/v2',
      expect.objectContaining({ method: 'POST' }),
    ))
    expect(await screen.findByRole('heading', { name: 'Choose your password' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'ValidPass1' } })
    expect(screen.queryByLabelText(/confirm password/i)).not.toBeInTheDocument()
    const continuation = await screen.findByRole('button', { name: /continue to trial options/i })
    await waitFor(() => expect(continuation).toBeEnabled())
    fireEvent.click(continuation)

    expect(await screen.findByText('Standard Plan')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /30-day free trial/i })).toBeInTheDocument()
    expect(screen.queryByText(/€48|\/year|\/month/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Early Adopter/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/€36/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }))

    await screen.findByRole('heading', { name: 'Choose how to pay' })
    // No repeated plan/price bar; the signed plan and price remain on the choice itself.
    expect(screen.queryByText('Standard Plan')).not.toBeInTheDocument()
    expect(screen.queryByText(/BTCPay/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /bitcoin/i })).not.toBeInTheDocument()
    expect(screen.queryByText('€48.00/year')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /pay by card for standard plan, €48\.00\/year/i }))

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      'https://billing.test/auth/offers/v2/activate',
      expect.objectContaining({ body: expect.stringContaining('"provider":"stripe"') }),
    ))
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => String((init as RequestInit | undefined)?.body).includes('"provider":"btcpay"'))).toBe(false)
    await waitFor(() => expect(authState.startAnnualSignupPayment).toHaveBeenCalledWith(
      signedCheckoutIntent,
      'stripe',
      'http://localhost:3000/signup',
      'annual',
    ))
    expect(await screen.findByText('Add your payment method')).toBeInTheDocument()
    expect(screen.queryByText('Review your free trial')).not.toBeInTheDocument()
    expect(screen.getByText(/€0 today/)).toHaveTextContent('€48.00 on 2026-09-10 12:00 UTC')
    expect(screen.getByText(/Auto-renews/)).toHaveTextContent('€48.00')
    // The commitment disclosure beside the card form is the only price statement here.
    expect(screen.queryByText('Standard Plan')).not.toBeInTheDocument()
    expect(screen.getAllByText(/€48\.00\/year/)).toHaveLength(1)
  })

  it('replaces an expired no-card offer with renewed Standard terms and requires consent again', async () => {
    const standardOffer = {
      ...offer,
      offer: {
        ...offer.offer,
        planId: 'standard_annual',
        customerClass: 'standard',
        annualAmountMinor: 4800,
        monthlyEquivalentMinor: 400,
        providers: ['stripe'],
        offerRevision: 2,
        offerToken: 'renewed-standard-offer',
      },
    }
    let offerReads = 0
    let activations = 0
    localStorage.setItem('silentsuite-signup-email-proof', JSON.stringify({
      email: 'renew@example.test', requestId, wantsProductUpdates: false, rememberDevice: false, returnTo: null, expiresAt: Date.now() + 60_000,
    }))
    window.history.replaceState({}, '', '/signup?email_verification_token=link-token')
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/auth/signup-email-verifications/v2/consume')) {
        return new Response(JSON.stringify({ contractVersion: 2, emailOwnershipToken: ownershipToken, expiresAt: '2026-08-11T12:05:00Z' }))
      }
      if (url.endsWith('/auth/offers/v2')) {
        offerReads += 1
        return new Response(JSON.stringify(offerReads === 1 ? offer : standardOffer))
      }
      if (url.endsWith('/auth/offers/v2/activate')) {
        activations += 1
        if (activations === 1) {
          return new Response(JSON.stringify({
            type: 'https://api.silentsuite.io/errors/plan-not-purchasable',
            detail: 'The selected annual checkout is unavailable.',
          }), { status: 409 })
        }
        return new Response(JSON.stringify({ contractVersion: 2, checkoutIntentToken: signedCheckoutIntent, expiresAt: new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'), disclosure: { ...noCardDisclosure, annualAmountMinor: 4800, monthlyEquivalentMinor: 400 } }))
      }
      return new Response('{}', { status: 404 })
    }))

    window.history.replaceState({}, '', '/signup')
    const initialMount = render(<SignupPage />)
    initialMount.unmount()
    window.history.replaceState({}, '', '/signup?email_verification_token=link-token')
    render(<SignupPage />)
    expect(await screen.findByRole('heading', { name: 'Choose your password' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'ValidPass1' } })
    expect(screen.queryByLabelText(/confirm password/i)).not.toBeInTheDocument()
    const continuation = await screen.findByRole('button', { name: /continue to trial options/i })
    await waitFor(() => expect(continuation).toBeEnabled())
    fireEvent.click(continuation)
    fireEvent.click(await screen.findByRole('button', { name: /7 day free trial/i }))
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }))

    expect(await screen.findByText(/annual terms changed/i)).toBeInTheDocument()
    expect(screen.getByText('Standard Plan')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /30-day free trial/i })).toBeInTheDocument()
    expect(screen.queryByText(/€48|€36/)).not.toBeInTheDocument()
    expect(authState.createEtebaseAccount).not.toHaveBeenCalled()
    expect(authState.provisionAnnualNoCard).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /7 day free trial/i }))
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }))
    fireEvent.click(await acknowledgePasswordKey())
    await waitFor(() => expect(authState.provisionAnnualNoCard).toHaveBeenCalledWith(signedCheckoutIntent))
    expect(authState.createEtebaseAccount).toHaveBeenCalledWith('renew@example.test', 'ValidPass1', undefined)
  })

  it.each([
    ['card', /pay by card for early adopter plan, €36\.00\/year/i],
    ['bitcoin', /pay €36\.00 with bitcoin for early adopter plan/i],
  ] as const)('returns expired signup %s selection to renewed consent without starting payment', async (_kind, paymentAction) => {
    const standardOffer = {
      ...offer,
      offer: {
        ...offer.offer,
        planId: 'standard_annual',
        customerClass: 'standard',
        annualAmountMinor: 4800,
        monthlyEquivalentMinor: 400,
        providers: ['stripe'],
        offerRevision: 2,
        offerToken: 'renewed-standard-offer',
      },
    }
    let offerReads = 0
    localStorage.setItem('silentsuite-signup-email-proof', JSON.stringify({
      email: 'paid-renew@example.test', requestId, wantsProductUpdates: false, rememberDevice: false, returnTo: null, expiresAt: Date.now() + 60_000,
    }))
    window.history.replaceState({}, '', '/signup')
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/auth/signup-email-verifications/v2/consume')) {
        return new Response(JSON.stringify({ contractVersion: 2, emailOwnershipToken: ownershipToken, expiresAt: '2026-08-11T12:05:00Z' }))
      }
      if (url.endsWith('/auth/offers/v2')) {
        offerReads += 1
        return new Response(JSON.stringify(offerReads === 1 ? offer : standardOffer))
      }
      if (url.endsWith('/auth/offers/v2/activate')) {
        return new Response(JSON.stringify({
          type: 'https://api.silentsuite.io/errors/plan-not-purchasable',
          detail: 'The selected annual checkout is unavailable.',
        }), { status: 409 })
      }
      return new Response('{}', { status: 404 })
    }))

    const initialMount = render(<SignupPage />)
    initialMount.unmount()
    window.history.replaceState({}, '', '/signup?email_verification_token=link-token')
    render(<SignupPage />)
    expect(await screen.findByRole('heading', { name: 'Choose your password' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'ValidPass1' } })
    expect(screen.queryByLabelText(/confirm password/i)).not.toBeInTheDocument()
    const continuation = screen.getByRole('button', { name: /continue to trial options/i })
    await waitFor(() => expect(continuation).toBeEnabled())
    fireEvent.click(continuation)
    await screen.findByRole('heading', { name: /choose your plan/i })
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }))
    fireEvent.click(await screen.findByRole('button', { name: paymentAction }))

    expect(await screen.findByText(/annual terms changed/i)).toBeInTheDocument()
    expect(screen.getByText('Standard Plan')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /bitcoin/i })).not.toBeInTheDocument()
    expect(authState.startAnnualSignupPayment).not.toHaveBeenCalled()
  })
})
