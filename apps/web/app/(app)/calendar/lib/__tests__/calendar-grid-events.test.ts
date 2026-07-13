import { describe, expect, it } from 'vitest'
import type { CalendarEvent } from '@silentsuite/core'
import {
  expandEventsForRange,
  expandGridEventsForRange,
  getRequiredTimedHourBounds,
  isTimeGridGestureEligible,
  toScheduleXEvents,
  toScheduleXProjection,
  visibleDateRangeToInstantRange,
  type DisplayEvent,
} from '../calendar-grid-events'

function displayEvent(overrides: Partial<DisplayEvent> = {}): DisplayEvent {
  const startDate = new Date('2026-06-25T22:00:00.000Z')
  const endDate = new Date('2026-06-27T01:00:00.000Z')
  return {
    id: 'event-1',
    masterId: 'event-1',
    title: 'Multi-day trip',
    description: '',
    location: '',
    startDate,
    endDate,
    allDay: false,
    isRecurring: false,
    instanceDate: startDate,
    calendarId: 'cal-1',
    ...overrides,
  }
}

function zdt(date: Date, timeZone = 'UTC'): Temporal.ZonedDateTime {
  return Temporal.Instant.fromEpochMilliseconds(date.getTime()).toZonedDateTimeISO(timeZone)
}

function calendarEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  const startDate = new Date('2026-07-12T21:00:00.000Z')
  return {
    id: 'recurring-1',
    uid: 'recurring-1',
    title: 'Overnight support',
    description: '',
    location: '',
    startDate,
    endDate: new Date('2026-07-13T01:00:00.000Z'),
    allDay: false,
    recurrenceRule: 'FREQ=DAILY;COUNT=3',
    exceptions: [],
    alarms: [],
    created: startDate,
    updated: startDate,
    calendarId: 'cal-1',
    ...overrides,
  }
}

describe('expandEventsForRange', () => {
  it('includes a recurring occurrence that starts before the range and ends inside it', () => {
    const events = expandGridEventsForRange([calendarEvent()], {
      start: new Date('2026-07-13T00:00:00.000Z'),
      end: new Date('2026-07-14T00:00:00.000Z'),
    }).events

    expect(events.map((event) => event.startDate.toISOString())).toEqual([
      '2026-07-12T21:00:00.000Z',
      '2026-07-13T21:00:00.000Z',
    ])
  })

  it('uses half-open overlap semantics at both view boundaries', () => {
    const range = {
      start: new Date('2026-07-13T00:00:00.000Z'),
      end: new Date('2026-07-14T00:00:00.000Z'),
    }
    const endingAtStart = calendarEvent({
      id: 'ending',
      recurrenceRule: null,
      startDate: new Date('2026-07-12T22:00:00.000Z'),
      endDate: range.start,
    })
    const startingAtEnd = calendarEvent({
      id: 'starting',
      recurrenceRule: null,
      startDate: range.end,
      endDate: new Date('2026-07-14T01:00:00.000Z'),
    })

    expect(expandGridEventsForRange([endingAtStart, startingAtEnd], range).events).toEqual([])
  })

  it('preserves the established list-view boundary contract', () => {
    const range = {
      start: new Date('2026-07-13T00:00:00.000Z'),
      end: new Date('2026-07-14T00:00:00.000Z'),
    }
    const endingAtStart = calendarEvent({
      recurrenceRule: null,
      startDate: new Date('2026-07-12T22:00:00.000Z'),
      endDate: range.start,
    })

    expect(expandEventsForRange([endingAtStart], range)).toHaveLength(1)
  })

  it('preserves COUNT when EXDATE falls inside the carry-in lookback', () => {
    const start = new Date('2026-01-01T21:00:00.000Z')
    const expansion = expandGridEventsForRange([calendarEvent({
      startDate: start,
      endDate: new Date('2026-01-02T01:00:00.000Z'),
      recurrenceRule: 'FREQ=DAILY;COUNT=2',
      exceptions: [start],
    })], {
      start: new Date('2026-01-02T00:00:00.000Z'),
      end: new Date('2026-01-04T00:00:00.000Z'),
    })

    expect(expansion.events.map((event) => event.startDate.toISOString())).toEqual([
      '2026-01-02T21:00:00.000Z',
    ])
  })

  it('counts invalid recurring input without dropping valid siblings', () => {
    const invalid = calendarEvent({ endDate: new Date('2026-07-12T20:00:00.000Z') })
    const valid = calendarEvent({ id: 'valid', recurrenceRule: null })
    const expansion = expandGridEventsForRange([invalid, valid], {
      start: new Date('2026-07-12T00:00:00.000Z'),
      end: new Date('2026-07-14T00:00:00.000Z'),
    })

    expect(expansion.droppedCount).toBe(1)
    expect(expansion.events.map((event) => event.id)).toEqual(['valid'])
  })

  it('preserves interval phase for a recurring carry-in occurrence', () => {
    const expansion = expandGridEventsForRange([calendarEvent({
      startDate: new Date('2026-07-09T22:00:00.000Z'),
      endDate: new Date('2026-07-11T02:00:00.000Z'),
      recurrenceRule: 'FREQ=DAILY;INTERVAL=2;COUNT=4',
    })], {
      start: new Date('2026-07-12T00:00:00.000Z'),
      end: new Date('2026-07-13T00:00:00.000Z'),
    })

    expect(expansion.events.map((event) => event.startDate.toISOString())).toEqual([
      '2026-07-11T22:00:00.000Z',
    ])
  })

  it('preserves end-of-month anchoring for a recurring carry-in occurrence', () => {
    const expansion = expandGridEventsForRange([calendarEvent({
      startDate: new Date('2026-01-31T22:00:00.000Z'),
      endDate: new Date('2026-02-02T02:00:00.000Z'),
      recurrenceRule: 'FREQ=MONTHLY;COUNT=4',
    })], {
      start: new Date('2026-03-01T00:00:00.000Z'),
      end: new Date('2026-03-02T00:00:00.000Z'),
    })

    expect(expansion.events.map((event) => event.startDate.toISOString())).toEqual([
      '2026-02-28T22:00:00.000Z',
    ])
  })
})

