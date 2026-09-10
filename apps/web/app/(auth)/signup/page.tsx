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
import { AnnualTermsSummary, annualRetryAction, annualCardSubmitLabel, noCardTrialConsequence } from './components/annual-confirmation-summary'
import PendingPaymentPage from './pending-payment/page'
import { PaymentBackModal } from './components/payment-back-modal'
import { PaymentProblemsLink } from './components/payment-problems-link'
import { useSignupNavigation } from './use-signup-navigation'
import { SignupRecoveryWarning } from './components/signup-recovery-warning'
import { PasswordKeyAcknowledgement, StepCreateVault } from './components/step-create-vault'
import { StepCreatePaidAccount, type PaidAccountFormData } from './components/step-create-paid-account'
import { QRCodeSVG } from 'qrcode.react'
import { createEmailLinkContinuation } from '@/app/lib/signup-email-continuation'
import { trackCheckoutInitiated, trackPlanSelected } from './commercial-funnel-analytics'
import {
  activateAnnualCheckout,
  consumeSignupEmailOwnership,
  fetchAnonymousAnnualOffer,
  cancelUnclaimedAnnualSelection,
  BillingResponseError,
  isRenewableAnnualOfferError,
  requestSignupEmailOwnership,
  type AnnualCheckoutActivation,
  type AnnualOfferResponse,
} from '@/app/lib/billing-v2'
import {
  annualOfferAnnualLabel,
  annualOfferPlanLabel,
  formatAnnualOfferAmount,
  isAnnualOfferProviderAvailable,
} from '@/app/lib/annual-offer-presentation'

const CRYPTO_CHECKOUT_ENABLED = process.env.NEXT_PUBLIC_BTCPAY_CHECKOUT_ENABLED === 'true'
const BTCPAY_CHECKOUT_ORIGIN = process.env.NEXT_PUBLIC_BTCPAY_CHECKOUT_ORIGIN ?? 'https://btcpay.silentsuite.io'
const EMAIL_PROOF_CONTEXT_KEY = 'silentsuite-signup-email-proof'
const EMAIL_VERIFIED_MARKER_KEY = 'silentsuite-signup-email-verified'

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

function saveEmailProofContext(context: EmailProofContext) {
  const existing = (() => {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(EMAIL_PROOF_CONTEXT_KEY) ?? '{}')
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}
    } catch { return {} }
  })()
  localStorage.setItem(EMAIL_PROOF_CONTEXT_KEY, JSON.stringify({ ...existing, [context.requestId]: context }))
}

/**
 * Cross-tab presentation hint only. The tab that follows the emailed link
 * records which verification request it completed so that the original
 * "check your email" tab can say so. It carries no proof, token, password or
 * offer, grants nothing, and is matched strictly against the request this tab
 * is still waiting on.
 */
type EmailVerifiedMarker = { requestId: string; verifiedAt: number; expiresAt: number }

function publishEmailVerifiedMarker(requestId: string) {
  try {
    const marker: EmailVerifiedMarker = { requestId, verifiedAt: Date.now(), expiresAt: Date.now() + 15 * 60_000 }
    localStorage.setItem(EMAIL_VERIFIED_MARKER_KEY, JSON.stringify(marker))
  } catch {
    // The hint is optional; the callback tab continues regardless.
  }
}

