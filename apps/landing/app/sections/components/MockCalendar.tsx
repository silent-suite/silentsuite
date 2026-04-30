import { Shield, CalendarDays, CheckSquare, Users, Settings, Plus, ChevronLeft, ChevronRight, Search, RefreshCw } from 'lucide-react'

const NAV = [
  { icon: CalendarDays, label: 'Calendar', active: true },
  { icon: CheckSquare, label: 'Tasks' },
  { icon: Users, label: 'Contacts' },
  { icon: Settings, label: 'Settings' },
]

const CALENDARS = [
  { name: 'Personal', color: '#34d399' },
  { name: 'Work', color: '#f59e0b' },
  { name: 'Family', color: '#60a5fa' },
]

// Week starting Mon Apr 27 — Wed Apr 29 is "today" (matches the date the post
// mentions in copy). Numbers are intentionally hardcoded for layout stability.
const WEEK_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const WEEK_DATES = [27, 28, 29, 30, 1, 2, 3]
const TODAY_INDEX = 2 // Wed

const HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17]

interface CalendarEvent {
  day: number      // 0-6
  startHour: number
  endHour: number
  title: string
  calendar: 'Personal' | 'Work' | 'Family'
}

// All events are at least 1h tall (36px) so the title + time line render
// without clipping inside the grid cells.
const EVENTS: CalendarEvent[] = [
  { day: 0, startHour: 9,  endHour: 10,   title: 'Team Standup',       calendar: 'Work' },
  { day: 1, startHour: 11, endHour: 12,   title: '1:1 with Alex',      calendar: 'Work' },
  { day: 1, startHour: 12.5, endHour: 13.5, title: 'Lunch · Sarah',    calendar: 'Personal' },
  { day: 2, startHour: 9,  endHour: 10,   title: 'Team Standup',       calendar: 'Work' },
  { day: 2, startHour: 14, endHour: 15.5, title: 'Q1 Planning Review', calendar: 'Work' },
  { day: 3, startHour: 10, endHour: 11,   title: 'Coffee with Sarah',  calendar: 'Personal' },
  { day: 3, startHour: 16, endHour: 17,   title: 'Family call',        calendar: 'Family' },
  { day: 4, startHour: 16, endHour: 17,   title: 'Demo Day',           calendar: 'Work' },
]

const CAL_COLOR: Record<CalendarEvent['calendar'], string> = {
  Personal: '#34d399',
  Work: '#34d399', // unify work + personal under teal so the SilentSuite teal reads as "the" brand color
  Family: '#60a5fa',
}

// Used for events painted in amber (Personal lunch / Coffee) so the grid isn't
// monochrome teal. We intentionally pick a single non-teal accent.
const CAL_ACCENT: Partial<Record<CalendarEvent['calendar'], string>> = {
  Personal: '#f59e0b',
}

