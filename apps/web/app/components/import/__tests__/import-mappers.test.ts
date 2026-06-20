import { describe, it, expect } from 'vitest'
import { vEventToImportEvent, parseICalDate, isCompletedVTodo } from '../import-mappers'
import type { VEvent, VTodo } from '@silentsuite/core/utils/ical-parser'

describe('vEventToImportEvent', () => {
  it('propagates source TZID into the import payload', () => {
    const event: VEvent = {
      uid: 'a@example',
      summary: 'NY meeting',
      dtstart: '20260601T090000',
      dtend: '20260601T100000',
      dtstartParams: { TZID: 'America/New_York' },
      dtendParams: { TZID: 'America/New_York' },
    }

    const payload = vEventToImportEvent(event, 'cal-1')

    expect(payload.timezone).toBe('America/New_York')
    expect(payload.allDay).toBe(false)
    expect(payload.calendarId).toBe('cal-1')
  })

  it('preserves CATEGORIES labels in the import payload', () => {
    const event: VEvent = {
      uid: 'cat@example',
      summary: 'Tagged event',
      dtstart: '20260601T090000',
      dtend: '20260601T100000',
      categories: ['Work', 'Urgent'],
    }

    const payload = vEventToImportEvent(event, 'cal-1')

    expect(payload.categories).toEqual(['Work', 'Urgent'])
  })

  it('defaults categories to an empty array when the source has none', () => {
    const event: VEvent = {
      uid: 'nocat@example',
      summary: 'Untagged event',
      dtstart: '20260601T090000',
      dtend: '20260601T100000',
    }

    const payload = vEventToImportEvent(event, 'cal-1')

    expect(payload.categories).toEqual([])
  })

  it('drops timezone for all-day events (DATE-only, no TZID per RFC 5545)', () => {
    const event: VEvent = {
      uid: 'b@example',
      summary: 'All-day',
      dtstart: '20260601',
      dtend: '20260602',
    }

    const payload = vEventToImportEvent(event, 'cal-1')

    expect(payload.allDay).toBe(true)
    expect(payload.timezone).toBeUndefined()
  })

  it('leaves timezone undefined when DTSTART has no TZID (floating)', () => {
    const event: VEvent = {
      uid: 'c@example',
      summary: 'Floating',
      dtstart: '20260601T090000',
      dtend: '20260601T100000',
    }

    const payload = vEventToImportEvent(event, 'cal-1')

    expect(payload.timezone).toBeUndefined()
    expect(payload.allDay).toBe(false)
  })

  it('uses DURATION when DTEND is absent', () => {
    const event: VEvent = {
      uid: 'duration@example',
      summary: 'Long workshop',
      dtstart: '20260601T090000',
      duration: 'PT3H',
    }

    const payload = vEventToImportEvent(event, 'cal-1')

    expect(payload.endDate.getTime() - payload.startDate.getTime()).toBe(3 * 60 * 60 * 1000)
  })

  it('prefers DTEND over DURATION when both are present', () => {
    const event: VEvent = {
      uid: 'duration-with-end@example',
      summary: 'Workshop',
      dtstart: '20260601T090000',
      dtend: '20260601T100000',
      duration: 'PT3H',
    }

    const payload = vEventToImportEvent(event, 'cal-1')

    expect(payload.endDate.getTime() - payload.startDate.getTime()).toBe(60 * 60 * 1000)
  })

  it('defaults all-day events without DTEND to one day', () => {
    const event: VEvent = {
      uid: 'all-day-no-end@example',
      summary: 'Holiday',
      dtstart: '20260601',
      dtstartParams: { VALUE: 'DATE' },
    }

    const payload = vEventToImportEvent(event, 'cal-1')

    expect(payload.allDay).toBe(true)
    expect(payload.startDate.getFullYear()).toBe(2026)
    expect(payload.startDate.getMonth()).toBe(5)
    expect(payload.startDate.getDate()).toBe(1)
    expect(payload.endDate.getFullYear()).toBe(2026)
    expect(payload.endDate.getMonth()).toBe(5)
    expect(payload.endDate.getDate()).toBe(2)
  })

  it('falls back to one day for invalid timed DURATION on all-day events', () => {
    const event: VEvent = {
      uid: 'all-day-invalid-duration@example',
      summary: 'Holiday',
      dtstart: '20260601',
      dtstartParams: { VALUE: 'DATE' },
      duration: 'PT3H',
    }

    const payload = vEventToImportEvent(event, 'cal-1')

    expect(payload.allDay).toBe(true)
    expect(payload.endDate.getFullYear()).toBe(2026)
    expect(payload.endDate.getMonth()).toBe(5)
    expect(payload.endDate.getDate()).toBe(2)
  })

  it('maps EXDATE values into import exceptions', () => {
    const event: VEvent = {
      uid: 'recurring@example',
      summary: 'Daily standup',
      dtstart: '20260601T090000',
      dtend: '20260601T093000',
      rrule: 'FREQ=DAILY;COUNT=3',
      exdate: ['20260602T090000'],
    }

    const payload = vEventToImportEvent(event, 'cal-1')

    expect(payload.exceptions).toHaveLength(1)
    expect(payload.exceptions[0]!.getFullYear()).toBe(2026)
    expect(payload.exceptions[0]!.getMonth()).toBe(5)
    expect(payload.exceptions[0]!.getDate()).toBe(2)
  })
})

describe('parseICalDate', () => {
  it('returns null for empty input', () => {
    expect(parseICalDate('')).toBeNull()
  })

  // Locale-resilience: assert on date components, not epoch ms — getFullYear /
  // getMonth / getDate reflect the constructor args regardless of TZ.
  it('extracts the wall-clock date from a TZID-stripped datetime', () => {
    const d = parseICalDate('20260601T090000')!
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(5)
    expect(d.getDate()).toBe(1)
  })

  it('extracts the wall-clock date from a UTC-suffixed datetime', () => {
    const d = parseICalDate('20260601T090000Z')!
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(5)
    expect(d.getDate()).toBe(1)
  })

  it('extracts the wall-clock date from a date-only value', () => {
    const d = parseICalDate('20260601')!
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(5)
    expect(d.getDate()).toBe(1)
  })
})

describe('isCompletedVTodo', () => {
  it('treats completed status as completed', () => {
    expect(isCompletedVTodo({ status: 'COMPLETED' })).toBe(true)
  })

  it('treats percent-complete 100 as completed for tasks.org compatibility', () => {
    const task: Pick<VTodo, 'status' | 'percentComplete'> = {
      status: 'NEEDS-ACTION',
      percentComplete: 100,
    }

    expect(isCompletedVTodo(task)).toBe(true)
  })

  it('does not let completed timestamp override explicit incomplete status', () => {
    expect(isCompletedVTodo({ status: 'NEEDS-ACTION', completed: '20260601T100000Z' })).toBe(false)
  })

  it('treats completed timestamp as completed when status is absent', () => {
    expect(isCompletedVTodo({ completed: '20260601T100000Z' })).toBe(true)
  })
})
