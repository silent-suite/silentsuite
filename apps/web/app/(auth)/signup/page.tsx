'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  Shield, Lock, Check, KeyRound, ChevronRight, Crown,
  ShieldCheck,
  Users, Settings, Activity, ExternalLink, CreditCard,
  Gift, ArrowLeft, Bitcoin,
} from 'lucide-react'
import { Button } from '@silentsuite/ui'
import { Input } from '@silentsuite/ui'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { normalizeServerUrl } from '@/app/stores/use-etebase-store'
import { isSelfHosted, isCustomServer } from '@/app/lib/self-hosted'
import { BILLING_API_URL } from '@/app/lib/config'
import { DISPLAY_VERSION } from '@/app/lib/constants'
import { findCommonEmailDomainTypo, normalizeEmailForComparison, signupEmailSchema } from '@/app/lib/email-recovery'
import { normalizeSignupReturnTo } from '@/app/lib/signup-return'
import dynamic from 'next/dynamic'
import { StepCreateVault } from './components/step-create-vault'
import { StepCreatePaidAccount, type PaidAccountFormData } from './components/step-create-paid-account'
import { QRCodeSVG } from 'qrcode.react'
import { trackCheckoutInitiated, trackPlanSelected } from './commercial-funnel-analytics'
import {
  activateAnnualCheckout,
  consumeSignupEmailOwnership,
  fetchAnonymousAnnualOffer,
  isRenewableAnnualOfferError,
  requestSignupEmailOwnership,
  type AnnualCheckoutActivation,
  type AnnualOfferResponse,
} from '@/app/lib/billing-v2'
import {
  annualOfferAnnualLabel,
  annualOfferPlanLabel,
  annualOfferRenewalCopy,
  formatAnnualOfferMonthlyEquivalent,
  isAnnualOfferProviderAvailable,
} from '@/app/lib/annual-offer-presentation'

const CRYPTO_CHECKOUT_ENABLED = process.env.NEXT_PUBLIC_BTCPAY_CHECKOUT_ENABLED === 'true'
const BTCPAY_CHECKOUT_ORIGIN = process.env.NEXT_PUBLIC_BTCPAY_CHECKOUT_ORIGIN ?? 'https://btcpay.silentsuite.io'
const EMAIL_PROOF_CONTEXT_KEY = 'silentsuite-signup-email-proof'

type EmailProofContext = {
  email: string
  requestId: string
  wantsProductUpdates: boolean
  rememberDevice: boolean
  returnTo: string | null
  expiresAt: number
}

/**
 * The email-link continuation is stored in localStorage, not sessionStorage.
 * A link opened from a mail client lands in a fresh browsing context with its
 * own empty sessionStorage, which would strand the only route into plan
 * selection. The payload is an email, a request id and two booleans — no
 * password and no bearer capability — so browser-profile scope is the correct
 * lifetime for it.
 */
function readEmailProofContext(requestId: string | null): EmailProofContext | null {
  try {
    const raw = localStorage.getItem(EMAIL_PROOF_CONTEXT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<EmailProofContext> | Record<string, Partial<EmailProofContext>>
    const candidate = requestId && typeof parsed === 'object' && parsed !== null && requestId in parsed
      ? (parsed as Record<string, Partial<EmailProofContext>>)[requestId]
      : parsed as Partial<EmailProofContext>
    if (typeof candidate.email === 'string' && isUuid(candidate.requestId)
      && (!requestId || candidate.requestId === requestId)
      && typeof candidate.wantsProductUpdates === 'boolean' && typeof candidate.rememberDevice === 'boolean'
      && typeof candidate.expiresAt === 'number' && candidate.expiresAt > Date.now()) {
      return candidate as EmailProofContext
    }
    return null
  } catch {
    return null
  }
}

function clearEmailProofContext(requestId?: string | null) {
  try {
    if (!isUuid(requestId)) return
    const raw = localStorage.getItem(EMAIL_PROOF_CONTEXT_KEY)
    const contexts = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    // Legacy storage held one flat context rather than a request-keyed map.
    // Remove it only when it names this exact validated request.
    if (contexts.requestId === requestId && typeof contexts.email === 'string') {
      localStorage.removeItem(EMAIL_PROOF_CONTEXT_KEY)
      return
    }
    delete contexts[requestId]
    if (Object.keys(contexts).length) localStorage.setItem(EMAIL_PROOF_CONTEXT_KEY, JSON.stringify(contexts))
    else localStorage.removeItem(EMAIL_PROOF_CONTEXT_KEY)
  } catch {
    // A storage failure must not break the funnel it was only annotating.
  }
}

/** Drops the single-use verification token from the address bar and history. */
function stripEmailVerificationTokenFromUrl() {
  const cleaned = new URL(window.location.href)
  cleaned.searchParams.delete('email_verification_token')
  cleaned.searchParams.delete('token')
  cleaned.searchParams.delete('request_id')
  window.history.replaceState({}, '', `${cleaned.pathname}${cleaned.search}${cleaned.hash}`)
}

const StripePaymentForm = dynamic(() => import('@/app/components/stripe-payment-form'), {
  loading: () => (
    <div className="flex flex-col items-center justify-center py-8">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
      <p className="mt-3 text-sm text-[rgb(var(--muted))]">Loading payment form...</p>
    </div>
  ),
  ssr: false,
})

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TrialPath = '7day' | '30day'

type CryptoPaymentMethod = {
  id: string
  label: string
  qrValue: string | null
  address: string | null
  paymentLink: string | null
  amountDue: string | null
  cryptoCode: string | null
}

type CryptoPaymentSession = {
  invoiceId: string
  lookupToken: string
  checkoutUrl: string
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const signupSchema = signupEmailSchema
  .and(z.object({
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .regex(/[A-Z]/, 'Must contain an uppercase letter')
      .regex(/[a-z]/, 'Must contain a lowercase letter')
      .regex(/[0-9]/, 'Must contain a number'),
    confirmPassword: z.string(),
  }))
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })

type SignupFormData = z.infer<typeof signupSchema>

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

// ---------------------------------------------------------------------------
// Password strength indicator
// ---------------------------------------------------------------------------

