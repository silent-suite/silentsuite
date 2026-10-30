'use client'

import { useEffect, useState } from 'react'
import { DAY_MS, trialDaysLeft, type AccountNotice } from '@/app/lib/account-notice'
import { isSelfHosted } from '@/app/lib/self-hosted'
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
      setNow(Date.now())
      useAuthStore.getState().refreshStaleAccountNotice()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [trialEndsAt])

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
  const isAdmin = useAuthStore((state) => state.user?.isAdmin)
  const eligible = !isSelfHosted && isAdmin !== true
  return useTrialCountdown(eligible && notice && typeof notice === 'object' ? notice : null)
}
