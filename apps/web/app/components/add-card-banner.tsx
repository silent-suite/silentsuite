'use client'

import { useState } from 'react'
import { CreditCard, Clock, X } from 'lucide-react'
import { Button } from '@silentsuite/ui'
import StripePaymentForm from './stripe-payment-form'

const BILLING_API_URL = process.env.NEXT_PUBLIC_BILLING_API_URL ?? 'http://localhost:3736'

interface AddCardBannerProps {
  daysRemaining: number
  planId: string
  onCardAdded: () => void
}

export default function AddCardBanner({ daysRemaining, planId, onCardAdded }: AddCardBannerProps) {
  const [showForm, setShowForm] = useState(false)
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [loading, setLoading] = useState(false)

  if (dismissed) return null

  const handleAddCard = async () => {
    setLoading(true)
    try {
      const res = await fetch(`${BILLING_API_URL}/subscription/setup-card`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ planId }),
      })
      if (res.ok) {
        const data = await res.json()
        setClientSecret(data.clientSecret)
        setShowForm(true)
      }
    } catch {
      // handle error
    } finally {
      setLoading(false)
    }
  }

  if (showForm && clientSecret) {
    return (
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-[rgb(var(--foreground))]">
            Add your card — get 23 more free days
          </h3>
          <button onClick={() => { setShowForm(false); setClientSecret(null) }}>
            <X className="h-4 w-4 text-[rgb(var(--muted))]" />
          </button>
        </div>
        <StripePaymentForm
          clientSecret={clientSecret}
          onSuccess={onCardAdded}
          submitLabel="Save card & extend trial"
          mode="setup"
        />
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
      <div className="flex items-center gap-3">
        <Clock className="h-4 w-4 text-amber-400" />
        <div>
          <p className="text-sm text-amber-400">
            {daysRemaining} day{daysRemaining !== 1 ? 's' : ''} left in your trial
          </p>
          <p className="text-xs text-[rgb(var(--muted))]">
            Add a card to extend to 30 days free
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleAddCard} disabled={loading}>
          <CreditCard className="h-3.5 w-3.5 mr-1.5" />
          {loading ? 'Loading...' : 'Add card'}
        </Button>
        <button onClick={() => setDismissed(true)} className="text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))]">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
