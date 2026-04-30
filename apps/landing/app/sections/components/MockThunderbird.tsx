import { Lock, Mail, Calendar, Users, FileText } from 'lucide-react'

/**
 * Lower-fidelity Thunderbird-style window for the SyncEverywhere strip.
 * Three-pane look (left rail / folder list / content) with SilentSuite's
 * encrypted calendars surfacing in the calendar tab — same idea as
 * MockAppleCalendar but small enough to live in a 4-up grid.
 */

const FOLDERS = [
  { name: 'Personal',  count: 32 },
  { name: 'Work',      count: 18, active: true },
  { name: 'Family',    count: 4 },
  { name: 'Birthdays', count: 9 },
]

const TODAY = [
  { time: '09:00', title: 'Team Standup', cal: 'Work', color: '#34d399' },
  { time: '11:00', title: '1:1 with Alex', cal: 'Work', color: '#34d399' },
  { time: '14:00', title: 'Q1 Planning Review', cal: 'Work', color: '#34d399' },
  { time: '16:00', title: 'Pick up groceries', cal: 'Personal', color: '#3b82f6' },
]

export function MockThunderbird() {
  return (
    <div
      className="relative rounded-lg overflow-hidden bg-[#1f2937] ring-1 ring-white/10 select-none"
      style={{
        boxShadow:
          '0 20px 40px -20px rgba(15, 23, 42, 0.5), 0 6px 16px -6px rgba(15, 23, 42, 0.3)',
      }}
    >
      {/* Window chrome — slightly different from Mac to read as Thunderbird */}
      <div className="flex items-center gap-2 px-3 h-7 bg-[#374151] border-b border-black/40 text-[10px] text-[#d1d5db]">
        <div className="flex items-center gap-1 flex-shrink-0 text-[#9ca3af]">
          <span className="w-2 h-2 rounded-full bg-[#9ca3af]/40" />
          <span className="w-2 h-2 rounded-full bg-[#9ca3af]/40" />
          <span className="w-2 h-2 rounded-full bg-[#9ca3af]/40" />
        </div>
        <span>Thunderbird</span>
      </div>

      <div className="flex h-[280px] text-[#d1d5db]">
        {/* Left rail (icons) */}
        <div className="w-9 bg-[#111827] border-r border-black/40 flex flex-col items-center py-2 gap-2">
          <Mail     className="w-3.5 h-3.5 text-[#9ca3af]" />
          <Calendar className="w-3.5 h-3.5 text-teal-400" />
          <Users    className="w-3.5 h-3.5 text-[#9ca3af]" />
          <FileText className="w-3.5 h-3.5 text-[#9ca3af]" />
        </div>

        {/* Folder pane */}
        <aside className="w-32 bg-[#1f2937] border-r border-black/40 px-2 py-2 text-[10px]">
          <div className="text-[8px] uppercase tracking-wide text-[#6b7280] mb-1.5">
            iCloud
          </div>
          <ul className="space-y-1 mb-3">
            <li className="flex items-center gap-1.5 text-[#d1d5db]">
              <span className="w-2 h-2 rounded-sm bg-[#3b82f6]" />
              Personal
            </li>
          </ul>
          <div className="text-[8px] uppercase tracking-wide text-[#6b7280] mb-1.5 flex items-center gap-1">
            SilentSuite <Lock className="w-2 h-2 text-teal-400" />
          </div>
          <ul className="space-y-1">
            {FOLDERS.map((f) => (
              <li
                key={f.name}
                className={`flex items-center justify-between gap-1.5 ${
                  f.active ? 'bg-teal-400/10 -mx-1 px-1 rounded' : ''
                }`}
              >
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-sm bg-teal-400" />
                  {f.name}
                </span>
                <span className="text-[#6b7280] text-[8px]">{f.count}</span>
              </li>
            ))}
          </ul>
        </aside>

        {/* Today list */}
        <div className="flex-1 bg-[#111827] px-3 py-2">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-white">Today</span>
            <span className="text-[9px] text-[#6b7280]">Wed 29 Apr</span>
          </div>
          <ul className="space-y-1">
            {TODAY.map((e, i) => (
              <li
                key={i}
                className="flex items-center gap-2 px-1.5 py-1 rounded text-[10px] bg-[#1f2937]/60"
              >
                <span
                  className="w-0.5 h-4 rounded-full"
                  style={{ backgroundColor: e.color }}
                />
                <span className="w-9 tabular-nums text-[#9ca3af]">{e.time}</span>
                <span className="flex-1 text-white truncate">{e.title}</span>
                {e.cal === 'Work' ? (
                  <Lock className="w-2 h-2 text-teal-400" />
                ) : null}
              </li>
            ))}
          </ul>
          <div className="mt-3 pt-2 border-t border-white/5 text-[8px] text-[#6b7280]">
            CalDAV via SilentSuite bridge · localhost:37358
          </div>
        </div>
      </div>
    </div>
  )
}
