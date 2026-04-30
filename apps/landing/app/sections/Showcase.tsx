'use client'

import { useState } from 'react'
import Link from 'next/link'
import { CalendarDays, CheckSquare, Users, ArrowRight } from 'lucide-react'
import BrowserFrame from './components/BrowserFrame'
import PhoneFrame from './components/PhoneFrame'
import { MockCalendarDesktop, MockCalendarMobile } from './components/MockCalendar'
import { MockContactsDesktop, MockContactsMobile } from './components/MockContacts'
import { MockTasksDesktop, MockTasksMobile } from './components/MockTasks'

type Tab = 'calendar' | 'contacts' | 'tasks'

const TABS: { id: Tab; label: string; icon: typeof CalendarDays; url: string }[] = [
  { id: 'calendar', label: 'Calendar', icon: CalendarDays, url: 'app.silentsuite.io/calendar' },
  { id: 'contacts', label: 'Contacts', icon: Users,        url: 'app.silentsuite.io/contacts' },
  { id: 'tasks',    label: 'Tasks',    icon: CheckSquare,  url: 'app.silentsuite.io/tasks' },
]

export default function Showcase() {
  const [tab, setTab] = useState<Tab>('calendar')
  const current = TABS.find((t) => t.id === tab)!

  return (
    <section
      id="showcase"
      className="relative py-24 overflow-hidden bg-navy-950 text-white"
    >
      {/* Soft radial backdrop so the laptop+phone scene doesn't sit on a flat slab */}
      <div
        aria-hidden="true"
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse 60% 50% at 50% 40%, rgba(52, 211, 153, 0.08), transparent 70%)',
        }}
      />

      <div className="relative max-w-6xl mx-auto px-6">
        <div className="text-center mb-10">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            One product, one account, three views.
          </h2>
          <p className="text-navy-300 max-w-2xl mx-auto">
            The same encrypted store powers calendar, contacts, and tasks. Use
            them in our web and Android apps, or surface them in Apple
            Calendar and Thunderbird via the bridge.
          </p>
        </div>

        {/* Tab strip */}
        <div className="flex justify-center mb-8">
          <div
            role="tablist"
            aria-label="Product showcase"
            className="inline-flex items-center gap-1 p-1 rounded-lg bg-navy-900 border border-white/5"
          >
            {TABS.map(({ id, label, icon: Icon }) => {
              const active = tab === id
              return (
                <button
                  key={id}
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTab(id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    active
                      ? 'bg-teal-400 text-navy-950'
                      : 'text-navy-300 hover:text-white'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Composed scene: browser frame with phone overlap */}
        <div className="relative max-w-5xl mx-auto">
          <BrowserFrame variant="minimal" url={current.url}>
            {tab === 'calendar' ? <MockCalendarDesktop /> : null}
            {tab === 'contacts' ? <MockContactsDesktop /> : null}
            {tab === 'tasks' ? <MockTasksDesktop /> : null}
          </BrowserFrame>

          {/* Phone — overlaps the bottom-right of the browser frame on md+
              screens. Scaled down so the laptop reads as the primary subject;
              transform-origin keeps the bottom-right corner anchored. */}
          <div
            className="hidden md:block absolute -right-2 -bottom-24 origin-bottom-right scale-[0.65] lg:scale-75 pointer-events-none"
            aria-hidden="true"
          >
            <PhoneFrame>
              {tab === 'calendar' ? <MockCalendarMobile /> : null}
              {tab === 'contacts' ? <MockContactsMobile /> : null}
              {tab === 'tasks' ? <MockTasksMobile /> : null}
            </PhoneFrame>
          </div>
        </div>

        {/* Mobile-only phone (when the browser-frame phone is hidden) */}
        <div className="md:hidden mt-10 flex justify-center">
          <PhoneFrame>
            {tab === 'calendar' ? <MockCalendarMobile /> : null}
            {tab === 'contacts' ? <MockContactsMobile /> : null}
            {tab === 'tasks' ? <MockTasksMobile /> : null}
          </PhoneFrame>
        </div>

        <div className="mt-32 md:mt-36 text-center">
          <Link
            href="/screenshots"
            className="inline-flex items-center gap-2 text-teal-400 hover:text-teal-300 text-sm font-medium"
          >
            See real screenshots — Android, Bridge, Webapp
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </section>
  )
}
