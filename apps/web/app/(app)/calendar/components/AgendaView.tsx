'use client'

import { useMemo } from 'react'
import { Clock, MapPin, Repeat2 } from 'lucide-react'
import { CalendarEmptyState } from '@/app/components/empty-state'
import { LabelChips } from '@/app/components/LabelEditor'
import type { CalendarEvent, DateRange } from '@silentsuite/core'
import type { CalendarList } from '@/app/stores/use-calendar-list-store'
import { usePreferencesStore } from '@/app/stores/use-preferences-store'
import { resolveUserTimezone, shortTimezoneLabel } from '@/app/lib/tz'
import { expandEventsForRange, type DisplayEvent } from '../lib/calendar-grid-events'

interface AgendaViewProps {
  events: CalendarEvent[]
  currentDate: Date
  calendars?: CalendarList[]
  mode?: 'day' | 'upcoming'
  onEventClick?: (eventId: string, instanceDate?: Date) => void
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

function compareEvents(a: DisplayEvent, b: DisplayEvent): number {
  if (!isSameDay(a.startDate, b.startDate)) return a.startDate.getTime() - b.startDate.getTime()
  if (a.allDay && !b.allDay) return -1
  if (!a.allDay && b.allDay) return 1
  return a.startDate.getTime() - b.startDate.getTime()
}

function getAgendaRange(currentDate: Date, mode: 'day' | 'upcoming'): DateRange {
  const start = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate())
  const end = new Date(start)
  if (mode === 'upcoming') {
    // Wide enough to catch normal weekly/monthly recurrences while keeping expansion bounded.
    end.setDate(start.getDate() + 180)
  }
  end.setHours(23, 59, 59, 999)
  return { start, end }
}

function collectionFallback(calendarId: string): string {
  return calendarId === 'default' ? 'Personal' : calendarId
}

export function AgendaView({ events, currentDate, calendars = [], mode = 'day', onEventClick }: AgendaViewProps) {
  const defaultTimezonePref = usePreferencesStore((s) => s.defaultTimezone)
  const userTz = resolveUserTimezone(defaultTimezonePref)
  const calendarMeta = useMemo(() => {
    const map = new Map<string, { name: string; color: string }>()
    for (const calendar of calendars) {
      map.set(calendar.id, { name: calendar.name, color: calendar.color })
    }
    if (!map.has('default')) map.set('default', { name: 'Personal', color: '#10b981' })
    return map
  }, [calendars])

  const agendaEvents = useMemo(() => {
    const range = getAgendaRange(currentDate, mode)
    return expandEventsForRange(events, range)
      .filter((event) => {
        const endComparison = event.allDay ? event.endDate > range.start : event.endDate >= range.start
        return endComparison && event.startDate <= range.end
      })
      .sort(compareEvents)
      .slice(0, mode === 'upcoming' ? 6 : undefined)
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
        const calendarId = event.calendarId ?? 'default'
        const collection = calendarMeta.get(calendarId) ?? { name: collectionFallback(calendarId), color: '#10b981' }
        return (
          <button
            key={event.id}
            type="button"
            onClick={() => onEventClick?.(event.masterId, event.instanceDate)}
            className={`w-full text-left rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-3 transition-colors hover:border-[rgb(var(--primary))] focus:outline-none focus:ring-2 focus:ring-emerald-500 ${
              mode === 'upcoming' && index === 5 ? 'max-[389px]:hidden' : ''
            }`}
          >
            <div className="flex items-start gap-3">
              <div
                className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: collection.color }}
                aria-hidden="true"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium text-[rgb(var(--foreground))] truncate">
                    {event.title}
                  </p>
                  {mode === 'upcoming' && (
                    <span className="shrink-0 text-xs text-[rgb(var(--muted))]">
                      {formatAgendaDate(event.startDate, currentDate, userTz)}
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[rgb(var(--muted))]">
                  <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-[rgb(var(--background))] px-2 py-0.5 font-medium">
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: collection.color }}
                      aria-hidden="true"
                    />
                    <span className="truncate">{collection.name}</span>
                  </span>
                  {event.isRecurring && (
                    <span className="inline-flex items-center gap-1">
                      <Repeat2 className="h-3 w-3" />
                      Repeats
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
