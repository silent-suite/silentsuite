'use client'

import { useEffect, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import { Crown, Lock, Zap } from 'lucide-react'
import { Button } from '@silentsuite/ui'
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

type PaymentOption = {
  id: string
  provider: 'stripe' | 'btcpay' | 'notice'
  planIds?: string[]
  billingIntervals?: BillingInterval[]
  entitlementPreview?: string
  enabled: boolean
  disabledReason?: string
}

interface PaymentChoicePanelProps {
  onSuccess: () => void | Promise<void>
  onCancel?: () => void
  initialInterval?: BillingInterval
  title?: string
  successPoll?: () => void | Promise<void>
}

function BillingToggle({ interval, onChange }: { interval: BillingInterval; onChange: (interval: BillingInterval) => void }) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-0.5">
      <button
        onClick={() => onChange('monthly')}
        className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
          interval === 'monthly' ? 'bg-[rgb(var(--primary))] text-white' : 'text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))]'
        }`}
      >
        Monthly
      </button>
      <button
        onClick={() => onChange('annual')}
        className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
          interval === 'annual' ? 'bg-[rgb(var(--primary))] text-white' : 'text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))]'
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

function safeBtcpayUrl(rawUrl: string): string {
  const checkoutUrl = new URL(rawUrl)
  if (checkoutUrl.protocol !== 'https:' || checkoutUrl.origin !== 'https://btcpay.silentsuite.io') {
    throw new Error('Bitcoin checkout returned an unexpected payment URL.')
  }
  return checkoutUrl.toString()
}

export default function PaymentChoicePanel({
  onSuccess,
  onCancel,
  initialInterval = 'monthly',
  title = 'Continue with silentsuite.io',
  successPoll,
}: PaymentChoicePanelProps) {
  const [interval, setInterval] = useState<BillingInterval>(initialInterval)
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [options, setOptions] = useState<PaymentOption[]>([])
  const [optionsLoaded, setOptionsLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function loadOptions() {
      setOptionsLoaded(false)
      try {
        const res = await fetch(`${BILLING_API_URL}/subscription/payment-options?interval=${interval}`, { credentials: 'include' })
        if (!res.ok) {
          if (!cancelled) setOptions([])
          return
        }
        const data = await res.json()
        if (!cancelled) setOptions(Array.isArray(data.options) ? data.options : [])
      } catch {
        if (!cancelled) setOptions([])
      } finally {
        if (!cancelled) setOptionsLoaded(true)
      }
    }
    void loadOptions()
    return () => { cancelled = true }
  }, [interval])

  const stripeOption = useMemo(() => options.find(option => option.id === 'stripe_pay_now' && option.enabled), [options])
  const btcpayAnnualOption = useMemo(() => options.find(option => option.id === 'btcpay_annual' && option.enabled), [options])
  const bitcoinSwitchOption = useMemo(() => options.find(option => option.id === 'bitcoin_annual_switch' && option.enabled), [options])
  const planId = stripeOption?.planIds?.[0] ?? (interval === 'monthly' ? 'early_monthly' : 'early_annual')

  const startStripe = async () => {
    setLoading('stripe')
    setError(null)
    try {
      const res = await fetch(`${BILLING_API_URL}/subscription/payment-flows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ flowKind: 'stripe_pay_now', planId }),
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
      setLoading(null)
    }
  }

  const startBtcpay = async () => {
    setLoading('btcpay')
    setError(null)
    try {
      const annualRes = await fetch(`${BILLING_API_URL}/subscription/payment-options?interval=annual`, { credentials: 'include' })
      if (!annualRes.ok) throw new Error('Bitcoin checkout is not available for this account state.')
      const annualData = await annualRes.json()
      const annualOptions = Array.isArray(annualData.options) ? annualData.options as PaymentOption[] : []
      const option = annualOptions.find(candidate => candidate.id === 'btcpay_annual' && candidate.enabled)
      if (!option) throw new Error('Bitcoin checkout is not available for this account state.')
      const res = await fetch(`${BILLING_API_URL}/subscription/payment-flows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ flowKind: 'btcpay_annual', planId: option.planIds?.[0] ?? 'early_annual', returnUrl: '/settings/subscription' }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(data?.detail ?? 'Bitcoin checkout is not available.')
      }
      const data = await res.json()
      window.location.href = safeBtcpayUrl(data.checkoutUrl)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start Bitcoin checkout.')
    } finally {
      setLoading(null)
    }
  }

  if (clientSecret) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Crown className="h-4 w-4 text-amber-400" />
              <span className="text-sm font-medium text-[rgb(var(--foreground))]">Early Adopter</span>
            </div>
            <PriceDisplay interval={interval} />
          </div>
          <p className="mt-1 text-xs text-[rgb(var(--muted))]">14 bonus days included after today&apos;s payment.</p>
        </div>
        <StripePaymentForm
          clientSecret={clientSecret}
          onSuccess={async () => {
            await onSuccess()
            await successPoll?.()
          }}
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
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold text-[rgb(var(--foreground))]">{title}</h2>
      <div className="rounded-xl border border-emerald-500/50 bg-emerald-500/5 p-4 text-left">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-[rgb(var(--border))] p-2 shrink-0">
            <Zap className="h-4 w-4 text-amber-400" />
          </div>
          <div>
            <h3 className="font-medium text-[rgb(var(--foreground))]">Pay now + 14 bonus days</h3>
            <p className="mt-0.5 text-xs text-[rgb(var(--muted))]">Choose monthly card, annual card, or annual Bitcoin when available.</p>
          </div>
        </div>
      </div>

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

      {bitcoinSwitchOption && interval === 'monthly' && (
        <button
          type="button"
          onClick={() => setInterval('annual')}
          className="w-full rounded-xl border border-amber-500/25 bg-amber-500/5 p-4 text-left transition-colors hover:bg-amber-500/10"
        >
          <h3 className="font-medium text-[rgb(var(--foreground))]">Prefer Bitcoin?</h3>
          <p className="mt-0.5 text-xs text-[rgb(var(--muted))]">Bitcoin payments are annual only. Switch to annual billing to pay with Bitcoin.</p>
        </button>
      )}

      {interval === 'annual' && btcpayAnnualOption && (
        <Button onClick={startBtcpay} disabled={loading !== null} variant="outline" className="w-full">
          {loading === 'btcpay' ? 'Opening Bitcoin checkout...' : 'Pay annual with Bitcoin'}
        </Button>
      )}

      {!optionsLoaded ? (
        <Button disabled className="w-full">
          Loading payment options...
        </Button>
      ) : stripeOption ? (
        <Button onClick={startStripe} disabled={loading !== null} className="w-full">
          {loading === 'stripe' ? 'Setting up...' : 'Continue to card payment'}
        </Button>
      ) : (
        <p className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-3 text-sm text-[rgb(var(--muted))]">
          Payment options are not available for this account state.
        </p>
      )}

      {onCancel && (
        <Button variant="outline" size="sm" onClick={onCancel} disabled={loading !== null} className="w-full">
          Cancel
        </Button>
      )}
    </div>
  )
}
