'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import { BILLING_API_URL } from '@/app/lib/config'
import { normalizeSignupReturnTo } from '@/app/lib/signup-return'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { StepCreateVault } from '../components/step-create-vault'
import { StepCreatePaidAccount, type PaidAccountFormData } from '../components/step-create-paid-account'

type PaymentState = 'pending' | 'settled' | 'account' | 'vault' | 'expired' | 'timeout' | 'unknown'

const BTCPAY_CHECKOUT_ORIGIN = process.env.NEXT_PUBLIC_BTCPAY_CHECKOUT_ORIGIN ?? 'https://btcpay.silentsuite.io'

function clearPendingCryptoPaymentSession() {
  sessionStorage.removeItem('silentsuite-pending-crypto-invoice')
  sessionStorage.removeItem('silentsuite-pending-crypto-token')
  sessionStorage.removeItem('silentsuite-pending-crypto-return-to')
}

function clearPendingCryptoSignup() {
  clearPendingCryptoPaymentSession()
  sessionStorage.removeItem('silentsuite-signup-in-progress')
}

export default function PendingPaymentPage() {
  const completeSignup = useAuthStore((s) => s.completeSignup)
  const createEtebaseAccount = useAuthStore((s) => s.createEtebaseAccount)
  const finalizePaidSignup = useAuthStore((s) => s.finalizePaidSignup)
  const restoreSignupStateFromRedirect = useAuthStore((s) => s.restoreSignupStateFromRedirect)
  const pendingSignup = useAuthStore((s) => s.pendingSignup)
  const [invoiceId, setInvoiceId] = useState<string | null>(null)
  const [returnTo, setReturnTo] = useState<string | null>(null)
  const [showReturnFallback, setShowReturnFallback] = useState(false)
  const [state, setState] = useState<PaymentState>('pending')
  const [restoredEmail, setRestoredEmail] = useState('')
  const [pollNonce, setPollNonce] = useState(0)
  const [restarting, setRestarting] = useState(false)
  const [restartError, setRestartError] = useState<string | null>(null)

  useEffect(() => {
    if (state !== 'pending') return

    let id = sessionStorage.getItem('silentsuite-pending-crypto-invoice')
    let invoiceLookupToken = sessionStorage.getItem('silentsuite-pending-crypto-token')
    const storedReturnTo = normalizeSignupReturnTo(sessionStorage.getItem('silentsuite-pending-crypto-return-to'))
    setInvoiceId(id)
    setReturnTo(storedReturnTo)

    let cancelled = false
    let timer: number | undefined
    let attempts = 0
    async function poll() {
      attempts += 1
      try {
        const hasLocalLookup = id && invoiceLookupToken
        const headers: Record<string, string> = { 'X-Requested-With': 'XMLHttpRequest' }
        if (invoiceLookupToken) headers['X-Invoice-Lookup-Token'] = invoiceLookupToken
        const res = await fetch(hasLocalLookup
          ? `${BILLING_API_URL}/subscription/crypto/invoice/${id}`
          : `${BILLING_API_URL}/subscription/crypto/invoice/latest`, {
          credentials: 'include',
          headers,
        })
        if (!res.ok) {
          if (!hasLocalLookup) {
            setState('unknown')
            sessionStorage.removeItem('silentsuite-signup-in-progress')
            return
          }
          scheduleNextPoll()
          return
        }
        const data = await res.json()
        if (cancelled) return
        if (typeof data.invoiceId === 'string') {
          id = data.invoiceId
          setInvoiceId(data.invoiceId)
          sessionStorage.setItem('silentsuite-pending-crypto-invoice', data.invoiceId)
        }
        if (data.status === 'settled') {
          clearPendingCryptoPaymentSession()
          const restored = restoreSignupStateFromRedirect()
          const email = restored?.pendingSignup.email ?? pendingSignup?.email ?? ''
          const currentPending = useAuthStore.getState().pendingSignup
          if (email && currentPending?.provisionedUser) {
            setRestoredEmail(email)
            setState('vault')
          } else if (email && currentPending?.paymentSessionToken) {
            setRestoredEmail(email)
            setState('account')
          } else {
            clearPendingCryptoSignup()
            setState('settled')
          }
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
  }, [pendingSignup?.email, pollNonce, restoreSignupStateFromRedirect, state])

  function handleVaultComplete() {
    completeSignup()
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

  async function handlePaidAccountComplete(data: PaidAccountFormData) {
    await createEtebaseAccount(restoredEmail, data.password)
    await finalizePaidSignup()
    setState('vault')
  }

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
      ? 'The invoice expired or was marked invalid. You can start a new Bitcoin invoice without creating another account.'
      : state === 'timeout'
        ? 'Settlement is taking longer than expected. You can check again manually or start a new Bitcoin invoice.'
        : state === 'unknown'
          ? 'This browser no longer has the invoice details needed to poll BTCPay. If your billing session is still active, you can start a new Bitcoin invoice.'
          : 'Crypto payments can take a little time to settle. Your app access stays locked until the BTCPay webhook activates the account.'

  async function restartBitcoinCheckout() {
    setRestarting(true)
    setRestartError(null)
    try {
      const res = await fetch(`${BILLING_API_URL}/subscription/crypto/checkout`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({
          planId: 'early_annual',
          returnUrl: `${window.location.origin}/signup/pending-payment`,
        }),
      })
      if (!res.ok) throw new Error('Could not start a new Bitcoin invoice. Please log in or contact support.')
      const data = await res.json()
      if (!data.checkoutUrl || !data.invoiceId || !data.invoiceLookupToken) {
        throw new Error('Bitcoin checkout did not return a complete payment session.')
      }
      const checkoutUrl = new URL(data.checkoutUrl)
      if (checkoutUrl.origin !== BTCPAY_CHECKOUT_ORIGIN || checkoutUrl.protocol !== 'https:') {
        throw new Error('Bitcoin checkout returned an unexpected payment URL.')
      }
      sessionStorage.setItem('silentsuite-pending-crypto-invoice', data.invoiceId)
      sessionStorage.setItem('silentsuite-pending-crypto-token', data.invoiceLookupToken)
      sessionStorage.setItem('silentsuite-signup-in-progress', 'true')
      window.location.href = checkoutUrl.toString()
    } catch (err) {
      setRestartError(err instanceof Error ? err.message : 'Could not start a new Bitcoin invoice.')
      setRestarting(false)
    }
  }

  if (state === 'vault') {
    return (
      <div className="mx-auto max-w-md space-y-6">
        <div className="flex items-center gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4">
          <Check className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div>
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">Bitcoin payment settled</p>
            <p className="text-xs text-[rgb(var(--muted))]">One last step - set up your vault.</p>
          </div>
        </div>
        <StepCreateVault email={restoredEmail} onComplete={handleVaultComplete} />
        {showReturnFallback && returnTo && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-[rgb(var(--foreground))]">
            <p className="font-medium">Browser did not reopen the Android app automatically.</p>
            <a href={returnTo} className="mt-2 inline-flex font-medium text-[rgb(var(--primary))] underline">
              Tap here to return to Android
            </a>
          </div>
        )}
      </div>
    )
  }

  if (state === 'account') {
    return (
      <div className="mx-auto max-w-md space-y-6">
        <div className="flex items-center gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4">
          <Check className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div>
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">Bitcoin payment settled</p>
            <p className="text-xs text-[rgb(var(--muted))]">One last account step before your vault setup.</p>
          </div>
        </div>
        <StepCreatePaidAccount email={restoredEmail} onNext={handlePaidAccountComplete} />
      </div>
    )
  }

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
            <button type="button" onClick={restartBitcoinCheckout} disabled={restarting} className="inline-flex h-9 w-full items-center justify-center rounded-md border border-navy-300 bg-transparent px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-navy-100 disabled:cursor-not-allowed disabled:opacity-60">
              {restarting ? 'Starting new invoice...' : 'Start new Bitcoin invoice'}
            </button>
          </>
        ) : state === 'expired' || state === 'unknown' ? (
          <button type="button" onClick={restartBitcoinCheckout} disabled={restarting} className="inline-flex h-9 w-full items-center justify-center rounded-md bg-teal-500 px-4 py-2 text-sm font-medium text-white shadow transition-colors hover:bg-teal-600 disabled:cursor-not-allowed disabled:opacity-60">
            {restarting ? 'Starting new invoice...' : 'Start new Bitcoin invoice'}
          </button>
        ) : (
          <Link href="/login" className="inline-flex h-9 w-full items-center justify-center rounded-md border border-navy-300 bg-transparent px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-navy-100">
            Go to login
          </Link>
        )}
        {restartError && (
          <p className="text-xs text-red-400">{restartError}</p>
        )}
      </div>
    </div>
  )
}
