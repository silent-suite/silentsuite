import { checkoutIntentToken as signedCheckoutIntent } from '@/src/__tests__/fixtures/annual-authority'
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { emulateInert, type InertEmulation } from '@/app/lib/__tests__/inert-test-utils'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { bumpAccountEpoch } from '@/app/lib/account-epoch'
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

vi.mock('@/app/lib/config', () => ({ BILLING_API_URL: 'https://billing.test', ETEBASE_SERVER_URL: 'https://server.example.test' }))
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

const pendingStripeFlow = {
  flowKind: 'stripe_pay_now',
  provider: 'stripe',
  status: 'processing',
  planId: 'early_monthly',
  billingInterval: 'monthly',
  amount: '3.60',
  currency: 'EUR',
  createdAt: '2026-07-10T00:00:00.000Z',
  cancellable: true,
}

const annualOffer = {
  contractVersion: 2,
  requestId: 'e91a6d70-0d4e-4352-9bdc-426d1f76d771',
  offer: {
    planId: 'early_annual', customerClass: 'early', billingInterval: 'annual', annualAmountMinor: 3600,
    monthlyEquivalentMinor: 300, currency: 'EUR', providers: ['stripe', 'btcpay'], offerRevision: 1,
    offerToken: 'signed-offer', expiresAt: '2026-08-10T12:10:00Z',
  },
}
// The account panel reads the opt-in preview (`?preview=1`) with the exact
// signed terms per provider; activation signs exactly the previewed card terms.
const PROFILE = 'account_confirmation_rules_v1'
function accountTerms(provider: string) {
  const prepaid = provider === 'btcpay'
  return {
    kind: prepaid ? 'prepaid' : 'charge_now', annualAmountMinor: 3600, firstChargeAmountMinor: 3600, renewalAmountMinor: prepaid ? null : 3600,
    monthlyEquivalentMinor: 300, currency: 'EUR', trialEndsAt: null, firstChargeAt: null, cancelBy: null, cancelByInclusive: false,
    autoRenew: !prepaid, prepaid, refundWindowDays: 30, bonusDays: 0, periodEndRule: PROFILE, renewalAt: null, entitlementEndsAt: null,
  }
}
const previewOffer = { ...annualOffer, accountTermsProfile: PROFILE, accountDisclosures: { stripe: accountTerms('stripe'), btcpay: accountTerms('btcpay') } }
const annualActivation = {
  contractVersion: 2,
  checkoutIntentToken: signedCheckoutIntent,
  expiresAt: '2026-08-10T12:05:00Z',
  disclosure: accountTerms('stripe'),
}
/** The page's own reads use the plain path; the panel's re-proof uses the opt-in path. */
function isCurrentFlow(url: string) {
  return url === `https://billing.test/subscription/payment-flows/current` || url === 'https://billing.test/subscription/payment-flows/current?preview=1'
}
// Billing mints the payment flow id server-side; it never equals the offer requestId.
const annualStripePayment = { contractVersion: 2, kind: 'stripe', authorityId: '6d1f0a94-8c52-4b7e-9f31-2a5d6e8b0c47', clientSecret: 'cs_test' }

function mockSubscription(
  subscription: Record<string, unknown>,
  currentFlow: Record<string, unknown> | null = null,
) {
  const response = { ...baseSubscription, ...subscription }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === 'https://billing.test/subscription' && !init?.method) {
      return { ok: true, json: async () => response }
    }
    if (isCurrentFlow(url)) {
      return { ok: true, json: async () => ({ flow: currentFlow }) }
    }
    if (url === 'https://billing.test/subscription/offers/v2?preview=1') {
      return { ok: true, json: async () => previewOffer }
    }
    if (url === 'https://billing.test/subscription/offers/v2/activate') {
      return { ok: true, json: async () => annualActivation }
    }
    if (url === 'https://billing.test/subscription/payment-flows/v2') {
      return { ok: true, json: async () => annualStripePayment }
    }
    return { ok: false, status: 404, json: async () => ({ detail: 'not found' }) }
  }))
}

