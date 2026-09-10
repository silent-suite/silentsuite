'use client'

import { useEffect, useRef, useState } from 'react'
import { BILLING_API_URL } from '@/app/lib/config'
import { cancelAnonymousPaymentSessionRecovery, type AnnualProvider } from '@/app/lib/billing-v2'
import { useAuthStore } from '@/app/stores/use-auth-store'

export const PAYMENT_BACK_COPY = {
  btcpay: {
    title: 'Cancel this Bitcoin payment?',
    body: 'Only continue if you haven’t sent payment. This checkout will be cancelled. Do not send Bitcoin or Lightning to its old payment details.',
  },
  stripe: {
    title: 'Leave card checkout?',
    body: 'Only continue if you haven’t confirmed a payment. This card checkout will be cancelled.',
  },
} as const
export const PAYMENT_BACK_CONFIRM = 'Cancel and go back'
export const PAYMENT_BACK_STAY = 'Stay'
export const PAYMENT_BACK_UNCONFIRMED = 'Cancellation is not confirmed yet. Retry, stay with this payment, or go back without cancelling. Do not start another payment.'
export const PAYMENT_BACK_ALREADY_CONFIRMED = 'This payment has already been confirmed, so it cannot be cancelled here. Stay to continue with it.'

/**
 * The Back confirmation for a payable signup checkout. Choosing the
 * destructive action is the explicit no-funds-sent acknowledgement the Bitcoin
 * cancellation contract requires; there is no separate checkbox. Only an exact
 * `released` receipt for the same provider and capability counts as cancelled.
 */
export function PaymentBackModal({ provider, onStay, onReleased, onLeaveUnreleased }: {
  provider: Exclude<AnnualProvider, 'none'>
  onStay: () => void
  onReleased: () => void
  /** Optional: navigate to the payment-method choices while this payment stays owned. */
  onLeaveUnreleased?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<'idle' | 'unconfirmed' | 'confirmed'>('idle')
  const running = useRef(false)
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => { dialog.current?.focus() }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !running.current) onStay() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onStay])

  async function cancel() {
    if (running.current) return
    running.current = true
    setBusy(true)
    try {
      const pending = useAuthStore.getState().pendingSignup
      if (!pending || pending.provisionedUser || pending.paymentMethod !== provider || !pending.paymentSessionToken || !pending.paymentSessionRequestKey) throw new Error('missing')
      const identity = { email: pending.email, requestKey: pending.paymentSessionRequestKey, recoverySecret: pending.paymentSessionToken }
      const response = await cancelAnonymousPaymentSessionRecovery({ fetcher: fetch, billingApiUrl: BILLING_API_URL,
        ...identity, paymentSessionToken: identity.recoverySecret, ...(provider === 'btcpay' ? { confirmNoBitcoinSent: true } : {}) })
      if (response.state === 'confirmed') { setOutcome('confirmed'); return }
      if (response.state !== 'released' || response.release?.provider !== provider) throw new Error('retained')
      const current = useAuthStore.getState().pendingSignup
      if (!current || current.provisionedUser || current.email !== pending.email || current.paymentSessionToken !== identity.recoverySecret || current.paymentSessionRequestKey !== identity.requestKey) throw new Error('changed')
      useAuthStore.getState().clearPendingSignupPaymentRecovery(identity)
      if (useAuthStore.getState().pendingSignup?.paymentSessionToken) throw new Error('retained')
      onReleased()
    } catch {
      setOutcome('unconfirmed')
    } finally { running.current = false; setBusy(false) }
  }

  const copy = PAYMENT_BACK_COPY[provider]
  const titleId = `payment-back-title-${provider}`
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => { if (!busy) onStay() }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        onClick={event => event.stopPropagation()}
        className="w-full max-w-sm space-y-4 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--background))] p-5 text-left shadow-lg outline-none">
        <h2 id={titleId} className="text-lg font-semibold text-[rgb(var(--foreground))]">{copy.title}</h2>
        <p className="text-sm text-[rgb(var(--muted))]">{copy.body}</p>
        {outcome !== 'idle' && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{outcome === 'confirmed' ? PAYMENT_BACK_ALREADY_CONFIRMED : PAYMENT_BACK_UNCONFIRMED}</p>}
        <div className="flex flex-col gap-2">
          <button type="button" disabled={busy} onClick={onStay} className="inline-flex h-9 w-full items-center justify-center rounded-md bg-teal-500 px-4 py-2 text-sm font-medium text-white shadow transition-colors hover:bg-teal-600 disabled:opacity-50">{PAYMENT_BACK_STAY}</button>
          {outcome !== 'confirmed' && <button type="button" disabled={busy} onClick={() => { void cancel() }} className="inline-flex h-9 w-full items-center justify-center rounded-md border border-[rgb(var(--border))] px-4 py-2 text-sm disabled:opacity-50">
            {busy ? 'Cancelling…' : outcome === 'unconfirmed' ? 'Retry cancellation' : PAYMENT_BACK_CONFIRM}
          </button>}
          {outcome === 'unconfirmed' && onLeaveUnreleased && <button type="button" disabled={busy} onClick={onLeaveUnreleased} className="text-sm underline disabled:opacity-50">Back without cancelling</button>}
        </div>
      </div>
    </div>
  )
}
