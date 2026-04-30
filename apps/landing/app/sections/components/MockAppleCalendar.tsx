import { Search, Calendar, Lock, Plus, ChevronLeft, ChevronRight } from 'lucide-react'

/**
 * Apple Calendar lookalike — a Mac-window mockup showing how SilentSuite
 * calendars surface in the system app via the CalDAV bridge, alongside
 * iCloud calendars. The point is the SilentSuite group (locked, encrypted)
 * sitting next to a regular iCloud group, with events from both painted
 * onto the same week grid.
 */

interface Event {
  day: number          // 0 = Mon
  startHour: number
  endHour: number
  title: string
  source: 'icloud' | 'silentsuite'
  calendar: string
}

const WEEK_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const WEEK_DATES = [27, 28, 29, 30, 1, 2, 3]
const TODAY_INDEX = 2 // Wed
const HOURS = [9, 10, 11, 12, 13, 14, 15, 16]

const EVENTS: Event[] = [
  { day: 0, startHour: 9,  endHour: 10,   title: 'Yoga',                source: 'icloud',     calendar: 'Personal' },
  { day: 0, startHour: 14, endHour: 15,   title: 'Team Standup',        source: 'silentsuite', calendar: 'Work' },
  { day: 1, startHour: 11, endHour: 12,   title: '1:1 with Alex',       source: 'silentsuite', calendar: 'Work' },
  { day: 2, startHour: 9,  endHour: 10,   title: 'Team Standup',        source: 'silentsuite', calendar: 'Work' },
  { day: 2, startHour: 14, endHour: 15.5, title: 'Q1 Planning Review',  source: 'silentsuite', calendar: 'Work' },
  { day: 2, startHour: 16, endHour: 17,   title: 'Pick up groceries',   source: 'icloud',     calendar: 'Personal' },
  { day: 3, startHour: 10, endHour: 11,   title: 'Coffee with Sarah',   source: 'silentsuite', calendar: 'Personal' },
  { day: 3, startHour: 13, endHour: 14,   title: 'Dentist',             source: 'icloud',     calendar: 'Personal' },
  { day: 4, startHour: 16, endHour: 17,   title: 'Demo Day',            source: 'silentsuite', calendar: 'Work' },
]

const ICLOUD_CALS = [
  { name: 'Personal', color: '#3b82f6' },
  { name: 'Family',   color: '#a855f7' },
]

const SILENT_CALS = [
  { name: 'Work',     color: '#34d399' },
  { name: 'Personal', color: '#34d399' },
  { name: 'Side projects', color: '#34d399' },
]

function eventColor(e: Event): string {
  if (e.source === 'silentsuite') return '#34d399'
  if (e.calendar === 'Family') return '#a855f7'
  return '#3b82f6'
}

