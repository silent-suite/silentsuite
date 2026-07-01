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
  categories?: string[]
  timezone?: string
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
          categories: event.categories,
          timezone: event.timezone,
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
          categories: event.categories,
          timezone: event.timezone,
        })
      }
    }
  }

  return result
}

export function toScheduleXEvents(
  displayEvents: DisplayEvent[],
  calendarColors: Map<string, string>,
  userTz: string,
  currentView: CalendarGridView,
  toScheduleXDateTime: (date: Date, tz: string) => Temporal.ZonedDateTime,
): CalendarEventExternal[] {
  return displayEvents.map((e) => {
    const color = calendarColors.get(e.calendarId ?? 'default') ?? '#10b981'
    const calendarId = e.calendarId ?? 'default'
    const colorClass = `sx-cal-color-${calendarId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
    const renderAsTimedMonthBar =
      currentView === 'month' && !e.allDay && isMultiDayTimedRange(e.startDate, e.endDate)
    const allDayMonthEnd = e.allDay ? toAllDayEndPlainDate(e.startDate, e.endDate) : null
    const renderAsAllDayMonthBar =
      currentView === 'month'
      && e.allDay
      && allDayMonthEnd !== null
      && Temporal.PlainDate.compare(allDayMonthEnd, dateToPlainDate(e.startDate)) > 0
    const additionalClasses = [colorClass]
    if (renderAsTimedMonthBar || renderAsAllDayMonthBar) {
      additionalClasses.push('ss-month-multiday')
    }

    return {
      id: e.id,
      title: e.isRecurring ? `↻ ${e.title}` : e.title,
      start: e.allDay || renderAsTimedMonthBar
        ? dateToPlainDate(e.startDate)
        : toScheduleXDateTime(e.startDate, userTz),
      end: e.allDay
        ? allDayMonthEnd!
        : renderAsTimedMonthBar
          ? toTimedMonthEndPlainDate(e.startDate, e.endDate)
          : toScheduleXDateTime(e.endDate, userTz),
      description: e.description || undefined,
      location: e.location || undefined,
      calendarId,
      _options: {
        additionalClasses,
      },
      _color: color,
    }
  })
}