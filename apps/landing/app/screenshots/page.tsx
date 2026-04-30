import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft, Smartphone, Monitor, Network } from 'lucide-react'

export const metadata: Metadata = {
  title: 'Screenshots · SilentSuite',
  description:
    'Real screenshots of SilentSuite — encrypted calendar, contacts, and tasks in the webapp on desktop and mobile, and integrated into Android via the CalDAV/CardDAV bridge.',
}

interface Shot {
  src: string
  caption: string
  detail?: string
}

interface Group {
  id: string
  label: string
  blurb: string
  icon: typeof Monitor
  aspect: string
  shots: Shot[]
}

const GROUPS: Group[] = [
  {
    id: 'webapp-desktop',
    label: 'Webapp on desktop',
    icon: Monitor,
    aspect: 'aspect-[2558/1311]',
    blurb:
      'app.silentsuite.io — your encrypted calendar, contacts, and tasks in any modern browser. Works as a PWA on desktop and tablet. Dark and light themes shown side by side.',
    shots: [
      { src: '/screenshots/webapp-calendar-dark.webp', caption: 'Calendar — week view, dark' },
      { src: '/screenshots/webapp-calendar-light.webp', caption: 'Calendar — week view, light' },
      { src: '/screenshots/webapp-contacts-dark.webp', caption: 'Contacts — detail view, dark' },
      { src: '/screenshots/webapp-contacts-light.webp', caption: 'Contacts — detail view, light' },
      { src: '/screenshots/webapp-tasks-dark.webp', caption: 'Tasks — full list, dark' },
      { src: '/screenshots/webapp-tasks-light.webp', caption: 'Tasks — full list, light' },
    ],
  },
  {
    id: 'webapp-mobile',
    label: 'Webapp on mobile',
    icon: Smartphone,
    aspect: 'aspect-[912/1868]',
    blurb:
      'Same encrypted webapp, in any mobile browser. Bottom-tab layout, agenda calendar, full keyboard support. Add to home screen for a native-feeling PWA.',
    shots: [
      { src: '/screenshots/webapp-mobile-calendar-dark.webp', caption: 'Calendar — agenda view, dark' },
      { src: '/screenshots/webapp-mobile-calendar-light.webp', caption: 'Calendar — agenda view, light' },
      { src: '/screenshots/webapp-mobile-contacts-dark.webp', caption: 'Contacts — list, dark' },
      { src: '/screenshots/webapp-mobile-contacts-light.webp', caption: 'Contacts — list, light' },
      { src: '/screenshots/webapp-mobile-tasks-dark.webp', caption: 'Tasks — list, dark' },
      { src: '/screenshots/webapp-mobile-tasks-light.webp', caption: 'Tasks — list, light' },
    ],
  },
  {
    id: 'android-bridge',
    label: 'Mobile Android bridge',
    icon: Network,
    aspect: 'aspect-[912/2048]',
    blurb:
      'The Android bridge app exposes your encrypted SilentSuite data to Android system apps via CalDAV/CardDAV. Plaintext only ever exists on devices you already control.',
    shots: [
      { src: '/screenshots/android-bridge-main-dark.webp', caption: 'Bridge — accounts overview, dark' },
      { src: '/screenshots/android-bridge-main-light.webp', caption: 'Bridge — accounts overview, light' },
      { src: '/screenshots/android-bridge-menu-dark.webp', caption: 'Bridge — side menu, dark' },
      { src: '/screenshots/android-bridge-menu-light.webp', caption: 'Bridge — side menu, light' },
    ],
  },
]

export default function ScreenshotsPage() {
  return (
    <main className="min-h-screen bg-navy-950 text-white pt-16 pb-32">
      <div className="max-w-5xl mx-auto px-6">
        <div className="mb-12">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-sm text-navy-400 hover:text-white mb-6"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to landing
          </Link>
          <h1 className="text-3xl md:text-5xl font-bold mb-4">
            What it actually looks like.
          </h1>
          <p className="text-lg text-navy-300 max-w-2xl">
            Real screenshots from the production SilentSuite apps — the
            webapp on desktop and mobile, and the Android bridge that integrates
            your encrypted data into Android system apps via CalDAV and CardDAV.
          </p>
        </div>

        <div className="space-y-20">
          {GROUPS.map(({ id, label, icon: Icon, blurb, shots, aspect }) => (
            <section key={id} id={id}>
              <div className="flex items-center gap-3 mb-3">
                <div className="w-9 h-9 rounded-lg bg-teal-400/10 border border-teal-400/30 flex items-center justify-center">
                  <Icon className="w-4 h-4 text-teal-400" />
                </div>
                <h2 className="text-2xl font-semibold">{label}</h2>
              </div>
              <p className="text-navy-300 max-w-2xl mb-8">{blurb}</p>

              <div className="grid sm:grid-cols-2 gap-6">
                {shots.map((s) => (
                  <figure
                    key={s.src}
                    className="rounded-xl border border-white/10 bg-navy-900/40 overflow-hidden"
                  >
                    <div className={`${aspect} bg-navy-900 border-b border-white/5 overflow-hidden`}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={s.src}
                        alt={s.caption}
                        loading="lazy"
                        className="w-full h-full object-cover object-top"
                      />
                    </div>
                    <figcaption className="px-4 py-3">
                      <div className="text-sm text-white">{s.caption}</div>
                      {s.detail ? (
                        <div className="text-xs text-navy-400 mt-0.5">{s.detail}</div>
                      ) : null}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </section>
          ))}
        </div>

        <div className="mt-24 p-8 rounded-xl border border-teal-400/30 bg-gradient-to-br from-teal-400/5 to-navy-900/40 text-center">
          <h2 className="text-xl font-semibold mb-3">
            The mockups on the homepage are pixel-close to these screens.
          </h2>
          <p className="text-navy-300 mb-6 max-w-xl mx-auto">
            Built from the same Tailwind tokens as the real apps — so when the
            UI updates, the homepage doesn&apos;t go stale.
          </p>
          <Link
            href="/#showcase"
            className="inline-flex items-center gap-2 text-teal-400 hover:text-teal-300 text-sm font-medium"
          >
            ← Back to the homepage Showcase
          </Link>
        </div>
      </div>
    </main>
  )
}
