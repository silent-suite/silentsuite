import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import PaymentChoicePanel from '../payment-choice-panel'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_BTCPAY_CHECKOUT_ENABLED = 'true'
  process.env.NEXT_PUBLIC_BTCPAY_CHECKOUT_ORIGIN = 'https://btcpay.test'
})

vi.mock('next/dynamic', () => ({
  default: () => () => <div data-testid="stripe-payment-form" />,
}))

vi.mock('@silentsuite/ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}))

vi.mock('lucide-react', () => ({
  Crown: () => <svg />,
  Lock: () => <svg />,
  Zap: () => <svg />,
}))

vi.mock('@/app/lib/config', () => ({
  BILLING_API_URL: 'https://billing.example.test',
}))

const annualOffer = {
  contractVersion: 2,
  requestId: 'e91a6d70-0d4e-4352-9bdc-426d1f76d771',
  offer: {
    planId: 'early_annual',
    customerClass: 'early',
    billingInterval: 'annual',
    annualAmountMinor: 3600,
    monthlyEquivalentMinor: 300,
    currency: 'EUR',
    providers: ['stripe', 'btcpay'],
    offerRevision: 1,
    offerToken: 'signed-offer',
    expiresAt: '2026-08-10T12:10:00Z',
  },
}

function bitcoinFlow(checkoutUrl: unknown) {
  return {
    flowKind: 'btcpay_annual',
    provider: 'btcpay',
    status: 'provider_pending',
    planId: 'early_annual',
    amount: '36.00',
    currency: 'EUR',
    createdAt: '2026-08-10T12:00:00Z',
    cancellable: true,
    invoiceId: 'invoice-1',
    checkoutUrl,
  }
}

function response(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response
}

// The account panel reads the opt-in preview (`?preview=1`) carrying the exact
// signed terms per offered provider; the plain offer stays in its old shape.
const PROFILE = 'account_confirmation_rules_v1'
const cardTerms = {
  kind: 'charge_now', annualAmountMinor: 3600, firstChargeAmountMinor: 3600, renewalAmountMinor: 3600, monthlyEquivalentMinor: 300,
  currency: 'EUR', trialEndsAt: null, firstChargeAt: null, cancelBy: null, cancelByInclusive: false, autoRenew: true, prepaid: false,
  refundWindowDays: 30, bonusDays: 0, periodEndRule: PROFILE, renewalAt: null, entitlementEndsAt: null,
}
const previewOffer = {
  ...annualOffer, accountTermsProfile: PROFILE,
  accountDisclosures: { stripe: cardTerms, btcpay: { ...cardTerms, kind: 'prepaid', renewalAmountMinor: null, autoRenew: false, prepaid: true } },
}

function mockPanel(checkoutUrl: unknown) {
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname === '/subscription/payment-flows/current') return response({ flow: bitcoinFlow(checkoutUrl) })
    if (url.pathname === '/subscription/offers/v2') return response(url.searchParams.get('preview') === '1' ? previewOffer : annualOffer)
    return response({}, false)
  })
  render(<PaymentChoicePanel onSuccess={vi.fn()} onCancel={vi.fn()} />)
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PaymentChoicePanel BTCPay continuation link', () => {
  it('links to a checkout URL on the configured BTCPay origin', async () => {
    mockPanel('https://btcpay.test/i/abc123')

    const link = await screen.findByRole('link', { name: /continue in btcpay/i })
    expect(link).toHaveAttribute('href', 'https://btcpay.test/i/abc123')
  })

  it.each([
    ['malformed', 'not-a-valid-url'],
    ['non-https', 'http://btcpay.test/i/abc123'],
    ['a different origin than the configured one', 'https://btcpay.silentsuite.io/i/abc123'],
    ['an attacker-controlled origin', 'https://evil.test/i/abc123'],
    ['a non-string value', 42],
  ] as const)('degrades gracefully when the API returns %s checkout URL', async (_kind, checkoutUrl) => {
    mockPanel(checkoutUrl)

    // The surrounding flow UI must survive: an unusable URL is not a reason to
    // destroy the only cancellation control mid-payment.
    expect(await screen.findByText(/payment already in progress/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel cryptocurrency payment and choose card' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /continue in btcpay/i })).not.toBeInTheDocument()
  })
})

