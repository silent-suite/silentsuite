import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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

function mockPanel(checkoutUrl: unknown) {
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/subscription/payment-flows/current')) return response({ flow: bitcoinFlow(checkoutUrl) })
    if (url.endsWith('/subscription/offers/v2')) return response(annualOffer)
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
    expect(screen.getByRole('button', { name: 'Cancel Bitcoin payment and choose card' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /continue in btcpay/i })).not.toBeInTheDocument()
  })
})
