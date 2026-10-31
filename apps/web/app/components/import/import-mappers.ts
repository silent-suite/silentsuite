import { parseICalDateValue } from '@silentsuite/core'
import type { VEvent, VTodo } from '@silentsuite/core/utils/ical-parser'
import { normalizeLabels } from '@/app/components/LabelEditor'

export interface ImportEventPayload {
  title: string
  description: string
  location: string
  startDate: Date
  endDate: Date
  allDay: boolean
  recurrenceRule: string | null
  exceptions: Date[]
  alarms: NonNullable<VEvent['valarms']>
  categories: string[]
  calendarId: string
  timezone: string | undefined
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function addICalDuration(start: Date, duration: string, allDay: boolean): Date | null {
  const match = duration.match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i)
  if (!match) return null

  const weeks = Number(match[1] ?? 0)
  const days = Number(match[2] ?? 0)
  const hours = Number(match[3] ?? 0)
  const minutes = Number(match[4] ?? 0)
  const seconds = Number(match[5] ?? 0)
  if (weeks + days + hours + minutes + seconds === 0) return null

  if (allDay) {
    return hours + minutes + seconds === 0 ? addDays(start, weeks * 7 + days) : null
  }

  const ms = (((weeks * 7 + days) * 24 + hours) * 60 + minutes) * 60 * 1000 + seconds * 1000
  return new Date(start.getTime() + ms)
}

function defaultEndDate(start: Date, allDay: boolean): Date {
  return allDay ? addDays(start, 1) : new Date(start.getTime() + 60 * 60 * 1000)
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
    : event.duration
      ? addICalDuration(start, event.duration, isAllDay) ?? defaultEndDate(start, isAllDay)
      : defaultEndDate(start, isAllDay)
  const exdateTzid = event.exdateParams?.['TZID'] ?? startTzid
  const exceptions = event.exdate?.map((date) => parseICalDateValue(date, exdateTzid).date) ?? []

  return {
    title: event.summary || 'Untitled Event',
    description: event.description ?? '',
    location: event.location ?? '',
    startDate: start,
    endDate: end,
    allDay: isAllDay,
    recurrenceRule: event.rrule ?? null,
    exceptions,
    alarms: event.valarms ?? [],
    categories: normalizeLabels(event.categories ?? []),
    calendarId,
    timezone: isAllDay ? undefined : startTzid,
  }
}

export function isCompletedVTodo(task: Pick<VTodo, 'status' | 'completed' | 'percentComplete'>): boolean {
  const status = task.status?.toUpperCase()
  return status === 'COMPLETED'
    || task.percentComplete === 100
    || (status === undefined && task.completed !== undefined)
}
