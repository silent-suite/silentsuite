'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import Link from 'next/link'
import { Button } from '@silentsuite/ui'
import { BILLING_API_URL } from '@/app/lib/config'
import { formatDate as formatDateUtil } from '@/app/lib/date'
import { getAccountEpoch, isCurrentAccountEpoch } from '@/app/lib/account-epoch'
import { parseAccountNotice, parseBillingDate, type BillingDate } from '@/app/lib/account-notice'
import { fetchAuthenticatedAccountOffer } from '@/app/lib/billing-v2'
import { formatAnnualOfferAmount } from '@/app/lib/annual-offer-presentation'
import { formatDaysLeft, isHostedBillingAccount, useEligibleAccountNotice, useTrialCountdown } from '@/app/hooks/use-trial-countdown'
import { useAuthStore } from '@/app/stores/use-auth-store'
import AddCardBanner from '@/app/components/add-card-banner'
import { ModalDialog } from '@/app/components/modal-dialog'
import PaymentChoicePanel from '@/app/components/payment-choice-panel'
import { getPaidBonusAccessDate } from './bonus-access'
import { SubscriptionEntry } from './subscription-entry'

interface SubscriptionCapabilities {
  trialActive: boolean
  trialExpired: boolean
  needsPaymentMethod: boolean
  canSetupCard: boolean
  canStartPaidSubscription: boolean
  canReactivate: boolean
  canRetryPayment: boolean
  canResumeCancellation: boolean
}

interface SubscriptionData {
  plan: string | null
  planLabel: string
  billingInterval: 'monthly' | 'annual'
  status: 'none' | 'trialing' | 'active' | 'past_due' | 'cancelled' | 'expired'
  renewalDate: string | null
  trial: {
    active: boolean
    endsAt: string | null
    daysRemaining: number | null
  }
  cancelAtPeriodEnd: boolean
  trialPath: '7day' | '30day' | 'immediate' | null
  earlyAdopter: boolean
  capabilities?: SubscriptionCapabilities
  /** Additive Billing fields; parsed strictly where used, absent on older servers. */
  accountNotice?: unknown
  billingDate?: unknown
}

function isSubscriptionData(value: unknown): value is SubscriptionData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const subscription = value as Record<string, unknown>
  const trial = subscription.trial
  return (typeof subscription.plan === 'string' || subscription.plan === null)
    && typeof subscription.planLabel === 'string'
    && (subscription.billingInterval === 'monthly' || subscription.billingInterval === 'annual')
    && ['none', 'trialing', 'active', 'past_due', 'cancelled', 'expired'].includes(String(subscription.status))
    && (typeof subscription.renewalDate === 'string' || subscription.renewalDate === null)
    && !!trial && typeof trial === 'object' && !Array.isArray(trial)
    && typeof (trial as Record<string, unknown>).active === 'boolean'
    && (typeof (trial as Record<string, unknown>).endsAt === 'string' || (trial as Record<string, unknown>).endsAt === null)
    && (typeof (trial as Record<string, unknown>).daysRemaining === 'number' || (trial as Record<string, unknown>).daysRemaining === null)
    && typeof subscription.cancelAtPeriodEnd === 'boolean'
    && (subscription.trialPath === '7day' || subscription.trialPath === '30day' || subscription.trialPath === 'immediate' || subscription.trialPath === null)
    && typeof subscription.earlyAdopter === 'boolean'
}

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-[rgb(var(--primary))]/20 text-[rgb(var(--primary))]',
  trialing: 'bg-amber-500/20 text-amber-700 dark:text-amber-400',
  past_due: 'bg-red-500/20 text-red-700 dark:text-red-400',
  cancelled: 'bg-neutral-500/20 text-neutral-600 dark:text-neutral-400',
  expired: 'bg-neutral-500/20 text-neutral-600 dark:text-neutral-400',
  none: 'bg-neutral-500/20 text-neutral-600 dark:text-neutral-400',
}

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  trialing: 'Trialing',
  past_due: 'Past Due',
  cancelled: 'Cancelled',
  expired: 'Expired',
  none: 'No Subscription',
}

