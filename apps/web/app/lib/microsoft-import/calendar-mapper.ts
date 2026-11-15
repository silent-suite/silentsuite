import { generateVCalendar, isKnownTimeZone } from '@silentsuite/core'
import { splitCalendarItem, type VAlarm, type VEvent } from '@silentsuite/core/utils/ical-parser'
import type { ProviderImportVEvent } from '@/app/components/import/import-mappers'
import { importSourceKey, importSourceLine } from '../google-import/source-key'
import { dateOf, dayNumber, rruleFor, seriesPattern, type GraphRecurrence, type SeriesPattern } from './recurrence'
import { WINDOWS_TO_IANA } from './windows-zones'

export type { GraphRecurrence, GraphRecurrencePattern, GraphRecurrenceRange } from './recurrence'

/*
 * Microsoft Graph calendar events -> the VEvent shape the existing calendar import writes.
 *
 * The calendar event list returns singleInstance events and series masters only. Each master is
 * re-read on its own with its cancelledOccurrences and its complete exceptionOccurrences, and the
 * series becomes ONE import unit: the master VEVENT with cancelled occurrences as EXDATEs and
 * changed occurrences as same-UID RECURRENCE-ID overrides, written as a single encrypted item
 * (the same rule as the Google import). Anything in a series that cannot be read exactly leaves
 * the whole series out, without a source marker, so a later import tries it again.
 *
 * Graph returns start/end in UTC (no outlook.timezone preference is sent). A timed event is written
 * in its original zone (Windows names mapped through CLDR, IANA names used as they are); a single
 * event in an unknown or custom zone is written in UTC, a series in one is unreadable unless the
 * recurrence time zone resolves.
 */

export interface GraphDateTimeTimeZone {
  dateTime?: string
  timeZone?: string
}

export interface GraphEvent {
  id?: string
  iCalUId?: string
  type?: string
  subject?: string
  body?: { contentType?: string; content?: string }
  location?: { displayName?: string }
  start?: GraphDateTimeTimeZone
  end?: GraphDateTimeTimeZone
  isAllDay?: boolean
  originalStartTimeZone?: string
  originalEndTimeZone?: string
  showAs?: string
  isReminderOn?: boolean
  reminderMinutesBeforeStart?: number
  isCancelled?: boolean
  recurrence?: GraphRecurrence | null
  originalStart?: string
  cancelledOccurrences?: string[]
  exceptionOccurrences?: GraphEvent[]
}

export interface GraphCalendar {
  id?: string
  name?: string
  hexColor?: string
  color?: string
  isDefaultCalendar?: boolean
}

/** Fields for $select on the calendar event list and the master GET (plan "Projections"). */
export const EVENT_FIELDS: readonly string[] = Object.freeze([
  'id', 'iCalUId', 'type', 'subject', 'body', 'location', 'start', 'end', 'isAllDay',
  'originalStartTimeZone', 'originalEndTimeZone', 'showAs', 'isReminderOn',
  'reminderMinutesBeforeStart', 'isCancelled',
])
export const LIST_SELECT = [...EVENT_FIELDS, 'recurrence'].join(',')
export const MASTER_SELECT = [...EVENT_FIELDS, 'recurrence', 'cancelledOccurrences', 'exceptionOccurrences'].join(',')
export const MASTER_EXPAND = `exceptionOccurrences($select=${[...EVENT_FIELDS, 'originalStart'].join(',')})`
/** Required fields the mapper checks on each exception (missing → whole series unreadable). */
export const EXCEPTION_REQUIRED_FIELDS: readonly string[] = Object.freeze(['originalStart', 'start', 'end'])

const DAY_MS = 86_400_000

// ---- zones and instants -------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    formatters.set(zone, f)
  }
  return f
}

/** Wall clock of an instant in `zone`, as Date.UTC(fields) ms. */
function wallIn(zone: string, ms: number): number {
  const parts = formatter(zone).formatToParts(new Date(ms))
  const p = (type: string) => Number(parts.find((x) => x.type === type)?.value ?? '0')
  return Date.UTC(p('year'), p('month') - 1, p('day'), p('hour') % 24, p('minute'), p('second'))
}

