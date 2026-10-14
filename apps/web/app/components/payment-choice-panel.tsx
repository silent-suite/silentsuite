'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { getAccountEpoch } from '@/app/lib/account-epoch'
import { createAuthenticatedPaymentFetch, PaymentSessionRecoveryError } from '@/app/lib/authenticated-payment-fetch'
import { Crown, Lock, Zap } from 'lucide-react'
import { Button } from '@silentsuite/ui'
import { BILLING_API_URL } from '@/app/lib/config'
import {
  AccountTermsUnavailableError,
  activateAuthenticatedAnnualCheckout,
  classifyAnnualOfferLoadFailure,
  fetchAuthenticatedAccountOffer,
  isAnnualOfferAuthenticationError,
  isRenewableAnnualOfferError,
  readFrozenAnnualDisclosure,
  resumeAuthenticatedAnnualPayment,
  startAuthenticatedAnnualPayment,
  type AccountAnnualOffer,
  type AnnualDisclosure,
  type AnnualOffer,
  type AnnualOfferResponse,
} from '@/app/lib/billing-v2'
import {
  annualOfferAnnualLabel,
  annualOfferMonthlyLabel,
  annualOfferPlanLabel,
  annualOfferRenewalCopy,
  annualTermsCopy,
  formatDisclosureAmount,
  isAnnualOfferProviderAvailable,
} from '@/app/lib/annual-offer-presentation'
import {
  BITCOIN_CANCELLATION_WARNING,
  PAYMENT_FLOW_CANCELLATION_MESSAGES,
  cancelPaymentFlow,
  type PaymentFlowCancellationProvider,
} from '@/app/lib/payment-flow-cancellation'
import BitcoinPaymentPanel, { type BitcoinPaymentSession } from './bitcoin-payment-panel'

const CRYPTO_CHECKOUT_ENABLED = process.env.NEXT_PUBLIC_BTCPAY_CHECKOUT_ENABLED === 'true'
const BTCPAY_CHECKOUT_ORIGIN = process.env.NEXT_PUBLIC_BTCPAY_CHECKOUT_ORIGIN ?? 'https://btcpay.silentsuite.io'

const StripePaymentForm = dynamic(() => import('./stripe-payment-form'), {
  loading: () => (
    <div className="flex flex-col items-center justify-center py-8">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
      <p className="mt-3 text-sm text-[rgb(var(--muted))]">Loading payment form...</p>
    </div>
  ),
  ssr: false,
})

type PaymentOption = {
  id: string
  provider: 'stripe' | 'btcpay'
  enabled: boolean
}

const OFFER_REFUSED_MESSAGE = 'Payment options are not available for this account state.'
const OFFER_LOAD_FAILED_MESSAGE = 'The current annual offer could not be loaded. Retry to review current terms before continuing.'
const OFFER_AUTHENTICATION_MESSAGE = 'Billing could not confirm your sign-in. Sign in again to review payment options.'
// The signed account terms could not be shown before the choice, so no
// payment may start until a retry returns them.
const TERMS_UNAVAILABLE_MESSAGE = 'Payment options are temporarily unavailable.'

const CURRENT_FLOW_KINDS = ['stripe_pay_now', 'btcpay_annual'] as const

type CurrentPaymentFlow = {
  flowKind: (typeof CURRENT_FLOW_KINDS)[number]
  createdAt: string
  cancellable: boolean
  checkoutUrl: string | null
  /** The server's own flow status; only `provider_confirmed` evidences confirmation. */
  status: string | null
  /** Present only when Billing names the authority; binds cancellation to it. */
  authorityId: string | null
  /** The flow's own frozen signed terms; never the latest offer. */
  disclosure: AnnualDisclosure | null
}

interface PaymentChoicePanelProps {
  onSuccess: () => void | Promise<void>
  onCancel?: () => void
  onDismissibilityChange?: (dismissible: boolean) => void
  title?: string
  successPoll?: () => void | Promise<void>
}
function PriceDisplay({ offer }: { offer: AnnualOffer }) {
  return (
    <span className="text-sm font-medium text-[rgb(var(--foreground))]">
      {annualOfferAnnualLabel(offer)}
      <span className="ml-1 text-xs text-emerald-600 dark:text-emerald-500">({annualOfferMonthlyLabel(offer)}, billed annually)</span>
    </span>
  )
}

function StripeTrustNote() {
  return (
    <div className="space-y-1.5 text-center text-xs text-[rgb(var(--muted))]">
      <p className="font-medium text-[rgb(var(--foreground))]">Powered by Stripe</p>
      <div className="flex items-center justify-center gap-1.5">
        <Lock className="h-3 w-3 text-emerald-500" />
        <span>Secured by Stripe. We never see your card details.</span>
      </div>
    </div>
  )
}

/**
 * Resolve an untrusted checkout URL to the configured BTCPay origin, or null.
 * Billing responses are not a render-time trust boundary: an unparseable or
 * unauthorized URL must hide the continuation link, never abort the render of
 * the surrounding payment flow.
 */
function resolveBtcpayUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string' || rawUrl === '') return null
  let checkoutUrl: URL
  try {
    checkoutUrl = new URL(rawUrl)
  } catch {
    return null
  }
  if (checkoutUrl.protocol !== 'https:' || checkoutUrl.origin !== BTCPAY_CHECKOUT_ORIGIN) return null
  return checkoutUrl.toString()
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A 2xx reply is authoritative only when the body itself states the outcome.
 * Provider creation is released solely by an own, literal `flow: null`; a
 * present flow must carry the smallest fields this panel depends on: the kind
 * that identifies the provider authority, the creation timestamp that binds a
 * Bitcoin acknowledgement to it, and the cancellable state that gates its
 * cancel control. Anything else is malformed and throws, so the caller fails
 * closed on its retry path instead of treating an unreadable success as proof
 * that no payment exists. The thrown reason is never rendered: server detail,
 * identifiers and checkout URLs stay out of the error surface.
 */
function readCurrentPaymentFlow(data: unknown): CurrentPaymentFlow | null {
  const malformed = () => new Error('The current payment flow reply could not be read.')
  if (!isPlainObject(data) || !Object.prototype.hasOwnProperty.call(data, 'flow')) throw malformed()
  const flow = data.flow
  if (flow === null) return null
  if (!isPlainObject(flow)) throw malformed()
  const flowKind = CURRENT_FLOW_KINDS.find((kind) => kind === flow.flowKind)
  if (!flowKind) throw malformed()
  if (typeof flow.cancellable !== 'boolean') throw malformed()
  if (typeof flow.createdAt !== 'string' || flow.createdAt === '') throw malformed()
  return {
    flowKind,
    createdAt: flow.createdAt,
    cancellable: flow.cancellable,
    checkoutUrl: typeof flow.checkoutUrl === 'string' ? flow.checkoutUrl : null,
    status: typeof flow.status === 'string' ? flow.status : null,
    authorityId: typeof flow.authorityId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(flow.authorityId) ? flow.authorityId : null,
    disclosure: readFrozenAnnualDisclosure(flow.disclosure),
  }
}

/**
 * Cancellation is provider-bound: a BTCPay authority can settle out-of-band, so
 * the client must know which provider it is releasing before it decides whether
 * a local Bitcoin acknowledgement is required.
 */
function cancellationProviderOf(flowKind: string | null | undefined): PaymentFlowCancellationProvider {
  if (flowKind === 'btcpay_annual') return 'btcpay'
  if (flowKind === 'stripe_pay_now') return 'stripe'
  return 'unknown'
}

/**
 * Every cancellation control states the consequence it performs. Where the
 * current server offer does not expose the other provider, the label stops at
 * the cancellation instead of promising a method the user cannot then choose.
 */
function cancellationActionLabel(provider: PaymentFlowCancellationProvider, otherProviderAvailable: boolean): string {
  if (provider === 'btcpay') return otherProviderAvailable ? 'Cancel cryptocurrency payment and choose card' : 'Cancel cryptocurrency payment'
  if (provider === 'stripe') return otherProviderAvailable ? 'Cancel card payment and choose cryptocurrency' : 'Cancel card payment'
  return 'Cancel payment'
}

function BitcoinCancellationAcknowledgement({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-left">
      <p className="text-xs text-amber-700 dark:text-amber-200">{BITCOIN_CANCELLATION_WARNING}</p>
      <label className="flex items-start gap-2 text-xs text-[rgb(var(--foreground))]">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0"
        />
        <span>I have not sent cryptocurrency for this payment.</span>
      </label>
    </div>
  )
}

function safeBtcpayUrl(rawUrl: string): string {
  const checkoutUrl = resolveBtcpayUrl(rawUrl)
  if (!checkoutUrl) throw new Error('Cryptocurrency checkout returned an unexpected payment URL.')
  return checkoutUrl
}

