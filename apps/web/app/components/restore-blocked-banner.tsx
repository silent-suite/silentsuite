'use client'

import { KeyRound } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'

/**
 * Non-blocking banner shown when the encrypted session could not be restored
 * on this browser (missing/invalid/corrupt local session). Reassuring, not an
 * error: the data is safe on the server; this browser just needs to unlock it
 * again. The CTA links to the loop-free unlock route. It never clears storage
 * and never calls logout().
 */
export function RestoreBlockedBanner() {
  const restoreBlocked = useEtebaseStore((s) => s.restoreBlocked)
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const pathname = usePathname()

  if (!restoreBlocked || !isAuthenticated) return null

  // Same-origin relative path only; fall back to /calendar.
  const returnTo = pathname && pathname.startsWith('/') && !pathname.includes('//') ? pathname : '/calendar'
  const href = `/login?reason=unlock&returnTo=${encodeURIComponent(returnTo)}`

  return (
    <div className="mx-3 mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200 md:mx-4">
      <KeyRound className="h-4 w-4 shrink-0 text-emerald-400" />
      <span className="flex-1">
        Your data is encrypted and safe on the server. This browser needs to unlock it again.
      </span>
      <Link
        href={href}
        className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2"
      >
        Unlock now
      </Link>
    </div>
  )
}
