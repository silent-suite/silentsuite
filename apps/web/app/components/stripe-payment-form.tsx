'use client'

import { useState, useEffect } from 'react'
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js'
import { loadStripe, type Stripe } from '@stripe/stripe-js'
import { Button } from '@silentsuite/ui'

const STRIPE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY

// Stripe Elements appearance matching our dark theme
const appearance = {
  theme: 'night' as const,
  variables: {
    colorPrimary: '#10b981', // emerald-500
    colorBackground: 'rgb(15, 23, 42)', // slate-900ish
    colorText: '#e2e8f0',
    colorDanger: '#ef4444',
    fontFamily: 'Inter, system-ui, sans-serif',
    borderRadius: '8px',
  },
}

interface PaymentFormProps {
  clientSecret: string
  onSuccess: () => void
  onError?: (error: string) => void
  submitLabel?: string
  mode?: 'setup' | 'payment' // setup = SetupIntent (trial), payment = PaymentIntent (immediate)
}

function PaymentFormInner({ onSuccess, onError, submitLabel, mode }: Omit<PaymentFormProps, 'clientSecret'>) {
  const stripe = useStripe()
  const elements = useElements()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!stripe || !elements) return

    setLoading(true)
    setError(null)

    let result
    if (mode === 'setup') {
      result = await stripe.confirmSetup({
        elements,
        confirmParams: { return_url: `${window.location.origin}/signup/success` },
        redirect: 'if_required',
      })
    } else {
      result = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: `${window.location.origin}/signup/success` },
        redirect: 'if_required',
      })
    }

    if (result.error) {
      const msg = result.error.message ?? 'Payment failed'
      setError(msg)
      onError?.(msg)
      setLoading(false)
    } else {
      onSuccess()
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {!ready && (
        <div className="flex flex-col items-center justify-center py-6">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
          <p className="mt-2 text-xs text-slate-500">Loading payment form...</p>
        </div>
      )}
      <div className={ready ? '' : 'sr-only'}>
        <PaymentElement onReady={() => setReady(true)} />
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {ready && (
        <Button type="submit" disabled={!stripe || loading} className="w-full">
          {loading ? 'Processing...' : (submitLabel ?? 'Confirm payment')}
        </Button>
      )}
    </form>
  )
}

export default function StripePaymentForm(props: PaymentFormProps) {
  const [stripeInstance, setStripeInstance] = useState<Stripe | null>(null)
  const [stripeError, setStripeError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!STRIPE_KEY) {
      setStripeError('Payment system not configured. Please contact support.')
      setLoading(false)
      return
    }
    loadStripe(STRIPE_KEY).then((s) => {
      if (s) {
        setStripeInstance(s)
      } else {
        setStripeError('Failed to load payment system. Please refresh and try again.')
      }
      setLoading(false)
    }).catch(() => {
      setStripeError('Failed to load payment system. Please refresh and try again.')
      setLoading(false)
    })
  }, [])

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-8">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
        <p className="mt-3 text-sm text-slate-400">Connecting to payment system...</p>
      </div>
    )
  }

  if (stripeError) {
    return (
      <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-center">
        <p className="text-sm text-red-400">{stripeError}</p>
        <p className="mt-1 text-xs text-slate-500">Error code: STRIPE_INIT</p>
      </div>
    )
  }

  if (!stripeInstance) {
    return (
      <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-center">
        <p className="text-sm text-red-400">Payment system unavailable. Please refresh the page.</p>
      </div>
    )
  }

  return (
    <Elements stripe={stripeInstance} options={{ clientSecret: props.clientSecret, appearance }}>
      <PaymentFormInner
        onSuccess={props.onSuccess}
        onError={props.onError}
        submitLabel={props.submitLabel}
        mode={props.mode}
      />
    </Elements>
  )
}
