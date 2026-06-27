'use client'

import { useMemo } from 'react'
import { Clock, MapPin } from 'lucide-react'
import { CalendarEmptyState } from '@/app/components/empty-state'
import { LabelChips } from '@/app/components/LabelEditor'
import type { CalendarEvent } from '@silentsuite/core'
import { usePreferencesStore } from '@/app/stores/use-preferences-store'
import { resolveUserTimezone, shortTimezoneLabel } from '@/app/lib/tz'

interface AgendaViewProps {
  events: CalendarEvent[]
  currentDate: Date
  mode?: 'day' | 'upcoming'
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

function formatAgendaDate(date: Date, currentDate: Date, tz: string): string {
  if (isSameDay(date, currentDate)) return 'Today'

  const tomorrow = new Date(currentDate)
  tomorrow.setDate(currentDate.getDate() + 1)
  if (isSameDay(date, tomorrow)) return 'Tomorrow'

  return date.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: tz,
  })
}

function eventStart(event: CalendarEvent): Date {
  return event.startDate instanceof Date ? event.startDate : new Date(event.startDate)
}

function eventEnd(event: CalendarEvent): Date {
  return event.endDate instanceof Date ? event.endDate : new Date(event.endDate)
}

function compareEvents(a: CalendarEvent, b: CalendarEvent): number {
  const aStart = eventStart(a)
  const bStart = eventStart(b)
  if (!isSameDay(aStart, bStart)) return aStart.getTime() - bStart.getTime()
  if (a.allDay && !b.allDay) return -1
  if (!a.allDay && b.allDay) return 1
  return aStart.getTime() - bStart.getTime()
}

export function AgendaView({ events, currentDate, mode = 'day', onEventClick }: AgendaViewProps) {
  const defaultTimezonePref = usePreferencesStore((s) => s.defaultTimezone)
  const userTz = resolveUserTimezone(defaultTimezonePref)
  const agendaEvents = useMemo(() => {
    const currentDayStart = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate())
    const currentDayEnd = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate(), 23, 59, 59, 999)

    if (mode === 'upcoming') {
      return events
        .filter((event) => {
          const end = eventEnd(event)
          // Keep in-progress all-day and timed events, then show upcoming items across future days.
          return event.allDay ? end > currentDayStart : end >= currentDayStart
        })
        .sort(compareEvents)
        .slice(0, 6)
    }

    return events
      .filter((e) => {
        const start = eventStart(e)
        const end = eventEnd(e)

        // Event overlaps with current day if it starts before day ends AND ends after day starts.
        // For all-day events, endDate follows iCal DTEND;VALUE=DATE convention (exclusive — the
        // day *after* the last day of the event), so use `>` rather than `>=` to avoid bleeding
        // a single-day event onto the morning of the next day.
        const endComparison = e.allDay ? end > currentDayStart : end >= currentDayStart
        return start <= currentDayEnd && endComparison
      })
      .sort(compareEvents)
  }, [events, currentDate, mode])

  if (agendaEvents.length === 0) {
    return <CalendarEmptyState />
  }

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      {mode === 'upcoming' && (
        <p className="px-1 text-xs font-medium text-[rgb(var(--muted))]">
          Next events
        </p>
      )}
      {agendaEvents.map((event, index) => {
        const start = eventStart(event)
        return (
          <button
            key={event.id}
            type="button"
            onClick={() => onEventClick?.(event.id)}
            className={`w-full text-left rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-3 transition-colors hover:border-[rgb(var(--primary))] focus:outline-none focus:ring-2 focus:ring-emerald-500 ${
              mode === 'upcoming' && index === 5 ? 'max-[389px]:hidden' : ''
            }`}
          >
            <div className="flex items-start gap-3">
              <div className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-[rgb(var(--primary))]" />
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium text-[rgb(var(--foreground))] truncate">
                    {event.title}
                  </p>
                  {mode === 'upcoming' && (
                    <span className="shrink-0 text-xs text-[rgb(var(--muted))]">
                      {formatAgendaDate(start, currentDate, userTz)}
                    </span>
                  )}
                </div>
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
                <LabelChips labels={event.categories} className="mt-1.5" />
              </div>
            </div>
          </button>
        )
      })}
    </div>
  )
}
