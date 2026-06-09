'use client'

import { Monitor, ExternalLink, ShieldCheck } from 'lucide-react'

const RELEASES_URL = 'https://github.com/silent-suite/silentsuite/releases/latest'
const DOCS_URL = 'https://docs.silentsuite.io/user-guide/apps/dav-bridge'

export default function DesktopSettingsPage() {
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

      {/* Installer status */}
      <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 space-y-3">
        <div className="flex items-center gap-3">
          <Monitor className="h-5 w-5 text-[rgb(var(--primary))]" />
          <div>
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">
              Installers are published through releases
            </p>
            <p className="text-xs text-[rgb(var(--muted))]">
              Download bridge binaries from GitHub releases until stable installer endpoints are pinned to main or a release tag.
            </p>
          </div>
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
