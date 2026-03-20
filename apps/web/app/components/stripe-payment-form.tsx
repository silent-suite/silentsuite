'use client'

import { useState } from 'react'
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js'
import { loadStripe } from '@stripe/stripe-js'
import { Button } from '@silentsuite/ui'

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!)

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
      <PaymentElement />
      {error && <p className="text-sm text-red-400">{error}</p>}
      <Button type="submit" disabled={!stripe || loading} className="w-full">
        {loading ? 'Processing...' : (submitLabel ?? 'Confirm payment')}
      </Button>
    </form>
  )
}

export default function StripePaymentForm(props: PaymentFormProps) {
  return (
    <Elements stripe={stripePromise} options={{ clientSecret: props.clientSecret, appearance }}>
      <PaymentFormInner
        onSuccess={props.onSuccess}
        onError={props.onError}
        submitLabel={props.submitLabel}
        mode={props.mode}
      />
    </Elements>
  )
}
