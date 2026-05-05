'use client'

import { useState, useEffect, useRef } from 'react'
import { MailWarning, Loader2 } from 'lucide-react'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { isSelfHosted } from '@/app/lib/self-hosted'
import { BILLING_API_URL } from '@/app/lib/config'

// Minimum gap between focus-triggered refreshes. Cheap guard against burst
// refreshes when the tab visibility flickers (e.g. fast alt-tab) or when
// React strict mode double-invokes the effect in dev.
const REFRESH_THROTTLE_MS = 5_000

export function EmailVerificationBanner() {
  const user = useAuthStore((s) => s.user)
  const refreshSession = useAuthStore((s) => s.refreshSession)
  const [resending, setResending] = useState(false)
  const [resent, setResent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastRefreshRef = useRef(0)

  const shouldShow = !isSelfHosted && user && user.emailVerified === false

  // When the banner is mounted (i.e. the user is signed in but unverified),
  // re-check the session whenever the tab regains focus. This handles the
  // common path of "user clicks the verify link in a new tab → comes back
  // here" — without this, the banner sticks until a hard reload because
  // refreshSession() otherwise only runs once on initial app mount.
  useEffect(() => {
    if (!shouldShow) return

    const maybeRefresh = () => {
      if (document.visibilityState !== 'visible') return
      const now = Date.now()
      if (now - lastRefreshRef.current < REFRESH_THROTTLE_MS) return
      lastRefreshRef.current = now
      void refreshSession()
    }

    document.addEventListener('visibilitychange', maybeRefresh)
    window.addEventListener('focus', maybeRefresh)
    return () => {
      document.removeEventListener('visibilitychange', maybeRefresh)
      window.removeEventListener('focus', maybeRefresh)
    }
  }, [shouldShow, refreshSession])

  // Don't show for self-hosted, unauthenticated, or already verified
  if (!shouldShow) {
    return null
  }

  const handleResend = async () => {
    setResending(true)
    setError(null)
    try {
      const res = await fetch(`${BILLING_API_URL}/auth/resend-verification`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      })
      if (res.ok) {
        setResent(true)
      } else if (res.status === 429) {
        setError('Too many requests. Please try again later.')
      } else {
        setError('Could not send verification email. Please try again.')
      }
    } catch {
      setError('Network error. Please check your connection.')
    } finally {
      setResending(false)
    }
  }

  return (
    <div role="alert" className="flex items-center gap-3 px-4 py-2 bg-amber-500/10 border-b border-amber-500/20 text-amber-800 dark:text-amber-200 text-sm">
      <MailWarning className="w-4 h-4 text-amber-400 shrink-0" />
      <span className="flex-1 text-xs">
        {resent
          ? 'Verification email sent. Check your inbox.'
          : 'Please verify your email address to ensure you receive important account notifications.'}
      </span>
      {!resent && (
        <button
          onClick={handleResend}
          disabled={resending}
          className="shrink-0 text-xs font-medium text-amber-400 hover:text-amber-300 underline underline-offset-2 disabled:opacity-50"
        >
          {resending ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            'Resend email'
          )}
        </button>
      )}
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  )
}
