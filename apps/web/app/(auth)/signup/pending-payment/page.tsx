'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import { BILLING_API_URL } from '@/app/lib/config'
import { normalizeSignupReturnTo } from '@/app/lib/signup-return'

type PaymentState = 'pending' | 'settled' | 'expired' | 'timeout' | 'unknown'

function clearPendingCryptoSignup() {
  sessionStorage.removeItem('silentsuite-pending-crypto-invoice')
  sessionStorage.removeItem('silentsuite-pending-crypto-token')
  sessionStorage.removeItem('silentsuite-pending-crypto-return-to')
  sessionStorage.removeItem('silentsuite-signup-in-progress')
}

export default function PendingPaymentPage() {
  const [invoiceId, setInvoiceId] = useState<string | null>(null)
  const [returnTo, setReturnTo] = useState<string | null>(null)
  const [showReturnFallback, setShowReturnFallback] = useState(false)
  const [state, setState] = useState<PaymentState>('pending')
  const [pollNonce, setPollNonce] = useState(0)

  useEffect(() => {
    const id = sessionStorage.getItem('silentsuite-pending-crypto-invoice')
    const lookupToken = sessionStorage.getItem('silentsuite-pending-crypto-token')
    const storedReturnTo = normalizeSignupReturnTo(sessionStorage.getItem('silentsuite-pending-crypto-return-to'))
    setInvoiceId(id)
    setReturnTo(storedReturnTo)
    if (!id || !lookupToken) {
      setState('unknown')
      clearPendingCryptoSignup()
      return
    }
    const invoiceLookupToken = lookupToken

    let cancelled = false
    let timer: number | undefined
    let attempts = 0
    async function poll() {
      attempts += 1
      try {
        const res = await fetch(`${BILLING_API_URL}/subscription/crypto/invoice/${id}`, {
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-Invoice-Lookup-Token': invoiceLookupToken },
        })
        if (!res.ok) {
          scheduleNextPoll()
          return
        }
        const data = await res.json()
        if (cancelled) return
        if (data.status === 'settled') {
          setState('settled')
          clearPendingCryptoSignup()
        } else if (data.status === 'expired' || data.status === 'invalid') {
          setState('expired')
          clearPendingCryptoSignup()
        } else {
          setState('pending')
          scheduleNextPoll()
        }
      } catch {
        if (!cancelled) {
          setState('pending')
          scheduleNextPoll()
        }
      }
    }

    function scheduleNextPoll() {
      if (cancelled || attempts >= 180) {
        if (!cancelled) {
          setState('timeout')
          sessionStorage.removeItem('silentsuite-signup-in-progress')
        }
        return
      }
      const delay = attempts < 30 ? 10_000 : 30_000
      timer = window.setTimeout(poll, delay)
    }

    poll()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [pollNonce])

  function handleSettledContinue() {
    if (returnTo) {
      setShowReturnFallback(false)
      window.location.href = returnTo
      window.setTimeout(() => {
        if (document.visibilityState === 'visible') setShowReturnFallback(true)
      }, 2000)
      return
    }
    window.location.href = '/'
  }

  const isWaiting = state === 'pending'
  const title = state === 'settled'
    ? 'Payment settled'
    : state === 'expired'
      ? 'Invoice not completed'
      : state === 'timeout'
        ? 'Still waiting for settlement'
        : state === 'unknown'
          ? 'Payment session not found'
          : 'Waiting for BTCPay settlement'

  const description = state === 'settled'
    ? 'Your annual prepaid access is active. Review the vault warning below, then continue into SilentSuite.'
    : state === 'expired'
      ? 'The invoice expired or was marked invalid. Start signup again or choose the free trial.'
      : state === 'timeout'
        ? 'Settlement is taking longer than expected. You can check again manually or start over.'
        : state === 'unknown'
          ? 'This browser no longer has the invoice details needed to poll BTCPay.'
          : 'Crypto payments can take a little time to settle. Your app access stays locked until the BTCPay webhook activates the account.'

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center space-y-6 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-amber-500/30 bg-amber-500/10">
        {state === 'settled' ? <Check className="h-7 w-7 text-emerald-400" /> : isWaiting ? <Loader2 className="h-7 w-7 animate-spin text-amber-300" /> : <AlertTriangle className="h-7 w-7 text-amber-300" />}
      </div>
      <div className="space-y-2">
        <h1 className="text-xl font-semibold text-[rgb(var(--foreground))]">
          {title}
        </h1>
        <p className="text-sm text-[rgb(var(--muted))]">
          {description}
        </p>
      </div>
      {invoiceId && state !== 'settled' && (
        <p className="text-xs text-[rgb(var(--muted))]">Invoice: {invoiceId}</p>
      )}
      {state === 'settled' && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-left text-xs text-[rgb(var(--muted))]">
          SilentSuite cannot recover your password or decrypt your vault for you. Keep your password safe before adding important data.
        </div>
      )}
      <div className="space-y-3">
        {state === 'settled' ? (
          <>
            <button type="button" onClick={handleSettledContinue} className="inline-flex h-9 w-full items-center justify-center rounded-md bg-teal-500 px-4 py-2 text-sm font-medium text-white shadow transition-colors hover:bg-teal-600">
              {returnTo ? 'Return to Android app' : 'Open SilentSuite'}
            </button>
            {showReturnFallback && returnTo && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-[rgb(var(--foreground))]">
                <p className="font-medium">Browser did not reopen the Android app automatically.</p>
                <a href={returnTo} className="mt-2 inline-flex font-medium text-[rgb(var(--primary))] underline">
                  Tap here to return to Android
                </a>
              </div>
            )}
          </>
        ) : state === 'timeout' ? (
          <>
            <button type="button" onClick={() => { setState('pending'); setPollNonce((value) => value + 1) }} className="inline-flex h-9 w-full items-center justify-center rounded-md bg-teal-500 px-4 py-2 text-sm font-medium text-white shadow transition-colors hover:bg-teal-600">
              Check again
            </button>
            <Link href="/signup" onClick={clearPendingCryptoSignup} className="inline-flex h-9 w-full items-center justify-center rounded-md border border-navy-300 bg-transparent px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-navy-100">
              Start over
            </Link>
          </>
        ) : state === 'expired' || state === 'unknown' ? (
          <Link href="/signup" onClick={clearPendingCryptoSignup} className="inline-flex h-9 w-full items-center justify-center rounded-md bg-teal-500 px-4 py-2 text-sm font-medium text-white shadow transition-colors hover:bg-teal-600">
            Start over
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
