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

export interface VisibleDateRange {
  start: Temporal.PlainDate
  /** Inclusive final visible date. */
  end: Temporal.PlainDate
}

export interface ScheduleXProjection {
  events: CalendarEventExternal[]
  sourceByRenderId: Map<string, DisplayEvent>
  droppedCount: number
}

export interface DisplayEventExpansion {
  events: DisplayEvent[]
  droppedCount: number
}

function expandEvents(
  events: CalendarEvent[],
  range: DateRange,
  gridSemantics: boolean,
): DisplayEventExpansion {
  const result: DisplayEvent[] = []
  let droppedCount = 0

  for (const event of events) {
    if (!event.recurrenceRule) {
      const overlaps = gridSemantics
        ? event.endDate > range.start && event.startDate < range.end
        : (event.allDay ? event.endDate > range.start : event.endDate >= range.start)
          && event.startDate <= range.end
      if (overlaps) {
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
      const duration = event.endDate.getTime() - event.startDate.getTime()
      if (gridSemantics && (!Number.isFinite(duration) || duration <= 0)) {
        droppedCount += 1
        continue
      }
      let recurrenceRange = range
      if (gridSemantics) {
        const lookbackMs = range.start.getTime() - duration
        const lookbackDate = new Date(lookbackMs)
        if (!Number.isFinite(lookbackMs) || !Number.isFinite(lookbackDate.getTime())) {
          droppedCount += 1
          continue
        }
        recurrenceRange = {
          start: new Date(Math.max(event.startDate.getTime(), lookbackDate.getTime())),
          end: range.end,
        }
      }
      const occurrences = expandRecurrence(
        event.recurrenceRule,
        event.startDate,
        recurrenceRange,
        event.exceptions,
      )

      for (const occDate of occurrences) {
        const occEnd = new Date(occDate.getTime() + duration)
        if (gridSemantics && !(occDate < range.end && occEnd > range.start)) continue
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

  return { events: result, droppedCount }
}

/** Preserve the established Agenda/list expansion contract. */
export function expandEventsForRange(events: CalendarEvent[], range: DateRange): DisplayEvent[] {
  return expandEvents(events, range, false).events
}

/** Grid-only half-open expansion with duration lookback and diagnostics. */
export function expandGridEventsForRange(
  events: CalendarEvent[],
  range: DateRange,
): DisplayEventExpansion {
  return expandEvents(events, range, true)
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

function startOfDay(date: Temporal.PlainDate, timeZone: string): Temporal.ZonedDateTime {
  return Temporal.ZonedDateTime.from({
    timeZone,
    year: date.year,
    month: date.month,
    day: date.day,
    hour: 0,
    minute: 0,
    second: 0,
  }, { disambiguation: 'compatible' })
}

export function visibleDateRangeToInstantRange(
  visibleDates: VisibleDateRange,
  timeZone: string,
): DateRange {
  const start = startOfDay(visibleDates.start, timeZone)
  const end = startOfDay(visibleDates.end.add({ days: 1 }), timeZone)
  if (Temporal.ZonedDateTime.compare(end, start) < 0) {
    throw new RangeError('Visible calendar range cannot run backwards')
  }
  return {
    start: new Date(start.epochMilliseconds),
    end: new Date(end.epochMilliseconds),
  }
}

export interface TimedHourBounds {
  startHour: number
  endHour: number
}

export function getRequiredTimedHourBounds(
  events: CalendarEventExternal[],
): TimedHourBounds | undefined {
  let startHour = 24
  let endHour = 0
  let found = false

  for (const event of events) {
    const start = event.start
    const end = event.end
    if (!(start instanceof Temporal.ZonedDateTime) || !(end instanceof Temporal.ZonedDateTime)) continue
    const roundedEnd = end.hour + (end.minute || end.second || end.millisecond || end.microsecond || end.nanosecond ? 1 : 0)
    startHour = Math.min(startHour, start.hour)
    endHour = Math.max(endHour, Math.min(24, roundedEnd))
    found = true
  }

  return found ? { startHour, endHour: Math.max(startHour + 1, endHour) } : undefined
}

export function isTimeGridGestureEligible(target: EventTarget | null): boolean {
  return target instanceof Element && !target.closest('.ss-timegrid-multiday-segment')
}

function laterZonedDateTime(
  first: Temporal.ZonedDateTime,
  second: Temporal.ZonedDateTime,
): Temporal.ZonedDateTime {
  return Temporal.ZonedDateTime.compare(first, second) >= 0 ? first : second
}

function earlierZonedDateTime(
  first: Temporal.ZonedDateTime,
  second: Temporal.ZonedDateTime,
): Temporal.ZonedDateTime {
  return Temporal.ZonedDateTime.compare(first, second) <= 0 ? first : second
}

function opaqueDigest(value: string): string {
  let h1 = 1779033703
  let h2 = 3144134277
  let h3 = 1013904242
  let h4 = 2773480762
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    h1 = h2 ^ Math.imul(h1 ^ code, 597399067)
    h2 = h3 ^ Math.imul(h2 ^ code, 2869860233)
    h3 = h4 ^ Math.imul(h3 ^ code, 951274213)
    h4 = h1 ^ Math.imul(h4 ^ code, 2716044179)
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067)
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233)
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213)
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179)
  return [h1, h2, h3, h4]
    .map((part) => (part >>> 0).toString(16).padStart(8, '0'))
    .join('')
}

interface RenderIdentity {
  id: string
  canonicalKey: string
}

function renderIdentityFor(source: DisplayEvent, segmentDate?: Temporal.PlainDate): RenderIdentity {
  const canonicalKey = JSON.stringify([
    source.isRecurring ? 'recurring' : 'single',
    source.calendarId ?? 'default',
    source.masterId,
    source.id,
    source.instanceDate.getTime(),
    source.endDate.getTime(),
    segmentDate?.toString() ?? null,
  ])
  return { id: `r${opaqueDigest(canonicalKey)}`, canonicalKey }
}

/** Build Schedule-X-only objects plus a direct map back to source display events. */
export function toScheduleXProjection(
  displayEvents: DisplayEvent[],
  calendarColors: Map<string, string>,
  userTz: string,
  currentView: CalendarGridView,
  visibleDates: VisibleDateRange,
  toScheduleXDateTime: (date: Date, tz: string) => Temporal.ZonedDateTime,
  initialDroppedCount = 0,
): ScheduleXProjection {
  const events: CalendarEventExternal[] = []
  const sourceByRenderId = new Map<string, DisplayEvent>()
  const canonicalByRenderId = new Map<string, string>()
  let droppedCount = initialDroppedCount

  const addProjectedEvent = (
    event: CalendarEventExternal,
    source: DisplayEvent,
    identity: RenderIdentity,
  ) => {
    if (canonicalByRenderId.has(identity.id)) {
      droppedCount += 1
      return
    }
    event.id = identity.id
    events.push(event)
    sourceByRenderId.set(identity.id, source)
    canonicalByRenderId.set(identity.id, identity.canonicalKey)
  }

  for (const source of displayEvents) {
    try {
      const sourceStartMs = source.startDate.getTime()
      const sourceEndMs = source.endDate.getTime()
      if (!Number.isFinite(sourceStartMs) || !Number.isFinite(sourceEndMs) || sourceEndMs <= sourceStartMs) {
        droppedCount += 1
        continue
      }
      const sourceStart = toScheduleXDateTime(source.startDate, userTz)
      const sourceEnd = toScheduleXDateTime(source.endDate, userTz)
      const isCrossDateTimed =
        currentView === 'week'
        && !source.allDay
        && !sourceStart.toPlainDate().equals(sourceEnd.toPlainDate())

      if (!isCrossDateTimed) {
        const event = toScheduleXEvents(
          [source],
          calendarColors,
          userTz,
          currentView,
          toScheduleXDateTime,
        )[0]
        if (!event) {
          droppedCount += 1
          continue
        }
        addProjectedEvent(event, source, renderIdentityFor(source))
        continue
      }

      let date = visibleDates.start
      while (Temporal.PlainDate.compare(date, visibleDates.end) <= 0) {
        const dayStart = startOfDay(date, userTz)
        const nextDayStart = startOfDay(date.add({ days: 1 }), userTz)
        if (
          dayStart.toPlainDate().equals(date)
          && Temporal.ZonedDateTime.compare(nextDayStart, dayStart) > 0
        ) {
          const segmentStart = laterZonedDateTime(sourceStart, dayStart)
          const segmentEndExclusive = earlierZonedDateTime(sourceEnd, nextDayStart)
          if (Temporal.ZonedDateTime.compare(segmentEndExclusive, segmentStart) > 0) {
            const scheduleEnd = Temporal.ZonedDateTime.compare(segmentEndExclusive, nextDayStart) === 0
              ? nextDayStart.subtract({ nanoseconds: 1 })
              : segmentEndExclusive
            const base = toScheduleXEvents(
              [source],
              calendarColors,
              userTz,
              'week',
              toScheduleXDateTime,
            )[0]!
            const event: CalendarEventExternal = {
              ...base,
              start: segmentStart,
              end: scheduleEnd,
              _options: {
                ...base._options,
                additionalClasses: [
                  ...(base._options?.additionalClasses ?? []),
                  'ss-timegrid-multiday-segment',
                ],
                disableDND: true,
                disableResize: true,
              },
              _ssTimedSegment: true,
            }
            addProjectedEvent(event, source, renderIdentityFor(source, date))
          }
        }
        date = date.add({ days: 1 })
      }
    } catch {
      droppedCount += 1
    }
  }

  return { events, sourceByRenderId, droppedCount }
}