/** Instant of a wall clock in `zone`: a repeated time is its first occurrence, a skipped one uses the
 *  offset from before the gap (RFC 5545 §3.3.5), as the core reader resolves TZID values. */
function instantOf(zone: string, wall: number): number {
  const offset = (ms: number) => wallIn(zone, ms) - ms
  const candidates = [offset(wall - DAY_MS), offset(wall + DAY_MS)]
    .filter((o) => offset(wall - o) === o)
    .map((o) => wall - o)
  return candidates.length > 0 ? Math.min(...candidates) : wall - offset(wall - DAY_MS)
}

/** An IANA zone for a Graph time zone name, or null for unknown and custom zones. */
export function resolveGraphTimeZone(name: string | undefined): string | null {
  if (typeof name !== 'string' || name.length === 0 || name.length > 100) return null
  if (name.toLowerCase() === 'tzone://microsoft/utc') return 'UTC'
  const candidate = Object.prototype.hasOwnProperty.call(WINDOWS_TO_IANA, name) ? WINDOWS_TO_IANA[name]! : name
  if (!/^[A-Za-z0-9_+\-/]+$/.test(candidate) || !isKnownTimeZone(candidate)) return null
  return formatter(candidate).resolvedOptions().timeZone
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')
const stamp = (wall: number) => {
  const d = new Date(wall)
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
}
const dateValue = (date: string) => date.replace(/-/g, '')
const dayOfWall = (wall: number) => Math.floor(wall / DAY_MS)
const timeOfWall = (wall: number) => wall - dayOfWall(wall) * DAY_MS

/** A Graph local dateTime ("2026-06-01T09:00:00.0000000") as Date.UTC(fields) ms. */
function parseLocal(value: string | undefined): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?$/.exec(value ?? '')
  const day = m ? dayNumber(m[1]) : null
  if (!m || day === null) return null
  const [h, mi, s] = [Number(m[2]), Number(m[3]), Number(m[4])]
  return h < 24 && mi < 60 && s < 60 ? day * DAY_MS + ((h * 60 + mi) * 60 + s) * 1000 : null
}

/** The instant of a Graph dateTimeTimeZone (UTC as returned by default, or a named zone). */
function instantOfGraph(value: GraphDateTimeTimeZone | undefined): number | null {
  const wall = parseLocal(value?.dateTime)
  if (wall === null || !value?.timeZone) return null
  if (value.timeZone.toUpperCase() === 'UTC') return wall
  const zone = resolveGraphTimeZone(value.timeZone)
  return zone ? instantOf(zone, wall) : null
}

/** A DateTimeOffset ("2026-06-01T07:00:00Z", offsets allowed) as an instant. */
function parseOffset(value: string | undefined): number | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$/i.exec(value ?? '')
  const wall = m ? parseLocal(m[1]) : null
  if (!m || wall === null) return null
  if (m[2]!.toUpperCase() === 'Z') return wall
  const sign = m[2]!.startsWith('-') ? -1 : 1
  const [oh, om] = m[2]!.slice(1).split(':').map(Number)
  return oh! < 24 && om! < 60 ? wall - sign * (oh! * 60 + om!) * 60_000 : null
}

/** The calendar date of an all-day boundary, for either shape Graph may return: a value at midnight
 *  is taken as is; otherwise the instant must be midnight in the original zone. */
function allDayDate(wall: number | null, instant: number | null, originalZone: string | undefined): string | null {
  if (wall !== null && timeOfWall(wall) === 0) return dateOf(dayOfWall(wall))
  const zone = resolveGraphTimeZone(originalZone)
  if (instant === null || !zone) return null
  const local = wallIn(zone, instant)
  return timeOfWall(local) === 0 ? dateOf(dayOfWall(local)) : null
}

function allDayOf(value: GraphDateTimeTimeZone | undefined, originalZone: string | undefined): string | null {
  return allDayDate(parseLocal(value?.dateTime), instantOfGraph(value), originalZone)
}

// ---- fields --------------------------------------------------------------------------------

