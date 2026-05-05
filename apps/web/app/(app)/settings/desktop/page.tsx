'use client'

import { useCallback, useState } from 'react'
import { Monitor, ExternalLink, Copy, CheckCircle, ShieldCheck } from 'lucide-react'

const INSTALL_COMMAND = 'curl -fsSL https://silentsuite.io/bridge/install.sh | sh'
const INSTALL_COMMAND_PS = 'irm https://silentsuite.io/bridge/install.ps1 | iex'
const RELEASES_URL = 'https://github.com/silent-suite/silentsuite/releases/latest'
const DOCS_URL = 'https://docs.silentsuite.io/user-guide/apps/dav-bridge'

export default function DesktopSettingsPage() {
  const [copied, setCopied] = useState<'sh' | 'ps' | null>(null)

  const handleCopy = useCallback(async (variant: 'sh' | 'ps') => {
    const text = variant === 'sh' ? INSTALL_COMMAND : INSTALL_COMMAND_PS
    try {
      await navigator.clipboard.writeText(text)
      setCopied(variant)
      setTimeout(() => setCopied(null), 2000)
    } catch {
      // Clipboard access may be blocked; users can still select manually
    }
  }, [])

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-base font-semibold text-[rgb(var(--foreground))]">
          Desktop bridge
        </h2>
        <p className="text-sm text-[rgb(var(--muted))]">
          Install the SilentSuite bridge to use SilentSuite from Thunderbird, Apple Calendar,
          GNOME Calendar, Evolution, or any standard CalDAV/CardDAV client.
        </p>
      </div>

      {/* Install one-liner — macOS / Linux */}
      <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 space-y-3">
        <div className="flex items-center gap-3">
          <Monitor className="h-5 w-5 text-[rgb(var(--primary))]" />
          <div>
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">
              Install on macOS or Linux
            </p>
            <p className="text-xs text-[rgb(var(--muted))]">
              Run this in your terminal.
            </p>
          </div>
        </div>

        <div className="flex items-stretch gap-2">
          <pre className="flex-1 overflow-x-auto rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--background))] px-3 py-2 text-xs text-[rgb(var(--foreground))] font-mono">
            <code>{INSTALL_COMMAND}</code>
          </pre>
          <button
            type="button"
            onClick={() => handleCopy('sh')}
            aria-label="Copy install command"
            className="flex items-center gap-1 rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--background))] px-3 py-2 text-xs font-medium text-[rgb(var(--foreground))] hover:bg-[rgb(var(--surface))] transition-colors"
          >
            {copied === 'sh' ? (
              <CheckCircle className="h-4 w-4 text-emerald-500" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
            {copied === 'sh' ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      {/* Install one-liner — Windows */}
      <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 space-y-3">
        <div className="flex items-center gap-3">
          <Monitor className="h-5 w-5 text-[rgb(var(--primary))]" />
          <div>
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">
              Install on Windows
            </p>
            <p className="text-xs text-[rgb(var(--muted))]">
              Run this in PowerShell.
            </p>
          </div>
        </div>

        <div className="flex items-stretch gap-2">
          <pre className="flex-1 overflow-x-auto rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--background))] px-3 py-2 text-xs text-[rgb(var(--foreground))] font-mono">
            <code>{INSTALL_COMMAND_PS}</code>
          </pre>
          <button
            type="button"
            onClick={() => handleCopy('ps')}
            aria-label="Copy PowerShell install command"
            className="flex items-center gap-1 rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--background))] px-3 py-2 text-xs font-medium text-[rgb(var(--foreground))] hover:bg-[rgb(var(--surface))] transition-colors"
          >
            {copied === 'ps' ? (
              <CheckCircle className="h-4 w-4 text-emerald-500" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
            {copied === 'ps' ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      {/* Direct downloads + docs */}
      <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 space-y-3">
        <p className="text-sm font-medium text-[rgb(var(--foreground))]">
          Or download binaries directly
        </p>
        <div className="flex flex-col gap-2">
          <a
            href={RELEASES_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 rounded-lg bg-[rgb(var(--primary))] px-4 py-2.5 text-sm font-medium text-white hover:bg-[rgb(var(--primary-hover))] transition-colors"
          >
            <ExternalLink className="h-4 w-4" />
            View latest release on GitHub
          </a>
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 rounded-lg border border-[rgb(var(--border))] px-4 py-2.5 text-sm font-medium text-[rgb(var(--foreground))] hover:bg-[rgb(var(--surface))] transition-colors"
          >
            Read the bridge documentation
          </a>
        </div>
      </div>

      {/* Privacy note */}
      <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4">
        <div className="flex items-start gap-3">
          <ShieldCheck className="h-5 w-5 text-[rgb(var(--primary))] mt-0.5 flex-shrink-0" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">
              Stays end-to-end encrypted
            </p>
            <p className="text-xs text-[rgb(var(--muted))]">
              The bridge runs locally on{' '}
              <code className="font-mono text-[rgb(var(--foreground))]">localhost:37358</code>.
              Plain DAV stays inside <code className="font-mono text-[rgb(var(--foreground))]">localhost</code>;
              all upstream traffic is end-to-end encrypted Etebase.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
