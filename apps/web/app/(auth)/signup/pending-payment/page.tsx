'use client'

import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import { BILLING_API_URL } from '@/app/lib/config'
import { normalizeSignupReturnTo } from '@/app/lib/signup-return'
import { useAuthStore } from '@/app/stores/use-auth-store'
import {

  getAnonymousPaymentSessionRecovery,
  reconcileAnonymousPaymentSessionRecovery,
} from '@/app/lib/billing-v2'
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
/**
 * Settlement can take a while, so the waiting screen re-checks the anonymous
 * recovery sibling on the historical bounded schedule: 10s apart for the first
 * 30 attempts, then 30s, giving up after 180 so a paid customer is never left
 * on an animated spinner that resolves only if they press a button.
 */
const SETTLEMENT_POLL_MAX_ATTEMPTS = 180
const SETTLEMENT_POLL_FAST_ATTEMPTS = 30
const SETTLEMENT_POLL_FAST_DELAY_MS = 10_000
const SETTLEMENT_POLL_SLOW_DELAY_MS = 30_000

/** Whether a completed recovery read leaves anything worth re-checking. */
type SettlementPollDisposition = 'poll' | 'stop'

function settlementPollDelayMs(completedAttempts: number): number {
  return completedAttempts < SETTLEMENT_POLL_FAST_ATTEMPTS ? SETTLEMENT_POLL_FAST_DELAY_MS : SETTLEMENT_POLL_SLOW_DELAY_MS
}
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

function hasPersistedRecovery(pending: SignupPaymentContinuation | null): boolean {
  try {
    const raw = sessionStorage.getItem('silentsuite-signup-redirect-state')
    if (!raw || !pending) return false
    const saved = JSON.parse(raw)
    return saved.pendingSignup?.email === pending.email
      && saved.pendingSignup?.paymentSessionToken === pending.paymentSessionToken
      && saved.pendingSignup?.paymentSessionRequestKey === pending.paymentSessionRequestKey
      && saved.pendingSignup?.serverUrl === pending.serverUrl
      && typeof saved.savedAt === 'number' && Date.now() >= saved.savedAt
      && Date.now() - saved.savedAt < 2 * 60 * 60 * 1000
  } catch { return false }
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

export default function PendingPaymentPage() {
  const completeSignup = useAuthStore((s) => s.completeSignup)
  const createEtebaseAccount = useAuthStore((s) => s.createEtebaseAccount)
  const finalizePaidSignup = useAuthStore((s) => s.finalizePaidSignup)
  const saveSignupStateForRedirect = useAuthStore((s) => s.saveSignupStateForRedirect)
  const restoreSignupStateFromRedirect = useAuthStore((s) => s.restoreSignupStateFromRedirect)
  const pendingSignup = useAuthStore((s) => s.pendingSignup)
  const [returnTo, setReturnTo] = useState<string | null>(null)
  const [showReturnFallback, setShowReturnFallback] = useState(false)
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

  const loadCurrentFlow = useCallback(async (isCancelled: () => boolean = () => false): Promise<SettlementPollDisposition> => {
    if (!isCancelled()) {
      setFlowCheckState('loading')
      setRestartError(null)
    }
    try {
      if (activePendingSignup?.provisionedUser) return 'stop'
      if (activePendingSignup?.billingContractVersion !== 2
        && isEmail(activePendingSignup?.email)
        && isRecoveryToken(activePendingSignup.paymentSessionToken)) {
        if (!isCancelled()) {
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
        if (!isCancelled()) {
          setFlowCheckState('ready')
        }
        return 'stop'
      }
      let result = await getAnonymousPaymentSessionRecovery({
        fetcher: fetch,
        billingApiUrl: BILLING_API_URL,
        paymentSessionToken: recovery.paymentSessionToken,
        recoverySecret: recovery.paymentSessionToken,
        requestKey: recovery.requestKey,
        email: recovery.email,
      })
      if (result.state === 'open') {
        result = await reconcileAnonymousPaymentSessionRecovery({
          fetcher: fetch,
          billingApiUrl: BILLING_API_URL,
          paymentSessionToken: recovery.paymentSessionToken,
          recoverySecret: recovery.paymentSessionToken,
          requestKey: recovery.requestKey,
          email: recovery.email,
        })
      }
      if (isCancelled()) return 'stop'
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
    } catch {
      if (!isCancelled()) {
        setFlowCheckState('failed')
        setRestartError('Could not verify whether a payment is already in progress. Retry before starting another invoice.')
      }
      // A transient recovery failure is not a settlement answer, so the
      // schedule keeps its remaining attempts rather than stranding the user.
      return 'poll'
    }
  }, [activePendingSignup])

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
    if (!recoveryInitialized) return
    if (state === 'vault' || state === 'account' || state === 'settled') return

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
      timer = window.setTimeout(() => { void runAttempt() }, settlementPollDelayMs(attempts))
    }

    void runAttempt()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [loadCurrentFlow, recoveryInitialized, state])

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
    : 'Checking checkout status'
  const description = state === 'settled'
    ? 'Your annual prepaid access is active. Continue to vault setup.'
    : !hasRecovery
      ? 'This browser has no payment recovery capability. Return to the original signup tab to retry, or contact support if payment may have started. Do not start a second payment.'
      : 'An invoice or payment has not been confirmed. Check the existing checkout status. Back keeps this same payment recovery; it does not cancel or start another payment.'

  function handleRecoveryBack(event: MouseEvent<HTMLAnchorElement>) {
    if (hasRecovery && !hasPersistedRecovery(activePendingSignup)) {
      event.preventDefault()
      setRestartError('This browser could not retain payment recovery. Stay on this page to check the existing payment, or contact support. Do not start another payment.')
    }
  }

  function renderBitcoinRecoveryAction() {
    return <div className="space-y-3">
      {hasRecovery && <button type="button" onClick={() => { void loadCurrentFlow() }} disabled={flowCheckState === 'loading'} className="inline-flex min-h-9 w-full items-center justify-center rounded-md border border-[rgb(var(--border))] px-4 py-2 text-sm">
        {flowCheckState === 'loading' ? 'Checking current payment...' : flowCheckState === 'failed' ? 'Retry payment status' : 'Check payment status again'}
      </button>}
      <p className="text-sm">Reloading keeps this same payment. Cancellation and switching payment methods are not available here; contact support for help.</p>
      <a href="/signup?recovery=payment" onClick={handleRecoveryBack} className="block underline">Reload this payment recovery</a>
      <a href="mailto:support@silentsuite.io" className="block underline">Contact support</a>
    </div>
  }

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
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center space-y-6 text-center">
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
        ) : state === 'timeout' ? (
          <>
            <button type="button" onClick={() => { void loadCurrentFlow() }} className="inline-flex h-9 w-full items-center justify-center rounded-md bg-teal-500 px-4 py-2 text-sm font-medium text-white shadow transition-colors hover:bg-teal-600">
              Check again
            </button>
            {renderBitcoinRecoveryAction()}
          </>
        ) : state === 'pending' || state === 'expired' || state === 'unknown' ? (
          renderBitcoinRecoveryAction()
        ) : (
          renderBitcoinRecoveryAction()
        )}
        {restartError && (
          <p className="text-xs text-red-400">{restartError}</p>
        )}
      </div>
    </div>
  )
}