function alarmsFor(event: GraphEvent): VAlarm[] | undefined {
  const m = event.reminderMinutesBeforeStart
  if (event.isReminderOn !== true || typeof m !== 'number' || !Number.isInteger(m) || m < 0) return undefined
  return [{ action: 'DISPLAY', trigger: m === 0 ? 'PT0S' : `-PT${m}M`, description: 'Reminder' }]
}

function textFields(event: GraphEvent): Partial<VEvent> {
  const description = event.body?.content && (event.body.contentType ?? 'text').toLowerCase() === 'text'
    ? event.body.content.trimEnd()
    : ''
  const location = event.location?.displayName?.trim()
  return {
    ...(event.subject ? { summary: event.subject } : {}),
    ...(description ? { description } : {}),
    ...(location ? { location } : {}),
    ...(event.showAs === 'free' ? { transp: 'TRANSPARENT' } : {}),
  }
}

type Timed = { value: string; params?: Record<string, string> }

/** True when the wall clock of `ms` in `zone` reads back as `ms`: false in the repeated hour after
 *  a DST fall-back, which a TZID value (and the core reader) resolves to its first occurrence. */
function roundTrips(zone: string, ms: number): boolean {
  return instantOf(zone, wallIn(zone, ms)) === ms
}

/** A TZID wall time, or UTC when the wall time would read back as a different instant. */
const inZone = (zone: string | null, ms: number): Timed => (zone && roundTrips(zone, ms)
  ? { value: stamp(wallIn(zone, ms)), params: { TZID: zone } }
  : { value: `${stamp(ms)}Z` })

/** One event's own VEVENT (a single event or a changed occurrence). Null if it cannot be read. */
function eventVEvent(event: GraphEvent, uid: string, fallbackZone: string | null): VEvent | null {
  let start: Timed, end: Timed
  if (event.isAllDay === true) {
    const s = allDayOf(event.start, event.originalStartTimeZone)
    const e = allDayOf(event.end, event.originalEndTimeZone ?? event.originalStartTimeZone)
    if (!s || !e || dayNumber(e)! <= dayNumber(s)!) return null
    start = { value: dateValue(s), params: { VALUE: 'DATE' } }
    end = { value: dateValue(e), params: { VALUE: 'DATE' } }
  } else {
    const s = instantOfGraph(event.start)
    const e = instantOfGraph(event.end)
    if (s === null || e === null || e < s) return null
    const zone = resolveGraphTimeZone(event.originalStartTimeZone) ?? fallbackZone
    start = inZone(zone, s)
    end = inZone(zone, e)
  }
  const alarms = alarmsFor(event)
  return {
    uid,
    dtstart: start.value,
    ...(start.params ? { dtstartParams: start.params } : {}),
    dtend: end.value,
    ...(end.params ? { dtendParams: end.params } : {}),
    ...textFields(event),
    ...(alarms ? { valarms: alarms } : {}),
  }
}

// ---- series --------------------------------------------------------------------------------

/** Sample window for comparing the series zone with a different recurrence time zone. */
const ZONE_CHECK_DAYS = 400

/**
 * When the recurrence time zone differs from the series zone, the occurrence dates (and the dates of
 * cancelled occurrence ids) are only unambiguous if both zones keep one fixed offset difference over
 * a full year and the series' time of day stays on the same date in both.
 */
function zonesAgree(seriesZone: string, recurrenceZone: string, firstWall: number): boolean {
  if (seriesZone === recurrenceZone) return true
  let delta: number | null = null
  for (let i = 0; i < ZONE_CHECK_DAYS; i++) {
    const ms = instantOf(seriesZone, firstWall + i * DAY_MS)
    const d = wallIn(recurrenceZone, ms) - wallIn(seriesZone, ms)
    if (delta === null) delta = d
    else if (d !== delta) return false
  }
  const shifted = timeOfWall(firstWall) + (delta ?? 0)
  return shifted >= 0 && shifted < DAY_MS
}

interface SeriesForm {
  allDay: boolean
  zone: string | null
  /** Time of day of every occurrence in `zone` (ms); 0 for all-day. */
  time: number
}