describe('visibleDateRangeToInstantRange', () => {
  it('derives the half-open instant range from visible dates in the user timezone', () => {
    const range = visibleDateRangeToInstantRange({
      start: Temporal.PlainDate.from('2026-07-13'),
      end: Temporal.PlainDate.from('2026-07-13'),
    }, 'America/New_York')

    expect(range.start.toISOString()).toBe('2026-07-13T04:00:00.000Z')
    expect(range.end.toISOString()).toBe('2026-07-14T04:00:00.000Z')
  })

  it('returns an empty instant range for a single skipped local date', () => {
    const range = visibleDateRangeToInstantRange({
      start: Temporal.PlainDate.from('2011-12-30'),
      end: Temporal.PlainDate.from('2011-12-30'),
    }, 'Pacific/Apia')

    expect(range.start.getTime()).toBe(range.end.getTime())
  })

  it('derives a positive-offset user day independently of process timezone', () => {
    const range = visibleDateRangeToInstantRange({
      start: Temporal.PlainDate.from('2026-07-13'),
      end: Temporal.PlainDate.from('2026-07-13'),
    }, 'Asia/Tokyo')

    expect(range.start.toISOString()).toBe('2026-07-12T15:00:00.000Z')
    expect(range.end.toISOString()).toBe('2026-07-13T15:00:00.000Z')
  })
})

