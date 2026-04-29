import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft, Smartphone, Monitor, Network, ImageIcon } from 'lucide-react'

export const metadata: Metadata = {
  title: 'Screenshots · SilentSuite',
  description:
    'Real screenshots of SilentSuite — encrypted calendar, contacts, and tasks on Android, in the webapp, and via the CalDAV/CardDAV bridge in Apple Calendar and Thunderbird.',
}

interface Shot {
  caption: string
  detail?: string
}

interface Group {
  id: string
  label: string
  blurb: string
  icon: typeof Monitor
  shots: Shot[]
}

const GROUPS: Group[] = [
  {
    id: 'webapp',
    label: 'Webapp',
    icon: Monitor,
    blurb:
      'app.silentsuite.io — your encrypted calendar, contacts, and tasks in any modern browser. Works as a PWA on desktop and tablet.',
    shots: [
      { caption: 'Calendar — week view', detail: 'Schedule-X grid with multi-calendar colour coding.' },
      { caption: 'Contacts — list and detail', detail: 'Two-column split with full vCard fields encrypted.' },
      { caption: 'Tasks — priority and due dates', detail: 'Quick-add bar, recurring tasks, sub-task support.' },
      { caption: 'Settings — devices and sessions' },
    ],
  },
  {
    id: 'android',
    label: 'Android',
    icon: Smartphone,
    blurb:
      'Native Android app. Bottom-nav layout, agenda calendar, full offline support. Available on F-Droid and as a direct APK.',
    shots: [
      { caption: 'Calendar — agenda view' },
      { caption: 'Contact detail' },
      { caption: 'Tasks list' },
      { caption: 'Settings — sync status' },
    ],
  },
  {
    id: 'bridge',
    label: 'Bridge — Apple Calendar / Thunderbird / DAVx5',
    icon: Network,
    blurb:
      'Standalone bridge app exposes your encrypted SilentSuite data to any CalDAV/CardDAV client. Plaintext only ever exists on devices you already control.',
    shots: [
      { caption: 'Bridge — first-run setup' },
      { caption: 'Apple Calendar — SilentSuite events alongside iCloud' },
      { caption: 'Apple Contacts — encrypted address book in the system app' },
      { caption: 'Thunderbird — calendar and contacts' },
      { caption: 'DAVx5 on Android — system-level integration' },
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
            Real screenshots from the production SilentSuite apps and from the
            CalDAV/CardDAV bridge integrating with Apple Calendar, Thunderbird,
            and DAVx5.
          </p>
        </div>

        <div className="space-y-20">
          {GROUPS.map(({ id, label, icon: Icon, blurb, shots }) => (
            <section key={id} id={id}>
              <div className="flex items-center gap-3 mb-3">
                <div className="w-9 h-9 rounded-lg bg-teal-400/10 border border-teal-400/30 flex items-center justify-center">
                  <Icon className="w-4 h-4 text-teal-400" />
                </div>
                <h2 className="text-2xl font-semibold">{label}</h2>
              </div>
              <p className="text-navy-300 max-w-2xl mb-8">{blurb}</p>

              <div className="grid sm:grid-cols-2 gap-6">
                {shots.map((s, i) => (
                  <figure
                    key={i}
                    className="rounded-xl border border-white/10 bg-navy-900/40 overflow-hidden"
                  >
                    <div className="aspect-[16/10] bg-navy-900 flex items-center justify-center text-navy-500 border-b border-white/5">
                      <div className="flex flex-col items-center gap-2 text-center px-4">
                        <ImageIcon className="w-8 h-8 opacity-40" />
                        <span className="text-xs">Screenshot pending</span>
                      </div>
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
