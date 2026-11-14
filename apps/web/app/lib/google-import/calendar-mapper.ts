import { generateVCalendar, isKnownTimeZone, parseICalDateValue } from '@silentsuite/core'
import { splitCalendarItem, type VAlarm, type VEvent } from '@silentsuite/core/utils/ical-parser'
import type { ProviderImportVEvent } from '@/app/components/import/import-mappers'
import { importSourceKey, importSourceLine } from './source-key'

/*
 * Google Calendar API events -> the VEvent shape the existing calendar import writes.
 *
 * Events are listed with singleEvents=false, so a recurring series arrives as its master
 * plus one entry per changed or cancelled occurrence (recurringEventId = the master's id).
 * Each series becomes ONE import unit: the master VEVENT with cancelled occurrences as
 * EXDATEs and changed occurrences as same-UID RECURRENCE-ID overrides, all written as a
 * single encrypted item. A series is therefore saved or skipped as a whole and cannot be
 * left half-written. Its source key is the series iCalUID.
 */

export interface GoogleEventDateTime {
  date?: string
  dateTime?: string
  timeZone?: string
}

export interface GoogleReminder {
  method?: string
  minutes?: number
}

export interface GoogleEvent {
  id: string
  iCalUID?: string
  status?: string
  eventType?: string
  summary?: string
  description?: string
  location?: string
  transparency?: string
  start?: GoogleEventDateTime
  end?: GoogleEventDateTime
  recurrence?: string[]
  recurringEventId?: string
  originalStartTime?: GoogleEventDateTime
  reminders?: { useDefault?: boolean; overrides?: GoogleReminder[] }
}

export interface GoogleCalendar {
  id: string
  summary?: string
  summaryOverride?: string
  backgroundColor?: string
  timeZone?: string
  primary?: boolean
  defaultReminders?: GoogleReminder[]
}

/** Google's generated contact-birthday calendar: SilentSuite derives birthdays from contacts itself. */
export function isGoogleBirthdayCalendar(calendar: Pick<GoogleCalendar, 'id'>): boolean {
  return calendar.id.endsWith('#contacts@group.v.calendar.google.com')
}

/** Event types that are not calendar entries a user would expect to move. */
const SKIPPED_EVENT_TYPES = new Set(['workingLocation', 'birthday'])

type StartForm = { kind: 'date' } | { kind: 'tzid'; zone: string } | { kind: 'utc' }

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

function utcStamp(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
}

function wallClock(ms: number, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms))
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  const hour = part('hour') === '24' ? '00' : part('hour')
  return `${part('year')}${part('month')}${part('day')}T${hour}${part('minute')}${part('second')}`
}

function dateValue(date: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.replace(/-/g, '') : null
}

function formOf(start: GoogleEventDateTime): StartForm {
  if (start.date) return { kind: 'date' }
  const zone = start.timeZone
  return zone && isKnownTimeZone(zone) ? { kind: 'tzid', zone } : { kind: 'utc' }
}

/** An iCalendar value and parameters for a Google date or date-time, written in `form`. */
function inForm(value: GoogleEventDateTime, form: StartForm): { value: string; params?: Record<string, string> } | null {
  if (form.kind === 'date') {
    const date = dateValue(value.date ?? value.dateTime?.slice(0, 10) ?? '')
    return date ? { value: date, params: { VALUE: 'DATE' } } : null
  }
  if (!value.dateTime) return null
  const ms = Date.parse(value.dateTime)
  if (!Number.isFinite(ms)) return null
  return form.kind === 'tzid'
    ? { value: wallClock(ms, form.zone), params: { TZID: form.zone } }
    : { value: utcStamp(ms) }
}

/** An instant or date read from an EXDATE value, written in the series' form. */
function exdateInForm(raw: string, params: Record<string, string>, form: StartForm): string | null {
  const clean = raw.trim()
  const isDate = (params['VALUE'] ?? '').toUpperCase() === 'DATE' || /^\d{8}$/.test(clean)
  if (form.kind === 'date') return /^\d{8}/.test(clean) ? clean.slice(0, 8) : null
  if (isDate) return null
  const { date } = parseICalDateValue(clean, params['TZID'])
  const ms = date.getTime()
  if (!Number.isFinite(ms)) return null
  return form.kind === 'tzid' ? wallClock(ms, form.zone) : utcStamp(ms)
}

