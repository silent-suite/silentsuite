import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import AddCardBanner from '../add-card-banner'

vi.mock('next/dynamic', () => ({
  default: () => function MockStripePaymentForm({ mode, submitLabel }: { mode: string; submitLabel: string }) {
    return <div data-testid="stripe-payment-form">{mode}:{submitLabel}</div>
  },
}))

vi.mock('@/app/lib/config', () => ({
  BILLING_API_URL: 'https://billing.example.test',
}))

vi.stubGlobal('fetch', vi.fn())

const monthlyOptions = {
  selectedInterval: 'monthly',
  options: [
    { id: 'stripe_pay_now', provider: 'stripe', planIds: ['early_monthly'], billingIntervals: ['monthly'], enabled: true },
    { id: 'bitcoin_annual_switch', provider: 'notice', planIds: ['early_annual'], billingIntervals: ['annual'], enabled: true },
  ],
}

const annualOptions = {
  selectedInterval: 'annual',
  options: [
    { id: 'stripe_pay_now', provider: 'stripe', planIds: ['early_annual'], billingIntervals: ['annual'], enabled: true },
    { id: 'btcpay_annual', provider: 'btcpay', planIds: ['early_annual'], billingIntervals: ['annual'], enabled: true },
  ],
}

describe('AddCardBanner', () => {
  beforeEach(() => {
    vi.mocked(fetch).mockReset()
    vi.stubGlobal('location', { href: 'https://app.example.test/settings/subscription' })
  })

  it('uses shared payment options and starts Stripe pay-now through payment-flows', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => monthlyOptions } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ clientSecret: 'pi_secret', flowKind: 'stripe_pay_now' }) } as Response)

    render(<AddCardBanner daysRemaining={3} onCardAdded={vi.fn()} />)

    expect(screen.getByText(/Subscribe by card or annual Bitcoin and get 14 bonus days/)).toBeInTheDocument()
    expect(screen.queryByText(/Add a card to continue/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Choose payment'))

    expect(await screen.findByText('Pay now + 14 bonus days')).toBeInTheDocument()
    expect(screen.getByText('Prefer Bitcoin?')).toBeInTheDocument()
    expect(screen.queryByText('30-day trial')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Continue to card payment'))

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      'https://billing.example.test/subscription/payment-flows',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ flowKind: 'stripe_pay_now', planId: 'early_monthly' }),
      }),
    ))

    expect(await screen.findByText('14 bonus days included after today\'s payment.')).toBeInTheDocument()
    expect(screen.getByTestId('stripe-payment-form')).toHaveTextContent('payment:Pay €3.60')
  })

  it('switches monthly Bitcoin banner to annual and starts annual BTCPay flow', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => monthlyOptions } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => annualOptions } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => annualOptions } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ checkoutUrl: 'https://btcpay.silentsuite.io/i/inv_123' }) } as Response)

    render(<AddCardBanner daysRemaining={3} onCardAdded={vi.fn()} />)
    fireEvent.click(screen.getByText('Choose payment'))

    fireEvent.click(await screen.findByText('Prefer Bitcoin?'))
    expect(await screen.findByText('Pay annual with Bitcoin')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Pay annual with Bitcoin'))

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      'https://billing.example.test/subscription/payment-flows',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ flowKind: 'btcpay_annual', planId: 'early_annual', returnUrl: '/settings/subscription' }),
      }),
    ))
  })
})
