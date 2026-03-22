'use client'

import { useEffect, useState, useCallback } from 'react'
import { Crown, Star, Sparkles, AlertTriangle, Loader2, Check } from 'lucide-react'
import { Button } from '@silentsuite/ui'
import StripePaymentForm from '@/app/components/stripe-payment-form'

const BILLING_API_URL =
  process.env.NEXT_PUBLIC_BILLING_API_URL ?? 'http://localhost:3736'

interface SubscriptionData {
  plan: string | null
  planLabel: string
  billingInterval: 'monthly' | 'annual'
  status: 'none' | 'trialing' | 'active' | 'past_due' | 'cancelled'
  renewalDate: string | null
  trial: {
    active: boolean
    endsAt: string | null
    daysRemaining: number | null
  }
  cancelAtPeriodEnd: boolean
  trialPath: '7day' | '30day' | 'immediate' | null
  earlyAdopter: boolean
}

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-[rgb(var(--primary))]/20 text-[rgb(var(--primary))]',
  trialing: 'bg-amber-500/20 text-amber-400',
  past_due: 'bg-red-500/20 text-red-400',
  cancelled: 'bg-neutral-500/20 text-neutral-400',
  none: 'bg-neutral-500/20 text-neutral-400',
}

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  trialing: 'Trialing',
  past_due: 'Past Due',
  cancelled: 'Cancelled',
  none: 'No Subscription',
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
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
}: {
  accessUntil: string
  cancelling: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(var(--background))]/80 backdrop-blur-sm">
      <div className="mx-4 w-full max-w-md rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-6 space-y-4">
        <h2 className="text-lg font-semibold text-[rgb(var(--foreground))]">Cancel your subscription</h2>
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
            className="border-red-500 bg-red-500/10 text-red-400 hover:bg-red-500/20"
            onClick={onConfirm}
            disabled={cancelling}
          >
            {cancelling ? 'Cancelling\u2026' : 'Cancel subscription'}
          </Button>
        </div>
      </div>
    </div>
  )
}

const REACTIVATION_PLANS = [
  { id: 'early_monthly', name: 'Early Adopter Monthly', price: '3.60', period: '/mo', description: 'Locked-in early adopter pricing', icon: Crown, earlyOnly: true },
  { id: 'early_annual', name: 'Early Adopter Annual', price: '36', period: '/yr', description: 'Save with annual billing', icon: Crown, badge: 'Best value', earlyOnly: true },
  { id: 'standard_monthly', name: 'Standard Monthly', price: '4.80', period: '/mo', description: 'Full access, billed monthly', icon: Star, earlyOnly: false },
  { id: 'standard_annual', name: 'Standard Annual', price: '48', period: '/yr', description: 'Save with annual billing', icon: Sparkles, badge: 'Best value', earlyOnly: false },
] as const

