'use client'

import Link from 'next/link'
import { Info } from 'lucide-react'
import { formatDaysLeft, useAccountTrialCountdown } from '@/app/hooks/use-trial-countdown'

/** Compact seven-day trial status, kept as its own link next to (never inside) Settings. */
export function TrialStatusLink({ expanded }: { expanded: boolean }) {
  const countdown = useAccountTrialCountdown()
  if (!countdown) return null
  const text = `Free trial · ${formatDaysLeft(countdown.daysLeft)}`

  return (
    <Link
      href="/settings/subscription"
      aria-label={`Free trial, ${formatDaysLeft(countdown.daysLeft)}. Subscription details`}
      className="group relative flex min-h-11 items-center gap-3 rounded-md px-2 py-2 text-sm text-amber-700 transition-colors hover:bg-[rgb(var(--background))] focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 dark:text-amber-400"
    >
      <Info className="h-5 w-5 shrink-0" aria-hidden="true" />
      {expanded ? (
        <span className="truncate">{text}</span>
      ) : (
        <span className="pointer-events-none absolute left-full ml-2 z-[100] hidden whitespace-nowrap rounded-md bg-[rgb(var(--foreground))] px-2 py-1 text-xs text-[rgb(var(--background))] shadow-lg group-hover:block group-focus-within:block">
          {text}
        </span>
      )}
    </Link>
  )
}
