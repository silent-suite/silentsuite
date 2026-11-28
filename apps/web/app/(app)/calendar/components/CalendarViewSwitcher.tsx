'use client'

import { useCalendarStore, type CalendarView } from '@/app/stores/use-calendar-store'

const views: { value: CalendarView; label: string; shortLabel: string }[] = [
  { value: 'week', label: 'Week', shortLabel: 'W' },
  { value: 'month', label: 'Month', shortLabel: 'M' },
]

export function CalendarViewSwitcher() {
  const currentView = useCalendarStore((s) => s.currentView)
  const setCurrentView = useCalendarStore((s) => s.setCurrentView)

  return (
    <div
      className="inline-flex rounded-lg border border-[rgb(var(--border))] overflow-hidden"
      role="group"
      aria-label="Calendar view"
    >
      {views.map(({ value, label, shortLabel }) => (
        <button
          key={value}
          onClick={() => setCurrentView(value)}
          aria-pressed={currentView === value}
          className={`no-min-size px-3 py-1.5 text-sm font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset ${
            currentView === value
              ? 'bg-[rgb(var(--primary-strong))] text-white focus-visible:ring-white'
              : 'bg-[rgb(var(--surface))] text-[rgb(var(--muted))] focus-visible:ring-emerald-500 hover:text-[rgb(var(--foreground))] active:bg-[rgb(var(--border))]'
          }`}
        >
          <span className="hidden sm:inline">{label}</span>
          <span className="sm:hidden">{shortLabel}</span>
        </button>
      ))}
    </div>
  )
}