function formatDateStr(iso: string): string {
  return formatDateUtil(new Date(iso), 'system', { year: 'numeric', month: 'long', day: 'numeric' })
}

function getCapabilities(data: SubscriptionData): SubscriptionCapabilities {
  if (data.capabilities) return data.capabilities

  const canSetupCard = data.trialPath === '7day' && data.trial.active
  const canReactivate = data.status === 'cancelled' || data.status === 'expired' || data.status === 'none'
  return {
    trialActive: data.trial.active,
    trialExpired: false,
    needsPaymentMethod: canSetupCard,
    canSetupCard,
    canStartPaidSubscription: false,
    canReactivate,
    canRetryPayment: false,
    canResumeCancellation: data.cancelAtPeriodEnd && data.status === 'active',
  }
}

const BILLING_DATE_LABELS: Record<BillingDate['kind'], string> = {
  renews: 'Renews on',
  access_until: 'Access until',
  trial_ends: 'Free trial ends',
  first_charge: 'First payment',
  ended: 'Ended on',
}

const SUBSCRIBE_REASON = 'Keep your calendar, contacts and tasks syncing, end-to-end encrypted, in the web app and on Android.'

/**
 * The date row comes from Billing's billingDate. An older server without it only gets a
 * neutral future period end, never a renewal or charge promise, and no past date.
 */
function getDateRow(data: SubscriptionData): { label: string; at: string } | null {
  if (data.billingDate !== undefined) {
    const billingDate = parseBillingDate(data.billingDate)
    return billingDate?.at ? { label: BILLING_DATE_LABELS[billingDate.kind], at: billingDate.at } : null
  }
  if (!data.renewalDate || !(new Date(data.renewalDate).getTime() > Date.now())) return null
  const accessOnly = data.status === 'cancelled' || data.status === 'expired' || data.cancelAtPeriodEnd
  return { label: accessOnly ? 'Access until' : 'Current period ends', at: data.renewalDate }
}

/** Which actions the card renders; only a purchase action reads the signed offer price. */
function getCardActions(data: SubscriptionData, paymentPending: boolean, paymentFailure: string | null) {
  const capabilities = getCapabilities(data)
  const showAddCard = capabilities.canSetupCard && data.trial.daysRemaining != null && !paymentPending && !paymentFailure
  const canOpenPaidRecovery = !paymentPending && !paymentFailure && (
    capabilities.canRetryPayment
    || capabilities.canStartPaidSubscription
    || capabilities.canReactivate
  )
  const showPaidRecovery = canOpenPaidRecovery && !capabilities.canSetupCard && !data.cancelAtPeriodEnd
  return { showAddCard, showPaidRecovery, isPurchase: showAddCard || (showPaidRecovery && !capabilities.canRetryPayment) }
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <SubscriptionEntry />
      <div className="rounded-lg border border-[rgb(var(--border))] p-4 space-y-4">
        <div className="h-4 w-32 animate-pulse rounded bg-[rgb(var(--border))]" />
        <div className="space-y-3">
          <div className="h-3 w-48 animate-pulse rounded bg-[rgb(var(--border))]" />
          <div className="h-3 w-36 animate-pulse rounded bg-[rgb(var(--border))]" />
          <div className="h-3 w-40 animate-pulse rounded bg-[rgb(var(--border))]" />
        </div>
      </div>
    </div>
  )
}

function CancelDialog({
  accessUntil,
  cancelling,
  onConfirm,
  onClose,
  restoreFocusTo,
}: {
  accessUntil: string
  cancelling: boolean
  onConfirm: () => void
  onClose: () => void
  restoreFocusTo: HTMLElement | null
}) {
  return (
    <ModalDialog
      title="Cancel your subscription"
      description={`Your access continues until ${accessUntil}. After that, your account becomes read-only. Your encrypted data remains safe and can be exported or reactivated.`}
      onClose={onClose}
      closeOnEscape={!cancelling}
      closeOnBackdrop={!cancelling}
      restoreFocusTo={restoreFocusTo}
    >
      <div className="space-y-4">
        <div className="space-y-2 text-sm text-[rgb(var(--foreground))]">
          <p>Your access continues until {accessUntil}. After that, your account becomes read-only.</p>
          <p>Your data stays safe and encrypted. You can export anytime. You can reactivate anytime.</p>
        </div>
        <div className="flex gap-3 pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            disabled={cancelling}
          >
            Keep subscription
          </Button>
          <Button
            size="sm"
            className="border-red-500 bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20"
            onClick={onConfirm}
            disabled={cancelling}
          >
            {cancelling ? 'Cancelling\u2026' : 'Cancel subscription'}
          </Button>
        </div>
      </div>
    </ModalDialog>
  )
}

