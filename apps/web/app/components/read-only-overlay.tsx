'use client'

import { Lock, WifiOff, RefreshCw, ExternalLink } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { useAuthStore } from '@/app/stores/use-auth-store'

/**
 * Non-blocking banner shown when subscription has ended.
 * User retains read access but cannot create/update/delete.
 */
export function ReadOnlyBanner() {
  const subscriptionStatus = useAuthStore((s) => s.subscriptionStatus)

  const title =
    subscriptionStatus === 'none'
      ? 'Your trial has ended.'
      : 'Your subscription has ended.'

  return (
    <div className="mx-3 mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200 md:mx-4">
      <Lock className="h-4 w-4 shrink-0 text-amber-400" />
      <span className="flex-1">
        {title} Your data is safe and read-only.
      </span>
      <div className="flex items-center gap-3">
        <Link
          href="/settings/subscription"
          className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2"
        >
          Choose a plan
          <ExternalLink className="h-3.5 w-3.5" />
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
 */
export function DegradedModeBanner() {
  const retryBillingConnection = useAuthStore((s) => s.retryBillingConnection)
  const [isRetrying, setIsRetrying] = useState(false)

  const handleRetry = async () => {
    setIsRetrying(true)
    try {
      await retryBillingConnection()
    } finally {
      setIsRetrying(false)
    }
  }

  return (
    <div className="mx-3 mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-sm text-blue-200 md:mx-4">
      <WifiOff className="h-4 w-4 shrink-0 text-blue-400" />
      <span className="flex-1">
        Billing service temporarily unavailable. Your data is safe.
      </span>
      <button
        onClick={handleRetry}
        disabled={isRetrying}
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-blue-300 transition-colors hover:bg-blue-500/20 disabled:opacity-50"
      >
        <RefreshCw className={`h-3 w-3 ${isRetrying ? 'animate-spin' : ''}`} />
        {isRetrying ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  )
}
