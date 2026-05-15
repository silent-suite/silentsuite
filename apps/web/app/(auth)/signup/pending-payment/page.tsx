'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Check, Loader2 } from 'lucide-react'
import { BILLING_API_URL } from '@/app/lib/config'

type PaymentState = 'pending' | 'settled' | 'expired' | 'unknown'

export default function PendingPaymentPage() {
  const [invoiceId, setInvoiceId] = useState<string | null>(null)
  const [state, setState] = useState<PaymentState>('pending')

  useEffect(() => {
    const id = sessionStorage.getItem('silentsuite-pending-crypto-invoice')
    const lookupToken = sessionStorage.getItem('silentsuite-pending-crypto-token')
    setInvoiceId(id)
    if (!id || !lookupToken) {
      setState('unknown')
      return
    }

    let cancelled = false
    async function poll() {
      try {
        const res = await fetch(`${BILLING_API_URL}/subscription/crypto/invoice/${id}`, {
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-Invoice-Lookup-Token': lookupToken },
        })
        if (!res.ok) return
        const data = await res.json()
        if (cancelled) return
        if (data.status === 'settled') {
          setState('settled')
          sessionStorage.removeItem('silentsuite-pending-crypto-invoice')
          sessionStorage.removeItem('silentsuite-pending-crypto-token')
          sessionStorage.removeItem('silentsuite-signup-in-progress')
        } else if (data.status === 'expired' || data.status === 'invalid') {
          setState('expired')
        } else {
          setState('pending')
        }
      } catch {
        if (!cancelled) setState('pending')
      }
    }

    poll()
    const timer = window.setInterval(poll, 10_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center space-y-6 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-amber-500/30 bg-amber-500/10">
        {state === 'settled' ? <Check className="h-7 w-7 text-emerald-400" /> : <Loader2 className="h-7 w-7 animate-spin text-amber-300" />}
      </div>
      <div className="space-y-2">
        <h1 className="text-xl font-semibold text-[rgb(var(--foreground))]">
          {state === 'settled' ? 'Payment settled' : state === 'expired' ? 'Invoice not completed' : 'Waiting for BTCPay settlement'}
        </h1>
        <p className="text-sm text-[rgb(var(--muted))]">
          {state === 'settled'
            ? 'Your annual prepaid access is active. You can now continue into SilentSuite.'
            : state === 'expired'
              ? 'The invoice expired or was marked invalid. Please start signup again or choose the free trial.'
              : 'Crypto payments can take a little time to settle. Your app access stays locked until the BTCPay webhook activates the account.'}
        </p>
      </div>
      {invoiceId && state !== 'settled' && (
        <p className="text-xs text-[rgb(var(--muted))]">Invoice: {invoiceId}</p>
      )}
      <div className="space-y-3">
        {state === 'settled' ? (
          <Link href="/" className="inline-flex h-9 w-full items-center justify-center rounded-md bg-teal-500 px-4 py-2 text-sm font-medium text-white shadow transition-colors hover:bg-teal-600">
            Open SilentSuite
          </Link>
        ) : (
          <Link href="/login" className="inline-flex h-9 w-full items-center justify-center rounded-md border border-navy-300 bg-transparent px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-navy-100">
            Go to login
          </Link>
        )}
      </div>
    </div>
  )
}
