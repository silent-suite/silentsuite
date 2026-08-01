'use client'

import { ExternalLink, Monitor } from 'lucide-react'
import Image from 'next/image'
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
    logo: '/channel-icons/google-play.svg',
  },
  {
    name: 'Zapstore',
    detail: 'Open app store; releases may arrive later',
    href: ZAPSTORE_URL,
    logo: '/channel-icons/zapstore.png',
  },
  {
    name: 'Obtainium',
    detail: 'Receive updates from GitHub Releases',
    href: INSTALL_DOCS_URL,
    logo: '/channel-icons/obtainium.svg',
  },
]

const channelCardClass = 'flex min-h-28 items-center gap-3 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-4'

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

      <div
        data-android-managed-channels
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(15rem,0.9fr)] lg:grid-rows-2 lg:items-stretch"
      >
        {activeChannels.map(({ name, detail, href, logo }) => (
          <a
            key={name}
            data-android-channel={name}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={`${channelCardClass} group transition-colors hover:border-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 dark:hover:border-emerald-300 dark:focus-visible:ring-emerald-300`}
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-[rgb(var(--border))] bg-white p-2">
              <Image
                src={logo}
                alt=""
                aria-hidden="true"
                width={28}
                height={28}
                unoptimized={logo.endsWith('.png')}
                className="h-7 w-7 object-contain"
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-[rgb(var(--foreground))]">{name}</span>
              <span className="mt-1 block text-xs leading-relaxed text-[rgb(var(--muted))]">{detail}</span>
            </span>
            <ExternalLink className="h-4 w-4 shrink-0 text-[rgb(var(--muted))] group-hover:text-emerald-700 dark:group-hover:text-emerald-300" aria-hidden="true" />
          </a>
        ))}

        <div
          data-android-channel="F-Droid"
          role="group"
          aria-disabled="true"
          aria-label="F-Droid, on the roadmap. Pending official inclusion"
          className={channelCardClass}
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-[rgb(var(--border))] bg-white p-2 opacity-75">
            <Image
              src="/channel-icons/fdroid.png"
              alt=""
              aria-hidden="true"
              width={28}
              height={28}
              unoptimized
              className="h-7 w-7 object-contain"
            />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-[rgb(var(--muted))]">F-Droid</span>
              <span className="rounded-full bg-[rgb(var(--border))] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[rgb(var(--foreground))]">Soon</span>
            </span>
            <span className="mt-1 block text-xs leading-relaxed text-[rgb(var(--muted))]">Pending official inclusion</span>
          </span>
        </div>

        <div
          data-android-download-qr
          className="hidden lg:col-start-3 lg:row-start-1 lg:row-span-2 lg:flex"
        >
          <a
            href={INSTALL_DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={`${channelCardClass} w-full flex-col justify-center text-center transition-colors hover:border-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 dark:hover:border-emerald-300 dark:focus-visible:ring-emerald-300`}
            aria-label="Open Android installation options"
          >
            <span className="flex h-40 w-40 shrink-0 items-center justify-center rounded-lg border border-[rgb(var(--border))] bg-white p-[7px]">
              <QRCodeSVG
                value={INSTALL_DOCS_URL}
                size={144}
                level="M"
                marginSize={0}
                aria-label="QR code linking to Android installation options"
              />
            </span>
            <span className="min-w-0 text-center">
              <span className="block text-sm font-semibold text-[rgb(var(--foreground))]">Installing elsewhere?</span>
              <span className="mt-1 block text-xs leading-relaxed text-[rgb(var(--muted))]">Scan for every option.</span>
            </span>
          </a>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm text-[rgb(var(--muted))]">
        <span>Prefer a signed APK?</span>
        <a
          href={RELEASES_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="group inline-flex items-center gap-2 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-3 py-2 font-medium text-[rgb(var(--foreground))] transition-colors hover:border-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 dark:hover:border-emerald-300 dark:focus-visible:ring-emerald-300"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-md border border-[rgb(var(--border))] bg-white p-1">
            <Image src="/channel-icons/github.svg" alt="" aria-hidden="true" width={20} height={20} className="h-5 w-5 object-contain" />
          </span>
          Direct APK
          <ExternalLink className="h-3.5 w-3.5 text-[rgb(var(--muted))] group-hover:text-emerald-700 dark:group-hover:text-emerald-300" aria-hidden="true" />
        </a>
        <a
          href={INSTALL_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="whitespace-nowrap text-[rgb(var(--foreground))] hover:underline"
        >
          Installation help
        </a>
      </div>

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
            <p className="text-xs font-medium text-amber-700 text-center dark:text-amber-300">On the roadmap, coming soon</p>
            <p className="pt-1 text-center text-xs text-[rgb(var(--muted))]">iOS is not currently supported.</p>
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
