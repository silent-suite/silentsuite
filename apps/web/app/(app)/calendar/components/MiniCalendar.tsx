'use client'

import { useCallback, useMemo } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { expandRecurrence, type CalendarEvent } from '@silentsuite/core'
import { useCalendarStore } from '@/app/stores/use-calendar-store'
import { useCalendarListStore } from '@/app/stores/use-calendar-list-store'
import { usePreferencesStore } from '@/app/stores/use-preferences-store'
import { formatDate } from '@/app/lib/date'

const WEEKDAY_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const FALLBACK_CALENDAR_COLOR = '#10b981'
const MAX_DOTS_PER_DAY = 4

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function nextDay(date: Date): Date {
  const next = startOfDay(date)
  next.setDate(next.getDate() + 1)
  return next
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

function formatDayLabel(date: Date, dateFormat: import('@silentsuite/core').DateFormat): string {
  return formatDate(date, dateFormat, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

function eventOverlapsDay(startDate: Date, endDate: Date, day: Date): boolean {
  if (endDate <= startDate) return isSameDay(startDate, day)
  const dayStart = startOfDay(day)
  return startDate < nextDay(dayStart) && endDate > dayStart
}

function addDotColor(dotsByDay: Map<string, string[]>, day: Date, color: string) {
  const key = dateKey(day)
  const colors = dotsByDay.get(key) ?? []
  if (!colors.includes(color)) {
    colors.push(color)
    dotsByDay.set(key, colors)
  }
}

function addEventDots(
  dotsByDay: Map<string, string[]>,
  days: Date[],
  event: CalendarEvent,
  color: string,
  rangeStart: Date,
  rangeEnd: Date,
) {
  const addSpan = (startDate: Date, endDate: Date) => {
    if (endDate < rangeStart || startDate > rangeEnd) return
    for (const day of days) {
      if (eventOverlapsDay(startDate, endDate, day)) addDotColor(dotsByDay, day, color)
    }
  }

  if (!event.recurrenceRule) {
    addSpan(event.startDate, event.endDate)
    return
  }

  const durationMs = Math.max(0, event.endDate.getTime() - event.startDate.getTime())
  const expansionStart = new Date(rangeStart.getTime() - Math.max(durationMs, 86400000))
  const occurrences = expandRecurrence(
    event.recurrenceRule,
    event.startDate,
    { start: expansionStart, end: rangeEnd },
    event.exceptions,
  )

  for (const occurrenceStart of occurrences) {
    addSpan(occurrenceStart, new Date(occurrenceStart.getTime() + durationMs))
  }
}

interface DayCell {
  date: Date
  inCurrentMonth: boolean
  isToday: boolean
  isSelected: boolean
  eventDotColors: string[]
}

export function MiniCalendar() {
  const router = useRouter()
  const pathname = usePathname()
  const currentDate = useCalendarStore((s) => s.currentDate)
  const setCurrentDate = useCalendarStore((s) => s.setCurrentDate)
  const events = useCalendarStore((s) => s.events)
  const calendars = useCalendarListStore((s) => s.calendars)

  const today = useMemo(() => new Date(), [])
  const dateFormat = usePreferencesStore((s) => s.dateFormat)

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

  const calendarColors = useMemo(() => {
    const colors = new Map<string, string>()
    for (const calendar of calendars) colors.set(calendar.id, calendar.color)
    if (!colors.has('default')) colors.set('default', FALLBACK_CALENDAR_COLOR)
    return colors
  }, [calendars])

  const visibleCalendarIds = useMemo(() => {
    const ids = new Set(calendars.filter((calendar) => calendar.visible).map((calendar) => calendar.id))
    ids.add('default')
    return ids
  }, [calendars])

  const days = useMemo((): DayCell[] => {
    const firstOfMonth = new Date(miniYear, miniMonth, 1)
    // Monday = 0, Sunday = 6
    let startDow = firstOfMonth.getDay() - 1
    if (startDow < 0) startDow = 6

    const cellDates: { date: Date; inCurrentMonth: boolean }[] = []

    // Days from previous month
    for (let i = startDow - 1; i >= 0; i--) {
      const d = new Date(miniYear, miniMonth, -i)
      cellDates.push({ date: d, inCurrentMonth: false })
    }

    // Days in current month
    const daysInMonth = new Date(miniYear, miniMonth + 1, 0).getDate()
    for (let day = 1; day <= daysInMonth; day++) {
      const d = new Date(miniYear, miniMonth, day)
      cellDates.push({ date: d, inCurrentMonth: true })
    }

    // Fill remaining cells (up to 42 = 6 rows)
    const remaining = 42 - cellDates.length
    for (let i = 1; i <= remaining; i++) {
      const d = new Date(miniYear, miniMonth + 1, i)
      cellDates.push({ date: d, inCurrentMonth: false })
    }

    const dotsByDay = new Map<string, string[]>()
    const visibleDays = cellDates.map((cell) => cell.date)
    const rangeStart = startOfDay(visibleDays[0]!)
    const rangeEnd = nextDay(visibleDays[visibleDays.length - 1]!)

    for (const event of events) {
      const calendarId = event.calendarId ?? 'default'
      if (!visibleCalendarIds.has(calendarId)) continue
      addEventDots(
        dotsByDay,
        visibleDays,
        event,
        calendarColors.get(calendarId) ?? FALLBACK_CALENDAR_COLOR,
        rangeStart,
        rangeEnd,
      )
    }

    return cellDates.map((cell) => ({
      date: cell.date,
      inCurrentMonth: cell.inCurrentMonth,
      isToday: isSameDay(cell.date, today),
      isSelected: isSameDay(cell.date, currentDate),
      eventDotColors: dotsByDay.get(dateKey(cell.date)) ?? [],
    }))
  }, [miniYear, miniMonth, currentDate, events, today, calendarColors, visibleCalendarIds])

  const monthLabel = formatDate(new Date(miniYear, miniMonth), 'system', { month: 'long', year: 'numeric' })

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
            aria-label={formatDayLabel(cell.date, dateFormat)}
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
            {cell.eventDotColors.length > 0 && (
              <span className="absolute bottom-0.5 left-1/2 flex max-w-[22px] -translate-x-1/2 gap-0.5 overflow-hidden" aria-hidden="true">
                {cell.eventDotColors.slice(0, MAX_DOTS_PER_DAY).map((color, index) => (
                  <span
                    key={`${color}-${index}`}
                    className="h-1 w-1 shrink-0 rounded-full ring-[0.5px] ring-[rgb(var(--background))]"
                    style={{ backgroundColor: color }}
                  />
                ))}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
