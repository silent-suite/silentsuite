import { describe, expect, it } from 'vitest'
import { toScheduleXEvents, type DisplayEvent } from '../calendar-grid-events'

function displayEvent(overrides: Partial<DisplayEvent> = {}): DisplayEvent {
  const startDate = new Date('2026-06-25T22:00:00Z')
  const endDate = new Date('2026-06-27T01:00:00Z')
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

function zdt(date: Date): Temporal.ZonedDateTime {
  return Temporal.Instant.fromEpochMilliseconds(date.getTime()).toZonedDateTimeISO('UTC')
}

describe('toScheduleXEvents', () => {
  it('splits timed multi-day events into one month-view segment per affected day', () => {
    const events = toScheduleXEvents(
      [displayEvent()],
      new Map([['cal-1', '#10b981']]),
      'UTC',
      'month',
      zdt,
    )

    expect(events).toHaveLength(3)
    expect(events.map((event) => String(event.start))).toEqual([
      '2026-06-25',
      '2026-06-26',
      '2026-06-27',
    ])
    expect(events.map((event) => String(event.end))).toEqual([
      '2026-06-25',
      '2026-06-26',
      '2026-06-27',
    ])
    expect(events.map((event) => event.id)).toEqual([
      'event-1__day_2026-06-25',
      'event-1__day_2026-06-26',
      'event-1__day_2026-06-27',
    ])
  })

  it('keeps timed multi-day events as a single timed event outside month view', () => {
    const events = toScheduleXEvents(
      [displayEvent()],
      new Map([['cal-1', '#10b981']]),
      'UTC',
      'week',
      zdt,
    )

    expect(events).toHaveLength(1)
    expect(events[0]!.id).toBe('event-1')
    expect(String(events[0]!.start)).toContain('2026-06-25')
    expect(String(events[0]!.end)).toContain('2026-06-27')
  })

  it('keeps all-day multi-day events as one Schedule-X date range', () => {
    const event = displayEvent({
      allDay: true,
      startDate: new Date('2026-06-25T00:00:00Z'),
      endDate: new Date('2026-06-28T00:00:00Z'),
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
  })
})