describe('SubscriptionPage billing recovery CTAs', () => {
  let inert: InertEmulation

  beforeEach(() => {
    vi.unstubAllGlobals()
    window.history.replaceState({}, '', '/settings/subscription')
    // Every dialog on this page inerts the background wrapper, so all of these
    // tests must run against browser-accurate inert focus behaviour.
    inert = emulateInert()
  })

  afterEach(() => {
    inert.restore()
    vi.useRealTimers()
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
    expect(screen.getByText(/Review your server-owned annual payment options and get 14 bonus days/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /cancel subscription/i })).not.toBeInTheDocument()
  })

  it('routes the no-card CTA through the sole labelled, inert, focus-restoring payment dialog and permits direct close only after no-flow verification', async () => {
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
    const opener = await screen.findByRole('button', { name: /choose payment/i })
    opener.focus()
    fireEvent.click(opener)

    const dialog = await screen.findByRole('dialog', { name: /continue with silentsuite\.io/i })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('aria-describedby')
    expect(screen.getByText('Plan').closest('[aria-hidden="true"]')).toHaveAttribute('inert')
    await screen.findByRole('button', { name: /continue to card payment/i })
    await waitFor(() => expect(dialog).toContainElement(document.activeElement))
    // The background really was inerted while the opener held focus, so the
    // restoration assertion below cannot pass by jsdom's missing inert support.
    expect(inert.blurred).not.toHaveLength(0)

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /continue with silentsuite\.io/i })).not.toBeInTheDocument())
    expect(document.activeElement).toBe(opener)

    fireEvent.click(opener)
    const reopenedDialog = await screen.findByRole('dialog', { name: /continue with silentsuite\.io/i })
    await screen.findByRole('button', { name: /continue to card payment/i })
    fireEvent.click(reopenedDialog.previousElementSibling!)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /continue with silentsuite\.io/i })).not.toBeInTheDocument())
  })

  it('keeps no-card payment authority visible on Escape/backdrop and uses the cancellation endpoint for active or unverified flows', async () => {
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
    }, pendingStripeFlow)

    render(<SubscriptionPage />)
    fireEvent.click(await screen.findByRole('button', { name: /choose payment/i }))
    const dialog = await screen.findByRole('dialog', { name: /continue with silentsuite\.io/i })
    await screen.findByText(/card payment in progress/i)

    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(dialog.previousElementSibling!)
    expect(screen.getByRole('dialog', { name: /continue with silentsuite\.io/i })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel card payment' }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, init]) => (
      url === 'https://billing.test/subscription/payment-flows/cancel'
        && (init as RequestInit | undefined)?.method === 'POST'
    ))).toBe(true))
    expect(screen.getByRole('dialog', { name: /continue with silentsuite\.io/i })).toBeInTheDocument()
  })

  it('preserves no-card CTA payment success confirmation in the shared chooser', async () => {
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
    fireEvent.click(await screen.findByRole('button', { name: /choose payment/i }))
    fireEvent.click(await screen.findByRole('button', { name: /continue to card payment/i }))
    fireEvent.click(await screen.findByRole('button', { name: /mock payment success/i }))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /continue with silentsuite\.io/i })).not.toBeInTheDocument())
    expect(screen.getByText(/confirming your payment/i)).toBeInTheDocument()
  })

  it('keeps the no-card dialog open when failed payment-status verification cannot be authoritatively cancelled', async () => {
    const noCardSubscription = {
      ...baseSubscription,
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
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://billing.test/subscription' && !init?.method) return { ok: true, json: async () => noCardSubscription }
      if (isCurrentFlow(url)) return { ok: false, json: async () => ({}) }
      if (url === 'https://billing.test/subscription/offers/v2?preview=1') return { ok: true, json: async () => previewOffer }
      if (url === 'https://billing.test/subscription/payment-flows/cancel') return { ok: false, json: async () => ({ detail: 'Cancellation could not be confirmed.' }) }
      return { ok: false, status: 404, json: async () => ({}) }
    }))

    render(<SubscriptionPage />)
    fireEvent.click(await screen.findByRole('button', { name: /choose payment/i }))
    await screen.findByRole('button', { name: /retry payment status/i })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel any payment in progress and close' }))

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, init]) => (
      url === 'https://billing.test/subscription/payment-flows/cancel'
        && (init as RequestInit | undefined)?.method === 'POST'
    ))).toBe(true))
    expect(screen.getByRole('dialog', { name: /continue with silentsuite\.io/i })).toBeInTheDocument()
    expect(await screen.findByText('Could not cancel the pending payment flow.')).toBeInTheDocument()
    expect(screen.queryByText('Cancellation could not be confirmed.')).not.toBeInTheDocument()
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

  it('presents cancellation as a labelled modal, traps keyboard focus, and restores the opener on Escape', async () => {
    mockSubscription({})
    render(<SubscriptionPage />)

    const opener = await screen.findByRole('button', { name: /cancel subscription/i })
    opener.focus()
    fireEvent.click(opener)

    const dialog = await screen.findByRole('dialog', { name: /cancel your subscription/i })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('aria-describedby')
    await waitFor(() => expect(document.activeElement).toHaveTextContent(/keep subscription/i))

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toHaveTextContent(/cancel subscription/i)
    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /cancel your subscription/i })).not.toBeInTheDocument())
    expect(document.activeElement).toBe(opener)
  })

  it('exposes the payment choice overlay as an isolated labelled modal', async () => {
    mockSubscription({
      status: 'cancelled',
      capabilities: { ...baseSubscription.capabilities, canReactivate: true },
    })
    render(<SubscriptionPage />)

    const opener = await screen.findByRole('button', { name: /reactivate/i })
    opener.focus()
    fireEvent.click(opener)
    const dialog = await screen.findByRole('dialog', { name: /continue with silentsuite\.io/i })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('aria-describedby')
    expect(dialog.parentElement?.previousElementSibling).toHaveAttribute('aria-hidden', 'true')
    await screen.findByRole('button', { name: /continue to card payment/i })
    await waitFor(() => expect(document.activeElement).toHaveTextContent(/continue to card payment/i))

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /continue with silentsuite\.io/i })).not.toBeInTheDocument())
    expect(document.activeElement).toBe(opener)

    fireEvent.click(opener)
    const reopenedDialog = await screen.findByRole('dialog', { name: /continue with silentsuite\.io/i })
    await screen.findByRole('button', { name: /continue to card payment/i })
    fireEvent.click(reopenedDialog.previousElementSibling!)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /continue with silentsuite\.io/i })).not.toBeInTheDocument())
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
      if (isCurrentFlow(url)) return { ok: true, json: async () => ({ flow: null }) }
      if (url === 'https://billing.test/subscription/offers/v2?preview=1') return { ok: true, json: async () => previewOffer }
      if (url === 'https://billing.test/subscription/offers/v2/activate') return { ok: true, json: async () => annualActivation }
      if (url === 'https://billing.test/subscription/payment-flows/v2') {
        return { ok: false, status: 500, json: async () => ({ detail: 'Payment setup failed safely' }) }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }))

    render(<SubscriptionPage />)

    fireEvent.click(await screen.findByRole('button', { name: /reactivate/i }))
    fireEvent.click(await screen.findByRole('button', { name: /continue to card payment/i }))

    expect(await screen.findByText('Payment setup failed safely')).toBeInTheDocument()
    // The loading state recovers onto the same choice; no confirmation screen exists.
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
      if (isCurrentFlow(url)) return { ok: true, json: async () => ({ flow: null }) }
      if (url === 'https://billing.test/subscription/offers/v2?preview=1') return { ok: true, json: async () => previewOffer }
      if (url === 'https://billing.test/subscription/offers/v2/activate') return { ok: true, json: async () => annualActivation }
      if (url === 'https://billing.test/subscription/payment-flows/v2') return { ok: true, json: async () => annualStripePayment }
      return { ok: false, status: 404, json: async () => ({}) }
    }))

    render(<SubscriptionPage />)

    fireEvent.click(await screen.findByRole('button', { name: /reactivate/i }))
    fireEvent.click(await screen.findByRole('button', { name: /continue to card payment/i }))
    expect(await screen.findByText('Amount due')).toBeInTheDocument()
    expect(screen.getByText('Powered by Stripe')).toBeInTheDocument()
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: /mock payment success/i }))

    expect(screen.getByText(/confirming your payment/i)).toBeInTheDocument()
    expect(screen.queryByText(/payment incomplete/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /retry payment/i })).not.toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(10000)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByRole('button', { name: /retry payment status/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^retry payment$/i })).not.toBeInTheDocument()
  })

  it('keeps polling a no-card trial until Stripe confirmation removes payment requirements', async () => {
    vi.useFakeTimers()
    window.history.replaceState({}, '', '/settings/subscription?payment_intent=pi_123&payment_intent_client_secret=secret_123&redirect_status=processing')
    let subscriptionFetches = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://billing.test/subscription' && !init?.method) {
        subscriptionFetches += 1
        const cardConfirmed = subscriptionFetches >= 2
        return { ok: true, json: async () => cardConfirmed
          ? {
              ...baseSubscription,
              status: 'trialing',
              trial: { active: true, endsAt: '2026-07-30T00:00:00.000Z', daysRemaining: 20 },
              capabilities: { ...baseSubscription.capabilities, trialActive: true },
            }
          : {
              ...baseSubscription,
              status: 'trialing',
              trialPath: '7day',
              trial: { active: true, endsAt: '2026-07-17T00:00:00.000Z', daysRemaining: 7 },
              capabilities: { ...baseSubscription.capabilities, trialActive: true, needsPaymentMethod: true, canSetupCard: true },
            } }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }))

    render(<SubscriptionPage />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(screen.getByText(/confirming your payment/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /retry payment/i })).not.toBeInTheDocument()
    expect(window.location.search).toBe('')

    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByText('Trialing')).toBeInTheDocument()
    expect(screen.queryByText(/confirming your payment/i)).not.toBeInTheDocument()
    expect(subscriptionFetches).toBeGreaterThanOrEqual(2)
  })

  it('ignores an older pending poll response after a newer response confirms payment', async () => {
    vi.useFakeTimers()
    window.history.replaceState({}, '', '/settings/subscription?payment_intent=pi_123&redirect_status=processing')
    let subscriptionFetches = 0
    let resolveFirst: ((response: { ok: boolean; json: () => Promise<Record<string, unknown>> }) => void) | undefined
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (url === 'https://billing.test/subscription' && !init?.method) {
        subscriptionFetches += 1
        if (subscriptionFetches === 1) {
          return new Promise(resolve => { resolveFirst = resolve })
        }
        return Promise.resolve({ ok: true, json: async () => baseSubscription })
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) })
    }))

    render(<SubscriptionPage />)
    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByText('Active')).toBeInTheDocument()
    expect(subscriptionFetches).toBe(2)

    await act(async () => {
      resolveFirst?.({
        ok: true,
        json: async () => ({
          ...baseSubscription,
          status: 'none',
          renewalDate: null,
          capabilities: { ...baseSubscription.capabilities, canRetryPayment: true, canStartPaidSubscription: true },
        }),
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByText('Active')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^retry payment$/i })).not.toBeInTheDocument()
  })

  it('stops bounded redirect polling with an actionable timeout', async () => {
    vi.useFakeTimers()
    window.history.replaceState({}, '', '/settings/subscription?payment_intent=pi_123&redirect_status=succeeded')
    mockSubscription({
      status: 'trialing',
      trialPath: '7day',
      trial: { active: true, endsAt: '2026-07-17T00:00:00.000Z', daysRemaining: 7 },
      capabilities: {
        ...baseSubscription.capabilities,
        trialActive: true,
        needsPaymentMethod: true,
        canSetupCard: true,
      },
    }, pendingStripeFlow)

    render(<React.StrictMode><SubscriptionPage /></React.StrictMode>)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText(/confirming your payment/i)).toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(10000)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByText(/payment needs attention/i)).toBeInTheDocument()
    expect(screen.getByText(/taking longer than expected/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry payment status/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /review payment options/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^retry payment$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /choose payment/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/confirming your payment/i)).not.toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /review payment options/i }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByText(/card payment in progress/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel card payment' })).toBeInTheDocument()
    expect(screen.queryByText(/taking longer than expected/i)).not.toBeInTheDocument()
  })

  it('removes an incomplete Stripe client secret from the URL without suppressing the normal fetch', async () => {
    window.history.replaceState({}, '', '/settings/subscription?payment_intent_client_secret=secret_123')
    mockSubscription({})

    render(<SubscriptionPage />)

    expect(await screen.findByText('Active')).toBeInTheDocument()
    expect(window.location.search).toBe('')
  })

  it('offers a manual status retry when every redirect poll fails', async () => {
    vi.useFakeTimers()
    window.history.replaceState({}, '', '/settings/subscription?payment_intent=pi_123&redirect_status=processing')
    const fetchMock = vi.fn(async (url: string) => {
      if (isCurrentFlow(url)) {
        return { ok: true, json: async () => ({ flow: pendingStripeFlow }) }
      }
      if (url === 'https://billing.test/subscription/payment-options?interval=monthly') {
        return { ok: true, json: async () => ({ selectedInterval: 'monthly', options: [] }) }
      }
      return { ok: false, status: 503, json: async () => ({}) }
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<SubscriptionPage />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText(/confirming your payment/i)).toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(10000)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByText(/payment needs attention/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry payment status/i })).toBeInTheDocument()
    expect(screen.queryByText(/unable to load subscription details/i)).not.toBeInTheDocument()

    const firstAttemptCalls = fetchMock.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: /retry payment status/i }))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(screen.getByText(/confirming your payment/i)).toBeInTheDocument()
    expect(fetchMock.mock.calls.length).toBeGreaterThan(firstAttemptCalls)

    await act(async () => {
      vi.advanceTimersByTime(10000)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByText(/payment needs attention/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry payment status/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /review payment options/i })).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /review payment options/i }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByText(/^payment in progress$/i)).toBeInTheDocument()
    expect(screen.queryByText(/card payment in progress/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel card payment' })).toBeInTheDocument()
  })

  it('opens current-flow recovery after a failed Stripe redirect when subscription data is unavailable', async () => {
    window.history.replaceState({}, '', '/settings/subscription?payment_intent=pi_123&payment_intent_client_secret=secret_123&redirect_status=failed')
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (isCurrentFlow(url)) {
        return { ok: true, json: async () => ({ flow: pendingStripeFlow }) }
      }
      if (url === 'https://billing.test/subscription/payment-options?interval=monthly') {
        return { ok: true, json: async () => ({ selectedInterval: 'monthly', options: [] }) }
      }
      return { ok: false, status: 503, json: async () => ({}) }
    }))

    render(<SubscriptionPage />)

    expect(await screen.findByText(/payment needs attention/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /review payment options/i }))
    expect(await screen.findByText(/^payment in progress$/i)).toBeInTheDocument()
    expect(screen.queryByText(/card payment in progress/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel card payment' })).toBeInTheDocument()
    expect(window.location.search).toBe('')
  })

  it('shows an actionable retry path after a failed Stripe redirect', async () => {
    window.history.replaceState({}, '', '/settings/subscription?payment_intent=pi_123&payment_intent_client_secret=secret_123&redirect_status=failed')
    mockSubscription({
      status: 'none',
      renewalDate: null,
      capabilities: {
        ...baseSubscription.capabilities,
        canRetryPayment: true,
        canStartPaidSubscription: true,
      },
    }, pendingStripeFlow)

    render(<SubscriptionPage />)

    expect(await screen.findByText(/payment needs attention/i)).toBeInTheDocument()
    expect(screen.getByText(/Stripe could not confirm this payment/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry payment status/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /review payment options/i }))
    expect(await screen.findByText(/card payment in progress/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel card payment' })).toBeInTheDocument()
    expect(screen.queryByText(/Stripe could not confirm this payment/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/confirming your payment/i)).not.toBeInTheDocument()
    expect(window.location.search).toBe('')
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

// S2b: the page owns each confirmation attempt and manual operation, and only an
// owned, latest-started confirmation may refresh the real auth store's tuple.
type AuthStoreState = ReturnType<typeof useAuthStore.getState>
const ACCOUNT_A = { id: 'account-a', email: 'a@example.invalid', planId: 'early_monthly', isAdmin: false, onboardedAt: null }
const ACCOUNT_B = { id: 'account-b', email: 'b@example.invalid', planId: 'early_monthly', isAdmin: false, onboardedAt: null }
const STRIPE_RETURN = '/settings/subscription?payment_intent=pi_123&redirect_status=processing'

const confirmedEntitled = { ...baseSubscription, status: 'active', hostedAccess: 'entitled' }
const awaitingCard = {
  ...baseSubscription,
  status: 'trialing',
  trialPath: '7day',
  renewalDate: null,
  trial: { active: true, endsAt: '2026-07-17T00:00:00.000Z', daysRemaining: 7 },
  capabilities: { ...baseSubscription.capabilities, trialActive: true, needsPaymentMethod: true, canSetupCard: true },
  hostedAccess: 'entitled',
}
const cancelScheduled = {
  ...baseSubscription,
  cancelAtPeriodEnd: true,
  capabilities: { ...baseSubscription.capabilities, canResumeCancellation: true },
  hostedAccess: 'entitled',
}

// hostedAccess is not declared on the store yet; these casts only seed and read it.
function seedAccount(user: typeof ACCOUNT_A | null) {
  useAuthStore.setState({ user, isAuthenticated: user !== null, subscriptionStatus: null, hostedAccess: null } as unknown as Partial<AuthStoreState>)
}

function storeTuple(): [unknown, unknown] {
  const state = useAuthStore.getState() as AuthStoreState & { hostedAccess?: unknown }
  return [state.subscriptionStatus, state.hostedAccess]
}

/** An account boundary as the store publishes it: a new epoch, then the next user or none. */
function takeOver(user: typeof ACCOUNT_B | null) {
  act(() => {
    bumpAccountEpoch()
    seedAccount(user)
  })
}

function json(body: unknown) {
  return { ok: true, json: async () => body }
}

describe('SubscriptionPage S2b confirmation ownership and store refresh', () => {
  let inert: InertEmulation
  const openGates: Array<() => void> = []
  const unsubscribers: Array<() => void> = []

  /** A held value; cleanup releases anything a test left pending with its fallback. */
  function gate(fallback: unknown) {
    let resolve!: (value: unknown) => void
    const promise = new Promise<unknown>(done => { resolve = done })
    let open = true
    const release = (value: unknown) => {
      if (!open) return
      open = false
      resolve(value)
    }
    openGates.push(() => release(fallback))
    return { promise, release }
  }

  /**
   * The page's reads and the store's refresh share GET /subscription, so every
   * GET is counted; each takes the next responder and the last one repeats.
   */
  function routeBilling(responders: Array<() => unknown>, cancel?: () => unknown) {
    const calls = { gets: 0, cancels: 0 }
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://billing.test/subscription' && (!init?.method || init.method === 'GET')) {
        const responder = responders[Math.min(calls.gets, responders.length - 1)]
        calls.gets += 1
        return responder()
      }
      if (url === 'https://billing.test/subscription/cancel' && init?.method === 'POST' && cancel) {
        calls.cancels += 1
        return cancel()
      }
      if (isCurrentFlow(url)) return { ok: true, json: async () => ({ flow: null }) }
      return { ok: false, status: 404, json: async () => ({}) }
    }))
    return calls
  }

  function recordStoreTuples() {
    const seen: Array<[unknown, unknown]> = []
    unsubscribers.push(useAuthStore.subscribe(() => { seen.push(storeTuple()) }))
    return seen
  }

  /** Drains the page's and the store's fetch and JSON chains, optionally after advancing fake timers. */
  async function settle(advanceMs = 0) {
    await act(async () => {
      if (advanceMs > 0) vi.advanceTimersByTime(advanceMs)
      for (let tick = 0; tick < 25; tick += 1) await Promise.resolve()
    })
  }

  function startStripeReturn() {
    vi.useFakeTimers()
    window.history.replaceState({}, '', STRIPE_RETURN)
  }

  async function confirmCancellation() {
    fireEvent.click(await screen.findByRole('button', { name: /cancel subscription/i }))
    const dialog = await screen.findByRole('dialog', { name: /cancel your subscription/i })
    fireEvent.click(within(dialog).getByRole('button', { name: /^cancel subscription$/i }))
  }

  beforeEach(() => {
    vi.unstubAllGlobals()
    window.history.replaceState({}, '', '/settings/subscription')
    localStorage.removeItem('silentsuite-server-url')
    seedAccount(ACCOUNT_A)
    inert = emulateInert()
  })

  afterEach(async () => {
    cleanup()
    openGates.splice(0).forEach(release => release())
    await act(async () => {
      for (let tick = 0; tick < 25; tick += 1) await Promise.resolve()
    })
    unsubscribers.splice(0).forEach(unsubscribe => unsubscribe())
    vi.useRealTimers()
    vi.unstubAllGlobals()
    seedAccount(null)
    inert.restore()
  })

  it('[RED] a confirmed payment for the current account starts one account-bound store refresh that publishes the real tuple', async () => {
    startStripeReturn()
    const calls = routeBilling([() => json(confirmedEntitled)])
    const seen = recordStoreTuples()

    render(<SubscriptionPage />)
    await settle()
    await settle(10000)

    expect(screen.getByText('Active')).toBeInTheDocument()
    expect(storeTuple()).toEqual(['active', 'entitled'])
    expect(seen).toContainEqual(['active', 'entitled'])
    expect(seen).not.toContainEqual(['active', null])
    expect(calls.gets).toBe(2)
    expect(useAuthStore.getState().user).toBe(ACCOUNT_A)
  })

  // Supplement: originally [CTRL] on store/dispatch only; strengthened with the page-local
  // oracle (no A data or confirmation under B), which the unowned page publishes today.
  it('[RED] a takeover by account B during the poll fetch publishes no A page data, starts no refresh and leaves B unchanged', async () => {
    startStripeReturn()
    const first = gate(json(awaitingCard))
    const calls = routeBilling([() => first.promise, () => json(confirmedEntitled)])

    render(<SubscriptionPage />)
    await settle()
    expect(calls.gets).toBe(1)

    takeOver(ACCOUNT_B)
    first.release(json(confirmedEntitled))
    await settle()
    expect(screen.queryByText('Active')).not.toBeInTheDocument()
    await settle(10000)

    expect(calls.gets).toBe(1)
    expect(screen.queryByText('Active')).not.toBeInTheDocument()
    expect(useAuthStore.getState().user).toBe(ACCOUNT_B)
    expect(storeTuple()).toEqual([null, null])
  })

  it.each([
    ['fetch rejection (catch)', (released: Promise<unknown>) => () => released.then(() => { throw new TypeError('synthetic network failure') })],
    ['JSON rejection', (released: Promise<unknown>) => () => ({ ok: true, json: () => released.then(() => { throw new SyntaxError('synthetic malformed body') }) })],
  ])('[RED] an ordinary %s after a takeover by account B completes no loading, failure, data, refresh or next dispatch', async (_label, responder) => {
    startStripeReturn()
    const first = gate(null)
    const calls = routeBilling([responder(first.promise), () => json(confirmedEntitled)])

    render(<SubscriptionPage />)
    await settle()
    expect(calls.gets).toBe(1)

    takeOver(ACCOUNT_B)
    first.release(null)
    await settle()

    expect(screen.queryByText(/confirming your payment/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/payment needs attention/i)).not.toBeInTheDocument()
    await settle(10000)
    expect(calls.gets).toBe(1)
    expect(screen.queryByText(/payment needs attention/i)).not.toBeInTheDocument()
    expect(useAuthStore.getState().user).toBe(ACCOUNT_B)
    expect(storeTuple()).toEqual([null, null])
  })

  it('[RED] the final poll completing after a takeover by account B publishes no failure or retry action', async () => {
    startStripeReturn()
    const final = gate(json(awaitingCard))
    const calls = routeBilling([() => json(awaitingCard), () => json(awaitingCard), () => json(awaitingCard), () => final.promise])

    render(<SubscriptionPage />)
    await settle()
    await settle(5000)
    expect(calls.gets).toBe(3)
    await settle(5000)
    expect(calls.gets).toBe(4)

    takeOver(ACCOUNT_B)
    final.release(json(awaitingCard))
    await settle()

    expect(screen.queryByText(/payment needs attention/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /retry payment status/i })).not.toBeInTheDocument()
    expect(calls.gets).toBe(4)
    expect(storeTuple()).toEqual([null, null])
  })

  it('[RED] a manual "Retry payment status" on A\'s page after a takeover by account B starts no attempt or request', async () => {
    startStripeReturn()
    const calls = routeBilling([() => json(awaitingCard)])

    render(<SubscriptionPage />)
    await settle()
    await settle(10000)
    expect(calls.gets).toBe(4)
    const retry = screen.getByRole('button', { name: /retry payment status/i })

    takeOver(ACCOUNT_B)
    fireEvent.click(retry)
    await settle()
    await settle(10000)

    expect(calls.gets).toBe(4)
    expect(screen.queryByText(/confirming your payment/i)).not.toBeInTheDocument()
    expect(useAuthStore.getState().user).toBe(ACCOUNT_B)
    expect(storeTuple()).toEqual([null, null])
  })

  it('[CTRL] a cancellation request rejected after a takeover by account B reads nothing and starts no refresh', async () => {
    const cancel = gate(null)
    const calls = routeBilling([() => json(baseSubscription), () => json(cancelScheduled)], () => cancel.promise.then(() => { throw new TypeError('synthetic network failure') }))

    render(<SubscriptionPage />)
    await confirmCancellation()
    await settle()
    expect(calls.cancels).toBe(1)

    takeOver(ACCOUNT_B)
    cancel.release(null)
    await settle()

    expect(calls.gets).toBe(1)
    expect(useAuthStore.getState().user).toBe(ACCOUNT_B)
    expect(storeTuple()).toEqual([null, null])
  })

  it('[RED] a takeover by account B while the poll JSON is pending publishes no A page data, starts no refresh and leaves B unchanged', async () => {
    startStripeReturn()
    const body = gate(awaitingCard)
    let jsonRequested = false
    const calls = routeBilling([() => ({ ok: true, json: () => { jsonRequested = true; return body.promise } })])

    render(<SubscriptionPage />)
    await settle()
    expect(jsonRequested).toBe(true)

    takeOver(ACCOUNT_B)
    body.release(confirmedEntitled)
    await settle()
    expect(screen.queryByText('Active')).not.toBeInTheDocument()
    await settle(10000)

    expect(calls.gets).toBe(1)
    expect(screen.queryByText('Active')).not.toBeInTheDocument()
    expect(useAuthStore.getState().user).toBe(ACCOUNT_B)
    expect(storeTuple()).toEqual([null, null])
  })

  it('[RED] a takeover by account B before a scheduled poll fires dispatches no GET', async () => {
    startStripeReturn()
    const calls = routeBilling([() => json(awaitingCard), () => json(confirmedEntitled)])

    render(<SubscriptionPage />)
    await settle()
    expect(calls.gets).toBe(1)
    expect(screen.getByText(/confirming your payment/i)).toBeInTheDocument()

    takeOver(ACCOUNT_B)
    await settle(2000)
    expect(calls.gets).toBe(1)
    await settle(10000)

    expect(calls.gets).toBe(1)
    expect(useAuthStore.getState().user).toBe(ACCOUNT_B)
    expect(storeTuple()).toEqual([null, null])
  })

  it('[RED] logout before a scheduled poll fires dispatches no GET', async () => {
    startStripeReturn()
    const calls = routeBilling([() => json(awaitingCard), () => json(confirmedEntitled)])

    render(<SubscriptionPage />)
    await settle()
    expect(calls.gets).toBe(1)

    takeOver(null)
    await settle(2000)
    expect(calls.gets).toBe(1)
    await settle(10000)

    expect(calls.gets).toBe(1)
    expect(useAuthStore.getState().user).toBeNull()
    expect(storeTuple()).toEqual([null, null])
  })

  it('[RED] an older poll response while the latest-started poll is pending publishes no data or confirmation', async () => {
    startStripeReturn()
    const first = gate(json(awaitingCard))
    const second = gate(json(awaitingCard))
    const calls = routeBilling([() => first.promise, () => second.promise, () => json(awaitingCard)])

    render(<SubscriptionPage />)
    await settle()
    await settle(2000)
    expect(calls.gets).toBe(2)

    first.release(json(confirmedEntitled))
    await settle()

    expect(screen.queryByText('Active')).not.toBeInTheDocument()
    expect(calls.gets).toBe(2)
    expect(storeTuple()).toEqual([null, null])

    second.release(json(awaitingCard))
    await settle()

    expect(screen.getByText('Trialing')).toBeInTheDocument()
    expect(screen.getByText(/confirming your payment/i)).toBeInTheDocument()
    expect(screen.queryByText('Active')).not.toBeInTheDocument()
    expect(storeTuple()).toEqual([null, null])
  })

  it('[CTRL] a superseded attempt\'s late confirmed response publishes nothing and starts no refresh', async () => {
    startStripeReturn()
    const first = gate(json(awaitingCard))
    const calls = routeBilling([() => first.promise, () => json(awaitingCard)])

    render(<SubscriptionPage />)
    await settle()
    await settle(10000)
    expect(calls.gets).toBe(4)

    fireEvent.click(screen.getByRole('button', { name: /retry payment status/i }))
    await settle()
    expect(calls.gets).toBe(5)
    expect(screen.getByText(/confirming your payment/i)).toBeInTheDocument()

    first.release(json(confirmedEntitled))
    await settle()

    expect(screen.queryByText('Active')).not.toBeInTheDocument()
    expect(screen.getByText(/confirming your payment/i)).toBeInTheDocument()
    expect(calls.gets).toBe(5)
    expect(storeTuple()).toEqual([null, null])
  })

  it('[CTRL] unmount with a pending poll dispatches nothing more and leaves the store unchanged', async () => {
    startStripeReturn()
    const first = gate(json(awaitingCard))
    const calls = routeBilling([() => first.promise, () => json(confirmedEntitled)])

    const { unmount } = render(<SubscriptionPage />)
    await settle()
    expect(calls.gets).toBe(1)

    unmount()
    first.release(json(confirmedEntitled))
    await settle()
    await settle(10000)

    expect(calls.gets).toBe(1)
    expect(useAuthStore.getState().user).toBe(ACCOUNT_A)
    expect(storeTuple()).toEqual([null, null])
  })

  it('[RED] a cancellation that completes after a takeover by account B reads nothing and starts no refresh', async () => {
    const cancel = gate({ ok: false, status: 503, json: async () => ({}) })
    const calls = routeBilling([() => json(baseSubscription), () => json(cancelScheduled)], () => cancel.promise)

    render(<SubscriptionPage />)
    await confirmCancellation()
    await settle()
    expect(calls.cancels).toBe(1)
    expect(calls.gets).toBe(1)

    takeOver(ACCOUNT_B)
    cancel.release(json({}))
    await settle()

    expect(calls.gets).toBe(1)
    expect(screen.queryByText(/subscription will be cancelled/i)).not.toBeInTheDocument()
    expect(useAuthStore.getState().user).toBe(ACCOUNT_B)
    expect(storeTuple()).toEqual([null, null])
  })

  it('[CTRL] a same-account cancellation still re-reads the subscription through the page owner', async () => {
    const calls = routeBilling([() => json(baseSubscription), () => json(cancelScheduled)], () => json({}))

    render(<SubscriptionPage />)
    await confirmCancellation()

    expect(await screen.findByText(/subscription will be cancelled/i)).toBeInTheDocument()
    expect(calls.cancels).toBe(1)
    expect(calls.gets).toBeGreaterThanOrEqual(2)
    expect(screen.queryByRole('dialog', { name: /cancel your subscription/i })).not.toBeInTheDocument()
  })

  // Same account, fresh user object (e.g. onboarding metadata or a same-id retry publication),
  // with no epoch or account transition: a NEW explicit operation is the current account's.
  it('[RED] a new manual cancellation after a same-account fresh user publication still cancels and re-reads', async () => {
    const calls = routeBilling([() => json(baseSubscription), () => json(cancelScheduled)], () => json({}))

    render(<SubscriptionPage />)
    expect(await screen.findByText('Active')).toBeInTheDocument()
    act(() => { useAuthStore.setState({ user: { ...ACCOUNT_A, onboardedAt: '2026-10-28T00:00:00.000Z' } } as unknown as Partial<AuthStoreState>) })

    await confirmCancellation()
    await settle()

    expect(calls.cancels).toBe(1)
    expect(await screen.findByText(/subscription will be cancelled/i)).toBeInTheDocument()
    expect(calls.gets).toBe(2)
  })

  it('[RED] a new manual "Retry payment status" after a same-account fresh user publication starts a new attempt', async () => {
    startStripeReturn()
    const calls = routeBilling([() => json(awaitingCard)])

    render(<SubscriptionPage />)
    await settle()
    await settle(10000)
    expect(calls.gets).toBe(4)
    act(() => { useAuthStore.setState({ user: { ...ACCOUNT_A } } as unknown as Partial<AuthStoreState>) })

    fireEvent.click(screen.getByRole('button', { name: /retry payment status/i }))
    await settle()

    expect(calls.gets).toBe(5)
    expect(screen.getByText(/confirming your payment/i)).toBeInTheDocument()
  })

  it('[CTRL] a poll in flight before a same-account fresh user publication stays bound to its origin and publishes nothing', async () => {
    startStripeReturn()
    const first = gate(json(awaitingCard))
    const calls = routeBilling([() => first.promise, () => json(confirmedEntitled)])

    render(<SubscriptionPage />)
    await settle()
    act(() => { useAuthStore.setState({ user: { ...ACCOUNT_A } } as unknown as Partial<AuthStoreState>) })
    first.release(json(confirmedEntitled))
    await settle()
    await settle(10000)

    expect(screen.queryByText('Active')).not.toBeInTheDocument()
    expect(calls.gets).toBe(1)
    expect(storeTuple()).toEqual([null, null])
  })

  // Final-review corrections (A, B).
  it('[RED] "Review payment options" on A\'s page after a takeover by account B mounts no payment panel and reads nothing for B', async () => {
    startStripeReturn()
    const calls = routeBilling([() => json(awaitingCard)])

    render(<SubscriptionPage />)
    await settle()
    await settle(10000)
    const review = screen.getByRole('button', { name: /review payment options/i })
    const before = vi.mocked(fetch).mock.calls.length

    takeOver(ACCOUNT_B)
    fireEvent.click(review)
    await settle()

    expect(screen.queryByRole('dialog', { name: /continue with silentsuite\.io/i })).not.toBeInTheDocument()
    expect(vi.mocked(fetch).mock.calls.length).toBe(before)
    expect(calls.gets).toBe(4)
  })

  it('[RED] a same-account fresh user publication during the cancellation POST leaves the dialog usable for a new cancellation', async () => {
    const firstCancel = gate({ ok: false, status: 503, json: async () => ({}) })
    let cancelRequests = 0
    const calls = routeBilling([() => json(baseSubscription), () => json(cancelScheduled)],
      () => (++cancelRequests === 1 ? firstCancel.promise : json({})))

    render(<SubscriptionPage />)
    await confirmCancellation()
    await settle()
    expect(calls.cancels).toBe(1)

    act(() => { useAuthStore.setState({ user: { ...ACCOUNT_A } } as unknown as Partial<AuthStoreState>) })
    firstCancel.release(json({}))
    await settle()

    // The old operation publishes and re-reads nothing, but the current account's dialog is not wedged.
    expect(calls.gets).toBe(1)
    const dialog = screen.getByRole('dialog', { name: /cancel your subscription/i })
    expect(within(dialog).queryByRole('button', { name: /cancelling/i })).not.toBeInTheDocument()
    const confirm = within(dialog).getByRole('button', { name: /^cancel subscription$/i })
    expect(confirm).not.toBeDisabled()
    fireEvent.click(confirm)
    expect(await screen.findByText(/subscription will be cancelled/i)).toBeInTheDocument()
    expect(calls.cancels).toBe(2)
  })

  // Second-review correction: the ordinary initial read (no confirmation attempt).
  it('[RED] a same-account fresh user publication during the held initial read rejects that response and loads through a fresh owned read', async () => {
    const first = gate(json(baseSubscription))
    const calls = routeBilling([() => first.promise, () => json(baseSubscription)])

    render(<SubscriptionPage />)
    await settle()
    expect(calls.gets).toBe(1)

    act(() => { useAuthStore.setState({ user: { ...ACCOUNT_A } } as unknown as Partial<AuthStoreState>) })
    // The stale response would show a different status; it must never be published.
    first.release(json({ ...baseSubscription, status: 'cancelled', capabilities: { ...baseSubscription.capabilities, canReactivate: true } }))
    await settle()

    expect(calls.gets).toBe(2)
    expect(screen.getByText('Active')).toBeInTheDocument()
    expect(screen.queryByText('Cancelled')).not.toBeInTheDocument()
  })

  it('[CTRL] a takeover by account B during the held initial read publishes nothing, completes no loading and reads nothing more', async () => {
    const first = gate(json(baseSubscription))
    const calls = routeBilling([() => first.promise, () => json(baseSubscription)])

    render(<SubscriptionPage />)
    await settle()
    expect(calls.gets).toBe(1)

    takeOver(ACCOUNT_B)
    first.release(json(baseSubscription))
    await settle()

    expect(calls.gets).toBe(1)
    expect(screen.queryByText('Active')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /cancel subscription/i })).not.toBeInTheDocument()
    expect(useAuthStore.getState().user).toBe(ACCOUNT_B)
    expect(storeTuple()).toEqual([null, null])
  })

  it('[RED] a same-account fresh user publication during a confirmation attempt ends it with the existing retry action', async () => {
    startStripeReturn()
    const calls = routeBilling([() => json(awaitingCard)])

    render(<SubscriptionPage />)
    await settle()
    expect(calls.gets).toBe(1)
    expect(screen.getByText(/confirming your payment/i)).toBeInTheDocument()

    act(() => { useAuthStore.setState({ user: { ...ACCOUNT_A } } as unknown as Partial<AuthStoreState>) })
    await settle(2000)

    // The old attempt dispatches nothing more and is not left confirming forever.
    expect(calls.gets).toBe(1)
    expect(screen.queryByText(/confirming your payment/i)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /retry payment status/i }))
    await settle()
    expect(calls.gets).toBe(2)
    expect(screen.getByText(/confirming your payment/i)).toBeInTheDocument()
  })
})
