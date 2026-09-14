'use client'

import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ModalDialog } from '@/app/components/modal-dialog'
import { BILLING_API_URL } from '@/app/lib/config'
import { cancelAnonymousPaymentSessionRecovery, type AnnualProvider } from '@/app/lib/billing-v2'
import { useAuthStore } from '@/app/stores/use-auth-store'

export const PAYMENT_BACK_COPY = {
  btcpay: {
    title: 'Cancel this cryptocurrency payment?',
    body: 'Only continue if you haven’t sent cryptocurrency for this payment. This checkout will be cancelled. Do not send Bitcoin, Lightning or Monero to its old payment details.',
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
export function PaymentBackModal({ provider, onStay, onReleased, onLeaveUnreleased, restoreFocusTo }: {
  provider: Exclude<AnnualProvider, 'none'>
  restoreFocusTo?: HTMLElement | null
  onStay: () => void
  onReleased: () => void
  /** Optional: navigate to the payment-method choices while this payment stays owned. */
  onLeaveUnreleased?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<'idle' | 'unconfirmed' | 'confirmed'>('idle')
  const running = useRef(false)
  const portal = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    // The portal is a body sibling of the entire auth layout, including theme
    // and legal controls. Restore each sibling's original accessibility state.
    const siblings = Array.from(document.body.children).filter(node => node !== portal.current)
    const previous = siblings.map(node => ({ node, inert: node.getAttribute('inert'), hidden: node.getAttribute('aria-hidden') }))
    for (const { node } of previous) { node.setAttribute('inert', ''); node.setAttribute('aria-hidden', 'true') }
    return () => {
      for (const { node, inert, hidden } of previous) {
        if (inert === null) node.removeAttribute('inert'); else node.setAttribute('inert', inert)
        if (hidden === null) node.removeAttribute('aria-hidden'); else node.setAttribute('aria-hidden', hidden)
      }
    }
  }, [])

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
  return createPortal(
    <div ref={portal}>
      <ModalDialog title={copy.title} description={copy.body} onClose={onStay}
        closeOnEscape={!busy} closeOnBackdrop={!busy} restoreFocusTo={restoreFocusTo} className="space-y-4 text-left">
        <p className="text-sm text-[rgb(var(--muted))]">{copy.body}</p>
        {outcome !== 'idle' && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{outcome === 'confirmed' ? PAYMENT_BACK_ALREADY_CONFIRMED : PAYMENT_BACK_UNCONFIRMED}</p>}
        <div className="flex flex-col gap-2">
          <button type="button" disabled={busy} onClick={onStay} className="inline-flex h-9 w-full items-center justify-center rounded-md bg-teal-500 px-4 py-2 text-sm font-medium text-white shadow transition-colors hover:bg-teal-600 disabled:opacity-50">{PAYMENT_BACK_STAY}</button>
          {outcome !== 'confirmed' && <button type="button" disabled={busy} onClick={() => { void cancel() }} className="inline-flex h-9 w-full items-center justify-center rounded-md border border-[rgb(var(--border))] px-4 py-2 text-sm disabled:opacity-50">
            {busy ? 'Cancelling…' : outcome === 'unconfirmed' ? 'Retry cancellation' : PAYMENT_BACK_CONFIRM}
          </button>}
          {outcome === 'unconfirmed' && onLeaveUnreleased && <button type="button" disabled={busy} onClick={onLeaveUnreleased} className="text-sm underline disabled:opacity-50">Back without cancelling</button>}
        </div>
      </ModalDialog>
    </div>, document.body
  )
}
