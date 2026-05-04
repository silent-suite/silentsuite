'use client'

import { Smartphone, ExternalLink, Monitor } from 'lucide-react'
import Link from 'next/link'
import { QRCodeSVG } from 'qrcode.react'

// TODO: make this version-dynamic at build time (see issue #116) — currently
// the version-pinned filename will break when the umbrella tag bumps past
// v0.1.0-beta. Tracked as the "approach 2" follow-up in #116.
const APK_DOWNLOAD_URL =
  'https://github.com/silent-suite/silentsuite/releases/latest/download/silentsuite-android-v0.1.0-beta.apk'
const RELEASES_URL = 'https://github.com/silent-suite/silentsuite/releases/latest'

export default function MobileSettingsPage() {
  const docsUrl = 'https://docs.silentsuite.io/mobile'

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-base font-semibold text-[rgb(var(--foreground))]">
          Connect Mobile
        </h2>
        <p className="text-sm text-[rgb(var(--muted))]">
          Access your encrypted calendar, tasks, and contacts on your phone.
        </p>
      </div>

      {/* QR Code section */}
      <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-6">
        <div className="flex flex-col items-center gap-4">
          <div className="flex h-48 w-48 items-center justify-center rounded-lg border border-[rgb(var(--border))] bg-white p-3">
            <QRCodeSVG
              value={APK_DOWNLOAD_URL}
              size={168}
              level="M"
              marginSize={0}
              aria-label="QR code linking to the latest SilentSuite Android APK"
            />
          </div>
          <p className="text-sm text-[rgb(var(--foreground))] font-medium">
            Scan with your phone camera
          </p>
          <p className="text-xs text-[rgb(var(--muted))] text-center">
            The QR code links to the latest SilentSuite Android APK.
          </p>
          <a
            href={RELEASES_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-[rgb(var(--primary))] hover:underline"
          >
            Or download manually from GitHub Releases
          </a>
        </div>
      </div>

      {/* Manual setup */}
      <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 space-y-4">
        <div className="flex items-center gap-3">
          <Smartphone className="h-5 w-5 text-[rgb(var(--primary))]" />
          <div>
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">Manual setup</p>
            <p className="text-xs text-[rgb(var(--muted))]">
              Follow the documentation to set up the mobile app manually
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <a
            href={docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 rounded-lg bg-[rgb(var(--primary))] px-4 py-2.5 text-sm font-medium text-white hover:bg-[rgb(var(--primary-hover))] transition-colors"
          >
            <ExternalLink className="h-4 w-4" />
            View setup instructions
          </a>
          <a
            href="https://docs.silentsuite.io"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 rounded-lg border border-[rgb(var(--border))] px-4 py-2.5 text-sm font-medium text-[rgb(var(--foreground))] hover:bg-[rgb(var(--surface))] transition-colors"
          >
            Read the full documentation
          </a>
        </div>
      </div>

      {/* Supported platforms */}
      <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 space-y-3">
        <p className="text-sm font-medium text-[rgb(var(--foreground))]">Supported platforms</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--background))] p-3 text-center">
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">Android</p>
            <p className="text-xs text-[rgb(var(--primary))]">Available now</p>
          </div>
          <div className="rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--background))] p-3 text-left space-y-1">
            <p className="text-sm font-medium text-[rgb(var(--foreground))] text-center">iOS</p>
            <p className="text-xs text-[rgb(var(--muted))] text-center">Native app coming soon</p>
            <p className="text-xs text-[rgb(var(--muted))] pt-1">
              Compatible with the{' '}
              <a
                href="https://apps.apple.com/us/app/apple-store/id1489574285"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[rgb(var(--primary))] hover:underline"
              >
                EteSync iOS app
              </a>{' '}
              on the App Store — same Etebase protocol, sign in with your SilentSuite credentials.
            </p>
          </div>
        </div>
      </div>

      {/* Footer note pointing at desktop integration */}
      <p className="text-xs text-[rgb(var(--muted))] text-center">
        <Monitor className="inline h-3 w-3 mr-1 -mt-0.5" />
        Looking for desktop integration?{' '}
        <Link href="/settings/desktop" className="text-[rgb(var(--primary))] hover:underline">
          See Settings → Desktop
        </Link>
        .
      </p>
    </div>
  )
}
