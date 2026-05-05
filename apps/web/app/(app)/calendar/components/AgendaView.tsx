'use client'

import { useMemo } from 'react'
import { Clock, MapPin } from 'lucide-react'
import { CalendarEmptyState } from '@/app/components/empty-state'
import type { CalendarEvent } from '@silentsuite/core'
import { usePreferencesStore } from '@/app/stores/use-preferences-store'
import { resolveUserTimezone, shortTimezoneLabel } from '@/app/lib/tz'

interface AgendaViewProps {
  events: CalendarEvent[]
  currentDate: Date
  onEventClick?: (eventId: string) => void
}

function formatTime(date: Date, tz: string): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: tz })
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

export function AgendaView({ events, currentDate, onEventClick }: AgendaViewProps) {
  const defaultTimezonePref = usePreferencesStore((s) => s.defaultTimezone)
  const userTz = resolveUserTimezone(defaultTimezonePref)
  const dayEvents = useMemo(() => {
    const currentDayStart = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate())
    const currentDayEnd = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate(), 23, 59, 59, 999)

    return events
      .filter((e) => {
        const start = e.startDate instanceof Date ? e.startDate : new Date(e.startDate)
        const end = e.endDate instanceof Date ? e.endDate : new Date(e.endDate)

        // Event overlaps with current day if it starts before day ends AND ends after day starts.
        // For all-day events, endDate follows iCal DTEND;VALUE=DATE convention (exclusive — the
        // day *after* the last day of the event), so use `>` rather than `>=` to avoid bleeding
        // a single-day event onto the morning of the next day.
        const endComparison = e.allDay ? end > currentDayStart : end >= currentDayStart
        return start <= currentDayEnd && endComparison
      })
      .sort((a, b) => {
        if (a.allDay && !b.allDay) return -1
        if (!a.allDay && b.allDay) return 1
        const aStart = a.startDate instanceof Date ? a.startDate : new Date(a.startDate)
        const bStart = b.startDate instanceof Date ? b.startDate : new Date(b.startDate)
        return aStart.getTime() - bStart.getTime()
      })
  }, [events, currentDate])

  if (dayEvents.length === 0) {
    return <CalendarEmptyState />
  }

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      {dayEvents.map((event) => (
        <button
          key={event.id}
          type="button"
          onClick={() => onEventClick?.(event.id)}
          className="w-full text-left rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-3 transition-colors hover:border-[rgb(var(--primary))] focus:outline-none focus:ring-2 focus:ring-emerald-500"
        >
          <div className="flex items-start gap-3">
            <div className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-[rgb(var(--primary))]" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-[rgb(var(--foreground))] truncate">
                {event.title}
              </p>
              {!event.allDay && (
                <div className="mt-1 flex items-center gap-1 text-xs text-[rgb(var(--muted))]">
                  <Clock className="h-3 w-3" />
                  <span>
                    {formatTime(event.startDate, userTz)} – {formatTime(event.endDate, userTz)}
                  </span>
                  {event.timezone && event.timezone !== userTz && (
                    <span className="ml-1 rounded bg-[rgb(var(--surface-muted))] px-1 py-0.5 text-[10px] font-medium text-[rgb(var(--muted))]">
                      {shortTimezoneLabel(event.timezone, event.startDate)}
                    </span>
                  )}
                </div>
              )}
              {event.allDay && (
                <span className="mt-1 inline-block text-xs text-[rgb(var(--muted))]">All day</span>
              )}
              {event.location && (
                <div className="mt-1 flex items-center gap-1 text-xs text-[rgb(var(--muted))]">
                  <MapPin className="h-3 w-3" />
                  <span className="truncate">{event.location}</span>
                </div>
              )}
              {event.description && (
                <p className="mt-1 text-xs text-[rgb(var(--muted))] line-clamp-2">
                  {event.description}
                </p>
              )}
            </div>
          </div>
        </button>
      ))}
    </div>
  )
}