export default function SubscriptionPage() {
  const [data, setData] = useState<SubscriptionData | null>(null)
  const [loading, setLoading] = useState(true)
  const [bannerDismissed, setBannerDismissed] = useState(false)
  const [showCancelDialog, setShowCancelDialog] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [showPlanSelection, setShowPlanSelection] = useState(false)
  const [reactivating, setReactivating] = useState<string | null>(null)
  const [reactivateClientSecret, setReactivateClientSecret] = useState<string | null>(null)
  const [reactivatePlanId, setReactivatePlanId] = useState<string | null>(null)
  const [showChangePlanDialog, setShowChangePlanDialog] = useState(false)
  const [changingPlan, setChangingPlan] = useState(false)
  const [changePlanSuccess, setChangePlanSuccess] = useState<{ plan: string; effectiveDate: string; prorated: boolean } | null>(null)
  const [earlyAdopterForfeitConfirmed, setEarlyAdopterForfeitConfirmed] = useState(false)
  const [selectedChangePlan, setSelectedChangePlan] = useState<string | null>(null)
  const [changePlanError, setChangePlanError] = useState<string | null>(null)
  const [changePlanToast, setChangePlanToast] = useState<string | null>(null)

  const fetchSubscription = useCallback(async () => {
    try {
      const res = await fetch(`${BILLING_API_URL}/subscription`, {
        credentials: 'include',
      })
      if (res.ok) {
        setData(await res.json())
      }
    } catch {
      // API may not be running in dev
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSubscription()
  }, [fetchSubscription])

  async function handleCancel() {
    setCancelling(true)
    try {
      const res = await fetch(`${BILLING_API_URL}/subscription/cancel`, {
        method: 'POST',
        credentials: 'include',
      })
      if (res.ok) {
        setShowCancelDialog(false)
        await fetchSubscription()
      }
    } catch {
      // API may not be running in dev
    } finally {
      setCancelling(false)
    }
  }

  async function handleReactivate(planId: string) {
    setReactivating(planId)
    try {
      const res = await fetch(`${BILLING_API_URL}/subscription/reactivate`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId }),
      })
      if (res.ok) {
        const { clientSecret } = await res.json()
        setReactivateClientSecret(clientSecret)
        setReactivatePlanId(planId)
      }
    } catch {
      // API may not be running in dev
    } finally {
      setReactivating(null)
    }
  }

  async function handleChangePlan(newPlanId: string) {
    setChangingPlan(true)
    setChangePlanError(null)
    try {
      const isEarlyAdopterPlan = data?.plan?.startsWith('early_')
      const res = await fetch(`${BILLING_API_URL}/subscription/change-plan`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planId: newPlanId,
          ...(isEarlyAdopterPlan && earlyAdopterForfeitConfirmed ? { confirmForfeit: true } : {}),
        }),
      })
      if (res.ok) {
        const result = await res.json()
        setChangePlanSuccess(result)
        setSelectedChangePlan(null)
        await fetchSubscription()
        // Show toast and auto-dismiss
        const planInfo = REACTIVATION_PLANS.find(p => p.id === newPlanId)
        setChangePlanToast(`Switched to ${planInfo?.name ?? 'new plan'}`)
        setTimeout(() => setChangePlanToast(null), 4000)
      } else {
        const body = await res.json().catch(() => null)
        setChangePlanError(body?.error ?? 'Failed to change plan. Please try again.')
      }
    } catch {
      setChangePlanError('Unable to reach billing service. Please try again.')
    } finally {
      setChangingPlan(false)
    }
  }

  if (loading) return <LoadingSkeleton />

  if (!data) {
    return (
      <div className="space-y-6">
        <p className="text-sm text-[rgb(var(--muted))]">Unable to load subscription details.</p>
      </div>
    )
  }

  const showTrialBanner =
    !bannerDismissed &&
    data.trial.active &&
    data.trial.daysRemaining != null &&
    data.trial.daysRemaining <= 7

  const isCancelled = data.status === 'cancelled'
  const isActiveOrTrialing = data.status === 'active' || data.status === 'trialing'
  const accessUntilFormatted = data.renewalDate ? formatDate(data.renewalDate) : 'the end of your current period'
  const isEarlyAdopterPlan = data.plan?.startsWith('early_')

  // Filter reactivation plans: show early adopter plans only if user is an early adopter
  const availablePlans = REACTIVATION_PLANS.filter(
    (p) => !p.earlyOnly || data.earlyAdopter,
  )

  return (
    <div className="space-y-6">
      {/* Cancel confirmation dialog */}
      {showCancelDialog && (
        <CancelDialog
          accessUntil={accessUntilFormatted}
          cancelling={cancelling}
          onConfirm={handleCancel}
          onClose={() => setShowCancelDialog(false)}
        />
      )}

      {/* Trial banner */}
      {showTrialBanner && (
        <div className="flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <p className="text-sm text-amber-400">
            {data.trial.daysRemaining} day{data.trial.daysRemaining !== 1 ? 's' : ''} remaining in your trial
          </p>
          <button
            onClick={() => setBannerDismissed(true)}
            className="text-amber-400 hover:text-amber-300 text-sm font-medium"
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
                Ends {formatDate(data.trial.endsAt)} &mdash; {data.trial.daysRemaining} day
                {data.trial.daysRemaining !== 1 ? 's' : ''} remaining
              </p>
            </div>
          )}

          {/* Trial path info */}
          {data.trialPath && data.trial.active && (
            <div>
              <p className="text-xs text-[rgb(var(--muted))]">Trial type</p>
              <p className="text-sm text-[rgb(var(--foreground))]">
                {data.trialPath === '7day' ? '7-day trial (no card)' : data.trialPath === '30day' ? '30-day trial' : 'Paid + 30-day bonus'}
              </p>
            </div>
          )}

          {/* Renewal / access date */}
          {data.renewalDate && (
            <div>
              <p className="text-xs text-[rgb(var(--muted))]">
                {isCancelled || data.cancelAtPeriodEnd ? 'Access until' : 'Next billing'}
              </p>
              <p className="text-sm text-[rgb(var(--foreground))]">{formatDate(data.renewalDate)}</p>
            </div>
          )}

          {/* Cancel at period end notice */}
          {data.cancelAtPeriodEnd && !isCancelled && data.renewalDate && (
            <p className="text-xs text-amber-400">
              Your subscription will be cancelled at the end of the current period ({formatDate(data.renewalDate)})
            </p>
          )}
        </div>
      </section>

      {/* Action buttons */}
      <div className="flex gap-3">
        {isActiveOrTrialing && !data.cancelAtPeriodEnd && (
          <>
            <Button variant="outline" size="sm" onClick={() => { setShowChangePlanDialog(true); setChangePlanSuccess(null); setEarlyAdopterForfeitConfirmed(false); setSelectedChangePlan(null); setChangePlanError(null) }}>
              Change plan
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="border-red-500/30 text-red-400 hover:bg-red-500/10"
              onClick={() => setShowCancelDialog(true)}
            >
              Cancel subscription
            </Button>
          </>
        )}
        {(isCancelled || data.status === 'none' || data.cancelAtPeriodEnd) && (
          <Button size="sm" onClick={() => setShowPlanSelection(true)}>
            Reactivate
          </Button>
        )}
      </div>

      {/* Plan selection dialog (reactivate) */}
      {showPlanSelection && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(var(--background))]/80 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-md rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-6 space-y-4">
            {reactivateClientSecret && reactivatePlanId ? (
              <>
                <h2 className="text-lg font-semibold text-[rgb(var(--foreground))]">Complete payment</h2>
                <StripePaymentForm
                  clientSecret={reactivateClientSecret}
                  onSuccess={async () => {
                    setReactivateClientSecret(null)
                    setReactivatePlanId(null)
                    setShowPlanSelection(false)
                    await fetchSubscription()
                  }}
                  submitLabel="Reactivate subscription"
                  mode="payment"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { setReactivateClientSecret(null); setReactivatePlanId(null) }}
                  className="w-full"
                >
                  Back
                </Button>
              </>
            ) : (
              <>
                <h2 className="text-lg font-semibold text-[rgb(var(--foreground))]">Choose your plan</h2>
                <div className="space-y-3">
                  {availablePlans.map((plan) => {
                    const Icon = plan.icon
                    return (
                      <div key={plan.id} className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4">
                        <div className="flex items-start justify-between">
                          <div className="flex items-start gap-3">
                            <div className="mt-0.5 rounded-lg bg-[rgb(var(--border))] p-2">
                              <Icon className="h-5 w-5 text-[rgb(var(--primary))]" />
                            </div>
                            <div>
                              <div className="flex items-center gap-2">
                                <h3 className="font-medium text-white">{plan.name}</h3>
                                {'badge' in plan && plan.badge && (
                                  <span className="rounded-full bg-[rgb(var(--primary))]/10 px-2 py-0.5 text-xs font-medium text-[rgb(var(--primary))]">
                                    {plan.badge}
                                  </span>
                                )}
                              </div>
                              <p className="mt-0.5 text-sm text-[rgb(var(--muted))]">{plan.description}</p>
                            </div>
                          </div>
                          <div className="text-right">
                            <span className="text-2xl font-bold text-white">EUR {plan.price}</span>
                            <span className="text-sm text-[rgb(var(--muted))]">{plan.period}</span>
                          </div>
                        </div>
                        <Button
                          onClick={() => handleReactivate(plan.id)}
                          disabled={reactivating !== null}
                          className="mt-4 w-full"
                        >
                          {reactivating === plan.id ? 'Setting up...' : 'Select plan'}
                        </Button>
                      </div>
                    )
                  })}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowPlanSelection(false)}
                  disabled={reactivating !== null}
                  className="w-full"
                >
                  Cancel
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Change plan dialog */}
      {showChangePlanDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(var(--background))]/80 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-lg rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-6 space-y-4">
            {changePlanSuccess ? (
              <>
                <h2 className="text-lg font-semibold text-[rgb(var(--foreground))]">Plan changed</h2>
                <p className="text-sm text-[rgb(var(--foreground))]">
                  You are now on the {changePlanSuccess.plan.endsWith('_annual') ? 'Annual' : 'Monthly'} plan.
                  {changePlanSuccess.prorated
                    ? ' The change is effective immediately and your account has been prorated.'
                    : ` The change takes effect on ${formatDate(changePlanSuccess.effectiveDate)}.`}
                </p>
                <Button
                  size="sm"
                  onClick={() => { setShowChangePlanDialog(false); setChangePlanSuccess(null) }}
                  className="w-full"
                >
                  Done
                </Button>
              </>
            ) : selectedChangePlan ? (
              /* Confirmation step */
              (() => {
                const targetPlan = REACTIVATION_PLANS.find(p => p.id === selectedChangePlan)!
                const isAnnualSwitch = selectedChangePlan.endsWith('_annual')
                const isLeavingEarlyAdopter = isEarlyAdopterPlan && selectedChangePlan.startsWith('standard_')
                return (
                  <>
                    <h2 className="text-lg font-semibold text-[rgb(var(--foreground))]">Confirm plan change</h2>
                    <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--background))] p-4 space-y-2">
                      <p className="text-sm text-[rgb(var(--foreground))]">
                        Switch to <span className="font-medium">{targetPlan.name}</span> at{' '}
                        <span className="font-medium">&euro;{targetPlan.price}{targetPlan.period}</span>
                      </p>
                      <p className="text-xs text-[rgb(var(--muted))]">
                        {isAnnualSwitch
                          ? 'You will be charged the prorated difference immediately.'
                          : `Your new plan takes effect at your next billing date${data.renewalDate ? ` (${formatDate(data.renewalDate)})` : ''}.`}
                      </p>
                    </div>
                    {isLeavingEarlyAdopter && (
                      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
                        <div className="flex items-start gap-2">
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                          <p className="text-sm text-amber-400">
                            Switching to Standard will forfeit your Early Adopter rate. This cannot be undone.
                          </p>
                        </div>
                        <label className="flex items-center gap-2 text-sm text-[rgb(var(--foreground))] cursor-pointer">
                          <input
                            type="checkbox"
                            checked={earlyAdopterForfeitConfirmed}
                            onChange={(e) => setEarlyAdopterForfeitConfirmed(e.target.checked)}
                            className="rounded border-[rgb(var(--border))]"
                          />
                          I understand and want to proceed
                        </label>
                      </div>
                    )}
                    {changePlanError && (
                      <p className="text-xs text-red-400">{changePlanError}</p>
                    )}
                    <div className="flex gap-3 pt-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => { setSelectedChangePlan(null); setChangePlanError(null); setEarlyAdopterForfeitConfirmed(false) }}
                        disabled={changingPlan}
                      >
                        Back
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => handleChangePlan(selectedChangePlan)}
                        disabled={changingPlan || (isLeavingEarlyAdopter && !earlyAdopterForfeitConfirmed)}
                      >
                        {changingPlan ? (
                          <span className="flex items-center gap-2">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Switching&hellip;
                          </span>
                        ) : (
                          'Confirm switch'
                        )}
                      </Button>
                    </div>
                  </>
                )
              })()
            ) : (
              /* Plan selection step */
              <>
                <h2 className="text-lg font-semibold text-[rgb(var(--foreground))]">Change plan</h2>
                <div className="grid gap-3">
                  {availablePlans.map((plan) => {
                    const Icon = plan.icon
                    const isCurrent = plan.id === data.plan
                    return (
                      <button
                        key={plan.id}
                        disabled={isCurrent}
                        onClick={() => { setSelectedChangePlan(plan.id); setChangePlanError(null); setEarlyAdopterForfeitConfirmed(false) }}
                        className={`w-full rounded-lg border p-4 text-left transition-colors ${
                          isCurrent
                            ? 'border-emerald-500 bg-emerald-500/5 cursor-default'
                            : 'border-[rgb(var(--border))] hover:border-[rgb(var(--primary))]/50 hover:bg-[rgb(var(--primary))]/5 cursor-pointer'
                        }`}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex items-start gap-3">
                            <div className="mt-0.5 rounded-lg bg-[rgb(var(--border))] p-2">
                              <Icon className="h-5 w-5 text-[rgb(var(--primary))]" />
                            </div>
                            <div>
                              <div className="flex items-center gap-2">
                                <h3 className="font-medium text-[rgb(var(--foreground))]">{plan.name}</h3>
                                {isCurrent && (
                                  <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-400">
                                    <Check className="h-3 w-3" /> Current
                                  </span>
                                )}
                                {'badge' in plan && plan.badge && !isCurrent && (
                                  <span className="rounded-full bg-[rgb(var(--primary))]/10 px-2 py-0.5 text-xs font-medium text-[rgb(var(--primary))]">
                                    {plan.badge}
                                  </span>
                                )}
                              </div>
                              <p className="mt-0.5 text-sm text-[rgb(var(--muted))]">{plan.description}</p>
                              {!isCurrent && (
                                <p className="mt-1 text-xs text-[rgb(var(--muted))]">
                                  {plan.id.endsWith('_annual')
                                    ? 'Prorated charge applies immediately'
                                    : 'Takes effect at next billing date'}
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <span className={`text-xl font-bold ${isCurrent ? 'text-emerald-400' : 'text-[rgb(var(--foreground))]'}`}>
                              &euro;{plan.price}
                            </span>
                            <span className="text-sm text-[rgb(var(--muted))]">{plan.period}</span>
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowChangePlanDialog(false)}
                  className="w-full"
                >
                  Cancel
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Success toast */}
      {changePlanToast && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 shadow-lg backdrop-blur-sm">
          <p className="text-sm font-medium text-emerald-400">{changePlanToast}</p>
        </div>
      )}
    </div>
  )
}
