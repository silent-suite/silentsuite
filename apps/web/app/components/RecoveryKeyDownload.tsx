'use client'

import { useState, useCallback } from 'react'
import { Download, Shield, AlertTriangle } from 'lucide-react'

interface RecoveryKeyDownloadProps {
  recoveryKey: string
  email: string
  onContinue: () => void
}

export function RecoveryKeyDownload({ recoveryKey, email, onContinue }: RecoveryKeyDownloadProps) {
  const [downloaded, setDownloaded] = useState(false)

  const handleDownload = useCallback(() => {
    // Generate a simple text-based recovery document
    const content = `
═══════════════════════════════════════════════════════
          SILENTSUITE RECOVERY KEY
═══════════════════════════════════════════════════════

Account: ${email}
Generated: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}

───────────────────────────────────────────────────────
  YOUR RECOVERY KEY
───────────────────────────────────────────────────────

  ${recoveryKey}

───────────────────────────────────────────────────────

IMPORTANT:
- Store this key in a safe place
- This key can restore access to your encrypted data
- SilentSuite cannot recover this key for you
- Do NOT share this key with anyone
- Consider storing a printed copy in a safe location

───────────────────────────────────────────────────────
  SilentSuite - Private Sync, By Design
  https://silentsuite.io
═══════════════════════════════════════════════════════
`.trim()

    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `silentsuite-recovery-key-${new Date().toISOString().split('T')[0]}.txt`
    link.click()
    URL.revokeObjectURL(url)
    setDownloaded(true)
  }, [recoveryKey, email])

  return (
    <div className="space-y-6">
      <div className="text-center space-y-3">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border border-emerald-500/30 bg-emerald-500/10">
          <Shield className="h-8 w-8 text-emerald-500" />
        </div>
        <h2 className="text-xl font-semibold text-[rgb(var(--foreground))]">
          Save your recovery key
        </h2>
        <p className="text-sm text-[rgb(var(--muted))]">
          This key can restore access to your encrypted data if you forget your password.
          Store it somewhere safe.
        </p>
      </div>

      {/* Recovery key display */}
      <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4">
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
      <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 font-mono text-sm text-[rgb(var(--foreground))] break-all select-all text-center">
        {recoveryKey}
      </div>

      {/* Download button */}
      <button
        onClick={handleDownload}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-4 py-3 text-sm font-medium text-[rgb(var(--foreground))] hover:bg-[rgb(var(--border))]/30 transition-colors"
      >
        <Download className="h-4 w-4" />
        {downloaded ? 'Downloaded! Download again' : 'Download recovery key'}
      </button>

      {/* Continue */}
      <button
        onClick={onContinue}
        disabled={!downloaded}
        className="w-full rounded-lg bg-emerald-600 px-4 py-3 text-sm font-medium text-white hover:bg-emerald-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {downloaded ? 'Continue' : 'Please download your recovery key first'}
      </button>
    </div>
  )
}
