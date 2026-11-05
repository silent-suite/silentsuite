'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button } from '@silentsuite/ui'
import { Input } from '@silentsuite/ui'
import { useAuthStore, type User } from '@/app/stores/use-auth-store'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { isSelfHosted, isCustomServer } from '@/app/lib/self-hosted'
import { BILLING_API_URL, ETEBASE_SERVER_URL } from '@/app/lib/config'
import { getAccountEpoch, isCurrentAccountEpoch } from '@/app/lib/account-epoch'
import {
  buildRestoreDiagnosticsCopyText,
  canExposeRestoreDiagnosticsCopy,
  readRestoreDiagnostics,
} from '@/app/lib/sync-restore-diagnostics'

// ---------------------------------------------------------------------------
// Account mode for this session
// ---------------------------------------------------------------------------

/**
 * 'hosted': a SilentSuite-hosted account with a billing session.
 * 'local': an account on a self-hosted server, either from a self-hosted build
 * or from the hosted web app connected to a custom server. Billing has no
 * account for it.
 * 'unresolved': not known yet (before mount, no user, unreadable storage).
 * Account actions that touch billing are only offered for 'hosted'.
 */
type AccountMode = 'hosted' | 'local' | 'unresolved'

const SERVER_URL_KEY = 'silentsuite-server-url'

/** The stored custom server URL; undefined when storage cannot be read. */
function readStoredServerUrl(): string | null | undefined {
  try {
    if (typeof window === 'undefined') return undefined
    return window.localStorage.getItem(SERVER_URL_KEY)
  } catch {
    return undefined
  }
}

function classifyAccountMode(user: User | null | undefined): AccountMode {
  if (isSelfHosted) return 'local'
  if (!user) return 'unresolved'
  // Only local-server login, refresh and signup paths set this marker.
  if (user.id === 'self-hosted') return 'local'
  const stored = readStoredServerUrl()
  if (stored === undefined) return 'unresolved'
  return isCustomServer(stored ?? undefined) ? 'local' : 'hosted'
}

/**
 * The Etebase server for this session's account, or null when it cannot be
 * confirmed. Never falls back to the hosted server for a self-hosted account.
 */
function resolveAccountServerUrl(mode: AccountMode): string | null {
  if (mode === 'hosted') return ETEBASE_SERVER_URL
  if (mode !== 'local') return null
  const stored = readStoredServerUrl()
  // Unreadable storage leaves the chosen server unknown; only an absent value
  // means the build's own server.
  if (stored === undefined) return null
  if (isSelfHosted) return stored || ETEBASE_SERVER_URL
  return stored && isCustomServer(stored) ? stored : null
}

/** The account an action started for: the signed-in user object and its epoch. */
interface AccountOwner {
  user: User | null
  epoch: number
}

function captureAccountOwner(): AccountOwner {
  return { user: useAuthStore.getState().user, epoch: getAccountEpoch() }
}

/**
 * True while the same signed-in user object is current in the same account
 * epoch, and no other tab has logged out since.
 */
function isAccountOwner(owner: AccountOwner): boolean {
  return useAuthStore.getState().user === owner.user && isCurrentAccountEpoch(owner.epoch)
}

/**
 * Server output and the first client render agree ('local' for self-hosted
 * builds, otherwise 'unresolved'); browser storage is only read after mount.
 */
function useAccountMode(user: User | null): AccountMode {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return isSelfHosted ? 'local' : 'unresolved'
  return classifyAccountMode(user)
}

// ---------------------------------------------------------------------------
// Validation (same rules as signup)
// ---------------------------------------------------------------------------

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .regex(/[A-Z]/, 'Must contain an uppercase letter')
      .regex(/[a-z]/, 'Must contain a lowercase letter')
      .regex(/[0-9]/, 'Must contain a number'),
    confirmNewPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmNewPassword, {
    message: 'Passwords do not match',
    path: ['confirmNewPassword'],
  })

type PasswordFormData = z.infer<typeof passwordSchema>

// ---------------------------------------------------------------------------
// Account Fingerprint Section
// ---------------------------------------------------------------------------

