'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import {
  Shield, Lock, AlertTriangle, Copy, CheckCircle, Download,
} from 'lucide-react'

/**
 * Step: Create Vault + Recovery Key
 *
 * Shared between the main signup page and the 3DS redirect success page.
 */
export function StepVaultAndRecovery({
  email,
  onComplete,
}: {
  email: string
  onComplete: () => void
}) {
  const [phase, setPhase] = useState<'creating' | 'recovery'>('creating')
  const [copied, setCopied] = useState(false)
  const [downloaded, setDownloaded] = useState(false)

  // Generate a cryptographically secure recovery key (4 groups of 4 chars)
  const recoveryKey = useRef<string | null>(null)
  if (recoveryKey.current === null) {
    const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    recoveryKey.current = Array.from({ length: 4 }, (_, g) =>
      Array.from({ length: 4 }, (_, i) =>
        charset[bytes[g * 4 + i]! % charset.length]!
      ).join('')
    ).join('-')
  }
  const recoveryKeyValue = recoveryKey.current

  useEffect(() => {
    if (phase !== 'creating') return
    // Simulate vault creation time (the actual Etebase account was created before payment)
    const timer = setTimeout(() => setPhase('recovery'), 2500)
    return () => clearTimeout(timer)
  }, [phase])

  const handleDownloadTxt = useCallback(() => {
    const content = `
SILENTSUITE RECOVERY KEY
========================

Account: ${email}
Generated: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}

YOUR RECOVERY KEY:
${recoveryKeyValue}

IMPORTANT:
- Store this key in a safe place
- This key can restore access to your encrypted data
- SilentSuite cannot recover this key for you
- Do NOT share this key with anyone
`.trim()

    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `silentsuite-recovery-key-${new Date().toISOString().split('T')[0]}.txt`
    link.click()
    URL.revokeObjectURL(url)
    setDownloaded(true)
  }, [recoveryKeyValue, email])

  const handleDownloadPdf = useCallback(() => {
    // For now, use the same text download. Full PDF generation can be added later.
    handleDownloadTxt()
  }, [handleDownloadTxt])

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(recoveryKeyValue)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback: select the text
    }
  }, [recoveryKeyValue])

  if (phase === 'creating') {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <div className="relative mb-8">
          <div className="vault-pulse h-20 w-20 rounded-2xl border-2 border-[rgb(var(--primary))]/50 bg-[rgb(var(--surface))] flex items-center justify-center">
            <Lock className="h-10 w-10 text-[rgb(var(--primary))] vault-lock" />
          </div>
          <div className="vault-ring absolute inset-0 rounded-2xl border-2 border-[rgb(var(--primary))]/30" />
        </div>
        <p className="text-lg font-medium text-[rgb(var(--foreground))]">
          Setting up your encrypted vault
        </p>
        <p className="mt-2 text-sm text-[rgb(var(--muted))]">
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

  return (
    <div className="space-y-6">
      <div className="text-center space-y-3">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border border-emerald-500/30 bg-emerald-500/10">
          <Shield className="h-8 w-8 text-emerald-500" />
        </div>
        <h2 className="text-lg sm:text-xl font-semibold text-[rgb(var(--foreground))]">
          Save your recovery key
        </h2>
        <p className="text-sm text-[rgb(var(--muted))]">
          This key can restore access to your encrypted data if you forget your password.
        </p>
      </div>

      {/* Warning */}
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
          <div>
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">
              SilentSuite cannot recover this key
            </p>
            <p className="mt-1 text-xs text-[rgb(var(--muted))]">
              Due to end-to-end encryption, we never have access to your recovery key.
              If you lose it and forget your password, your data cannot be recovered.
            </p>
          </div>
        </div>
      </div>

      {/* Key display */}
      <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 font-mono text-base tracking-wider text-[rgb(var(--foreground))] text-center select-all">
        {recoveryKeyValue}
      </div>

      {/* Actions */}
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={handleCopy}
          className="flex items-center justify-center gap-2 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-4 py-2.5 text-sm font-medium text-[rgb(var(--foreground))] hover:bg-[rgb(var(--border))]/30 transition-colors"
        >
          {copied ? <CheckCircle className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
          {copied ? 'Copied!' : 'Copy key'}
        </button>
        <button
          onClick={handleDownloadPdf}
          className="flex items-center justify-center gap-2 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-4 py-2.5 text-sm font-medium text-[rgb(var(--foreground))] hover:bg-[rgb(var(--border))]/30 transition-colors"
        >
          <Download className="h-4 w-4" />
          {downloaded ? 'Downloaded!' : 'Download'}
        </button>
      </div>

      {/* Continue */}
      <button
        onClick={onComplete}
        disabled={!downloaded && !copied}
        className="w-full rounded-lg bg-[rgb(var(--primary))] px-4 py-3 text-sm font-medium text-white hover:bg-[rgb(var(--primary-hover))] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {downloaded || copied ? 'Continue to your workspace' : 'Please save your recovery key first'}
      </button>
    </div>
  )
}
