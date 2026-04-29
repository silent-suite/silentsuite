import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import BrowserFrame, { BrowserFrameVariant } from '../sections/components/BrowserFrame'
import PhoneFrame from '../sections/components/PhoneFrame'
import { MockCalendarDesktop, MockCalendarMobile } from '../sections/components/MockCalendar'
import { MockContactsDesktop, MockContactsMobile } from '../sections/components/MockContacts'
import { MockTasksDesktop, MockTasksMobile } from '../sections/components/MockTasks'

// Hidden preview-only page. Not linked from anywhere on the public site —
// reachable by typing /showcase. Used to compare the Safari frame and the
// minimal (no-chrome) frame side-by-side across all three product mockups,
// so we can pick a final direction before shipping the homepage Showcase.
export const metadata: Metadata = {
  title: 'Showcase preview · SilentSuite',
  robots: { index: false, follow: false },
}

const PRODUCTS = [
  {
    id: 'calendar',
    label: 'Calendar',
    url: 'app.silentsuite.io/calendar',
    desktop: <MockCalendarDesktop />,
    mobile: <MockCalendarMobile />,
  },
  {
    id: 'contacts',
    label: 'Contacts',
    url: 'app.silentsuite.io/contacts',
    desktop: <MockContactsDesktop />,
    mobile: <MockContactsMobile />,
  },
  {
    id: 'tasks',
    label: 'Tasks',
    url: 'app.silentsuite.io/tasks',
    desktop: <MockTasksDesktop />,
    mobile: <MockTasksMobile />,
  },
] as const

const VARIANTS: { id: BrowserFrameVariant; label: string; description: string }[] = [
  {
    id: 'safari',
    label: 'Safari frame',
    description:
      'Traffic-light dots + URL pill. Reads as "this is a real app" without the noise of a full Chrome tab strip.',
  },
  {
    id: 'minimal',
    label: 'Minimal (no chrome)',
    description:
      'Just rounded corners + ring + drop shadow. The Linear / Obsidian / new-Proton style. Modern, frame-free.',
  },
]

export default function ShowcasePreview() {
  return (
    <main className="min-h-screen bg-navy-950 text-white pt-16 pb-32">
      <div className="max-w-6xl mx-auto px-6">
        <div className="mb-10">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-sm text-navy-400 hover:text-white mb-6"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to landing
          </Link>
          <h1 className="text-3xl md:text-4xl font-bold mb-3">
            Showcase preview
          </h1>
          <p className="text-navy-300 max-w-2xl">
            Internal preview — not linked from the public site. Compare the two
            frame styles across all three product mockups, then decide which
            one ships on the homepage Showcase section.
          </p>
        </div>

        {/* Two columns of frame styles, three rows of products */}
        {VARIANTS.map((variant) => (
          <section key={variant.id} className="mb-24">
            <div className="mb-8 pb-4 border-b border-white/10">
              <div className="flex items-baseline gap-3">
                <h2 className="text-xl font-semibold text-white">{variant.label}</h2>
                <span className="text-xs text-navy-500">variant=&quot;{variant.id}&quot;</span>
              </div>
              <p className="text-sm text-navy-400 mt-1 max-w-2xl">{variant.description}</p>
            </div>

            <div className="space-y-20">
              {PRODUCTS.map((product) => (
                <div key={product.id}>
                  <div className="text-xs uppercase tracking-wide text-navy-500 mb-4">
                    {product.label}
                  </div>
                  <div className="relative max-w-5xl mx-auto">
                    <BrowserFrame variant={variant.id} url={product.url}>
                      {product.desktop}
                    </BrowserFrame>
                    <div
                      className="hidden md:block absolute -right-2 -bottom-24 origin-bottom-right scale-[0.65] lg:scale-75 pointer-events-none"
                      aria-hidden="true"
                    >
                      <PhoneFrame>{product.mobile}</PhoneFrame>
                    </div>
                  </div>
                  {/* Mobile-only phone */}
                  <div className="md:hidden mt-10 flex justify-center">
                    <PhoneFrame>{product.mobile}</PhoneFrame>
                  </div>
                  {/* Spacer for the overlapping (scaled) phone on desktop */}
                  <div className="hidden md:block h-32" aria-hidden="true" />
                </div>
              ))}
            </div>
          </section>
        ))}

        <div className="text-center mt-16 p-6 rounded-xl border border-white/10 bg-navy-900/40">
          <p className="text-sm text-navy-300">
            The homepage currently uses the <strong className="text-white">Safari</strong> frame.
            Change <code className="text-teal-400 text-xs">variant=&quot;safari&quot;</code> in{' '}
            <code className="text-teal-400 text-xs">app/sections/Showcase.tsx</code> to switch.
          </p>
        </div>
      </div>
    </main>
  )
}