function AccountFingerprintSection() {
  const t = useTranslations('SettingsSecurity.AccountFingerprint')
  const fingerprint = useEtebaseStore((s) => s.accountFingerprint)
  const [revealed, setRevealed] = useState(false)
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')

  const copyFingerprint = async () => {
    if (!fingerprint) return

    try {
      await navigator.clipboard.writeText(fingerprint)
      setCopyStatus('copied')
    } catch {
      setCopyStatus('failed')
    }

    window.setTimeout(() => setCopyStatus('idle'), 2000)
  }

  return (
    <section className="rounded-lg border border-[rgb(var(--border))] p-4 space-y-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold text-[rgb(var(--foreground))]">{t('title')}</h2>
        <p className="text-xs text-[rgb(var(--muted))]">
          {t('description')}
        </p>
      </div>

      <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-3 space-y-3">
        <code className="block whitespace-pre-wrap break-words font-mono text-xs text-[rgb(var(--foreground))]">
          {fingerprint ? (revealed ? fingerprint : t('hidden')) : t('unavailable')}
        </code>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!fingerprint}
            onClick={() => setRevealed((value) => !value)}
          >
            {revealed ? t('hide') : t('reveal')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!fingerprint || !revealed}
            onClick={copyFingerprint}
          >
            {copyStatus === 'copied' ? t('copied') : copyStatus === 'failed' ? t('copyFailed') : t('copy')}
          </Button>
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Restore Diagnostics Section
// ---------------------------------------------------------------------------

function RestoreDiagnosticsSection() {
  const t = useTranslations('SettingsSecurity.RestoreDiagnostics')
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const canCopyDiagnostics = canExposeRestoreDiagnosticsCopy()

  if (!canCopyDiagnostics) return null

  const copyDiagnostics = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard API unavailable')
      await navigator.clipboard.writeText(buildRestoreDiagnosticsCopyText(readRestoreDiagnostics()))
      setCopyStatus('copied')
    } catch {
      setCopyStatus('failed')
    }

    window.setTimeout(() => setCopyStatus('idle'), 2000)
  }

  return (
    <section className="rounded-lg border border-[rgb(var(--border))] p-4 space-y-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold text-[rgb(var(--foreground))]">{t('title')}</h2>
        <p className="text-xs text-[rgb(var(--muted))]">
          {t('description')}
        </p>
      </div>
      <Button type="button" variant="secondary" size="sm" onClick={copyDiagnostics}>
        {copyStatus === 'copied' ? t('copied') : copyStatus === 'failed' ? t('copyFailed') : t('copy')}
      </Button>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Change Password Section
// ---------------------------------------------------------------------------

function ChangePasswordSection() {
  const [success, setSuccess] = useState(false)
  const [apiError, setApiError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<PasswordFormData>({
    resolver: zodResolver(passwordSchema) as any,
    mode: 'onBlur',
  })

  const onSubmit = async (data: PasswordFormData) => {
    setSuccess(false)
    setApiError(null)

    try {
      const { user } = useAuthStore.getState()
      const email = user?.email
      if (!email) {
        throw new Error('Unable to determine your account email. Please sign in again.')
      }
      const mode = classifyAccountMode(user)
      const serverUrl = resolveAccountServerUrl(mode)
      if (!serverUrl) {
        throw new Error("We couldn't confirm which server this account uses. Please sign in again.")
      }
      // Every later step must still act for this account; another login or a
      // logout in another tab can happen while this flow is waiting.
      const owner = captureAccountOwner()
      const accountChanged = () => new Error('Your account changed during the password update. Please sign in again.')

      const core = await import('@silentsuite/core')

      // 1. Verify the current password by attempting a login
      let testAccount: Awaited<ReturnType<typeof core.logIn>> | null = null
      try {
        testAccount = await core.logIn(serverUrl, email, data.currentPassword)
      } catch {
        throw new Error('Current password is incorrect')
      }

      // Clean up the test session
      try {
        await core.logout(testAccount)
      } catch {
        // Non-critical — proceed even if cleanup fails
      }

      // 2. Change the Etebase password using the live account
      if (!isAccountOwner(owner)) throw accountChanged()
      const { account } = useEtebaseStore.getState()
      if (!account) {
        throw new Error('Etebase session not available. Please sign in again.')
      }

      try {
        await core.changePassword(account, data.newPassword)
      } catch {
        throw new Error('Failed to change password. Please try again.')
      }

      // 3. Re-save the session after password change
      const { secureSet, secureRemoveIfEqual } = await import('@/app/lib/secure-storage')
      const newSession = await core.saveSession(account)
      if (!isAccountOwner(owner)) throw accountChanged()
      await secureSet('etebase_session', newSession)
      if (!isAccountOwner(owner)) {
        // The write cannot be cancelled once started. Remove it only if it is
        // still the stored value, so a newer account's later write survives;
        // a newer value this write already replaced cannot be restored here.
        await secureRemoveIfEqual('etebase_session', newSession)
        throw accountChanged()
      }

      // 4. Notify billing API to invalidate other sessions. Billing has no
      // account for a self-hosted session; on the hosted web app the existing
      // warning stays, since nothing here signs other sessions out.
      const stillHosted = mode === 'hosted' && classifyAccountMode(useAuthStore.getState().user) === 'hosted'
      let billingWarning = (mode === 'local' && !isSelfHosted) || (mode === 'hosted' && !stillHosted)
      if (stillHosted) {
        try {
          const res = await fetch(`${BILLING_API_URL}/account/password`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
            credentials: 'include',
          })

          if (!res.ok) {
            billingWarning = true
          }
        } catch {
          billingWarning = true
        }
      }

      setSuccess(true)
      if (billingWarning) {
        setApiError('Password changed, but other sessions may not have been signed out.')
      }
      reset()
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'Something went wrong')
    }
  }

  return (
    <section className="rounded-lg border border-[rgb(var(--border))] p-4 space-y-4">
      <h2 className="text-sm font-semibold text-[rgb(var(--foreground))]">Change Password</h2>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
        <div className="space-y-1">
          <label htmlFor="currentPassword" className="block text-xs text-[rgb(var(--muted))]">
            Current password
          </label>
          <Input id="currentPassword" type="password" {...register('currentPassword')} />
          {errors.currentPassword && (
            <p className="text-xs text-red-400">{errors.currentPassword.message}</p>
          )}
        </div>

        <div className="space-y-1">
          <label htmlFor="newPassword" className="block text-xs text-[rgb(var(--muted))]">
            New password
          </label>
          <Input id="newPassword" type="password" {...register('newPassword')} />
          {errors.newPassword && (
            <p className="text-xs text-red-400">{errors.newPassword.message}</p>
          )}
        </div>

        <div className="space-y-1">
          <label htmlFor="confirmNewPassword" className="block text-xs text-[rgb(var(--muted))]">
            Confirm new password
          </label>
          <Input id="confirmNewPassword" type="password" {...register('confirmNewPassword')} />
          {errors.confirmNewPassword && (
            <p className="text-xs text-red-400">{errors.confirmNewPassword.message}</p>
          )}
        </div>

        {apiError && <p className="text-xs text-red-400">{apiError}</p>}
        {success && <p className="text-xs text-[rgb(var(--primary))]">Password updated successfully. Other sessions have been signed out.</p>}

        <Button type="submit" disabled={isSubmitting} size="sm">
          {isSubmitting ? 'Updating...' : 'Update password'}
        </Button>
      </form>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Delete Account Section
// ---------------------------------------------------------------------------

function DeleteAccountSection({ mode }: { mode: 'hosted' | 'local' }) {
  const router = useRouter()
  const { logout } = useAuthStore()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ownerRef = useRef<AccountOwner | null>(null)
  // Self-hosted accounts cannot be erased from here; the action only signs out.
  const isLocal = mode === 'local'
  const confirmToken = isLocal ? 'SIGNOUT' : 'DELETE'

  const handleDelete = async () => {
    // The dialog was opened for one account; act only if it is still current
    // and still classified the same way.
    const owner = ownerRef.current
    if (!owner || !isAccountOwner(owner) || classifyAccountMode(owner.user) !== mode) {
      setError('Your account changed. Close this dialog and try again.')
      return
    }

    setDeleting(true)
    setError(null)

    // logout() clears the user before it yields, so a signed-in user after it
    // returns is a newer account that must not be redirected.
    const signOutAndLeave = async () => {
      await logout()
      if (useAuthStore.getState().user === null) router.push('/')
    }

    try {
      if (isLocal) {
        await signOutAndLeave()
        return
      }

      const res = await fetch(`${BILLING_API_URL}/account`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: confirmText }),
        credentials: 'include',
      })

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.detail ?? 'Failed to delete account')
      }

      // The DELETE already went out with the session it was sent under; never
      // sign out an account that became current while it was pending.
      if (!isAccountOwner(owner)) return

      // Clear local auth state
      await signOutAndLeave()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setDeleting(false)
    }
  }

  return (
    <>
      <section className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-red-400">Danger Zone</h2>
        <p className="text-xs text-[rgb(var(--muted))]">
          {isLocal
            ? "Self-hosted accounts can't be deleted from here. Signing out removes this device's session and locally cached data, including changes not yet synced. Your account and data on your server are not deleted."
            : 'This action is permanent. All your data will be deleted and cannot be recovered.'}
        </p>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => {
            ownerRef.current = captureAccountOwner()
            setDialogOpen(true)
          }}
        >
          {isLocal ? 'Sign out of this device' : 'Delete my account'}
        </Button>
      </section>

      {dialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-sm rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--background))] p-6 shadow-xl space-y-4">
            <h3 className="text-sm font-semibold text-[rgb(var(--foreground))]">
              {isLocal ? 'Confirm sign out' : 'Confirm Account Deletion'}
            </h3>
            <p className="text-xs text-[rgb(var(--muted))]">
              Type <span className="font-mono font-semibold text-red-400">{confirmToken}</span> to confirm.
            </p>

            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={`Type ${confirmToken}`}
              autoFocus
            />

            {error && <p className="text-xs text-red-400">{error}</p>}

            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDialogOpen(false)
                  setConfirmText('')
                  setError(null)
                }}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={confirmText !== confirmToken || deleting}
                onClick={handleDelete}
              >
                {isLocal
                  ? (deleting ? 'Signing out...' : 'Sign out')
                  : (deleting ? 'Deleting...' : 'Confirm Delete')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Security Page
// ---------------------------------------------------------------------------

export default function SecurityPage() {
  const user = useAuthStore((s) => s.user)
  const accountMode = useAccountMode(user)
  return (
    <div className="space-y-6">
      <AccountFingerprintSection />
      <RestoreDiagnosticsSection />
      <ChangePasswordSection />
      {accountMode !== 'unresolved' && (
        // Remount on a mode or account change so an open dialog never carries over.
        <DeleteAccountSection key={`${accountMode}:${user?.id ?? 'none'}`} mode={accountMode} />
      )}
    </div>
  )
}
