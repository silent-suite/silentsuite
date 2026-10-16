import { emailOwnershipToken, checkoutIntentToken } from '@/src/__tests__/fixtures/annual-authority'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import SignupPage from '../page'
import { useAuthStore } from '@/app/stores/use-auth-store'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_BTCPAY_CHECKOUT_ENABLED = 'true'
})

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('../commercial-funnel-analytics', () => ({ CheckoutReturnAnalytics: () => null, trackCheckoutInitiated: vi.fn(), trackPlanSelected: vi.fn() }))
vi.mock('@/app/lib/secure-storage', () => ({ secureGet: vi.fn(), secureSet: vi.fn(), secureRemove: vi.fn(), secureClear: vi.fn(), migrateFromLocalStorage: vi.fn() }))

const requestId = 'e91a6d70-0d4e-4352-9bdc-426d1f76d771'
const email = 'inline-recovery@example.test'
const offer = {
  contractVersion: 2,
  requestId,
  offer: {
    planId: 'early_annual', customerClass: 'early', billingInterval: 'annual', annualAmountMinor: 3600,
    monthlyEquivalentMinor: 300, currency: 'EUR', providers: ['stripe', 'btcpay'], offerRevision: 1,
    offerToken: 'signed-offer', expiresAt: '2099-08-11T12:10:00Z',
  },
}
const prepaidDisclosure = {
  kind: 'prepaid', annualAmountMinor: 3600, firstChargeAmountMinor: 3600, renewalAmountMinor: null,
  monthlyEquivalentMinor: 300, currency: 'EUR', trialEndsAt: null, firstChargeAt: null,
  cancelBy: null, cancelByInclusive: false, autoRenew: false, prepaid: true, refundWindowDays: 30,
  bonusDays: 0, periodEndRule: 'confirmation_plus_1_utc_calendar_year', renewalAt: null, entitlementEndsAt: null,
}
const flowInProgress = {
  type: 'https://api.silentsuite.io/errors/payment-flow-in-progress', title: 'Payment flow in progress', status: 409,
  detail: 'This payment is no longer awaiting payment. Use its payment recovery for the current state.',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('scrollTo', vi.fn())
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
  sessionStorage.clear(); localStorage.clear()
  useAuthStore.setState({ pendingSignup: null, user: null, isAuthenticated: false, isLoading: false, error: null })
})

it('routes a same-attempt Bitcoin retry refused as in progress to the existing recovery without another start', async () => {
  const starts: Record<string, unknown>[] = []
  const recoveries: { url: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (url.endsWith('/consume')) return new Response(JSON.stringify({ contractVersion: 2, emailOwnershipToken, expiresAt: '2099-01-01T00:00:00Z' }))
    if (url.endsWith('/activate')) return new Response(JSON.stringify({ contractVersion: 2, checkoutIntentToken, expiresAt: '2099-01-01T00:00:00Z', disclosure: prepaidDisclosure }))
    if (url.endsWith('/auth/signup/payment-session/v2')) {
      starts.push(body)
      // The first dispatch is ambiguous; the same-attempt retry finds the invoice no longer payable.
      if (starts.length === 1) throw new TypeError('Failed to fetch')
      return new Response(JSON.stringify(flowInProgress), { status: 409, headers: { 'Content-Type': 'application/problem+json' } })
    }
    if (/\/auth\/signup\/payment-session\/v2\/(current|reconcile)$/.test(url)) {
      recoveries.push({ url, body })
      return new Response(JSON.stringify({ contractVersion: 2, state: 'open', flow: { provider: 'btcpay', status: 'provider_pending' } }))
    }
    return new Response(JSON.stringify(offer))
  }))
  localStorage.setItem('silentsuite-signup-email-proof', JSON.stringify({
    [requestId]: { email, requestId, wantsProductUpdates: false, rememberDevice: false, returnTo: null, expiresAt: Date.now() + 60_000 },
  }))
  window.history.replaceState({}, '', `/signup?token=link-token&request_id=${requestId}`)
  render(<SignupPage />)
  await screen.findByRole('heading', { name: 'Choose your password' })
  fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'ValidPass1' } })
  const next = screen.getByRole('button', { name: /continue to trial options/i })
  await waitFor(() => expect(next).toBeEnabled())
  fireEvent.click(next)
  fireEvent.click(await screen.findByRole('button', { name: /30-day free trial/i }))
  fireEvent.click(screen.getByRole('button', { name: /^continue$/i }))
  fireEvent.click(await screen.findByRole('button', { name: /^pay .* with bitcoin, lightning and monero for/i }))

  fireEvent.click(await screen.findByRole('button', { name: /^retry cryptocurrency payment$/i }))
  expect(await screen.findByText(/Use its payment recovery for the current state/)).toBeVisible()
  expect(starts).toHaveLength(2)
  expect(starts[1]).toEqual(starts[0])

  fireEvent.click(screen.getByRole('button', { name: "Check this payment's status" }))
  // The existing in-document recovery reads the same owned attempt; it starts nothing.
  await waitFor(() => expect(recoveries.length).toBeGreaterThan(0))
  expect(recoveries[0].url).toMatch(/\/current$/)
  for (const { body } of recoveries) {
    expect(body).toEqual({ contractVersion: 2, email, requestKey: starts[0].requestKey, recoverySecret: starts[0].recoverySecret, switchingProfile: 'v1' })
  }
  expect(await screen.findByRole('button', { name: 'Back' })).toBeVisible()
  expect(screen.queryByRole('button', { name: /^retry cryptocurrency payment$/i })).not.toBeInTheDocument()
  expect(starts).toHaveLength(2)
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/activate'))).toHaveLength(1)
})
