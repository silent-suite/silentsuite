'use client'

import { useState } from 'react'
import { CreditCard, Clock, X } from 'lucide-react'
import { Button } from '@silentsuite/ui'
import PaymentChoicePanel from './payment-choice-panel'

interface AddCardBannerProps {
  daysRemaining: number
  onCardAdded: () => void
}

function AddCardModal({
  onClose,
  onCardAdded,
}: {
  onClose: () => void
  onCardAdded: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(var(--background))]/80 backdrop-blur-sm">
      <div className="mx-4 w-full max-w-md rounded-xl border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-6 space-y-5">
        <div className="flex items-center justify-between">
          <span className="sr-only">Payment options</span>
          <button onClick={onClose} className="ml-auto text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>
        <PaymentChoicePanel onSuccess={onCardAdded} title="Continue with silentsuite.io" />
      </div>
    </div>
  )
}

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
              Subscribe by card or annual Bitcoin and get 14 bonus days. If you do nothing, your account becomes read-only when the trial ends.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setShowModal(true)}>
            <CreditCard className="h-3.5 w-3.5 mr-1.5" />
            Choose payment
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