describe('toScheduleXEvents', () => {
  it('renders timed multi-day month events as one connected date-range bar', () => {
    const events = toScheduleXEvents(
      [displayEvent({
        startDate: new Date(2026, 5, 25, 22, 0),
        endDate: new Date(2026, 5, 27, 1, 0),
      })],
      new Map([['cal-1', '#10b981']]),
      'UTC',
      'month',
      zdt,
    )

    expect(events).toHaveLength(1)
    expect(events[0]!.id).toBe('event-1')
    expect(String(events[0]!.start)).toBe('2026-06-25')
    expect(String(events[0]!.end)).toBe('2026-06-27')
    expect(events[0]!._options?.additionalClasses).toEqual([
      'sx-cal-color-cal-1',
      'ss-month-multiday',
    ])
  })

  it('does not paint timed month bars onto a final midnight-only day', () => {
    const events = toScheduleXEvents(
      [displayEvent({
        startDate: new Date(2026, 5, 25, 22, 0),
        endDate: new Date(2026, 5, 27, 0, 0),
      })],
      new Map([['cal-1', '#10b981']]),
      'UTC',
      'month',
      zdt,
    )

    expect(events).toHaveLength(1)
    expect(String(events[0]!.start)).toBe('2026-06-25')
    expect(String(events[0]!.end)).toBe('2026-06-26')
    expect(events[0]!.id).toBe('event-1')
  })

  it('projects a timed multi-day event into one hourly segment per visible local date', () => {
    const source = displayEvent()
    const projection = toScheduleXProjection(
      [source],
      new Map([['cal-1', '#10b981']]),
      'UTC',
      'week',
      {
        start: Temporal.PlainDate.from('2026-06-25'),
        end: Temporal.PlainDate.from('2026-06-27'),
      },
      zdt,
    )

    expect(projection.events).toHaveLength(3)
    expect(projection.events.map((event) => String(event.start).slice(0, 10))).toEqual([
      '2026-06-25',
      '2026-06-26',
      '2026-06-27',
    ])
    expect(projection.events.every((event) => {
      return String(event.start).slice(0, 10) === String(event.end).slice(0, 10)
    })).toBe(true)
    expect(projection.events.every((event) => {
      return event._options?.additionalClasses?.includes('ss-timegrid-multiday-segment')
    })).toBe(true)
    expect(projection.sourceByRenderId.get(String(projection.events[1]!.id))).toBe(source)
  })

  it('keeps all-day multi-day events as one Schedule-X date range', () => {
    const event = displayEvent({
      allDay: true,
      startDate: new Date(2026, 5, 25),
      endDate: new Date(2026, 5, 28),
    })

    const events = toScheduleXEvents(
      [event],
      new Map([['cal-1', '#10b981']]),
      'UTC',
      'month',
      zdt,
    )

    expect(events).toHaveLength(1)
    expect(String(events[0]!.start)).toBe('2026-06-25')
    expect(String(events[0]!.end)).toBe('2026-06-27')
    expect(events[0]!._options?.additionalClasses).toEqual([
      'sx-cal-color-cal-1',
      'ss-month-multiday',
    ])
  })

  it('does not mark single-day events as multi-day month bars', () => {
    const events = toScheduleXEvents(
      [displayEvent({
        startDate: new Date('2026-06-25T09:00:00.000Z'),
        endDate: new Date('2026-06-25T10:00:00.000Z'),
      })],
      new Map([['cal-1', '#10b981']]),
      'UTC',
      'month',
      zdt,
    )

    expect(events).toHaveLength(1)
    expect(String(events[0]!.start)).toContain('2026-06-25')
    expect(events[0]!._options?.additionalClasses).toEqual(['sx-cal-color-cal-1'])
  })
})

