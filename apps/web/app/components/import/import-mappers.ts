import { parseICalDateValue } from '@silentsuite/core'
import type { VEvent } from '@silentsuite/core/utils/ical-parser'

export interface ImportEventPayload {
  title: string
  description: string
  location: string
  startDate: Date
  endDate: Date
  allDay: boolean
  recurrenceRule: string | null
  alarms: NonNullable<VEvent['valarms']>
  calendarId: string
  timezone: string | undefined
}

// DTEND TZID note: when DTSTART and DTEND carry different TZIDs the per-side
// instant is parsed correctly here, but only `startTzid` is persisted as
// `timezone`. On round-trip both sides re-emit with the start-side TZID — the
// per-side label is lost. Rare in real-world ICS; tracked in #68.
export function vEventToImportEvent(
  event: VEvent,
  calendarId: string,
): ImportEventPayload {
  const startTzid = event.dtstartParams?.['TZID']
  const endTzid = event.dtendParams?.['TZID'] ?? startTzid
  const { date: start, allDay: isAllDay } = parseICalDateValue(event.dtstart, startTzid)
  const end = event.dtend
    ? parseICalDateValue(event.dtend, endTzid).date
    : new Date(start.getTime() + 60 * 60 * 1000)

  return {
    title: event.summary || 'Untitled Event',
    description: event.description ?? '',
    location: event.location ?? '',
    startDate: start,
    endDate: end,
    allDay: isAllDay,
    recurrenceRule: event.rrule ?? null,
    alarms: event.valarms ?? [],
    calendarId,
    timezone: isAllDay ? undefined : startTzid,
  }
}

// Date-only on import: the Task model has no timezone field, so a TZID-bearing
// or UTC datetime would otherwise be parsed in the importer's local zone and
// land on the wrong instant. Take the wall-clock date from the source value.
// Full TZID parity for VTODO is tracked in #66.
export function parseICalDate(d: string): Date | null {
  if (!d) return null
  const digits = d.replace(/[^0-9]/g, '')
  if (digits.length < 8) {
    const parsed = new Date(d)
    return isNaN(parsed.getTime()) ? null : parsed
  }
  return new Date(
    parseInt(digits.slice(0, 4)),
    parseInt(digits.slice(4, 6)) - 1,
    parseInt(digits.slice(6, 8)),
  )
}
