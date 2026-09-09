'use client'

import { useEffect, useRef, useState } from 'react'
import { Shield, AlertTriangle, Lock } from 'lucide-react'

/**
 * The password-loss acknowledgement shared by every hosted path.
 *
 * SilentSuite is end-to-end encrypted: the user's password is the only
 * factor that unwraps their master key. We don't store it, can't reset it,
 * and currently have no recovery-key flow that wraps anything (see GitHub
 * issues for future work). This component's job is to make that contract
 * explicit before the user lands in the app — they tick a box acknowledging
 * that losing the password means losing access to encrypted data.
 *
 * Paid paths render it after their account exists (via `StepCreateVault`).
 * The no-card trial renders it *before* account creation, so the same
 * acknowledgement gates the only mutation on that path.
 */
export function PasswordKeyAcknowledgement({
  onContinue,
  busy = false,
  error,
  consequence,
  children,
}: {
  onContinue: () => void
  busy?: boolean
  error?: string | null
  /** One concise line stating what continuing does when it also creates the account. */
  consequence?: React.ReactNode
  children?: React.ReactNode
}) {
  const [acknowledged, setAcknowledged] = useState(false)

  return (
    <div className="space-y-6">
      <div className="text-center space-y-3">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border border-emerald-500/30 bg-emerald-500/10">
          <Shield className="h-8 w-8 text-emerald-500" />
        </div>
        <h2 className="text-lg sm:text-xl font-semibold text-[rgb(var(--foreground))]">
          Your password is your only key
        </h2>
        <p className="text-sm text-[rgb(var(--muted))]">
          SilentSuite is end-to-end encrypted. Your password unlocks your
          data on your devices — we never see it.
        </p>
      </div>

      <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
          <div className="space-y-2">
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">
              We can&apos;t reset your password or recover your data
            </p>
            <ul className="text-xs text-[rgb(var(--muted))] space-y-1 list-disc pl-4">
              <li>If you forget your password, your encrypted data cannot be recovered.</li>
              <li>
                Use a password manager. Pick something long and unique.
              </li>
              <li>
                You can change your password from Settings while signed in.
              </li>
            </ul>
          </div>
        </div>
      </div>

      <label className="flex items-start gap-3 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 cursor-pointer">
        <input
          type="checkbox"
          checked={acknowledged}
          disabled={busy}
          onChange={(e) => setAcknowledged(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-[rgb(var(--primary))] cursor-pointer"
        />
        <span className="text-sm text-[rgb(var(--foreground))]">
          I understand that SilentSuite cannot recover my password or
          decrypt my data on my behalf.
        </span>
      </label>

      {consequence && <p className="text-sm text-[rgb(var(--muted))]">{consequence}</p>}

      {error && (
        <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </div>
      )}

      <button
        onClick={onContinue}
        disabled={!acknowledged || busy}
        className="w-full rounded-lg bg-[rgb(var(--primary))] px-4 py-3 text-sm font-medium text-white hover:bg-[rgb(var(--primary-hover))] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {busy ? 'Creating your account...' : 'Continue to your workspace'}
      </button>

      {children}
    </div>
  )
}

/**
 * Step: Create Vault
 *
 * Shared between the main signup page, the 3DS redirect success page and
 * pending-payment recovery. Shows a brief key animation while the
 * (already-created) Etebase account settles, then the acknowledgement above.
 * When the caller already collected the acknowledgement before creating the
 * account (`acknowledged`), the step completes after the animation instead of
 * asking twice.
 */
export function StepCreateVault({
  email: _email,
  onComplete,
  acknowledged = false,
}: {
  email: string
  onComplete: () => void
  acknowledged?: boolean
}) {
  const [phase, setPhase] = useState<'creating' | 'acknowledge'>('creating')
  // Callers may pass a fresh callback each render; the settle timer must not restart.
  const completeRef = useRef(onComplete)
  completeRef.current = onComplete

  useEffect(() => {
    if (phase !== 'creating') return
    // Brief animation while the (already-created) Etebase account settles.
    const timer = setTimeout(() => {
      if (acknowledged) completeRef.current()
      else setPhase('acknowledge')
    }, 2500)
    return () => clearTimeout(timer)
  }, [acknowledged, phase])

  if (phase === 'creating') {
    return (
      <div className="flex flex-col items-center justify-center py-12 space-y-6">
        <div className="vault-pulse relative flex h-20 w-20 items-center justify-center rounded-2xl border border-emerald-500/30 bg-emerald-500/10">
          <Lock className="vault-lock h-10 w-10 text-emerald-500" />
          <div className="vault-ring absolute inset-0 rounded-2xl border-2 border-emerald-500/40" />
        </div>
        <p className="text-sm text-[rgb(var(--muted))] text-center">
          Generating your encryption keys...
        </p>

        <style jsx>{`
          .vault-pulse {
            animation: vaultPulse 1.5s ease-in-out infinite;
          }
          .vault-lock {
            animation: vaultLock 2s ease-in-out forwards;
          }
          .vault-ring {
            animation: vaultRing 1.5s ease-in-out infinite;
          }
          @keyframes vaultPulse {
            0%, 100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.3); }
            50% { box-shadow: 0 0 0 12px rgba(16, 185, 129, 0); }
          }
          @keyframes vaultLock {
            0% { opacity: 0.5; transform: scale(0.8); }
            50% { opacity: 1; transform: scale(1.1); }
            100% { opacity: 1; transform: scale(1); }
          }
          @keyframes vaultRing {
            0% { transform: scale(1); opacity: 0.3; }
            50% { transform: scale(1.15); opacity: 0; }
            100% { transform: scale(1); opacity: 0.3; }
          }
          @media (prefers-reduced-motion: reduce) {
            .vault-pulse,
            .vault-lock,
            .vault-ring {
              animation: none;
            }
            .vault-lock {
              opacity: 1;
              transform: scale(1);
            }
            .vault-ring {
              opacity: 0.3;
            }
          }
        `}</style>
      </div>
    )
  }

  return <PasswordKeyAcknowledgement onContinue={onComplete} />
}
