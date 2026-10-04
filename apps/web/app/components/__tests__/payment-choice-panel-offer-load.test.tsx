import React from 'react'
import { checkoutIntentToken as signedCheckoutIntent } from '@/src/__tests__/fixtures/annual-authority'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import PaymentChoicePanel from '../payment-choice-panel'
import { BillingResponseError, classifyAnnualOfferLoadFailure } from '@/app/lib/billing-v2'

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
    planId: 'early_annual', customerClass: 'early', billingInterval: 'annual', annualAmountMinor: 3600,
    monthlyEquivalentMinor: 300, currency: 'EUR', providers: ['stripe', 'btcpay'], offerRevision: 1,
    offerToken: 'signed-offer', expiresAt: '2026-08-10T12:10:00Z',
  },
}

const REFUSED = 'Payment options are not available for this account state.'
const TRANSIENT = 'The current annual offer could not be loaded. Retry to review current terms before continuing.'
const LOADING = 'Loading the server-owned annual offer before payment options are shown.'

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body } as Response
}

function problem(status: number, code: string) {
  return response({ type: `https://api.silentsuite.io/errors/${code}`, title: 'Annual Billing Request Rejected', status, detail: 'No annual offer is available for this account.', instance: '/subscription/offers/v2' }, status)
}

function serve(offers: Array<() => Response | Promise<Response>>) {
  let offerCalls = 0
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/subscription/payment-flows/current')) return response({ flow: null })
    if (url.endsWith('/subscription/offers/v2')) return offers[Math.min(offerCalls++, offers.length - 1)]!()
    throw new Error(`unexpected request ${url}`)
  })
  return () => offerCalls
}

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => { vi.unstubAllGlobals() })

describe('annual offer load failure classification', () => {
  it('exports the offer failure classifier', () => {
    expect(classifyAnnualOfferLoadFailure).toBeTypeOf('function')
  })
  it.each([
    ['class refusal', new BillingResponseError('refused', 409, 'https://api.silentsuite.io/errors/plan-not-purchasable'), 'refused'],
    ['missing session', new BillingResponseError('auth', 401, 'https://api.silentsuite.io/errors/authentication-failed'), 'refused'],
    ['other conflict', new BillingResponseError('busy', 409, 'https://api.silentsuite.io/errors/payment-flow-in-progress'), 'transient'],
    ['temporary unavailability', new BillingResponseError('down', 503, 'https://api.silentsuite.io/errors/offer-unavailable'), 'transient'],
    ['rate limit', new BillingResponseError('slow', 429, null), 'transient'],
    ['network failure', new TypeError('Failed to fetch'), 'transient'],
    ['invalid payload', new Error('Billing returned an invalid annual offer.'), 'transient'],
  ] as const)('classifies %s', (_name, error, expected) => {
    expect(classifyAnnualOfferLoadFailure(error)).toBe(expected)
  })
})