export function MockCalendarDesktop() {
  return (
    <div className="flex h-[520px] text-navy-200 font-sans select-none">
      {/* Sidebar */}
      <aside className="w-44 border-r border-white/5 bg-navy-900/60 flex flex-col">
        <div className="px-4 h-12 flex items-center gap-2 border-b border-white/5">
          <div className="w-6 h-6 rounded bg-teal-400/15 border border-teal-400/30 flex items-center justify-center flex-shrink-0">
            <Shield className="w-3.5 h-3.5 text-teal-400" />
          </div>
          <span className="text-white text-sm font-semibold">SilentSuite</span>
        </div>

        {/* Mini-month */}
        <div className="px-3 py-3 border-b border-white/5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-semibold text-white">April 2026</span>
            <div className="flex gap-0.5 text-navy-400">
              <ChevronLeft className="w-3 h-3" />
              <ChevronRight className="w-3 h-3" />
            </div>
          </div>
          <div className="grid grid-cols-7 gap-y-0.5 text-[9px] text-navy-500 text-center mb-1">
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
              <span key={i}>{d}</span>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-y-0.5 text-[9px] text-navy-300 text-center">
            {Array.from({ length: 30 }, (_, i) => i + 1).map((n) => (
              <span
                key={n}
                className={
                  n === 29
                    ? 'rounded-full bg-teal-400 text-navy-950 font-semibold w-4 h-4 mx-auto leading-4'
                    : n >= 27
                      ? 'text-white'
                      : ''
                }
              >
                {n}
              </span>
            ))}
          </div>
        </div>

        {/* My calendars */}
        <div className="px-3 py-3 border-b border-white/5">
          <div className="text-[10px] uppercase tracking-wide text-navy-500 mb-2">My calendars</div>
          <ul className="space-y-1.5">
            {CALENDARS.map((c) => (
              <li key={c.name} className="flex items-center gap-2 text-xs text-navy-200">
                <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: c.color }} />
                {c.name}
              </li>
            ))}
          </ul>
        </div>

        {/* Nav */}
        <nav className="px-2 py-2 flex-1">
          <ul className="space-y-0.5">
            {NAV.map(({ icon: Icon, label, active }) => (
              <li key={label}>
                <div
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-xs ${
                    active
                      ? 'bg-teal-400/10 text-teal-300 font-semibold'
                      : 'text-navy-300'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </div>
              </li>
            ))}
          </ul>
        </nav>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col">
        {/* Top bar */}
        <div className="h-12 px-4 flex items-center justify-between border-b border-white/5 bg-navy-900/30">
          <div className="flex items-center gap-3">
            <button className="text-xs px-2.5 py-1 rounded-md border border-white/10 text-white hover:bg-white/5">Today</button>
            <ChevronLeft className="w-3.5 h-3.5 text-navy-400" />
            <ChevronRight className="w-3.5 h-3.5 text-navy-400" />
            <span className="text-sm font-semibold text-white">Apr 27 — May 3, 2026</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 text-[10px] text-teal-400 px-2 py-1 rounded-md bg-teal-400/10">
              <RefreshCw className="w-3 h-3" />
              Synced
            </div>
            <div className="flex items-center gap-0.5 text-[10px] text-navy-300 rounded-md border border-white/10 overflow-hidden">
              <span className="px-2 py-1 bg-white/5 text-white">Week</span>
              <span className="px-2 py-1">Month</span>
            </div>
            <button className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-md bg-teal-400 text-navy-950 font-semibold">
              <Plus className="w-3.5 h-3.5" />
              New event
            </button>
          </div>
        </div>

        {/* Week grid */}
        <div className="flex-1 grid grid-cols-[40px_repeat(7,1fr)] text-[10px]">
          {/* Header row */}
          <div className="border-b border-white/5" />
          {WEEK_DAYS.map((d, i) => (
            <div
              key={i}
              className={`text-center py-1.5 border-b border-l border-white/5 ${
                i === TODAY_INDEX ? 'bg-teal-400/5' : ''
              }`}
            >
              <div className={`text-[10px] uppercase ${i === TODAY_INDEX ? 'text-teal-400' : 'text-navy-400'}`}>{d}</div>
              <div
                className={`text-sm font-semibold ${
                  i === TODAY_INDEX ? 'text-teal-400' : 'text-white'
                }`}
              >
                {WEEK_DATES[i]}
              </div>
            </div>
          ))}

          {/* Body: hour gutter + 7 day columns */}
          <div className="row-span-1">
            {HOURS.map((h) => (
              <div key={h} className="h-9 text-right pr-1 pt-0.5 text-[9px] text-navy-500">
                {h.toString().padStart(2, '0')}:00
              </div>
            ))}
          </div>
          {WEEK_DAYS.map((_, dayIdx) => (
            <div
              key={dayIdx}
              className={`relative border-l border-white/5 ${
                dayIdx === TODAY_INDEX ? 'bg-teal-400/[0.03]' : ''
              }`}
            >
              {HOURS.map((_, i) => (
                <div key={i} className="h-9 border-b border-white/5" />
              ))}
              {/* Events on this day */}
              {EVENTS.filter((e) => e.day === dayIdx).map((e, i) => {
                const top = (e.startHour - HOURS[0]) * 36 // 36 = h-9 (2.25rem)
                const height = (e.endHour - e.startHour) * 36
                const baseColor = CAL_ACCENT[e.calendar] ?? CAL_COLOR[e.calendar]
                return (
                  <div
                    key={i}
                    className="absolute left-1 right-1 rounded px-1.5 py-0.5 text-[9px] font-semibold leading-tight overflow-hidden border-l-2"
                    style={{
                      top: `${top}px`,
                      height: `${Math.max(height, 18)}px`,
                      backgroundColor: `${baseColor}22`,
                      borderColor: baseColor,
                      color: baseColor,
                    }}
                  >
                    <div className="truncate">{e.title}</div>
                    <div className="text-[8px] opacity-70">
                      {Math.floor(e.startHour).toString().padStart(2, '0')}:
                      {((e.startHour % 1) * 60).toString().padStart(2, '0')}
                    </div>
                  </div>
                )
              })}
              {/* Now indicator on today */}
              {dayIdx === TODAY_INDEX ? (
                <div
                  className="absolute left-0 right-0 z-10 pointer-events-none"
                  style={{ top: `${(11.4 - HOURS[0]) * 36}px` }}
                >
                  <div className="h-px bg-teal-400" />
                  <div className="absolute -left-1 -top-1 w-2 h-2 rounded-full bg-teal-400" />
                </div>
              ) : null}
            </div>
          ))}
        </div>

        {/* Footer status */}
        <div className="h-6 border-t border-white/5 px-3 flex items-center justify-between text-[10px] text-navy-500 bg-navy-900/30">
          <div className="flex items-center gap-1.5">
            <Search className="w-3 h-3" />
            <span>tim@silentsuite.io · End-to-end encrypted</span>
          </div>
          <span>{EVENTS.length} events this week</span>
        </div>
      </div>
    </div>
  )
}

