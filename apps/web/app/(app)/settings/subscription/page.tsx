'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { Button } from '@silentsuite/ui'
import { BILLING_API_URL } from '@/app/lib/config'
import { formatDate as formatDateUtil } from '@/app/lib/date'
import { getAccountEpoch, isCurrentAccountEpoch } from '@/app/lib/account-epoch'
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
  const [bannerDismissed, setBannerDismissed] = useState(false)
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
  // Every request, timer and continuation belongs to the account this page was opened
  // for; a later account never becomes the owner of this page's data or actions.
  const [accountOwner] = useState(() => ({ user: useAuthStore.getState().user, epoch: getAccountEpoch() }))
  const mountedRef = useRef(false)
  // Latest-started subscription read; an older response never publishes.
  const requestSequenceRef = useRef(0)
  const ownerCurrent = useCallback(() => mountedRef.current
    && useAuthStore.getState().user === accountOwner.user
    && isCurrentAccountEpoch(accountOwner.epoch), [accountOwner])

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

  const fetchSubscription = useCallback(async () => {
    if (!ownerCurrent()) return null
    const sequence = ++requestSequenceRef.current
    const nextData = await requestSubscription()
    if (!ownerCurrent() || sequence !== requestSequenceRef.current) return null
    if (nextData) setData(nextData)
    setLoading(false)
    return nextData
  }, [ownerCurrent, requestSubscription])

  useEffect(() => {
    if (stripePaymentReturn.paymentIntent && stripePaymentReturn.redirectStatus) return
    void fetchSubscription()
  }, [fetchSubscription, stripePaymentReturn])

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
    // This attempt acts only while it is current, unsettled and its account owns the page.
    const live = () => !cancelled && !settled && ownerCurrent()

    const pollSubscription = async (finalAttempt = false) => {
      if (!live()) return
      const sequence = ++requestSequenceRef.current
      const nextData = await requestSubscription()
      if (!live() || sequence !== requestSequenceRef.current) return
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
        if (accountOwner.user) void useAuthStore.getState().fetchSubscription()
        return
      }
      if (finalAttempt && !settled) {
        setPaymentConfirmationPending(false)
        setPaymentReturnFailure('Payment confirmation is taking longer than expected. Retry the payment status or choose another payment method.')
      }
    }

    void pollSubscription()
    PAYMENT_CONFIRMATION_POLL_DELAYS_MS.forEach((delayMs, index) => {
      timers.push(window.setTimeout(() => {
        if (live()) void pollSubscription(index === PAYMENT_CONFIRMATION_POLL_DELAYS_MS.length - 1)
      }, delayMs))
    })

    return () => {
      cancelled = true
      clearTimers()
    }
  }, [accountOwner, ownerCurrent, paymentConfirmationAttempt, requestSubscription])

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
    if (!ownerCurrent()) return
    setPaymentConfirmationPending(true)
    setPaymentReturnFailure(null)
    setShowPlanSelection(false)
    setPaymentConfirmationAttempt(attempt => attempt + 1)
  }

  function captureModalOpener() {
    setModalOpener(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  }

  function openPaymentRecovery() {
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
    if (!ownerCurrent()) return
    setCancelling(true)
    try {
      const res = await fetch(`${BILLING_API_URL}/subscription/cancel`, {
        method: 'POST',
        credentials: 'include',
      })
      if (res.ok && ownerCurrent()) {
        setShowCancelDialog(false)
        await fetchSubscription()
      }
    } catch {
      // API may not be running in dev
    } finally {
      if (ownerCurrent()) setCancelling(false)
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
            <p className="text-sm text-[rgb(var(--muted))]">Unable to load subscription details.</p>
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
  const showTrialBanner =
    !bannerDismissed &&
    data.trial.active &&
    data.trial.daysRemaining != null &&
    data.trial.daysRemaining <= 7 &&
    !capabilities.canSetupCard

  const isCancelled = data.status === 'cancelled' || data.status === 'expired'
  const hasLiveSubscriptionActions = (data.status === 'active' || data.status === 'trialing')
    && !data.cancelAtPeriodEnd
    && !capabilities.canSetupCard
    && !capabilities.trialExpired
    && !capabilities.canRetryPayment
    && !capabilities.canStartPaidSubscription
  const canOpenPaidRecovery = !paymentConfirmationPending && !paymentReturnFailure && (
    capabilities.canRetryPayment
    || capabilities.canStartPaidSubscription
    || capabilities.canReactivate
  )
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

      {/* Trial banner */}
      {showTrialBanner && (
        <div className="flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <p className="text-sm text-amber-700 dark:text-amber-400">
            {data.trial.daysRemaining} day{data.trial.daysRemaining !== 1 ? 's' : ''} remaining in your trial
          </p>
          <button
            onClick={() => setBannerDismissed(true)}
            className="text-amber-700 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-300 text-sm font-medium"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Subscription details card */}
      <section className="rounded-lg border border-[rgb(var(--border))] p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[rgb(var(--foreground))]">Subscription</h2>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[data.status] ?? STATUS_STYLES.none}`}
          >
            {STATUS_LABELS[data.status] ?? data.status}
          </span>
        </div>

        <div className="space-y-3">
          {/* Plan name */}
          <div>
            <p className="text-xs text-[rgb(var(--muted))]">Plan</p>
            <p className="text-sm text-[rgb(var(--foreground))]">{data.planLabel}</p>
          </div>

          {/* Billing interval */}
          {data.plan && (
            <div>
              <p className="text-xs text-[rgb(var(--muted))]">Billing</p>
              <p className="text-sm text-[rgb(var(--foreground))] capitalize">{data.billingInterval}</p>
            </div>
          )}

          {/* Trial info */}
          {data.trial.active && data.trial.endsAt && (
            <div>
              <p className="text-xs text-[rgb(var(--muted))]">Trial</p>
              <p className="text-sm text-[rgb(var(--foreground))]">
                Ends {formatDateStr(data.trial.endsAt)} &mdash; {data.trial.daysRemaining} day
                {data.trial.daysRemaining !== 1 ? 's' : ''} remaining
              </p>
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

          {/* Renewal / access date */}
          {data.renewalDate && (
            <div>
              <p className="text-xs text-[rgb(var(--muted))]">
                {isCancelled || data.cancelAtPeriodEnd ? 'Access until' : 'Next billing'}
              </p>
              <p className="text-sm text-[rgb(var(--foreground))]">{formatDateStr(data.renewalDate)}</p>
            </div>
          )}

          {/* Cancel at period end notice */}
          {data.cancelAtPeriodEnd && !isCancelled && data.renewalDate && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Your subscription will be cancelled at the end of the current period ({formatDateStr(data.renewalDate)})
            </p>
          )}
        </div>
      </section>

      {capabilities.canSetupCard
        && data.trial.daysRemaining != null
        && !paymentConfirmationPending
        && !paymentReturnFailure && (
        <AddCardBanner daysRemaining={data.trial.daysRemaining} onChoosePayment={openPaymentRecovery} />
      )}

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

      {/* Action buttons */}
      <div className="flex gap-3">
        {hasLiveSubscriptionActions && (
            <Button
              variant="outline"
              size="sm"
              className="border-red-500/30 text-red-600 dark:text-red-400 hover:bg-red-500/10"
              onClick={() => { captureModalOpener(); setShowCancelDialog(true) }}
            >
              Cancel subscription
            </Button>
        )}
        {canOpenPaidRecovery && !capabilities.canSetupCard && !data.cancelAtPeriodEnd && (
          <Button size="sm" onClick={openPaymentRecovery}>
            {paidRecoveryLabel}
          </Button>
        )}
      </div>

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