/** The RECURRENCE-ID / EXDATE value of the occurrence on `date`. */
const occurrenceValue = (form: SeriesForm, date: string) => (form.allDay
  ? dateValue(date)
  : stamp(dayNumber(date)! * DAY_MS + form.time))

function cancelledDate(id: unknown): string | null {
  if (typeof id !== 'string' || id.length > 4096) return null
  const m = /\.(\d{4}-\d{2}-\d{2})$/.exec(id)
  return m && dayNumber(m[1]) !== null ? m[1]! : null
}

/** The occurrence date an exception replaces, or null if originalStart is not an occurrence. */
function exceptionDate(exception: GraphEvent, form: SeriesForm, series: SeriesPattern, master: GraphEvent): string | null {
  const ms = parseOffset(exception.originalStart)
  if (ms === null) return null
  let date: string | null
  if (form.allDay) {
    date = allDayDate(ms, ms, master.originalStartTimeZone)
  } else {
    date = dateOf(dayOfWall(wallIn(form.zone!, ms)))
    if (instantOf(form.zone!, dayNumber(date)! * DAY_MS + form.time) !== ms) return null
  }
  return date && series.matches(date) ? date : null
}

function mapSeries(master: GraphEvent, uid: string, sourceKey: string): ProviderImportVEvent | null {
  if (!Array.isArray(master.cancelledOccurrences) || !Array.isArray(master.exceptionOccurrences)) return null
  const series = seriesPattern(master.recurrence)
  if (!series) return null
  const range = master.recurrence!.range!
  const firstDay = dayNumber(series.first)!

  let form: SeriesForm
  let dtstart: Timed, dtend: Timed, until: string | undefined
  if (master.isAllDay === true) {
    const s = allDayOf(master.start, master.originalStartTimeZone)
    const e = allDayOf(master.end, master.originalEndTimeZone ?? master.originalStartTimeZone)
    if (!s || !e || dayNumber(e)! <= dayNumber(s)!) return null
    form = { allDay: true, zone: null, time: 0 }
    dtstart = { value: dateValue(series.first), params: { VALUE: 'DATE' } }
    dtend = { value: dateValue(dateOf(firstDay + dayNumber(e)! - dayNumber(s)!)), params: { VALUE: 'DATE' } }
    if (series.end.kind === 'until') until = dateValue(series.end.date)
  } else {
    const hasRecurrenceZone = typeof range.recurrenceTimeZone === 'string' && range.recurrenceTimeZone !== ''
    const recurrenceZone = hasRecurrenceZone ? resolveGraphTimeZone(range.recurrenceTimeZone) : null
    if (hasRecurrenceZone && !recurrenceZone) return null
    const zone = resolveGraphTimeZone(master.originalStartTimeZone) ?? recurrenceZone
    const s = instantOfGraph(master.start)
    const e = instantOfGraph(master.end)
    if (!zone || s === null || e === null || e < s) return null
    // A series starting in the repeated hour of a DST fall-back cannot keep its wall clock exactly.
    if (!roundTrips(zone, s)) return null
    const time = timeOfWall(wallIn(zone, s))
    const firstWall = firstDay * DAY_MS + time
    if (recurrenceZone && !zonesAgree(zone, recurrenceZone, firstWall)) return null
    form = { allDay: false, zone, time }
    const startMs = instantOf(zone, firstWall)
    dtstart = { value: stamp(firstWall), params: { TZID: zone } }
    dtend = inZone(zone, startMs + (e - s))
    if (series.end.kind === 'until') {
      const untilZone = recurrenceZone ?? zone
      until = `${stamp(instantOf(untilZone, (dayNumber(series.end.date)! + 1) * DAY_MS) - 1000)}Z`
    }
  }
  const rrule = rruleFor(series, until)
  if (!rrule) return null

  const exdates = new Set<string>()
  for (const id of master.cancelledOccurrences) {
    const date = cancelledDate(id)
    if (!date || !series.matches(date)) return null
    exdates.add(occurrenceValue(form, date))
  }

  const overrides: VEvent[] = []
  const overrideIds = new Set<string>()
  for (const exception of master.exceptionOccurrences) {
    if (!exception || typeof exception !== 'object') return null
    if (EXCEPTION_REQUIRED_FIELDS.some((field) => (exception as Record<string, unknown>)[field] === undefined)) return null
    const date = exceptionDate(exception, form, series, master)
    if (!date) return null
    const rid = occurrenceValue(form, date)
    if (exception.isCancelled === true) { exdates.add(rid); continue }
    const override = eventVEvent(exception, uid, form.zone)
    if (!override || overrideIds.has(rid)) return null
    overrideIds.add(rid)
    const ridLine = form.allDay ? `RECURRENCE-ID;VALUE=DATE:${rid}` : `RECURRENCE-ID;TZID=${form.zone}:${rid}`
    overrides.push({ ...override, unknownProperties: [ridLine] })
  }
  // A changed occurrence that is also cancelled is contradictory.
  for (const rid of overrideIds) if (exdates.has(rid)) return null

  const alarms = alarmsFor(master)
  const vevent: VEvent = {
    uid,
    dtstart: dtstart.value,
    ...(dtstart.params ? { dtstartParams: dtstart.params } : {}),
    dtend: dtend.value,
    ...(dtend.params ? { dtendParams: dtend.params } : {}),
    ...textFields(master),
    rrule,
    ...(exdates.size > 0 ? { exdate: [...exdates].sort(), ...(form.zone ? { exdateParams: { TZID: form.zone } } : {}) } : {}),
    ...(alarms ? { valarms: alarms } : {}),
    unknownProperties: [importSourceLine(sourceKey)],
  }
  // Overrides are kept exactly as the shared core reader keeps them from a synced item.
  const kept = overrides.length > 0 ? splitCalendarItem(generateVCalendar([vevent, ...overrides]))?.overrides ?? [] : []
  if (kept.length !== overrides.length) return null
  return { ...vevent, sourceKey, ...(kept.length > 0 ? { overrides: kept } : {}) }
}

