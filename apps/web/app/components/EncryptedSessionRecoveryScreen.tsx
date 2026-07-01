'use client'

import { LockKeyhole, LogOut } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { Button } from '@silentsuite/ui'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { useSyncStore } from '@/app/stores/use-sync-store'

export function EncryptedSessionRecoveryScreen() {
  const router = useRouter()
  const blocker = useSyncStore((s) => s.initialSyncBlocker)
  const error = useSyncStore((s) => s.error)
  const logout = useAuthStore((s) => s.logout)

  if (!blocker) return null

  const detail = blocker === 'missing-encrypted-session'
    ? 'This browser could not find the encrypted vault keys needed to read your calendars, tasks, and contacts.'
    : 'This browser could not restore the encrypted vault keys needed to read your calendars, tasks, and contacts.'

  const unlock = () => {
    router.push(`/login?reason=unlock&returnTo=${encodeURIComponent('/calendar')}`)
  }

  return (
    <section
      aria-labelledby="encrypted-session-recovery-title"
      className="mx-auto flex min-h-full max-w-2xl flex-col items-center justify-center px-4 py-12 text-center"
    >
      <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400">
        <LockKeyhole className="h-7 w-7" aria-hidden="true" />
      </div>

      <div className="space-y-3">
        <p className="text-sm font-medium uppercase tracking-wide text-emerald-400">You are signed in</p>
        <h1 id="encrypted-session-recovery-title" className="text-2xl font-semibold text-[rgb(var(--foreground))] md:text-3xl">
          Unlock your encrypted data
        </h1>
        <p className="text-base text-[rgb(var(--muted))]">
          {detail} Your data has not been deleted. Sign in again to unlock it on this browser.
        </p>
        {error && (
          <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {error}
          </p>
        )}
      </div>

      <div className="mt-7 flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:justify-center">
        <Button type="button" onClick={unlock} className="w-full sm:w-auto">
          Sign in again to unlock data
        </Button>
        <Button type="button" variant="outline" onClick={() => void logout()} className="w-full gap-2 sm:w-auto">
          <LogOut className="h-4 w-4" aria-hidden="true" />
          Sign out
        </Button>
      </div>

      <p className="mt-6 max-w-xl text-sm text-[rgb(var(--muted))]">
        Encryption keys stay local to this browser or device. Signing in again recreates the local encrypted session so SilentSuite can decrypt your data here.
      </p>
    </section>
  )
}