/** No CR, LF or other controls: a provider value can never add a line. */
const SAFE_RECURRENCE_LINE = /^(RRULE|RDATE|EXDATE)([;:])[^\u0000-\u001f\u007f]*$/i

function parseRecurrenceLine(line: string): { name: string; params: Record<string, string>; value: string } | null {
  const match = SAFE_RECURRENCE_LINE.exec(line)
  if (!match) return null
  const colon = line.indexOf(':')
  if (colon === -1) return null
  const head = line.slice(0, colon).split(';')
  const params: Record<string, string> = {}
  for (const param of head.slice(1)) {
    const eq = param.indexOf('=')
    if (eq > 0) params[param.slice(0, eq).toUpperCase()] = param.slice(eq + 1)
  }
  return { name: head[0]!.toUpperCase(), params, value: line.slice(colon + 1) }
}

function alarmsFor(event: GoogleEvent, calendar: GoogleCalendar): VAlarm[] | undefined {
  const reminders = event.reminders?.useDefault === false
    ? event.reminders.overrides ?? []
    : calendar.defaultReminders ?? []
  const alarms = reminders
    .filter((r) => r.method === 'popup' && typeof r.minutes === 'number' && Number.isInteger(r.minutes) && r.minutes >= 0)
    .map((r) => ({ action: 'DISPLAY', trigger: r.minutes === 0 ? 'PT0S' : `-PT${r.minutes}M`, description: 'Reminder' }))
  return alarms.length > 0 ? alarms : undefined
}

/** The VEVENT fields every entry has, its DTSTART/DTEND in its own form. Null if it has no usable start. */
function baseVEvent(event: GoogleEvent, uid: string): VEvent | null {
  if (!event.start) return null
  const form = formOf(event.start)
  const start = inForm(event.start, form)
  if (!start) return null
  // A timed end keeps its own zone (else the start's); an all-day end is a DATE like its start.
  const end = event.end
    ? inForm(event.end, form.kind === 'date' ? form : formOf({ dateTime: event.end.dateTime, timeZone: event.end.timeZone ?? event.start.timeZone }))
    : null
  const status = event.status === 'tentative' ? 'TENTATIVE' : event.status === 'confirmed' ? 'CONFIRMED' : undefined
  return {
    uid,
    dtstart: start.value,
    ...(start.params ? { dtstartParams: start.params } : {}),
    ...(end ? { dtend: end.value, ...(end.params ? { dtendParams: end.params } : {}) } : {}),
    ...(event.summary ? { summary: event.summary } : {}),
    ...(event.description ? { description: event.description } : {}),
    ...(event.location ? { location: event.location } : {}),
    ...(status ? { status } : {}),
    ...(event.transparency === 'transparent' ? { transp: 'TRANSPARENT' } : {}),
  }
}

export interface MappedGoogleCalendar {
  units: ProviderImportVEvent[]
  /** Entries that could not be read (no usable start) and were left out. */
  unreadable: number
}

/**
 * Maps one calendar's events (all pages) into import units. `newUid` gives each unit a fresh
 * SilentSuite UID; the Google iCalUID is kept as the source key, not reused as UID.
 */
