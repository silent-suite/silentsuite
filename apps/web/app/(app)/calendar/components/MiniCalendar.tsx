'use client'

import { useCallback, useMemo } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useCalendarStore, type CalendarView } from '@/app/stores/use-calendar-store'

const WEEKDAY_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function isSameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()
}

interface DayCell {
  date: Date
  inCurrentMonth: boolean
  isToday: boolean
  isSelected: boolean
  hasEvent: boolean
}

export function MiniCalendar() {
  const router = useRouter()
  const pathname = usePathname()
  const currentDate = useCalendarStore((s) => s.currentDate)
  const setCurrentDate = useCalendarStore((s) => s.setCurrentDate)
  const currentView = useCalendarStore((s) => s.currentView)
  const setCurrentView = useCalendarStore((s) => s.setCurrentView)
  const events = useCalendarStore((s) => s.events)

  const today = useMemo(() => new Date(), [])

  const handleDayClick = useCallback(
    (date: Date) => {
      setCurrentDate(date)
      // Stay in the current view — just navigate to the clicked date
      if (!pathname.startsWith('/calendar')) {
        router.push('/calendar')
      }
    },
    [setCurrentDate, pathname, router],
  )

  const [miniMonth, miniYear] = useMemo(
    () => [currentDate.getMonth(), currentDate.getFullYear()],
    [currentDate],
  )

  const days = useMemo((): DayCell[] => {
    const firstOfMonth = new Date(miniYear, miniMonth, 1)
    // Monday = 0, Sunday = 6
    let startDow = firstOfMonth.getDay() - 1
    if (startDow < 0) startDow = 6

    const result: DayCell[] = []

    // Days from previous month
    for (let i = startDow - 1; i >= 0; i--) {
      const d = new Date(miniYear, miniMonth, -i)
      result.push({
        date: d,
        inCurrentMonth: false,
        isToday: isSameDay(d, today),
        isSelected: isSameDay(d, currentDate),
        hasEvent: events.some((e) => isSameDay(e.startDate, d)),
      })
    }

    // Days in current month
    const daysInMonth = new Date(miniYear, miniMonth + 1, 0).getDate()
    for (let day = 1; day <= daysInMonth; day++) {
      const d = new Date(miniYear, miniMonth, day)
      result.push({
        date: d,
        inCurrentMonth: true,
        isToday: isSameDay(d, today),
        isSelected: isSameDay(d, currentDate),
        hasEvent: events.some((e) => isSameDay(e.startDate, d)),
      })
    }

    // Fill remaining cells (up to 42 = 6 rows)
    const remaining = 42 - result.length
    for (let i = 1; i <= remaining; i++) {
      const d = new Date(miniYear, miniMonth + 1, i)
      result.push({
        date: d,
        inCurrentMonth: false,
        isToday: isSameDay(d, today),
        isSelected: isSameDay(d, currentDate),
        hasEvent: events.some((e) => isSameDay(e.startDate, d)),
      })
    }

    return result
  }, [miniYear, miniMonth, currentDate, events, today])

  const monthLabel = new Date(miniYear, miniMonth).toLocaleString('default', {
    month: 'long',
    year: 'numeric',
  })

  function navigateMiniMonth(offset: number) {
    setCurrentDate(new Date(miniYear, miniMonth + offset, 1))
  }

  return (
    <div className="px-2 py-3">
      {/* Month header */}
      <div className="flex items-center justify-between px-1 mb-2">
        <span className="text-xs font-medium text-[rgb(var(--foreground))]">{monthLabel}</span>
        <div className="flex gap-0.5">
          <button
            onClick={() => navigateMiniMonth(-1)}
            className="rounded p-0.5 text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500"
            aria-label="Previous month"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => navigateMiniMonth(1)}
            className="rounded p-0.5 text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500"
            aria-label="Next month"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Weekday headers */}
      <div className="grid grid-cols-7 mb-1">
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="text-center text-[10px] font-medium text-[rgb(var(--muted))]">
            {label}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7">
        {days.map((cell, i) => (
          <button
            key={i}
            onClick={() => handleDayClick(cell.date)}
            className={`relative flex h-7 w-full items-center justify-center rounded text-[11px] transition-colors duration-100 focus:outline-none focus:ring-2 focus:ring-emerald-500 ${
              cell.isToday
                ? 'bg-[rgb(var(--primary))] font-bold text-white'
                : cell.isSelected
                  ? 'bg-[rgb(var(--primary))]/20 font-medium text-[rgb(var(--primary))]'
                  : cell.inCurrentMonth
                    ? 'text-[rgb(var(--foreground))] hover:bg-[rgb(var(--background))]'
                    : 'text-[rgb(var(--muted))]/50 hover:bg-[rgb(var(--background))]'
            }`}
          >
            {cell.date.getDate()}
            {cell.hasEvent && !cell.isToday && (
              <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 h-1 w-1 rounded-full bg-[rgb(var(--primary))]" />
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
