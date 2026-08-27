'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import { Crown, Lock, Zap } from 'lucide-react'
import { Button } from '@silentsuite/ui'
import { BILLING_API_URL } from '@/app/lib/config'
import {
  activateAuthenticatedAnnualCheckout,
  fetchAuthenticatedAnnualOffer,
  isRenewableAnnualOfferError,
  startAuthenticatedAnnualPayment,
  type AnnualCheckoutActivation,
  type AnnualOffer,
  type AnnualOfferResponse,
} from '@/app/lib/billing-v2'
import {
  annualOfferAnnualLabel,
  annualOfferMonthlyLabel,
  annualOfferPlanLabel,
  annualOfferRenewalCopy,
  formatAnnualOfferAmount,
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

const CURRENT_FLOW_KINDS = ['stripe_pay_now', 'btcpay_annual'] as const

type CurrentPaymentFlow = {
  flowKind: (typeof CURRENT_FLOW_KINDS)[number]
  createdAt: string
  cancellable: boolean
  checkoutUrl: string | null
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

function disclosureTimestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'Not scheduled'
}

function disclosureRule(value: string): string {
  return value.replaceAll('_', ' ')
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
  if (provider === 'btcpay') return otherProviderAvailable ? 'Cancel Bitcoin payment and choose card' : 'Cancel Bitcoin payment'
  if (provider === 'stripe') return otherProviderAvailable ? 'Cancel card payment and choose Bitcoin' : 'Cancel card payment'
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
        <span>I have not sent Bitcoin for this payment.</span>
      </label>
    </div>
  )
}

function safeBtcpayUrl(rawUrl: string): string {
  const checkoutUrl = resolveBtcpayUrl(rawUrl)
  if (!checkoutUrl) throw new Error('Bitcoin checkout returned an unexpected payment URL.')
  return checkoutUrl
}

