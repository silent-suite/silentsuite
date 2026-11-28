import { describe, expect, it } from 'vitest'
import type { CalendarEvent } from '@silentsuite/core'
import { toSearchResults } from '../search-results'

function calendarEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  const startDate = new Date('2026-03-02T09:00:00.000Z')
  return {
    id: 'event-1',
    uid: 'event-1',
    title: 'Standup',
    description: '',
    location: '',
    startDate,
    endDate: new Date(startDate.getTime() + 30 * 60_000),
    allDay: false,
    recurrenceRule: null,
    exceptions: [],
    alarms: [],
    created: startDate,
    updated: startDate,
    calendarId: 'cal-1',
    timezone: 'UTC',
    ...overrides,
  }
}

const at = (iso: string) => new Date(iso)
const iso = (d: Date | undefined) => d?.toISOString()

describe('toSearchResults (WEB-17)', () => {
  const now = at('2026-11-27T12:00:00.000Z')

  it('sorts results by the date they show', () => {
    const late = calendarEvent({ id: 'late', startDate: at('2026-12-10T09:00:00.000Z'), endDate: at('2026-12-10T10:00:00.000Z') })
    const early = calendarEvent({ id: 'early', startDate: at('2026-01-05T09:00:00.000Z'), endDate: at('2026-01-05T10:00:00.000Z') })
    const mid = calendarEvent({ id: 'mid', startDate: at('2026-11-28T09:00:00.000Z'), endDate: at('2026-11-28T10:00:00.000Z') })

    const results = toSearchResults([late, early, mid], now)

    expect(results.map((r) => r.event.id)).toEqual(['early', 'mid', 'late'])
    expect(results.every((r) => r.instanceDate === undefined)).toBe(true)
  })

  it('shows a repeating event at its next occurrence from today', () => {
    const weekly = calendarEvent({ recurrenceRule: 'FREQ=WEEKLY' })

    const [result] = toSearchResults([weekly], now)

    // 2026-11-27 is a Friday; the Monday series next falls on 2026-11-30.
    expect(iso(result?.startDate)).toBe('2026-11-30T09:00:00.000Z')
    expect(iso(result?.instanceDate)).toBe('2026-11-30T09:00:00.000Z')
    expect(result?.event).toBe(weekly)
  })

  it('counts an occurrence earlier today as the next one', () => {
    // Today is the host's day, so this series and clock use host-local times.
    const start = new Date(2026, 2, 2, 9, 0)
    const daily = calendarEvent({ startDate: start, endDate: new Date(2026, 2, 2, 9, 30), timezone: undefined, recurrenceRule: 'FREQ=DAILY' })

    const [result] = toSearchResults([daily], new Date(2026, 10, 27, 12, 0))

    expect(result?.startDate.getTime()).toBe(new Date(2026, 10, 27, 9, 0).getTime())
  })

  it('shows the most recent occurrence when the series has ended', () => {
    const ended = calendarEvent({ recurrenceRule: 'FREQ=WEEKLY;COUNT=4' })

    const [result] = toSearchResults([ended], now)

    expect(iso(result?.startDate)).toBe('2026-03-23T09:00:00.000Z')
    expect(iso(result?.instanceDate)).toBe('2026-03-23T09:00:00.000Z')
  })

  it('skips an excluded occurrence', () => {
    const weekly = calendarEvent({ recurrenceRule: 'FREQ=WEEKLY', exceptions: [at('2026-11-30T09:00:00.000Z')] })

    const [result] = toSearchResults([weekly], now)

    expect(iso(result?.startDate)).toBe('2026-12-07T09:00:00.000Z')
  })

  it('finds the next occurrence of a series that repeats less than yearly', () => {
    const everyTwoYears = calendarEvent({
      startDate: at('2025-06-01T09:00:00.000Z'),
      endDate: at('2025-06-01T10:00:00.000Z'),
      recurrenceRule: 'FREQ=YEARLY;INTERVAL=2',
    })

    const [result] = toSearchResults([everyTwoYears], now)

    expect(iso(result?.startDate)).toBe('2027-06-01T09:00:00.000Z')
  })

  it('sorts a repeating event by its shown occurrence, not its first date', () => {
    const weekly = calendarEvent({ id: 'weekly', recurrenceRule: 'FREQ=WEEKLY' })
    const oneOff = calendarEvent({ id: 'one-off', startDate: at('2026-11-29T09:00:00.000Z'), endDate: at('2026-11-29T10:00:00.000Z') })

    expect(toSearchResults([weekly, oneOff], now).map((r) => r.event.id)).toEqual(['one-off', 'weekly'])
  })
})
