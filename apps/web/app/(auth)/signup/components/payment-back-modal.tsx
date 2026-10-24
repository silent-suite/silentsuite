'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ModalDialog } from '@/app/components/modal-dialog'
import { BILLING_API_URL } from '@/app/lib/config'
import { rateLimitedCancellationCopy } from '@/app/lib/payment-flow-cancellation'
import { BillingResponseError, cancelAnonymousPaymentSessionRecovery, type AnnualProvider } from '@/app/lib/billing-v2'
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
export const PAYMENT_BACK_UNCONFIRMED = 'Cancellation is not confirmed yet. Retry cancellation or stay with this payment. Do not start another payment.'
export const PAYMENT_BACK_ALREADY_CONFIRMED = 'This payment has already been confirmed, so it cannot be cancelled here. Stay to continue with it.'

/**
 * The Back confirmation for a payable signup checkout. Choosing the
 * destructive action is the explicit no-funds-sent acknowledgement the Bitcoin
 * cancellation contract requires; there is no separate checkbox. Only an exact
 * `released` receipt for the same provider and capability counts as cancelled.
 *
 * A 429 refusal leaves the payment owned. Its deadline is reported to the
 * stable parent, which passes it back as `cooldownUntil` only for the same
 * capability, so closing and reopening the dialog cannot send futile retries.
 */
export function PaymentBackModal({ provider, onStay, onReleased, restoreFocusTo, cooldownUntil, onRateLimited }: {
  provider: Exclude<AnnualProvider, 'none'>
  restoreFocusTo?: HTMLElement | null
  onStay: () => void
  onReleased: () => void
  cooldownUntil?: number
  /** `identity` is the request key of the capability whose request was refused. */
  onRateLimited?: (until: number, identity: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<'idle' | 'unconfirmed' | 'confirmed'>('idle')
  const running = useRef(false)
  const portal = useRef<HTMLDivElement>(null)
  const remainingMs = cooldownUntil === undefined ? 0 : cooldownUntil - Date.now()
  const coolingDown = remainingMs > 0
  // Re-render at the deadline only; expiry never sends a request by itself.
  const [, setExpiryTick] = useState(0)
  useEffect(() => {
    if (!coolingDown) return
    const timer = window.setTimeout(() => setExpiryTick(tick => tick + 1), remainingMs)
    return () => window.clearTimeout(timer)
  })
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
    if (running.current || coolingDown) return
    running.current = true
    setBusy(true)
    let requestKey: string | null = null
    try {
      const pending = useAuthStore.getState().pendingSignup
      if (!pending || pending.provisionedUser || pending.paymentMethod !== provider || !pending.paymentSessionToken || !pending.paymentSessionRequestKey) throw new Error('missing')
      const identity = { email: pending.email, requestKey: pending.paymentSessionRequestKey, recoverySecret: pending.paymentSessionToken }
      requestKey = identity.requestKey
      const response = await cancelAnonymousPaymentSessionRecovery({ fetcher: fetch, billingApiUrl: BILLING_API_URL,
        ...identity, paymentSessionToken: identity.recoverySecret, ...(provider === 'btcpay' ? { confirmNoBitcoinSent: true } : {}) })
      if (response.state === 'confirmed') { setOutcome('confirmed'); return }
      if (response.state !== 'released' || response.release?.provider !== provider) throw new Error('retained')
      const current = useAuthStore.getState().pendingSignup
      if (!current || current.provisionedUser || current.email !== pending.email || current.paymentSessionToken !== identity.recoverySecret || current.paymentSessionRequestKey !== identity.requestKey) throw new Error('changed')
      useAuthStore.getState().clearPendingSignupPaymentRecovery(identity)
      if (useAuthStore.getState().pendingSignup?.paymentSessionToken) throw new Error('retained')
      onReleased()
    } catch (error) {
      // Classified on HTTP 429 alone; neither limiter body is ever rendered.
      if (requestKey && error instanceof BillingResponseError && error.billingStatus === 429) {
        onRateLimited?.(Date.now() + (error.retryAfterMs ?? 15 * 60_000), requestKey)
      }
      setOutcome('unconfirmed')
    } finally { running.current = false; setBusy(false) }
  }

  const copy = PAYMENT_BACK_COPY[provider]
  const message = coolingDown ? rateLimitedCancellationCopy(Math.max(1, Math.ceil(remainingMs / 60_000)))
    : outcome === 'confirmed' ? PAYMENT_BACK_ALREADY_CONFIRMED
    : outcome === 'unconfirmed' ? PAYMENT_BACK_UNCONFIRMED : null
  return createPortal(
    <div ref={portal}>
      <ModalDialog title={copy.title} description={copy.body} onClose={onStay}
        closeOnEscape={!busy} closeOnBackdrop={!busy} restoreFocusTo={restoreFocusTo} className="space-y-4 text-left">
        <p className="text-sm text-[rgb(var(--muted))]">{copy.body}</p>
        {message && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{message}</p>}
        <div className="flex flex-col gap-2">
          <button type="button" disabled={busy} onClick={onStay} className="inline-flex h-9 w-full items-center justify-center rounded-md bg-teal-500 px-4 py-2 text-sm font-medium text-white shadow transition-colors hover:bg-teal-600 disabled:opacity-50">{PAYMENT_BACK_STAY}</button>
          {outcome !== 'confirmed' && <button type="button" disabled={busy || coolingDown} onClick={() => { void cancel() }} className="inline-flex h-9 w-full items-center justify-center rounded-md border border-[rgb(var(--border))] px-4 py-2 text-sm disabled:opacity-50">
            {busy ? 'Cancelling…' : outcome === 'unconfirmed' ? 'Retry cancellation' : PAYMENT_BACK_CONFIRM}
          </button>}
        </div>
      </ModalDialog>
    </div>, document.body
  )
}