export default function PaymentChoicePanel({
  onSuccess,
  onCancel,
  onDismissibilityChange,
  title = 'Continue with silentsuite.io',
  successPoll,
}: PaymentChoicePanelProps) {
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [paymentOffer, setPaymentOffer] = useState<AnnualOffer | null>(null)
  const [bitcoinSession, setBitcoinSession] = useState<BitcoinPaymentSession | null>(null)
  const [currentFlow, setCurrentFlow] = useState<CurrentPaymentFlow | null>(null)
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [options, setOptions] = useState<PaymentOption[]>([])
  const [annualOffer, setAnnualOffer] = useState<AnnualOfferResponse | null>(null)
  const [pendingActivation, setPendingActivation] = useState<{ activation: AnnualCheckoutActivation; provider: 'stripe' | 'btcpay' } | null>(null)
  const [optionsLoaded, setOptionsLoaded] = useState(false)
  const [currentFlowLoaded, setCurrentFlowLoaded] = useState(false)
  const [currentFlowLoadFailed, setCurrentFlowLoadFailed] = useState(false)
  const [offerRefreshFailed, setOfferRefreshFailed] = useState(false)
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

  const loadOptions = useCallback(async (isCancelled: () => boolean = () => false) => {
    setOptionsLoaded(false)
    setAnnualOffer(null)
    setOptions([])
    try {
      const offer = await fetchAuthenticatedAnnualOffer({ fetcher: fetch, billingApiUrl: BILLING_API_URL })
      if (!isCancelled()) {
        applyAnnualOffer(offer)
        setOfferRefreshFailed(false)
      }
    } catch {
      if (!isCancelled()) {
        setAnnualOffer(null)
        setOptions([])
      }
    } finally {
      if (!isCancelled()) setOptionsLoaded(true)
    }
  }, [applyAnnualOffer])

  useEffect(() => {
    let cancelled = false
    void loadOptions(() => cancelled)
    return () => { cancelled = true }
  }, [loadOptions])

  async function renewAnnualOfferAndRequireConsent() {
    // Never reuse a provider selection, card secret, or Bitcoin authority
    // after the signed offer that authorized it was rejected.
    setPendingActivation(null)
    setClientSecret(null)
    setPaymentOffer(null)
    setBitcoinSession(null)
    setOptions([])
    setAnnualOffer(null)
    setOfferRefreshFailed(false)
    try {
      const offer = await fetchAuthenticatedAnnualOffer({ fetcher: fetch, billingApiUrl: BILLING_API_URL })
      applyAnnualOffer(offer)
      setError('The annual terms changed. Review the updated offer and choose a payment method again.')
    } catch {
      // Do not leave expired terms actionable if the fresh server authority is
      // unavailable. The explicit retry is the only way back into payment.
      setOptions([])
      setAnnualOffer(null)
      setOfferRefreshFailed(true)
      setError('The annual terms changed, but the current offer could not be loaded. Retry to review current terms before continuing.')
    } finally {
      setOptionsLoaded(true)
    }
  }

  const stripeOption = useMemo(() => options.find(option => option.id === 'stripe_pay_now' && option.enabled), [options])
  const btcpayAnnualOption = useMemo(() => options.find(option => option.id === 'btcpay_annual' && option.enabled), [options])
  const currentFlowCheckoutUrl = useMemo(() => resolveBtcpayUrl(currentFlow?.checkoutUrl), [currentFlow?.checkoutUrl])
  const stripeAvailable = Boolean(annualOffer && isAnnualOfferProviderAvailable(annualOffer.offer, 'stripe'))
  const btcpayAvailable = Boolean(annualOffer && isAnnualOfferProviderAvailable(annualOffer.offer, 'btcpay', CRYPTO_CHECKOUT_ENABLED))
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
        ? `${currentFlow.flowKind}:${currentFlow.createdAt}`
        : 'none'

  useEffect(() => {
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
    if (!isCancelled()) {
      setCurrentFlowLoaded(false)
      setCurrentFlowLoadFailed(false)
    }
    try {
      const res = await fetch(`${BILLING_API_URL}/subscription/payment-flows/current`, { credentials: 'include' })
      if (!res.ok) throw new Error('Could not verify the current payment flow.')
      const flow = readCurrentPaymentFlow(await res.json())
      if (!isCancelled()) {
        setCurrentFlow(flow)
        setCurrentFlowLoaded(true)
      }
    } catch {
      if (!isCancelled()) {
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
        fetcher: fetch,
        billingApiUrl: BILLING_API_URL,
        provider,
        confirmNoBitcoinSent: bitcoinCancelAcknowledged,
      })
      if (!result.cancelled) {
        // The provider authority survives every refusal, ambiguity and lost
        // response: local panel state is left exactly as it was.
        if (result.failure === 'bitcoin-acknowledgement-required') setBitcoinAcknowledgementProven(true)
        setError(result.message)
        return false
      }
      setCurrentFlow(null)
      setClientSecret(null)
      setPaymentOffer(null)
      setBitcoinSession(null)
      setBitcoinAcknowledgementProven(false)
      // Provider creation stays unavailable continuously from cancellation
      // success until a fresh lookup proves `flow: null`. The re-proof is
      // started in the same commit that releases the authority, so a faster
      // offer refresh can never repopulate the creation controls first.
      const reprovedCurrentFlow = loadCurrentFlow()
      await loadOptions()
      await reprovedCurrentFlow
      return true
    } finally {
      // Each attempt requires its own deliberate acknowledgement.
      setBitcoinCancelAcknowledged(false)
      setLoading(null)
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
      if (cancelled) onCancel?.()
    })
  }

  const startStripe = async () => {
    setLoading('stripe')
    setError(null)
    try {
      if (!annualOffer || !stripeAvailable) throw new Error('Card checkout is not available for this server-owned annual offer.')
      const activation = await activateAuthenticatedAnnualCheckout({
        fetcher: fetch,
        billingApiUrl: BILLING_API_URL,
        offer: annualOffer,
        trialPath: 'immediate',
        provider: 'stripe',
        behavior: 'immediate_card',
      })
      setPendingActivation({ activation, provider: 'stripe' })
    } catch (err) {
      if (isRenewableAnnualOfferError(err)) {
        await renewAnnualOfferAndRequireConsent()
        return
      }
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(null)
    }
  }

  const startBtcpay = async () => {
    setLoading('btcpay')
    setError(null)
    try {
      if (!annualOffer || !btcpayAvailable) throw new Error('Bitcoin checkout is not available for this server-owned annual offer.')
      const activation = await activateAuthenticatedAnnualCheckout({
        fetcher: fetch,
        billingApiUrl: BILLING_API_URL,
        offer: annualOffer,
        trialPath: 'immediate',
        provider: 'btcpay',
        behavior: 'prepaid_bitcoin',
      })
      setPendingActivation({ activation, provider: 'btcpay' })
    } catch (err) {
      if (isRenewableAnnualOfferError(err)) {
        await renewAnnualOfferAndRequireConsent()
        return
      }
      setError(err instanceof Error ? err.message : 'Unable to start Bitcoin checkout.')
    } finally {
      setLoading(null)
    }
  }

  const confirmActivation = async () => {
    const pending = pendingActivation
    if (!pending || !annualOffer) return
    setLoading(pending.provider)
    setError(null)
    try {
      const data = await startAuthenticatedAnnualPayment({
        fetcher: fetch,
        billingApiUrl: BILLING_API_URL,
        checkoutIntentToken: pending.activation.checkoutIntentToken,
        expectedAuthorityId: annualOffer.requestId,
        returnUrl: `${window.location.origin}/settings/subscription`,
      })
      if (data.kind !== pending.provider) throw new Error('Billing returned the wrong payment provider.')
      if (data.kind === 'stripe') {
        setClientSecret(data.clientSecret)
        setPaymentOffer(annualOffer.offer)
        setPendingActivation(null)
        return
      }
      const checkoutUrl = safeBtcpayUrl(data.checkoutUrl)
      if (!data.invoiceId || !data.invoiceLookupToken) throw new Error('Bitcoin checkout did not return a complete payment session.')
      setBitcoinSession({ invoiceId: data.invoiceId, lookupToken: data.invoiceLookupToken, checkoutUrl })
      setPendingActivation(null)
    } catch (err) {
      if (isRenewableAnnualOfferError(err)) {
        await renewAnnualOfferAndRequireConsent()
        return
      }
      setError(err instanceof Error ? err.message : 'Unable to start Bitcoin checkout.')
    } finally {
      setLoading(null)
    }
  }

  if (pendingActivation) {
    const disclosure = pendingActivation.activation.disclosure
    return (
      <div className="space-y-5">
        <h2 className="text-lg font-semibold text-[rgb(var(--foreground))]">Confirm annual terms</h2>
        <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 text-sm text-[rgb(var(--muted))]">
          <p>€{(disclosure.firstChargeAmountMinor / 100).toFixed(2)} today.</p>
          <p>Annual price: €{(disclosure.annualAmountMinor / 100).toFixed(2)}.</p>
          <p>Renewal amount: {disclosure.renewalAmountMinor === null ? 'Not applicable' : `€${(disclosure.renewalAmountMinor / 100).toFixed(2)}`}.</p>
          <p>First charge: {disclosureTimestamp(disclosure.firstChargeAt)}.</p>
          <p>Cancel before: {disclosure.cancelBy ? disclosureTimestamp(disclosure.cancelBy) : 'Not applicable'}{disclosure.cancelByInclusive ? ' (inclusive)' : ''}.</p>
          <p>Renews: {disclosureTimestamp(disclosure.renewalAt)}.</p>
          <p>Access through: {disclosureTimestamp(disclosure.entitlementEndsAt)}.</p>
          <p>Period end rule: {disclosureRule(disclosure.periodEndRule)}.</p>
          <p>{disclosure.refundWindowDays}-day refund window.</p>
          <p>{disclosure.autoRenew ? 'Renews automatically each year.' : 'Does not renew automatically.'}</p>
          <p>{disclosure.prepaid ? 'Prepaid annual access.' : 'Card payment.'}</p>
          <p>{disclosure.bonusDays} bonus days after confirmed payment.</p>
        </div>
        {error && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}
        <Button onClick={() => { void confirmActivation() }} disabled={loading !== null} className="w-full">Confirm annual terms and continue</Button>
        <Button onClick={() => setPendingActivation(null)} disabled={loading !== null} variant="outline" className="w-full">Back to payment options</Button>
      </div>
    )
  }

  if (bitcoinSession && annualOffer && btcpayAvailable) {
    return (
      <BitcoinPaymentPanel
        session={bitcoinSession}
        title={`Pay ${annualOfferAnnualLabel(annualOffer.offer)} annual with Bitcoin`}
        description={`Scan the QR code or copy the payment details to pay ${formatAnnualOfferAmount(annualOffer.offer)} for ${annualOfferPlanLabel(annualOffer.offer)} (${annualOffer.offer.planId}). Your 14 bonus days and paid access apply after settlement confirms.`}
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
          await onSuccess()
          await successPoll?.()
        }}
      />
    )
  }

  if (clientSecret && paymentOffer) {
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
                <span className="text-sm font-medium text-[rgb(var(--foreground))]">{annualOfferPlanLabel(paymentOffer)}</span>
                <p className="text-xs text-[rgb(var(--muted))]">Annual card payment · {paymentOffer.planId}</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-xs text-[rgb(var(--muted))]">Amount due</p>
              <p className="text-sm font-semibold text-[rgb(var(--foreground))]">
                {formatAnnualOfferAmount(paymentOffer)}
              </p>
            </div>
          </div>
          <p className="mt-2 text-xs text-[rgb(var(--muted))]">Pay {annualOfferRenewalCopy(paymentOffer)} today. 14 bonus days are included after payment.</p>
        </div>
        <StripeTrustNote />
        <StripePaymentForm
          clientSecret={clientSecret}
          onSuccess={async () => {
            await onSuccess()
            await successPoll?.()
          }}
          submitLabel={`Pay ${formatAnnualOfferAmount(paymentOffer)}`}
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
    return (
      <div className="space-y-5">
        <h2 className="text-lg font-semibold text-[rgb(var(--foreground))]">Payment already in progress</h2>
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-left">
          <h3 className="font-medium text-[rgb(var(--foreground))]">
            {isBitcoin ? 'Bitcoin invoice in progress' : isStripe ? 'Card payment in progress' : 'Payment in progress'}
          </h3>
          <p className="mt-1 text-sm text-[rgb(var(--muted))]">
            To prevent double payments, only one payment flow can be active at a time. Continue the current payment or cancel it before choosing another method.
          </p>
          {isBitcoin && currentFlowCheckoutUrl && (
            <a href={currentFlowCheckoutUrl} className="mt-3 inline-flex w-full items-center justify-center rounded-md border border-amber-500/30 px-4 py-2 text-sm font-medium text-amber-700 transition-colors hover:bg-amber-500/10 dark:text-amber-200">
              Continue in BTCPay
            </a>
          )}
        </div>
        {error && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}
        {bitcoinAcknowledgementRequired && (
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
          <p className="text-xs text-[rgb(var(--muted))]">This payment is already being confirmed. Please wait for the provider update or contact support.</p>
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
            <h3 className="font-medium text-[rgb(var(--foreground))]">Pay now + 14 bonus days</h3>
            <p className="mt-0.5 text-xs text-[rgb(var(--muted))]">
              {annualOffer
                ? `Choose a server-authorized payment method for ${annualOfferPlanLabel(annualOffer.offer)}.`
                : 'Loading the server-owned annual offer before payment options are shown.'}
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

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </div>
      )}

      {offerRefreshFailed && (
        <Button
          type="button"
          onClick={() => { void renewAnnualOfferAndRequireConsent() }}
          disabled={loading !== null}
          variant="outline"
          className="w-full"
        >
          Retry current annual offer
        </Button>
      )}

      {currentFlowLoaded && btcpayAnnualOption && btcpayAvailable && annualOffer && (
        <Button onClick={startBtcpay} disabled={loading !== null} variant="outline" className="w-full" aria-label={`Pay ${annualOfferAnnualLabel(annualOffer.offer)} with Bitcoin for ${annualOfferPlanLabel(annualOffer.offer)}`}>
          {loading === 'btcpay' ? 'Opening Bitcoin checkout...' : 'Pay annual with Bitcoin'}
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
        <Button onClick={startStripe} disabled={loading !== null} className="w-full" aria-label={`Continue to card payment for ${annualOfferPlanLabel(annualOffer.offer)}, ${annualOfferAnnualLabel(annualOffer.offer)}`}>
          {loading === 'stripe' ? 'Setting up...' : 'Continue to card payment'}
        </Button>
      ) : (
        <p className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-3 text-sm text-[rgb(var(--muted))]">
          Payment options are not available for this account state.
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
