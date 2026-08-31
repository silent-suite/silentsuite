import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SignupPage from '../page'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_BTCPAY_CHECKOUT_ENABLED = 'true'
})

const requestId = 'e91a6d70-0d4e-4352-9bdc-426d1f76d771'
const ownershipToken = 'A'.repeat(43)
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
    sessionStorage.clear()
    localStorage.clear()
    window.history.replaceState({}, '', '/signup')
  })

  it('survives a full navigation without persisting a password and completes the verified lineage', async () => {
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
        return new Response(JSON.stringify({ contractVersion: 2, checkoutIntentToken: ownershipToken, expiresAt: '2026-08-11T12:05:00Z', disclosure: noCardDisclosure }))
      }
      return new Response('{}', { status: 404 })
    }))

    const firstMount = render(<SignupPage />)
    firstMount.unmount()
    window.history.replaceState({}, '', `/signup?email_verification_token=link-token&request_id=${requestId}`)
    render(<SignupPage />)

    expect(await screen.findByRole('heading', { name: 'Re-enter your account details' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'ValidPass1' } })
    fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'ValidPass1' } })
    const continuation = screen.getByRole('button', { name: /continue to trial options/i })
    await waitFor(() => expect(continuation).toBeEnabled())
    fireEvent.click(continuation)
    expect(await screen.findByRole('heading', { name: /choose your plan/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /7 day free trial/i }))
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /confirm annual terms and continue/i }))

    await waitFor(() => expect(authState.provisionAnnualNoCard).toHaveBeenCalledWith(ownershipToken))
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
        return new Response(JSON.stringify({ contractVersion: 2, checkoutIntentToken: ownershipToken, expiresAt: '2026-08-11T12:05:00Z', disclosure: noCardDisclosure }))
      }
      return new Response('{}', { status: 404 })
    }))

    window.history.replaceState({}, '', '/signup?email_verification_token=link-token')
    render(<SignupPage />)

    expect(await screen.findByRole('heading', { name: 'Re-enter your account details' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'ValidPass1' } })
    fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'ValidPass1' } })
    const continuation = screen.getByRole('button', { name: /continue to trial options/i })
    await waitFor(() => expect(continuation).toBeEnabled())
    fireEvent.click(continuation)
    expect(await screen.findByRole('heading', { name: /choose your plan/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /7 day free trial/i }))
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /confirm annual terms and continue/i }))

    await waitFor(() => expect(authState.provisionAnnualNoCard).toHaveBeenCalledWith(ownershipToken))
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
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument()
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
          contractVersion: 2, checkoutIntentToken: ownershipToken, expiresAt: '2026-08-11T12:05:00Z',
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
    expect(await screen.findByRole('heading', { name: 'Re-enter your account details' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'ValidPass1' } })
    fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'ValidPass1' } })
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
    expect(screen.getAllByText('2027-09-10 12:00 UTC')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: /confirm annual terms and continue/i }))
    await waitFor(() => expect(authState.startAnnualSignupPayment).toHaveBeenCalledWith(
      ownershipToken,
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
        return new Response(JSON.stringify({ contractVersion: 2, checkoutIntentToken: ownershipToken, expiresAt: '2026-08-11T12:05:00Z', disclosure: { ...noCardDisclosure, annualAmountMinor: 4800, monthlyEquivalentMinor: 400 } }))
      }
      return new Response('{}', { status: 404 })
    }))

    window.history.replaceState({}, '', '/signup')
    const initialMount = render(<SignupPage />)
    initialMount.unmount()
    window.history.replaceState({}, '', '/signup?email_verification_token=link-token')
    render(<SignupPage />)
    expect(await screen.findByRole('heading', { name: 'Re-enter your account details' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'ValidPass1' } })
    fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'ValidPass1' } })
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
    fireEvent.click(await screen.findByRole('button', { name: /confirm annual terms and continue/i }))
    await waitFor(() => expect(authState.provisionAnnualNoCard).toHaveBeenCalledWith(ownershipToken))
    expect(authState.createEtebaseAccount).toHaveBeenCalledWith('renew@example.test', 'ValidPass1', undefined)
  })

  it.each([
    ['card', /continue to card payment for early adopter plan, €36\.00\/year/i],
    ['bitcoin', /pay €36\.00\/year with bitcoin, lightning or monero for early adopter plan/i],
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
    expect(await screen.findByRole('heading', { name: 'Re-enter your account details' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'ValidPass1' } })
    fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'ValidPass1' } })
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