function readEmailVerifiedMarker(raw: string | null): EmailVerifiedMarker | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<EmailVerifiedMarker>
    if (isUuid(parsed.requestId) && typeof parsed.verifiedAt === 'number'
      && typeof parsed.expiresAt === 'number' && parsed.expiresAt > Date.now()) {
      return parsed as EmailVerifiedMarker
    }
    return null
  } catch {
    return null
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
  disclosure: AnnualCheckoutActivation['disclosure']
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

/** Customer-facing message for a payment start that did not complete; never a fresh-start hint. */
function describePaymentStartError(err: unknown): string {
  return err instanceof BillingResponseError
    && err.billingProblemType === 'https://api.silentsuite.io/errors/provider-unavailable'
    ? 'Payment creation is not yet confirmed. Retry this same payment, or recover its status. Do not start another payment.'
    : err instanceof Error ? err.message : 'Failed to start checkout'
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
  const submittingRef = useRef(false)
  const needsPassword = isSelfHosted || isCustomServer(serverUrl.trim() ? normalizeServerUrl(serverUrl) : undefined)

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
    resolver: zodResolver(needsPassword ? signupSchema : z.object({ email: signupEmailSchema.shape.email })) as any,
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
        if (submittingRef.current) return
        submittingRef.current = true
        setSubmitError(null)
        setIsSubmitting(true)
        try {
          await onNext(needsPassword ? data : { email: data.email, confirmEmail: data.email, password: '', confirmPassword: '' })
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Account creation failed. Please try again.'
          setSubmitError(message)
        } finally {
          submittingRef.current = false
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

        {needsPassword && <div className="space-y-2">
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
        </div>}

        {needsPassword && <><div className="space-y-2">
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

        </>}

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
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={rememberDevice}
              onChange={(e) => onRememberDeviceChange(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-[rgb(var(--border))] bg-[rgb(var(--surface))] text-[rgb(var(--primary))] focus:ring-[rgb(var(--primary))] focus:ring-offset-0"
            />
            <span className="text-xs text-[rgb(var(--muted))] leading-relaxed">Keep me signed in on this device</span>
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
          <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
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
          {needsPassword ? 'No phone number required. Just email and password.' : 'First verify your email. You will choose a password next.'}
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

function CryptoPaymentPanel({
  annualOffer,
  session,
  onBack,
  disclosure,
  onConfirm,
  provisioning = false,
  provisionError,
  onPaymentComplete,
}: {
  annualOffer: AnnualOfferResponse['offer']
  session: CryptoPaymentSession | null
  disclosure: AnnualCheckoutActivation['disclosure']
  onConfirm?: () => void
  provisioning?: boolean
  provisionError?: string | null
  onBack: () => void
  onPaymentComplete: () => void
}) {
  const saveSignupStateForRedirect = useAuthStore((s) => s.saveSignupStateForRedirect)
  const [paymentMethods, setPaymentMethods] = useState<CryptoPaymentMethod[]>([])
  const [selectedMethodId, setSelectedMethodId] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'pending' | 'processing' | 'settled' | 'expired' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [detailsAttempt, setDetailsAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false

    async function loadPaymentMethods() {
      if (!session) return
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
        const usable = methods.filter(method => (method.id === 'BTC-CHAIN' || method.id === 'BTC-LN' || method.id === 'BTC') && (method.qrValue || method.paymentLink || method.address))
        if (!usable.length) throw new Error('Could not load Bitcoin payment details.')
        setPaymentMethods(usable)
        setSelectedMethodId(usable[0].id)
        setStatus(current => ['settled', 'expired', 'processing'].includes(current) ? current : 'pending')
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load Bitcoin payment details.')
          setStatus(current => ['settled', 'expired', 'processing'].includes(current) ? current : 'error')
        }
      }
    }

    loadPaymentMethods()
    return () => { cancelled = true }
  }, [session, detailsAttempt])

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    let attempts = 0

    async function poll() {
      if (!session) return
      if (++attempts > 180) { setStatus('processing'); return }
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
          sessionStorage.removeItem('silentsuite-pending-crypto-invoice')
          sessionStorage.removeItem('silentsuite-pending-crypto-token')
          sessionStorage.removeItem('silentsuite-pending-crypto-return-to')
          timer = window.setTimeout(onPaymentComplete, 1200)
          return
        }
        if (data.status === 'processing') setStatus('processing')
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
  }, [onPaymentComplete, session])

  const selectedMethod = paymentMethods.find((method) => method.id === selectedMethodId) ?? paymentMethods[0]
  const qrValue = selectedMethod?.qrValue ?? selectedMethod?.paymentLink ?? selectedMethod?.address ?? ''
  const handleExternalCheckout = () => saveSignupStateForRedirect(annualOffer.billingInterval)

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
    // Display/poll status is not an exact release receipt. Retain payment recovery.
    onBack()
  }

  return (
    <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-300 motion-reduce:animate-none">
      <div className="space-y-2 text-center">
        <h2 className="text-lg sm:text-xl font-semibold text-[rgb(var(--foreground))]">Pay {formatAnnualOfferAmount(annualOffer)} with Bitcoin</h2>
        <p className="text-sm text-[rgb(var(--muted))]">
          {session
            ? <>Scan the QR code or copy the payment details for your {annualOfferPlanLabel(annualOffer)}. Access unlocks after settlement confirms.</>
            : 'Your Bitcoin invoice could not be created yet. Retry the same payment below; a second invoice is never started here.'}
        </p>
      </div>

      {/* Terms stay beside the payable controls instead of on a separate review screen. */}
      <AnnualTermsSummary disclosure={disclosure} />
      {provisionError && <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-600 dark:text-red-400">{provisionError}</div>}
      {!session ? (
        <Button type="button" className="w-full" disabled={provisioning} onClick={onConfirm}>
          {provisioning ? 'Starting…' : annualRetryAction(disclosure)}
        </Button>
      ) : status === 'settled' ? (
        <div className="space-y-4 text-center">
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-700 dark:text-emerald-300">
            Payment confirmed for your {annualOfferPlanLabel(annualOffer)}. Account and vault setup still need to finish.
          </div>
        </div>
      ) : status === 'processing' ? (
        <div className="space-y-3 text-sm"><p>Payment is processing or still unconfirmed. Your account continues automatically once it is confirmed.</p></div>
      ) : status === 'expired' ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-200">
          This Bitcoin invoice expired. Expiry alone does not confirm cancellation: use Back to cancel it, or contact support if you sent a payment.
        </div>
      ) : status === 'error' ? (
        <div className="space-y-3 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-600 dark:text-red-400">
          <p>{error ?? 'Could not load Bitcoin payment details.'}</p>
          <button type="button" onClick={() => { setError(null); setStatus('loading'); setDetailsAttempt(value => value + 1) }} className="underline">Retry Bitcoin payment details</button>
          <Link href={session.checkoutUrl} onClick={handleExternalCheckout} className="inline-flex h-9 w-full items-center justify-center rounded-md border border-red-500/30 bg-transparent px-4 py-2 text-sm font-medium text-red-700 shadow-sm transition-colors hover:bg-red-500/10 dark:text-red-200">
            Open in BTCPay instead
          </Link>
        </div>
      ) : selectedMethod && qrValue ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
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
            {/* Monero is not a live rail: Billing's invoice allow-list is BTC-CHAIN and BTC-LN only. */}
            <button
              type="button"
              disabled
              aria-disabled="true"
              title="Monero payments are not available yet"
              className="cursor-not-allowed rounded-lg border border-dashed border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-3 py-2 text-sm text-[rgb(var(--muted))] opacity-60"
            >
              Monero (soon)
            </button>
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
          <p className="mt-3 text-sm text-[rgb(var(--muted))]">Loading Bitcoin payment details...</p>
        </div>
      )}

      <button
        onClick={handleBack}
        disabled={provisioning}
        className="flex items-center gap-1.5 text-sm text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back
      </button>
      {session && <PaymentProblemsLink />}
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
  cardDisclosure,
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
  cardDisclosure: AnnualCheckoutActivation['disclosure'] | null
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
  const [startingMethod, setStartingMethod] = useState<'stripe' | 'btcpay' | null>(null)
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

  // Choosing a method with its price and charge timing visible is the
  // affirmative step; the parent reserves the offer and opens the provider's
  // own payment surface. No funds move until the customer confirms there.
  const handleSelectCard = useCallback(() => {
    if (!stripeAvailable) {
      setPaymentMethodError('Card checkout is not available for this annual offer.')
      return
    }
    setPaymentMethodError(null)
    setStartingMethod('stripe')
    trackPlanSelected(annualOfferDetails)
    onSelectPaid()
  }, [annualOfferDetails, onSelectPaid, stripeAvailable])

  const handleSelectBitcoin = useCallback(() => {
    if (!bitcoinAvailable) {
      setPaymentMethodError('Bitcoin checkout is not available for this annual offer.')
      return
    }
    setPaymentMethodError(null)
    setStartingMethod('btcpay')
    trackPlanSelected(annualOfferDetails)
    onSelectCrypto()
  }, [annualOfferDetails, bitcoinAvailable, onSelectCrypto])


  useEffect(() => {
    // Scroll to top of page on step transitions, not just the element
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [planView])

  useEffect(() => {
    if (!provisioning) setStartingMethod(null)
  }, [provisioning])

  // --- Payment sub-step ---
  if (planView === 'confirm' && pendingAnnualClaim) {
    const disclosure = pendingAnnualClaim.activation.disclosure
    if (pendingAnnualClaim.provider === 'btcpay') return <CryptoPaymentPanel
      annualOffer={annualOfferDetails} session={null} disclosure={disclosure}
      onConfirm={onConfirmAnnualClaim} provisioning={provisioning} provisionError={provisionError}
      onBack={onBack} onPaymentComplete={onPaymentComplete} />
    if (pendingAnnualClaim.provider === 'none') {
      // The password-loss acknowledgement is the only gate before the no-card
      // account is created; nothing is provisioned until it is ticked.
      return (
        <div ref={contentRef} className="animate-in fade-in slide-in-from-right-4 duration-300 motion-reduce:animate-none">
          <PasswordKeyAcknowledgement
            onContinue={onConfirmAnnualClaim}
            busy={provisioning}
            error={provisionError}
            consequence={noCardTrialConsequence(disclosure)}
          >
            <button type="button" disabled={provisioning} onClick={onBack} className="flex items-center gap-1.5 text-sm text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors">
              <ArrowLeft className="h-4 w-4" /> Back
            </button>
          </PasswordKeyAcknowledgement>
        </div>
      )
    }
    // A reserved card claim whose payment session did not start. Retry the
    // same claim here; the card form itself opens once Stripe returns a secret.
    return (
      <div ref={contentRef} className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-300 motion-reduce:animate-none">
        <div className="space-y-2 text-center">
          <h2 className="text-lg sm:text-xl font-semibold text-[rgb(var(--foreground))]">Add your payment method</h2>
          <p className="text-sm text-[rgb(var(--muted))]">The card form could not be opened yet. Retry below; your selection is kept and nothing has been charged.</p>
        </div>
        <AnnualTermsSummary disclosure={disclosure} />
        {provisionError && <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-600 dark:text-red-400">{provisionError}</div>}
        <Button type="button" className="w-full" disabled={provisioning} onClick={onConfirmAnnualClaim}>
          {provisioning ? 'Starting…' : annualRetryAction(disclosure)}
        </Button>
        <button type="button" disabled={provisioning} onClick={onBack} className="flex items-center gap-1.5 text-sm text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
      </div>
    )
  }

  if (planView === 'crypto' && cryptoPaymentSession) {
    if (!bitcoinAvailable) {
      return (
        <div className="space-y-4" role="alert">
          <p className="text-sm text-red-600 dark:text-red-400">Bitcoin checkout is not available for this annual offer.</p>
          <Button type="button" variant="outline" onClick={onBack}>Back to payment methods</Button>
        </div>
      )
    }
    return (
      <CryptoPaymentPanel
        annualOffer={annualOfferDetails}
        session={cryptoPaymentSession}
        provisionError={provisionError}
        provisioning={provisioning}
        onBack={onBack}
        disclosure={cryptoPaymentSession.disclosure}
        onPaymentComplete={onPaymentComplete}
      />
    )
  }

  if (planView === 'method') {
    return (
      <div ref={contentRef} className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-300 motion-reduce:animate-none">
        <div className="space-y-2 text-center">
          <h2 className="text-lg sm:text-xl font-semibold text-[rgb(var(--foreground))]">Choose how to pay</h2>
        </div>

        <div className="grid gap-3">
          {stripeAvailable && (
            <button
              type="button"
              onClick={handleSelectCard}
              disabled={provisioning}
              aria-label={`Pay by card for ${annualOfferPlanLabel(annualOfferDetails)}, ${annualOfferAnnualLabel(annualOfferDetails)}, billed after the 30-day trial`}
              className="group w-full rounded-xl border-2 border-slate-700/50 bg-[rgb(var(--surface))] p-4 text-left transition-all hover:border-emerald-500/70 hover:bg-emerald-500/5 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-emerald-500/10 p-2.5 shrink-0">
                  <CreditCard className="h-5 w-5 text-emerald-400" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-[rgb(var(--foreground))]">Pay by Card (Powered by Stripe)</h3>
                  <p className="mt-1 text-sm text-[rgb(var(--muted))]">
                    Card gets billed after the 30-day trial. You can cancel anytime.
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
              aria-label={`Pay ${formatAnnualOfferAmount(annualOfferDetails)} with Bitcoin for ${annualOfferPlanLabel(annualOfferDetails)}, paid now with a 30-day money-back guarantee`}
              className="group w-full rounded-xl border-2 border-slate-700/50 bg-[rgb(var(--surface))] p-4 text-left transition-all hover:border-amber-500/70 hover:bg-amber-500/5 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-amber-500/10 p-2.5 shrink-0">
                  <Bitcoin className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-[rgb(var(--foreground))]">Bitcoin, Lightning and Monero</h3>
                  <p className="mt-1 text-sm text-[rgb(var(--muted))]">
                    Payment has to be made with account creation, but we offer a 30-day, no-questions-asked money-back guarantee.
                  </p>
                  <p className="mt-1 text-sm text-[rgb(var(--muted))]">
                    {formatAnnualOfferAmount(annualOfferDetails)} for one year, paid now. No automatic renewal.
                  </p>
                </div>
              </div>
            </button>
          )}

          {!stripeAvailable && !bitcoinAvailable && (
            <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-600 dark:text-red-400">
              No payment method is authorized for this annual offer.
            </p>
          )}
        </div>

        {provisioning && startingMethod && (
          <p role="status" className="text-center text-sm text-[rgb(var(--muted))]">
            {startingMethod === 'stripe' ? 'Opening the card form...' : 'Preparing your Bitcoin invoice...'}
          </p>
        )}

        {(paymentMethodError || provisionError) && (
          <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
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
        </div>

        {/* The validated disclosure states charge amount, timing and renewal once, beside the card form it governs. */}
        {cardDisclosure && <AnnualTermsSummary disclosure={cardDisclosure} />}
        {provisionError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{provisionError}</p>}
        {/* Stripe payment form */}
        {provisioning ? (
          <div className="flex flex-col items-center justify-center py-8">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-[rgb(var(--primary))] border-t-transparent" />
            <p className="mt-3 text-sm text-[rgb(var(--muted))]">Preparing payment form...</p>
          </div>
        ) : clientSecret && cardDisclosure ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-[rgb(var(--muted))]" />
              <h3 className="text-sm font-medium text-[rgb(var(--foreground))]">Card <span className="text-[rgb(var(--muted))] font-normal">(powered by Stripe)</span></h3>
            </div>
            <StripePaymentForm
              clientSecret={clientSecret}
              onSuccess={onPaymentComplete}
              submitLabel={annualCardSubmitLabel(cardDisclosure)}
              mode={cardDisclosure.kind === 'card_trial' ? 'setup' : 'payment'}
              selectedInterval={annualOfferDetails.billingInterval}
            />
            <p className="flex items-center justify-center gap-1.5 text-[10px] text-[rgb(var(--muted))]">
              <Lock className="h-3 w-3 text-emerald-500" />
              Secured by Stripe
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
          disabled={provisioning}
          className="flex items-center gap-1.5 text-sm text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>
        {clientSecret && <PaymentProblemsLink />}
      </div>
    )
  }

  // --- Cards view (plan selection) ---
  return (
    <div ref={contentRef} className="space-y-4 sm:space-y-6 animate-in fade-in slide-in-from-left-4 duration-300 motion-reduce:animate-none">
      <div className="space-y-2 text-center">
        <h2 className="text-lg sm:text-xl font-semibold text-[rgb(var(--foreground))]">Choose your plan</h2>
        <p className="text-sm text-[rgb(var(--muted))]">
          {annualOfferPlanLabel(annualOfferDetails)}
        </p>
      </div>

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

        {/* Card B: 30-day free trial. Heading, badge and feature bullet are the
            pre-annual-rollout copy (82019158^, introduced by #123 8bff947d);
            price and payment-method terms are stated on the next screen. */}
        <button
          onClick={() => setSelectedTrial('30day')}
          aria-label="30-day free trial — full access to all features"
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
              <ul className="mt-3 space-y-1.5">
                <li className="flex items-center gap-2 text-sm text-[rgb(var(--muted))]">
                  <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                  Full access to all features
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
        <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
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
        <span className="text-center">Your data stays encrypted · Export anytime</span>
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
  { key: 'account' as const, label: 'Email', number: 1 },
  { key: 'verifiedAccount' as const, label: 'Password', number: 2 },
  { key: 'plan' as const, label: 'Plan', number: 3 },
  { key: 'vault' as const, label: 'Finish', number: 4 },
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
  const [paymentRecovery, setPaymentRecovery] = useState<boolean | null>(null)
  useEffect(() => {
    // This nonsecret route hint selects a recovery screen, never payment authority.
    setPaymentRecovery(new URLSearchParams(window.location.search).get('recovery') === 'payment')
  }, [])
  if (paymentRecovery === null) return <p role="status" className="py-12 text-center text-sm text-[rgb(var(--muted))]">Loading signup…</p>
  return paymentRecovery ? <PendingPaymentPage /> : <SignupJourney />
}

function SignupJourney() {
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
  const [cardDisclosure, setCardDisclosure] = useState<AnnualCheckoutActivation['disclosure'] | null>(null)
  const [cryptoPaymentSession, setCryptoPaymentSession] = useState<CryptoPaymentSession | null>(null)
  const [provisionError, setProvisionError] = useState<string | null>(null)
  const [provisioning, setProvisioning] = useState(false)
  const operationRef = useRef(false)
  const [usingSelfHostedServer, setUsingSelfHostedServer] = useState(false)
  const [planView, setPlanView] = useState<PlanView>('cards')
  const [wantsProductUpdates, setWantsProductUpdates] = useState(false)
  const [rememberDevice, setRememberDevice] = useState(false)
  const [returnTo, setReturnTo] = useState<string | null>(null)
  const [showReturnFallback, setShowReturnFallback] = useState(false)
  const claimAttemptedRef = useRef(false)
  const [emailOwnershipToken, setEmailOwnershipToken] = useState<string | null>(null)
  const [annualOffer, setAnnualOffer] = useState<AnnualOfferResponse | null>(null)
  const [annualOfferRequestId, setAnnualOfferRequestId] = useState<string | null>(null)
  const [pendingAnnualClaim, setPendingAnnualClaim] = useState<PendingAnnualClaim | null>(null)
  // Reservation cancellation never resolves Etebase/account or provider authority.
  // Keep this bounded UI pre-claim; partial/uncertain creation keeps its continuation.
  const [paymentSwitch, setPaymentSwitch] = useState<'stripe' | 'btcpay' | null>(null)
  const [selectionCancellation, setSelectionCancellation] = useState<'confirm' | 'unknown' | 'refused' | 'verify' | null>(null)
  const pendingAnnualClaimRef = useRef(pendingAnnualClaim)
  pendingAnnualClaimRef.current = pendingAnnualClaim
  const [recoveredSignupEmail, setRecoveredSignupEmail] = useState<string | null>(null)
  const [awaitingEmailProof, setAwaitingEmailProof] = useState(false)
  const sentRequestRef = useRef<string | null>(null)
  // Account creation and reservation ownership have independent lifetimes.
  const encryptedAccountAttemptedRef = useRef(false)
  const [sendingEmail, setSendingEmail] = useState(false)
  // Presentation only: another tab completed this exact verification request.
  const [emailConfirmedElsewhere, setEmailConfirmedElsewhere] = useState(false)
  // The no-card path collects the password-loss acknowledgement before creation.
  const [noCardAcknowledged, setNoCardAcknowledged] = useState(false)
  const backRef = useRef<() => void>(() => {})
  const [selectionGeneration, setSelectionGeneration] = useState(0)
  const [emailProofUnavailable, setEmailProofUnavailable] = useState(false)
  const [emailProofError, setEmailProofError] = useState<string | null>(null)
  const [emailProofBusy, setEmailProofBusy] = useState(false)
  const [requestingEmailProof, setRequestingEmailProof] = useState(false)
  const resendBusyRef = useRef(false)
  const mountedRef = useRef(false)
  const [emailProofAttempt, setEmailProofAttempt] = useState(0)
  const emailContinuationRef = useRef<{
    context: EmailProofContext
    continuation: ReturnType<typeof createEmailLinkContinuation>
  } | null>(null)
  const formDataRef = useRef<SignupFormData | null>(null)

  const navigation = useSignupNavigation({
    enabled: !usingSelfHostedServer && (!!emailOwnershipToken || awaitingEmailProof || sendingEmail) && step !== 'vault',
    warnOnLeave: !(awaitingEmailProof && emailConfirmedElsewhere),
    step,
    view: awaitingEmailProof ? 'sent' : sendingEmail ? 'sending' : planView,
    intercept: () => {
      if (operationRef.current || selectionCancellation || paymentSwitch) return true
      if (awaitingEmailProof || sendingEmail || pendingAnnualClaim || clientSecret || cryptoPaymentSession || claimAttemptedRef.current) {
        backRef.current()
        return true
      }
      return false
    },
    restore: (checkpoint) => {
      if (checkpoint.step === 'verifiedAccount' && !claimAttemptedRef.current && !encryptedAccountAttemptedRef.current) {
        setStep('verifiedAccount')
        return true
      }
      if (checkpoint.step !== 'plan' || !annualOffer || !formDataRef.current?.password) return false
      const view = checkpoint.view
      if (view === 'cards' || view === 'method'
        || (view === 'confirm' && pendingAnnualClaim)
        || (view === 'payment' && clientSecret)
        || (view === 'crypto' && cryptoPaymentSession)) {
        setPlanView(view as PlanView)
        setStep('plan')
        return true
      }
      return false
    },
  })

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    setReturnTo(normalizeSignupReturnTo(new URLSearchParams(window.location.search).get('return_to')))
  }, [])

  useEffect(() => {
    if (!awaitingEmailProof) {
      setEmailConfirmedElsewhere(false)
      return
    }
    // Only the request this tab is still waiting on counts. Back retires it,
    // resend replaces it, and an old link names a different request, so none
    // of those can mark this attempt confirmed. The marker grants nothing.
    const matchesCurrentRequest = (raw: string | null) => {
      const marker = readEmailVerifiedMarker(raw)
      return marker !== null && sentRequestRef.current !== null && marker.requestId === sentRequestRef.current
    }
    try {
      if (matchesCurrentRequest(localStorage.getItem(EMAIL_VERIFIED_MARKER_KEY))) setEmailConfirmedElsewhere(true)
    } catch {
      // Storage is optional for this hint.
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key === EMAIL_VERIFIED_MARKER_KEY && matchesCurrentRequest(event.newValue)) setEmailConfirmedElsewhere(true)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [awaitingEmailProof])

  useEffect(() => {
    if (!emailContinuationRef.current) {
      const params = new URLSearchParams(window.location.search)
      const token = params.get('email_verification_token') ?? params.get('token')
      if (!token) return
      const requestId = params.get('request_id')
      const context = readEmailProofContext(requestId)
      // Capture once, then remove the bearer URL before any fallible request.
      // Strict Mode replay joins the captured continuation, not a second consume.
      stripEmailVerificationTokenFromUrl()
      if (!context) {
        clearEmailProofContext(requestId)
        setEmailProofUnavailable(true)
        setAwaitingEmailProof(false)
        return
      }
      emailContinuationRef.current = {
        context,
        continuation: createEmailLinkContinuation(
          () => consumeSignupEmailOwnership({ fetcher: fetch, billingApiUrl: BILLING_API_URL, email: context.email, token }),
          () => fetchAnonymousAnnualOffer({ fetcher: fetch, billingApiUrl: BILLING_API_URL, email: context.email, requestId: context.requestId }),
        ),
      }
    }
    const { context, continuation } = emailContinuationRef.current
    let cancelled = false
    setEmailProofBusy(true)
    setEmailProofError(null)
    void (async () => {
      const { ownership, offer } = await continuation.load()
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
      // Tell the original waiting tab, if any, that this request is done.
      publishEmailVerifiedMarker(context.requestId)
    })().catch(() => {
      if (!cancelled) setEmailProofError(continuation.hasProof()
        ? 'Your email was verified, but trial options could not be loaded. Retry, or request a new link if verification has expired.'
        : 'This verification link could not be completed. It may have expired, already been used, or the connection was interrupted. Request a new link to continue safely.')
    }).finally(() => {
      if (!cancelled) setEmailProofBusy(false)
    })
    return () => { cancelled = true }
  }, [prepareSignupDraft, emailProofAttempt])

  const requestNewVerificationEmail = useCallback(async () => {
    const previous = emailContinuationRef.current?.context
    if (!previous || resendBusyRef.current) return
    resendBusyRef.current = true
    setRequestingEmailProof(true)
    setSendingEmail(true)
    setEmailProofBusy(true)
    const context = { ...previous, requestId: crypto.randomUUID(), expiresAt: Date.now() + 15 * 60_000 }
    sentRequestRef.current = context.requestId
    setEmailConfirmedElsewhere(false)
    try {
      // Persist the non-secret lineage before sending: a lost acknowledgement
      // must not make a successfully delivered replacement link unusable.
      saveEmailProofContext(context)
      await requestSignupEmailOwnership({ fetcher: fetch, billingApiUrl: BILLING_API_URL, email: context.email, requestId: context.requestId })
      if (!mountedRef.current || sentRequestRef.current !== context.requestId) return
      clearEmailProofContext(previous.requestId)
      emailContinuationRef.current = null
      setEmailOwnershipToken(null)
      setAnnualOffer(null)
      setAnnualOfferRequestId(null)
      setRecoveredSignupEmail(null)
      setEmailProofError(null)
      setEmailProofUnavailable(false)
      setAwaitingEmailProof(true)
    } catch {
      if (mountedRef.current && sentRequestRef.current === context.requestId) setEmailProofError('A new verification email could not be confirmed. Check your inbox, or try requesting another link shortly.')
    } finally {
      resendBusyRef.current = false
      if (mountedRef.current && sentRequestRef.current === context.requestId) {
        setSendingEmail(false)
        setRequestingEmailProof(false)
        setEmailProofBusy(false)
      }
    }
  }, [])

  const handleAccountComplete = useCallback(async (data: SignupFormData) => {
    emailContinuationRef.current = null
    setEmailProofError(null)
    setEmailOwnershipToken(null)
    setAnnualOffer(null)
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
    setCardDisclosure(null)
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
    // This full-navigation continuation intentionally contains no password, and
    // is browser-profile scoped so the emailed link works from a new tab.
    sentRequestRef.current = requestId
    setEmailConfirmedElsewhere(false)
    setSendingEmail(true)
    try {
      saveEmailProofContext(context)
      await requestSignupEmailOwnership({ fetcher: fetch, billingApiUrl: BILLING_API_URL, email: identifier, requestId })
      if (!mountedRef.current || sentRequestRef.current !== requestId) return
      setEmailProofUnavailable(false)
      setAwaitingEmailProof(true)
    } catch {
      if (mountedRef.current && sentRequestRef.current === requestId) {
        setEmailProofError('The verification email could not be confirmed. Check your inbox or try again.')
      }
    } finally {
      if (mountedRef.current && sentRequestRef.current === requestId) setSendingEmail(false)
    }
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
      throw new Error('Your trial options are no longer available. Request a new email link.')
    }
    const email = normalizeEmailForComparison(recoveredSignupEmail)
    if (!email) throw new Error('Your verified email is unavailable. Request a new email link.')
    if (encryptedAccountAttemptedRef.current) throw new Error('Account setup has started. Your original password remains unchanged. Sign in or recover the existing account.')
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
    // Provider choice, card secret, and Bitcoin checkout data are consent
    // derived from the rejected offer, so none may survive a refresh.
    setClientSecret(null)
    setCardDisclosure(null)
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
    if (operationRef.current) return
    if (clientSecret || cryptoPaymentSession) {
      setProvisionError(`Your ${cryptoPaymentSession ? 'Bitcoin' : 'card'} payment is still pending. Resume it, or use Back to cancel it before choosing again.`)
      return
    }
    if (pendingAnnualClaim && (claimAttemptedRef.current || Date.parse(pendingAnnualClaim.activation.expiresAt) > Date.now())) {
      if (pendingAnnualClaim.provider === 'none') setPlanView('confirm')
      else setProvisionError(claimAttemptedRef.current
        ? 'Setup may have started. Return to your current selection below to finish or retry safely.'
        : `Your current option is held until ${new Date(pendingAnnualClaim.activation.expiresAt).toUTCString()}. After that time, choose a different option and continue. Or return to your current selection below.`)
      return
    }
    operationRef.current = true
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
      operationRef.current = false
      setProvisioning(false)
    }
  }, [annualOffer, clientSecret, cryptoPaymentSession, emailOwnershipToken, pendingAnnualClaim, recoveredSignupEmail, renewAnnualOfferAndRequireConsent])

  /**
   * Starts the provider payment for a reserved paid claim. The caller owns
   * `operationRef`/`provisioning` and its own error surface. The same expiry,
   * mutation-marker and single-attempt rules apply on first start and on
   * retry, so a failed start is always retried with the same claim, the same
   * checkout token and the same recovery secret — never a second invoice.
   */
  const startAnnualPayment = useCallback(async (pending: PendingAnnualClaim) => {
    if (pending.provider === 'none' || !annualOffer) throw new Error('Verify your email before selecting a payment method.')
    // Only unattempted authority can be discarded. An expired token after a
    // dispatched request may still own a payment with an unknown outcome.
    if (!claimAttemptedRef.current && Date.parse(pending.activation.expiresAt) <= Date.now()) {
      setPendingAnnualClaim(null)
      setPlanView('cards')
      setProvisionError('Your selected terms expired. Review the options and choose again before continuing.')
      return
    }
    navigation.markMutation('payment')
    claimAttemptedRef.current = true
    const returnPath = pending.provider === 'stripe' ? '/signup' : '/signup/pending-payment'
    const result = await startAnnualSignupPayment(pending.activation.checkoutIntentToken, pending.provider, new URL(returnPath, window.location.origin).toString(), annualOffer.offer.billingInterval)
    if (pending.provider === 'stripe') {
      if (result.clientSecret) {
        trackCheckoutInitiated(annualOffer.offer, 'stripe')
        setCardDisclosure(pending.activation.disclosure)
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
      disclosure: pending.activation.disclosure,
      invoiceId: result.cryptoInvoiceId,
      lookupToken: result.cryptoInvoiceLookupToken,
      checkoutUrl: checkoutUrl.toString(),
    })
    setPendingAnnualClaim(null)
    trackCheckoutInitiated(annualOffer.offer, 'btcpay')
    setPlanView('crypto')
  }, [annualOffer, navigation, recoveredSignupEmail, returnTo, startAnnualSignupPayment])

  const handleSelectPaid = useCallback(async () => {
    if (operationRef.current) return
    if (clientSecret) { setPlanView('payment'); return }
    if (cryptoPaymentSession) {
      // Never a second payable provider: the Bitcoin payment must be cancelled first.
      setProvisionError('Your Bitcoin payment is still pending. Resume it, or use Back to cancel it before choosing card.')
      return
    }
    if (pendingAnnualClaim && (claimAttemptedRef.current || Date.parse(pendingAnnualClaim.activation.expiresAt) > Date.now())) {
      if (pendingAnnualClaim.provider === 'stripe') setPlanView('confirm')
      else setProvisionError(claimAttemptedRef.current
        ? 'Setup may have started. Return to your current selection below to finish or retry safely.'
        : `Your current option is held until ${new Date(pendingAnnualClaim.activation.expiresAt).toUTCString()}. After that time, choose a different option and continue. Or return to your current selection below.`)
      return
    }
    operationRef.current = true
    setProvisionError(null)
    setProvisioning(true)
    let claim: PendingAnnualClaim | null = null
    try {
      if (!annualOffer || !emailOwnershipToken || !recoveredSignupEmail) throw new Error('Verify your email before selecting a trial.')
      if (!isAnnualOfferProviderAvailable(annualOffer.offer, 'stripe')) throw new Error('Card checkout is not available for this annual offer.')
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
      claim = { activation: authority, provider: 'stripe' }
      setPendingAnnualClaim(claim)
      // The card choice was made with price and charge timing visible; open
      // the card form directly. Nothing is charged until it is confirmed there.
      await startAnnualPayment(claim)
    } catch (err: unknown) {
      if (isRenewableAnnualOfferError(err)) {
        await renewAnnualOfferAndRequireConsent(annualOffer)
        return
      }
      setProvisionError(claim ? describePaymentStartError(err) : err instanceof Error ? err.message : 'Failed to set up your account')
      // A reserved claim keeps its retry surface; a failed reservation returns to the methods.
      setPlanView(claim ? 'confirm' : 'method')
    } finally {
      operationRef.current = false
      setProvisioning(false)
    }
  }, [annualOffer, clientSecret, cryptoPaymentSession, emailOwnershipToken, pendingAnnualClaim, recoveredSignupEmail, renewAnnualOfferAndRequireConsent, startAnnualPayment])

  const handleSelectCrypto = useCallback(async () => {
    if (operationRef.current) return
    if (cryptoPaymentSession) { setPlanView('crypto'); return }
    if (clientSecret) {
      // Never a second payable provider: the card checkout must be cancelled first.
      setProvisionError('Your card checkout is still open. Resume it, or use Back to cancel it before choosing Bitcoin.')
      return
    }
    if (pendingAnnualClaim && (claimAttemptedRef.current || Date.parse(pendingAnnualClaim.activation.expiresAt) > Date.now())) {
      if (pendingAnnualClaim.provider === 'btcpay') setPlanView('confirm')
      else setProvisionError(claimAttemptedRef.current
        ? 'Setup may have started. Return to your current selection below to finish or retry safely.'
        : `Your current option is held until ${new Date(pendingAnnualClaim.activation.expiresAt).toUTCString()}. After that time, choose a different option and continue. Or return to your current selection below.`)
      return
    }
    operationRef.current = true
    setProvisionError(null)
    setProvisioning(true)
    let claim: PendingAnnualClaim | null = null
    try {
      if (!annualOffer || !emailOwnershipToken || !recoveredSignupEmail) throw new Error('Verify your email before selecting a payment method.')
      if (!isAnnualOfferProviderAvailable(annualOffer.offer, 'btcpay', CRYPTO_CHECKOUT_ENABLED)) throw new Error('Bitcoin checkout is not available for this annual offer.')
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
      claim = { activation: authority, provider: 'btcpay' }
      setPendingAnnualClaim(claim)
      // The Bitcoin choice was made with price, upfront payment and refund
      // terms visible; create the invoice and show it. Paying is still the
      // customer's own action against the displayed address.
      await startAnnualPayment(claim)
    } catch (err: unknown) {
      if (isRenewableAnnualOfferError(err)) {
        await renewAnnualOfferAndRequireConsent(annualOffer)
        return
      }
      setProvisionError(claim ? describePaymentStartError(err) : err instanceof Error ? err.message : 'Failed to start crypto checkout')
      if (claim) setPlanView('confirm')
    } finally {
      operationRef.current = false
      setProvisioning(false)
    }
  }, [annualOffer, clientSecret, cryptoPaymentSession, emailOwnershipToken, pendingAnnualClaim, recoveredSignupEmail, renewAnnualOfferAndRequireConsent, startAnnualPayment])

  const handleConfirmAnnualClaim = useCallback(async () => {
    const pending = pendingAnnualClaim
    if (!pending || !annualOffer || operationRef.current) return
    // Only unattempted authority can be discarded. An expired token after a
    // dispatched request may still own an account or payment with an unknown outcome.
    if (!claimAttemptedRef.current && Date.parse(pending.activation.expiresAt) <= Date.now()) {
      setPendingAnnualClaim(null)
      setPlanView('cards')
      setProvisionError('Your selected terms expired. Review the options and choose again before continuing.')
      return
    }
    operationRef.current = true
    setProvisioning(true)
    setProvisionError(null)
    try {
      if (pending.provider === 'none') {
        // Reached only through the ticked password-loss acknowledgement.
        navigation.markMutation('setup')
        claimAttemptedRef.current = true
        const data = formDataRef.current
        if (!data) throw new Error('Please enter your account details again.')
        const normalizedUrl = serverUrl.trim() ? normalizeServerUrl(serverUrl) : undefined
        encryptedAccountAttemptedRef.current = true
        await createEtebaseAccount(data.email, data.password, normalizedUrl)
        await provisionAnnualNoCard(pending.activation.checkoutIntentToken)
        setPendingAnnualClaim(null)
        setNoCardAcknowledged(true)
        setStep('vault')
        return
      }
      await startAnnualPayment(pending)
    } catch (err: unknown) {
      if (isRenewableAnnualOfferError(err)) {
        await renewAnnualOfferAndRequireConsent(annualOffer)
        return
      }
      setProvisionError(describePaymentStartError(err))
    } finally {
      operationRef.current = false
      setProvisioning(false)
    }
  }, [annualOffer, createEtebaseAccount, navigation, pendingAnnualClaim, provisionAnnualNoCard, renewAnnualOfferAndRequireConsent, serverUrl, startAnnualPayment])

  const handleCancelSelection = useCallback(async () => {
    const pending = pendingAnnualClaim
    if (useAuthStore.getState().pendingSignup?.provisionedUser) {
      setProvisionError('Your account is already created. Continue setup to establish your session; no new trial or payment is needed.')
      return
    }
    if (!pending || !annualOfferRequestId || !recoveredSignupEmail || !emailOwnershipToken
      || operationRef.current || clientSecret || cryptoPaymentSession) return
    operationRef.current = true
    setProvisioning(true)
    setProvisionError(null)
    setSelectionCancellation('confirm')
    const ownsSelection = () => mountedRef.current && pendingAnnualClaimRef.current === pending
    try {
      await cancelUnclaimedAnnualSelection({
        fetcher: fetch, billingApiUrl: BILLING_API_URL,
        email: recoveredSignupEmail, requestId: annualOfferRequestId,
        checkoutIntentToken: pending.activation.checkoutIntentToken, emailOwnershipToken,
      })
      if (!ownsSelection()) return
      // Only this exact reservation is released. Never reset pendingSignup,
      // credentials, session attestation, or a payment recovery capability.
      pendingAnnualClaimRef.current = null
      setPendingAnnualClaim(null)
      claimAttemptedRef.current = false
      setSelectionCancellation(null)
      setSelectionGeneration((generation) => generation + 1)
      navigation.retireCheckpoints()
      setPlanView('cards')
    } catch (error) {
      if (!ownsSelection()) return
      if (error instanceof BillingResponseError && error.billingStatus === 409
        && error.billingProblemType === 'https://api.silentsuite.io/errors/authority-in-progress') {
        claimAttemptedRef.current = true
        setSelectionCancellation('refused')
        setProvisionError('Setup or payment has already started. Your selection was not cancelled. Continue or recover the existing setup; do not start another payment.')
      } else if (error instanceof BillingResponseError && error.billingStatus === 400) {
        setSelectionCancellation('verify')
        setProvisionError('Cancellation could not be verified. Your selection is retained. Verify ownership again using the same signup request, then retry.')
      } else {
        setSelectionCancellation('unknown')
        setProvisionError('Cancellation is not confirmed. Your selection is retained. Retry cancellation to check this exact selection before choosing again.')
      }
    } finally {
      operationRef.current = false
      if (mountedRef.current) setProvisioning(false)
    }
  }, [annualOfferRequestId, clientSecret, cryptoPaymentSession, emailOwnershipToken, navigation, pendingAnnualClaim, recoveredSignupEmail])

  const handlePlanBack = useCallback(() => {
    if (operationRef.current) return
    if (useAuthStore.getState().pendingSignup?.provisionedUser) {
      setProvisionError('Your account is already created. Continue setup to establish your session; no new trial or payment is needed.')
      return
    }
    if (clientSecret || cryptoPaymentSession) {
      setProvisionError(null)
      setPaymentSwitch(cryptoPaymentSession ? 'btcpay' : 'stripe')
      return
    }
    if (pendingAnnualClaim && pendingAnnualClaim.provider !== 'none' && claimAttemptedRef.current) {
      setSelectionCancellation(null)
      setPlanView('confirm')
      setProvisionError('Payment creation is not yet confirmed. Retry this same payment below, or recover its status. Back cannot confirm cancellation.')
      return
    }
    if (pendingAnnualClaim) { void handleCancelSelection(); return }
    if (claimAttemptedRef.current || clientSecret || cryptoPaymentSession
      || useAuthStore.getState().pendingSignup?.provisionedUser) {
      setProvisionError('Setup or payment has already started. Continue or recover the existing setup; do not start another payment.')
      return
    }
    if (planView === 'method') setPlanView('cards')
    else if (encryptedAccountAttemptedRef.current) {
      setProvisionError('Account setup has started. Your original password remains unchanged. Choose a plan below, or sign in to recover the existing account.')
    } else setStep('verifiedAccount')
  }, [clientSecret, cryptoPaymentSession, handleCancelSelection, pendingAnnualClaim, planView])

  const handleEmailBack = () => {
    clearEmailProofContext(sentRequestRef.current)
    sentRequestRef.current = null
    clearEmailProofContext(emailContinuationRef.current?.context.requestId ?? null)
    setRequestingEmailProof(false)
    setEmailProofBusy(false)
    setSendingEmail(false)
    emailContinuationRef.current = null
    setAwaitingEmailProof(false)
    setEmailConfirmedElsewhere(false)
    setEmailProofError(null)
    navigation.clear()
  }
  backRef.current = awaitingEmailProof || sendingEmail ? handleEmailBack : handlePlanBack

  const handleVerifySelectionOwnership = useCallback(async () => {
    if (operationRef.current || !annualOfferRequestId || !recoveredSignupEmail) return
    operationRef.current = true
    setProvisioning(true)
    try {
      saveEmailProofContext({ email: recoveredSignupEmail, requestId: annualOfferRequestId,
        wantsProductUpdates, rememberDevice, returnTo, expiresAt: Date.now() + 15 * 60_000 })
      await requestSignupEmailOwnership({ fetcher: fetch, billingApiUrl: BILLING_API_URL,
        email: recoveredSignupEmail, requestId: annualOfferRequestId })
      if (mountedRef.current) setProvisionError('Check your email for a verification link for this same signup. Your selection has not been cleared or replaced.')
    } catch {
      if (mountedRef.current) setProvisionError('A verification email could not be confirmed. Your selection is retained; retry verification.')
    } finally {
      operationRef.current = false
      if (mountedRef.current) setProvisioning(false)
    }
  }, [annualOfferRequestId, recoveredSignupEmail, rememberDevice, returnTo, wantsProductUpdates])

  const createAndFinalizePaidAccount = useCallback(async (password?: string) => {
    const data = formDataRef.current
    if (!data?.email) throw new Error('Please enter your account details again.')
    const normalizedUrl = serverUrl.trim() ? normalizeServerUrl(serverUrl) : undefined
    encryptedAccountAttemptedRef.current = true
    await createEtebaseAccount(data.email, password ?? data.password, normalizedUrl)
    await finalizePaidSignup()
  }, [createEtebaseAccount, finalizePaidSignup, serverUrl])

  const handlePaymentComplete = useCallback(async () => {
    if (operationRef.current) return
    operationRef.current = true
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
      operationRef.current = false
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
    navigation.clear()
    if (returnTo) {
      setShowReturnFallback(false)
      window.location.href = returnTo
      window.setTimeout(() => {
        if (document.visibilityState === 'visible') setShowReturnFallback(true)
      }, 2000)
      return
    }
    router.push('/')
  }, [completeSignup, navigation, returnTo, router])

  const email = formDataRef.current?.email || ''

  const activeSteps = usingSelfHostedServer
    ? STEPS_SELFHOST
    : STEPS_HOSTED

  // A refresh during payment continues the same owned payment inline: the
  // pending-payment continuation restores its capability and controls itself.
  if (navigation.recovery === 'payment') return <PendingPaymentPage />
  if (navigation.recovery) {
    return <div className="mx-auto w-full max-w-md space-y-4">
      <SignupRecoveryWarning />
      <h1 className="text-xl font-semibold">Continue your signup safely</h1>
      <p role="status">Your password and verification proof were not saved. Refreshing has not repeated account creation or started another payment.</p>
      {navigation.recovery === 'review' ? <>
        <p>Verify your email again to continue. If you already chose a trial, it may remain reserved briefly; we will not replace a pending payment.</p>
        <Button onClick={() => navigation.clear()}>Verify email again</Button>
      </> : <>
        <p>Setup may already have started. Do not start a second signup or payment. Try signing in with the password you chose. If setup is incomplete, contact support to recover it.</p>
        <Link href="/login" className="block underline">Sign in to your account</Link>
        <a href="mailto:support@silentsuite.io" className="block underline">Contact support</a>
      </>}
    </div>
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-stretch justify-center md:flex-row">
      <ProgressStepper currentStep={!usingSelfHostedServer && (step === 'paidAccount' || (provisioning && step === 'plan' && claimAttemptedRef.current)) ? 'vault' : step} steps={activeSteps} />
      <div className={`mx-auto w-full max-w-md min-w-0 md:mx-0 md:flex-1 ${step === 'account' && (awaitingEmailProof || sendingEmail) ? 'flex flex-col justify-center' : ''}`}>
        <SignupRecoveryWarning />
        {navigation.notice && <p role="status" className="mb-4 text-sm text-[rgb(var(--muted))]">Finish or recover your current setup before changing account details. Your password has not been saved.</p>}
        {step === 'plan' && selectionCancellation && <section className="space-y-4" aria-label="Cancel selection">
          <h2 className="text-xl font-semibold">Cancel this selection?</h2>
          <p>This releases only your trial or payment selection. It does not cancel a payment or subscription, delete an account, or start another trial. You will choose again and review new terms before continuing.</p>
          {provisionError && <p role="alert">{provisionError}</p>}
          {selectionCancellation !== 'refused' && <Button disabled={provisioning} onClick={handleCancelSelection}>
            {provisioning ? 'Checking selection...' : selectionCancellation === 'confirm' ? 'Confirm cancellation' : 'Retry cancellation'}
          </Button>}
          {selectionCancellation === 'confirm' && <Button variant="outline" disabled={provisioning} onClick={() => {
            if (!operationRef.current) setSelectionCancellation(null)
          }}>Keep current selection</Button>}
          {selectionCancellation === 'verify' && <Button variant="outline" disabled={provisioning} onClick={handleVerifySelectionOwnership}>Verify ownership again</Button>}
          {selectionCancellation !== 'confirm' && <Button onClick={() => { setSelectionCancellation(null); setPlanView('confirm') }}>Continue current selection</Button>}
        </section>}
        {step === 'plan' && !selectionCancellation && planView !== 'confirm' && pendingAnnualClaim && <Button variant="outline" disabled={provisioning} className="mb-4 w-full" onClick={() => { setProvisionError(null); setPlanView('confirm') }}>Return to current selection</Button>}
        {step === 'account' && (
          <>
            {emailProofBusy && <p role="status" className="mb-4 text-sm text-[rgb(var(--muted))]">{requestingEmailProof ? 'Requesting a new verification email...' : 'Verifying your email and loading trial options...'}</p>}
            {emailProofError && (
              <div role="alert" className="mb-4 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-600 dark:text-red-400">
                <p>{emailProofError}</p>
                {emailContinuationRef.current?.continuation.hasProof() && (
                  <Button className="mt-3" disabled={emailProofBusy} onClick={() => setEmailProofAttempt((attempt) => attempt + 1)}>
                    Retry loading trial options
                  </Button>
                )}
                {emailContinuationRef.current && (
                  <Button className="mt-3" variant="outline" disabled={emailProofBusy} onClick={requestNewVerificationEmail}>
                    Request a new verification email
                  </Button>
                )}
              </div>
            )}
            {emailProofUnavailable && (
              <div role="alert" className="mb-4 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-600 dark:text-red-400">
                <p className="font-medium">This verification link could not be matched to a signup in this browser.</p>
                <p className="mt-1">
                  Open the link in the browser you started signing up in, or enter your details below to request a new verification email.
                </p>
              </div>
            )}
            {!emailProofBusy && !awaitingEmailProof && !sendingEmail && <StepCreateAccount
              onNext={handleAccountComplete}
              serverUrl={serverUrl}
              setServerUrl={setServerUrl}
              initialData={formDataRef.current}
              wantsProductUpdates={wantsProductUpdates}
              onWantsProductUpdatesChange={setWantsProductUpdates}
              rememberDevice={rememberDevice}
              onRememberDeviceChange={setRememberDevice}
            />}
            {(sendingEmail || awaitingEmailProof) && <section aria-label="Email verification" className="flex flex-col items-center justify-center gap-5 py-8 text-center">
              <p role="status" className="text-sm text-[rgb(var(--muted))]">{sendingEmail
                ? 'Sending verification email...'
                : emailConfirmedElsewhere
                  ? 'Email confirmed. Continue in the other tab. This tab is safe to close.'
                  : 'Check your email and open the verification link in this browser. Then choose your password.'}</p>
              <Button variant="outline" onClick={handleEmailBack}>Back</Button>
            </section>}
          </>
        )}
        {step === 'verifiedAccount' && (
          <StepCreatePaidAccount
            email={recoveredSignupEmail ?? ''}
            onNext={handleVerifiedAccountComplete}
            initialError={provisionError}
            continuation="verified-no-card"
            initialData={formDataRef.current ?? undefined}
          />
        )}
        {step === 'selfhost' && (
          <StepSelfHostSupport onNext={handleSelfHostChoice} />
        )}
        {step === 'admin' && (
          <StepAdminInfo serverUrl={serverUrl.trim()} onNext={handleAdminInfoComplete} />
        )}
        {step === 'plan' && paymentSwitch && <PaymentBackModal provider={paymentSwitch}
          onStay={() => setPaymentSwitch(null)}
          onLeaveUnreleased={() => {
            // The payment stays owned and resumable; no other provider becomes payable.
            setPaymentSwitch(null)
            setProvisionError(null)
            setPlanView('method')
          }}
          onReleased={() => {
            setPaymentSwitch(null)
            setClientSecret(null)
            setCardDisclosure(null)
            setCryptoPaymentSession(null)
            pendingAnnualClaimRef.current = null
            setPendingAnnualClaim(null)
            claimAttemptedRef.current = false
            setProvisionError(null)
            navigation.clear()
            setPlanView('method')
          }} />}
        <div aria-hidden={paymentSwitch ? true : undefined} inert={Boolean(paymentSwitch)}>
        {step === 'plan' && !selectionCancellation && (
          annualOffer ? <StepChoosePlan
            key={`${annualOffer.requestId}:${annualOffer.offer.offerToken}:${selectionGeneration}`}
            annualOffer={annualOffer}
            onSelectFree={handleSelectFree}
            onChoosePaymentMethod={() => setPlanView('method')}
            onSelectPaid={handleSelectPaid}
            onSelectCrypto={handleSelectCrypto}
            planView={planView}
            onBack={handlePlanBack}
            clientSecret={clientSecret}
            cardDisclosure={cardDisclosure}
            provisioning={provisioning}
            provisionError={provisionError}
            onClearError={() => setProvisionError(null)}
            onClearCryptoPaymentSession={() => setCryptoPaymentSession(null)}
            onPaymentComplete={handlePaymentComplete}
            cryptoPaymentSession={cryptoPaymentSession}
            pendingAnnualClaim={pendingAnnualClaim}
            onConfirmAnnualClaim={handleConfirmAnnualClaim}
          /> : <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-600 dark:text-red-400">
            <p>{provisionError ?? 'Your annual offer is unavailable. Verify your email to request a new offer.'}</p>
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
        </div>
        {step === 'paidAccount' && (
          <StepCreatePaidAccount
            email={formDataRef.current?.email ?? ''}
            onNext={handlePaidAccountComplete}
            initialError={provisionError}
          />
        )}
        {step === 'vault' && (
          <>
            <StepCreateVault email={email} onComplete={handleVaultComplete} acknowledged={noCardAcknowledged} />
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
