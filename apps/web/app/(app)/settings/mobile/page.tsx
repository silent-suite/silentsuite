'use client'

import { Download, ExternalLink, Monitor, PackageCheck, RefreshCw, Store } from 'lucide-react'
import Link from 'next/link'
import { QRCodeSVG } from 'qrcode.react'

const INSTALL_DOCS_URL = 'https://docs.silentsuite.io/user-guide/apps/android'
const GOOGLE_PLAY_URL = 'https://play.google.com/store/apps/details?id=io.silentsuite.android'
const ZAPSTORE_URL = 'https://zapstore.dev/apps/io.silentsuite.android'
const RELEASES_URL = 'https://github.com/silent-suite/silentsuite/releases/latest'

const activeChannels = [
  {
    name: 'Google Play',
    detail: 'Install and update through Google Play',
    href: GOOGLE_PLAY_URL,
    icon: PackageCheck,
  },
  {
    name: 'Obtainium',
    detail: 'Receive updates from GitHub Releases',
    href: INSTALL_DOCS_URL,
    icon: RefreshCw,
  },
  {
    name: 'Zapstore',
    detail: 'Open app store; releases may arrive later',
    href: ZAPSTORE_URL,
    icon: Store,
  },
]

export default function MobileSettingsPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-base font-semibold text-[rgb(var(--foreground))]">
          Get SilentSuite for Android
        </h2>
        <p className="text-sm text-[rgb(var(--muted))]">
          Choose how you install and receive updates. Every option uses
          SilentSuite&apos;s encrypted sync model, but release timing may differ by channel.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_13rem] md:items-center">
        <div className="grid gap-3 sm:grid-cols-2">
          {activeChannels.map(({ name, detail, href, icon: Icon }) => (
            <a
              key={name}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex min-h-28 items-center gap-3 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 transition-colors hover:border-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 dark:hover:border-emerald-300 dark:focus-visible:ring-emerald-300"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-700 text-white dark:bg-emerald-400 dark:text-slate-950">
                <Icon className="h-5 w-5" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-[rgb(var(--foreground))]">{name}</span>
                <span className="mt-1 block text-xs leading-relaxed text-[rgb(var(--muted))]">{detail}</span>
              </span>
              <ExternalLink className="h-4 w-4 shrink-0 text-[rgb(var(--muted))] group-hover:text-emerald-700 dark:group-hover:text-emerald-300" aria-hidden="true" />
            </a>
          ))}

          <div
            role="group"
            aria-disabled="true"
            aria-label="F-Droid, soon. Pending official inclusion"
            className="flex min-h-28 items-center gap-3 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--background))] text-[rgb(var(--muted))]">
              <Download className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-[rgb(var(--muted))]">F-Droid</span>
                <span className="rounded-full bg-[rgb(var(--border))] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[rgb(var(--foreground))]">Soon</span>
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-[rgb(var(--muted))]">Pending official inclusion</span>
            </span>
          </div>
        </div>

        <div data-android-download-qr className="hidden md:block">
          <a
            href={INSTALL_DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="block rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 text-center transition-colors hover:border-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 dark:hover:border-emerald-300 dark:focus-visible:ring-emerald-300"
            aria-label="Open Android installation options"
          >
            <span className="mx-auto flex w-fit rounded-lg bg-white p-2">
              <QRCodeSVG
                value={INSTALL_DOCS_URL}
                size={144}
                level="M"
                marginSize={0}
                aria-label="QR code linking to Android installation options"
              />
            </span>
            <span className="mt-3 block text-xs font-medium text-[rgb(var(--foreground))]">Scan for every option</span>
          </a>
        </div>
      </div>

      <p className="text-sm text-[rgb(var(--muted))]">
        <span className="font-medium text-[rgb(var(--foreground))]">Prefer a manual install?</span>{' '}
        <a
          href={RELEASES_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-emerald-700 hover:underline dark:text-emerald-300"
        >
          Download the signed APK from GitHub Releases.
        </a>{' '}
        <a
          href={INSTALL_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="whitespace-nowrap text-[rgb(var(--foreground))] hover:underline"
        >
          Installation help
        </a>
      </p>

      {/* Supported platforms */}
      <div className="rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4 space-y-3">
        <p className="text-sm font-medium text-[rgb(var(--foreground))]">Supported platforms</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--background))] p-3 text-center">
            <p className="text-sm font-medium text-[rgb(var(--foreground))]">Android</p>
            <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300">Available now</p>
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
              on the App Store — same Etebase protocol, sign in with your silentsuite.io credentials.
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