export function MockAppleCalendar() {
  return (
    <div
      className="relative rounded-xl overflow-hidden bg-[#1c1c1e] ring-1 ring-white/10 select-none"
      style={{
        boxShadow:
          '0 30px 60px -20px rgba(15, 23, 42, 0.5), 0 8px 24px -8px rgba(15, 23, 42, 0.3)',
      }}
    >
      {/* Mac window chrome */}
      <div className="flex items-center gap-3 px-3 h-9 bg-[#2a2a2c] border-b border-black/40">
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className="w-3 h-3 rounded-full bg-[#ff5f57]" />
          <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
          <span className="w-3 h-3 rounded-full bg-[#28c840]" />
        </div>
        <div className="flex-1 text-center text-xs text-[#8e8e93] font-medium">
          Calendar
        </div>
        <div className="w-[52px]" aria-hidden="true" />
      </div>

      {/* Toolbar */}
      <div className="h-10 px-3 flex items-center justify-between bg-[#1c1c1e] border-b border-black/40 text-[#e5e5ea]">
        <div className="flex items-center gap-1.5">
          <button className="px-2 py-0.5 text-xs rounded border border-[#3a3a3c] bg-[#2a2a2c]">
            Today
          </button>
          <ChevronLeft className="w-3.5 h-3.5 text-[#8e8e93]" />
          <ChevronRight className="w-3.5 h-3.5 text-[#8e8e93]" />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">April 2026</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 text-[10px] rounded border border-[#3a3a3c] overflow-hidden">
            <span className="px-2 py-0.5">Day</span>
            <span className="px-2 py-0.5 bg-[#2a2a2c] text-white">Week</span>
            <span className="px-2 py-0.5">Month</span>
            <span className="px-2 py-0.5">Year</span>
          </div>
          <div className="flex items-center gap-1 px-2 py-0.5 rounded border border-[#3a3a3c] bg-[#2a2a2c] text-[10px]">
            <Search className="w-3 h-3 text-[#8e8e93]" />
            <span className="text-[#8e8e93]">Search</span>
          </div>
        </div>
      </div>

      <div className="flex">
        {/* Sidebar */}
        <aside className="w-44 bg-[#1c1c1e] border-r border-black/40 text-[#e5e5ea]">
          <div className="px-3 py-3">
            <div className="text-[10px] uppercase tracking-wide text-[#8e8e93] mb-2">iCloud</div>
            <ul className="space-y-1.5">
              {ICLOUD_CALS.map((c) => (
                <li key={c.name} className="flex items-center gap-2 text-xs">
                  <span
                    className="w-3 h-3 rounded-sm border border-white/20"
                    style={{ backgroundColor: c.color }}
                  />
                  {c.name}
                </li>
              ))}
            </ul>

            <div className="mt-5 mb-2 flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wide text-[#8e8e93]">SilentSuite</span>
              <span
                title="End-to-end encrypted via SilentSuite bridge"
                className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-semibold uppercase tracking-wide bg-teal-400/15 border border-teal-400/30 text-teal-400"
              >
                <Lock className="w-2 h-2" />
                E2EE
              </span>
            </div>
            <ul className="space-y-1.5">
              {SILENT_CALS.map((c) => (
                <li key={c.name} className="flex items-center gap-2 text-xs">
                  <span
                    className="w-3 h-3 rounded-sm border border-white/20"
                    style={{ backgroundColor: c.color }}
                  />
                  {c.name}
                </li>
              ))}
            </ul>

            <div className="mt-4 pt-3 border-t border-white/5">
              <div className="text-[9px] text-[#8e8e93] leading-relaxed">
                Synced via CalDAV bridge.
                Plaintext only on this Mac.
              </div>
            </div>
          </div>
        </aside>

        {/* Week grid */}
        <div className="flex-1 grid grid-cols-[36px_repeat(7,1fr)] text-[10px] bg-[#1c1c1e] text-[#e5e5ea]">
          {/* Header row */}
          <div className="border-b border-black/40 bg-[#2a2a2c]" />
          {WEEK_DAYS.map((d, i) => (
            <div
              key={i}
              className={`text-center py-1.5 border-b border-l border-black/40 bg-[#2a2a2c] ${
                i === TODAY_INDEX ? 'bg-[#1c1c1e]' : ''
              }`}
            >
              <div className={`text-[9px] uppercase ${i === TODAY_INDEX ? 'text-[#ff453a]' : 'text-[#8e8e93]'}`}>{d}</div>
              <div
                className={`text-sm font-semibold ${
                  i === TODAY_INDEX ? 'text-[#ff453a]' : 'text-white'
                }`}
              >
                {WEEK_DATES[i]}
              </div>
            </div>
          ))}

          {/* Body */}
          <div>
            {HOURS.map((h) => (
              <div key={h} className="h-9 text-right pr-1 pt-0.5 text-[8px] text-[#8e8e93]">
                {h.toString().padStart(2, '0')}:00
              </div>
            ))}
          </div>
          {WEEK_DAYS.map((_, dayIdx) => (
            <div
              key={dayIdx}
              className="relative border-l border-black/40"
            >
              {HOURS.map((_, i) => (
                <div key={i} className="h-9 border-b border-black/40" />
              ))}
              {EVENTS.filter((e) => e.day === dayIdx).map((e, i) => {
                const top = (e.startHour - HOURS[0]) * 36
                const height = (e.endHour - e.startHour) * 36
                const color = eventColor(e)
                return (
                  <div
                    key={i}
                    className="absolute left-0.5 right-0.5 rounded px-1 py-0.5 text-[9px] font-semibold leading-tight overflow-hidden border-l-2"
                    style={{
                      top: `${top}px`,
                      height: `${height}px`,
                      backgroundColor: `${color}33`,
                      borderColor: color,
                      color: '#e5e5ea',
                    }}
                  >
                    <div className="flex items-center gap-1">
                      {e.source === 'silentsuite' ? (
                        <Lock className="w-2 h-2 flex-shrink-0" style={{ color }} />
                      ) : null}
                      <span className="truncate">{e.title}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
