'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import { BILLING_API_URL } from '@/app/lib/config'
import { normalizeSignupReturnTo } from '@/app/lib/signup-return'
import { useAuthStore } from '@/app/stores/use-auth-store'
import {

  BillingResponseError,
  getAnonymousPaymentSessionRecovery,
  reconcileAnonymousPaymentSessionRecovery,
} from '@/app/lib/billing-v2'
import StripePaymentForm from '@/app/components/stripe-payment-form'
import { AnnualTermsSummary, annualCardSubmitLabel } from '../components/annual-confirmation-summary'
import { retireSignupPaymentCheckpoints } from '../use-signup-navigation'
import { PaymentBackModal } from '../components/payment-back-modal'
import { PaymentProblemsLink } from '../components/payment-problems-link'
import type { AnonymousPaymentSessionRecovery, AnnualProvider } from '@/app/lib/billing-v2'
import { SignupRecoveryWarning } from '../components/signup-recovery-warning'
import { StepCreateVault } from '../components/step-create-vault'
import { StepCreatePaidAccount, type PaidAccountFormData } from '../components/step-create-paid-account'
import { CheckoutReturnAnalytics } from '../commercial-funnel-analytics'

type PaymentState = 'pending' | 'settled' | 'account' | 'vault' | 'expired' | 'timeout' | 'unknown'
type PaymentFlowCheckState = 'idle' | 'loading' | 'ready' | 'failed'


type PaymentSessionRecoveryContext = {
  email: string
  requestKey: string
  paymentSessionToken: string
}

type PersistedPaymentSessionRecoveryContext = Omit<PaymentSessionRecoveryContext, 'paymentSessionToken'>

type SignupPaymentContinuation = import('@/app/stores/use-auth-store').RedirectSignupState['pendingSignup']

const PENDING_CRYPTO_RECOVERY_CONTEXT_KEY = 'silentsuite-pending-crypto-recovery-context'
// Billing: current 10 / 15 minutes; reconcile 5 / 15 minutes. Four-minute
// polling leaves headroom for explicit checks. Both paths share the counters.
const RECOVERY_WINDOW_MS = 15 * 60_000
const SETTLEMENT_POLL_DELAY_MS = 4 * 60_000
const SETTLEMENT_POLL_MAX_ATTEMPTS = 20
const RECOVERY_LIMITS = { current: 10, reconcile: 5 } as const
type SettlementPollDisposition = 'poll' | 'stop'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function isRecoveryToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(value)
}

function isEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function readPersistedPaymentSessionRecoveryContext(): PersistedPaymentSessionRecoveryContext | null {
  try {
    const raw = sessionStorage.getItem(PENDING_CRYPTO_RECOVERY_CONTEXT_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as unknown
    if (!isRecord(value) || Object.keys(value).length !== 2 || !isEmail(value.email) || !isUuid(value.requestKey)) return null
    return { email: value.email, requestKey: value.requestKey }
  } catch {
    return null
  }
}

function readPaymentSessionRecoveryContext(pending: {
  email: string
  paymentSessionToken?: string
  paymentSessionRequestKey?: string
} | null): PaymentSessionRecoveryContext | null {
  const stored = readPersistedPaymentSessionRecoveryContext()
  const email = pending?.email ?? stored?.email
  const requestKey = pending?.paymentSessionRequestKey ?? stored?.requestKey
  const paymentSessionToken = pending?.paymentSessionToken ?? sessionStorage.getItem('silentsuite-pending-crypto-token')
  if (!isEmail(email) || !isUuid(requestKey) || !isRecoveryToken(paymentSessionToken)) return null
  return { email, requestKey, paymentSessionToken }
}

export default function PendingPaymentRecovery({ onReleased }: { onReleased?: () => void } = {}) {
  const completeSignup = useAuthStore((s) => s.completeSignup)
  const createEtebaseAccount = useAuthStore((s) => s.createEtebaseAccount)
  const finalizePaidSignup = useAuthStore((s) => s.finalizePaidSignup)
  const saveSignupStateForRedirect = useAuthStore((s) => s.saveSignupStateForRedirect)
  const restoreSignupStateFromRedirect = useAuthStore((s) => s.restoreSignupStateFromRedirect)
  const pendingSignup = useAuthStore((s) => s.pendingSignup)
  const [returnTo, setReturnTo] = useState<string | null>(null)
  const [showReturnFallback, setShowReturnFallback] = useState(false)
  const [ownedPayable, setOwnedPayable] = useState<{ identity: string; value: AnonymousPaymentSessionRecovery['continuation'] }>()
  const [ownedProvider, setOwnedProvider] = useState<AnnualProvider | null>(null)
  const [switching, setSwitching] = useState(false)
  const [released, setReleased] = useState(false)
  const backOpener = useRef<HTMLElement | null>(null)
  const releaseCallback = useRef(onReleased)
  releaseCallback.current = onReleased
  useEffect(() => {
    if (!released) return
    retireSignupPaymentCheckpoints()
    releaseCallback.current?.()
  }, [released])
  const [state, setState] = useState<PaymentState>('pending')
  const [restoredEmail, setRestoredEmail] = useState('')
  const [restartError, setRestartError] = useState<string | null>(null)
  const [sessionPassword, setSessionPassword] = useState('')
  const [recoveringSession, setRecoveringSession] = useState(false)
  const sessionInFlight = useRef(false)
  const recoverCompletedSignupSession = useAuthStore((s) => s.recoverCompletedSignupSession)
  const [flowCheckState, setFlowCheckState] = useState<PaymentFlowCheckState>('idle')
  // Kept out of `restartError`, which every flow check clears on entry.
  const [emailProofUnavailable, setEmailProofUnavailable] = useState(false)
  const [restoredContinuation, setRestoredContinuation] = useState<SignupPaymentContinuation | null>(null)
  const [recoveryInitialized, setRecoveryInitialized] = useState(false)
  const redirectRestorationAttempted = useRef(false)
  const activePendingSignup = (pendingSignup ?? restoredContinuation) as SignupPaymentContinuation | null

  const recoveryIdentity = JSON.stringify(readPaymentSessionRecoveryContext(activePendingSignup))
  const identityRef = useRef(recoveryIdentity)
  identityRef.current = recoveryIdentity
  const payable = ownedPayable?.identity === recoveryIdentity ? ownedPayable.value : undefined
  const setPayable = useCallback((value: AnonymousPaymentSessionRecovery['continuation']) => {
    setOwnedPayable(value ? { identity: recoveryIdentity, value } : undefined)
  }, [recoveryIdentity])
  const attemptsByRoute = useRef<{ current: number[]; reconcile: number[] }>({ current: [], reconcile: [] })
  const retryAt = useRef(0)
  const flowInFlight = useRef(false)
  const [retryUntil, setRetryUntil] = useState(0)
  const previousPending = useRef(pendingSignup)
  useEffect(() => {
    if (previousPending.current && !pendingSignup) {
      setRestoredContinuation(null)
      setOwnedPayable(undefined)
      setOwnedProvider(null)
      setSwitching(false)
    }
    previousPending.current = pendingSignup
  }, [pendingSignup])
  useEffect(() => {
    setOwnedPayable(undefined)
    setOwnedProvider(null)
    setSwitching(false)
    setState('pending')
  }, [recoveryIdentity])
  useEffect(() => {
    if (!retryUntil) return
    const timer = window.setTimeout(() => setRetryUntil(0), Math.max(0, retryUntil - Date.now()))
    return () => window.clearTimeout(timer)
  }, [retryUntil])

  const loadCurrentFlow = useCallback(async (isCancelled: () => boolean = () => false): Promise<SettlementPollDisposition> => {
    if (flowInFlight.current) return 'poll'
    flowInFlight.current = true
    const storeOwner = useAuthStore.getState().pendingSignup
    const stillCurrent = () => !isCancelled() && identityRef.current === recoveryIdentity
      && (!storeOwner || (useAuthStore.getState().pendingSignup !== null
        && JSON.stringify(readPaymentSessionRecoveryContext(useAuthStore.getState().pendingSignup)) === recoveryIdentity))
    const reserveRead = (route: 'current' | 'reconcile') => {
      const now = Date.now()
      const recent = attemptsByRoute.current[route].filter(at => at > now - RECOVERY_WINDOW_MS)
      attemptsByRoute.current[route] = recent
      const availableAt = Math.max(retryAt.current, recent.length >= RECOVERY_LIMITS[route] ? recent[0] + RECOVERY_WINDOW_MS : 0)
      if (availableAt > now) throw new BillingResponseError('Payment status retry is delayed', 429, null, availableAt - now)
      recent.push(now)
    }
    if (stillCurrent()) {
      setFlowCheckState('loading')
      setRestartError(null)
    }
    try {
      if (activePendingSignup?.provisionedUser) return 'stop'
      if (activePendingSignup?.billingContractVersion !== 2
        && isEmail(activePendingSignup?.email)
        && isRecoveryToken(activePendingSignup.paymentSessionToken)) {
        if (stillCurrent()) {
          setRestoredEmail(activePendingSignup.email)
          setFlowCheckState('ready')
          setState('account')
        }
        return 'stop'
      }
      const recovery = readPaymentSessionRecoveryContext(activePendingSignup)
      if (!recovery) {
        // Nothing local can be polled, and re-running this would only flicker
        // the recovery controls back into their "checking" state every tick.
        if (stillCurrent()) {
          setFlowCheckState('ready')
        }
        return 'stop'
      }
      reserveRead('current')
      let result = await getAnonymousPaymentSessionRecovery({
        fetcher: fetch,
        billingApiUrl: BILLING_API_URL,
        paymentSessionToken: recovery.paymentSessionToken,
        recoverySecret: recovery.paymentSessionToken,
        requestKey: recovery.requestKey,
        email: recovery.email,
      })
      if (!stillCurrent()) return 'stop'
      // Even if reconciliation subsequently fails, a current authoritative
      // response without payable evidence must remove the old controls.
      setPayable(result.continuation)
      if (result.state === 'open' && !result.continuation) {
        reserveRead('reconcile')
        result = await reconcileAnonymousPaymentSessionRecovery({
          fetcher: fetch,
          billingApiUrl: BILLING_API_URL,
          paymentSessionToken: recovery.paymentSessionToken,
          recoverySecret: recovery.paymentSessionToken,
          requestKey: recovery.requestKey,
          email: recovery.email,
        })
      }
      if (!stillCurrent()) return 'stop'
      if (result.flow && activePendingSignup?.paymentMethod && result.flow.provider !== activePendingSignup.paymentMethod) throw new Error('Mismatched payment provider')
      setOwnedProvider(result.flow?.provider ?? null)
      setPayable(result.continuation)
      if (result.state === 'released' && result.release) {
        if (activePendingSignup?.paymentMethod && result.release.provider !== activePendingSignup.paymentMethod) throw new Error('Mismatched release provider')
        useAuthStore.getState().clearPendingSignupPaymentRecovery({ email: recovery.email, requestKey: recovery.requestKey, recoverySecret: recovery.paymentSessionToken })
        if (!useAuthStore.getState().pendingSignup?.paymentSessionToken) setReleased(true)
        setFlowCheckState('ready')
        return 'stop'
      }
      if (result.state === 'closed') {
        // Generic closed is also returned for unknown proof: never release authority.
        setFlowCheckState('ready')
        setState('unknown')
        return 'stop'
      }
      if (result.state === 'confirmed') {
        setRestoredEmail(recovery.email)
        setFlowCheckState('ready')
        setState('account')
        return 'stop'
      }
      setFlowCheckState('ready')
      return 'poll'
    } catch (error) {
      if (stillCurrent()) {
        const transient = error instanceof TypeError || (error instanceof BillingResponseError
          && (error.billingStatus === 429 || error.billingStatus >= 500))
        if (!transient) setPayable(undefined)
        if (error instanceof BillingResponseError && error.retryAfterMs !== null) {
          retryAt.current = Math.max(retryAt.current, Date.now() + error.retryAfterMs)
          setRetryUntil(retryAt.current)
        }
        setFlowCheckState('failed')
        setRestartError('Could not verify whether a payment is already in progress. Retry before starting another invoice.')
      }
      // A transient recovery failure is not a settlement answer, so the
      // schedule keeps its remaining attempts rather than stranding the user.
      return 'poll'
    } finally { flowInFlight.current = false }
  }, [activePendingSignup, recoveryIdentity, setPayable])

  useEffect(() => {
    if (redirectRestorationAttempted.current) return
    redirectRestorationAttempted.current = true
    if (!pendingSignup) {
      const restored = restoreSignupStateFromRedirect({ retainForRecovery: true })
      if (restored) setRestoredContinuation(restored.pendingSignup)
    } else {
      // Snapshot the in-memory continuation before any full-document departure.
      // Do not renew a restored snapshot's bounded lifetime. Passwords/session
      // attestations are excluded by the store's allowlisted serializer.
      saveSignupStateForRedirect('annual')
    }
    setRecoveryInitialized(true)
  }, [pendingSignup, restoreSignupStateFromRedirect, saveSignupStateForRedirect])

  useEffect(() => {
    setReturnTo(normalizeSignupReturnTo(sessionStorage.getItem('silentsuite-pending-crypto-return-to')))
    if (!recoveryInitialized || released || switching) return
    if (state !== 'pending') return

    let cancelled = false
    let timer: number | undefined
    let attempts = 0

    const runAttempt = async () => {
      attempts += 1
      const disposition = await loadCurrentFlow(() => cancelled)
      if (cancelled) return
      // Only the waiting screen re-checks on a schedule. Terminal screens own
      // their own explicit retry controls, and re-entering this effect with a
      // new `state` would otherwise restart the schedule indefinitely.
      if (disposition === 'stop' || state !== 'pending') return
      if (attempts >= SETTLEMENT_POLL_MAX_ATTEMPTS) {
        setState('timeout')
        sessionStorage.removeItem('silentsuite-signup-in-progress')
        return
      }
      timer = window.setTimeout(() => { void runAttempt() }, Math.max(SETTLEMENT_POLL_DELAY_MS, retryAt.current - Date.now()))
    }

    void runAttempt()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [loadCurrentFlow, recoveryInitialized, state, released, switching])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.has('email_verification_token') || params.has('token')) setEmailProofUnavailable(true)
  }, [])

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
    if (useAuthStore.getState().pendingSignup?.provisionedUser) {
      await recoverCompletedSignupSession(data.password)
      setState('vault')
      return
    }
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
  const hasRecovery = Boolean(readPaymentSessionRecoveryContext(activePendingSignup))
  // The recovery projection contains no correlated invoice readiness evidence.
  // A local invoice string must never become an availability claim.
  const title = state === 'settled' ? 'Payment settled'
    : state === 'unknown' ? 'Payment release not confirmed'
    : !hasRecovery ? 'Payment recovery details unavailable'
    : state === 'timeout' ? 'Payment status is still unconfirmed'
    : payable ? 'Continue your existing payment' : 'Checking checkout status'
  const description = state === 'settled'
    ? 'Your annual prepaid access is active. Continue to vault setup.'
    : !hasRecovery
      ? 'This browser has no payment recovery capability. Return to the original signup tab, or contact support if payment may have started. Do not start a second payment.'
      : state === 'timeout' || state === 'unknown' ? 'This payment is still unconfirmed. Check again to recover this same payment before starting another.'
      : payable ? 'Continue the same payment below. Your account continues automatically once it is confirmed.' : 'This payment has not been confirmed yet. Its status is checked automatically, and your account continues once it is confirmed.'
  // Back cancels this exact owned payment; the provider is authoritative once
  // read, otherwise the persisted method of the same capability.
  const backProvider: AnnualProvider | null = ownedProvider
    ?? (activePendingSignup?.paymentMethod === 'stripe' || activePendingSignup?.paymentMethod === 'btcpay' ? activePendingSignup.paymentMethod : null)

  function renderPaymentControls() {
    return <div className="space-y-3">
      {payable && <div className="space-y-4">
        <AnnualTermsSummary disclosure={payable.disclosure} />
        {payable.provider === 'stripe' && payable.clientSecret
          ? <StripePaymentForm key={payable.providerObjectId} clientSecret={payable.clientSecret} mode={payable.disclosure.kind === 'card_trial' ? 'setup' : 'payment'} submitLabel={annualCardSubmitLabel(payable.disclosure)} selectedInterval="annual" onSuccess={() => { setPayable(undefined); void loadCurrentFlow() }} />
          : payable.checkoutUrl && <a href={payable.checkoutUrl} onClick={() => saveSignupStateForRedirect('annual')} className="block rounded-md border p-3 text-center">Continue this Bitcoin payment</a>}
      </div>}
      {hasRecovery && flowCheckState === 'loading' && <p role="status" className="text-xs text-[rgb(var(--muted))]">Checking current payment...</p>}
      {hasRecovery && flowCheckState === 'failed' && <button type="button" onClick={() => { void loadCurrentFlow() }} disabled={retryUntil > Date.now()} className="text-sm underline disabled:opacity-50">Retry</button>}
      {hasRecovery && backProvider
        ? <button type="button" onClick={event => { backOpener.current = event.currentTarget; setSwitching(true) }} disabled={flowCheckState === 'loading'} className="inline-flex min-h-9 w-full items-center justify-center rounded-md border border-[rgb(var(--border))] px-4 py-2 text-sm disabled:opacity-50">Back</button>
        : <a href="/signup" className="inline-flex min-h-9 w-full items-center justify-center rounded-md border border-[rgb(var(--border))] px-4 py-2 text-sm">Back</a>}
      <PaymentProblemsLink />
    </div>
  }

  if (released) return <div className="space-y-4"><h1 className="text-xl font-semibold">Verify email to choose a payment method</h1><p>Payment cancelled. This browser no longer has valid email verification and signed signup terms. Verify your email again to load payment choices.</p><a href="/signup" className="underline">Verify email again</a></div>

  if (state === 'vault') {
    return (
      <div className="mx-auto max-w-md space-y-6">
        <SignupRecoveryWarning />
        <div className="flex items-center gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4">
          <Check className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div>
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">Continue account setup</p>
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

  if (activePendingSignup?.provisionedUser) {
    return <div className="mx-auto max-w-md space-y-6">
      <SignupRecoveryWarning />
      <h1 className="text-xl font-semibold">Finish signing in</h1>
      <p>Your account is already set up. Enter your existing account password to finish signing in. Your payment will not be submitted again.</p>
      <form className="space-y-4" onSubmit={async (event) => {
        event.preventDefault()
        if (sessionInFlight.current) return
        sessionInFlight.current = true
        setRecoveringSession(true)
        setRestartError(null)
        try {
          await recoverCompletedSignupSession(sessionPassword || undefined)
          setSessionPassword('')
          setRestoredEmail(activePendingSignup.email)
          setState('vault')
        } catch (error) {
          setRestartError(error instanceof Error ? error.message : 'Could not finish signing in.')
        } finally {
          sessionInFlight.current = false
          setRecoveringSession(false)
        }
      }}>
        <label htmlFor="recovery-password">Existing account password</label>
        <input id="recovery-password" type="password" autoComplete="current-password" value={sessionPassword} onChange={(event) => setSessionPassword(event.target.value)} />
        <button type="submit" disabled={recoveringSession}>{recoveringSession ? 'Signing in...' : 'Retry sign in'}</button>
        {restartError && <p role="alert">{restartError}</p>}
      </form>
    </div>
  }

  if (state === 'account') {
    return (
      <div className="mx-auto max-w-md space-y-6">
        <SignupRecoveryWarning />
        <div className="flex items-center gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4">
          <Check className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div>
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">Continue account setup</p>
            <p className="text-xs text-[rgb(var(--muted))]">One last account step before your vault setup.</p>
          </div>
        </div>
        <StepCreatePaidAccount email={restoredEmail} onNext={handlePaidAccountComplete} />
      </div>
    )
  }

  return (
    <>
    {switching && backProvider && <PaymentBackModal provider={backProvider} restoreFocusTo={backOpener.current} onStay={() => setSwitching(false)}
      onReleased={() => { setSwitching(false); setPayable(undefined); setReleased(true) }} />}
    <div aria-hidden={switching ? true : undefined} inert={switching} className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center space-y-6 text-center">
      <SignupRecoveryWarning />
      <CheckoutReturnAnalytics outcome="pending" paymentMethod="btcpay" />
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
      {state === 'settled' && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-left text-xs text-[rgb(var(--muted))]">
          SilentSuite cannot recover your password or decrypt your vault for you. Keep your password safe before adding important data.
        </div>
      )}
      <div className="space-y-3">
        {emailProofUnavailable && (
          <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-left text-sm text-red-600 dark:text-red-400">
            <p className="font-medium">This verification link could not be matched to a payment in this browser.</p>
            <p className="mt-1">Open the link in the browser you requested it from, or contact support for help with this payment.</p>
          </div>
        )}
        {state === 'settled' ? (
          <>
            <button type="button" onClick={handleSettledContinue} className="inline-flex h-9 w-full items-center justify-center rounded-md bg-teal-500 px-4 py-2 text-sm font-medium text-white shadow transition-colors hover:bg-teal-600">
              {returnTo ? 'Return to Android app' : 'Open app.silentsuite.io'}
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
        ) : state === 'timeout' || state === 'unknown' ? (
          <>
            <button type="button" onClick={() => { void loadCurrentFlow() }} disabled={flowCheckState === 'loading' || retryUntil > Date.now()} className="inline-flex h-9 w-full items-center justify-center rounded-md bg-teal-500 px-4 py-2 text-sm font-medium text-white shadow transition-colors hover:bg-teal-600">
              Check again
            </button>
            {renderPaymentControls()}
          </>
        ) : (
          renderPaymentControls()
        )}
        {restartError && (
          <p className="text-xs text-red-400">{restartError}</p>
        )}
      </div>
    </div>
    </>
  )
}
