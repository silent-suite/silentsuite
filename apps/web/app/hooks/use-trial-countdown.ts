'use client'

import { useEffect, useState } from 'react'
import { DAY_MS, trialDaysLeft, type AccountNotice } from '@/app/lib/account-notice'
import { isCustomServer, isSelfHosted } from '@/app/lib/self-hosted'
import { useAuthStore } from '@/app/stores/use-auth-store'

const MAX_TIMEOUT_MS = 2_147_483_647

export interface TrialCountdown {
  daysLeft: number
  trialEndsAt: string
}

export function formatDaysLeft(days: number): string {
  return `${days} day${days === 1 ? '' : 's'} left`
}

/**
 * Client-clock countdown for a running seven-day no-card trial. It only holds timers: at the
 * next day boundary it re-renders, and at the end instant it hides itself and claims the
 * store's single shared refresh. It never shows "ended" on its own.
 */
export function useTrialCountdown(notice: AccountNotice | null): TrialCountdown | null {
  const trialEndsAt = notice?.kind === 'trial_days_left' ? notice.trialEndsAt : null
  const endMs = trialEndsAt ? Date.parse(trialEndsAt) : Number.NaN
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!trialEndsAt) return
    const current = Date.now()
    const left = trialDaysLeft(endMs, current)
    if (trialDaysLeft(endMs, now) !== left) setNow(current)
    if (left === 0) {
      useAuthStore.getState().claimTrialExpiryRefresh(trialEndsAt)
      return
    }
    const nextBoundary = endMs - (left - 1) * DAY_MS
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(Math.max(nextBoundary - current, 1000), MAX_TIMEOUT_MS))
    return () => window.clearTimeout(timer)
  }, [trialEndsAt, endMs, now])

  useEffect(() => {
    if (!trialEndsAt) return
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return
      const current = Date.now()
      setNow(current)
      // One refresh decision: a tab returning after the end instant makes the shared expiry
      // claim (deduplicated across consumers) instead of a separate stale-notice read.
      if (trialDaysLeft(endMs, current) === 0) useAuthStore.getState().claimTrialExpiryRefresh(trialEndsAt)
      else useAuthStore.getState().refreshStaleAccountNotice()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [trialEndsAt, endMs])

  if (!trialEndsAt) return null
  const daysLeft = trialDaysLeft(endMs, now)
  return daysLeft > 0 ? { daysLeft, trialEndsAt } : null
}

/**
 * The signed-in hosted account's countdown; admins and self-host builds get none. Custom
 * servers never receive a notice: the store's fetchSubscription clears it for them.
 */
export function useAccountTrialCountdown(): TrialCountdown | null {
  const notice = useAuthStore((state) => state.accountNotice)
  return useTrialCountdown(useEligibleAccountNotice(notice && typeof notice === 'object' ? notice : null))
}

/** Hosted Billing account: not a self-host build and no custom server chosen for this browser. */
export function isHostedBillingAccount(): boolean {
  if (isSelfHosted) return false
  const storedServerUrl = typeof window !== 'undefined' ? localStorage.getItem('silentsuite-server-url') : null
  return !isCustomServer(storedServerUrl ?? undefined)
}

/**
 * Shared by navigation and the subscription page: admins, self-host builds and custom-server
 * accounts get no notice, whatever a Billing response says. The server check runs only once
 * there is a notice to show.
 */
export function useEligibleAccountNotice(notice: AccountNotice | null): AccountNotice | null {
  const isAdmin = useAuthStore((state) => state.user?.isAdmin)
  if (!notice || isAdmin === true || !isHostedBillingAccount()) return null
  return notice
}
