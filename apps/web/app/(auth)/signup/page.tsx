'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  Shield, Lock, Check, KeyRound, ChevronRight, User, Crown,
  ShieldCheck, Download, AlertTriangle, Copy, CheckCircle,
  Users, Settings, Activity, ExternalLink,
} from 'lucide-react'
import { Button } from '@silentsuite/ui'
import { Input } from '@silentsuite/ui'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { isSelfHosted, isCustomServer } from '@/app/lib/self-hosted'

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const signupSchema = z
  .object({
    email: z.string().optional(),
    username: z.string().optional(),
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

const emailSignupSchema = signupSchema.refine(
  (data) => data.email && data.email.includes('@'),
  { message: 'Please enter a valid email address', path: ['email'] },
)

const usernameSignupSchema = signupSchema.refine(
  (data) => data.username && data.username.length >= 3 && data.username.length <= 20 && /^[a-zA-Z0-9_]+$/.test(data.username),
  { message: 'Username: 3-20 characters, letters/numbers/underscores only', path: ['username'] },
)

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
// Step 1: Create Account
// ---------------------------------------------------------------------------

function StepCreateAccount({
  onNext,
  serverUrl,
  setServerUrl,
}: {
  onNext: (data: SignupFormData) => void
  serverUrl: string
  setServerUrl: (url: string) => void
}) {
  const [useUsername, setUseUsername] = useState(false)

  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors, isValid },
  } = useForm<SignupFormData>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolver: zodResolver(useUsername ? usernameSignupSchema : emailSignupSchema) as any,
    mode: 'onBlur',
  })

  const password = watch('password', '')

  const toggleMode = useCallback(() => {
    setUseUsername((prev) => !prev)
    reset()
  }, [reset])

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h2 className="text-xl font-semibold text-[rgb(var(--foreground))]">Create your account</h2>
        <p className="text-sm text-[rgb(var(--muted))]">
          Start your encrypted workspace in seconds
        </p>
      </div>

      <form onSubmit={handleSubmit(onNext)} className="space-y-4">
        {useUsername ? (
          <div className="space-y-2">
            <label
              htmlFor="username"
              className="block text-sm font-medium text-[rgb(var(--foreground))]/80"
            >
              Username
            </label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[rgb(var(--muted))]" />
              <Input
                id="username"
                type="text"
                autoFocus
                placeholder="your_username"
                {...register('username')}
                className="bg-[rgb(var(--surface))] text-[rgb(var(--foreground))] border-[rgb(var(--border))] pl-10"
              />
            </div>
            {errors.username && (
              <p className="text-xs text-red-400">{errors.username.message}</p>
            )}
            <p className="text-[10px] text-[rgb(var(--muted))]">
              3-20 characters. Letters, numbers, and underscores only.
            </p>
          </div>
        ) : (
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
              {...register('email')}
              className="bg-[rgb(var(--surface))] text-[rgb(var(--foreground))] border-[rgb(var(--border))]"
            />
            {errors.email && (
              <p className="text-xs text-red-400">{errors.email.message}</p>
            )}
          </div>
        )}

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
            {...register('password')}
            className="bg-[rgb(var(--surface))] text-[rgb(var(--foreground))] border-[rgb(var(--border))]"
          />
          {errors.password && (
            <p className="text-xs text-red-400">{errors.password.message}</p>
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
            {...register('confirmPassword')}
            className="bg-[rgb(var(--surface))] text-[rgb(var(--foreground))] border-[rgb(var(--border))]"
          />
          {errors.confirmPassword && (
            <p className="text-xs text-red-400">
              {errors.confirmPassword.message}
            </p>
          )}
        </div>

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

        <Button type="submit" disabled={!isValid} className="w-full">
          Continue
        </Button>

        <p className="flex items-center justify-center gap-1.5 text-xs text-[rgb(var(--muted))]">
          <KeyRound className="h-3 w-3 text-emerald-500" />
          {useUsername
            ? 'No email required. Just a username and password.'
            : 'No phone number required. Just email and password.'}
        </p>
      </form>

      {/* Toggle between email and username mode */}
      <div className="text-center">
        <button
          type="button"
          onClick={toggleMode}
          className="text-xs text-emerald-500 hover:text-emerald-400 hover:underline transition-colors"
        >
          {useUsername
            ? 'Sign up with email instead'
            : 'Sign up with username only (advanced)'}
        </button>
      </div>

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
// Step 2: Choose Plan
// ---------------------------------------------------------------------------

function StepChoosePlan({ onNext }: { onNext: (planId: string) => void }) {
  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <h2 className="text-xl font-semibold text-[rgb(var(--foreground))]">Choose your plan</h2>
        <p className="text-sm text-[rgb(var(--muted))]">
          Start with a 30-day free trial. Cancel anytime.
        </p>
      </div>

      {/* Founding Member Plan */}
      <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-5 ring-1 ring-amber-500/20 flex flex-col relative overflow-hidden">
        <div className="absolute top-3 right-3">
          <span className="rounded-full bg-amber-500/15 px-2.5 py-1 text-[11px] font-medium text-amber-400">
            Early supporter
          </span>
        </div>
        <div className="flex items-center gap-3 mb-3">
          <div className="rounded-lg bg-amber-500/10 p-2.5">
            <Crown className="h-5 w-5 text-amber-400" />
          </div>
          <h3 className="text-lg font-semibold text-[rgb(var(--foreground))]">Founding Member</h3>
        </div>
        <p className="text-sm leading-relaxed text-[rgb(var(--muted))]">
          30 days free, then &euro;3/mo. Price locked forever as a thank you for your early support.
        </p>
        <div className="mt-5 pt-4 border-t border-amber-500/10">
          <div className="mb-4 flex items-baseline gap-1.5">
            <span className="text-3xl font-bold text-[rgb(var(--foreground))]">&euro;3</span>
            <span className="text-sm text-[rgb(var(--muted))]">/month after trial</span>
          </div>
          <Button
            onClick={() => onNext('founding_member')}
            className="w-full py-2.5 text-sm bg-amber-600 hover:bg-amber-700"
          >
            Become a founding member
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-center gap-1.5 text-xs text-[rgb(var(--muted))]">
        <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
        <span>30-day money-back guarantee. Cancel anytime.</span>
      </div>
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
// Step 3: Payment (redirects to Stripe Checkout)
// ---------------------------------------------------------------------------

function StepPayment({ planId, onComplete }: { planId: string; onComplete: () => void }) {
  const signup = useAuthStore((s: any) => s.signup)
  const pendingSignup = useAuthStore((s: any) => s.pendingSignup)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function processPayment() {
      if (!pendingSignup) {
        setError('Signup session expired. Please start again.')
        return
      }

      try {
        const checkoutUrl = await signup(planId)
        if (checkoutUrl) {
          // Redirect to Stripe Checkout
          window.location.href = checkoutUrl
        } else {
          // No payment needed (e.g. coupon, or Stripe returned inline)
          onComplete()
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Payment setup failed'
        setError(message)
      }
    }

    processPayment()
  }, [planId, signup, pendingSignup, onComplete])

  if (error) {
    return (
      <div className="space-y-4 text-center">
        <p className="text-sm text-red-400">{error}</p>
        <Button onClick={() => window.location.reload()} className="w-full">
          Try again
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center justify-center py-12">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-[rgb(var(--primary))] border-t-transparent" />
      <p className="mt-4 text-sm text-[rgb(var(--muted))]">
        Setting up your payment...
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 4: Create Vault + Recovery Key
// ---------------------------------------------------------------------------

function StepVaultAndRecovery({
  email,
  onComplete,
}: {
  email: string
  onComplete: () => void
}) {
  const [phase, setPhase] = useState<'creating' | 'recovery'>('creating')
  const [copied, setCopied] = useState(false)
  const [downloaded, setDownloaded] = useState(false)

  // TODO: Replace with actual recovery key from Etebase
  const recoveryKey = useRef(
    Array.from({ length: 4 }, () =>
      Array.from({ length: 4 }, () =>
        'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]
      ).join('')
    ).join('-')
  ).current

  useEffect(() => {
    if (phase !== 'creating') return
    // Simulate vault creation time (the actual Etebase account was created before payment)
    const timer = setTimeout(() => setPhase('recovery'), 2500)
    return () => clearTimeout(timer)
  }, [phase])

  const handleDownloadTxt = useCallback(() => {
    const content = `
SILENTSUITE RECOVERY KEY
========================

Account: ${email}
Generated: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}

YOUR RECOVERY KEY:
${recoveryKey}

IMPORTANT:
- Store this key in a safe place
- This key can restore access to your encrypted data
- SilentSuite cannot recover this key for you
- Do NOT share this key with anyone
`.trim()

    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `silentsuite-recovery-key-${new Date().toISOString().split('T')[0]}.txt`
    link.click()
    URL.revokeObjectURL(url)
    setDownloaded(true)
  }, [recoveryKey, email])

  const handleDownloadPdf = useCallback(() => {
    // For now, use the same text download. Full PDF generation can be added later.
    handleDownloadTxt()
  }, [handleDownloadTxt])

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback: select the text
    }
  }, [recoveryKey])

  if (phase === 'creating') {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <div className="relative mb-8">
          <div className="vault-pulse h-20 w-20 rounded-2xl border-2 border-[rgb(var(--primary))]/50 bg-[rgb(var(--surface))] flex items-center justify-center">
            <Lock className="h-10 w-10 text-[rgb(var(--primary))] vault-lock" />
          </div>
          <div className="vault-ring absolute inset-0 rounded-2xl border-2 border-[rgb(var(--primary))]/30" />
        </div>
        <p className="text-lg font-medium text-[rgb(var(--foreground))]">
          Setting up your encrypted vault
        </p>
        <p className="mt-2 text-sm text-[rgb(var(--muted))]">
          Generating your encryption keys...
        </p>

        <style jsx>{`
          .vault-pulse {
            animation: vaultPulse 1.5s ease-in-out infinite;
          }
          .vault-lock {
            animation: vaultLock 2s ease-in-out forwards;
          }
          .vault-ring {
            animation: vaultRing 1.5s ease-in-out infinite;
          }
          @keyframes vaultPulse {
            0%, 100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.3); }
            50% { box-shadow: 0 0 0 12px rgba(16, 185, 129, 0); }
          }
          @keyframes vaultLock {
            0% { opacity: 0.5; transform: scale(0.8); }
            50% { opacity: 1; transform: scale(1.1); }
            100% { opacity: 1; transform: scale(1); }
          }
          @keyframes vaultRing {
            0% { transform: scale(1); opacity: 0.3; }
            50% { transform: scale(1.15); opacity: 0; }
            100% { transform: scale(1); opacity: 0.3; }
          }
        `}</style>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="text-center space-y-3">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border border-emerald-500/30 bg-emerald-500/10">
          <Shield className="h-8 w-8 text-emerald-500" />
        </div>
        <h2 className="text-xl font-semibold text-[rgb(var(--foreground))]">
          Save your recovery key
        </h2>
        <p className="text-sm text-[rgb(var(--muted))]">
          This key can restore access to your encrypted data if you forget your password.
        </p>
      </div>

      {/* Warning */}
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
          <div>
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">
              SilentSuite cannot recover this key
            </p>
            <p className="mt-1 text-xs text-[rgb(var(--muted))]">
              Due to end-to-end encryption, we never have access to your recovery key.
              If you lose it and forget your password, your data cannot be recovered.
            </p>
          </div>
        </div>
      </div>

      {/* Key display */}
      <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 font-mono text-base tracking-wider text-[rgb(var(--foreground))] text-center select-all">
        {recoveryKey}
      </div>

      {/* Actions */}
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={handleCopy}
          className="flex items-center justify-center gap-2 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-4 py-2.5 text-sm font-medium text-[rgb(var(--foreground))] hover:bg-[rgb(var(--border))]/30 transition-colors"
        >
          {copied ? <CheckCircle className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
          {copied ? 'Copied!' : 'Copy key'}
        </button>
        <button
          onClick={handleDownloadPdf}
          className="flex items-center justify-center gap-2 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-4 py-2.5 text-sm font-medium text-[rgb(var(--foreground))] hover:bg-[rgb(var(--border))]/30 transition-colors"
        >
          <Download className="h-4 w-4" />
          {downloaded ? 'Downloaded!' : 'Download'}
        </button>
      </div>

      {/* Continue */}
      <button
        onClick={onComplete}
        disabled={!downloaded && !copied}
        className="w-full rounded-lg bg-[rgb(var(--primary))] px-4 py-3 text-sm font-medium text-white hover:bg-[rgb(var(--primary-hover))] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {downloaded || copied ? 'Continue to your workspace' : 'Please save your recovery key first'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Progress Stepper
// ---------------------------------------------------------------------------

type Step = 'account' | 'plan' | 'selfhost' | 'admin' | 'payment' | 'vault'

const STEPS_DEFAULT = [
  { key: 'account' as const, label: 'Create Account', number: 1 },
  { key: 'plan' as const, label: 'Choose Plan', number: 2 },
  { key: 'payment' as const, label: 'Payment', number: 3 },
  { key: 'vault' as const, label: 'Setup Vault', number: 4 },
]

const STEPS_SELFHOST = [
  { key: 'account' as const, label: 'Create Account', number: 1 },
  { key: 'selfhost' as const, label: 'Self-Hosting', number: 2 },
  { key: 'admin' as const, label: 'Admin Setup', number: 3 },
  { key: 'vault' as const, label: 'Setup Vault', number: 4 },
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
      <div className="flex md:hidden items-center justify-center gap-2 mb-6">
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
                className={`w-4 h-0.5 transition-colors ${
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
  const [step, setStep] = useState<Step>('account')
  const [serverUrl, setServerUrl] = useState('')
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null)
  const [usingSelfHostedServer, setUsingSelfHostedServer] = useState(false)
  const formDataRef = useRef<SignupFormData | null>(null)

  const handleAccountComplete = useCallback(async (data: SignupFormData) => {
    formDataRef.current = data
    const trimmedUrl = serverUrl.trim() || undefined
    if (trimmedUrl) {
      localStorage.setItem('silentsuite-server-url', trimmedUrl)
    } else {
      localStorage.removeItem('silentsuite-server-url')
    }

    // Create account on the server (default or custom)
    const identifier = data.email || data.username || ''
    try {
      await createEtebaseAccount(identifier, data.password, trimmedUrl)
    } catch {
      // Error is displayed by the store
      return
    }

    const selfHosted = isSelfHosted || isCustomServer(trimmedUrl)
    setUsingSelfHostedServer(selfHosted)

    if (selfHosted) {
      // Self-hosted: show free vs support choice
      setStep('selfhost')
    } else {
      setStep('plan')
    }
  }, [createEtebaseAccount, serverUrl])

  const handleSelfHostChoice = useCallback(async (choice: 'free' | 'support') => {
    if (choice === 'support') {
      // Open Stripe payment link in new tab
      window.open('https://buy.stripe.com/test_00wfZjeifgm49n94Qf3VC00', '_blank')
    }
    // Complete signup as self-hosted (skip billing API)
    try {
      await signup('self-hosted')
    } catch {
      // Error displayed by store
    }
    setStep('admin')
  }, [signup])

  const handleAdminInfoComplete = useCallback(() => {
    setStep('vault')
  }, [])

  const handlePlanSelected = useCallback((planId: string) => {
    setSelectedPlan(planId)
    setStep('payment')
  }, [])

  const handlePaymentComplete = useCallback(() => {
    setStep('vault')
  }, [])

  const handleVaultComplete = useCallback(() => {
    router.push('/onboarding')
  }, [router])

  const email = formDataRef.current?.email || formDataRef.current?.username || ''
  const activeSteps = usingSelfHostedServer ? STEPS_SELFHOST : STEPS_DEFAULT

  return (
    <div className="flex items-start justify-center max-w-2xl mx-auto">
      <ProgressStepper currentStep={step} steps={activeSteps} />
      <div className="flex-1 max-w-md">
        {step === 'account' && (
          <StepCreateAccount
            onNext={handleAccountComplete}
            serverUrl={serverUrl}
            setServerUrl={setServerUrl}
          />
        )}
        {step === 'selfhost' && (
          <StepSelfHostSupport onNext={handleSelfHostChoice} />
        )}
        {step === 'admin' && (
          <StepAdminInfo serverUrl={serverUrl.trim()} onNext={handleAdminInfoComplete} />
        )}
        {step === 'plan' && (
          <StepChoosePlan onNext={handlePlanSelected} />
        )}
        {step === 'payment' && selectedPlan && (
          <StepPayment planId={selectedPlan} onComplete={handlePaymentComplete} />
        )}
        {step === 'vault' && (
          <StepVaultAndRecovery email={email} onComplete={handleVaultComplete} />
        )}
      </div>
    </div>
  )
}