const PAYMENT_CONFIRMATION_POLL_DELAYS_MS = [2000, 5000, 10000] as const
const PAYMENT_CONFIRMATION_DELAYED = 'Payment confirmation is taking longer than expected. Retry the payment status or choose another payment method.'

/** The live user object and boundary that started one operation. */
interface OperationOwner {
  user: ReturnType<typeof useAuthStore.getState>['user']
  epoch: number
}

interface StripePaymentReturn {
  hasStripeParameters: boolean
  paymentIntent: string | null
  redirectStatus: string | null
}

function getStripePaymentReturn(search: string): StripePaymentReturn {
  const params = new URLSearchParams(search)
  return {
    hasStripeParameters: params.has('payment_intent')
      || params.has('payment_intent_client_secret')
      || params.has('redirect_status'),
    paymentIntent: params.get('payment_intent'),
    redirectStatus: params.get('redirect_status'),
  }
}

function PaymentChoiceDialog({
  dismissible,
  onClose,
  onSuccess,
  onDismissibilityChange,
  restoreFocusTo,
}: {
  dismissible: boolean
  onClose: () => void
  onSuccess: () => void | Promise<void>
  onDismissibilityChange: (dismissible: boolean) => void
  restoreFocusTo: HTMLElement | null
}) {
  return (
    <ModalDialog
      title="Continue with silentsuite.io"
      description="Review the current server-authorized annual payment options before choosing a payment method."
      onClose={onClose}
      closeOnEscape={dismissible}
      closeOnBackdrop={dismissible}
      restoreFocusTo={restoreFocusTo}
    >
      <PaymentChoicePanel
        onSuccess={onSuccess}
        onCancel={onClose}
        onDismissibilityChange={onDismissibilityChange}
        title="Payment options"
      />
    </ModalDialog>
  )
}

