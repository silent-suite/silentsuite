'use client'

import { useRef, useState } from 'react'
import { BILLING_API_URL } from '@/app/lib/config'
import { cancelAnonymousPaymentSessionRecovery, type AnnualProvider } from '@/app/lib/billing-v2'
import { useAuthStore } from '@/app/stores/use-auth-store'

export function paymentSwitchLabel(provider: AnnualProvider) {
  return provider === 'stripe' ? 'Cancel card payment and choose Bitcoin' : 'Cancel Bitcoin payment and choose card'
}

export function PaymentSwitchDecision({ provider, onKeep, onReleased }: {
  provider: AnnualProvider
  onKeep: () => void
  onReleased: () => void
}) {
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const running = useRef(false)
  async function cancel() {
    if (running.current) return
    running.current = true
    setBusy(true)
    setError(null)
    try {
      const pending = useAuthStore.getState().pendingSignup
      if (!pending || pending.provisionedUser || pending.paymentMethod !== provider || !pending.paymentSessionToken || !pending.paymentSessionRequestKey) throw new Error('missing')
      const identity = { email: pending.email, requestKey: pending.paymentSessionRequestKey, recoverySecret: pending.paymentSessionToken }
      const response = await cancelAnonymousPaymentSessionRecovery({ fetcher: fetch, billingApiUrl: BILLING_API_URL,
        ...identity, paymentSessionToken: identity.recoverySecret, ...(provider === 'btcpay' ? { confirmNoBitcoinSent: acknowledged } : {}) })
      if (response.state !== 'released' || response.release?.provider !== provider) throw new Error('retained')
      const current = useAuthStore.getState().pendingSignup
      if (!current || current.provisionedUser || current.email !== pending.email || current.paymentSessionToken !== identity.recoverySecret || current.paymentSessionRequestKey !== identity.requestKey) throw new Error('changed')
      useAuthStore.getState().clearPendingSignupPaymentRecovery(identity)
      if (useAuthStore.getState().pendingSignup?.paymentSessionToken) throw new Error('retained')
      onReleased()
    } catch {
      setError('Cancellation is not confirmed. Keep this payment and check its status, or retry cancellation. Do not send another payment.')
    } finally { running.current = false; setBusy(false) }
  }
  return <section role="region" aria-label="Cancel and switch payment" className="space-y-4 rounded-lg border border-[rgb(var(--border))] p-4">
    <h2 className="font-semibold">{paymentSwitchLabel(provider)}</h2>
    {provider === 'btcpay' && <>
      <p className="text-sm">A copied Bitcoin address cannot be revoked. After cancellation, do not pay the old invoice or address. If a payment reaches it later, contact support for manual review or a refund.</p>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={acknowledged} disabled={busy} onChange={event => setAcknowledged(event.target.checked)} />I have not sent any Bitcoin.</label>
    </>}
    {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    <button type="button" disabled={busy || (provider === 'btcpay' && !acknowledged)} onClick={() => { void cancel() }} className="block w-full rounded-md border p-2 disabled:opacity-50">{busy ? 'Confirming cancellation…' : paymentSwitchLabel(provider)}</button>
    <button type="button" disabled={busy} onClick={onKeep} className="block underline">Keep this payment</button>
    <a href="/signup?recovery=payment" className="block underline">Check this payment’s status</a>
  </section>
}
