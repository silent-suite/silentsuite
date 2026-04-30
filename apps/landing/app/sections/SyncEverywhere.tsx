import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import BrowserFrame from './components/BrowserFrame'
import PhoneFrame from './components/PhoneFrame'
import { MockCalendarDesktop, MockCalendarMobile } from './components/MockCalendar'
import { MockAppleCalendar } from './components/MockAppleCalendar'
import { MockThunderbird } from './components/MockThunderbird'

export default function SyncEverywhere() {
  return (
    <section
      id="sync-everywhere"
      className="relative py-28 bg-navy-950 text-white overflow-hidden"
    >
      <div className="relative max-w-6xl mx-auto px-6">
        <div className="text-center mb-12">
          <h2 className="text-3xl md:text-4xl font-bold mb-4 leading-tight">
            One encrypted store. Every surface you use.
          </h2>
          <p className="text-navy-300 max-w-2xl mx-auto">
            The same ciphertext lives on our server. Decryption happens
            wherever you choose to install a SilentSuite client or run the
            CalDAV/CardDAV bridge.
          </p>
        </div>

        {/* Four-up grid of platform mockups, scaled small */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 lg:gap-5 items-end">
          <Slot label="SilentSuite Webapp" caption="The native React webapp.">
            <div className="origin-top-left scale-[0.32] sm:scale-[0.4] lg:scale-[0.32] xl:scale-[0.36] w-[1200px]">
              <BrowserFrame variant="minimal" url="app.silentsuite.io">
                <MockCalendarDesktop />
              </BrowserFrame>
            </div>
          </Slot>

          <Slot label="Android" caption="Native app, agenda view, full offline support.">
            <div className="origin-top-left scale-[0.55] sm:scale-[0.65] lg:scale-[0.45] xl:scale-[0.55] w-[300px]">
              <PhoneFrame>
                <MockCalendarMobile />
              </PhoneFrame>
            </div>
          </Slot>

          <Slot label="Apple Calendar" caption="Via the CalDAV bridge — alongside iCloud calendars.">
            <div className="origin-top-left scale-[0.32] sm:scale-[0.4] lg:scale-[0.32] xl:scale-[0.36] w-[1200px]">
              <MockAppleCalendar />
            </div>
          </Slot>

          <Slot label="Thunderbird" caption="Cross-platform desktop client. Same bridge.">
            <div className="origin-top-left scale-[0.55] sm:scale-[0.7] lg:scale-[0.5] xl:scale-[0.6] w-[440px]">
              <MockThunderbird />
            </div>
          </Slot>
        </div>

        <div className="mt-16 text-center">
          <Link
            href="/screenshots"
            className="inline-flex items-center gap-1.5 text-teal-400 hover:text-teal-300 text-sm font-medium"
          >
            See real screenshots from each platform
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </section>
  )
}

function Slot({ label, caption, children }: { label: string; caption: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      {/* Bounded box that clips the scaled mockup */}
      <div className="relative h-48 sm:h-56 lg:h-44 xl:h-52 rounded-xl overflow-hidden bg-navy-900/30 border border-white/5 mb-3 flex items-start justify-start p-3">
        {children}
      </div>
      <div className="text-sm font-semibold text-white">{label}</div>
      <div className="text-xs text-navy-400 mt-0.5 leading-relaxed">{caption}</div>
    </div>
  )
}
