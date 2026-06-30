'use client'

import { useState, useEffect, useRef, type FormEvent } from 'react'
import { MailWarning, Loader2 } from 'lucide-react'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { isSelfHosted } from '@/app/lib/self-hosted'
import { BILLING_API_URL } from '@/app/lib/config'
import { normalizeEmailForComparison, signupEmailSchema } from '@/app/lib/email-recovery'

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
  const [showChangeEmail, setShowChangeEmail] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [confirmNewEmail, setConfirmNewEmail] = useState('')
  const [changingEmail, setChangingEmail] = useState(false)
  const [changeSuccess, setChangeSuccess] = useState<string | null>(null)
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

  const handleChangeEmail = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setChangeSuccess(null)

    const parsed = signupEmailSchema.safeParse({ email: newEmail, confirmEmail: confirmNewEmail })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a valid email address.')
      return
    }

    const normalizedEmail = normalizeEmailForComparison(parsed.data.email)
    setChangingEmail(true)
    try {
      const res = await fetch(`${BILLING_API_URL}/account/email/change`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ email: normalizedEmail }),
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => null)
        if (res.status === 429) {
          throw new Error('Too many requests. Please try again later.')
        }
        throw new Error(errData?.detail ?? 'Could not change email. Please try again.')
      }
      const data = await res.json().catch(() => null)
      const updatedEmail = normalizeEmailForComparison(data?.email ?? normalizedEmail)
      setNewEmail('')
      setConfirmNewEmail('')
      setResent(false)
      setChangeSuccess(
        data?.sent === false
          ? `Email changed to ${updatedEmail}, but the verification email could not be sent. Try Resend email in a moment.`
          : `Verification email sent to ${updatedEmail}.`,
      )
      await refreshSession()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change email. Please try again.')
    } finally {
      setChangingEmail(false)
    }
  }

  return (
    <div className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-sm text-amber-800 dark:text-amber-200">
      <div role="alert" className="flex items-center gap-3">
        <MailWarning className="w-4 h-4 text-amber-400 shrink-0" />
        <span className="flex-1 text-xs">
          {changeSuccess
            ? changeSuccess
            : resent
              ? 'Verification email sent. Check your inbox.'
              : 'Please verify your email so you can receive account and billing messages.'}
        </span>
        {!resent && !changeSuccess && (
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
        <button
          onClick={() => {
            setShowChangeEmail((value) => !value)
            setError(null)
            setChangeSuccess(null)
          }}
          className="shrink-0 text-xs font-medium text-amber-400 hover:text-amber-300 underline underline-offset-2"
        >
          Change email
        </button>
      </div>

      {showChangeEmail && (
        <form onSubmit={handleChangeEmail} className="mt-3 grid gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 sm:grid-cols-2">
          <p className="text-xs text-amber-900 dark:text-amber-100 sm:col-span-2">
            This changes the email we use for account and billing messages. Your current login email may stay the same for now.
          </p>
          <div className="space-y-1">
            <label htmlFor="account-contact-email" className="block text-xs font-medium">
              New email
            </label>
            <input
              id="account-contact-email"
              type="email"
              value={newEmail}
              onChange={(event) => setNewEmail(event.target.value)}
              className="w-full rounded-md border border-amber-500/30 bg-white/80 px-2 py-1.5 text-sm text-slate-900 dark:bg-slate-950/80 dark:text-slate-100"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="account-contact-email-confirm" className="block text-xs font-medium">
              Confirm new email
            </label>
            <input
              id="account-contact-email-confirm"
              type="email"
              value={confirmNewEmail}
              onChange={(event) => setConfirmNewEmail(event.target.value)}
              className="w-full rounded-md border border-amber-500/30 bg-white/80 px-2 py-1.5 text-sm text-slate-900 dark:bg-slate-950/80 dark:text-slate-100"
            />
          </div>
          <div className="flex items-center gap-3 sm:col-span-2">
            <button
              type="submit"
              disabled={changingEmail}
              className="rounded-md bg-amber-500 px-3 py-1.5 text-xs font-medium text-slate-950 hover:bg-amber-400 disabled:opacity-50"
            >
              {changingEmail ? 'Saving...' : 'Save email'}
            </button>
            <button
              type="button"
              onClick={() => setShowChangeEmail(false)}
              className="text-xs font-medium text-amber-700 underline underline-offset-2 hover:text-amber-600 dark:text-amber-300 dark:hover:text-amber-200"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && <p className="mt-2 text-xs text-red-500 dark:text-red-400">{error}</p>}
    </div>
  )
}
