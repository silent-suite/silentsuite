'use client'

import { Lock, WifiOff, RefreshCw } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { useSyncStore } from '@/app/stores/use-sync-store'
import { ENDED_TITLES, type EndedHistory } from '@/app/lib/account-notice'

// Same words as the recovery button on /settings/subscription, where this link goes.
const PLAN_ACTION_LABELS: Record<EndedHistory, string> = {
  trial: 'Subscribe',
  subscription: 'Reactivate',
  unpaid: 'Subscribe',
}

/**
 * Non-blocking banner shown when subscription has ended.
 * User retains read access but cannot create/update/delete.
 */
export function ReadOnlyBanner() {
  const subscriptionStatus = useAuthStore((s) => s.subscriptionStatus)
  const hostedAccess = useAuthStore((s) => s.hostedAccess)
  const endedHistory = useAuthStore((s) => s.endedHistory)
  const pathname = usePathname()

  // Billing's read names what ended; without one, the status alone decides as before.
  const history = endedHistory
    ?? (subscriptionStatus === 'none' || (subscriptionStatus === 'trialing' && hostedAccess === 'trial_ended')
      ? 'trial'
      : 'subscription')
  const title = ENDED_TITLES[history]

  // The subscription page's own card already says this and offers the same action.
  if (pathname === '/settings/subscription') return null

  return (
    <div className="mx-3 mt-2 flex flex-col gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200 sm:flex-row sm:items-center md:mx-4">
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span>
          {title} Your data is safe and read-only.
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <Link
          href="/settings/subscription"
          className="inline-flex items-center gap-1.5 rounded-lg bg-amber-700 px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-amber-800 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 dark:bg-amber-400 dark:text-amber-950 dark:hover:bg-amber-300"
        >
          {PLAN_ACTION_LABELS[history]}
        </Link>
        <Link
          href="/settings/export"
          className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-[rgb(var(--muted))] transition-colors hover:bg-amber-500/20"
        >
          Export data
        </Link>
      </div>
    </div>
  )
}

/**
 * Non-blocking banner shown when billing API is unreachable.
 * User retains full read + write access (degraded mode).
 * Hidden while the browser is offline: billing is then unreachable because the
 * device has no connection, not because the billing service is down.
 */
export function DegradedModeBanner() {
  const retryBillingConnection = useAuthStore((s) => s.retryBillingConnection)
  const isOnline = useSyncStore((s) => s.isOnline)
  const [isRetrying, setIsRetrying] = useState(false)

  const handleRetry = async () => {
    setIsRetrying(true)
    try {
      await retryBillingConnection()
    } finally {
      setIsRetrying(false)
    }
  }

  if (!isOnline) return null

  return (
    <div className="mx-3 mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-sm text-blue-800 dark:text-blue-200 md:mx-4">
      <WifiOff className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
      <span className="flex-1">
        Billing service temporarily unavailable. Your data is safe.
      </span>
      <button
        onClick={handleRetry}
        disabled={isRetrying}
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-500/20 disabled:opacity-50 dark:text-blue-300"
      >
        <RefreshCw className={`h-3 w-3 ${isRetrying ? 'animate-spin' : ''}`} />
        {isRetrying ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  )
}
