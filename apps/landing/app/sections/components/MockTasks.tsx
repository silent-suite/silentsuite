import { Shield, CalendarDays, CheckSquare, Users, Settings, Plus, ChevronDown, Flag } from 'lucide-react'
import { BottomNav } from './MockCalendar'

const NAV = [
  { icon: CalendarDays, label: 'Calendar' },
  { icon: CheckSquare, label: 'Tasks', active: true },
  { icon: Users, label: 'Contacts' },
  { icon: Settings, label: 'Settings' },
]

type Priority = 'urgent' | 'high' | 'medium' | 'low'

interface Task {
  done: boolean
  title: string
  list: string
  due?: string
  priority: Priority
  overdue?: boolean
}

const PRIORITY_COLOR: Record<Priority, string> = {
  urgent: '#ef4444',
  high:   '#fb923c',
  medium: '#f59e0b',
  low:    '#34d399',
}

const TASKS: Task[] = [
  { done: false, title: 'Book flights for offsite',         list: 'Work',     due: 'Yesterday',     priority: 'urgent', overdue: true },
  { done: false, title: 'Prepare presentation deck',        list: 'Work',     due: 'Tomorrow',      priority: 'high' },
  { done: false, title: 'Review pull request #142',         list: 'Work',     due: 'Today',         priority: 'medium' },
  { done: false, title: 'Buy groceries · oat milk, bread',  list: 'Personal', due: 'Today',         priority: 'medium' },
  { done: false, title: 'Renew passport',                   list: 'Personal', due: 'Sat 2 May',     priority: 'high' },
  { done: false, title: 'Update docs for v2 API',           list: 'Work',                          priority: 'low' },
  { done: true,  title: 'Schedule annual review',           list: 'Work',     due: 'Mon 27 Apr',    priority: 'medium' },
  { done: true,  title: 'File quarterly invoice',           list: 'Work',     due: 'Fri 24 Apr',    priority: 'high' },
]

const LISTS = [
  { name: 'Work',     color: '#34d399', count: 12 },
  { name: 'Personal', color: '#f59e0b', count: 5 },
  { name: 'Side proj.', color: '#a78bfa', count: 3 },
]

