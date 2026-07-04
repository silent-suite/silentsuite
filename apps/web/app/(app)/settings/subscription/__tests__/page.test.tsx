import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import SubscriptionPage from '../page'

vi.mock('next/dynamic', () => ({
  default: () => function MockStripePaymentForm({ mode, submitLabel, onSuccess }: { mode: string; submitLabel: string; onSuccess?: () => Promise<void> | void }) {
    return (
      <div data-testid="stripe-payment-form">
        {mode}:{submitLabel}
        <button onClick={() => { void onSuccess?.() }}>mock payment success</button>
      </div>
    )
  },
}))

vi.mock('@silentsuite/ui', () => ({
  Button: ({ children, onClick, disabled, ...props }: {
    children: React.ReactNode
    onClick?: () => void
    disabled?: boolean
  }) => <button onClick={onClick} disabled={disabled} {...props}>{children}</button>,
}))

vi.mock('lucide-react', () => ({
  Crown: ({ className }: { className?: string }) => <svg data-testid="crown-icon" className={className} />,
  Loader2: ({ className }: { className?: string }) => <svg data-testid="loader-icon" className={className} />,
  Check: ({ className }: { className?: string }) => <svg data-testid="check-icon" className={className} />,
  CreditCard: ({ className }: { className?: string }) => <svg data-testid="credit-card-icon" className={className} />,
  Clock: ({ className }: { className?: string }) => <svg data-testid="clock-icon" className={className} />,
  X: ({ className }: { className?: string }) => <svg data-testid="x-icon" className={className} />,
  Lock: ({ className }: { className?: string }) => <svg data-testid="lock-icon" className={className} />,
  Zap: ({ className }: { className?: string }) => <svg data-testid="zap-icon" className={className} />,
}))

vi.mock('@/app/lib/config', () => ({ BILLING_API_URL: 'https://billing.test' }))
vi.mock('@/app/lib/date', () => ({
  formatDate: (date: Date) => date.toISOString().slice(0, 10),
}))

const baseSubscription = {
  plan: 'early_monthly',
  planLabel: 'Early Adopter',
  billingInterval: 'monthly',
  status: 'active',
  renewalDate: '2026-07-30T00:00:00.000Z',
  trial: { active: false, endsAt: null, daysRemaining: null },
  cancelAtPeriodEnd: false,
  trialPath: null,
  earlyAdopter: true,
  capabilities: {
    trialActive: false,
    trialExpired: false,
    needsPaymentMethod: false,
    canSetupCard: false,
    canStartPaidSubscription: false,
    canReactivate: false,
    canRetryPayment: false,
    canResumeCancellation: false,
  },
}

function mockSubscription(subscription: Record<string, unknown>) {
  const response = { ...baseSubscription, ...subscription }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === 'https://billing.test/subscription' && !init?.method) {
      return { ok: true, json: async () => response }
    }
    if (url === 'https://billing.test/subscription/payment-flows/current') {
      return { ok: true, json: async () => ({ flow: null }) }
    }
    if (url === 'https://billing.test/subscription/payment-options?interval=monthly') {
      return { ok: true, json: async () => ({
        selectedInterval: 'monthly',
        options: [
          { id: 'stripe_pay_now', provider: 'stripe', planIds: ['early_monthly'], billingIntervals: ['monthly'], enabled: true },
          { id: 'bitcoin_annual_switch', provider: 'notice', planIds: ['early_annual'], billingIntervals: ['annual'], enabled: true },
        ],
      }) }
    }
    if (url === 'https://billing.test/subscription/payment-options?interval=annual') {
      return { ok: true, json: async () => ({
        selectedInterval: 'annual',
        options: [
          { id: 'stripe_pay_now', provider: 'stripe', planIds: ['early_annual'], billingIntervals: ['annual'], enabled: true },
          { id: 'btcpay_annual', provider: 'btcpay', planIds: ['early_annual'], billingIntervals: ['annual'], enabled: true },
        ],
      }) }
    }
    if (url === 'https://billing.test/subscription/payment-flows') {
      return { ok: true, json: async () => ({
        clientSecret: 'cs_test',
        planId: 'early_monthly',
        billingInterval: 'monthly',
        amount: '3.60',
        currency: 'EUR',
      }) }
    }
    return { ok: false, status: 404, json: async () => ({ detail: 'not found' }) }
  }))
}

