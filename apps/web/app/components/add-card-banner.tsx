'use client'

import { useState } from 'react'
import { CreditCard, Clock, X, Lock, Zap, Crown } from 'lucide-react'
import { Button } from '@silentsuite/ui'
import dynamic from 'next/dynamic'
import { BILLING_API_URL } from '@/app/lib/config'

const StripePaymentForm = dynamic(() => import('./stripe-payment-form'), {
  loading: () => (
    <div className="flex flex-col items-center justify-center py-8">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
      <p className="mt-3 text-sm text-[rgb(var(--muted))]">Loading payment form...</p>
    </div>
  ),
  ssr: false,
})

type BillingInterval = 'monthly' | 'annual'

interface AddCardBannerProps {
  daysRemaining: number
  onCardAdded: () => void
}

// ---------------------------------------------------------------------------
// Billing toggle (compact)
// ---------------------------------------------------------------------------

function BillingToggle({
  interval,
  onChange,
}: {
  interval: BillingInterval
  onChange: (interval: BillingInterval) => void
}) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-0.5">
      <button
        onClick={() => onChange('monthly')}
        className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
          interval === 'monthly'
            ? 'bg-[rgb(var(--primary))] text-white'
            : 'text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))]'
        }`}
      >
        Monthly
      </button>
      <button
        onClick={() => onChange('annual')}
        className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
          interval === 'annual'
            ? 'bg-[rgb(var(--primary))] text-white'
            : 'text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))]'
        }`}
      >
        Annual
      </button>
    </div>
  )
}

function PriceDisplay({ interval }: { interval: BillingInterval }) {
  if (interval === 'monthly') {
    return (
      <span className="text-sm font-medium text-[rgb(var(--foreground))]">
        &euro;3.60<span className="text-[rgb(var(--muted))]">/mo</span>
      </span>
    )
  }
  return (
    <span className="text-sm font-medium text-[rgb(var(--foreground))]">
      &euro;36<span className="text-[rgb(var(--muted))]">/yr</span>
      <span className="ml-1 text-xs text-emerald-600 dark:text-emerald-500">(&euro;3/mo)</span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Full-screen modal for adding card
// ---------------------------------------------------------------------------

function AddCardModal({
  onClose,
  onCardAdded,
}: {
  onClose: () => void
  onCardAdded: () => void
}) {
  const [interval, setInterval] = useState<BillingInterval>('monthly')
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const planId = interval === 'monthly' ? 'early_monthly' : 'early_annual'

  const handleContinue = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${BILLING_API_URL}/subscription/setup-card`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ planId, trialPath: 'immediate' }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(data?.detail ?? 'Failed to set up payment')
      }
      const data = await res.json()
      setClientSecret(data.clientSecret)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(var(--background))]/80 backdrop-blur-sm">
      <div className="mx-4 w-full max-w-md rounded-xl border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-6 space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-[rgb(var(--foreground))]">
            Continue with silentsuite.io
          </h2>
          <button onClick={onClose} className="text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>

        {!clientSecret ? (
          <>
            {/* Pay now summary */}
            <div className="rounded-xl border border-emerald-500/50 bg-emerald-500/5 p-4 text-left">
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-[rgb(var(--border))] p-2 shrink-0">
                  <Zap className="h-4 w-4 text-amber-400" />
                </div>
                <div>
                  <h3 className="font-medium text-[rgb(var(--foreground))]">Pay now + 14 bonus days</h3>
                  <p className="mt-0.5 text-xs text-[rgb(var(--muted))]">
                    Choose monthly or annual. Your card is charged now.
                  </p>
                </div>
                <div className="ml-auto shrink-0 rounded-full bg-emerald-500 p-0.5">
                  <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                </div>
              </div>
            </div>

            {/* Billing toggle + price */}
            <div className="flex items-center justify-between">
              <BillingToggle interval={interval} onChange={setInterval} />
              <div className="flex items-center gap-2">
                <Crown className="h-3.5 w-3.5 text-amber-400" />
                <PriceDisplay interval={interval} />
              </div>
            </div>

            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              </div>
            )}

            <Button onClick={handleContinue} disabled={loading} className="w-full">
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  Setting up...
                </span>
              ) : (
                'Continue to payment'
              )}
            </Button>
          </>
        ) : (
          <>
            {/* Payment summary */}
            <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Crown className="h-4 w-4 text-amber-400" />
                  <span className="text-sm font-medium text-[rgb(var(--foreground))]">Early Adopter</span>
                </div>
                <PriceDisplay interval={interval} />
              </div>
              <p className="mt-1 text-xs text-[rgb(var(--muted))]">
                14 bonus days included after today&apos;s payment.
              </p>
            </div>

            {/* Stripe form */}
            <StripePaymentForm
              clientSecret={clientSecret}
              onSuccess={onCardAdded}
              submitLabel={`Pay ${interval === 'monthly' ? '\u20AC3.60' : '\u20AC36'}`}
              mode="payment"
            />

            <div className="flex items-center justify-center gap-1.5 text-xs text-[rgb(var(--muted))]">
              <Lock className="h-3 w-3 text-emerald-500" />
              <span>Secured by Stripe. We never see your card details.</span>
            </div>

            <button
              onClick={() => setClientSecret(null)}
              className="w-full text-center text-xs text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors"
            >
              &larr; Back to options
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Banner component (shown in settings/subscription)
// ---------------------------------------------------------------------------

export default function AddCardBanner({ daysRemaining, onCardAdded }: AddCardBannerProps) {
  const [showModal, setShowModal] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  if (dismissed) return null

  return (
    <>
      <div className="flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
        <div className="flex items-center gap-3">
          <Clock className="h-4 w-4 text-amber-700 dark:text-amber-400" />
          <div>
            <p className="text-sm text-amber-700 dark:text-amber-400">
              {daysRemaining} day{daysRemaining !== 1 ? 's' : ''} left in your trial
            </p>
            <p className="text-xs text-[rgb(var(--muted))]">
              Add a card to continue with silentsuite.io
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setShowModal(true)}>
            <CreditCard className="h-3.5 w-3.5 mr-1.5" />
            Add payment method
          </Button>
          <button onClick={() => setDismissed(true)} className="text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))]">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {showModal && (
        <AddCardModal
          onClose={() => setShowModal(false)}
          onCardAdded={() => {
            setShowModal(false)
            onCardAdded()
          }}
        />
      )}
    </>
  )
}