export function MockTasksDesktop() {
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

        <div className="px-3 py-3 border-b border-white/5">
          <div className="text-[10px] uppercase tracking-wide text-navy-500 mb-2">Lists</div>
          <ul className="space-y-1.5 text-xs text-navy-200">
            {LISTS.map((l) => (
              <li key={l.name} className="flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: l.color }} />
                  {l.name}
                </span>
                <span className="text-navy-500 text-[10px]">{l.count}</span>
              </li>
            ))}
          </ul>
        </div>

        <nav className="px-2 py-2 flex-1">
          <ul className="space-y-0.5">
            {NAV.map(({ icon: Icon, label, active }) => (
              <li key={label}>
                <div
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-xs ${
                    active ? 'bg-teal-400/10 text-teal-300 font-semibold' : 'text-navy-300'
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
        <div className="h-12 px-4 flex items-center justify-between border-b border-white/5 bg-navy-900/30">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-white">All tasks</span>
            <span className="text-[11px] text-navy-400">6 open · 2 done</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 text-[10px] text-navy-300 px-2 py-1 rounded-md border border-white/10">
              Sort: Due date <ChevronDown className="w-3 h-3" />
            </div>
            <button className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-md bg-teal-400 text-navy-950 font-semibold">
              <Plus className="w-3.5 h-3.5" />
              New task
            </button>
          </div>
        </div>

        {/* Quick add */}
        <div className="px-4 py-2 border-b border-white/5">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-navy-900 border border-white/5">
            <Plus className="w-3.5 h-3.5 text-navy-400" />
            <span className="text-xs text-navy-500">Add a task — type and press Enter</span>
          </div>
        </div>

        {/* List */}
        <ul className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
          {TASKS.map((t, i) => (
            <li
              key={i}
              className={`flex items-center gap-3 px-3 py-2 rounded-md ${
                t.overdue ? 'bg-red-500/5 border border-red-500/20' : 'hover:bg-white/[0.02]'
              }`}
            >
              <div
                className={`w-4 h-4 rounded-md border flex items-center justify-center flex-shrink-0 ${
                  t.done
                    ? 'bg-teal-400 border-teal-400'
                    : 'border-navy-500'
                }`}
              >
                {t.done ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="#0A1018" strokeWidth="3" className="w-2.5 h-2.5">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : null}
              </div>
              <div className="flex-1 min-w-0">
                <div
                  className={`text-xs ${
                    t.done ? 'text-navy-500 line-through' : 'text-white'
                  }`}
                >
                  {t.title}
                </div>
                <div className="text-[10px] text-navy-400 flex items-center gap-2 mt-0.5">
                  <span>{t.list}</span>
                  {t.due ? (
                    <>
                      <span>·</span>
                      <span className={t.overdue ? 'text-red-400 font-semibold' : ''}>{t.due}</span>
                    </>
                  ) : null}
                </div>
              </div>
              <Flag
                className="w-3 h-3 flex-shrink-0"
                style={{ color: PRIORITY_COLOR[t.priority] }}
              />
            </li>
          ))}
        </ul>

        <div className="h-6 border-t border-white/5 px-3 flex items-center justify-between text-[10px] text-navy-500">
          <span>Encrypted on device · synced 12s ago</span>
          <span>8 tasks total</span>
        </div>
      </div>
    </div>
  )
}

export function MockTasksMobile() {
  return (
    <div className="flex flex-col h-full text-navy-200 font-sans select-none">
      <div className="px-4 pt-7 pb-2 flex items-center justify-between bg-navy-950">
        <div>
          <div className="text-[10px] text-navy-400 uppercase tracking-wide">All tasks</div>
          <div className="text-base font-semibold text-white">6 open</div>
        </div>
        <button className="w-7 h-7 rounded-full bg-teal-400 text-navy-950 flex items-center justify-center">
          <Plus className="w-4 h-4" />
        </button>
      </div>

      <div className="px-3 pb-1.5">
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-navy-900 border border-white/5">
          <Plus className="w-3.5 h-3.5 text-navy-400" />
          <span className="text-[11px] text-navy-500">Add a task</span>
        </div>
      </div>

      <ul className="flex-1 overflow-hidden px-2 py-1 space-y-1">
        {TASKS.slice(0, 7).map((t, i) => (
          <li
            key={i}
            className={`flex items-center gap-2 px-2 py-1.5 rounded-md ${
              t.overdue ? 'bg-red-500/5 border border-red-500/20' : ''
            }`}
          >
            <div
              className={`w-3.5 h-3.5 rounded-md border flex items-center justify-center flex-shrink-0 ${
                t.done ? 'bg-teal-400 border-teal-400' : 'border-navy-500'
              }`}
            >
              {t.done ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="#0A1018" strokeWidth="3" className="w-2 h-2">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : null}
            </div>
            <div className="flex-1 min-w-0">
              <div className={`text-[11px] ${t.done ? 'text-navy-500 line-through' : 'text-white'}`}>
                {t.title}
              </div>
              <div className="text-[9px] text-navy-400 flex items-center gap-1.5">
                <span>{t.list}</span>
                {t.due ? (
                  <>
                    <span>·</span>
                    <span className={t.overdue ? 'text-red-400 font-semibold' : ''}>{t.due}</span>
                  </>
                ) : null}
              </div>
            </div>
            <Flag className="w-2.5 h-2.5 flex-shrink-0" style={{ color: PRIORITY_COLOR[t.priority] }} />
          </li>
        ))}
      </ul>

      <BottomNav active="Tasks" />
    </div>
  )
}
