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
import dynamic from 'next/dynamic'
import { StepCreateVault } from './components/step-create-vault'
import { QRCodeSVG } from 'qrcode.react'

const CRYPTO_CHECKOUT_ENABLED = process.env.NEXT_PUBLIC_BTCPAY_CHECKOUT_ENABLED === 'true'
const BTCPAY_CHECKOUT_ORIGIN = process.env.NEXT_PUBLIC_BTCPAY_CHECKOUT_ORIGIN ?? 'https://btcpay.silentsuite.io'

const StripePaymentForm = dynamic(() => import('@/app/components/stripe-payment-form'), {
  loading: () => (
    <div className="flex flex-col items-center justify-center py-8">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
      <p className="mt-3 text-sm text-slate-400">Loading payment form...</p>
    </div>
  ),
  ssr: false,
})

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PlanId = 'early_monthly' | 'early_annual'
type TrialPath = '7day' | '30day'
type BillingInterval = 'monthly' | 'annual'

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

const PLAN_PRICES: Record<PlanId, { monthly: number; annual: number; annualPerMonth: number }> = {
  early_monthly: { monthly: 3.60, annual: 36, annualPerMonth: 3 },
  early_annual: { monthly: 3.60, annual: 36, annualPerMonth: 3 },
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const signupSchema = z
  .object({
    email: z.string().min(1, 'Please enter a valid email address'),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .regex(/[A-Z]/, 'Must contain an uppercase letter')
      .regex(/[a-z]/, 'Must contain a lowercase letter')
      .regex(/[0-9]/, 'Must contain a number'),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
  .refine((data) => data.email.includes('@'), {
    message: 'Please enter a valid email address',
    path: ['email'],
  })

type SignupFormData = z.infer<typeof signupSchema>

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
// Billing interval toggle (section-level, larger tap targets)
// ---------------------------------------------------------------------------

function BillingToggle({
  interval,
  onChange,
}: {
  interval: BillingInterval
  onChange: (interval: BillingInterval) => void
}) {
  return (
    <div className="flex items-center justify-center gap-1 rounded-full border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-1">
      <button
        onClick={() => onChange('monthly')}
        className={`rounded-full min-h-[44px] px-4 py-2 text-sm font-medium transition-colors ${
          interval === 'monthly'
            ? 'bg-[rgb(var(--primary))] text-white'
            : 'text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))]'
        }`}
      >
        Monthly
      </button>
      <button
        onClick={() => onChange('annual')}
        className={`rounded-full min-h-[44px] px-4 py-2 text-sm font-medium transition-colors ${
          interval === 'annual'
            ? 'bg-[rgb(var(--primary))] text-white'
            : 'text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))]'
        }`}
      >
        Annual
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Price display helper — used inline in the trial subhead, intentionally
// modest in size so it doesn't dominate the "30-day free trial" headline.
// ---------------------------------------------------------------------------

function PriceDisplay({ interval }: { interval: BillingInterval }) {
  if (interval === 'monthly') {
    return (
      <span className="text-sm text-[rgb(var(--muted))]">
        Then <span className="font-semibold text-[rgb(var(--foreground))]">&euro;3.60/month</span>. Cancel anytime before day 30, no charge.
      </span>
    )
  }
  return (
    <span className="text-sm text-[rgb(var(--muted))]">
      Then <span className="font-semibold text-[rgb(var(--foreground))]">&euro;3.00/month</span> billed annually. Cancel anytime before day 30, no charge.
      <span className="ml-1 text-xs font-medium text-emerald-400">Save 17%</span>
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
}: {
  onNext: (data: SignupFormData) => Promise<void>
  serverUrl: string
  setServerUrl: (url: string) => void
  initialData?: SignupFormData | null
  wantsProductUpdates: boolean
  onWantsProductUpdatesChange: (value: boolean) => void
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
            Email address
          </label>
          <Input
            id="email"
            type="email"
            autoFocus
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? 'signup-email-error' : undefined}
            {...register('email')}
            className="bg-[rgb(var(--surface))] text-[rgb(var(--foreground))] border-[rgb(var(--border))]"
          />
          {errors.email && (
            <p id="signup-email-error" role="alert" className="text-xs text-red-400">{errors.email.message}</p>
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
            <p id="signup-password-error" role="alert" className="text-xs text-red-400">{errors.password.message}</p>
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
            <p id="signup-confirm-password-error" role="alert" className="text-xs text-red-400">
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
            Send me product updates and feature announcements (~8/year)
            <br />
            <span className="text-[rgb(var(--muted))]/70">We will never share your email. Unsubscribe anytime.</span>
          </span>
        </label>

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
              Leave empty to use the default SilentSuite server. Self-hosters: enter your own server URL.
            </p>
          </div>
        </details>

        {submitError && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
            <p className="text-sm text-red-400">{submitError}</p>
          </div>
        )}

        <Button type="submit" disabled={!isValid || isSubmitting} className="w-full">
          {isSubmitting ? (
            <span className="flex items-center justify-center gap-2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              Creating account...
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

type PlanView = 'cards' | 'method' | 'payment' | 'crypto'

function CryptoPaymentPanel({ session, onBack }: { session: CryptoPaymentSession; onBack: () => void }) {
  const [paymentMethods, setPaymentMethods] = useState<CryptoPaymentMethod[]>([])
  const [selectedMethodId, setSelectedMethodId] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'pending' | 'settled' | 'expired' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)

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
        if (!res.ok) throw new Error('Could not check Bitcoin payment status.')
        const data = await res.json()
        if (cancelled) return
        if (data.status === 'settled') {
          setStatus('settled')
          sessionStorage.removeItem('silentsuite-pending-crypto-invoice')
          sessionStorage.removeItem('silentsuite-pending-crypto-token')
          sessionStorage.removeItem('silentsuite-signup-in-progress')
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
  }, [session.invoiceId, session.lookupToken])

  const selectedMethod = paymentMethods.find((method) => method.id === selectedMethodId) ?? paymentMethods[0]
  const qrValue = selectedMethod?.qrValue ?? selectedMethod?.paymentLink ?? selectedMethod?.address ?? ''

  return (
    <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-300 motion-reduce:animate-none">
      <div className="space-y-2 text-center">
        <h2 className="text-lg sm:text-xl font-semibold text-[rgb(var(--foreground))]">Pay with Bitcoin</h2>
        <p className="text-sm text-[rgb(var(--muted))]">
          Scan the QR code or copy the payment details. SilentSuite unlocks after BTCPay settlement confirms.
        </p>
      </div>

      {status === 'settled' ? (
        <div className="space-y-4 text-center">
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-300">
            Payment settled. Your annual access is active.
          </div>
          <Link href="/" className="inline-flex h-9 w-full items-center justify-center rounded-md bg-teal-500 px-4 py-2 text-sm font-medium text-white shadow transition-colors hover:bg-teal-600">
            Open SilentSuite
          </Link>
        </div>
      ) : status === 'expired' ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
          This Bitcoin invoice expired. Go back and start a new Bitcoin invoice.
        </div>
      ) : status === 'error' ? (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-400">
          {error ?? 'Could not load Bitcoin payment details.'}
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
                    ? 'border-amber-500 bg-amber-500/10 text-amber-200'
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
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(qrValue)}
              className="text-xs text-emerald-400 hover:text-emerald-300"
            >
              Copy payment details
            </button>
          </div>

          <Link href={session.checkoutUrl} className="inline-flex h-9 w-full items-center justify-center rounded-md border border-navy-300 bg-transparent px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-navy-100">
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
        onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to payment methods
      </button>
    </div>
  )
}

function StepChoosePlan({
  interval,
  onIntervalChange,
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
  onPaymentComplete,
  selectedInterval,
  cryptoPaymentSession,
}: {
  interval: BillingInterval
  onIntervalChange: (interval: BillingInterval) => void
  onSelectFree: () => void
  onChoosePaymentMethod: () => void
  onSelectPaid: (promoCode?: string) => void
  onSelectCrypto: (useAnnual?: boolean) => void
  planView: PlanView
  onBack: () => void
  clientSecret: string | null
  provisioning: boolean
  provisionError: string | null
  onClearError: () => void
  onPaymentComplete: () => void
  selectedInterval: BillingInterval
  cryptoPaymentSession: CryptoPaymentSession | null
}) {
  const contentRef = useRef<HTMLDivElement>(null)
  const [selectedTrial, setSelectedTrial] = useState<TrialPath>('30day')
  const [paymentMethodError, setPaymentMethodError] = useState<string | null>(null)
  const [promoCode, setPromoCode] = useState('')

  if (planView === 'crypto' && cryptoPaymentSession) {
    return (
      <CryptoPaymentPanel
        session={cryptoPaymentSession}
        onBack={onBack}
      />
    )
  }

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
    setPaymentMethodError(null)
    onSelectPaid(promoCode)
  }, [onSelectPaid, promoCode])

  const handleSelectBitcoin = useCallback(() => {
    if (interval !== 'annual') {
      onIntervalChange('annual')
    }
    setPaymentMethodError(null)
    onSelectCrypto(interval !== 'annual')
  }, [interval, onIntervalChange, onSelectCrypto])

  const hasEnteredPromoCode = promoCode.trim().length > 0

  useEffect(() => {
    // Scroll to top of page on step transitions, not just the element
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [planView])

  // --- Payment sub-step ---
  if (planView === 'method') {
    const annualBitcoinAvailable = interval === 'annual' && CRYPTO_CHECKOUT_ENABLED
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
              <span className="text-sm font-medium text-[rgb(var(--foreground))]">Early Adopter Plan</span>
            </div>
            <span className="text-sm text-[rgb(var(--foreground))]">
              {interval === 'monthly' ? '€3.60/month' : '€3.00/month billed yearly'}
            </span>
          </div>
        </div>

        <div className="grid gap-3">
          <button
            type="button"
            onClick={handleSelectCard}
            disabled={provisioning}
            className="group w-full rounded-xl border-2 border-slate-700/50 bg-[rgb(var(--surface))] p-4 text-left transition-all hover:border-emerald-500/70 hover:bg-emerald-500/5 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <div className="flex items-start gap-3">
              <div className="rounded-lg bg-emerald-500/10 p-2.5 shrink-0">
                <CreditCard className="h-5 w-5 text-emerald-400" />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-[rgb(var(--foreground))]">Card with Stripe</h3>
                <p className="mt-1 text-sm text-[rgb(var(--muted))]">
                  Start the 30-day trial now. Your card is billed only after the trial unless you cancel.
                </p>
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={handleSelectBitcoin}
            disabled={provisioning || !CRYPTO_CHECKOUT_ENABLED}
            className={`group w-full rounded-xl border-2 p-4 text-left transition-all disabled:cursor-not-allowed disabled:opacity-60 ${
              annualBitcoinAvailable
                ? 'border-slate-700/50 bg-[rgb(var(--surface))] hover:border-amber-500/70 hover:bg-amber-500/5'
                : 'border-amber-500/30 bg-amber-500/5'
            }`}
          >
            <div className="flex items-start gap-3">
              <div className="rounded-lg bg-amber-500/10 p-2.5 shrink-0">
                <Bitcoin className="h-5 w-5 text-amber-400" />
              </div>
              <div className="flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold text-[rgb(var(--foreground))]">
                    {interval === 'annual' ? 'Bitcoin with BTCPay' : 'Switch to yearly and pay with Bitcoin'}
                  </h3>
                  <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300">
                    Annual only
                  </span>
                </div>
                <p className="mt-1 text-sm text-[rgb(var(--muted))]">
                  {interval === 'annual'
                    ? 'Pay once with Bitcoin for €32.40/year. App access starts only after the invoice settles.'
                    : 'Bitcoin is available for the yearly plan only. This switches you to yearly billing and opens BTCPay.'}
                </p>
              </div>
            </div>
          </button>
        </div>

        {selectedTrial === '30day' && (
          <div className="space-y-2">
            <label
              htmlFor="beta-promo-code"
              className="block text-sm font-medium text-[rgb(var(--foreground))]/80"
            >
              Add promo code <span className="text-[rgb(var(--muted))]">(optional, card only)</span>
            </label>
            <Input
              id="beta-promo-code"
              value={promoCode}
              onChange={(event) => setPromoCode(event.target.value.toUpperCase().replace(/\s/g, '').slice(0, 64))}
              placeholder="Enter promo code"
              maxLength={64}
              autoCapitalize="characters"
              autoComplete="off"
              disabled={provisioning}
              className="bg-[rgb(var(--surface))] text-[rgb(var(--foreground))] border-[rgb(var(--border))]"
            />
            <p className="text-xs text-[rgb(var(--muted))]">
              {hasEnteredPromoCode
                ? 'If valid, Stripe applies 100% off for the first 3 months before billing begins.'
                : 'Applied securely by Stripe before your trial starts.'}
            </p>
          </div>
        )}

        {(paymentMethodError || provisionError) && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
            <p className="text-sm text-red-400">{paymentMethodError ?? provisionError}</p>
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
    const priceLabel = interval === 'monthly' ? '\u20AC3.60/month' : '\u20AC3.00/month'
    const hasAcceptedPromoCode = hasEnteredPromoCode && !!clientSecret && !provisioning && !provisionError

    return (
      <div ref={contentRef} className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300 motion-reduce:animate-none">
        <div className="space-y-2 text-center">
          <h2 className="text-lg sm:text-xl font-semibold text-[rgb(var(--foreground))]">Add your payment method</h2>
          <p className="text-sm text-[rgb(var(--muted))]">
            {hasAcceptedPromoCode
              ? 'Your beta code gives you 3 months free. Your card is only billed after the promo period.'
              : 'Your card will not be charged for 30 days.'}
          </p>
        </div>

        {/* Plan summary bar */}
        <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Crown className="h-4 w-4 text-emerald-400" />
              <span className="text-sm font-medium text-[rgb(var(--foreground))]">Early Adopter Plan</span>
            </div>
            <span className="text-sm text-[rgb(var(--foreground))]">{priceLabel}</span>
          </div>
          <p className="mt-1 text-xs text-[rgb(var(--muted))]">
            {hasAcceptedPromoCode
              ? 'Promo code accepted: 100% off for 3 months. Cancel before billing starts.'
              : 'Card secures your trial - no charge until day 30. Cancel anytime before.'}
          </p>
          <div className="mt-2 flex items-center gap-1.5 text-xs text-[rgb(var(--muted))]">
            <Lock className="h-3 w-3 text-emerald-500" />
            <span>Secured by Stripe. We never see your card details.</span>
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
              <h3 className="text-sm font-medium text-[rgb(var(--foreground))]">Card <span className="text-[rgb(var(--muted))] font-normal">(powered by Stripe)</span></h3>
            </div>
            <StripePaymentForm
              clientSecret={clientSecret}
              onSuccess={onPaymentComplete}
              submitLabel={hasAcceptedPromoCode ? 'Save card and start 3 months free' : 'Start 30-day free trial'}
              mode="setup"
              selectedInterval={selectedInterval}
            />
            <p className="flex items-center justify-center gap-1.5 text-[10px] text-[rgb(var(--muted))]">
              <Lock className="h-3 w-3 text-emerald-500" />
              Secured by Stripe
            </p>
          </div>
        ) : provisionError ? (
          <div className="space-y-4 text-center">
            <p className="text-sm text-red-400">{provisionError}</p>
            <button
              onClick={onBack}
              className="text-sm text-emerald-500 hover:text-emerald-400 transition-colors"
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
          Early Adopter pricing
        </p>
      </div>

      {/* Billing toggle — section level */}
      <div className="flex justify-center">
        <BillingToggle interval={interval} onChange={onIntervalChange} />
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

        {/* Card B: 30 Day Free Trial — card secures the trial, no charge for 30 days */}
        <button
          onClick={() => setSelectedTrial('30day')}
          aria-label={`30-day free trial — then ${interval === 'monthly' ? '€3.60/month' : '€3.00/month billed annually'}, cancel anytime before day 30 with no charge`}
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
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-400 uppercase tracking-wide">
                  Recommended
                </span>
              </div>
              <p className="mt-1.5 leading-snug">
                <PriceDisplay interval={interval} />
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
                  {interval === 'annual' ? 'Billed annually after trial' : 'Billed monthly after trial'}
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
          <p className="text-sm text-red-400">{provisionError}</p>
          <button
            onClick={onClearError}
            className="mt-2 text-xs text-red-400 hover:text-red-300 underline"
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

function StepSelfHostSupport({ onNext }: { onNext: (choice: 'free' | 'support') => void }) {
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
            onClick={() => onNext('free')}
            variant="outline"
            className="w-full py-2.5 text-sm"
          >
            Continue for free
          </Button>
        </div>
      </div>

      {/* Support option */}
      <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-5 ring-1 ring-amber-500/20 flex flex-col relative overflow-hidden">
        <div className="absolute top-3 right-3">
          <span className="rounded-full bg-amber-500/15 px-2.5 py-1 text-[11px] font-medium text-amber-400">
            Optional
          </span>
        </div>
        <div className="flex items-center gap-3 mb-3">
          <div className="rounded-lg bg-amber-500/10 p-2.5">
            <Crown className="h-5 w-5 text-amber-400" />
          </div>
          <h3 className="text-lg font-semibold text-[rgb(var(--foreground))]">Support the project</h3>
        </div>
        <p className="text-sm leading-relaxed text-[rgb(var(--muted))]">
          SilentSuite is open source. If you find it useful, consider supporting
          ongoing development.
        </p>
        <div className="mt-5 pt-4 border-t border-amber-500/10">
          <div className="mb-4 flex items-baseline gap-1.5">
            <span className="text-3xl font-bold text-[rgb(var(--foreground))]">&euro;4</span>
            <span className="text-sm text-[rgb(var(--muted))]">/month</span>
          </div>
          <Button
            onClick={() => onNext('support')}
            className="w-full py-2.5 text-sm bg-amber-600 hover:bg-amber-700"
          >
            Support SilentSuite
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
            className="flex items-center gap-2 text-sm font-medium text-emerald-500 hover:text-emerald-400 transition-colors"
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

type Step = 'account' | 'plan' | 'selfhost' | 'admin' | 'vault'

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
      <div className="flex md:hidden items-center justify-center gap-1 sm:gap-2 mb-4 sm:mb-6">
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
  const createEtebaseAccount = useAuthStore((s) => s.createEtebaseAccount)
  const signup = useAuthStore((s) => s.signup)
  const completeSignup = useAuthStore((s) => s.completeSignup)
  const [step, setStep] = useState<Step>('account')
  const [serverUrl, setServerUrl] = useState('')

  // Scroll to top on main step changes
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [step])
  const [selectedInterval, setSelectedInterval] = useState<BillingInterval>('annual')
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [cryptoPaymentSession, setCryptoPaymentSession] = useState<CryptoPaymentSession | null>(null)
  const [provisionError, setProvisionError] = useState<string | null>(null)
  const [provisioning, setProvisioning] = useState(false)
  const [usingSelfHostedServer, setUsingSelfHostedServer] = useState(false)
  const [planView, setPlanView] = useState<PlanView>('cards')
  const [wantsProductUpdates, setWantsProductUpdates] = useState(false)
  const formDataRef = useRef<SignupFormData | null>(null)

  const handleAccountComplete = useCallback(async (data: SignupFormData) => {
    formDataRef.current = data
    const normalizedUrl = serverUrl.trim() ? normalizeServerUrl(serverUrl) : undefined
    if (normalizedUrl) {
      localStorage.setItem('silentsuite-server-url', normalizedUrl)
    } else {
      localStorage.removeItem('silentsuite-server-url')
    }

    // Create account on the server (default or custom)
    const identifier = data.email || ''
    await createEtebaseAccount(identifier, data.password, normalizedUrl)

    // Store product updates preference in pendingSignup for later use
    const pending = useAuthStore.getState().pendingSignup
    if (!pending) console.error('pendingSignup not set after createEtebaseAccount')
    if (pending) {
      useAuthStore.setState({
        pendingSignup: { ...pending, wantsProductUpdates },
      })
    }

    const selfHosted = isSelfHosted || isCustomServer(normalizedUrl)
    setUsingSelfHostedServer(selfHosted)

    if (selfHosted) {
      setStep('selfhost')
    } else {
      setStep('plan')
    }
  }, [createEtebaseAccount, serverUrl, wantsProductUpdates])

  const handleSelfHostChoice = useCallback(async (choice: 'free' | 'support') => {
    if (choice === 'support') {
      // TODO: Replace with inline Stripe Elements flow
      window.open('https://buy.stripe.com/test_00wfZjeifgm49n94Qf3VC00', '_blank')
    }
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

  const handleSelectFree = useCallback(async () => {
    setProvisioning(true)
    setProvisionError(null)
    try {
      const planId: PlanId = selectedInterval === 'monthly' ? 'early_monthly' : 'early_annual'
      await signup(planId, '7day')
      setStep('vault')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to set up your account'
      setProvisionError(message)
    } finally {
      setProvisioning(false)
    }
  }, [signup, selectedInterval])

  const handleSelectPaid = useCallback(async (promoCode?: string) => {
    setProvisionError(null)
    setProvisioning(true)
    setPlanView('payment')
    try {
      const planId: PlanId = selectedInterval === 'monthly' ? 'early_monthly' : 'early_annual'
      const result = await signup(planId, '30day', promoCode)
      if (result.clientSecret) {
        setClientSecret(result.clientSecret)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to set up your account'
      setProvisionError(message)
      setPlanView('method')
    } finally {
      setProvisioning(false)
    }
  }, [signup, selectedInterval])

  const handleSelectCrypto = useCallback(async (useAnnual = false) => {
    setProvisionError(null)
    if (!useAnnual && selectedInterval !== 'annual') {
      setProvisionError('Bitcoin is only available for the yearly plan. Switch to yearly billing to pay with Bitcoin.')
      return
    }
    setProvisioning(true)
    try {
      const result = await signup('early_annual', 'crypto_annual')
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
      if (result.cryptoInvoiceLookupToken) {
        sessionStorage.setItem('silentsuite-pending-crypto-token', result.cryptoInvoiceLookupToken)
      }
      if (!result.cryptoInvoiceId || !result.cryptoInvoiceLookupToken) {
        throw new Error('Crypto checkout did not return a complete payment session.')
      }
      setCryptoPaymentSession({
        invoiceId: result.cryptoInvoiceId,
        lookupToken: result.cryptoInvoiceLookupToken,
        checkoutUrl: checkoutUrl.toString(),
      })
      setPlanView('crypto')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to start crypto checkout'
      setProvisionError(message)
    } finally {
      setProvisioning(false)
    }
  }, [signup, selectedInterval])

  const handlePlanBack = useCallback(() => {
    if (planView === 'crypto') {
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

  const handlePaymentComplete = useCallback(() => {
    setStep('vault')
  }, [])

  const handleVaultComplete = useCallback(() => {
    // Finalize authentication — only NOW does the user become authenticated.
    completeSignup()
    router.push('/')
  }, [completeSignup, router])

  const email = formDataRef.current?.email || ''

  const activeSteps = usingSelfHostedServer
    ? STEPS_SELFHOST
    : STEPS_HOSTED

  return (
    <div className="flex items-start justify-center max-w-2xl mx-auto">
      <ProgressStepper currentStep={step} steps={activeSteps} />
      <div className="flex-1 max-w-md">
        {step === 'account' && (
          <StepCreateAccount
            onNext={handleAccountComplete}
            serverUrl={serverUrl}
            setServerUrl={setServerUrl}
            initialData={formDataRef.current}
            wantsProductUpdates={wantsProductUpdates}
            onWantsProductUpdatesChange={setWantsProductUpdates}
          />
        )}
        {step === 'selfhost' && (
          <StepSelfHostSupport onNext={handleSelfHostChoice} />
        )}
        {step === 'admin' && (
          <StepAdminInfo serverUrl={serverUrl.trim()} onNext={handleAdminInfoComplete} />
        )}
        {step === 'plan' && (
          <StepChoosePlan
            interval={selectedInterval}
            onIntervalChange={setSelectedInterval}
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
            onPaymentComplete={handlePaymentComplete}
            selectedInterval={selectedInterval}
            cryptoPaymentSession={cryptoPaymentSession}
          />
        )}
        {step === 'vault' && (
          <StepCreateVault email={email} onComplete={handleVaultComplete} />
        )}
      </div>
      {/* Build version indicator */}
      <div className="fixed bottom-2 left-2 text-[10px] text-slate-600 font-mono select-none pointer-events-none">
        v0.3.0
      </div>
    </div>
  )
}
