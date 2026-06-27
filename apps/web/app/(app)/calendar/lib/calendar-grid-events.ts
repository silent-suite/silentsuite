import type { CalendarEventExternal } from '@schedule-x/calendar'
import { expandRecurrence } from '@silentsuite/core'
import type { CalendarEvent, DateRange } from '@silentsuite/core'
import { dateToPlainDate, isMultiDayTimedRange, toAllDayEndPlainDate, toTimedMonthEndPlainDate } from './all-day'

/** Expanded event used for display — may be a recurring instance */
export interface DisplayEvent {
  id: string
  /** The master event id (for recurring instances, this differs from id) */
  masterId: string
  title: string
  description: string
  location: string
  startDate: Date
  endDate: Date
  allDay: boolean
  isRecurring: boolean
  /** The specific occurrence date for this instance */
  instanceDate: Date
  calendarId?: string
}

type CalendarGridView = 'week' | 'month'

/** Expand recurring events into individual display events for the visible range */
export function expandEventsForRange(
  events: CalendarEvent[],
  range: DateRange,
): DisplayEvent[] {
  const result: DisplayEvent[] = []

  for (const event of events) {
    if (!event.recurrenceRule) {
      // Non-recurring: include if it overlaps the range. For all-day events,
      // endDate is iCal-exclusive (next-day midnight) so use strict `>` to avoid
      // matching events whose visual last day is just before range.start.
      const overlapsRangeStart = event.allDay
        ? event.endDate > range.start
        : event.endDate >= range.start
      if (overlapsRangeStart && event.startDate <= range.end) {
        result.push({
          id: event.id,
          masterId: event.id,
          title: event.title,
          description: event.description,
          location: event.location,
          startDate: event.startDate,
          endDate: event.endDate,
          allDay: event.allDay,
          isRecurring: false,
          instanceDate: event.startDate,
          calendarId: event.calendarId,
        })
      }
    } else {
      // Recurring: expand occurrences
      const duration = event.endDate.getTime() - event.startDate.getTime()
      const occurrences = expandRecurrence(
        event.recurrenceRule,
        event.startDate,
        range,
        event.exceptions,
      )

      for (const occDate of occurrences) {
        const occEnd = new Date(occDate.getTime() + duration)
        result.push({
          id: `${event.id}__${occDate.getTime()}`,
          masterId: event.id,
          title: event.title,
          description: event.description,
          location: event.location,
          startDate: occDate,
          endDate: occEnd,
          allDay: event.allDay,
          isRecurring: true,
          instanceDate: occDate,
          calendarId: event.calendarId,
        })
      }
    }
  }

  return result
}

function splitMonthTimedEvent(e: DisplayEvent): DisplayEvent[] {
  const segments: DisplayEvent[] = []
  const endPlainDate = toTimedMonthEndPlainDate(e.startDate, e.endDate)
  let day = dateToPlainDate(e.startDate)

  while (Temporal.PlainDate.compare(day, endPlainDate) <= 0) {
    const segmentDate = new Date(day.year, day.month - 1, day.day, e.startDate.getHours(), e.startDate.getMinutes(), e.startDate.getSeconds(), e.startDate.getMilliseconds())
    segments.push({
      ...e,
      id: `${e.id}__day_${day.toString()}`,
      startDate: segmentDate,
      endDate: segmentDate,
    })
    day = day.add({ days: 1 })
  }

  return segments
}

export function toScheduleXEvents(
  displayEvents: DisplayEvent[],
  calendarColors: Map<string, string>,
  userTz: string,
  currentView: CalendarGridView,
  toScheduleXDateTime: (date: Date, tz: string) => Temporal.ZonedDateTime,
): CalendarEventExternal[] {
  const eventsForView = currentView === 'month'
    ? displayEvents.flatMap((e) => (!e.allDay && isMultiDayTimedRange(e.startDate, e.endDate) ? splitMonthTimedEvent(e) : [e]))
    : displayEvents

  return eventsForView.map((e) => {
    const color = calendarColors.get(e.calendarId ?? 'default') ?? '#10b981'
    return {
      id: e.id,
      title: e.isRecurring ? `↻ ${e.title}` : e.title,
      start: e.allDay ? dateToPlainDate(e.startDate) : currentView === 'month' && e.id.includes('__day_') ? dateToPlainDate(e.startDate) : toScheduleXDateTime(e.startDate, userTz),
      end: e.allDay
        ? toAllDayEndPlainDate(e.startDate, e.endDate)
        : currentView === 'month' && e.id.includes('__day_')
          ? dateToPlainDate(e.startDate)
          : toScheduleXDateTime(e.endDate, userTz),
      description: e.description || undefined,
      location: e.location || undefined,
      calendarId: e.calendarId ?? 'default',
      _options: {
        additionalClasses: [`sx-cal-color-${(e.calendarId ?? 'default').replace(/[^a-zA-Z0-9_-]/g, '_')}`],
      },
      _color: color,
    }
  })
}