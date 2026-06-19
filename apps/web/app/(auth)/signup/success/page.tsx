'use client'

import { useEffect, useState, useCallback, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { CheckCircle, AlertTriangle, Lock } from 'lucide-react'
import { MS_PER_DAY } from '@/app/lib/constants'
import { Button } from '@silentsuite/ui'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { formatDate as formatDateUtil } from '@/app/lib/date'
import { normalizeSignupReturnTo } from '@/app/lib/signup-return'
import { StepCreateVault } from '../components/step-create-vault'
import { StepCreatePaidAccount, type PaidAccountFormData } from '../components/step-create-paid-account'

// ---------------------------------------------------------------------------
// Inner component that reads searchParams (must be inside <Suspense>)
// ---------------------------------------------------------------------------

type RedirectState = 'loading' | 'account' | 'vault' | 'failed' | 'expired' | 'none'

function SignupSuccessInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const completeSignup = useAuthStore((s) => s.completeSignup)
  const createEtebaseAccount = useAuthStore((s) => s.createEtebaseAccount)
  const finalizePaidSignup = useAuthStore((s) => s.finalizePaidSignup)
  const restoreSignupStateFromRedirect = useAuthStore((s) => s.restoreSignupStateFromRedirect)
  const redirectStatus = searchParams.get('redirect_status')
  const setupIntent = searchParams.get('setup_intent')
  const returnTo = normalizeSignupReturnTo(searchParams.get('return_to'))
  const isStripeRedirect = !!(setupIntent && redirectStatus)

  const [state, setState] = useState<RedirectState>(isStripeRedirect ? 'loading' : 'none')
  const [restoredEmail, setRestoredEmail] = useState<string>('')
  const [showReturnFallback, setShowReturnFallback] = useState(false)

  useEffect(() => {
    if (!isStripeRedirect) return

    if (redirectStatus === 'failed') {
      setState('failed')
      return
    }

    if (redirectStatus === 'succeeded' || redirectStatus === 'processing') {
      const restored = restoreSignupStateFromRedirect()
      if (restored?.pendingSignup.provisionedUser) {
        setRestoredEmail(restored.pendingSignup.email)
        setState('vault')
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
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[rgb(var(--primary))] border-t-transparent" />
        <p className="mt-4 text-sm text-[rgb(var(--muted))]">Completing setup...</p>
      </div>
    )
  }

  if (state === 'account') {
    return (
      <div className="max-w-md mx-auto space-y-6">
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
  const trialEndDate = formatDateUtil(new Date(Date.now() + 30 * MS_PER_DAY), 'system', { day: 'numeric', month: 'long', year: 'numeric' })

  return (
    <div className="max-w-md mx-auto space-y-6 text-center">
      <div className="flex flex-col items-center gap-4">
        <div className="rounded-full bg-[rgb(var(--primary))]/10 p-4">
          <CheckCircle className="h-12 w-12 text-[rgb(var(--primary))]" />
        </div>
        <h2 className="text-xl font-semibold text-[rgb(var(--foreground))]">
          Payment successful!
        </h2>
        <p className="text-sm leading-relaxed text-[rgb(var(--muted))]">
          Your 30-day free trial has started. You won&apos;t be charged until{' '}
          <span className="font-medium text-[rgb(var(--foreground))]">{trialEndDate}</span>.
        </p>
      </div>

      <Button onClick={handleSuccessContinue} className="w-full">
        {returnTo ? 'Return to Android app' : 'Set up your workspace'}
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
  )
}
