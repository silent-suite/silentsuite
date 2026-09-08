import { emailOwnershipToken as signedEmailProof, checkoutIntentToken as signedCheckoutIntent } from '@/src/__tests__/fixtures/annual-authority'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BillingResponseError } from '@/app/lib/billing-v2'
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
}

vi.mock('@/app/stores/use-auth-store', () => {
  function useAuthStore<T>(selector: (state: typeof authState) => T): T { return selector(authState) }
  useAuthStore.getState = () => ({ pendingSignup: { paymentSessionRequestKey: requestId } })
  useAuthStore.setState = vi.fn()
  return { useAuthStore }
})
vi.mock('@/app/stores/use-etebase-store', () => ({ normalizeServerUrl: (value: string) => value }))
vi.mock('@/app/lib/config', () => ({ BILLING_API_URL: 'https://billing.test' }))
vi.mock('@/app/lib/self-hosted', () => ({ isSelfHosted: false, isCustomServer: () => false }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }))

describe('email-link seven-day no-card continuation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authState.provisionAnnualNoCard.mockReset()
    authState.startAnnualSignupPayment.mockReset()
    vi.stubGlobal('scrollTo', vi.fn())
    sessionStorage.clear()
    localStorage.clear()
    window.history.replaceState({}, '', '/signup')
  })

  it.each(['review', 'setup', 'payment'])('recovers a refreshed %s checkpoint without replay or secrets', async (phase) => {
    vi.stubGlobal('fetch', vi.fn())
    window.history.replaceState({ silentsuiteSignup: { version: 1, journey: 'test-journey', phase, step: 'plan', view: 'confirm' } }, '', '/signup')
    render(<SignupPage />)
    expect(await screen.findByRole('heading', { name: 'Continue your signup safely' })).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
    expect(authState.createEtebaseAccount).not.toHaveBeenCalled()
    expect(authState.provisionAnnualNoCard).not.toHaveBeenCalled()
    expect(authState.startAnnualSignupPayment).not.toHaveBeenCalled()
    expect(screen.queryByLabelText(/^password$/i)).not.toBeInTheDocument()
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

  it('preserves a live review and only switches expired unclaimed terms after a successful activation', async () => {
    localStorage.setItem('silentsuite-signup-email-proof', JSON.stringify({
      [requestId]: { email: 'switch@example.test', requestId, wantsProductUpdates: false, rememberDevice: false, returnTo: null, expiresAt: Date.now() + 60_000 },
    }))
    let activations = 0
    let rejectReplacement = true
    const cardTerms = { ...noCardDisclosure, kind: 'card_trial', firstChargeAmountMinor: 3600, renewalAmountMinor: 3600, firstChargeAt: noCardDisclosure.trialEndsAt, cancelBy: noCardDisclosure.trialEndsAt, autoRenew: true, refundWindowDays: 30, periodEndRule: 'first_charge_plus_1_utc_calendar_year', renewalAt: '2099-09-10T12:00:00Z', entitlementEndsAt: '2099-09-10T12:00:00Z' }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/consume')) return new Response(JSON.stringify({ contractVersion: 2, emailOwnershipToken: ownershipToken, expiresAt: '2099-01-01T00:00:00Z' }))
      if (String(input).endsWith('/activate')) {
        activations++
        if (activations > 1 && rejectReplacement) throw new Error('Connection interrupted. Retry your selection.')
        return new Response(JSON.stringify({ contractVersion: 2, checkoutIntentToken: signedCheckoutIntent, expiresAt: '2099-01-01T00:00:00Z', disclosure: activations === 1 ? noCardDisclosure : cardTerms }))
      }
      return new Response(JSON.stringify(offer))
    }))
    window.history.replaceState({}, '', `/signup?token=link-token&request_id=${requestId}`)
    render(<SignupPage />)
    await screen.findByRole('heading', { name: 'Choose your password' })
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'ValidPass1' } })
    const next = screen.getByRole('button', { name: /continue to trial options/i })
    await waitFor(() => expect(next).toBeEnabled())
    fireEvent.click(next)
    fireEvent.click(await screen.findByRole('button', { name: /7 day free trial/i }))
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }))
    await screen.findByRole('button', { name: /create account and start free trial/i })
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
    fireEvent.click(screen.getByRole('button', { name: /30-day free trial/i }))
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /continue to card payment/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Your current option is held until')
    expect(activations).toBe(1)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2100-01-01T00:00:00Z'))
    try {
      fireEvent.click(screen.getByRole('button', { name: /continue to card payment/i }))
      expect(await screen.findByRole('alert')).toHaveTextContent('Connection interrupted')
      expect(screen.getByRole('button', { name: 'Return to current selection' })).toBeInTheDocument()
      rejectReplacement = false
      fireEvent.click(screen.getByRole('button', { name: /continue to card payment/i }))
      await screen.findByRole('heading', { name: 'Confirm annual terms' })
      expect(screen.getByText(/Add a card next. No charge today/)).toBeInTheDocument()
      expect(activations).toBe(3)
      expect(authState.createEtebaseAccount).not.toHaveBeenCalled()
      expect(authState.startAnnualSignupPayment).not.toHaveBeenCalled()
    } finally { clock.mockRestore() }
  })

  async function openConfirmation(provider: 'none' | 'stripe') {
    localStorage.setItem('silentsuite-signup-email-proof', JSON.stringify({
      [requestId]: { email: 'expiry@example.test', requestId, wantsProductUpdates: false, rememberDevice: false, returnTo: null, expiresAt: Date.now() + 60_000 },
    }))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/consume')) return new Response(JSON.stringify({ contractVersion: 2, emailOwnershipToken: ownershipToken, expiresAt: '2099-01-01T00:00:00Z' }))
      if (String(input).endsWith('/activate')) return new Response(JSON.stringify({ contractVersion: 2, checkoutIntentToken: signedCheckoutIntent, expiresAt: '2099-01-01T00:00:00Z', disclosure: provider === 'none' ? noCardDisclosure : { ...noCardDisclosure, kind: 'card_trial', firstChargeAmountMinor: 3600, renewalAmountMinor: 3600, firstChargeAt: noCardDisclosure.trialEndsAt, cancelBy: noCardDisclosure.trialEndsAt, autoRenew: true, refundWindowDays: 30, periodEndRule: 'first_charge_plus_1_utc_calendar_year', renewalAt: '2099-09-10T12:00:00Z', entitlementEndsAt: '2099-09-10T12:00:00Z' } }))
      return new Response(JSON.stringify(offer))
    }))
    window.history.replaceState({}, '', `/signup?token=link-token&request_id=${requestId}`)
    render(<SignupPage />)
    await screen.findByRole('heading', { name: 'Choose your password' })
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'ValidPass1' } })
    const next = screen.getByRole('button', { name: /continue to trial options/i })
    await waitFor(() => expect(next).toBeEnabled())
    fireEvent.click(next)
    fireEvent.click(await screen.findByRole('button', { name: provider === 'none' ? /7 day free trial/i : /30-day free trial/i }))
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }))
    if (provider === 'stripe') fireEvent.click(await screen.findByRole('button', { name: /continue to card payment/i }))
    return screen.findByRole('button', { name: /create account and start free trial|confirm annual terms and continue/i })
  }

  it.each(['none', 'stripe'] as const)('renews expired unattempted %s confirmation before any mutation and requires consent again', async (provider) => {
    const confirm = await openConfirmation(provider)
    const rejection = new BillingResponseError('Invalid request', 400, 'https://api.silentsuite.io/errors/invalid-request')
    authState.provisionAnnualNoCard.mockRejectedValue(rejection)
    authState.startAnnualSignupPayment.mockRejectedValue(rejection)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2100-01-01T00:00:00Z'))
    try {
      fireEvent.click(confirm)
      expect(await screen.findByRole('alert')).toHaveTextContent(/review.*choose.*again/i)
      expect(authState.createEtebaseAccount).not.toHaveBeenCalled()
      expect(authState.provisionAnnualNoCard).not.toHaveBeenCalled()
      expect(authState.startAnnualSignupPayment).not.toHaveBeenCalled()
      clock.mockRestore()
      fireEvent.click(screen.getByRole('button', { name: /7 day free trial/i }))
      fireEvent.click(screen.getByRole('button', { name: /^continue$/i }))
      await screen.findByRole('button', { name: /create account and start free trial/i })
      expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/activate'))).toHaveLength(2)
      expect(authState.createEtebaseAccount).not.toHaveBeenCalled()
    } finally { clock.mockRestore() }
  })

  it.each(['none', 'stripe'] as const)('retains ambiguous 400 after a %s attempt even when its terms expire', async (provider) => {
    const confirm = await openConfirmation(provider)
    const rejection = new BillingResponseError('Invalid request', 400, 'https://api.silentsuite.io/errors/invalid-request')
    authState.provisionAnnualNoCard.mockRejectedValue(rejection)
    authState.startAnnualSignupPayment.mockRejectedValue(rejection)
    fireEvent.click(confirm)
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid request')
    expect(authState.createEtebaseAccount).toHaveBeenCalledTimes(provider === 'none' ? 1 : 0)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2100-01-01T00:00:00Z'))
    try {
      fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
      if (provider === 'stripe') fireEvent.click(screen.getByRole('button', { name: 'Back to plan selection', exact: true }))
      fireEvent.click(screen.getByRole('button', { name: provider === 'none' ? /30-day free trial/i : /7 day free trial/i }))
      fireEvent.click(screen.getByRole('button', { name: /^continue$/i }))
      if (provider === 'none') fireEvent.click(await screen.findByRole('button', { name: /continue to card payment/i }))
      expect(await screen.findByRole('alert')).toHaveTextContent('Setup may have started')
      expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/activate'))).toHaveLength(1)
    } finally { clock.mockRestore() }
  })

  it('fails navigation-marker quota before mutation, permits account edits, and retries after storage recovery', async () => {
    const confirm = await openConfirmation('none')
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
      fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
      fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
      await screen.findByRole('heading', { name: 'Choose your password' })
      expect(screen.getByLabelText(/^password$/i)).toHaveValue('ValidPass1')
      expect(window.history.state.silentsuiteSignup.phase).toBe('review')
      storage.mockRestore()
      const next = screen.getByRole('button', { name: /continue to trial options/i })
      await waitFor(() => expect(next).toBeEnabled())
      fireEvent.click(next)
      fireEvent.click(await screen.findByRole('button', { name: 'Return to current selection', exact: true }))
      fireEvent.click(await screen.findByRole('button', { name: /create account and start free trial/i }))
      await waitFor(() => expect(authState.provisionAnnualNoCard).toHaveBeenCalledTimes(1))
      expect(authState.createEtebaseAccount).toHaveBeenCalledTimes(1)
    } finally { storage.mockRestore() }
  })

  it('requests hosted email verification before asking for a password', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 202 })))
    render(<SignupPage />)
    expect(screen.queryByLabelText(/^password$/i)).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: 'fresh@example.test' } })
    fireEvent.change(screen.getByLabelText(/^confirm email$/i), { target: { value: 'fresh@example.test' } })
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
    act(() => window.history.back())
    await screen.findByRole('heading', { name: 'Choose your password' })
    act(() => window.history.forward())
    await screen.findByRole('heading', { name: /choose your plan/i })
    expect(authState.createEtebaseAccount).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /back/i }))
    expect(await screen.findByRole('heading', { name: 'Choose your password' })).toBeInTheDocument()
    expect(screen.getByLabelText(/^password$/i)).toHaveValue('ValidPass1')
    fireEvent.click(screen.getByRole('button', { name: /continue to trial options/i }))
    fireEvent.click(await screen.findByRole('button', { name: /7 day free trial/i }))
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }))
    await screen.findByRole('button', { name: /create account and start free trial/i })
    act(() => window.history.back())
    await screen.findByRole('heading', { name: /choose your plan/i })
    act(() => window.history.forward())
    fireEvent.click(await screen.findByRole('button', { name: /create account and start free trial/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not start your trial. Please retry.')
    expect(screen.queryByText('Not applicable')).not.toBeInTheDocument()
    expect(screen.getByText(/No card required. No automatic charge or renewal/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
    expect(await screen.findByRole('heading', { name: /choose your plan/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }))
    await screen.findByRole('button', { name: /create account and start free trial/i })
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/activate'))).toHaveLength(1)
    const leave = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(leave)
    expect(leave.defaultPrevented).toBe(true)
    act(() => window.dispatchEvent(new PopStateEvent('popstate')))
    expect(screen.getByRole('status')).toHaveTextContent('Finish or recover your current setup')
    expect(authState.provisionAnnualNoCard).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(window.history.state)).not.toContain('ValidPass1')
    expect(JSON.stringify(sessionStorage)).not.toContain('ValidPass1')
    let finish!: () => void
    authState.provisionAnnualNoCard.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const retry = screen.getByRole('button', { name: /create account and start free trial/i })
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
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'ValidPass1' } })
    expect(screen.queryByLabelText(/confirm password/i)).not.toBeInTheDocument()
    const continuation = screen.getByRole('button', { name: /continue to trial options/i })
    await waitFor(() => expect(continuation).toBeEnabled())
    fireEvent.click(continuation)
    expect(await screen.findByRole('heading', { name: /choose your plan/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /7 day free trial/i }))
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /create account and start free trial|confirm annual terms and continue/i }))

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
    fireEvent.click(await screen.findByRole('button', { name: /create account and start free trial|confirm annual terms and continue/i }))

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

    expect(await screen.findByText('Standard Plan pricing')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /then €48\.00\/year.*€4\.00\/month/i })).toBeInTheDocument()
    expect(screen.queryByText(/Early Adopter/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/€36/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }))

    expect(await screen.findByText('Standard Plan')).toBeInTheDocument()
    expect(screen.queryByText(/BTCPay/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /bitcoin/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /continue to card payment for standard plan, €48\.00\/year/i }))

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      'https://billing.test/auth/offers/v2/activate',
      expect.objectContaining({ body: expect.stringContaining('"provider":"stripe"') }),
    ))
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => String((init as RequestInit | undefined)?.body).includes('"provider":"btcpay"'))).toBe(false)
    expect(authState.startAnnualSignupPayment).not.toHaveBeenCalled()
    expect(await screen.findByText('Confirm annual terms')).toBeInTheDocument()
    expect(screen.getAllByText('2026-09-10 12:00 UTC')).toHaveLength(2)
    expect(screen.getByText('2027-09-10 12:00 UTC')).toBeInTheDocument()
    expect(screen.getByText('€48.00/year from 2027-09-10 12:00 UTC')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /create account and start free trial|confirm annual terms and continue/i }))
    await waitFor(() => expect(authState.startAnnualSignupPayment).toHaveBeenCalledWith(
      signedCheckoutIntent,
      'stripe',
      'http://localhost:3000/signup',
    ))
    expect(await screen.findByText('Add your payment method')).toBeInTheDocument()
    expect(screen.getByText('Standard Plan')).toBeInTheDocument()
    expect(screen.getAllByText(/€48\.00\/year/)).not.toHaveLength(0)
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
    expect(screen.getByText('Standard Plan pricing')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /then €48\.00\/year.*€4\.00\/month/i })).toBeInTheDocument()
    expect(authState.createEtebaseAccount).not.toHaveBeenCalled()
    expect(authState.provisionAnnualNoCard).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /7 day free trial/i }))
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /create account and start free trial|confirm annual terms and continue/i }))
    await waitFor(() => expect(authState.provisionAnnualNoCard).toHaveBeenCalledWith(signedCheckoutIntent))
    expect(authState.createEtebaseAccount).toHaveBeenCalledWith('renew@example.test', 'ValidPass1', undefined)
  })

  it.each([
    ['card', /continue to card payment for early adopter plan, €36\.00\/year/i],
    ['bitcoin', /pay €36\.00\/year with bitcoin for early adopter plan/i],
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
    expect(screen.getByText('Standard Plan pricing')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /bitcoin/i })).not.toBeInTheDocument()
    expect(authState.startAnnualSignupPayment).not.toHaveBeenCalled()
  })
})
