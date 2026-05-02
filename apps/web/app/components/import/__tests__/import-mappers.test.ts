import { describe, it, expect } from 'vitest'
import { vEventToImportEvent, parseICalDate } from '../import-mappers'
import type { VEvent } from '@silentsuite/core/utils/ical-parser'

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