export interface MappedMicrosoftCalendar {
  units: ProviderImportVEvent[]
  /** Events or series left out because they (or a part of their series) could not be read.
   *  None of them is marked imported, so a later import tries them again. */
  unreadable: number
}

/**
 * `events`: singleInstance events from the list, plus each seriesMaster AS RE-READ by the master GET
 * (with cancelledOccurrences and the complete exceptionOccurrences). `incompleteMasters`: ids of masters
 * whose detail read or continuation could not be completed; counted unreadable, never imported.
 * `newUid` gives each unit a fresh SilentSuite UID; the Graph iCalUId is the source key, not the UID.
 */
export function mapMicrosoftCalendarEvents(
  accountId: string,
  calendar: GraphCalendar,
  events: readonly GraphEvent[],
  incompleteMasters: ReadonlySet<string> = new Set(),
  newUid: () => string = () => crypto.randomUUID(),
): MappedMicrosoftCalendar {
  const units: ProviderImportVEvent[] = []
  const seen = new Set<string>()
  let unreadable = 0
  for (const event of events) {
    // Occurrences and exceptions are read through their master, never on their own.
    if (event.type === 'occurrence' || event.type === 'exception') continue
    if (event.isCancelled === true) continue
    const isMaster = event.type === 'seriesMaster' || (event.type === undefined && event.recurrence != null)
    const known = event.type === undefined || event.type === 'seriesMaster' || event.type === 'singleInstance'
    if (!known || !calendar.id || !event.iCalUId || (!isMaster && event.recurrence != null)
      || (isMaster && (!event.id || incompleteMasters.has(event.id)))) {
      unreadable += 1
      continue
    }
    const sourceKey = importSourceKey('microsoft', accountId, calendar.id, event.iCalUId)
    if (seen.has(sourceKey)) continue
    const uid = newUid()
    let unit: ProviderImportVEvent | null
    if (isMaster) {
      unit = mapSeries(event, uid, sourceKey)
    } else {
      const vevent = eventVEvent(event, uid, null)
      unit = vevent ? { ...vevent, unknownProperties: [importSourceLine(sourceKey)], sourceKey } : null
    }
    if (!unit) { unreadable += 1; continue }
    seen.add(sourceKey)
    units.push(unit)
  }
  return { units, unreadable }
}