describe('hourly projection contracts', () => {
  const visibleDates = {
    start: Temporal.PlainDate.from('2026-06-25'),
    end: Temporal.PlainDate.from('2026-06-27'),
  }

  it('omits a midnight-only final segment and uses the 23:59 approximation', () => {
    const projection = toScheduleXProjection([
      displayEvent({ endDate: new Date('2026-06-27T00:00:00.000Z') }),
    ], new Map(), 'UTC', 'week', visibleDates, zdt)

    expect(projection.events).toHaveLength(2)
    expect(String(projection.events[1]!.end)).toContain('2026-06-26T23:59:59.999999999')
  })

  it('bounds segments to visible dates and keeps stable opaque ids across input order', () => {
    const first = displayEvent()
    const second = displayEvent({
      id: 'event-2',
      masterId: 'event-2',
      startDate: new Date('2026-06-26T09:00:00.000Z'),
      endDate: new Date('2026-06-26T10:00:00.000Z'),
      instanceDate: new Date('2026-06-26T09:00:00.000Z'),
    })
    const dates = {
      start: Temporal.PlainDate.from('2026-06-26'),
      end: Temporal.PlainDate.from('2026-06-26'),
    }
    const forward = toScheduleXProjection([first, second], new Map(), 'UTC', 'week', dates, zdt)
    const reverse = toScheduleXProjection([second, first], new Map(), 'UTC', 'week', dates, zdt)

    expect(forward.events).toHaveLength(2)
    expect(new Set(forward.events.map((event) => String(event.id)))).toEqual(
      new Set(reverse.events.map((event) => String(event.id))),
    )
    const ids = forward.events.map((event) => String(event.id))
    expect(ids.every((id) => /^r[0-9a-f]{32}$/.test(id))).toBe(true)
    expect(ids.every((id) => {
      const probe = document.createElement('div')
      probe.id = id
      document.body.appendChild(probe)
      const found = document.querySelector(`#${id}`) === probe
      probe.remove()
      return found
    })).toBe(true)
    expect(ids.every((id) => !id.includes(first.id) && !id.includes(first.masterId))).toBe(true)
    expect(ids.every((id) => !decodeURIComponent(id).includes('cal-1'))).toBe(true)
  })

  it('isolates invalid source data and reports a content-free dropped count', () => {
    const invalid = displayEvent({ startDate: new Date(Number.NaN) })
    const projection = toScheduleXProjection(
      [invalid, displayEvent({ id: 'valid', masterId: 'valid' })],
      new Map(),
      'UTC',
      'week',
      visibleDates,
      zdt,
    )

    expect(projection.droppedCount).toBe(1)
    expect(projection.events).toHaveLength(3)
  })

  it('derives full timed bounds and rejects projected segments from custom gestures', () => {
    const projection = toScheduleXProjection([displayEvent()], new Map(), 'UTC', 'week', visibleDates, zdt)
    expect(getRequiredTimedHourBounds(projection.events)).toEqual({ startHour: 0, endHour: 24 })

    const segment = document.createElement('div')
    segment.className = 'ss-timegrid-multiday-segment'
    const child = document.createElement('span')
    segment.appendChild(child)
    expect(isTimeGridGestureEligible(child)).toBe(false)
    expect(isTimeGridGestureEligible(document.createElement('div'))).toBe(true)
  })

  it('skips a nonexistent local date without fixed 24-hour day arithmetic', () => {
    const start = Temporal.ZonedDateTime.from('2011-12-29T12:00:00-10:00[Pacific/Apia]')
    const end = Temporal.ZonedDateTime.from('2011-12-31T12:00:00+14:00[Pacific/Apia]')
    const source = displayEvent({
      startDate: new Date(start.epochMilliseconds),
      endDate: new Date(end.epochMilliseconds),
      instanceDate: new Date(start.epochMilliseconds),
    })
    const projection = toScheduleXProjection([source], new Map(), 'Pacific/Apia', 'week', {
      start: Temporal.PlainDate.from('2011-12-29'),
      end: Temporal.PlainDate.from('2011-12-31'),
    }, zdt)

    expect(projection.events.map((event) => String(event.start).slice(0, 10))).toEqual([
      '2011-12-29',
      '2011-12-31',
    ])
  })

  it.each([
    {
      name: 'spring-forward gap',
      start: '2026-03-28T22:00:00.000Z',
      end: '2026-03-29T02:00:00.000Z',
      dates: ['2026-03-28', '2026-03-29'],
    },
    {
      name: 'fall-back fold',
      start: '2026-10-24T21:00:00.000Z',
      end: '2026-10-25T03:00:00.000Z',
      dates: ['2026-10-24', '2026-10-25'],
    },
  ])('splits across the Berlin $name with valid local segments', ({ start, end, dates }) => {
    const projection = toScheduleXProjection(
      [displayEvent({ startDate: new Date(start), endDate: new Date(end) })],
      new Map(),
      'Europe/Berlin',
      'week',
      {
        start: Temporal.PlainDate.from(dates[0]!),
        end: Temporal.PlainDate.from(dates[1]!),
      },
      zdt,
    )

    expect(projection.events.map((event) => String(event.start).slice(0, 10))).toEqual(dates)
    expect(projection.events.every((event) => Temporal.ZonedDateTime.compare(
      event.end as Temporal.ZonedDateTime,
      event.start as Temporal.ZonedDateTime,
    ) > 0)).toBe(true)
  })
})