describe('SubscriptionPage billing recovery CTAs', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows choose payment for active no-card trials without making cancel the only action', async () => {
    mockSubscription({
      status: 'trialing',
      trial: { active: true, endsAt: '2026-07-03T00:00:00.000Z', daysRemaining: 3 },
      trialPath: '7day',
      renewalDate: null,
      capabilities: {
        ...baseSubscription.capabilities,
        trialActive: true,
        needsPaymentMethod: true,
        canSetupCard: true,
      },
    })

    render(<SubscriptionPage />)

    expect(await screen.findByRole('button', { name: /choose payment/i })).toBeInTheDocument()
    expect(screen.getByText(/Subscribe by card or annual Bitcoin and get 14 bonus days/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /cancel subscription/i })).not.toBeInTheDocument()
  })

  it('shows subscribe recovery for expired no-card trials', async () => {
    mockSubscription({
      status: 'trialing',
      trial: { active: false, endsAt: '2026-06-01T00:00:00.000Z', daysRemaining: null },
      trialPath: '7day',
      renewalDate: null,
      capabilities: {
        ...baseSubscription.capabilities,
        trialExpired: true,
        canStartPaidSubscription: true,
      },
    })

    render(<SubscriptionPage />)

    expect(await screen.findByRole('button', { name: /^subscribe$/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /change plan/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /cancel subscription/i })).not.toBeInTheDocument()
  })

  it('shows retry payment for pending payments', async () => {
    mockSubscription({
      status: 'none',
      renewalDate: null,
      capabilities: {
        ...baseSubscription.capabilities,
        canRetryPayment: true,
        canStartPaidSubscription: true,
      },
    })

    render(<SubscriptionPage />)

    expect(await screen.findByText(/payment incomplete/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry payment/i })).toBeInTheDocument()
  })

  it('shows a paid recovery path for derived expired prepaid users', async () => {
    mockSubscription({
      status: 'expired',
      renewalDate: '2026-06-01T00:00:00.000Z',
      capabilities: {
        ...baseSubscription.capabilities,
        canStartPaidSubscription: true,
      },
    })

    render(<SubscriptionPage />)

    expect(await screen.findByRole('button', { name: /^subscribe$/i })).toBeInTheDocument()
  })

  it('shows visible shared payment-flow errors and recovers the loading state', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://billing.test/subscription' && !init?.method) {
        return { ok: true, json: async () => ({
          ...baseSubscription,
          status: 'cancelled',
          capabilities: { ...baseSubscription.capabilities, canReactivate: true },
        }) }
      }
      if (url === 'https://billing.test/subscription/payment-flows/current') return { ok: true, json: async () => ({ flow: null }) }
      if (url === 'https://billing.test/subscription/payment-options?interval=monthly') {
        return { ok: true, json: async () => ({ selectedInterval: 'monthly', options: [{ id: 'stripe_pay_now', provider: 'stripe', planIds: ['early_monthly'], billingIntervals: ['monthly'], enabled: true }] }) }
      }
      if (url === 'https://billing.test/subscription/payment-flows') {
        return { ok: false, status: 500, json: async () => ({ detail: 'Payment setup failed safely' }) }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }))

    render(<SubscriptionPage />)

    fireEvent.click(await screen.findByRole('button', { name: /reactivate/i }))
    fireEvent.click(await screen.findByRole('button', { name: /continue to card payment/i }))

    expect(await screen.findByText('Payment setup failed safely')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: /continue to card payment/i })).not.toBeDisabled())
  })

  it('suppresses retry CTA while payment confirmation is pending after client-side success', async () => {
    let subscriptionFetches = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://billing.test/subscription' && !init?.method) {
        subscriptionFetches += 1
        return { ok: true, json: async () => subscriptionFetches === 1
          ? {
              ...baseSubscription,
              status: 'cancelled',
              capabilities: { ...baseSubscription.capabilities, canReactivate: true },
            }
          : {
              ...baseSubscription,
              status: 'none',
              capabilities: { ...baseSubscription.capabilities, canRetryPayment: true, canStartPaidSubscription: true },
            } }
      }
      if (url === 'https://billing.test/subscription/payment-flows/current') return { ok: true, json: async () => ({ flow: null }) }
      if (url === 'https://billing.test/subscription/payment-options?interval=monthly') {
        return { ok: true, json: async () => ({ selectedInterval: 'monthly', options: [{ id: 'stripe_pay_now', provider: 'stripe', planIds: ['early_monthly'], billingIntervals: ['monthly'], enabled: true }] }) }
      }
      if (url === 'https://billing.test/subscription/payment-flows') {
        return { ok: true, json: async () => ({ clientSecret: 'cs_test', planId: 'early_monthly', billingInterval: 'monthly', amount: '3.60', currency: 'EUR' }) }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }))

    render(<SubscriptionPage />)

    fireEvent.click(await screen.findByRole('button', { name: /reactivate/i }))
    fireEvent.click(await screen.findByRole('button', { name: /continue to card payment/i }))
    expect(await screen.findByText('Amount due')).toBeInTheDocument()
    expect(screen.getByText('Powered by Stripe')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: /mock payment success/i }))

    expect(await screen.findByText(/confirming your payment/i)).toBeInTheDocument()
    expect(screen.queryByText(/payment incomplete/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /retry payment/i })).not.toBeInTheDocument()
  })

  it('does not route cancel-at-period-end users into reactivation', async () => {
    mockSubscription({
      status: 'active',
      cancelAtPeriodEnd: true,
      capabilities: {
        ...baseSubscription.capabilities,
        canResumeCancellation: true,
      },
    })

    render(<SubscriptionPage />)

    await screen.findByText(/subscription will be cancelled/i)
    expect(screen.queryByRole('button', { name: /reactivate/i })).not.toBeInTheDocument()
  })
})
