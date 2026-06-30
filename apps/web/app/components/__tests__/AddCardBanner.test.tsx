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

describe('AddCardBanner', () => {
  beforeEach(() => {
    vi.mocked(fetch).mockReset()
  })

  it('offers only pay-now monthly/annual choices and requests immediate payment setup', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ clientSecret: 'pi_secret' }),
    } as Response)

    render(<AddCardBanner daysRemaining={3} onCardAdded={vi.fn()} />)

    fireEvent.click(screen.getByText('Add payment method'))

    expect(screen.getByText('Pay now + 14 bonus days')).toBeInTheDocument()
    expect(screen.getByText('Choose monthly or annual. Your card is charged now.')).toBeInTheDocument()
    expect(screen.queryByText('30-day trial')).not.toBeInTheDocument()
    expect(screen.getByText('Monthly')).toBeInTheDocument()
    expect(screen.getByText('Annual')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Annual'))
    fireEvent.click(screen.getByText('Continue to payment'))

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      'https://billing.example.test/subscription/setup-card',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ planId: 'early_annual', trialPath: 'immediate' }),
      }),
    ))

    expect(await screen.findByText('14 bonus days included after today\'s payment.')).toBeInTheDocument()
    expect(screen.getByTestId('stripe-payment-form')).toHaveTextContent('payment:Pay €36')
  })
})