function PasswordStrength({ password }: { password: string }) {
  const checks = [
    { label: 'At least 8 characters', met: password.length >= 8 },
    { label: 'Uppercase letter', met: /[A-Z]/.test(password) },
    { label: 'Lowercase letter', met: /[a-z]/.test(password) },
    { label: 'Number', met: /[0-9]/.test(password) },
  ]
  const metCount = checks.filter((c) => c.met).length

  if (!password) return null

  return (
    <div className="mt-2 space-y-2">
      <div className="flex gap-1">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className={`h-1 flex-1 rounded-full transition-colors ${
              i <= metCount
                ? metCount <= 2
                  ? 'bg-red-500'
                  : metCount === 3
                    ? 'bg-yellow-500'
                    : 'bg-[rgb(var(--primary))]'
                : 'bg-[rgb(var(--border))]'
            }`}
          />
        ))}
      </div>
      <ul className="space-y-1">
        {checks.map((check) => (
          <li
            key={check.label}
            className={`flex items-center gap-1.5 text-xs ${
              check.met ? 'text-[rgb(var(--primary))]' : 'text-[rgb(var(--muted))]'
            }`}
          >
            {check.met ? (
              <Check className="h-3 w-3" />
            ) : (
              <div className="h-3 w-3 rounded-full border border-[rgb(var(--border))]" />
            )}
            {check.label}
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Price display helper — used inline in the trial subhead, intentionally
// modest in size so it doesn't dominate the "30-day free trial" headline.
// ---------------------------------------------------------------------------

function PriceDisplay({ offer }: { offer: AnnualOfferResponse['offer'] }) {
  return (
    <span className="text-sm text-[rgb(var(--muted))]">
      Then <span className="font-semibold text-[rgb(var(--foreground))]">{annualOfferAnnualLabel(offer)}</span>, billed annually ({formatAnnualOfferMonthlyEquivalent(offer)}/month). Cancel anytime before day 30, no charge.
    </span>
  )
}

// ---------------------------------------------------------------------------
// Step 1: Create Account
// ---------------------------------------------------------------------------

function StepCreateAccount({
  onNext,
  serverUrl,
  setServerUrl,
  initialData,
  wantsProductUpdates,
  onWantsProductUpdatesChange,
  rememberDevice,
  onRememberDeviceChange,
}: {
  onNext: (data: SignupFormData) => Promise<void>
  serverUrl: string
  setServerUrl: (url: string) => void
  initialData?: SignupFormData | null
  wantsProductUpdates: boolean
  onWantsProductUpdatesChange: (value: boolean) => void
  rememberDevice: boolean
  onRememberDeviceChange: (value: boolean) => void
}) {
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isValid },
  } = useForm<SignupFormData>({
    // CQ-25: @hookform/resolvers v5 expects zod v3 types internally.
    // Zod v4 changed its type exports (ZodType → ZodTypeAny, different generics),
    // causing a type mismatch. The runtime works fine — only the types clash.
    // Remove this cast once @hookform/resolvers ships native zod v4 support.
    // Tracking: https://github.com/react-hook-form/resolvers/issues
    resolver: zodResolver(signupSchema) as any,
    mode: 'onChange',
    defaultValues: initialData ?? undefined,
  })

  const password = watch('password', '')
  const emailTypoWarning = findCommonEmailDomainTypo(watch('email', ''))

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="space-y-1.5 sm:space-y-2 text-center">
        <h2 className="text-lg sm:text-xl font-semibold text-[rgb(var(--foreground))]">Create your account</h2>
        <p className="text-sm text-[rgb(var(--muted))]">
          Start your encrypted workspace in seconds
        </p>
      </div>

      <form onSubmit={handleSubmit(async (data) => {
        setSubmitError(null)
        setIsSubmitting(true)
        try {
          await onNext(data)
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Account creation failed. Please try again.'
          setSubmitError(message)
        } finally {
          setIsSubmitting(false)
        }
      })} className="space-y-4">
        <div className="space-y-2">
          <label
            htmlFor="email"
            className="block text-sm font-medium text-[rgb(var(--foreground))]/80"
          >
            Email
          </label>
          <Input
            id="email"
            type="email"
            autoFocus
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? 'signup-email-error' : emailTypoWarning ? 'signup-email-warning' : undefined}
            {...register('email')}
            className="bg-[rgb(var(--surface))] text-[rgb(var(--foreground))] border-[rgb(var(--border))]"
          />
          {errors.email && (
            <p id="signup-email-error" role="alert" className="text-xs text-red-600 dark:text-red-400">{errors.email.message}</p>
          )}
          {!errors.email && emailTypoWarning && (
            <p id="signup-email-warning" className="text-xs text-amber-600 dark:text-amber-300">{emailTypoWarning.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <label
            htmlFor="confirmEmail"
            className="block text-sm font-medium text-[rgb(var(--foreground))]/80"
          >
            Confirm email
          </label>
          <Input
            id="confirmEmail"
            type="email"
            aria-invalid={!!errors.confirmEmail}
            aria-describedby={errors.confirmEmail ? 'signup-confirm-email-error' : undefined}
            {...register('confirmEmail')}
            className="bg-[rgb(var(--surface))] text-[rgb(var(--foreground))] border-[rgb(var(--border))]"
          />
          {errors.confirmEmail && (
            <p id="signup-confirm-email-error" role="alert" className="text-xs text-red-600 dark:text-red-400">
              {errors.confirmEmail.message}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <label
            htmlFor="password"
            className="block text-sm font-medium text-[rgb(var(--foreground))]/80"
          >
            Password
          </label>
          <Input
            id="password"
            type="password"
            aria-invalid={!!errors.password}
            aria-describedby={errors.password ? 'signup-password-error' : undefined}
            {...register('password')}
            className="bg-[rgb(var(--surface))] text-[rgb(var(--foreground))] border-[rgb(var(--border))]"
          />
          {errors.password && (
            <p id="signup-password-error" role="alert" className="text-xs text-red-600 dark:text-red-400">{errors.password.message}</p>
          )}
          <PasswordStrength password={password} />
        </div>

        <div className="space-y-2">
          <label
            htmlFor="confirmPassword"
            className="block text-sm font-medium text-[rgb(var(--foreground))]/80"
          >
            Confirm password
          </label>
          <Input
            id="confirmPassword"
            type="password"
            aria-invalid={!!errors.confirmPassword}
            aria-describedby={errors.confirmPassword ? 'signup-confirm-password-error' : undefined}
            {...register('confirmPassword')}
            className="bg-[rgb(var(--surface))] text-[rgb(var(--foreground))] border-[rgb(var(--border))]"
          />
          {errors.confirmPassword && (
            <p id="signup-confirm-password-error" role="alert" className="text-xs text-red-600 dark:text-red-400">
              {errors.confirmPassword.message}
            </p>
          )}
        </div>

        {/* Product updates opt-in */}
        <label className="flex items-start gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={wantsProductUpdates}
            onChange={(e) => onWantsProductUpdatesChange(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-[rgb(var(--border))] bg-[rgb(var(--surface))] text-[rgb(var(--primary))] focus:ring-[rgb(var(--primary))] focus:ring-offset-0"
          />
          <span className="text-xs text-[rgb(var(--muted))] leading-relaxed">
            Send me product updates and feature announcements
            <br />
            <span className="text-[rgb(var(--muted))]/70">We will never share your email. Unsubscribe anytime.</span>
          </span>
        </label>

        {!serverUrl.trim() && (
          <label className="flex items-start gap-2.5 cursor-pointer rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))]/40 p-3">
            <input
              type="checkbox"
              checked={rememberDevice}
              onChange={(e) => onRememberDeviceChange(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-[rgb(var(--border))] bg-[rgb(var(--surface))] text-[rgb(var(--primary))] focus:ring-[rgb(var(--primary))] focus:ring-offset-0"
            />
            <span className="text-sm font-medium text-[rgb(var(--foreground))]/80">Keep me signed in on this device</span>
          </label>
        )}

        {/* Advanced Settings */}
        <details className="group">
          <summary className="flex cursor-pointer items-center gap-2 text-xs text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors">
            <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
            Advanced Settings
          </summary>
          <div className="mt-3 space-y-2">
            <label className="block text-xs text-[rgb(var(--muted))]">
              Server URL
            </label>
            <Input
              type="url"
              placeholder="https://sync.example.com"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              className="bg-[rgb(var(--surface))] text-[rgb(var(--foreground))] border-[rgb(var(--border))] text-xs"
            />
            <p className="text-[10px] text-[rgb(var(--muted))]">
              Leave empty to use the default silentsuite.io server. Self-hosters: enter your own server URL.
            </p>
          </div>
        </details>

        {submitError && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
            <p className="text-sm text-red-600 dark:text-red-400">{submitError}</p>
          </div>
        )}

        <Button type="submit" disabled={!isValid || isSubmitting} className="w-full">
          {isSubmitting ? (
            <span className="flex items-center justify-center gap-2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              Continuing...
            </span>
          ) : (
            'Continue'
          )}
        </Button>

        <p className="flex items-center justify-center gap-1.5 text-xs text-[rgb(var(--muted))]">
          <KeyRound className="h-3 w-3 text-emerald-500" />
          No phone number required. Just email and password.
        </p>
      </form>

      <p className="text-center text-sm text-[rgb(var(--muted))]">
        Already have an account?{' '}
        <Link href="/login" className="text-emerald-500 hover:underline">
          Log in
        </Link>
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 2: Choose your plan (2-card selection + inline payment sub-step)
// ---------------------------------------------------------------------------

type PlanView = 'cards' | 'method' | 'confirm' | 'payment' | 'crypto'
type PendingAnnualClaim = {
  activation: AnnualCheckoutActivation
  provider: 'none' | 'stripe' | 'btcpay'
}

function formatDisclosureTimestamp(value: string | null): string {
  if (!value) return 'Not applicable'
  return `${value.slice(0, 10)} ${value.slice(11, 16)} UTC`
}

function CryptoPaymentPanel({
  annualOffer,
  session,
  onBack,
  onInvoiceInactive,
  onPaymentComplete,
}: {
  annualOffer: AnnualOfferResponse['offer']
  session: CryptoPaymentSession
  onBack: () => void
  onInvoiceInactive: () => void
  onPaymentComplete: () => void
}) {
  const saveSignupStateForRedirect = useAuthStore((s) => s.saveSignupStateForRedirect)
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
        if (!res.ok) throw new Error('Could not load cryptocurrency payment details.')
        const data = await res.json()
        if (cancelled) return
        const methods = Array.isArray(data.paymentMethods) ? data.paymentMethods as CryptoPaymentMethod[] : []
        if (!methods.some((method) => method.qrValue || method.paymentLink || method.address)) {
          throw new Error('Could not load cryptocurrency payment details.')
        }
        setPaymentMethods(methods)
        setSelectedMethodId(methods[0]?.id ?? null)
        setStatus('pending')
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load cryptocurrency payment details.')
          setStatus('error')
        }
      }
    }

    loadPaymentMethods()
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
        if (!res.ok) throw new Error('Could not check cryptocurrency payment status.')
        const data = await res.json()
        if (cancelled) return
        if (data.status === 'settled') {
          setStatus('settled')
          sessionStorage.removeItem('silentsuite-pending-crypto-invoice')
          sessionStorage.removeItem('silentsuite-pending-crypto-token')
          sessionStorage.removeItem('silentsuite-pending-crypto-return-to')
          timer = window.setTimeout(onPaymentComplete, 1200)
          return
        }
        if (data.status === 'expired' || data.status === 'invalid') {
          setStatus('expired')
          return
        }
        timer = window.setTimeout(poll, 10_000)
      } catch {
        if (!cancelled) timer = window.setTimeout(poll, 15_000)
      }
    }

    poll()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [onPaymentComplete, session.invoiceId, session.lookupToken])

  const selectedMethod = paymentMethods.find((method) => method.id === selectedMethodId) ?? paymentMethods[0]
  const qrValue = selectedMethod?.qrValue ?? selectedMethod?.paymentLink ?? selectedMethod?.address ?? ''
  const handleExternalCheckout = () => saveSignupStateForRedirect('annual')

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
    if (status === 'expired' || status === 'settled' || status === 'error') onInvoiceInactive()
    onBack()
  }

  return (
    <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-300 motion-reduce:animate-none">
      <div className="space-y-2 text-center">
        <h2 className="text-lg sm:text-xl font-semibold text-[rgb(var(--foreground))]">Pay with Bitcoin, Lightning or Monero</h2>
        <p className="text-sm text-[rgb(var(--muted))]">
          Choose a payment method, then scan the QR code or copy the payment details. Your silentsuite.io access unlocks after BTCPay confirms settlement.
        </p>
      </div>

      {status === 'settled' ? (
        <div className="space-y-4 text-center">
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-700 dark:text-emerald-300">
            Payment settled. Your {annualOfferPlanLabel(annualOffer)} annual access ({annualOffer.planId}) is active. Taking you to vault setup...
          </div>
        </div>
      ) : status === 'expired' ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-200">
          This cryptocurrency invoice expired. Go back and start a new invoice.
        </div>
      ) : status === 'error' ? (
        <div className="space-y-3 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-600 dark:text-red-400">
          <p>{error ?? 'Could not load cryptocurrency payment details.'}</p>
          <Link href={session.checkoutUrl} onClick={handleExternalCheckout} className="inline-flex h-9 w-full items-center justify-center rounded-md border border-red-500/30 bg-transparent px-4 py-2 text-sm font-medium text-red-700 shadow-sm transition-colors hover:bg-red-500/10 dark:text-red-200">
            Open in BTCPay instead
          </Link>
        </div>
      ) : selectedMethod && qrValue ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="group" aria-label="Cryptocurrency payment method">
            {paymentMethods.map((method) => (
              <button
                key={method.id}
                type="button"
                onClick={() => setSelectedMethodId(method.id)}
                aria-pressed={selectedMethod.id === method.id}
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
                Amount due: <span className="font-medium">{selectedMethod.amountDue} {selectedMethod.cryptoCode ?? ''}</span>
              </p>
            )}
            <p className="break-all text-xs text-[rgb(var(--muted))]">{selectedMethod.address ?? qrValue}</p>
            <button
              type="button"
              onClick={handleCopyPaymentDetails}
              className="text-xs font-medium text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300"
            >
              {copied ? 'Copied to clipboard' : 'Copy payment details'}
            </button>
          </div>

          <Link href={session.checkoutUrl} onClick={handleExternalCheckout} className="inline-flex h-9 w-full items-center justify-center rounded-md border border-navy-300 bg-transparent px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-navy-100">
            Open in BTCPay instead
          </Link>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-8">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-[rgb(var(--primary))] border-t-transparent" />
          <p className="mt-3 text-sm text-[rgb(var(--muted))]">Loading cryptocurrency payment details...</p>
        </div>
      )}

      <button
        onClick={handleBack}
        className="flex items-center gap-1.5 text-sm text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to payment methods
      </button>
    </div>
  )
}

function StepChoosePlan({
  annualOffer,
  onSelectFree,
  onChoosePaymentMethod,
  onSelectPaid,
  onSelectCrypto,
  planView,
  onBack,
  clientSecret,
  provisioning,
  provisionError,
  onClearError,
  onClearCryptoPaymentSession,
  onPaymentComplete,
  cryptoPaymentSession,
  pendingAnnualClaim,
  onConfirmAnnualClaim,
}: {
  annualOffer: AnnualOfferResponse
  onSelectFree: () => void
  onChoosePaymentMethod: () => void
  onSelectPaid: () => void
  onSelectCrypto: (useAnnual?: boolean) => void
  planView: PlanView
  onBack: () => void
  clientSecret: string | null
  provisioning: boolean
  provisionError: string | null
  onClearError: () => void
  onClearCryptoPaymentSession: () => void
  onPaymentComplete: () => void
  cryptoPaymentSession: CryptoPaymentSession | null
  pendingAnnualClaim: PendingAnnualClaim | null
  onConfirmAnnualClaim: () => void
}) {
  const contentRef = useRef<HTMLDivElement>(null)
  const [selectedTrial, setSelectedTrial] = useState<TrialPath>('30day')
  const [paymentMethodError, setPaymentMethodError] = useState<string | null>(null)
  const annualOfferDetails = annualOffer.offer
  const stripeAvailable = isAnnualOfferProviderAvailable(annualOfferDetails, 'stripe')
  const bitcoinAvailable = isAnnualOfferProviderAvailable(annualOfferDetails, 'btcpay', CRYPTO_CHECKOUT_ENABLED)

  const handleContinue = useCallback(() => {
    if (selectedTrial === '7day') {
      onSelectFree()
    } else {
      setPaymentMethodError(null)
      onClearError()
      onChoosePaymentMethod()
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }, [selectedTrial, onSelectFree, onChoosePaymentMethod, onClearError])

  const handleSelectCard = useCallback(() => {
    if (!stripeAvailable) {
      setPaymentMethodError('Card checkout is not available for this server-owned annual offer.')
      return
    }
    setPaymentMethodError(null)
    trackPlanSelected(annualOfferDetails)
    onSelectPaid()
  }, [annualOfferDetails, onSelectPaid, stripeAvailable])

  const handleSelectBitcoin = useCallback(() => {
    if (!bitcoinAvailable) {
      setPaymentMethodError('Cryptocurrency checkout is not available for this server-owned annual offer.')
      return
    }
    setPaymentMethodError(null)
    trackPlanSelected(annualOfferDetails)
    onSelectCrypto()
  }, [annualOfferDetails, bitcoinAvailable, onSelectCrypto])


  useEffect(() => {
    // Scroll to top of page on step transitions, not just the element
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [planView])

  // --- Payment sub-step ---
  if (planView === 'confirm' && pendingAnnualClaim) {
    const disclosure = pendingAnnualClaim.activation.disclosure
    return (
      <div ref={contentRef} className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-300 motion-reduce:animate-none">
        <div className="space-y-2 text-center">
          <h2 className="text-lg sm:text-xl font-semibold text-[rgb(var(--foreground))]">Confirm annual terms</h2>
          <p className="text-sm text-[rgb(var(--muted))]">Review the exact server-issued schedule before this checkout authority is claimed.</p>
        </div>
        <dl className="space-y-2 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 text-sm">
          <div className="flex justify-between gap-4"><dt>Annual price</dt><dd>€{(disclosure.annualAmountMinor / 100).toFixed(2)}/year</dd></div>
          <div className="flex justify-between gap-4"><dt>First charge amount</dt><dd>€{(disclosure.firstChargeAmountMinor / 100).toFixed(2)}</dd></div>
          <div className="flex justify-between gap-4"><dt>First charge time</dt><dd>{formatDisclosureTimestamp(disclosure.firstChargeAt)}</dd></div>
          <div className="flex justify-between gap-4"><dt>Cancel before</dt><dd>{formatDisclosureTimestamp(disclosure.cancelBy)}</dd></div>
          <div className="flex justify-between gap-4"><dt>Renews</dt><dd>{formatDisclosureTimestamp(disclosure.renewalAt)}</dd></div>
          <div className="flex justify-between gap-4"><dt>Renewal amount</dt><dd>{disclosure.renewalAmountMinor === null ? 'Not applicable' : `€${(disclosure.renewalAmountMinor / 100).toFixed(2)}/year`}</dd></div>
          <div className="flex justify-between gap-4"><dt>Refund window</dt><dd>{disclosure.refundWindowDays ? `${disclosure.refundWindowDays} days` : 'Not applicable'}</dd></div>
          <div className="flex justify-between gap-4"><dt>Auto-renewal</dt><dd>{disclosure.autoRenew ? 'On' : 'Off'}</dd></div>
          <div className="flex justify-between gap-4"><dt>Prepaid</dt><dd>{disclosure.prepaid ? 'Yes' : 'No'}</dd></div>
          <div className="flex justify-between gap-4"><dt>Access through</dt><dd>{formatDisclosureTimestamp(disclosure.entitlementEndsAt)}</dd></div>
        </dl>
        <Button type="button" className="w-full" disabled={provisioning} onClick={onConfirmAnnualClaim}>
          {provisioning ? 'Starting…' : 'Confirm annual terms and continue'}
        </Button>
        <button type="button" onClick={onBack} className="flex items-center gap-1.5 text-sm text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
      </div>
    )
  }

  if (planView === 'crypto' && cryptoPaymentSession) {
    if (!bitcoinAvailable) {
      return (
        <div className="space-y-4" role="alert">
          <p className="text-sm text-red-600 dark:text-red-400">Cryptocurrency checkout is not available for this server-owned annual offer.</p>
          <Button type="button" variant="outline" onClick={onBack}>Back to payment methods</Button>
        </div>
      )
    }
    return (
      <CryptoPaymentPanel
        annualOffer={annualOfferDetails}
        session={cryptoPaymentSession}
        onBack={onBack}
        onInvoiceInactive={onClearCryptoPaymentSession}
        onPaymentComplete={onPaymentComplete}
      />
    )
  }

  if (planView === 'method') {
    return (
      <div ref={contentRef} className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-300 motion-reduce:animate-none">
        <div className="space-y-2 text-center">
          <h2 className="text-lg sm:text-xl font-semibold text-[rgb(var(--foreground))]">Choose how to pay</h2>
          <p className="text-sm text-[rgb(var(--muted))]">
            Your 30-day trial starts after the payment method is set up. No charge today for card payments.
          </p>
        </div>

        <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Crown className="h-4 w-4 text-emerald-400" />
              <span className="text-sm font-medium text-[rgb(var(--foreground))]">{annualOfferPlanLabel(annualOfferDetails)}</span>
            </div>
            <span className="text-sm text-[rgb(var(--foreground))]">{annualOfferAnnualLabel(annualOfferDetails)}</span>
          </div>
          <p className="mt-1 text-xs text-[rgb(var(--muted))]">Plan ID: {annualOfferDetails.planId} · {annualOfferRenewalCopy(annualOfferDetails)}</p>
        </div>

        <div className="grid gap-3">
          {stripeAvailable && (
            <button
              type="button"
              onClick={handleSelectCard}
              disabled={provisioning}
              aria-label={`Continue to card payment for ${annualOfferPlanLabel(annualOfferDetails)}, ${annualOfferAnnualLabel(annualOfferDetails)}`}
              className="group w-full rounded-xl border-2 border-slate-700/50 bg-[rgb(var(--surface))] p-4 text-left transition-all hover:border-emerald-500/70 hover:bg-emerald-500/5 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-emerald-500/10 p-2.5 shrink-0">
                  <CreditCard className="h-5 w-5 text-emerald-400" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-[rgb(var(--foreground))]">Card with Stripe</h3>
                  <p className="mt-1 text-sm text-[rgb(var(--muted))]">
                    Start the 30-day trial now. Your card is charged {annualOfferAnnualLabel(annualOfferDetails)} after the trial unless you cancel.
                  </p>
                </div>
              </div>
            </button>
          )}

          {bitcoinAvailable && (
            <button
              type="button"
              onClick={handleSelectBitcoin}
              disabled={provisioning}
              aria-label={`Pay ${annualOfferAnnualLabel(annualOfferDetails)} with Bitcoin, Lightning or Monero for ${annualOfferPlanLabel(annualOfferDetails)}`}
              className="group w-full rounded-xl border-2 border-slate-700/50 bg-[rgb(var(--surface))] p-4 text-left transition-all hover:border-amber-500/70 hover:bg-amber-500/5 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-amber-500/10 p-2.5 shrink-0">
                  <Bitcoin className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                </div>
                <div className="flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold text-[rgb(var(--foreground))]">Bitcoin, Lightning or Monero</h3>
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">Annual only</span>
                  </div>
                  <p className="mt-1 text-sm text-[rgb(var(--muted))]">
                    Pay once with Bitcoin, Lightning, or Monero. Payment is processed through our self-hosted BTCPay Server. Access starts after the invoice settles.
                  </p>
                </div>
              </div>
            </button>
          )}

          {!stripeAvailable && !bitcoinAvailable && (
            <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-600 dark:text-red-400">
              No payment method is authorized for this server-owned annual offer.
            </p>
          )}
        </div>

        {(paymentMethodError || provisionError) && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
            <p className="text-sm text-red-600 dark:text-red-400">{paymentMethodError ?? provisionError}</p>
          </div>
        )}

        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to plan selection
        </button>
      </div>
    )
  }

  if (planView === 'payment') {
    return (
      <div ref={contentRef} className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300 motion-reduce:animate-none">
        <div className="space-y-2 text-center">
          <h2 className="text-lg sm:text-xl font-semibold text-[rgb(var(--foreground))]">Add your payment method</h2>
          <p className="text-sm text-[rgb(var(--muted))]">
            Your card will not be charged for 30 days. It renews at {annualOfferAnnualLabel(annualOfferDetails)} unless you cancel before then.
          </p>
        </div>

        {/* Plan summary bar */}
        <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Crown className="h-4 w-4 text-emerald-400" />
              <span className="text-sm font-medium text-[rgb(var(--foreground))]">{annualOfferPlanLabel(annualOfferDetails)}</span>
            </div>
            <span className="text-sm text-[rgb(var(--foreground))]">{annualOfferAnnualLabel(annualOfferDetails)}</span>
          </div>
          <p className="mt-1 text-xs text-[rgb(var(--muted))]">
            Plan ID: {annualOfferDetails.planId}. Card secures your trial — {annualOfferRenewalCopy(annualOfferDetails)} after day 30 unless you cancel before then.
          </p>
          <div className="mt-2 flex items-center gap-1.5 text-xs text-[rgb(var(--muted))]">
            <Lock className="h-3 w-3 text-emerald-500" />
            <span>Your card details are sent directly to Stripe and never pass through SilentSuite.</span>
          </div>
        </div>

        {/* Stripe payment form */}
        {provisioning ? (
          <div className="flex flex-col items-center justify-center py-8">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-[rgb(var(--primary))] border-t-transparent" />
            <p className="mt-3 text-sm text-[rgb(var(--muted))]">Preparing payment form...</p>
          </div>
        ) : clientSecret ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-[rgb(var(--muted))]" />
              <h3 className="text-sm font-medium text-[rgb(var(--foreground))]">Secure card payment with Stripe</h3>
            </div>
            <StripePaymentForm
              clientSecret={clientSecret}
              onSuccess={onPaymentComplete}
              submitLabel={`Start 30-day free trial — then ${annualOfferAnnualLabel(annualOfferDetails)}`}
              mode="setup"
              selectedInterval="annual"
            />
            <p className="flex items-center justify-center gap-1.5 text-[10px] text-[rgb(var(--muted))]">
              <Lock className="h-3 w-3 text-emerald-500" />
              <a href="https://stripe.com" target="_blank" rel="noreferrer" className="font-medium text-indigo-600 dark:text-indigo-300">Powered by Stripe</a>
            </p>
          </div>
        ) : provisionError ? (
          <div className="space-y-4 text-center">
            <p className="text-sm text-red-600 dark:text-red-400">{provisionError}</p>
            <button
              onClick={onBack}
              className="text-sm text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300 transition-colors"
            >
              Go back and try again
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-8">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-[rgb(var(--primary))] border-t-transparent" />
            <p className="mt-3 text-sm text-[rgb(var(--muted))]">Setting up payment...</p>
          </div>
        )}

        {/* Back button — bottom-left */}
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to plan selection
        </button>
      </div>
    )
  }

  // --- Cards view (plan selection) ---
  return (
    <div ref={contentRef} className="space-y-4 sm:space-y-6 animate-in fade-in slide-in-from-left-4 duration-300 motion-reduce:animate-none">
      <div className="space-y-2 text-center">
        <h2 className="text-lg sm:text-xl font-semibold text-[rgb(var(--foreground))]">Choose your plan</h2>
        <p className="text-sm text-[rgb(var(--muted))]">
          {annualOfferPlanLabel(annualOfferDetails)} pricing
        </p>
      </div>

      <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-center text-sm text-[rgb(var(--muted))]">
        Annual access only. Exact price and renewal terms are confirmed by Billing before checkout.
      </p>

      <div className="space-y-3 sm:space-y-4">
        {/* Card A: 7 Day Free Trial — no card */}
        <button
          onClick={() => setSelectedTrial('7day')}
          aria-label="7 Day Free Trial — full access, no credit card required"
          className={`group w-full rounded-xl border-2 p-4 sm:p-5 text-left transition-all ${
            selectedTrial === '7day'
              ? 'border-emerald-500 bg-emerald-500/5'
              : 'border-slate-700/50 bg-[rgb(var(--surface))] hover:border-slate-600/50 hover:bg-[rgb(var(--surface))]/80'
          }`}
        >
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-[rgb(var(--border))] p-2.5 shrink-0">
              <Gift className="h-5 w-5 text-[rgb(var(--muted))]" />
            </div>
            <div className="flex-1">
              <h3 className="font-semibold text-[rgb(var(--foreground))]">7 Day Free Trial</h3>
              <ul className="mt-2 space-y-1.5">
                <li className="flex items-center gap-2 text-sm text-[rgb(var(--muted))]">
                  <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                  Full access to all features
                </li>
                <li className="flex items-center gap-2 text-sm text-[rgb(var(--muted))]">
                  <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                  No credit card required
                </li>
              </ul>
            </div>
          </div>
        </button>

        {/* Card B: 30 Day Free Trial — card secures the trial, no charge for 30 days */}
        <button
          onClick={() => setSelectedTrial('30day')}
          aria-label={`30-day free trial — then ${annualOfferRenewalCopy(annualOfferDetails)}, cancel anytime before day 30 with no charge`}
          className={`group w-full rounded-xl border-2 p-4 sm:p-6 text-left transition-all ${
            selectedTrial === '30day'
              ? 'border-emerald-500 bg-emerald-500/5'
              : 'border-slate-700/50 bg-[rgb(var(--surface))] hover:border-slate-600/50 hover:bg-[rgb(var(--surface))]/80'
          }`}
        >
          <div className="flex items-start gap-3 sm:gap-4">
            <div className="rounded-xl bg-emerald-500/15 p-2.5 sm:p-3 shrink-0">
              <Crown className="h-5 w-5 sm:h-6 sm:w-6 text-emerald-400" />
            </div>
            <div className="flex-1">
              <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                <h3 className="text-xl sm:text-2xl font-bold text-[rgb(var(--foreground))] leading-tight">30-day free trial</h3>
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400 uppercase tracking-wide">
                  Recommended
                </span>
              </div>
              <p className="mt-1.5 leading-snug">
                <PriceDisplay offer={annualOfferDetails} />
              </p>
              <ul className="mt-3 space-y-1.5">
                <li className="flex items-center gap-2 text-sm text-[rgb(var(--muted))]">
                  <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                  Full access to all features
                </li>
                <li className="flex items-center gap-2 text-sm text-[rgb(var(--muted))]">
                  <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                  Card secures your trial &mdash; no charge until day 30
                </li>
                <li className="flex items-center gap-2 text-sm text-[rgb(var(--muted))]">
                  <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                  {annualOfferRenewalCopy(annualOfferDetails)} after trial
                </li>
              </ul>
            </div>
          </div>
        </button>

      </div>

      {/* Continue button */}
      <Button
        onClick={handleContinue}
        disabled={provisioning}
        className="w-full"
      >
        {provisioning ? (
          <span className="flex items-center justify-center gap-2">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
            Setting up...
          </span>
        ) : (
          'Continue'
        )}
      </Button>

      {/* Error display */}
      {provisionError && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
          <p className="text-sm text-red-600 dark:text-red-400">{provisionError}</p>
          <button
            onClick={onClearError}
            className="mt-2 text-xs text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Trust signals */}
      <div className="flex items-center justify-center gap-1.5 text-xs text-[rgb(var(--muted))]">
        <ShieldCheck className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
        <span className="text-center">Cancel anytime · Your data stays encrypted · Export anytime</span>
      </div>

      {/* Back button — bottom-left */}
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 2b: Self-Host Support Choice
// ---------------------------------------------------------------------------

function StepSelfHostSupport({ onNext }: { onNext: () => void }) {
  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h2 className="text-xl font-semibold text-[rgb(var(--foreground))]">You&apos;re self-hosting</h2>
        <p className="text-sm text-[rgb(var(--muted))]">
          Your account was created on your own server. All features are unlocked.
        </p>
      </div>

      {/* Free option */}
      <div className="rounded-xl border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-5 flex flex-col">
        <div className="flex items-center gap-3 mb-3">
          <div className="rounded-lg bg-emerald-500/10 p-2.5">
            <Shield className="h-5 w-5 text-emerald-500" />
          </div>
          <h3 className="text-lg font-semibold text-[rgb(var(--foreground))]">Free forever</h3>
        </div>
        <p className="text-sm leading-relaxed text-[rgb(var(--muted))]">
          Self-hosting is completely free. No limits, no feature gates, no expiry.
          You run the server, you own the data.
        </p>
        <div className="mt-4">
          <Button
            onClick={onNext}
            variant="outline"
            className="w-full py-2.5 text-sm"
          >
            Continue for free
          </Button>
        </div>
      </div>

    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 2c: Admin Info (self-hosters only)
// ---------------------------------------------------------------------------

function StepAdminInfo({ serverUrl, onNext }: { serverUrl: string; onNext: () => void }) {
  const adminUrl = serverUrl ? `${serverUrl.replace(/\/+$/, '')}/admin/` : ''

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-emerald-500/30 bg-emerald-500/10">
          <Shield className="h-7 w-7 text-emerald-500" />
        </div>
        <h2 className="text-xl font-semibold text-[rgb(var(--foreground))]">You&apos;re the admin</h2>
        <p className="text-sm text-[rgb(var(--muted))]">
          As the first user on this server, you have admin privileges.
        </p>
      </div>

      <div className="space-y-3">
        <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 flex items-start gap-3">
          <Users className="h-5 w-5 text-emerald-500 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">User management</p>
            <p className="text-xs text-[rgb(var(--muted))] mt-0.5">
              View, create, and manage all user accounts on your server via the admin panel.
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 flex items-start gap-3">
          <Activity className="h-5 w-5 text-emerald-500 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">Server monitoring</p>
            <p className="text-xs text-[rgb(var(--muted))] mt-0.5">
              Monitor collections, check database state, and review server health.
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 flex items-start gap-3">
          <Settings className="h-5 w-5 text-emerald-500 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">Full control</p>
            <p className="text-xs text-[rgb(var(--muted))] mt-0.5">
              All features are unlocked for every user. No subscription tiers or feature gates.
            </p>
          </div>
        </div>
      </div>

      {adminUrl && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-4">
          <p className="text-xs text-[rgb(var(--muted))] mb-2">Your admin panel:</p>
          <a
            href={adminUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-sm font-medium text-emerald-600 hover:text-emerald-700 dark:text-emerald-500 dark:hover:text-emerald-400 transition-colors"
          >
            {adminUrl}
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <p className="text-[10px] text-[rgb(var(--muted))] mt-2">
            Log in with the admin credentials from your .env file.
          </p>
        </div>
      )}

      <Button onClick={onNext} className="w-full">
        Continue
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Progress Stepper
// ---------------------------------------------------------------------------

type Step = 'account' | 'verifiedAccount' | 'plan' | 'selfhost' | 'admin' | 'paidAccount' | 'vault'

const STEPS_HOSTED = [
  { key: 'account' as const, label: 'Account', number: 1 },
  { key: 'plan' as const, label: 'Plan', number: 2 },
  { key: 'vault' as const, label: 'Setup', number: 3 },
]

const STEPS_SELFHOST = [
  { key: 'account' as const, label: 'Account', number: 1 },
  { key: 'selfhost' as const, label: 'Self-Hosting', number: 2 },
  { key: 'admin' as const, label: 'Admin Setup', number: 3 },
  { key: 'vault' as const, label: 'Setup', number: 4 },
]

function ProgressStepper({ currentStep, steps }: { currentStep: Step; steps: readonly { key: string; label: string; number: number }[] }) {
  const currentIndex = steps.findIndex((s) => s.key === currentStep)

  return (
    <>
      {/* Desktop: vertical stepper on the left */}
      <div className="hidden md:flex flex-col gap-0 mr-8">
        {steps.map((step, i) => (
          <div key={step.key} className="flex items-start gap-3">
            <div className="flex flex-col items-center">
              <div
                className={`flex h-8 w-8 items-center justify-center rounded-full border-2 text-sm font-semibold transition-colors ${
                  i < currentIndex
                    ? 'border-emerald-500 bg-emerald-500 text-white'
                    : i === currentIndex
                      ? 'border-emerald-500 text-emerald-500'
                      : 'border-[rgb(var(--border))] text-[rgb(var(--muted))]'
                }`}
              >
                {i < currentIndex ? (
                  <Check className="h-4 w-4" />
                ) : (
                  step.number
                )}
              </div>
              {i < steps.length - 1 && (
                <div
                  className={`w-0.5 h-12 transition-colors ${
                    i < currentIndex ? 'bg-emerald-500' : 'bg-[rgb(var(--border))]'
                  }`}
                />
              )}
            </div>
            <span
              className={`mt-1.5 text-sm ${
                i <= currentIndex
                  ? 'text-[rgb(var(--foreground))] font-medium'
                  : 'text-[rgb(var(--muted))]'
              }`}
            >
              {step.label}
            </span>
          </div>
        ))}
      </div>

      {/* Mobile: horizontal stepper on top */}
      <div className="flex w-full md:hidden items-center justify-center gap-1 sm:gap-2 mb-4 sm:mb-6">
        {steps.map((step, i) => (
          <div key={step.key} className="flex items-center gap-1.5">
            <div className="flex items-center gap-1">
              <div
                className={`flex h-6 w-6 items-center justify-center rounded-full border-2 text-xs font-semibold transition-colors ${
                  i < currentIndex
                    ? 'border-emerald-500 bg-emerald-500 text-white'
                    : i === currentIndex
                      ? 'border-emerald-500 text-emerald-500'
                      : 'border-[rgb(var(--border))] text-[rgb(var(--muted))]'
                }`}
              >
                {i < currentIndex ? (
                  <Check className="h-3 w-3" />
                ) : (
                  step.number
                )}
              </div>
              <span
                className={`text-xs hidden sm:inline ${
                  i <= currentIndex
                    ? 'text-[rgb(var(--foreground))] font-medium'
                    : 'text-[rgb(var(--muted))]'
                }`}
              >
                {step.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div
                className={`w-3 sm:w-4 h-0.5 transition-colors ${
                  i < currentIndex ? 'bg-emerald-500' : 'bg-[rgb(var(--border))]'
                }`}
              />
            )}
          </div>
        ))}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Main Signup Page
// ---------------------------------------------------------------------------

export default function SignupPage() {
  const router = useRouter()
  const prepareSignupDraft = useAuthStore((s) => s.prepareSignupDraft)
  const createEtebaseAccount = useAuthStore((s) => s.createEtebaseAccount)
  const signup = useAuthStore((s) => s.signup)
  const provisionAnnualNoCard = useAuthStore((s) => s.provisionAnnualNoCard)
  const startAnnualSignupPayment = useAuthStore((s) => s.startAnnualSignupPayment)
  const finalizePaidSignup = useAuthStore((s) => s.finalizePaidSignup)
  const completeSignup = useAuthStore((s) => s.completeSignup)
  const [step, setStep] = useState<Step>('account')
  const [serverUrl, setServerUrl] = useState('')

  // Scroll to top on main step changes
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [step])
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [cryptoPaymentSession, setCryptoPaymentSession] = useState<CryptoPaymentSession | null>(null)
  const [provisionError, setProvisionError] = useState<string | null>(null)
  const [provisioning, setProvisioning] = useState(false)
  const [usingSelfHostedServer, setUsingSelfHostedServer] = useState(false)
  const [planView, setPlanView] = useState<PlanView>('cards')
  const [wantsProductUpdates, setWantsProductUpdates] = useState(false)
  const [rememberDevice, setRememberDevice] = useState(false)
  const [returnTo, setReturnTo] = useState<string | null>(null)
  const [showReturnFallback, setShowReturnFallback] = useState(false)
  const [emailOwnershipToken, setEmailOwnershipToken] = useState<string | null>(null)
  const [annualOffer, setAnnualOffer] = useState<AnnualOfferResponse | null>(null)
  const [annualOfferRequestId, setAnnualOfferRequestId] = useState<string | null>(null)
  const [pendingAnnualClaim, setPendingAnnualClaim] = useState<PendingAnnualClaim | null>(null)
  const [recoveredSignupEmail, setRecoveredSignupEmail] = useState<string | null>(null)
  const [awaitingEmailProof, setAwaitingEmailProof] = useState(false)
  const [emailProofUnavailable, setEmailProofUnavailable] = useState(false)
  const formDataRef = useRef<SignupFormData | null>(null)

  useEffect(() => {
    setReturnTo(normalizeSignupReturnTo(new URLSearchParams(window.location.search).get('return_to')))
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const token = params.get('email_verification_token') ?? params.get('token')
    if (!token) return
    const requestId = params.get('request_id')
    const context = readEmailProofContext(requestId)
    if (!context) {
      // Without the draft there is no email to verify the token against, so the
      // link cannot be spent here. Say so and leave the signup form usable
      // rather than silently discarding the only path into plan selection.
      clearEmailProofContext(requestId)
      stripEmailVerificationTokenFromUrl()
      setEmailProofUnavailable(true)
      setAwaitingEmailProof(false)
      return
    }

    let cancelled = false
    void (async () => {
      const ownership = await consumeSignupEmailOwnership({ fetcher: fetch, billingApiUrl: BILLING_API_URL, email: context.email, token })
      const offer = await fetchAnonymousAnnualOffer({ fetcher: fetch, billingApiUrl: BILLING_API_URL, email: context.email, requestId: context.requestId })
      if (cancelled) return
      prepareSignupDraft(context.email, context.wantsProductUpdates, context.rememberDevice)
      setEmailOwnershipToken(ownership.emailOwnershipToken)
      setAnnualOffer(offer)
      setAnnualOfferRequestId(offer.requestId)
      setRecoveredSignupEmail(context.email)
      setWantsProductUpdates(context.wantsProductUpdates)
      setRememberDevice(context.rememberDevice)
      setReturnTo(context.returnTo ?? null)
      if (context.returnTo) {
        const current = new URL(window.location.href)
        current.searchParams.set('return_to', context.returnTo)
        window.history.replaceState({}, '', `${current.pathname}${current.search}${current.hash}`)
      }
      setAwaitingEmailProof(false)
      setEmailProofUnavailable(false)
      setProvisionError(null)
      setPlanView('cards')
      // Passwords are intentionally never part of the email-link context.
      setStep('verifiedAccount')
      // The continuation has been spent; it must not outlive this funnel in
      // browser-profile storage. Other concurrently requested lineages remain.
      clearEmailProofContext(context.requestId)
      stripEmailVerificationTokenFromUrl()
    })().catch((err: unknown) => {
      if (!cancelled) setProvisionError(err instanceof Error ? err.message : 'Email verification could not be completed. Request a new link.')
    })
    return () => { cancelled = true }
  }, [prepareSignupDraft])

  const handleAccountComplete = useCallback(async (data: SignupFormData) => {
    formDataRef.current = data
    const normalizedUrl = serverUrl.trim() ? normalizeServerUrl(serverUrl) : undefined
    if (normalizedUrl) {
      localStorage.setItem('silentsuite-server-url', normalizedUrl)
    } else {
      localStorage.removeItem('silentsuite-server-url')
    }

    const identifier = normalizeEmailForComparison(data.email || '')
    const selfHosted = isSelfHosted || isCustomServer(normalizedUrl)

    if (selfHosted) {
      await createEtebaseAccount(identifier, data.password, normalizedUrl)

      const pending = useAuthStore.getState().pendingSignup
      if (!pending) console.error('pendingSignup not set after createEtebaseAccount')
      if (pending) {
        useAuthStore.setState({
          pendingSignup: { ...pending, wantsProductUpdates },
        })
      }
      setUsingSelfHostedServer(true)
      setStep('selfhost')
      return
    }

    prepareSignupDraft(identifier, wantsProductUpdates, rememberDevice)
    setClientSecret(null)
    setCryptoPaymentSession(null)
    setProvisionError(null)
    setPlanView('cards')
    setUsingSelfHostedServer(false)
    const requestId = crypto.randomUUID()
    const context: EmailProofContext = {
      email: identifier,
      requestId,
      wantsProductUpdates,
      rememberDevice,
      returnTo,
      expiresAt: Date.now() + 15 * 60_000,
    }
    await requestSignupEmailOwnership({ fetcher: fetch, billingApiUrl: BILLING_API_URL, email: identifier, requestId })
    // This full-navigation continuation intentionally contains no password, and
    // is browser-profile scoped so the emailed link works from a new tab.
    const existing = (() => { try { return JSON.parse(localStorage.getItem(EMAIL_PROOF_CONTEXT_KEY) ?? '{}') as Record<string, EmailProofContext> } catch { return {} } })()
    localStorage.setItem(EMAIL_PROOF_CONTEXT_KEY, JSON.stringify({ ...existing, [requestId]: context }))
    setEmailProofUnavailable(false)
    setAwaitingEmailProof(true)
  }, [createEtebaseAccount, prepareSignupDraft, rememberDevice, returnTo, serverUrl, wantsProductUpdates])

  const handleSelfHostChoice = useCallback(async () => {
    try {
      await signup('self-hosted', 'immediate')
    } catch {
      // Error displayed by store
    }
    setStep('admin')
  }, [signup])

  const handleAdminInfoComplete = useCallback(() => {
    setStep('vault')
  }, [])

  const handleVerifiedAccountComplete = useCallback(async (data: PaidAccountFormData) => {
    if (!annualOffer || !emailOwnershipToken || !recoveredSignupEmail) {
      throw new Error('Your verified annual offer is no longer available. Request a new email link.')
    }
    const email = normalizeEmailForComparison(recoveredSignupEmail)
    if (!email) throw new Error('Your verified email is unavailable. Request a new email link.')
    // This is the only password lifetime after the full email-link navigation:
    // an in-memory ref consumed by the selected annual authority path.
    formDataRef.current = { email, confirmEmail: email, password: data.password, confirmPassword: data.confirmPassword }
    setProvisionError(null)
    setPlanView('cards')
    setStep('plan')
  }, [annualOffer, emailOwnershipToken, recoveredSignupEmail])

  const renewAnnualOfferAndRequireConsent = useCallback(async (staleOffer: AnnualOfferResponse | null) => {
    const email = normalizeEmailForComparison(recoveredSignupEmail ?? '')
    const requestId = staleOffer?.requestId ?? annualOfferRequestId
    // Provider choice, card secret, and BTCPay checkout data are consent
    // derived from the rejected offer, so none may survive a refresh.
    setClientSecret(null)
    setCryptoPaymentSession(null)
    setPendingAnnualClaim(null)
    setPlanView('cards')
    setAnnualOffer(null)
    setProvisionError(null)
    setStep('plan')
    if (!email || !requestId) {
      setProvisionError('The annual terms changed. Verify your email again to request the current offer.')
      return
    }
    try {
      const renewedOffer = await fetchAnonymousAnnualOffer({
        fetcher: fetch,
        billingApiUrl: BILLING_API_URL,
        email,
        requestId,
      })
      setAnnualOffer(renewedOffer)
      setAnnualOfferRequestId(renewedOffer.requestId)
      setProvisionError('The annual terms changed. Review the updated offer and choose a trial or payment method again.')
    } catch {
      // Never fall back to stale signed terms if the authoritative refetch
      // fails. The visible retry only renews terms; it cannot start payment.
      setAnnualOffer(null)
      setProvisionError('The annual terms changed, but the current offer could not be loaded. Retry to review current terms before continuing.')
    }
  }, [annualOfferRequestId, recoveredSignupEmail])

  const handleSelectFree = useCallback(async () => {
    setProvisioning(true)
    setProvisionError(null)
    try {
      const data = formDataRef.current
      if (!data) throw new Error('Please enter your account details again.')
      if (!annualOffer || !emailOwnershipToken || !recoveredSignupEmail) throw new Error('Verify your email before selecting a trial.')
      const authority = await activateAnnualCheckout({
        fetcher: fetch,
        billingApiUrl: BILLING_API_URL,
        offer: annualOffer,
        email: recoveredSignupEmail,
        emailOwnershipToken,
        trialPath: 'trial_7day_no_card',
        provider: 'none',
        behavior: 'no_card_trial',
      })
      setPendingAnnualClaim({ activation: authority, provider: 'none' })
      setPlanView('confirm')
    } catch (err: unknown) {
      if (isRenewableAnnualOfferError(err)) {
        await renewAnnualOfferAndRequireConsent(annualOffer)
        return
      }
      const message = err instanceof Error ? err.message : 'Failed to set up your account'
      setProvisionError(message)
    } finally {
      setProvisioning(false)
    }
  }, [annualOffer, emailOwnershipToken, recoveredSignupEmail, renewAnnualOfferAndRequireConsent])

  const handleSelectPaid = useCallback(async () => {
    setProvisionError(null)
    setProvisioning(true)
    try {
      if (!annualOffer || !emailOwnershipToken || !recoveredSignupEmail) throw new Error('Verify your email before selecting a trial.')
      if (!isAnnualOfferProviderAvailable(annualOffer.offer, 'stripe')) throw new Error('Card checkout is not available for this server-owned annual offer.')
      const authority = await activateAnnualCheckout({
        fetcher: fetch,
        billingApiUrl: BILLING_API_URL,
        offer: annualOffer,
        email: recoveredSignupEmail,
        emailOwnershipToken,
        trialPath: 'trial_30day_card',
        provider: 'stripe',
        behavior: 'card_trial',
      })
      setPendingAnnualClaim({ activation: authority, provider: 'stripe' })
      setPlanView('confirm')
    } catch (err: unknown) {
      if (isRenewableAnnualOfferError(err)) {
        await renewAnnualOfferAndRequireConsent(annualOffer)
        return
      }
      const message = err instanceof Error ? err.message : 'Failed to set up your account'
      setProvisionError(message)
      setPlanView('method')
    } finally {
      setProvisioning(false)
    }
  }, [annualOffer, emailOwnershipToken, recoveredSignupEmail, renewAnnualOfferAndRequireConsent])

  const handleSelectCrypto = useCallback(async () => {
    setProvisionError(null)
    setProvisioning(true)
    try {
      if (!annualOffer || !emailOwnershipToken || !recoveredSignupEmail) throw new Error('Verify your email before selecting a payment method.')
      if (!isAnnualOfferProviderAvailable(annualOffer.offer, 'btcpay', CRYPTO_CHECKOUT_ENABLED)) throw new Error('Cryptocurrency checkout is not available for this server-owned annual offer.')
      if (cryptoPaymentSession) {
        setPlanView('crypto')
        return
      }
      const authority = await activateAnnualCheckout({
        fetcher: fetch,
        billingApiUrl: BILLING_API_URL,
        offer: annualOffer,
        email: recoveredSignupEmail,
        emailOwnershipToken,
        trialPath: 'immediate',
        provider: 'btcpay',
        behavior: 'prepaid_bitcoin',
      })
      setPendingAnnualClaim({ activation: authority, provider: 'btcpay' })
      setPlanView('confirm')
    } catch (err: unknown) {
      if (isRenewableAnnualOfferError(err)) {
        await renewAnnualOfferAndRequireConsent(annualOffer)
        return
      }
      setProvisionError(err instanceof Error ? err.message : 'Failed to start crypto checkout')
    } finally {
      setProvisioning(false)
    }
  }, [annualOffer, cryptoPaymentSession, emailOwnershipToken, recoveredSignupEmail, renewAnnualOfferAndRequireConsent])

  const handleConfirmAnnualClaim = useCallback(async () => {
    const pending = pendingAnnualClaim
    if (!pending || !annualOffer) return
    setProvisioning(true)
    setProvisionError(null)
    try {
      if (pending.provider === 'none') {
        const data = formDataRef.current
        if (!data) throw new Error('Please enter your account details again.')
        const normalizedUrl = serverUrl.trim() ? normalizeServerUrl(serverUrl) : undefined
        await createEtebaseAccount(data.email, data.password, normalizedUrl)
        await provisionAnnualNoCard(pending.activation.checkoutIntentToken)
        setPendingAnnualClaim(null)
        setStep('vault')
        return
      }
      const returnPath = pending.provider === 'stripe' ? '/signup' : '/signup/pending-payment'
      const result = await startAnnualSignupPayment(pending.activation.checkoutIntentToken, pending.provider, new URL(returnPath, window.location.origin).toString())
      if (pending.provider === 'stripe') {
        if (result.clientSecret) {
          trackCheckoutInitiated(annualOffer.offer, 'stripe')
          setClientSecret(result.clientSecret)
        }
        setPendingAnnualClaim(null)
        setPlanView('payment')
        return
      }
      if (!result.cryptoCheckoutUrl) {
        throw new Error('Crypto checkout did not return a payment URL.')
      }
      const checkoutUrl = new URL(result.cryptoCheckoutUrl)
      if (checkoutUrl.origin !== BTCPAY_CHECKOUT_ORIGIN || checkoutUrl.protocol !== 'https:') {
        throw new Error('Crypto checkout returned an unexpected payment URL.')
      }
      if (result.cryptoInvoiceId) {
        sessionStorage.setItem('silentsuite-pending-crypto-invoice', result.cryptoInvoiceId)
      }
      if (!result.cryptoInvoiceId || !result.cryptoInvoiceLookupToken) {
        throw new Error('Crypto checkout did not return a complete payment session.')
      }
      const requestKey = useAuthStore.getState().pendingSignup?.paymentSessionRequestKey
      if (!isUuid(requestKey)) throw new Error('Billing did not retain the payment recovery lineage.')
      sessionStorage.setItem('silentsuite-pending-crypto-recovery-context', JSON.stringify({ email: recoveredSignupEmail, requestKey }))
      if (returnTo) {
        sessionStorage.setItem('silentsuite-pending-crypto-return-to', returnTo)
      } else {
        sessionStorage.removeItem('silentsuite-pending-crypto-return-to')
      }
      setCryptoPaymentSession({
        invoiceId: result.cryptoInvoiceId,
        lookupToken: result.cryptoInvoiceLookupToken,
        checkoutUrl: checkoutUrl.toString(),
      })
      setPendingAnnualClaim(null)
      trackCheckoutInitiated(annualOffer.offer, 'btcpay')
      setPlanView('crypto')
    } catch (err: unknown) {
      if (isRenewableAnnualOfferError(err)) {
        await renewAnnualOfferAndRequireConsent(annualOffer)
        return
      }
      const message = err instanceof Error ? err.message : 'Failed to start crypto checkout'
      setProvisionError(message)
    } finally {
      setProvisioning(false)
    }
  }, [annualOffer, createEtebaseAccount, pendingAnnualClaim, provisionAnnualNoCard, recoveredSignupEmail, renewAnnualOfferAndRequireConsent, returnTo, serverUrl, startAnnualSignupPayment])

  const handlePlanBack = useCallback(() => {
    if (planView === 'confirm') {
      setPendingAnnualClaim(null)
      setPlanView('method')
    } else if (planView === 'crypto') {
      setPlanView('method')
    } else if (planView === 'payment') {
      setPlanView('method')
    } else if (planView === 'method') {
      setPlanView('cards')
    } else {
      // Back from cards view goes to account step
      setStep('account')
    }
  }, [planView])

  const createAndFinalizePaidAccount = useCallback(async (password?: string) => {
    const data = formDataRef.current
    if (!data?.email) throw new Error('Please enter your account details again.')
    const normalizedUrl = serverUrl.trim() ? normalizeServerUrl(serverUrl) : undefined
    await createEtebaseAccount(data.email, password ?? data.password, normalizedUrl)
    await finalizePaidSignup()
  }, [createEtebaseAccount, finalizePaidSignup, serverUrl])

  const handlePaymentComplete = useCallback(async () => {
    setProvisioning(true)
    setProvisionError(null)
    try {
      await createAndFinalizePaidAccount()
      setCryptoPaymentSession(null)
      setStep('vault')
    } catch (err) {
      setProvisionError(err instanceof Error ? err.message : 'Payment succeeded, but account creation needs one more step.')
      setStep('paidAccount')
    } finally {
      setProvisioning(false)
    }
  }, [createAndFinalizePaidAccount])

  const handlePaidAccountComplete = useCallback(async (data: PaidAccountFormData) => {
    await createAndFinalizePaidAccount(data.password)
    setStep('vault')
  }, [createAndFinalizePaidAccount])

  const handleVaultComplete = useCallback(() => {
    // Finalize authentication — only NOW does the user become authenticated.
    completeSignup()
    if (returnTo) {
      setShowReturnFallback(false)
      window.location.href = returnTo
      window.setTimeout(() => {
        if (document.visibilityState === 'visible') setShowReturnFallback(true)
      }, 2000)
      return
    }
    router.push('/')
  }, [completeSignup, returnTo, router])

  const email = formDataRef.current?.email || ''

  const activeSteps = usingSelfHostedServer
    ? STEPS_SELFHOST
    : STEPS_HOSTED

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-stretch justify-center md:flex-row md:items-start">
      <ProgressStepper currentStep={step === 'paidAccount' ? 'vault' : step === 'verifiedAccount' ? 'account' : step} steps={activeSteps} />
      <div className="mx-auto w-full max-w-md min-w-0 md:mx-0 md:flex-1">
        {step === 'account' && (
          <>
            {emailProofUnavailable && (
              <div role="alert" className="mb-4 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-600 dark:text-red-400">
                <p className="font-medium">This verification link could not be matched to a signup in this browser.</p>
                <p className="mt-1">
                  Open the link in the browser you started signing up in, or enter your details below to request a new verification email.
                </p>
              </div>
            )}
            <StepCreateAccount
              onNext={handleAccountComplete}
              serverUrl={serverUrl}
              setServerUrl={setServerUrl}
              initialData={formDataRef.current}
              wantsProductUpdates={wantsProductUpdates}
              onWantsProductUpdatesChange={setWantsProductUpdates}
              rememberDevice={rememberDevice}
              onRememberDeviceChange={setRememberDevice}
            />
            {awaitingEmailProof && <p role="status" className="mt-4 text-center text-sm text-[rgb(var(--muted))]">Check your email and open the verification link in this browser. Your password is not saved while you open the link.</p>}
          </>
        )}
        {step === 'verifiedAccount' && (
          <StepCreatePaidAccount
            email={recoveredSignupEmail ?? ''}
            onNext={handleVerifiedAccountComplete}
            initialError={provisionError}
            continuation="verified-no-card"
          />
        )}
        {step === 'selfhost' && (
          <StepSelfHostSupport onNext={handleSelfHostChoice} />
        )}
        {step === 'admin' && (
          <StepAdminInfo serverUrl={serverUrl.trim()} onNext={handleAdminInfoComplete} />
        )}
        {step === 'plan' && (
          annualOffer ? <StepChoosePlan
            key={`${annualOffer.requestId}:${annualOffer.offer.offerToken}`}
            annualOffer={annualOffer}
            onSelectFree={handleSelectFree}
            onChoosePaymentMethod={() => setPlanView('method')}
            onSelectPaid={handleSelectPaid}
            onSelectCrypto={handleSelectCrypto}
            planView={planView}
            onBack={handlePlanBack}
            clientSecret={clientSecret}
            provisioning={provisioning}
            provisionError={provisionError}
            onClearError={() => setProvisionError(null)}
            onClearCryptoPaymentSession={() => setCryptoPaymentSession(null)}
            onPaymentComplete={handlePaymentComplete}
            cryptoPaymentSession={cryptoPaymentSession}
            pendingAnnualClaim={pendingAnnualClaim}
            onConfirmAnnualClaim={handleConfirmAnnualClaim}
          /> : <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-600 dark:text-red-400">
            <p>{provisionError ?? 'Your server-owned annual offer is unavailable. Verify your email to request a new offer.'}</p>
            {annualOfferRequestId && recoveredSignupEmail && (
              <button
                type="button"
                onClick={() => { void renewAnnualOfferAndRequireConsent(null) }}
                disabled={provisioning}
                className="mt-3 text-sm font-medium underline disabled:opacity-60"
              >
                Retry current annual offer
              </button>
            )}
          </div>
        )}
        {step === 'paidAccount' && (
          <StepCreatePaidAccount
            email={formDataRef.current?.email ?? ''}
            onNext={handlePaidAccountComplete}
            initialError={provisionError}
          />
        )}
        {step === 'vault' && (
          <>
            <StepCreateVault email={email} onComplete={handleVaultComplete} />
            {showReturnFallback && returnTo && (
              <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-[rgb(var(--foreground))]">
                <p className="font-medium">Browser did not reopen the Android app automatically.</p>
                <a href={returnTo} className="mt-2 inline-flex font-medium text-[rgb(var(--primary))] underline">
                  Tap here to return to Android
                </a>
              </div>
            )}
          </>
        )}
      </div>
      {/* Build version indicator */}
      <div className="fixed bottom-2 left-2 text-[10px] text-slate-600 font-mono select-none pointer-events-none">
        v{DISPLAY_VERSION}
      </div>
    </div>
  )
}