export default function SubscriptionPage() {
  const [stripePaymentReturn] = useState<StripePaymentReturn>(() => (
    typeof window === 'undefined'
      ? { hasStripeParameters: false, paymentIntent: null, redirectStatus: null }
      : getStripePaymentReturn(window.location.search)
  ))
  const [data, setData] = useState<SubscriptionData | null>(null)
  const [loading, setLoading] = useState(true)
  const [offerQuote, setOfferQuote] = useState<{ price: string; owner: OperationOwner; sequence: number } | null>(null)
  const [showCancelDialog, setShowCancelDialog] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [showPlanSelection, setShowPlanSelection] = useState(false)
  const [paymentChoiceDismissible, setPaymentChoiceDismissible] = useState(false)
  const [paymentConfirmationPending, setPaymentConfirmationPending] = useState(false)
  const [paymentReturnFailure, setPaymentReturnFailure] = useState<string | null>(null)
  const [paymentConfirmationAttempt, setPaymentConfirmationAttempt] = useState(0)
  // Captured while the CTA still holds focus. React marks the wrapper below
  // `inert` in the same commit that mounts the dialog, and the browser blurs
  // the CTA before any effect runs, so the dialog cannot discover it later.
  const [modalOpener, setModalOpener] = useState<HTMLElement | null>(null)
  const stripeReturnHandledRef = useRef(false)
  // The page belongs to the account (id and boundary) it was opened for; a later account never
  // owns its data or actions. Each new operation captures the live user object of that account
  // before any await or timer, and its continuations stay bound to that exact origin.
  const [principal] = useState(() => ({ id: useAuthStore.getState().user?.id ?? null, epoch: getAccountEpoch() }))
  const mountedRef = useRef(false)
  // Latest-started subscription read; an older response never publishes.
  const requestSequenceRef = useRef(0)
  // Latest-started offer price read, owned separately from the subscription reads.
  const offerSequenceRef = useRef(0)
  const captureOwner = useCallback((): OperationOwner | null => {
    const user = useAuthStore.getState().user
    if (!mountedRef.current || (user?.id ?? null) !== principal.id || !isCurrentAccountEpoch(principal.epoch)) return null
    return { user, epoch: principal.epoch }
  }, [principal])
  const ownerCurrent = useCallback((owner: OperationOwner | null) => owner !== null && mountedRef.current
    && useAuthStore.getState().user === owner.user
    && isCurrentAccountEpoch(owner.epoch), [])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const requestSubscription = useCallback(async (): Promise<SubscriptionData | null> => {
    try {
      const res = await fetch(`${BILLING_API_URL}/subscription`, {
        credentials: 'include',
      })
      if (res.ok) {
        const body: unknown = await res.json().catch(() => null)
        if (isSubscriptionData(body)) return body
      }
    } catch {
      // API may not be running in dev
    }
    return null
  }, [])

  const fetchSubscription = useCallback(async (initialOwner: OperationOwner | null = captureOwner()) => {
    let owner = initialOwner
    // A same-account fresh user object rejects the in-flight response; the page's still-current
    // account then gets one freshly owned read. Another account, logout or unmount gets nothing.
    for (let read = 0; read < 2 && ownerCurrent(owner); read += 1) {
      const sequence = ++requestSequenceRef.current
      const nextData = await requestSubscription()
      if (sequence !== requestSequenceRef.current) return null
      if (ownerCurrent(owner)) {
        if (nextData) setData(nextData)
        setLoading(false)
        return nextData
      }
      owner = captureOwner()
    }
    // Replaced again during the fresh read: end loading for the still-current account only
    // (existing unavailable view and recovery actions), publishing no stale data.
    if (owner && captureOwner()) setLoading(false)
    return null
  }, [captureOwner, ownerCurrent, requestSubscription])

  useEffect(() => {
    if (stripePaymentReturn.paymentIntent && stripePaymentReturn.redirectStatus) return
    void fetchSubscription()
  }, [fetchSubscription, stripePaymentReturn])

  // Admins, self-host builds and custom-server accounts get no notice here either, exactly as in
  // navigation; the raw status badge and the date rows remain.
  const notice = useEligibleAccountNotice(data ? parseAccountNotice(data.accountNotice) : null)
  const countdown = useTrialCountdown(notice)
  const expiredTrialEndsAt = notice?.kind === 'trial_days_left' && !countdown ? notice.trialEndsAt : null

  // Once this page's countdown has passed its end instant, its data is the pre-expiry view. The
  // store's expiry claim for this account, boundary and instant carries the one shared result,
  // whenever it completed; the page adopts it instead of reading again, and an older in-flight
  // page read can no longer overwrite it. Capabilities come only from that server body.
  const expiryClaim = useAuthStore((state) => state.trialExpiryRefreshClaim)
  useEffect(() => {
    if (!expiredTrialEndsAt || !expiryClaim || expiryClaim.response === null) return
    if (expiryClaim.trialEndsAt !== expiredTrialEndsAt || expiryClaim.userId !== principal.id || expiryClaim.epoch !== principal.epoch) return
    if (!captureOwner() || !isSubscriptionData(expiryClaim.response) || expiryClaim.response === data) return
    requestSequenceRef.current += 1
    setData(expiryClaim.response)
  }, [expiredTrialEndsAt, expiryClaim, data, principal, captureOwner])
  // The price and the reason to subscribe are hosted-only additions; self-host and custom-server
  // accounts keep their existing actions but get neither, and no offer read.
  const purchaseAction = data && isHostedBillingAccount()
    ? getCardActions(data, paymentConfirmationPending, paymentReturnFailure).isPurchase
    : false

  // The signed account offer supplies the price, read only while a purchase action is shown.
  // A quote belongs to the live owner and read that produced it: a newer read, a fresh user
  // object or another account hides it at once, and a failed or refused read leaves none.
  const liveUser = useAuthStore((state) => state.user)
  useEffect(() => {
    const sequence = ++offerSequenceRef.current
    setOfferQuote(null)
    if (!purchaseAction) return
    const owner = captureOwner()
    if (!owner) return
    const live = () => sequence === offerSequenceRef.current && ownerCurrent(owner)
    fetchAuthenticatedAccountOffer({
      fetcher: (input, init) => fetch(input, { ...init, credentials: 'include' }),
      billingApiUrl: BILLING_API_URL,
    }).then(
      (account) => { if (live()) setOfferQuote({ price: `${formatAnnualOfferAmount(account.offer.offer)} per year`, owner, sequence }) },
      () => { if (live()) setOfferQuote(null) },
    )
  }, [purchaseAction, data, liveUser, captureOwner, ownerCurrent])
  const offerPrice = offerQuote && offerQuote.sequence === offerSequenceRef.current && ownerCurrent(offerQuote.owner)
    ? offerQuote.price
    : null

  useEffect(() => {
    const { hasStripeParameters, paymentIntent, redirectStatus } = stripePaymentReturn
    if (hasStripeParameters) {
      const cleanedUrl = new URL(window.location.href)
      cleanedUrl.searchParams.delete('payment_intent')
      cleanedUrl.searchParams.delete('payment_intent_client_secret')
      cleanedUrl.searchParams.delete('redirect_status')
      window.history.replaceState({}, '', `${cleanedUrl.pathname}${cleanedUrl.search}${cleanedUrl.hash}`)
    }
    if (!paymentIntent || !redirectStatus) return
    if (stripeReturnHandledRef.current) return
    stripeReturnHandledRef.current = true

    if (redirectStatus !== 'succeeded' && redirectStatus !== 'processing') {
      setPaymentConfirmationPending(false)
      setPaymentReturnFailure('Stripe could not confirm this payment. You can retry or choose another payment method.')
      void fetchSubscription()
      return
    }

    setPaymentConfirmationPending(true)
    setPaymentReturnFailure(null)
    setShowPlanSelection(false)
    setPaymentConfirmationAttempt(attempt => attempt + 1)
  }, [fetchSubscription, stripePaymentReturn])

  useEffect(() => {
    if (paymentConfirmationAttempt === 0) return

    let cancelled = false
    let settled = false
    const timers: number[] = []
    const clearTimers = () => timers.forEach(timer => window.clearTimeout(timer))
    // This attempt acts only while it is current, unsettled and its own origin is still live.
    const owner = captureOwner()
    const live = () => !cancelled && !settled && ownerCurrent(owner)
    // An invalidated origin ends this attempt's own work. Only while the page's account is still
    // current does it clear this attempt's local confirming state, offering the existing retry;
    // it never publishes data, and a superseded attempt (cancelled) or another account gets nothing.
    const endInvalidated = () => {
      if (cancelled || settled) return
      settled = true
      clearTimers()
      if (!captureOwner()) return
      setLoading(false)
      setPaymentConfirmationPending(false)
      setPaymentReturnFailure(PAYMENT_CONFIRMATION_DELAYED)
    }

    const pollSubscription = async (finalAttempt = false) => {
      if (!live()) { endInvalidated(); return }
      const sequence = ++requestSequenceRef.current
      const nextData = await requestSubscription()
      if (cancelled || settled || sequence !== requestSequenceRef.current) return
      if (!ownerCurrent(owner)) { endInvalidated(); return }
      setLoading(false)
      if (nextData) setData(nextData)
      const capabilities = nextData ? getCapabilities(nextData) : null
      const paymentConfirmed = nextData?.status === 'active'
        || (nextData?.status === 'trialing'
          && capabilities?.canSetupCard === false
          && capabilities.needsPaymentMethod === false
          && capabilities.canRetryPayment === false)
      if (paymentConfirmed) {
        settled = true
        clearTimers()
        setPaymentConfirmationPending(false)
        setPaymentReturnFailure(null)
        // The confirmed payment refreshes the shared account state for its own signed-in account only.
        if (owner?.user) void useAuthStore.getState().fetchSubscription()
        return
      }
      if (finalAttempt && !settled) {
        setPaymentConfirmationPending(false)
        setPaymentReturnFailure(PAYMENT_CONFIRMATION_DELAYED)
      }
    }

    void pollSubscription()
    PAYMENT_CONFIRMATION_POLL_DELAYS_MS.forEach((delayMs, index) => {
      timers.push(window.setTimeout(() => {
        if (live()) void pollSubscription(index === PAYMENT_CONFIRMATION_POLL_DELAYS_MS.length - 1)
        else endInvalidated()
      }, delayMs))
    })

    return () => {
      cancelled = true
      clearTimers()
    }
  }, [captureOwner, ownerCurrent, paymentConfirmationAttempt, requestSubscription])

  useEffect(() => {
    if (!data) return
    const capabilities = getCapabilities(data)
    const paymentConfirmed = data.status === 'active'
      || (data.status === 'trialing'
        && !capabilities.canSetupCard
        && !capabilities.needsPaymentMethod
        && !capabilities.canRetryPayment)
    if (paymentConfirmed) {
      setPaymentConfirmationPending(false)
      setPaymentReturnFailure(null)
    }
  }, [data])

  function startPaymentConfirmation() {
    if (!captureOwner()) return
    setPaymentConfirmationPending(true)
    setPaymentReturnFailure(null)
    setShowPlanSelection(false)
    setPaymentConfirmationAttempt(attempt => attempt + 1)
  }

  function captureModalOpener() {
    setModalOpener(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  }

  function openPaymentRecovery() {
    // A retained page never opens a payment panel for an account other than its own.
    if (!captureOwner()) return
    captureModalOpener()
    setPaymentConfirmationPending(false)
    setPaymentReturnFailure(null)
    setPaymentChoiceDismissible(false)
    setShowPlanSelection(true)
  }

  function closePaymentRecovery() {
    setPaymentChoiceDismissible(false)
    setShowPlanSelection(false)
  }

  async function handleCancel() {
    const owner = captureOwner()
    if (!owner) return
    setCancelling(true)
    try {
      const res = await fetch(`${BILLING_API_URL}/subscription/cancel`, {
        method: 'POST',
        credentials: 'include',
      })
      if (res.ok && ownerCurrent(owner)) {
        setShowCancelDialog(false)
        await fetchSubscription(owner)
      }
    } catch {
      // API may not be running in dev
    } finally {
      // Neutral local cleanup for the page's still-current account, so a same-account fresh user
      // object never wedges the dialog; nothing is reset for another account.
      if (captureOwner()) setCancelling(false)
    }
  }

  if (loading) return <LoadingSkeleton />

  if (!data) {
    return (
      <>
        <div
          className="space-y-6"
          aria-hidden={showPlanSelection || undefined}
          inert={showPlanSelection ? true : undefined}
        >
          {paymentConfirmationPending && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
              <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">Confirming your payment.</p>
              <p className="mt-1 text-xs text-[rgb(var(--muted))]">This usually takes a few seconds. We will update this page automatically.</p>
            </div>
          )}
          {paymentReturnFailure ? (
            <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-amber-700 dark:text-amber-400">Payment needs attention.</p>
                <p className="mt-1 text-xs text-[rgb(var(--muted))]">{paymentReturnFailure}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={startPaymentConfirmation}>Retry payment status</Button>
                <Button size="sm" variant="outline" onClick={openPaymentRecovery}>Review payment options</Button>
              </div>
            </div>
          ) : !paymentConfirmationPending && (
            <div className="space-y-3">
              <p className="text-sm text-[rgb(var(--muted))]">Unable to load subscription details.</p>
              <Button size="sm" variant="outline" className="w-full sm:w-auto min-h-11" onClick={() => { void fetchSubscription() }}>
                Try again
              </Button>
            </div>
          )}
        </div>
        {showPlanSelection && (
          <PaymentChoiceDialog
            dismissible={paymentChoiceDismissible}
            onClose={closePaymentRecovery}
            onSuccess={startPaymentConfirmation}
            onDismissibilityChange={setPaymentChoiceDismissible}
            restoreFocusTo={modalOpener}
          />
        )}
      </>
    )
  }

  const capabilities = getCapabilities(data)
  const { showAddCard, showPaidRecovery } = getCardActions(data, paymentConfirmationPending, paymentReturnFailure)
  const dateRow = getDateRow(data)
  const showBillingRow = !!data.plan && !data.planLabel.toLowerCase().includes(data.billingInterval)
  const endedNotice = notice?.kind === 'trial_ended' || notice?.kind === 'access_ended'
  // Only Billing's notice (seven-day countdown or a verified end) replaces the raw status badge.
  const headline = countdown
    ? { title: `Free trial: ${formatDaysLeft(countdown.daysLeft)}`, detail: "No card on file, so you won't be charged." }
    : notice?.kind === 'trial_ended'
      ? { title: 'Your trial has ended.', detail: null }
      : notice?.kind === 'access_ended'
        ? { title: 'Your subscription has ended.', detail: null }
        : null

  const isCancelled = data.status === 'cancelled' || data.status === 'expired'
  const hasLiveSubscriptionActions = (data.status === 'active' || data.status === 'trialing')
    && !data.cancelAtPeriodEnd
    && !capabilities.canSetupCard
    && !capabilities.trialExpired
    && !capabilities.canRetryPayment
    && !capabilities.canStartPaidSubscription
  const paidRecoveryLabel = capabilities.canRetryPayment
    ? 'Retry payment'
    : data.status === 'cancelled'
      ? 'Reactivate'
      : 'Subscribe'
  const accessUntilFormatted = data.renewalDate ? formatDateStr(data.renewalDate) : 'the end of your current period'
  const paidBonusAccessDate = getPaidBonusAccessDate(data)
  const modalIsOpen = showCancelDialog || showPlanSelection
  return (
    <>
      <div
        className="space-y-6"
        aria-hidden={modalIsOpen || undefined}
        inert={modalIsOpen ? true : undefined}
      >

      {/* Subscription details card */}
      <section className="rounded-lg border border-[rgb(var(--border))] p-4 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-[rgb(var(--foreground))]">Subscription</h2>
          {!notice && (
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[data.status] ?? STATUS_STYLES.none}`}
            >
              {STATUS_LABELS[data.status] ?? data.status}
            </span>
          )}
        </div>

        {headline && (
          <div className="space-y-1">
            <p className="text-base font-semibold text-[rgb(var(--foreground))]">{headline.title}</p>
            {headline.detail && <p className="text-sm text-[rgb(var(--muted))]">{headline.detail}</p>}
            {endedNotice && (
              <>
                <p className="text-sm text-[rgb(var(--muted))]">Your data is safe and read-only.</p>
                <Link
                  href="/settings/export"
                  className="inline-flex min-h-11 items-center text-sm font-medium text-[rgb(var(--primary))] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 dark:focus-visible:ring-emerald-300"
                >
                  Export your data
                </Link>
              </>
            )}
          </div>
        )}

        <div className="space-y-3">
          {/* Plan name */}
          <div>
            <p className="text-xs text-[rgb(var(--muted))]">Plan</p>
            <p className="text-sm text-[rgb(var(--foreground))]">{data.planLabel}</p>
          </div>

          {/* Billing interval, unless the plan name already says it */}
          {showBillingRow && (
            <div>
              <p className="text-xs text-[rgb(var(--muted))]">Billing</p>
              <p className="text-sm text-[rgb(var(--foreground))] capitalize">{data.billingInterval}</p>
            </div>
          )}

          {/* Trial end date for older Billing without billingDate; dates only, no day count */}
          {data.billingDate === undefined && data.trial.active && data.trial.endsAt && (
            <div>
              <p className="text-xs text-[rgb(var(--muted))]">Trial</p>
              <p className="text-sm text-[rgb(var(--foreground))]">Ends {formatDateStr(data.trial.endsAt)}</p>
            </div>
          )}

          {/* Trial path info */}
          {data.trialPath && data.trial.active && (
            <div>
              <p className="text-xs text-[rgb(var(--muted))]">Trial type</p>
              <p className="text-sm text-[rgb(var(--foreground))]">
                {data.trialPath === '7day' ? '7-day trial (no card)' : data.trialPath === '30day' ? '30-day trial' : 'Paid + 14-day bonus'}
              </p>
            </div>
          )}

          {/* Paid bonus/access date */}
          {paidBonusAccessDate && (
            <div>
              <p className="text-xs text-[rgb(var(--muted))]">Bonus access</p>
              <p className="text-sm text-[rgb(var(--foreground))]">Included until {formatDateStr(paidBonusAccessDate)}</p>
            </div>
          )}

          {/* Renewal / access / trial / end date, labelled by Billing */}
          {dateRow && (
            <div>
              <p className="text-xs text-[rgb(var(--muted))]">{dateRow.label}</p>
              <p className="text-sm text-[rgb(var(--foreground))]">{formatDateStr(dateRow.at)}</p>
            </div>
          )}

          {/* Cancel at period end notice */}
          {data.cancelAtPeriodEnd && !isCancelled && data.renewalDate && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Your subscription will be cancelled at the end of the current period ({formatDateStr(data.renewalDate)})
            </p>
          )}
        </div>

        {purchaseAction && (
          <div className="space-y-1 border-t border-[rgb(var(--border))] pt-4">
            <p className="text-sm text-[rgb(var(--foreground))]">{SUBSCRIBE_REASON}</p>
            {offerPrice && <p className="text-sm font-medium text-[rgb(var(--foreground))]">{offerPrice}</p>}
          </div>
        )}

        {showAddCard && (
          <AddCardBanner daysRemaining={countdown?.daysLeft ?? null} onChoosePayment={openPaymentRecovery} />
        )}

        {(showPaidRecovery || hasLiveSubscriptionActions) && (
          <div className="flex flex-col gap-3 sm:flex-row">
            {showPaidRecovery && (
              <Button size="sm" className="w-full sm:w-auto min-h-11" onClick={openPaymentRecovery}>
                {paidRecoveryLabel}
              </Button>
            )}
            {hasLiveSubscriptionActions && (
              <Button
                variant="outline"
                size="sm"
                className="w-full sm:w-auto min-h-11 border-red-500/30 text-red-600 dark:text-red-400 hover:bg-red-500/10"
                onClick={() => { captureModalOpener(); setShowCancelDialog(true) }}
              >
                Cancel subscription
              </Button>
            )}
          </div>
        )}
      </section>

      {paymentConfirmationPending && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
          <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">Confirming your payment.</p>
          <p className="mt-1 text-xs text-[rgb(var(--muted))]">This usually takes a few seconds. We will update this page automatically.</p>
        </div>
      )}

      {paymentReturnFailure && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
          <p className="text-sm font-medium text-amber-700 dark:text-amber-300">Payment needs attention</p>
          <p className="mt-1 text-sm text-[rgb(var(--muted))]">{paymentReturnFailure}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={startPaymentConfirmation}>
              Retry payment status
            </Button>
            <Button size="sm" variant="outline" onClick={openPaymentRecovery}>
              Review payment options
            </Button>
          </div>
        </div>
      )}

      {capabilities.canRetryPayment && !paymentConfirmationPending && !paymentReturnFailure && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <p className="text-sm font-medium text-amber-700 dark:text-amber-400">Payment incomplete. Please try again.</p>
          <p className="mt-1 text-xs text-[rgb(var(--muted))]">Your subscription will activate after payment is completed.</p>
        </div>
      )}

      </div>

      {showCancelDialog && (
        <CancelDialog
          accessUntil={accessUntilFormatted}
          cancelling={cancelling}
          onConfirm={handleCancel}
          onClose={() => setShowCancelDialog(false)}
          restoreFocusTo={modalOpener}
        />
      )}

      {showPlanSelection && (
        <PaymentChoiceDialog
          dismissible={paymentChoiceDismissible}
          onClose={closePaymentRecovery}
          onSuccess={startPaymentConfirmation}
          onDismissibilityChange={setPaymentChoiceDismissible}
          restoreFocusTo={modalOpener}
        />
      )}
    </>
  )
}
