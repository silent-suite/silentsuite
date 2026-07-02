'use client'

import { useEffect, useState } from 'react'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { BILLING_API_URL } from '@/app/lib/config'

type CryptoPaymentMethod = {
  id: string
  label: string
  qrValue: string | null
  address: string | null
  paymentLink?: string | null
  amountDue: string | null
  cryptoCode: string | null
}

export type BitcoinPaymentSession = {
  invoiceId: string
  lookupToken: string
  checkoutUrl: string
}

type BitcoinPaymentPanelProps = {
  session: BitcoinPaymentSession
  title?: string
  description?: string
  settledMessage?: string
  onBack: () => void
  onInvoiceInactive?: () => void
  onPaymentComplete: () => void | Promise<void>
  externalCheckoutLabel?: string
}

export default function BitcoinPaymentPanel({
  session,
  title = 'Pay with Bitcoin',
  description = 'Scan the QR code or copy the payment details. Access unlocks after BTCPay settlement confirms.',
  settledMessage = 'Payment settled. Your access is active.',
  onBack,
  onInvoiceInactive,
  onPaymentComplete,
  externalCheckoutLabel = 'Open in BTCPay instead',
}: BitcoinPaymentPanelProps) {
  const [paymentMethods, setPaymentMethods] = useState<CryptoPaymentMethod[]>([])
  const [selectedMethodId, setSelectedMethodId] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'pending' | 'settled' | 'expired' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function loadPaymentMethods() {
      try {
        const res = await fetch(`${BILLING_API_URL}/subscription/crypto/invoice/${session.invoiceId}/payment-methods`, {
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-Invoice-Lookup-Token': session.lookupToken },
        })
        if (!res.ok) throw new Error('Could not load Bitcoin payment details.')
        const data = await res.json()
        if (cancelled) return
        const methods = Array.isArray(data.paymentMethods) ? data.paymentMethods as CryptoPaymentMethod[] : []
        if (!methods.some((method) => method.qrValue || method.paymentLink || method.address)) {
          throw new Error('Could not load Bitcoin payment details.')
        }
        setPaymentMethods(methods)
        setSelectedMethodId(methods[0]?.id ?? null)
        setStatus('pending')
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load Bitcoin payment details.')
          setStatus('error')
        }
      }
    }

    void loadPaymentMethods()
    return () => { cancelled = true }
  }, [session.invoiceId, session.lookupToken])

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined

    async function poll() {
      try {
        const res = await fetch(`${BILLING_API_URL}/subscription/crypto/invoice/${session.invoiceId}`, {
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-Invoice-Lookup-Token': session.lookupToken },
        })
        if (!res.ok) throw new Error('Could not check Bitcoin payment status.')
        const data = await res.json()
        if (cancelled) return
        if (data.status === 'settled') {
          setStatus('settled')
          timer = window.setTimeout(() => { void onPaymentComplete() }, 1200)
          return
        }
        if (data.status === 'expired' || data.status === 'invalid' || data.status === 'failed') {
          setStatus('expired')
          return
        }
        timer = window.setTimeout(poll, 10_000)
      } catch {
        if (!cancelled) timer = window.setTimeout(poll, 15_000)
      }
    }

    void poll()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [onPaymentComplete, session.invoiceId, session.lookupToken])

  const selectedMethod = paymentMethods.find((method) => method.id === selectedMethodId) ?? paymentMethods[0]
  const qrValue = selectedMethod?.qrValue ?? selectedMethod?.paymentLink ?? selectedMethod?.address ?? ''

  async function handleCopyPaymentDetails() {
    try {
      await navigator.clipboard.writeText(qrValue)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2500)
    } catch {
      setError('Could not copy payment details. Please copy them manually.')
    }
  }

  function handleBack() {
    if (status === 'expired' || status === 'settled' || status === 'error') onInvoiceInactive?.()
    onBack()
  }

  return (
    <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-300 motion-reduce:animate-none">
      <div className="space-y-2 text-center">
        <h2 className="text-lg sm:text-xl font-semibold text-[rgb(var(--foreground))]">{title}</h2>
        <p className="text-sm text-[rgb(var(--muted))]">{description}</p>
      </div>

      {status === 'settled' ? (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-center text-sm text-emerald-700 dark:text-emerald-300">
          {settledMessage}
        </div>
      ) : status === 'expired' ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-200">
          This Bitcoin invoice is no longer payable. Go back and start a new Bitcoin invoice.
        </div>
      ) : status === 'error' ? (
        <div className="space-y-3 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-600 dark:text-red-400">
          <p>{error ?? 'Could not load Bitcoin payment details.'}</p>
          <a href={session.checkoutUrl} className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-red-500/30 bg-transparent px-4 py-2 text-sm font-medium text-red-700 shadow-sm transition-colors hover:bg-red-500/10 dark:text-red-200">
            {externalCheckoutLabel}<ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      ) : selectedMethod && qrValue ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            {paymentMethods.map((method) => (
              <button
                key={method.id}
                type="button"
                onClick={() => setSelectedMethodId(method.id)}
                className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                  selectedMethod.id === method.id
                    ? 'border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-200'
                    : 'border-[rgb(var(--border))] bg-[rgb(var(--surface))] text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))]'
                }`}
              >
                {method.label}
              </button>
            ))}
          </div>

          <div className="rounded-xl border border-[rgb(var(--border))] bg-white p-4">
            <QRCodeSVG value={qrValue} size={240} className="mx-auto h-auto max-w-full" />
          </div>

          <div className="space-y-2 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-3 text-left">
            {selectedMethod.amountDue && (
              <p className="text-sm text-[rgb(var(--foreground))]">
                Amount due: <span className="font-medium">{selectedMethod.amountDue} {selectedMethod.cryptoCode ?? 'BTC'}</span>
              </p>
            )}
            <p className="break-all text-xs text-[rgb(var(--muted))]">{selectedMethod.address ?? qrValue}</p>
            <button type="button" onClick={handleCopyPaymentDetails} className="text-xs font-medium text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300">
              {copied ? 'Copied to clipboard' : 'Copy payment details'}
            </button>
          </div>

          <a href={session.checkoutUrl} className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-navy-300 bg-transparent px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-navy-100">
            {externalCheckoutLabel}<ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-8">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-[rgb(var(--primary))] border-t-transparent" />
          <p className="mt-3 text-sm text-[rgb(var(--muted))]">Loading Bitcoin payment details...</p>
        </div>
      )}

      <button onClick={handleBack} className="flex items-center gap-1.5 text-sm text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors">
        <ArrowLeft className="h-4 w-4" />
        Back to payment methods
      </button>
    </div>
  )
}
