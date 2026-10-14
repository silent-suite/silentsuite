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
  ArrowLeft: () => <svg />,
  ExternalLink: () => <svg />,
  Crown: () => <svg />,
  Lock: () => <svg />,
  Zap: () => <svg />,
}))

vi.mock('@/app/lib/config', () => ({
  BILLING_API_URL: 'https://billing.example.test',
  ETEBASE_SERVER_URL: 'https://server.example.test',
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
    const authorityId = '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607'
    let resumed = false
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === '/subscription/payment-flows/current') return response({ flow: { ...bitcoinFlow('https://btcpay.test/i/abc123'),
        authorityId, disclosure: previewOffer.accountDisclosures.btcpay } })
      if (url.pathname === '/subscription/offers/v2') return response(previewOffer)
      if (url.pathname === '/subscription/payment-flows/v2/resume') {
        expect(JSON.parse(String(init?.body))).toEqual({ contractVersion: 2, authorityId })
        resumed = true
        return response({ contractVersion: 2, kind: 'btcpay', authorityId, checkoutUrl: 'https://btcpay.test/i/abc123',
          invoiceId: 'invoice-1', invoiceLookupToken: 'retained-lookup-token', disclosure: previewOffer.accountDisclosures.btcpay })
      }
      if (url.pathname.endsWith('/payment-methods')) return response({ paymentMethods: [{ id: 'BTC-CHAIN', label: 'Bitcoin',
        qrValue: 'bitcoin:synthetic-test-address', address: 'synthetic-test-address', amountDue: '0.001', cryptoCode: 'BTC' }] })
      if (url.pathname.endsWith('/status')) return response({ status: 'New' })
      return response({}, false)
    })
    render(<PaymentChoicePanel onSuccess={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /resume cryptocurrency payment/i }))
    const link = await screen.findByRole('link', { name: /open in btcpay instead/i })
    expect(resumed).toBe(true)
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

  // A confirmed or conflicted authority is held; even
  // with a sealed disclosure and a valid retained BTCPay URL it offers neither
  // payment resumption nor the direct invoice link, only its status.
  it.each([['provider_confirmed'], ['provider_creation_conflict']])('offers no payment continuation for a held %s authority', async status => {
    const calls = mockAuthorityFlow({ ...bitcoinFlow('https://btcpay.test/i/abc123'), status, cancellable: false, authorityId: AUTHORITY_ID, disclosure: bitcoinTerms })

    expect(await screen.findByRole('button', { name: /check payment status/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /resume cryptocurrency payment/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /continue in btcpay/i })).not.toBeInTheDocument()
    expect(calls.filter(call => call.method !== 'GET')).toEqual([])
  })

  // Held, non-cancellable, not confirmed: the copy states the payment is
  // incomplete and recovery is blocked, points to the existing safe recovery
  // and to support on persistent failure, and promises no automatic checking,
  // confirmation or later cancellation. The no-crypto-sent acknowledgement is
  // shown only where cancellation is actually possible.
  it.each([['provider_creation_pending'], ['provider_creation_reconciling']])('states a blocked incomplete recovery without promises for a held %s authority', async status => {
    mockHeldFlow(status)

    expect(await screen.findByText(/payment already in progress/i)).toBeInTheDocument()
    const statement = screen.getByText(/incomplete/i)
    expect(statement.textContent).toMatch(/contact support/i)
    expect(statement.textContent).not.toMatch(/being checked|is checked|being confirmed|automatic|cannot be cancelled yet|will be cancelled/i)
    expect(screen.queryByText(/I have not sent cryptocurrency for this payment/i)).not.toBeInTheDocument()
  })

  it('keeps the no-crypto-sent acknowledgement for a cancellable Bitcoin authority', async () => {
    mockAuthorityFlow({ ...bitcoinFlow('https://btcpay.test/i/abc123'), status: 'provider_creation_reconciling', cancellable: true, authorityId: AUTHORITY_ID, disclosure: bitcoinTerms })

    expect(await screen.findByText(/I have not sent cryptocurrency for this payment/i)).toBeInTheDocument()
  })

  it('keeps the confirmation statement for a provider-confirmed flow', async () => {
    mockHeldFlow('provider_confirmed')

    expect(await screen.findByText(/already being confirmed/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel cryptocurrency payment and choose card' })).toBeDisabled()
  })

  // Requested: "Misleading Resume/confirmation controls and an unusable
  // cancellation acknowledgement." A retained URL is not live payability.
  it.each(['provider_creation_pending', 'provider_creation_reconciling', 'provider_confirmed', 'provider_creation_conflict'])('shows usable lifecycle controls without a disabled acknowledgement or stored-URL shortcut for held BTCPay %s', async status => {
    const calls = mockAuthorityFlow({ ...bitcoinFlow('https://btcpay.test/i/stored'), status, cancellable: false,
      authorityId: AUTHORITY_ID, disclosure: bitcoinTerms })
    expect(await screen.findByText('Payment already in progress')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /I have not sent cryptocurrency/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /continue in btcpay/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /resume cryptocurrency/i })).not.toBeInTheDocument()
    const check = screen.getByRole('button', { name: /check payment status/i })
    expect(check).toBeEnabled()
    expect(Boolean(screen.queryByText(/already being confirmed/i))).toBe(status === 'provider_confirmed')
    fireEvent.click(check)
    await waitFor(() => expect(calls.filter(call => call.path === '/subscription/payment-flows/current')).toHaveLength(2))
    expect(calls.filter(call => call.method !== 'GET')).toEqual([])
  })

  it.each(['provider_confirmed', 'provider_creation_conflict'])('keeps Stripe %s status-only with no payment continuation', async status => {
    const calls = mockAuthorityFlow({ flowKind: 'stripe_pay_now', provider: 'stripe', createdAt: '2026-08-10T12:00:00Z',
      status, cancellable: false, authorityId: AUTHORITY_ID, disclosure: cardTerms })
    expect(await screen.findByRole('button', { name: /check payment status/i })).toBeEnabled()
    expect(screen.queryByRole('button', { name: /resume card payment/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(Boolean(screen.queryByText(/already being confirmed/i))).toBe(status === 'provider_confirmed')
    expect(calls.filter(call => call.method !== 'GET')).toEqual([])
  })

  it('requires validated resume rather than a current-flow stored URL for a cancellable BTCPay authority', async () => {
    mockAuthorityFlow({ ...bitcoinFlow('https://btcpay.test/i/stored'), status: 'provider_creation_reconciling', cancellable: true,
      authorityId: AUTHORITY_ID, disclosure: bitcoinTerms })
    expect(await screen.findByRole('button', { name: /resume cryptocurrency/i })).toBeEnabled()
    expect(screen.queryByRole('link', { name: /continue in btcpay/i })).not.toBeInTheDocument()
  })

  it.each(['provider_creation_pending', 'provider_creation_reconciling'])('does not infer payability for unknown %s from a retained BTCPay URL', async status => {
    const calls = mockAuthorityFlow({ ...bitcoinFlow('https://btcpay.test/i/stored'), status, cancellable: false,
      authorityId: AUTHORITY_ID, disclosure: bitcoinTerms })
    expect(await screen.findByText('Payment already in progress')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /resume cryptocurrency payment/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /continue in btcpay/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /check payment status/i })).toBeEnabled()
    expect(calls.filter(call => call.method !== 'GET')).toEqual([])
  })

  it('requires a fresh authority-bound acknowledgement and successful cancel/current recheck before fresh choices', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> | null }> = []
    let currentReads = 0
    let cancelSent!: () => void
    const cancelled = new Promise<void>(resolve => { cancelSent = resolve })
    let releaseCurrent!: () => void
    const currentGate = new Promise<void>(resolve => { releaseCurrent = resolve })
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input))
      calls.push({ path: url.pathname, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null })
      if (url.pathname === '/subscription/offers/v2') return response(previewOffer)
      if (url.pathname === '/subscription/payment-flows/current') {
        currentReads++
        if (currentReads === 1) return response({ flow: { ...bitcoinFlow('https://btcpay.test/i/stored'),
          authorityId: AUTHORITY_ID, disclosure: bitcoinTerms } })
        await currentGate
        return response({ flow: null })
      }
      if (url.pathname === '/subscription/payment-flows/cancel') {
        cancelSent()
        return response({ cancelled: true, flowKind: 'btcpay_annual' })
      }
      return response({}, false)
    })
    render(<PaymentChoicePanel onSuccess={vi.fn()} />)
    const ack = await screen.findByRole('checkbox', { name: /I have not sent cryptocurrency/i })
    const cancel = screen.getByRole('button', { name: /cancel cryptocurrency payment/i })
    expect(ack).toBeEnabled()
    expect(ack).not.toBeChecked()
    expect(cancel).toBeDisabled()
    expect(calls.some(call => call.path.endsWith('/cancel'))).toBe(false)
    fireEvent.click(ack)
    expect(cancel).toBeEnabled()
    fireEvent.click(cancel)
    try {
      await cancelled
      await waitFor(() => expect(currentReads).toBe(2))
      expect(calls.find(call => call.path.endsWith('/cancel'))?.body).toEqual({ confirmNoBitcoinSent: true, expectedAuthorityId: AUTHORITY_ID })
      expect(screen.queryByRole('button', { name: /continue to card payment/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    } finally { releaseCurrent() }
    expect(await screen.findByRole('button', { name: /continue to card payment/i })).toBeEnabled()
    expect(calls.filter(call => call.path.endsWith('/cancel'))).toHaveLength(1)
    expect(calls.some(call => /activate$|payment-flows\/v2$/.test(call.path))).toBe(false)
  })

  it('recovers a retained no-dispatch Bitcoin authority through exact resume without a fresh activation', async () => {
    const mutations: Array<{ path: string; body: unknown }> = []
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname
      if (init?.method === 'POST') mutations.push({ path, body: JSON.parse(String(init.body)) })
      if (path === '/subscription/offers/v2') return response(previewOffer)
      if (path === '/subscription/payment-flows/current') return response({ flow: { ...bitcoinFlow(null),
        status: 'provider_creation_pending', cancellable: false, authorityId: AUTHORITY_ID, disclosure: bitcoinTerms } })
      if (path.endsWith('/resume')) return response({ contractVersion: 2, kind: 'btcpay', authorityId: AUTHORITY_ID,
        checkoutUrl: 'https://btcpay.test/i/recovered', invoiceId: 'recovered', invoiceLookupToken: 'retained-lookup', disclosure: bitcoinTerms })
      if (path.endsWith('/payment-methods')) return response({ paymentMethods: [] })
      return response({}, false)
    })
    render(<PaymentChoicePanel onSuccess={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /recover existing payment/i }))
    expect(await screen.findByRole('link', { name: /open in btcpay instead/i })).toHaveAttribute('href', 'https://btcpay.test/i/recovered')
    expect(mutations).toEqual([{ path: '/subscription/payment-flows/v2/resume', body: { contractVersion: 2, authorityId: AUTHORITY_ID } }])
  })
})
