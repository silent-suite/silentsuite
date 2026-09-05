'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import { BILLING_API_URL } from '@/app/lib/config'
import { normalizeSignupReturnTo } from '@/app/lib/signup-return'
import { useAuthStore } from '@/app/stores/use-auth-store'
import {
  activateAnnualCheckout,
  cancelAnonymousPaymentSessionRecovery,
  consumeSignupEmailOwnership,
  fetchAnonymousAnnualOffer,
  getAnonymousPaymentSessionRecovery,
  reconcileAnonymousPaymentSessionRecovery,
  requestSignupEmailOwnership,
  type AnnualCheckoutActivation,
  type AnonymousPaymentSessionRecovery,
} from '@/app/lib/billing-v2'
import { isAnnualOfferProviderAvailable } from '@/app/lib/annual-offer-presentation'
import { StepCreateVault } from '../components/step-create-vault'
import { StepCreatePaidAccount, type PaidAccountFormData } from '../components/step-create-paid-account'
import { CheckoutReturnAnalytics } from '../commercial-funnel-analytics'

type PaymentState = 'pending' | 'settled' | 'account' | 'vault' | 'expired' | 'timeout' | 'unknown'
type PaymentFlowCheckState = 'idle' | 'loading' | 'ready' | 'failed'

type CurrentPaymentFlow = NonNullable<AnonymousPaymentSessionRecovery['flow']>

type PaymentSessionRecoveryContext = {
  email: string
  requestKey: string
  paymentSessionToken: string
}

type PersistedPaymentSessionRecoveryContext = Omit<PaymentSessionRecoveryContext, 'paymentSessionToken'>

type SignupPaymentContinuation = {
  email: string
  serverUrl?: string
  paymentSessionToken?: string
  paymentSessionRequestKey?: string
  paymentMethod?: 'stripe' | 'btcpay'
  billingContractVersion?: 1 | 2
  wantsProductUpdates?: boolean
  rememberDevice?: boolean
}

type VerifiedAnnualRestartContext = Pick<
  SignupPaymentContinuation,
  'email' | 'paymentSessionRequestKey' | 'paymentMethod' | 'billingContractVersion' | 'wantsProductUpdates' | 'rememberDevice'
>

const BTCPAY_CHECKOUT_ORIGIN = process.env.NEXT_PUBLIC_BTCPAY_CHECKOUT_ORIGIN ?? 'https://btcpay.silentsuite.io'
const CRYPTO_CHECKOUT_ENABLED = process.env.NEXT_PUBLIC_BTCPAY_CHECKOUT_ENABLED === 'true'
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
 * The restart continuation lives in localStorage, not sessionStorage. Opening
 * the verification link is a full page load — often in a brand new browsing
 * context — by which point `pendingSignup`, the restored continuation and the
 * one-time redirect snapshot are all gone. This is the only thing that carries
 * the restart across that navigation. It holds an email, a request id and two
 * booleans: no password and no payment capability.
 */
