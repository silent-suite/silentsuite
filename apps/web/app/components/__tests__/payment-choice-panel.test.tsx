import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import PaymentChoicePanel from '../payment-choice-panel'

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

const activeFlow = {
  flowKind: 'stripe_pay_now',
  provider: 'stripe',
  status: 'processing',
  planId: 'early_annual',
  amount: '36.00',
  currency: 'EUR',
  createdAt: '2026-08-10T12:00:00Z',
  cancellable: true,
}

function response(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: async () => body } as Response
}

function renderPanel(onCancel = vi.fn()) {
  render(<PaymentChoicePanel onSuccess={vi.fn()} onCancel={onCancel} />)
  return onCancel
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PaymentChoicePanel cancellation safety', () => {
  it('renders the server-issued immediate-charge terms and requires confirmation before claiming payment authority', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/subscription/payment-flows/current')) return response({ flow: null })
      if (url.endsWith('/subscription/offers/v2')) return response(annualOffer)
      if (url.endsWith('/subscription/offers/v2/activate')) return response({
        contractVersion: 2,
        checkoutIntentToken: 'A'.repeat(43),
        expiresAt: '2026-08-10T12:05:00Z',
        disclosure: {
          kind: 'charge_now', annualAmountMinor: 3600, firstChargeAmountMinor: 3600, renewalAmountMinor: 3600,
          monthlyEquivalentMinor: 300, currency: 'EUR', trialEndsAt: null, firstChargeAt: null, cancelBy: null,
          cancelByInclusive: false, autoRenew: true, prepaid: false, refundWindowDays: 30, bonusDays: 14,
          periodEndRule: 'confirmation_bonus_then_1_utc_calendar_year', renewalAt: null, entitlementEndsAt: null,
        },
      })
      if (url.endsWith('/subscription/payment-flows/v2')) return response({ contractVersion: 2, kind: 'stripe', authorityId: annualOffer.requestId, clientSecret: 'pi_secret' })
      return response({}, false)
    })
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /continue to card payment/i }))
    expect(await screen.findByRole('heading', { name: /confirm annual terms/i })).toBeInTheDocument()
    expect(screen.getByText(/€36\.00 today/i)).toBeInTheDocument()
    expect(screen.getByText(/annual price.*€36\.00/i)).toBeInTheDocument()
    expect(screen.getByText(/renewal amount.*€36\.00/i)).toBeInTheDocument()
    expect(screen.getByText(/period end rule.*confirmation bonus then 1 utc calendar year/i)).toBeInTheDocument()
    expect(screen.getByText(/first charge.*not scheduled/i)).toBeInTheDocument()
    expect(screen.getByText(/cancel before.*not applicable/i)).toBeInTheDocument()
    expect(screen.getByText(/renews.*not scheduled/i)).toBeInTheDocument()
    expect(screen.getByText(/access through.*not scheduled/i)).toBeInTheDocument()
    expect(screen.getByText(/30-day refund window/i)).toBeInTheDocument()
    expect(screen.getByText(/renews automatically/i)).toBeInTheDocument()
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith('/subscription/payment-flows/v2'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /confirm annual terms and continue/i }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith('/subscription/payment-flows/v2'))).toBe(true))
  })

  it('clears rejected activation consent before showing a renewed offer', async () => {
    let offerReads = 0
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/subscription/payment-flows/current')) return response({ flow: null })
      if (url.endsWith('/subscription/offers/v2')) {
        offerReads += 1
        return response({ ...annualOffer, requestId: offerReads === 1 ? annualOffer.requestId : '22222222-2222-4222-8222-222222222222' })
      }
      if (url.endsWith('/subscription/offers/v2/activate')) return response({
        contractVersion: 2, checkoutIntentToken: 'A'.repeat(43), expiresAt: '2026-08-10T12:05:00Z',
        disclosure: {
          kind: 'charge_now', annualAmountMinor: 3600, firstChargeAmountMinor: 3600, renewalAmountMinor: 3600,
          monthlyEquivalentMinor: 300, currency: 'EUR', trialEndsAt: null, firstChargeAt: null, cancelBy: null,
          cancelByInclusive: false, autoRenew: true, prepaid: false, refundWindowDays: 30, bonusDays: 14,
          periodEndRule: 'confirmation_bonus_then_1_utc_calendar_year', renewalAt: null, entitlementEndsAt: null,
        },
      })
      if (url.endsWith('/subscription/payment-flows/v2')) return response({ detail: 'Offer expired', type: 'https://api.silentsuite.io/errors/plan-not-purchasable' }, false, 409)
      return response({}, false)
    })

    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /continue to card payment/i }))
    fireEvent.click(await screen.findByRole('button', { name: /confirm annual terms and continue/i }))

    expect(await screen.findByRole('button', { name: /continue to card payment/i })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /confirm annual terms/i })).not.toBeInTheDocument()
    expect(offerReads).toBe(2)
  })

  it('does not dismiss while the initial current-flow verification is pending', async () => {
    let resolveCurrentFlow: ((value: Response) => void) | undefined
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/subscription/payment-flows/current')) {
        return new Promise<Response>((resolve) => { resolveCurrentFlow = resolve })
      }
      if (url.endsWith('/subscription/offers/v2')) return response(annualOffer)
      return response({}, false)
    })
    const onCancel = renderPanel()

    const cancel = (await screen.findAllByRole('button', { name: /checking current payment/i }))[1]!
    expect(cancel).toBeDisabled()
    fireEvent.click(cancel)
    expect(onCancel).not.toHaveBeenCalled()
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith('/payment-flows/cancel'))).toBe(false)

    await act(async () => {
      resolveCurrentFlow?.(response({ flow: null }))
    })
  })

  it('keeps the chooser open after failed verification until cancellation succeeds, and exposes a status retry', async () => {
    let currentFlowReads = 0
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/subscription/payment-flows/current')) {
        currentFlowReads += 1
        return currentFlowReads === 1 ? response({}, false) : response({ flow: null })
      }
      if (url.endsWith('/subscription/offers/v2')) return response(annualOffer)
      if (url.endsWith('/subscription/payment-flows/cancel')) return response({ detail: 'Cancellation could not be confirmed.' }, false)
      return response({}, false)
    })
    const onCancel = renderPanel()

    expect(await screen.findByRole('button', { name: /retry payment status/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel any payment in progress and close' }))

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith('/payment-flows/cancel'))).toBe(true))
    expect(onCancel).not.toHaveBeenCalled()
    expect(await screen.findByText('Could not cancel the pending payment flow.')).toBeInTheDocument()
    expect(screen.queryByText('Cancellation could not be confirmed.')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /retry payment status/i }))
    expect(await screen.findByRole('button', { name: /continue to card payment/i })).toBeInTheDocument()
  })

  it('cancels an active flow through the authoritative endpoint before returning to payment options', async () => {
    let resolveCancellation: ((value: Response) => void) | undefined
    let currentFlowReads = 0
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/subscription/payment-flows/current')) {
        currentFlowReads += 1
        return response({ flow: currentFlowReads === 1 ? activeFlow : null })
      }
      if (url.endsWith('/subscription/offers/v2')) return response(annualOffer)
      if (url.endsWith('/subscription/payment-flows/cancel')) {
        return new Promise<Response>((resolve) => { resolveCancellation = resolve })
      }
      return response({}, false)
    })
    const onCancel = renderPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel card payment' }))
    await waitFor(() => expect(resolveCancellation).toBeTypeOf('function'))
    expect(onCancel).not.toHaveBeenCalled()

    await act(async () => {
      resolveCancellation?.(response({ cancelled: true }))
    })
    await screen.findByRole('button', { name: /continue to card payment/i })
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('closes directly only after a verified safe no-flow state', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/subscription/payment-flows/current')) return response({ flow: null })
      if (url.endsWith('/subscription/offers/v2')) return response(annualOffer)
      return response({}, false)
    })
    const onCancel = renderPanel()

    await screen.findByRole('button', { name: /continue to card payment/i })
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith('/payment-flows/cancel'))).toBe(false)
  })
})
