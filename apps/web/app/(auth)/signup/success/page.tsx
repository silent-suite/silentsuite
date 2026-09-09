'use client'

import { useEffect, useState, useCallback, useRef, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { CheckCircle, AlertTriangle, Lock } from 'lucide-react'
import { Button } from '@silentsuite/ui'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { normalizeSignupReturnTo } from '@/app/lib/signup-return'
import { StepCreateVault } from '../components/step-create-vault'
import { StepCreatePaidAccount, type PaidAccountFormData } from '../components/step-create-paid-account'
import { CheckoutReturnAnalytics } from '../commercial-funnel-analytics'
import { SignupRecoveryWarning } from '../components/signup-recovery-warning'

// ---------------------------------------------------------------------------
// Inner component that reads searchParams (must be inside <Suspense>)
// ---------------------------------------------------------------------------

type RedirectState = 'loading' | 'session' | 'account' | 'vault' | 'failed' | 'expired' | 'none'

function SignupSuccessInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const completeSignup = useAuthStore((s) => s.completeSignup)
  const createEtebaseAccount = useAuthStore((s) => s.createEtebaseAccount)
  const finalizePaidSignup = useAuthStore((s) => s.finalizePaidSignup)
  const recoverCompletedSignupSession = useAuthStore((s) => s.recoverCompletedSignupSession)
  const restoreSignupStateFromRedirect = useAuthStore((s) => s.restoreSignupStateFromRedirect)
  const redirectStatus = searchParams.get('redirect_status')
  const setupIntent = searchParams.get('setup_intent')
  const returnTo = normalizeSignupReturnTo(searchParams.get('return_to'))
  const isStripeRedirect = !!(setupIntent && redirectStatus)
  const checkoutReturn = <CheckoutReturnAnalytics outcome={redirectStatus === 'failed' ? 'failed' : 'returned'} paymentMethod={isStripeRedirect ? 'stripe' : 'unknown'} />

  const [state, setState] = useState<RedirectState>(isStripeRedirect ? 'loading' : 'none')
  const [restoredEmail, setRestoredEmail] = useState<string>('')
  const [showReturnFallback, setShowReturnFallback] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const recoveryInFlight = useRef(false)
  const restoredOnce = useRef(false)

  const recoverSession = useCallback(async (credential?: string) => {
    if (recoveryInFlight.current) return
    recoveryInFlight.current = true
    setSessionError(null)
    setState('loading')
    try {
      await recoverCompletedSignupSession(credential)
      setPassword('')
      setState('vault')
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : 'Could not finish signing in. Please retry.')
      setState('session')
    } finally {
      recoveryInFlight.current = false
    }
  }, [recoverCompletedSignupSession])

  useEffect(() => {
    if (!isStripeRedirect || restoredOnce.current) return
    restoredOnce.current = true

    if (redirectStatus === 'failed') {
      setState('failed')
      return
    }

    if (redirectStatus === 'succeeded' || redirectStatus === 'processing') {
      const restored = restoreSignupStateFromRedirect({ retainForRecovery: true })
      if (restored?.pendingSignup.provisionedUser) {
        setRestoredEmail(restored.pendingSignup.email)
        void recoverSession()
      } else if (restored?.pendingSignup.paymentSessionToken) {
        setRestoredEmail(restored.pendingSignup.email)
        setState('account')
      } else {
        // State missing or expired — can't complete the flow
        setState('expired')
      }
      return
    }

    // Unknown redirect_status — treat as failure
    setState('failed')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Run once on mount

  const handleVaultComplete = useCallback(() => {
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

  const handlePaidAccountComplete = useCallback(async (data: PaidAccountFormData) => {
    await createEtebaseAccount(restoredEmail, data.password)
    await finalizePaidSignup()
    setState('vault')
  }, [createEtebaseAccount, finalizePaidSignup, restoredEmail])

  const handleSuccessContinue = useCallback(() => {
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

  // --- Stripe 3DS redirect: loading ---
  if (state === 'loading') {
    return (
      <div className="max-w-md mx-auto flex flex-col items-center justify-center py-12">
        {checkoutReturn}
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[rgb(var(--primary))] border-t-transparent" />
        <p className="mt-4 text-sm text-[rgb(var(--muted))]">Completing setup...</p>
      </div>
    )
  }

  if (state === 'session') {
    return (
      <div className="max-w-md mx-auto space-y-6">
        {checkoutReturn}
        <h2 className="text-xl font-semibold">Finish signing in</h2>
        <p className="text-sm text-[rgb(var(--muted))]">Your account is already set up. Retry signing in, or enter the existing password for {restoredEmail} if this browser no longer has your account session. Your payment will not be submitted again.</p>
        {sessionError && <p role="alert" className="text-sm text-red-500">{sessionError}</p>}
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void recoverSession(password || undefined) }}>
          <label htmlFor="recovery-password" className="block text-sm">Existing account password</label>
          <input id="recovery-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} className="w-full rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--background))] p-3" />
          <Button type="submit" className="w-full">Retry sign in</Button>
        </form>
      </div>
    )
  }

  if (state === 'account') {
    return (
      <div className="max-w-md mx-auto space-y-6">
        {checkoutReturn}
        <div className="flex items-center gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4">
          <CheckCircle className="h-5 w-5 text-emerald-500 shrink-0" />
          <div>
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">Card verified successfully</p>
            <p className="text-xs text-[rgb(var(--muted))]">One last account step before your vault setup.</p>
          </div>
        </div>
        <StepCreatePaidAccount email={restoredEmail} onNext={handlePaidAccountComplete} />
      </div>
    )
  }

  // --- Stripe 3DS redirect: vault step ---
  if (state === 'vault') {
    return (
      <div className="max-w-md mx-auto space-y-6">
        {checkoutReturn}
        {/* Brief success confirmation before vault */}
        <div className="flex items-center gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4">
          <CheckCircle className="h-5 w-5 text-emerald-500 shrink-0" />
          <div>
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">Card verified successfully</p>
            <p className="text-xs text-[rgb(var(--muted))]">One last step — set up your vault.</p>
          </div>
        </div>

        <StepCreateVault
          email={restoredEmail}
          onComplete={handleVaultComplete}
        />
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

  // --- Stripe 3DS redirect: payment failed ---
  if (state === 'failed') {
    return (
      <div className="max-w-md mx-auto space-y-6 text-center">
        {checkoutReturn}
        <div className="flex flex-col items-center gap-4">
          <div className="rounded-full bg-red-500/10 p-4">
            <AlertTriangle className="h-12 w-12 text-red-400" />
          </div>
          <h2 className="text-xl font-semibold text-[rgb(var(--foreground))]">
            Payment verification failed
          </h2>
          <p className="text-sm leading-relaxed text-[rgb(var(--muted))]">
            Your bank could not verify the payment. Please try again with the same
            or a different card.
          </p>
        </div>
        <Button onClick={() => router.push('/signup')} className="w-full">
          Back to signup
        </Button>
      </div>
    )
  }

  // --- Stripe 3DS redirect: state expired / missing ---
  if (state === 'expired') {
    return (
      <div className="max-w-md mx-auto space-y-6 text-center">
        <div className="flex flex-col items-center gap-4">
          <div className="rounded-full bg-amber-500/10 p-4">
            <AlertTriangle className="h-12 w-12 text-amber-400" />
          </div>
          <h2 className="text-xl font-semibold text-[rgb(var(--foreground))]">
            Session expired
          </h2>
          <p className="text-sm leading-relaxed text-[rgb(var(--muted))]">
            Your signup session has expired. Your card was saved successfully, but
            you&apos;ll need to start the signup process again to complete setup.
          </p>
        </div>
        <Button onClick={() => router.push('/signup')} className="w-full">
          Start again
        </Button>
      </div>
    )
  }

  // --- Default: no Stripe params (direct navigation) ---
  return (
    <div className="max-w-md mx-auto space-y-6 text-center">
      {checkoutReturn}
      <div className="flex flex-col items-center gap-4">
        <div className="rounded-full bg-[rgb(var(--primary))]/10 p-4">
          <CheckCircle className="h-12 w-12 text-[rgb(var(--primary))]" />
        </div>
        <h2 className="text-xl font-semibold text-[rgb(var(--foreground))]">
          Payment confirmation required
        </h2>
        <p className="text-sm leading-relaxed text-[rgb(var(--muted))]">
          Return to your signup flow to confirm payment with Billing before access is activated.
        </p>
      </div>

      <Button onClick={handleSuccessContinue} className="w-full">
        {returnTo ? 'Return to Android app' : 'Back to signup'}
      </Button>
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

// ---------------------------------------------------------------------------
// Page wrapper with Suspense (required for useSearchParams)
// ---------------------------------------------------------------------------

export default function SignupSuccessPage() {
  return (
    <>
      {/* Keep recovery disclosure mounted across every status and Suspense fallback. */}
      <div className="max-w-md mx-auto"><SignupRecoveryWarning /></div>
      <Suspense
        fallback={
          <div className="max-w-md mx-auto flex flex-col items-center justify-center py-12">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-[rgb(var(--primary))] border-t-transparent" />
            <p className="mt-4 text-sm text-[rgb(var(--muted))]">Loading...</p>
          </div>
        }
      >
        <SignupSuccessInner />
      </Suspense>
    </>
  )
}