function readEmailProofContext(requestId: string | null): EmailProofContext | null {
  try {
    const raw = localStorage.getItem(EMAIL_PROOF_CONTEXT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<EmailProofContext> | Record<string, Partial<EmailProofContext>>
    const candidate = requestId && requestId in parsed ? (parsed as Record<string, Partial<EmailProofContext>>)[requestId] : parsed as Partial<EmailProofContext>
    if (isEmail(candidate.email) && isUuid(candidate.requestId)
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

function persistEmailProofContext(context: EmailProofContext) {
  const existing = (() => { try { return JSON.parse(localStorage.getItem(EMAIL_PROOF_CONTEXT_KEY) ?? '{}') as Record<string, EmailProofContext> } catch { return {} } })()
  localStorage.setItem(EMAIL_PROOF_CONTEXT_KEY, JSON.stringify({ ...existing, [context.requestId]: context }))
}

function clearEmailProofContext(requestId: string | null) {
  try {
    if (!isUuid(requestId)) return
    const raw = localStorage.getItem(EMAIL_PROOF_CONTEXT_KEY)
    if (!raw) return
    const contexts = JSON.parse(raw) as Record<string, unknown>
    if (contexts.requestId === requestId && typeof contexts.email === 'string') {
      localStorage.removeItem(EMAIL_PROOF_CONTEXT_KEY)
      return
    }
    delete contexts[requestId]
    if (Object.keys(contexts).length) localStorage.setItem(EMAIL_PROOF_CONTEXT_KEY, JSON.stringify(contexts))
    else localStorage.removeItem(EMAIL_PROOF_CONTEXT_KEY)
  } catch {
    // A storage failure must not break the restart it was only annotating.
  }
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

function captureVerifiedAnnualRestartContext(
  pending: SignupPaymentContinuation | null,
  recovery: PaymentSessionRecoveryContext | null,
): VerifiedAnnualRestartContext | null {
  if (!pending || !recovery) return null
  const context: VerifiedAnnualRestartContext = {
    email: recovery.email,
    paymentSessionRequestKey: recovery.requestKey,
  }
  if (pending.paymentMethod === 'stripe' || pending.paymentMethod === 'btcpay') context.paymentMethod = pending.paymentMethod
  if (pending.billingContractVersion === 1 || pending.billingContractVersion === 2) context.billingContractVersion = pending.billingContractVersion
  if (typeof pending.wantsProductUpdates === 'boolean') context.wantsProductUpdates = pending.wantsProductUpdates
  if (typeof pending.rememberDevice === 'boolean') context.rememberDevice = pending.rememberDevice
  return context
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

function persistPaymentSessionRecoveryContext(context: PersistedPaymentSessionRecoveryContext) {
  sessionStorage.setItem(PENDING_CRYPTO_RECOVERY_CONTEXT_KEY, JSON.stringify(context))
}

function clearPendingCryptoPaymentSession() {
  sessionStorage.removeItem('silentsuite-pending-crypto-invoice')
  sessionStorage.removeItem('silentsuite-pending-crypto-token')
  sessionStorage.removeItem('silentsuite-pending-crypto-return-to')
  sessionStorage.removeItem(PENDING_CRYPTO_RECOVERY_CONTEXT_KEY)
}

function clearPendingCryptoSignup() {
  clearPendingCryptoPaymentSession()
  sessionStorage.removeItem('silentsuite-signup-in-progress')
}

export default function PendingPaymentPage() {
  const completeSignup = useAuthStore((s) => s.completeSignup)
  const createEtebaseAccount = useAuthStore((s) => s.createEtebaseAccount)
  const finalizePaidSignup = useAuthStore((s) => s.finalizePaidSignup)
  const prepareSignupDraft = useAuthStore((s) => s.prepareSignupDraft)
  const startAnnualSignupPayment = useAuthStore((s) => s.startAnnualSignupPayment)
  const clearPendingSignupPaymentRecovery = useAuthStore((s) => s.clearPendingSignupPaymentRecovery)
  const saveSignupStateForRedirect = useAuthStore((s) => s.saveSignupStateForRedirect)
  const restoreSignupStateFromRedirect = useAuthStore((s) => s.restoreSignupStateFromRedirect)
  const pendingSignup = useAuthStore((s) => s.pendingSignup)
  const [returnTo, setReturnTo] = useState<string | null>(null)
  const [showReturnFallback, setShowReturnFallback] = useState(false)
  const [state, setState] = useState<PaymentState>('pending')
  const [restoredEmail, setRestoredEmail] = useState('')
  const [restarting, setRestarting] = useState(false)
  const [restartError, setRestartError] = useState<string | null>(null)
  const [currentFlow, setCurrentFlow] = useState<CurrentPaymentFlow | null>(null)
  const [flowCheckState, setFlowCheckState] = useState<PaymentFlowCheckState>('idle')
  const [emailOwnershipToken, setEmailOwnershipToken] = useState<string | null>(null)
  const [emailProofRequestId, setEmailProofRequestId] = useState<string | null>(null)
  const [emailProofRequested, setEmailProofRequested] = useState(false)
  const [pendingRestartActivation, setPendingRestartActivation] = useState<AnnualCheckoutActivation | null>(null)
  // Kept out of `restartError`, which every flow check clears on entry.
  const [emailProofUnavailable, setEmailProofUnavailable] = useState(false)
  const [restoredContinuation, setRestoredContinuation] = useState<SignupPaymentContinuation | null>(null)
  const [verifiedRestartContext, setVerifiedRestartContext] = useState<VerifiedAnnualRestartContext | null>(null)
  const [recoveryInitialized, setRecoveryInitialized] = useState(false)
  const redirectRestorationAttempted = useRef(false)
  const terminalAuthorityReleased = useRef(false)
  const activePendingSignup = (pendingSignup ?? restoredContinuation) as SignupPaymentContinuation | null

  const releaseTerminalPaymentSession = useCallback((
    restartContext: VerifiedAnnualRestartContext | null,
    recovery: PaymentSessionRecoveryContext,
  ) => {
    if (terminalAuthorityReleased.current) return
    terminalAuthorityReleased.current = true
    if (restartContext) setVerifiedRestartContext(restartContext)
    clearPendingCryptoSignup()
    clearPendingSignupPaymentRecovery({
      email: recovery.email,
      requestKey: recovery.requestKey,
      recoverySecret: recovery.paymentSessionToken,
      wantsProductUpdates: restartContext?.wantsProductUpdates,
      rememberDevice: restartContext?.rememberDevice,
    })
    setCurrentFlow(null)
    setFlowCheckState('ready')
  }, [clearPendingSignupPaymentRecovery])

  const loadCurrentFlow = useCallback(async (isCancelled: () => boolean = () => false): Promise<SettlementPollDisposition> => {
    if (!isCancelled()) {
      setFlowCheckState('loading')
      setCurrentFlow(null)
      setRestartError(null)
    }
    try {
      if (activePendingSignup?.billingContractVersion !== 2
        && isEmail(activePendingSignup?.email)
        && isRecoveryToken(activePendingSignup.paymentSessionToken)) {
        if (!isCancelled()) {
          setRestoredEmail(activePendingSignup.email)
          setCurrentFlow(null)
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
          setCurrentFlow(null)
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
        releaseTerminalPaymentSession(captureVerifiedAnnualRestartContext(activePendingSignup, recovery), recovery)
        setState('expired')
        return 'stop'
      }
      if (result.state === 'confirmed') {
        setRestoredEmail(recovery.email)
        setCurrentFlow(null)
        setFlowCheckState('ready')
        setState('account')
        return 'stop'
      }
      setCurrentFlow(result.flow)
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
  }, [activePendingSignup, releaseTerminalPaymentSession])

  useEffect(() => {
    if (redirectRestorationAttempted.current) return
    redirectRestorationAttempted.current = true
    if (!pendingSignup) {
      const restored = restoreSignupStateFromRedirect()
      if (restored) setRestoredContinuation(restored.pendingSignup)
    }
    setRecoveryInitialized(true)
  }, [pendingSignup, restoreSignupStateFromRedirect])

  useEffect(() => {
    setReturnTo(normalizeSignupReturnTo(sessionStorage.getItem('silentsuite-pending-crypto-return-to')))
    if (!recoveryInitialized) return
    if (terminalAuthorityReleased.current) return
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
    const token = params.get('email_verification_token') ?? params.get('token')
    if (!token) return
    const requestId = params.get('request_id')
    const context = readEmailProofContext(requestId)
    if (!context) {
      // Without the continuation there is no email to verify the token against,
      // so the restart cannot proceed here. Say so instead of leaving the user
      // on a button that will only ever answer "return to signup".
      clearEmailProofContext(requestId)
      setEmailProofRequested(false)
      setEmailProofUnavailable(true)
      return
    }

    let cancelled = false
    void consumeSignupEmailOwnership({
      fetcher: fetch,
      billingApiUrl: BILLING_API_URL,
      email: context.email,
      token,
    }).then((ownership) => {
      if (cancelled) return
      // Rebuild the signup draft the released terminal session took with it:
      // `startAnnualSignupPayment` needs a pendingSignup, and its recovery
      // scope must match the flags this continuation was requested under so a
      // fresh requestKey/secret pair is minted for the replacement invoice.
      prepareSignupDraft(context.email, context.wantsProductUpdates, context.rememberDevice)
      setVerifiedRestartContext({
        email: context.email,
        paymentMethod: 'btcpay',
        billingContractVersion: 2,
        wantsProductUpdates: context.wantsProductUpdates,
        rememberDevice: context.rememberDevice,
      })
      setEmailOwnershipToken(ownership.emailOwnershipToken)
      setEmailProofRequestId(context.requestId)
      setReturnTo(context.returnTo ?? null)
      setEmailProofRequested(false)
      setEmailProofUnavailable(false)
      setRestartError(null)
      clearEmailProofContext(requestId)
      const cleaned = new URL(window.location.href)
      cleaned.searchParams.delete('email_verification_token')
      cleaned.searchParams.delete('token')
      window.history.replaceState({}, '', `${cleaned.pathname}${cleaned.search}${cleaned.hash}`)
    }).catch((err: unknown) => {
      if (!cancelled) setRestartError(err instanceof Error ? err.message : 'Email verification could not be completed. Request a new link.')
    })
    return () => { cancelled = true }
  }, [prepareSignupDraft])

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
      ? 'The invoice expired or was marked invalid. Verify your email to request a new cryptocurrency invoice without creating another account.'
      : state === 'timeout'
        ? 'Settlement is taking longer than expected. You can check again manually or start a new cryptocurrency invoice.'
        : state === 'unknown'
          ? 'This browser no longer has the invoice details needed to poll BTCPay. If your billing session is still active, you can start a new cryptocurrency invoice.'
          : 'Crypto payments can take a little time to settle. Your app access stays locked until the BTCPay webhook activates the account.'

  async function restartBitcoinCheckout() {
    if (flowCheckState !== 'ready' || currentFlow) {
      setRestartError('Check the current payment status before starting another invoice.')
      return
    }
    const restartContinuation = verifiedRestartContext ?? activePendingSignup
    const email = restartContinuation?.email
    if (!email) {
      setRestartError('Return to signup to verify your email before starting another invoice.')
      return
    }

    setRestarting(true)
    setRestartError(null)
    try {
      if (!emailOwnershipToken || !emailProofRequestId) {
        const requestId = crypto.randomUUID()
        const context: EmailProofContext = {
          email,
          requestId,
          wantsProductUpdates: restartContinuation?.wantsProductUpdates === true,
          rememberDevice: restartContinuation?.rememberDevice === true,
          returnTo,
          expiresAt: Date.now() + 15 * 60_000,
        }
        await requestSignupEmailOwnership({ fetcher: fetch, billingApiUrl: BILLING_API_URL, email, requestId })
        persistEmailProofContext(context)
        setEmailProofRequestId(requestId)
        setEmailProofRequested(true)
        return
      }

      const offer = await fetchAnonymousAnnualOffer({ fetcher: fetch, billingApiUrl: BILLING_API_URL, email, requestId: emailProofRequestId })
      if (!isAnnualOfferProviderAvailable(offer.offer, 'btcpay', CRYPTO_CHECKOUT_ENABLED)) {
        throw new Error('Cryptocurrency checkout is not available for this server-owned annual offer.')
      }
      const authority = await activateAnnualCheckout({
        fetcher: fetch, billingApiUrl: BILLING_API_URL, offer, email, emailOwnershipToken,
        trialPath: 'immediate', provider: 'btcpay', behavior: 'prepaid_bitcoin',
      })
      setPendingRestartActivation(authority)
    } catch (err) {
      setRestartError(err instanceof Error ? err.message : 'Could not prepare a new cryptocurrency invoice.')
    } finally {
      setRestarting(false)
    }
  }

  async function confirmBitcoinRestart() {
    const authority = pendingRestartActivation
    if (!authority) return
    const email = (verifiedRestartContext ?? activePendingSignup)?.email
    if (!email) return
    setRestarting(true)
    setRestartError(null)
    try {
      const result = await startAnnualSignupPayment(
        authority.checkoutIntentToken,
        'btcpay',
        new URL('/signup/pending-payment', window.location.href).toString(),
      )
      if (!result.cryptoCheckoutUrl || !result.cryptoInvoiceId || !result.cryptoInvoiceLookupToken) {
        throw new Error('Billing did not return a complete cryptocurrency payment authority.')
      }
      const checkoutUrl = new URL(result.cryptoCheckoutUrl)
      if (checkoutUrl.origin !== BTCPAY_CHECKOUT_ORIGIN || checkoutUrl.protocol !== 'https:') {
        throw new Error('Cryptocurrency checkout returned an unexpected payment URL.')
      }
      sessionStorage.setItem('silentsuite-pending-crypto-invoice', result.cryptoInvoiceId)
      if (returnTo) sessionStorage.setItem('silentsuite-pending-crypto-return-to', returnTo)
      const requestKey = useAuthStore.getState().pendingSignup?.paymentSessionRequestKey
      if (!isUuid(requestKey)) throw new Error('Billing did not retain the payment recovery lineage.')
      persistPaymentSessionRecoveryContext({ email, requestKey })
      // The one-time redirect snapshot is the sole persisted payment-session
      // capability for the full navigation to BTCPay.
      saveSignupStateForRedirect('annual')
      sessionStorage.setItem('silentsuite-signup-in-progress', 'true')
      setPendingRestartActivation(null)
      window.location.href = checkoutUrl.toString()
    } catch (err) {
      setRestartError(err instanceof Error ? err.message : 'Could not start a new cryptocurrency invoice.')
    } finally {
      setRestarting(false)
    }
  }

  async function cancelCurrentFlow() {
    setRestarting(true)
    setRestartError(null)
    try {
      const recovery = readPaymentSessionRecoveryContext(activePendingSignup)
      if (!recovery) throw new Error('The payment recovery details are unavailable.')
      const result = await cancelAnonymousPaymentSessionRecovery({
        fetcher: fetch, billingApiUrl: BILLING_API_URL,
        paymentSessionToken: recovery.paymentSessionToken, recoverySecret: recovery.paymentSessionToken,
        requestKey: recovery.requestKey, email: recovery.email,
      })
      if (result.state !== 'closed') {
        throw new Error('Billing did not confirm that the payment flow is terminal.')
      }
      releaseTerminalPaymentSession(captureVerifiedAnnualRestartContext(activePendingSignup, recovery), recovery)
    } catch {
      // Do not reveal recovery capability or provider detail, and do not
      // release local state without an authoritative closed v2 response.
      setRestartError('Could not cancel the payment in progress.')
    } finally {
      setRestarting(false)
    }
  }

  function currentCheckoutUrl(): string | null {
    // Recovery responses intentionally omit the original checkout URL. It is
    // an untrusted cross-navigation authority and is never reconstructed here.
    return null
  }

  function renderBitcoinRecoveryAction() {
    if (pendingRestartActivation) {
      const disclosure = pendingRestartActivation.disclosure
      return (
        <div className="space-y-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 text-left">
          <h2 className="text-base font-semibold text-[rgb(var(--foreground))]">Confirm prepaid annual terms</h2>
          <p className="text-sm text-[rgb(var(--muted))]">€{(disclosure.annualAmountMinor / 100).toFixed(2)} for one prepaid year. This payment does not renew automatically.</p>
          <p className="text-sm text-[rgb(var(--muted))]">€{(disclosure.monthlyEquivalentMinor / 100).toFixed(2)} per month equivalent, billed in {disclosure.currency}.</p>
          <p className="text-sm text-[rgb(var(--muted))]">First charge amount: €{(disclosure.firstChargeAmountMinor / 100).toFixed(2)}.</p>
          <p className="text-sm text-[rgb(var(--muted))]">First charge: {disclosure.firstChargeAt ?? 'Immediate on confirmation'}.</p>
          <p className="text-sm text-[rgb(var(--muted))]">Access through: {disclosure.entitlementEndsAt ?? 'Determined from provider confirmation'}.</p>
          <p className="text-sm text-[rgb(var(--muted))]">Period end rule: {disclosure.periodEndRule.replaceAll('_', ' ')}.</p>
          <p className="text-sm text-[rgb(var(--muted))]">{disclosure.refundWindowDays}-day refund window and {disclosure.bonusDays} bonus days after settlement.</p>
          <button type="button" onClick={() => { void confirmBitcoinRestart() }} disabled={restarting} className="inline-flex h-9 w-full items-center justify-center rounded-md bg-teal-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
            {restarting ? 'Creating invoice...' : 'I agree — create cryptocurrency invoice'}
          </button>
          <button type="button" onClick={() => setPendingRestartActivation(null)} disabled={restarting} className="inline-flex h-9 w-full items-center justify-center rounded-md border border-navy-300 px-4 py-2 text-sm font-medium">Cancel</button>
        </div>
      )
    }
    if (flowCheckState === 'idle' || flowCheckState === 'loading') {
      return (
        <button type="button" disabled className="inline-flex h-9 w-full items-center justify-center rounded-md border border-navy-300 bg-transparent px-4 py-2 text-sm font-medium opacity-60">
          Checking current payment...
        </button>
      )
    }
    if (flowCheckState === 'failed') {
      return (
        <button type="button" onClick={() => { void loadCurrentFlow() }} className="inline-flex h-9 w-full items-center justify-center rounded-md border border-navy-300 bg-transparent px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-navy-100">
          Retry payment status
        </button>
      )
    }
    if (currentFlow) {
      const checkoutUrl = currentCheckoutUrl()
      return (
        <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-left">
          <div>
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">Payment already in progress</p>
            <p className="mt-1 text-xs text-[rgb(var(--muted))]">Continue the existing payment or cancel it before starting another invoice.</p>
          </div>
          {checkoutUrl && (
            <button type="button" onClick={() => { window.location.href = checkoutUrl }} className="inline-flex h-9 w-full items-center justify-center rounded-md bg-teal-500 px-4 py-2 text-sm font-medium text-white shadow transition-colors hover:bg-teal-600">
              Continue cryptocurrency checkout
            </button>
          )}
          <button type="button" onClick={cancelCurrentFlow} disabled={restarting} className="inline-flex h-9 w-full items-center justify-center rounded-md border border-navy-300 bg-transparent px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-navy-100 disabled:cursor-not-allowed disabled:opacity-60">
            {restarting ? 'Cancelling payment...' : 'Cancel and start another invoice'}
          </button>
          {!checkoutUrl && (
            <button type="button" onClick={() => { void loadCurrentFlow() }} className="inline-flex h-9 w-full items-center justify-center rounded-md border border-navy-300 bg-transparent px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-navy-100">
              Check payment status again
            </button>
          )}
        </div>
      )
    }
    return (
      <button type="button" onClick={restartBitcoinCheckout} disabled={restarting} className="inline-flex h-9 w-full items-center justify-center rounded-md bg-teal-500 px-4 py-2 text-sm font-medium text-white shadow transition-colors hover:bg-teal-600 disabled:cursor-not-allowed disabled:opacity-60">
        {restarting ? 'Starting new invoice...' : emailProofRequested ? 'Check your email to continue' : emailOwnershipToken ? 'Start new cryptocurrency invoice' : 'Verify email to start a new invoice'}
      </button>
    )
  }

  if (state === 'vault') {
    return (
      <div className="mx-auto max-w-md space-y-6">
        <div className="flex items-center gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4">
          <Check className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div>
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">Cryptocurrency payment settled</p>
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
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">Cryptocurrency payment settled</p>
            <p className="text-xs text-[rgb(var(--muted))]">One last account step before your vault setup.</p>
          </div>
        </div>
        <StepCreatePaidAccount email={restoredEmail} onNext={handlePaidAccountComplete} />
      </div>
    )
  }

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center space-y-6 text-center">
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
            <p className="mt-1">Open the link in the browser you requested it from, or request a new one below.</p>
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