export default function PaymentChoicePanel({
  onSuccess,
  onCancel,
  onDismissibilityChange,
  title = 'Continue with silentsuite.io',
  successPoll,
}: PaymentChoicePanelProps) {
  const accountId = useAuthStore(state => state.user?.id ?? null)
  const owner = useRef({ accountId, epoch: getAccountEpoch() })
  const live = useRef(true)
  const accountCurrent = () => live.current && owner.current.accountId === (useAuthStore.getState().user?.id ?? null)
    && owner.current.epoch === getAccountEpoch()
  const [sessionRecovery, setSessionRecovery] = useState<PaymentSessionRecoveryError | null>(null)
  const paymentFetch = useMemo(() => {
    const authenticated = createAuthenticatedPaymentFetch(owner.current.accountId, owner.current.epoch)
    return async (input: RequestInfo | URL, init?: RequestInit) => {
      try { return await authenticated(input, init) }
      catch (error) {
        if (live.current && error instanceof PaymentSessionRecoveryError && (accountCurrent() || useAuthStore.getState().user === null)) setSessionRecovery(error)
        throw error
      }
    }
  }, [])
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  // Plan labels only for a capability this panel just created from that offer;
  // a resumed authority has no trusted plan label, only its frozen terms.
  const [paymentPlan, setPaymentPlan] = useState<AnnualOffer | null>(null)
  // Authority Billing returned with the displayed card secret or invoice.
  const [paymentAuthorityId, setPaymentAuthorityId] = useState<string | null>(null)
  const [bitcoinSession, setBitcoinSession] = useState<BitcoinPaymentSession | null>(null)
  const [currentFlow, setCurrentFlow] = useState<CurrentPaymentFlow | null>(null)
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [options, setOptions] = useState<PaymentOption[]>([])
  const [annualOffer, setAnnualOffer] = useState<AnnualOfferResponse | null>(null)
  // Signed account terms per provider, shown before the choice and required to start.
  const [accountDisclosures, setAccountDisclosures] = useState<AccountAnnualOffer['accountDisclosures']>(null)
  const [paymentDisclosure, setPaymentDisclosure] = useState<AnnualDisclosure | null>(null)
  const [termsUnavailable, setTermsUnavailable] = useState(false)
  const [optionsLoaded, setOptionsLoaded] = useState(false)
  const [currentFlowLoaded, setCurrentFlowLoaded] = useState(false)
  const [currentFlowLoadFailed, setCurrentFlowLoadFailed] = useState(false)
  const [offerRefreshFailed, setOfferRefreshFailed] = useState(false)
  const [initialOfferFailed, setInitialOfferFailed] = useState(false)
  // Billing rejected the offer request's authentication, not the account.
  const [offerAuthFailed, setOfferAuthFailed] = useState(false)
  const offerRequestSequence = useRef(0)
  const offerMounted = useRef(false)
  useEffect(() => {
    offerMounted.current = true
    return () => { offerMounted.current = false; offerRequestSequence.current++ }
  }, [])
  const [bitcoinCancelAcknowledged, setBitcoinCancelAcknowledged] = useState(false)
  // Set when the authoritative endpoint proves a Bitcoin authority the local
  // state could not identify, so the acknowledgement can be offered truthfully.
  const [bitcoinAcknowledgementProven, setBitcoinAcknowledgementProven] = useState(false)

  const applyAnnualOffer = useCallback((offer: AnnualOfferResponse) => {
    setAnnualOffer(offer)
    setOptions(offer.offer.providers
      .filter((provider) => isAnnualOfferProviderAvailable(offer.offer, provider, provider === 'btcpay' ? CRYPTO_CHECKOUT_ENABLED : true))
      .map((provider) => ({
        id: provider === 'stripe' ? 'stripe_pay_now' : 'btcpay_annual',
        provider,
        enabled: true,
      })))
  }, [])

  // Without valid signed terms for every offered provider nothing is choosable.
  const applyAccountOffer = useCallback((account: AccountAnnualOffer): boolean => {
    if (!account.accountDisclosures) {
      setAnnualOffer(null)
      setOptions([])
      setAccountDisclosures(null)
      setTermsUnavailable(true)
      return false
    }
    applyAnnualOffer(account.offer)
    setAccountDisclosures(account.accountDisclosures)
    setTermsUnavailable(false)
    return true
  }, [applyAnnualOffer])

  const loadOptions = useCallback(async (isCancelled: () => boolean = () => false) => {
    const sequence = ++offerRequestSequence.current
    const current = () => accountCurrent() && offerMounted.current && sequence === offerRequestSequence.current && !isCancelled()
    setOptionsLoaded(false)
    setAnnualOffer(null)
    setOptions([])
    setAccountDisclosures(null)
    setTermsUnavailable(false)
    setOfferAuthFailed(false)
    try {
      const offer = await fetchAuthenticatedAccountOffer({ fetcher: paymentFetch, billingApiUrl: BILLING_API_URL })
      if (current()) {
        applyAccountOffer(offer)
        setOfferRefreshFailed(false)
        setInitialOfferFailed(false)
        setSessionRecovery(null)
      }
    } catch (error) {
      if (current()) {
        setAnnualOffer(null)
        setOptions([])
        setInitialOfferFailed(classifyAnnualOfferLoadFailure(error) === 'transient' || (error instanceof PaymentSessionRecoveryError && !error.signInRequired))
        setOfferAuthFailed(isAnnualOfferAuthenticationError(error))
      }
    } finally {
      if (current()) setOptionsLoaded(true)
    }
  }, [applyAccountOffer, paymentFetch])

  useEffect(() => {
    let cancelled = false
    void loadOptions(() => cancelled)
    return () => { cancelled = true }
  }, [loadOptions])

  async function renewAnnualOfferAndRequireConsent() {
    const sequence = ++offerRequestSequence.current
    const current = () => accountCurrent() && offerMounted.current && sequence === offerRequestSequence.current
    // Never reuse a provider selection, card secret, or Bitcoin authority
    // after the signed offer that authorized it was rejected.
    setClientSecret(null)
    setPaymentPlan(null)
    setPaymentDisclosure(null)
    setBitcoinSession(null)
    setOptions([])
    setAnnualOffer(null)
    setAccountDisclosures(null)
    setOfferRefreshFailed(false)
    setOfferAuthFailed(false)
    try {
      const offer = await fetchAuthenticatedAccountOffer({ fetcher: paymentFetch, billingApiUrl: BILLING_API_URL })
      if (!current()) return
      if (!applyAccountOffer(offer)) return
      setError('The annual terms changed. Review the updated offer and choose a payment method again.')
    } catch (error) {
      if (!current()) return
      // Do not leave expired terms actionable if the fresh server authority is
      // unavailable. The explicit retry is the only way back into payment.
      setOptions([])
      setAnnualOffer(null)
      const transient = classifyAnnualOfferLoadFailure(error) === 'transient'
      const authFailed = isAnnualOfferAuthenticationError(error)
      setOfferRefreshFailed(transient)
      setInitialOfferFailed(false)
      setOfferAuthFailed(authFailed)
      setError(authFailed ? OFFER_AUTHENTICATION_MESSAGE
        : transient ? 'The annual terms changed, but the current offer could not be loaded. Retry to review current terms before continuing.'
        : OFFER_REFUSED_MESSAGE)
    } finally {
      if (current()) setOptionsLoaded(true)
    }
  }

  // One message for the description and the action slot, so neither can
  // report a refused account while the other reports sign-in or a retry.
  const offerUnavailableMessage = offerAuthFailed ? OFFER_AUTHENTICATION_MESSAGE
    : termsUnavailable ? TERMS_UNAVAILABLE_MESSAGE
    : initialOfferFailed || offerRefreshFailed ? OFFER_LOAD_FAILED_MESSAGE
    : OFFER_REFUSED_MESSAGE
  const stripeOption = useMemo(() => options.find(option => option.id === 'stripe_pay_now' && option.enabled), [options])
  const btcpayAnnualOption = useMemo(() => options.find(option => option.id === 'btcpay_annual' && option.enabled), [options])
  const currentFlowCheckoutUrl = useMemo(() => resolveBtcpayUrl(currentFlow?.checkoutUrl), [currentFlow?.checkoutUrl])
  const stripeAvailable = Boolean(annualOffer && isAnnualOfferProviderAvailable(annualOffer.offer, 'stripe'))
  const btcpayAvailable = Boolean(annualOffer && isAnnualOfferProviderAvailable(annualOffer.offer, 'btcpay', CRYPTO_CHECKOUT_ENABLED))
  // Every cancel/back/switch names exactly the authority on screen: the one
  // returned with a displayed capability, else the one /current named.
  const displayedAuthorityId = bitcoinSession || clientSecret ? paymentAuthorityId : currentFlow?.authorityId ?? null
  const cancellationProvider: PaymentFlowCancellationProvider = bitcoinSession
    ? 'btcpay'
    : clientSecret
      ? 'stripe'
      : cancellationProviderOf(currentFlow?.flowKind)
  const otherProviderAvailable = cancellationProvider === 'btcpay'
    ? stripeAvailable
    : cancellationProvider === 'stripe'
      ? btcpayAvailable
      : false
  const cancellationLabel = cancellationActionLabel(cancellationProvider, otherProviderAvailable)
  const bitcoinAcknowledgementRequired = cancellationProvider === 'btcpay' || bitcoinAcknowledgementProven
  const cancellationBlocked = bitcoinAcknowledgementRequired && !bitcoinCancelAcknowledged
  const cancellationDisabled = loading !== null || cancellationBlocked
  // Identity of the provider authority currently on screen. A different
  // authority must never inherit a previous acknowledgement.
  const activeFlowKey = bitcoinSession
    ? `btcpay:${bitcoinSession.invoiceId}`
    : clientSecret
      ? 'stripe:inline'
      : currentFlow
        ? `${currentFlow.flowKind}:${currentFlow.authorityId ?? 'unnamed'}:${currentFlow.createdAt}`
        : 'none'

  // Reset before the browser can accept input for the new authority. A passive
  // effect can run after an immediate acknowledgement click and erase it.
  useLayoutEffect(() => {
    setBitcoinCancelAcknowledged(false)
    setBitcoinAcknowledgementProven(false)
  }, [activeFlowKey])

  const implicitDismissible = currentFlowLoaded
    && !currentFlowLoadFailed
    && !currentFlow
    && !clientSecret
    && !bitcoinSession
    && loading === null

  async function loadCurrentFlow(isCancelled: () => boolean = () => false) {
    if (accountCurrent() && !isCancelled()) {
      setCurrentFlowLoaded(false)
      setCurrentFlowLoadFailed(false)
    }
    try {
      const res = await paymentFetch(`${BILLING_API_URL}/subscription/payment-flows/current?preview=1`, { credentials: 'include' })
      if (!res.ok) throw new Error('Could not verify the current payment flow.')
      const flow = readCurrentPaymentFlow(await res.json())
      if (accountCurrent() && !isCancelled()) {
        setCurrentFlow(flow)
        setCurrentFlowLoaded(true)
      }
    } catch {
      if (accountCurrent() && !isCancelled()) {
        setCurrentFlowLoadFailed(true)
        setError('Could not verify whether a payment is already in progress. Retry before starting another payment.')
      }
    }
  }

  useEffect(() => {
    let cancelled = false
    void loadCurrentFlow(() => cancelled)
    return () => { cancelled = true }
  }, [])

  // An implicit modal dismissal must never make an active provider authority
  // disappear from view. Once Billing has confirmed there is no current flow,
  // closing the chooser is safe; otherwise the explicit Cancel control owns
  // the provider cancellation path.
  useLayoutEffect(() => {
    onDismissibilityChange?.(implicitDismissible)
  }, [implicitDismissible, onDismissibilityChange])

  const cancelCurrentFlow = async (provider: PaymentFlowCancellationProvider = cancellationProvider): Promise<boolean> => {
    // A Bitcoin authority is never released without a local acknowledgement,
    // even if a control were somehow actioned while blocked.
    if (provider === 'btcpay' && !bitcoinCancelAcknowledged) {
      setBitcoinAcknowledgementProven(true)
      setError(PAYMENT_FLOW_CANCELLATION_MESSAGES['bitcoin-acknowledgement-required'])
      return false
    }
    setLoading('cancel-flow')
    setError(null)
    try {
      const result = await cancelPaymentFlow({
        fetcher: paymentFetch,
        billingApiUrl: BILLING_API_URL,
        provider,
        confirmNoBitcoinSent: bitcoinCancelAcknowledged,
        expectedAuthorityId: displayedAuthorityId ?? undefined,
      })
      if (!accountCurrent()) return false
      if (!result.cancelled) {
        // The provider authority survives every refusal, ambiguity and lost
        // response: local panel state is left exactly as it was.
        if (result.failure === 'bitcoin-acknowledgement-required') setBitcoinAcknowledgementProven(true)
        setError(result.message)
        return false
      }
      setCurrentFlow(null)
      setClientSecret(null)
      setPaymentPlan(null)
      setPaymentAuthorityId(null)
      setPaymentDisclosure(null)
      setBitcoinSession(null)
      setBitcoinAcknowledgementProven(false)
      // Provider creation stays unavailable continuously from cancellation
      // success until a fresh lookup proves `flow: null`. The re-proof is
      // started in the same commit that releases the authority, so a faster
      // offer refresh can never repopulate the creation controls first.
      const reprovedCurrentFlow = loadCurrentFlow()
      await loadOptions()
      await reprovedCurrentFlow
      return accountCurrent()
    } finally {
      // Each attempt requires its own deliberate acknowledgement.
      if (accountCurrent()) { setBitcoinCancelAcknowledged(false); setLoading(null) }
    }
  }

  const handleExplicitCancel = () => {
    // Parent dismissal is safe only after Billing has conclusively verified
    // that there is no provider authority. Unknown and failed verification
    // states must be resolved by the authoritative cancellation endpoint.
    if (implicitDismissible) {
      onCancel?.()
      return
    }

    void cancelCurrentFlow().then((cancelled) => {
      if (cancelled && accountCurrent()) onCancel?.()
    })
  }

  const markTermsUnavailable = () => {
    setAnnualOffer(null)
    setOptions([])
    setAccountDisclosures(null)
    setTermsUnavailable(true)
  }

  // The signed terms were shown before the choice, so a choice
  // goes straight to the provider. Payment starts only when activation signed
  // exactly those terms; anything else stops before provider creation.
  const startPayment = async (provider: 'stripe' | 'btcpay') => {
    setLoading(provider)
    setError(null)
    try {
      const available = provider === 'stripe' ? stripeAvailable : btcpayAvailable
      if (!annualOffer || !available) {
        throw new Error(provider === 'stripe' ? 'Card checkout is not available for this server-owned annual offer.' : 'Cryptocurrency checkout is not available for this server-owned annual offer.')
      }
      const terms = accountDisclosures?.[provider]
      if (!terms) {
        markTermsUnavailable()
        return
      }
      const activation = await activateAuthenticatedAnnualCheckout({
        fetcher: paymentFetch,
        billingApiUrl: BILLING_API_URL,
        offer: annualOffer,
        trialPath: 'immediate',
        provider,
        behavior: provider === 'stripe' ? 'immediate_card' : 'prepaid_bitcoin',
        accountTerms: terms,
      })
      if (!accountCurrent()) return
      const data = await startAuthenticatedAnnualPayment({
        fetcher: paymentFetch,
        billingApiUrl: BILLING_API_URL,
        checkoutIntentToken: activation.checkoutIntentToken,
        returnUrl: `${window.location.origin}/settings/subscription`,
      })
      if (!accountCurrent()) return
      if (data.kind !== provider) throw new Error('Billing returned the wrong payment provider.')
      if (data.kind === 'stripe') {
        setClientSecret(data.clientSecret)
        setPaymentAuthorityId(data.authorityId)
        setPaymentPlan(annualOffer.offer)
        setPaymentDisclosure(terms)
        return
      }
      const checkoutUrl = safeBtcpayUrl(data.checkoutUrl)
      if (!data.invoiceId || !data.invoiceLookupToken) throw new Error('Cryptocurrency checkout did not return a complete payment session.')
      setBitcoinSession({ invoiceId: data.invoiceId, lookupToken: data.invoiceLookupToken, checkoutUrl })
      setPaymentAuthorityId(data.authorityId)
      setPaymentPlan(annualOffer.offer)
      setPaymentDisclosure(terms)
    } catch (err) {
      if (!accountCurrent()) return
      if (err instanceof AccountTermsUnavailableError) {
        markTermsUnavailable()
        return
      }
      if (isRenewableAnnualOfferError(err)) {
        await renewAnnualOfferAndRequireConsent()
        return
      }
      setError(err instanceof Error ? err.message : provider === 'stripe' ? 'Something went wrong' : 'Unable to start cryptocurrency checkout.')
      // A failed start may still have claimed an authority. Re-read it so the
      // same authority is resumable or cancellable, never silently replaced.
      await loadCurrentFlow()
    } finally {
      if (accountCurrent()) setLoading(null)
    }
  }

  // Resumes exactly the owned authority Billing named; never a new activation.
  // Independent of today's offer: amounts and terms come only from the
  // authority's own frozen disclosure.
  const resumeCurrentFlow = async () => {
    const flow = currentFlow
    if (!flow?.authorityId) return
    setLoading('resume')
    setError(null)
    try {
      const resumed = await resumeAuthenticatedAnnualPayment({ fetcher: paymentFetch, billingApiUrl: BILLING_API_URL, authorityId: flow.authorityId })
      if (!accountCurrent()) return
      if (resumed.kind !== (flow.flowKind === 'btcpay_annual' ? 'btcpay' : 'stripe')) throw new Error('Billing returned the wrong payment provider.')
      if (resumed.kind === 'stripe') {
        setClientSecret(resumed.clientSecret)
        setPaymentAuthorityId(resumed.authorityId)
        setPaymentPlan(null)
        setPaymentDisclosure(resumed.disclosure)
        return
      }
      if (!CRYPTO_CHECKOUT_ENABLED) throw new Error('Cryptocurrency checkout is not available.')
      const checkoutUrl = safeBtcpayUrl(resumed.checkoutUrl)
      setBitcoinSession({ invoiceId: resumed.invoiceId, lookupToken: resumed.invoiceLookupToken, checkoutUrl })
      setPaymentAuthorityId(resumed.authorityId)
      setPaymentPlan(null)
      setPaymentDisclosure(resumed.disclosure)
    } catch (err) {
      if (!accountCurrent()) return
      setError(err instanceof Error ? err.message : 'Unable to resume the current payment.')
    } finally {
      if (accountCurrent()) setLoading(null)
    }
  }

  const startStripe = () => { void startPayment('stripe') }
  const startBtcpay = () => { void startPayment('btcpay') }

  const signIn = <Link href="/login?reason=billing&returnTo=%2Fsettings%2Fsubscription">Sign in again</Link>
  if (!accountCurrent()) return <div>Payment account changed. Reopen subscription settings.{accountId === null && signIn}</div>
  if (sessionRecovery?.signInRequired) return <div><p>{sessionRecovery.message}</p>{signIn}</div>
  const retrySession = sessionRecovery && <Button onClick={() => { void loadOptions() }} disabled={loading !== null}>Retry current annual offer</Button>

  if (bitcoinSession && paymentDisclosure && CRYPTO_CHECKOUT_ENABLED) {
    return (
      <BitcoinPaymentPanel
        session={bitcoinSession}
        title={`Pay ${formatDisclosureAmount(paymentDisclosure)}/year annual with Bitcoin, Lightning and Monero`}
        description={`Scan the QR code or copy the payment details to pay ${formatDisclosureAmount(paymentDisclosure)} for ${paymentPlan ? `${annualOfferPlanLabel(paymentPlan)} (${paymentPlan.planId})` : 'this annual payment'}. ${annualTermsCopy(paymentDisclosure)}`}
        settledMessage="Payment settled. Refreshing your subscription..."
        backLabel={loading === 'cancel-flow' ? 'Cancelling payment flow...' : cancellationLabel}
        backDisabled={cancellationDisabled}
        backHint={(
          <div className="space-y-3">
            <BitcoinCancellationAcknowledgement
              checked={bitcoinCancelAcknowledged}
              disabled={loading !== null}
              onChange={setBitcoinCancelAcknowledged}
            />
            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              </div>
            )}
          </div>
        )}
        onBack={() => { void cancelCurrentFlow('btcpay') }}
        onPaymentComplete={async () => {
          if (!accountCurrent()) return
          await onSuccess()
          if (accountCurrent()) await successPoll?.()
        }}
      />
    )
  }

  if (clientSecret && paymentDisclosure) {
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => { void cancelCurrentFlow('stripe') }}
          disabled={cancellationDisabled}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-[rgb(var(--muted))] transition-colors hover:text-[rgb(var(--foreground))] disabled:opacity-50"
        >
          {loading === 'cancel-flow' ? 'Cancelling payment flow...' : cancellationLabel}
        </button>

        <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Crown className="h-4 w-4 text-amber-400" />
              <div>
                <span className="text-sm font-medium text-[rgb(var(--foreground))]">{paymentPlan ? annualOfferPlanLabel(paymentPlan) : 'Annual payment'}</span>
                <p className="text-xs text-[rgb(var(--muted))]">{paymentPlan ? `Annual card payment · ${paymentPlan.planId}` : 'Annual card payment'}</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-xs text-[rgb(var(--muted))]">Amount due</p>
              <p className="text-sm font-semibold text-[rgb(var(--foreground))]">
                {formatDisclosureAmount(paymentDisclosure)}
              </p>
            </div>
          </div>
          <p className="mt-2 text-xs text-[rgb(var(--muted))]">{annualTermsCopy(paymentDisclosure)}</p>
        </div>
        <StripeTrustNote />
        <StripePaymentForm
          clientSecret={clientSecret}
          onSuccess={async () => {
            if (!accountCurrent()) return
            await onSuccess()
            if (accountCurrent()) await successPoll?.()
          }}
          submitLabel={`Pay ${formatDisclosureAmount(paymentDisclosure)}`}
          mode="payment"
          returnPath="/settings/subscription"
        />
        {error && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}
        <button
          onClick={() => { void cancelCurrentFlow('stripe') }}
          disabled={cancellationDisabled}
          className="w-full text-center text-xs text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors disabled:opacity-50"
        >
          {loading === 'cancel-flow' ? 'Cancelling payment flow...' : cancellationLabel}
        </button>
      </div>
    )
  }

  if (currentFlow) {
    const isBitcoin = currentFlow.flowKind === 'btcpay_annual' && btcpayAvailable
    const isStripe = currentFlow.flowKind === 'stripe_pay_now' && stripeAvailable
    // Recovery of an owned authority does not depend on today's offer; only
    // the global crypto switch (and the BTCPay origin check) still applies.
    const recoverBitcoin = currentFlow.flowKind === 'btcpay_annual' && CRYPTO_CHECKOUT_ENABLED
    const recoverStripe = currentFlow.flowKind === 'stripe_pay_now'
    // An incomplete, non-cancellable Bitcoin authority with no trusted invoice
    // continuation proves nothing payable: only its current status is re-read.
    const unprovenBitcoin = recoverBitcoin && !currentFlow.cancellable && !currentFlowCheckoutUrl
      && currentFlow.status !== 'provider_confirmed'
    // A confirmed or conflicted authority is held: no payment continuation
    // (resume or direct invoice link) is offered, only its current status.
    const heldOutcome = currentFlow.status === 'provider_confirmed' || currentFlow.status === 'provider_creation_conflict'
    const statusOnly = heldOutcome || unprovenBitcoin || (!currentFlow.cancellable && recoverBitcoin)
    return (
      <div className="space-y-5">
        <h2 className="text-lg font-semibold text-[rgb(var(--foreground))]">Payment already in progress</h2>
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-left">
          <h3 className="font-medium text-[rgb(var(--foreground))]">
            {isBitcoin ? 'Cryptocurrency invoice in progress' : isStripe ? 'Card payment in progress' : 'Payment in progress'}
          </h3>
          <p className="mt-1 text-sm text-[rgb(var(--muted))]">
            To prevent double payments, only one payment flow can be active at a time. Continue the current payment or cancel it before choosing another method.
          </p>
          {currentFlow.disclosure && (
            <p className="mt-2 text-sm text-[rgb(var(--muted))]">{annualTermsCopy(currentFlow.disclosure)}</p>
          )}
        </div>
        {error && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}
        {statusOnly ? (
          <Button onClick={() => { void loadCurrentFlow() }} disabled={loading !== null} className="w-full">
            Check payment status
          </Button>
        ) : currentFlow.authorityId && currentFlow.disclosure && (recoverStripe || recoverBitcoin) && (
          <Button onClick={() => { void resumeCurrentFlow() }} disabled={loading !== null} className="w-full">
            {loading === 'resume' ? 'Resuming payment...' : recoverStripe ? 'Resume card payment' : 'Resume cryptocurrency payment'}
          </Button>
        )}
        {statusOnly && !heldOutcome && currentFlow.authorityId && currentFlow.disclosure && (recoverStripe || recoverBitcoin) && (
          <Button onClick={() => { void resumeCurrentFlow() }} disabled={loading !== null} className="w-full">
            {loading === 'resume' ? 'Recovering payment...' : 'Recover existing payment'}
          </Button>
        )}
        {retrySession}
        {bitcoinAcknowledgementRequired && currentFlow.cancellable && (
          <BitcoinCancellationAcknowledgement
            checked={bitcoinCancelAcknowledged}
            disabled={loading !== null || !currentFlow.cancellable}
            onChange={setBitcoinCancelAcknowledged}
          />
        )}
        <Button onClick={() => { void cancelCurrentFlow() }} disabled={cancellationDisabled || !currentFlow.cancellable} variant="outline" className="w-full">
          {loading === 'cancel-flow' ? 'Cancelling payment flow...' : cancellationLabel}
        </Button>
        {!currentFlow.cancellable && (
          <p className="text-xs text-[rgb(var(--muted))]">
            {currentFlow.status === 'provider_confirmed'
              ? 'This payment is already being confirmed. Please wait for the provider update or contact support.'
              : 'This payment is incomplete and its recovery is currently blocked. Retry this same payment later, and contact support if it keeps failing.'}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold text-[rgb(var(--foreground))]">{title}</h2>
      <div className="rounded-xl border border-emerald-500/50 bg-emerald-500/5 p-4 text-left">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-[rgb(var(--border))] p-2 shrink-0">
            <Zap className="h-4 w-4 text-amber-400" />
          </div>
          <div>
            <h3 className="font-medium text-[rgb(var(--foreground))]">Pay now</h3>
            <p className="mt-0.5 text-xs text-[rgb(var(--muted))]">
              {annualOffer
                ? `Choose a server-authorized payment method for ${annualOfferPlanLabel(annualOffer.offer)}.`
                : !optionsLoaded ? 'Loading the server-owned annual offer before payment options are shown.'
                : offerUnavailableMessage}
            </p>
          </div>
        </div>
      </div>

      {annualOffer && (
        <div className="flex items-center justify-end" data-plan-id={annualOffer.offer.planId}>
          <div className="flex items-center gap-2">
            <Crown className="h-3.5 w-3.5 text-amber-400" />
            <span className="sr-only">{annualOfferPlanLabel(annualOffer.offer)} ({annualOffer.offer.planId})</span>
            <PriceDisplay offer={annualOffer.offer} />
          </div>
        </div>
      )}

      {annualOffer && accountDisclosures && (
        <div className="space-y-2 text-xs text-[rgb(var(--muted))]">
          {stripeAvailable && accountDisclosures.stripe && <p>{annualTermsCopy(accountDisclosures.stripe)}</p>}
          {btcpayAvailable && accountDisclosures.btcpay && <p>{annualTermsCopy(accountDisclosures.btcpay)}</p>}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </div>
      )}

      {(offerRefreshFailed || initialOfferFailed || termsUnavailable) && (
        <Button
          type="button"
          onClick={() => { if (initialOfferFailed || termsUnavailable) void loadOptions(); else void renewAnnualOfferAndRequireConsent() }}
          disabled={loading !== null}
          variant="outline"
          className="w-full"
        >
          Retry current annual offer
        </Button>
      )}

      {currentFlowLoaded && btcpayAnnualOption && btcpayAvailable && annualOffer && (
        <Button onClick={startBtcpay} disabled={loading !== null} variant="outline" className="w-full" aria-label={`Pay ${annualOfferAnnualLabel(annualOffer.offer)} with Bitcoin, Lightning and Monero for ${annualOfferPlanLabel(annualOffer.offer)}`}>
          {loading === 'btcpay' ? 'Opening cryptocurrency checkout...' : 'Bitcoin, Lightning and Monero'}
        </Button>
      )}

      {!currentFlowLoaded ? (
        <Button
          disabled={!currentFlowLoadFailed || loading !== null}
          onClick={() => { void loadCurrentFlow() }}
          variant="outline"
          className="w-full"
        >
          {currentFlowLoadFailed ? 'Retry payment status' : 'Checking current payment...'}
        </Button>
      ) : !optionsLoaded ? (
        <Button disabled className="w-full">
          Loading payment options...
        </Button>
      ) : stripeOption && stripeAvailable && annualOffer ? (
        <Button onClick={startStripe} disabled={loading !== null} className="w-full" aria-label={`Continue to card payment for ${annualOfferPlanLabel(annualOffer.offer)}, ${annualOfferRenewalCopy(annualOffer.offer)}`}>
          {loading === 'stripe' ? 'Setting up...' : 'Continue to card payment'}
        </Button>
      ) : termsUnavailable ? null : (
        <p className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-3 text-sm text-[rgb(var(--muted))]">
          {offerUnavailableMessage}
        </p>
      )}

      {onCancel && (
        <>
          {bitcoinAcknowledgementRequired && (
            <BitcoinCancellationAcknowledgement
              checked={bitcoinCancelAcknowledged}
              disabled={loading !== null}
              onChange={setBitcoinCancelAcknowledged}
            />
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleExplicitCancel}
            disabled={cancellationDisabled || (!currentFlowLoaded && !currentFlowLoadFailed)}
            className="w-full"
          >
            {loading === 'cancel-flow'
              ? 'Cancelling payment flow...'
              : !currentFlowLoaded && !currentFlowLoadFailed
                ? 'Checking current payment...'
                : implicitDismissible
                  ? 'Cancel'
                  : 'Cancel any payment in progress and close'}
          </Button>
        </>
      )}
    </div>
  )
}