export function MockCalendarMobile() {
  return (
    <div className="flex flex-col h-full text-navy-200 font-sans select-none">
      {/* App bar */}
      <div className="px-4 pt-7 pb-2 flex items-center justify-between bg-navy-950">
        <div>
          <div className="text-[10px] text-navy-400 uppercase tracking-wide">Today</div>
          <div className="text-base font-semibold text-white">Wed, 29 Apr</div>
        </div>
        <button className="w-7 h-7 rounded-full bg-teal-400 text-navy-950 flex items-center justify-center">
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {/* Agenda body */}
      <div className="flex-1 overflow-hidden px-3 pb-2 space-y-3">
        <AgendaSection
          label="Today · 4 events"
          accent="text-teal-400"
          items={[
            { time: '09:00', title: 'Team Standup', dur: '1h', cal: 'Work', color: '#34d399' },
            { time: '11:00', title: '1:1 with Alex', dur: '1h', cal: 'Work', color: '#34d399' },
            { time: '12:30', title: 'Lunch · Sarah', dur: '1h', cal: 'Personal', color: '#f59e0b' },
            { time: '14:00', title: 'Q1 Planning Review', dur: '1h 30m', cal: 'Work', color: '#34d399' },
          ]}
        />
        <AgendaSection
          label="Tomorrow"
          accent="text-navy-400"
          items={[
            { time: '10:00', title: 'Coffee with Sarah', dur: '1h', cal: 'Personal', color: '#f59e0b' },
            { time: '16:00', title: 'Family call', dur: '1h', cal: 'Family', color: '#60a5fa' },
          ]}
        />
      </div>

      <BottomNav active="Calendar" />
    </div>
  )
}

function AgendaSection({
  label,
  accent,
  items,
}: {
  label: string
  accent: string
  items: { time: string; title: string; dur: string; cal: string; color: string }[]
}) {
  return (
    <div>
      <div className={`text-[10px] uppercase tracking-wide mb-1.5 ${accent}`}>{label}</div>
      <ul className="space-y-1.5">
        {items.map((e, i) => (
          <li
            key={i}
            className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg bg-navy-900/70 border border-white/5"
          >
            <div
              className="w-1 self-stretch rounded-full"
              style={{ backgroundColor: e.color }}
            />
            <div className="w-10 text-[10px] font-semibold text-white tabular-nums">
              {e.time}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs text-white truncate">{e.title}</div>
              <div className="text-[10px] text-navy-400">
                {e.cal} · {e.dur}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function BottomNav({ active }: { active: 'Calendar' | 'Tasks' | 'Contacts' | 'Settings' }) {
  const items: { label: typeof active; icon: typeof CalendarDays }[] = [
    { label: 'Calendar', icon: CalendarDays },
    { label: 'Tasks', icon: CheckSquare },
    { label: 'Contacts', icon: Users },
    { label: 'Settings', icon: Settings },
  ]
  return (
    <nav className="border-t border-white/5 bg-navy-900/80 px-2 py-2 pb-3 flex items-center justify-around">
      {items.map(({ label, icon: Icon }) => (
        <div
          key={label}
          className={`flex flex-col items-center gap-0.5 px-3 py-1 rounded-lg ${
            label === active ? 'text-teal-400' : 'text-navy-400'
          }`}
        >
          <Icon className="w-4 h-4" />
          <span className="text-[9px]">{label}</span>
        </div>
      ))}
    </nav>
  )
}
