import { describe, expect, it } from 'vitest'
import { toScheduleXEvents, type DisplayEvent } from '../calendar-grid-events'

function displayEvent(overrides: Partial<DisplayEvent> = {}): DisplayEvent {
  const startDate = new Date(2026, 5, 25, 22, 0)
  const endDate = new Date(2026, 5, 27, 1, 0)
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
  it('renders timed multi-day month events as one connected date-range bar', () => {
    const events = toScheduleXEvents(
      [displayEvent()],
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
        startDate: new Date(2026, 5, 25, 9, 0),
        endDate: new Date(2026, 5, 25, 10, 0),
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