// A held authority whose provider outcome is still being reconciled is not a
// confirmed payment: the panel must not claim confirmation from mere
// non-cancellability. A genuinely provider-confirmed flow keeps that statement.
describe('PaymentChoicePanel non-cancellable flow statement', () => {
  function mockHeldFlow(status: string) {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === '/subscription/payment-flows/current') return response({ flow: { ...bitcoinFlow(null), status, cancellable: false } })
      if (url.pathname === '/subscription/offers/v2') return response(url.searchParams.get('preview') === '1' ? previewOffer : annualOffer)
      return response({}, false)
    })
    render(<PaymentChoicePanel onSuccess={vi.fn()} onCancel={vi.fn()} />)
  }

  it.each([
    ['provider_creation_pending'],
    ['provider_creation_reconciling'],
    ['provider_creation_conflict'],
  ])('does not claim a %s authority is already being confirmed', async status => {
    mockHeldFlow(status)

    expect(await screen.findByText(/payment already in progress/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel cryptocurrency payment and choose card' })).toBeDisabled()
    expect(screen.queryByText(/already being confirmed/i)).not.toBeInTheDocument()
  })

  // No invoice continuation is proven for an incomplete, non-cancellable
  // Bitcoin authority: the action is a status check through the existing
  // current-authority read, never a claimed payment resumption.
  const AUTHORITY_ID = '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607'
  const bitcoinTerms = previewOffer.accountDisclosures.btcpay

  function mockAuthorityFlow(flow: Record<string, unknown>) {
    const calls: Array<{ path: string; method: string }> = []
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({ path: url.pathname, method: (init?.method ?? 'GET').toUpperCase() })
      if (url.pathname === '/subscription/payment-flows/current') return response({ flow })
      if (url.pathname === '/subscription/offers/v2') return response(url.searchParams.get('preview') === '1' ? previewOffer : annualOffer)
      return response({}, false)
    })
    render(<PaymentChoicePanel onSuccess={vi.fn()} onCancel={vi.fn()} />)
    return calls
  }

  it('offers only a status check for an incomplete, non-cancellable Bitcoin authority without a proven invoice', async () => {
    const calls = mockAuthorityFlow({ ...bitcoinFlow(null), status: 'provider_creation_reconciling', cancellable: false, authorityId: AUTHORITY_ID, disclosure: bitcoinTerms })

    const check = await screen.findByRole('button', { name: /check payment status/i })
    expect(screen.queryByRole('button', { name: /resume cryptocurrency payment/i })).not.toBeInTheDocument()
    const reads = calls.filter(call => call.path === '/subscription/payment-flows/current').length
    fireEvent.click(check)

    await waitFor(() => expect(calls.filter(call => call.path === '/subscription/payment-flows/current').length).toBe(reads + 1))
    expect(calls.filter(call => call.method !== 'GET')).toEqual([])
    expect(calls.some(call => /resume|activate|payment-flows\/v2$/.test(call.path))).toBe(false)
  })

  it('keeps resumption for a cancellable Bitcoin authority with a proven invoice continuation', async () => {
    mockAuthorityFlow({ ...bitcoinFlow('https://btcpay.test/i/abc123'), status: 'provider_creation_reconciling', cancellable: true, authorityId: AUTHORITY_ID, disclosure: bitcoinTerms })

    expect(await screen.findByRole('button', { name: /resume cryptocurrency payment/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /check payment status/i })).not.toBeInTheDocument()
  })

  it('keeps the confirmation statement for a provider-confirmed flow', async () => {
    mockHeldFlow('provider_confirmed')

    expect(await screen.findByText(/already being confirmed/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel cryptocurrency payment and choose card' })).toBeDisabled()
  })
})