export function mapGoogleCalendarEvents(
  accountId: string,
  calendar: GoogleCalendar,
  events: readonly GoogleEvent[],
  newUid: () => string = () => crypto.randomUUID(),
): MappedGoogleCalendar {
  const keyFor = (itemId: string) => importSourceKey('google', accountId, calendar.id, itemId)
  const relevant = events.filter((e) => !SKIPPED_EVENT_TYPES.has(e.eventType ?? 'default'))
  const masters = new Map<string, GoogleEvent>()
  for (const event of relevant) {
    if (!event.recurringEventId && event.status !== 'cancelled' && (event.recurrence?.length ?? 0) > 0) masters.set(event.id, event)
  }
  const instancesOf = new Map<string, GoogleEvent[]>()
  const standalone: GoogleEvent[] = []
  for (const event of relevant) {
    if (masters.has(event.id)) continue
    if (event.recurringEventId && masters.has(event.recurringEventId)) {
      instancesOf.set(event.recurringEventId, [...(instancesOf.get(event.recurringEventId) ?? []), event])
    } else if (event.status !== 'cancelled') {
      standalone.push(event)
    }
  }

  const units: ProviderImportVEvent[] = []
  const seen = new Set<string>()
  let unreadable = 0
  const push = (unit: ProviderImportVEvent) => {
    if (seen.has(unit.sourceKey)) return
    seen.add(unit.sourceKey)
    units.push(unit)
  }

  for (const master of masters.values()) {
    const uid = newUid()
    const base = baseVEvent(master, uid)
    if (!base) { unreadable += 1 + (instancesOf.get(master.id)?.length ?? 0); continue }
    const form = formOf(master.start!)
    const sourceKey = keyFor(master.iCalUID ?? master.id)
    const exdates: string[] = []
    const retained: string[] = [importSourceLine(sourceKey)]
    let rrule: string | undefined
    for (const line of master.recurrence ?? []) {
      const parsed = parseRecurrenceLine(line)
      if (!parsed) continue
      if (parsed.name === 'RRULE') rrule ??= parsed.value
      else if (parsed.name === 'RDATE') retained.push(line)
      else for (const value of parsed.value.split(',')) {
        const exdate = exdateInForm(value, parsed.params, form)
        if (exdate) exdates.push(exdate)
      }
    }
    const overrides: VEvent[] = []
    for (const instance of instancesOf.get(master.id) ?? []) {
      const rid = instance.originalStartTime ? inForm(instance.originalStartTime, form) : null
      if (!rid) { unreadable += 1; continue }
      if (instance.status === 'cancelled') { exdates.push(rid.value); continue }
      const override = baseVEvent(instance, uid)
      if (!override) { unreadable += 1; continue }
      const ridParams = rid.params ? Object.entries(rid.params).map(([k, v]) => `;${k}=${v}`).join('') : ''
      const alarms = alarmsFor(instance, calendar)
      overrides.push({ ...override, ...(alarms ? { valarms: alarms } : {}), unknownProperties: [`RECURRENCE-ID${ridParams}:${rid.value}`] })
    }
    const alarms = alarmsFor(master, calendar)
    const vevent: VEvent = {
      ...base,
      ...(rrule ? { rrule } : {}),
      ...(exdates.length > 0 ? { exdate: [...new Set(exdates)], ...(form.kind === 'tzid' ? { exdateParams: { TZID: form.zone } } : {}) } : {}),
      ...(alarms ? { valarms: alarms } : {}),
      unknownProperties: retained,
    }
    // Overrides are kept exactly as the shared core reader keeps them from a synced item.
    const kept = overrides.length > 0 ? splitCalendarItem(generateVCalendar([vevent, ...overrides]))?.overrides ?? [] : []
    unreadable += overrides.length - kept.length
    push({ ...vevent, sourceKey, ...(kept.length > 0 ? { overrides: kept } : {}) })
  }

  for (const event of standalone) {
    const base = baseVEvent(event, newUid())
    if (!base) { unreadable += 1; continue }
    // A changed occurrence whose series is not visible here is kept as a plain event of its own.
    const itemId = event.recurringEventId
      ? `${event.iCalUID ?? event.recurringEventId}#${event.originalStartTime?.dateTime ?? event.originalStartTime?.date ?? event.id}`
      : event.iCalUID ?? event.id
    const sourceKey = keyFor(itemId)
    const alarms = alarmsFor(event, calendar)
    push({ ...base, ...(alarms ? { valarms: alarms } : {}), unknownProperties: [importSourceLine(sourceKey)], sourceKey })
  }

  return { units, unreadable }
}