describe('PaymentChoicePanel initial offer failures', () => {
  it('shows a completed refusal without loading copy, retry or payment controls', async () => {
    serve([() => problem(409, 'plan-not-purchasable')])
    render(<PaymentChoicePanel onSuccess={vi.fn()} onCancel={vi.fn()} />)
    expect((await screen.findAllByText(REFUSED)).length).toBeGreaterThan(0)
    expect(screen.queryByText(LOADING)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry current annual offer' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Continue to card payment/ })).toBeNull()
  })

  it('retries a transient failure and shows payment controls only after a valid offer', async () => {
    const calls = serve([() => { throw new TypeError('Failed to fetch') }, () => response(annualOffer)])
    render(<PaymentChoicePanel onSuccess={vi.fn()} onCancel={vi.fn()} />)
    expect(await screen.findByText(TRANSIENT)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Continue to card payment/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry current annual offer' }))
    await waitFor(() => expect(calls()).toBe(2))
    expect(await screen.findByRole('button', { name: /Continue to card payment/ })).toBeTruthy()
    expect(screen.queryByText(TRANSIENT)).toBeNull()
  })

  it('moves from temporary unavailability to a completed refusal on retry', async () => {
    serve([() => problem(503, 'offer-unavailable'), () => problem(409, 'plan-not-purchasable')])
    render(<PaymentChoicePanel onSuccess={vi.fn()} onCancel={vi.fn()} />)
    expect(await screen.findByText(TRANSIENT)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry current annual offer' }))
    expect((await screen.findAllByText(REFUSED)).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Retry current annual offer' })).toBeNull()
  })

  it('treats a missing session as a non-retry refusal', async () => {
    serve([() => problem(401, 'authentication-failed')])
    render(<PaymentChoicePanel onSuccess={vi.fn()} onCancel={vi.fn()} />)
    expect((await screen.findAllByText(REFUSED)).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Retry current annual offer' })).toBeNull()
  })

  it('keeps a newer successful retry when an older retry later refuses', async () => {
    let releaseFirst: (value: Response) => void = () => {}
    const first = new Promise<Response>(resolve => { releaseFirst = resolve })
    let offerCalls = 0
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/subscription/payment-flows/current')) return response({ flow: null })
      offerCalls += 1
      if (offerCalls === 1) throw new TypeError('Failed to fetch')
      if (offerCalls === 2) return first
      return response(annualOffer)
    })
    render(<PaymentChoicePanel onSuccess={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Retry current annual offer' }))
    await waitFor(() => expect(offerCalls).toBe(2))
    fireEvent.click(screen.getByRole('button', { name: 'Retry current annual offer' }))
    expect(await screen.findByRole('button', { name: /Continue to card payment/ })).toBeTruthy()
    await act(async () => { releaseFirst(problem(409, 'plan-not-purchasable')); await first })
    await waitFor(() => expect(offerCalls).toBe(3))
    expect(screen.queryAllByText(REFUSED)).toHaveLength(0)
    expect(screen.getByRole('button', { name: /Continue to card payment/ })).toBeTruthy()
  })

  const renewedOffer = {
    contractVersion: 2,
    requestId: '3c0b9f6e-2a41-4d7c-8e95-6b1f2a7d9c30',
    offer: {
      planId: 'standard_annual', customerClass: 'standard', billingInterval: 'annual', annualAmountMinor: 4800,
      monthlyEquivalentMinor: 400, currency: 'EUR', providers: ['stripe'], offerRevision: 1,
      offerToken: 'signed-offer-renewed', expiresAt: '2026-08-10T12:20:00Z',
    },
  }

  it.each([
    ['renewal success', 'older success', 'success', 'success'],
    ['renewal success', 'older refusal', 'success', 'refusal'],
    ['renewal refusal', 'older success', 'refusal', 'success'],
    ['renewal refusal', 'older refusal', 'refusal', 'refusal'],
  ] as const)('keeps the newest %s when a pending initial retry resolves last with an %s', async (_newest, _older, newest, older) => {
    let releaseOlder: (value: Response) => void = () => {}
    const olderRetry = new Promise<Response>(resolve => { releaseOlder = resolve })
    let offers = 0
    const activations: Array<Record<string, unknown>> = []
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/subscription/payment-flows/current')) return response({ flow: null })
      if (url.endsWith('/subscription/offers/v2/activate')) {
        activations.push(JSON.parse(String(init?.body)))
        if (activations.length === 1) return problem(409, 'plan-not-purchasable')
        return response({ contractVersion: 2, checkoutIntentToken: signedCheckoutIntent, expiresAt: '2026-08-10T12:05:00Z', disclosure: {
          kind: 'charge_now', annualAmountMinor: 4800, firstChargeAmountMinor: 4800, renewalAmountMinor: 4800,
          monthlyEquivalentMinor: 400, currency: 'EUR', trialEndsAt: null, firstChargeAt: null, cancelBy: null,
          cancelByInclusive: false, autoRenew: true, prepaid: false, refundWindowDays: 30, bonusDays: 14,
          periodEndRule: 'confirmation_bonus_then_1_utc_calendar_year', renewalAt: null, entitlementEndsAt: null,
        } })
      }
      if (url.endsWith('/subscription/offers/v2')) {
        offers += 1
        if (offers === 1) return problem(503, 'offer-unavailable')
        if (offers === 2) return olderRetry
        if (offers === 3) return response(annualOffer)
        return newest === 'success' ? response(renewedOffer) : problem(409, 'plan-not-purchasable')
      }
      throw new Error(`unexpected request ${url}`)
    })
    render(<PaymentChoicePanel onSuccess={vi.fn()} />)
    // Initial 503, then retry A stays pending while retry B succeeds.
    fireEvent.click(await screen.findByRole('button', { name: 'Retry current annual offer' }))
    await waitFor(() => expect(offers).toBe(2))
    fireEvent.click(screen.getByRole('button', { name: 'Retry current annual offer' }))
    // Real activation on B's terms is rejected, so renewal C replaces them.
    fireEvent.click(await screen.findByRole('button', { name: /Continue to card payment/ }))
    await waitFor(() => expect(offers).toBe(4))
    expect(activations[0]).toMatchObject({ offerToken: 'signed-offer', requestId: annualOffer.requestId })
    if (newest === 'success') expect(await screen.findByText(/€48\.00\/year/)).toBeTruthy()
    else expect((await screen.findAllByText(REFUSED)).length).toBeGreaterThan(0)

    // The obsolete initial retry A resolves last.
    await act(async () => { releaseOlder(older === 'success' ? response(annualOffer) : problem(409, 'plan-not-purchasable')); await olderRetry })

    if (newest === 'success') {
      expect(screen.getByText(/€48\.00\/year/)).toBeTruthy()
      expect(screen.queryByText(/€36\.00\/year/)).toBeNull()
      expect(screen.queryAllByText(REFUSED)).toHaveLength(0)
      fireEvent.click(screen.getByRole('button', { name: /Continue to card payment/ }))
      await waitFor(() => expect(activations).toHaveLength(2))
      expect(activations[1]).toMatchObject({ offerToken: 'signed-offer-renewed', requestId: renewedOffer.requestId })
    } else {
      expect(screen.queryAllByText(REFUSED).length).toBeGreaterThan(0)
      expect(screen.queryByRole('button', { name: /Continue to card payment/ })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Retry current annual offer' })).toBeNull()
      expect(screen.queryByText(/€36\.00\/year/)).toBeNull()
      expect(activations).toHaveLength(1)
    }
  })

  it('treats a malformed successful payload as transient and retryable', async () => {
    serve([() => response({ ...annualOffer, requestId: 'invalid-uuid' })])
    render(<PaymentChoicePanel onSuccess={vi.fn()} />)
    expect(await screen.findByText(TRANSIENT)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry current annual offer' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Continue to card payment/ })).toBeNull()
  })

  it('completes renewal refusal without offering Retry after activation rejects old terms', async () => {
    let offers = 0
    vi.mocked(fetch).mockImplementation(async input => {
      const url = String(input)
      if (url.endsWith('/subscription/payment-flows/current')) return response({ flow: null })
      if (url.endsWith('/subscription/offers/v2')) return ++offers === 1 ? response(annualOffer) : problem(409, 'plan-not-purchasable')
      if (url.endsWith('/subscription/offers/v2/activate')) return problem(409, 'plan-not-purchasable')
      throw new Error(`unexpected request ${url}`)
    })
    render(<PaymentChoicePanel onSuccess={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Continue to card payment/ }))
    await waitFor(() => expect(offers).toBe(2))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry current annual offer' })).toBeNull())
    expect(screen.queryByText(LOADING)).toBeNull()
    expect(screen.queryAllByText(REFUSED).length).toBeGreaterThan(0)
  })

  it('keeps current-flow recovery available when the annual offer is refused', async () => {
    vi.mocked(fetch).mockImplementation(async input => String(input).endsWith('/subscription/payment-flows/current')
      ? response({ flow: { flowKind: 'stripe_pay_now', createdAt: '2026-08-10T12:00:00Z', cancellable: true, checkoutUrl: null } })
      : problem(409, 'plan-not-purchasable'))
    render(<PaymentChoicePanel onSuccess={vi.fn()} />)
    expect(await screen.findByRole('button', { name: 'Cancel card payment' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Continue to card payment/ })).toBeNull()
  })

  it('does not render a delayed offer after unmount', async () => {
    let resolveOffer!: (response: Response) => void
    const pending = new Promise<Response>(resolve => { resolveOffer = resolve })
    serve([() => pending])
    const view = render(<PaymentChoicePanel onSuccess={vi.fn()} />)
    view.unmount()
    await act(async () => { resolveOffer(response(annualOffer)); await pending })
    expect(view.container.childElementCount).toBe(0)
    expect(screen.queryByRole('button', { name: /Continue to card payment/ })).toBeNull()
  })

  it('turns a payment-flow class refusal into a completed renewal refusal without Retry or payment controls', async () => {
    let offers = 0
    let payments = 0
    vi.mocked(fetch).mockImplementation(async input => {
      const url = String(input)
      if (url.endsWith('/subscription/payment-flows/current')) return response({ flow: null })
      if (url.endsWith('/subscription/offers/v2')) return ++offers === 1 ? response(annualOffer) : problem(409, 'plan-not-purchasable')
      if (url.endsWith('/subscription/offers/v2/activate')) return response({ contractVersion: 2, checkoutIntentToken: signedCheckoutIntent, expiresAt: '2026-08-10T12:05:00Z', disclosure: {
        kind: 'charge_now', annualAmountMinor: 3600, firstChargeAmountMinor: 3600, renewalAmountMinor: 3600,
        monthlyEquivalentMinor: 300, currency: 'EUR', trialEndsAt: null, firstChargeAt: null, cancelBy: null,
        cancelByInclusive: false, autoRenew: true, prepaid: false, refundWindowDays: 30, bonusDays: 14,
        periodEndRule: 'confirmation_bonus_then_1_utc_calendar_year', renewalAt: null, entitlementEndsAt: null,
      } })
      if (url.endsWith('/subscription/payment-flows/v2')) { payments++; return problem(409, 'plan-not-purchasable') }
      throw new Error(`unexpected request ${url}`)
    })
    render(<PaymentChoicePanel onSuccess={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Continue to card payment/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Confirm annual terms and continue/ }))
    await waitFor(() => expect(offers).toBe(2))
    expect((await screen.findAllByText(REFUSED)).length).toBeGreaterThan(0)
    expect(payments).toBe(1)
    expect(screen.queryByText(LOADING)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry current annual offer' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Continue to card payment/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Confirm annual terms and continue/ })).toBeNull()
    expect(screen.queryByTestId('stripe-payment-form')).toBeNull()
  })

  it.each(['activation', 'payment'] as const)('retains %s retry state after 503 without renewing the offer', async boundary => {
    let offers = 0
    let activations = 0
    let payments = 0
    vi.mocked(fetch).mockImplementation(async input => {
      const url = String(input)
      if (url.endsWith('/subscription/payment-flows/current')) return response({ flow: null })
      if (url.endsWith('/subscription/offers/v2')) { offers++; return response(annualOffer) }
      if (url.endsWith('/subscription/offers/v2/activate')) {
        activations++
        if (boundary === 'activation') return problem(503, 'offer-unavailable')
        return response({ contractVersion: 2, checkoutIntentToken: signedCheckoutIntent, expiresAt: '2026-08-10T12:05:00Z', disclosure: {
          kind: 'charge_now', annualAmountMinor: 3600, firstChargeAmountMinor: 3600, renewalAmountMinor: 3600,
          monthlyEquivalentMinor: 300, currency: 'EUR', trialEndsAt: null, firstChargeAt: null, cancelBy: null,
          cancelByInclusive: false, autoRenew: true, prepaid: false, refundWindowDays: 30, bonusDays: 14,
          periodEndRule: 'confirmation_bonus_then_1_utc_calendar_year', renewalAt: null, entitlementEndsAt: null,
        } })
      }
      if (url.endsWith('/subscription/payment-flows/v2')) { payments++; return problem(503, 'provider-unavailable') }
      throw new Error(`unexpected request ${url}`)
    })
    render(<PaymentChoicePanel onSuccess={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Continue to card payment/ }))
    if (boundary === 'payment') fireEvent.click(await screen.findByRole('button', { name: /Confirm annual terms and continue/ }))
    expect(await screen.findByText('No annual offer is available for this account.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: boundary === 'payment' ? /Confirm annual terms and continue/ : /Continue to card payment/ }))
    await waitFor(() => expect(boundary === 'payment' ? payments : activations).toBe(2))
    expect(offers).toBe(1)
    expect(activations).toBe(boundary === 'payment' ? 1 : 2)
    expect(screen.queryByRole('button', { name: 'Retry current annual offer' })).toBeNull()
  })
})
