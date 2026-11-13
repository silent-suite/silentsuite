import { parseVEvent, generateVEvent, partitionRetainedRDates } from '../utils/ical-parser.js';
import type { VEvent, VAlarm } from '../utils/ical-parser.js';
import { isKnownTimeZone, wallTimeInZone, wallTimeToInstant } from '../utils/zoned-time.js';
import { expandRecurrence, occurrenceWallClock, occurrencesBefore } from '../utils/recurrence.js';
import type { DateRange } from './types.js';

export interface CalendarEvent {
  id: string;
  uid: string;
  title: string;
  description: string;
  location: string;
  startDate: Date;
  endDate: Date;
  allDay: boolean;
  recurrenceRule: string | null;
  exceptions: Date[];
  alarms: VAlarm[];
  /** User-defined labels/categories for grouping and filtering.
   *  Round-tripped via the ICS CATEGORIES property (comma-separated).
   *  Optional so existing callers keep compiling; deserialize paths default to []. */
  categories?: string[];
  calendarId?: string;
  /** IANA timezone for this event (e.g. 'America/New_York'). When absent,
   *  falls back to user default timezone, then local system timezone. */
  timezone?: string;
  /** True only when a timed DTSTART was read as RFC 5545 floating time (no Z, no TZID).
   *  Such events keep host-local semantics and are written back floating. Omitted otherwise.
   *  `allDay` and `timezone` take precedence over this flag. */
  floating?: true;
  /** Intended DTSTART wall clock (`YYYYMMDDTHHMMSS`) of a timed TZID event whose wall time does
   *  not exist in its zone (a DST gap), so it cannot be recovered from `startDate`. Present only
   *  in that case. Used only while it still resolves to `startDate` in `timezone`. */
  startWallClock?: string;
  /** The source DURATION of an event read without DTEND. Written back instead of DTEND while
   *  it still gives `endDate` from `startDate`, so nominal days and weeks keep their meaning
   *  for every occurrence. Omitted otherwise. */
  duration?: string;
  /** STATUS and TRANSP from the source, written back unchanged. Omitted when absent. */
  status?: string;
  transp?: string;
  /** Unsupported VEVENT property lines and subcomponents, kept so a web save does not
   *  drop them (attendees, organizer, CLASS, SEQUENCE, X-properties and the like).
   *  Revalidated when written. Omitted when there are none. */
  unknownProperties?: string[];
  unknownComponents?: string[][];
  created: Date;
  updated: Date;
}

function formatICalDate(date: Date, allDay: boolean): string {
  if (allDay) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}${m}${d}`;
  }
  return formatICalDateTime(date);
}

/** Format a Date as a local wall-clock iCal datetime string (no Z suffix) for
 * use with DTSTART;TZID=... properties. This preserves the local time in the
 * given timezone rather than converting to UTC.
 */
function formatICalDateTimeLocal(date: Date, tzid: string): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tzid,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const p = (type: string) => parts.find((x) => x.type === type)?.value ?? '00';
  const year = p('year');
  const month = p('month');
  const day = p('day');
  const hour = p('hour') === '24' ? '00' : p('hour'); // midnight edge case
  const minute = p('minute');
  const second = p('second');
  return `${year}${month}${day}T${hour}${minute}${second}`;
}

/** Host-local wall clock without Z or TZID, for events that were read as floating. */
function formatICalDateTimeFloating(date: Date): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}${mo}${d}T${h}${mi}${s}`;
}

function formatICalDateTime(date: Date): string {
  // Emit UTC with Z suffix so events have a timezone anchor across all sync
  // clients and timezones. Floating-time (no Z, no TZID) would cause events
  // to shift when viewed from a different timezone.
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const h = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  const s = String(date.getUTCSeconds()).padStart(2, '0');
  return `${y}${mo}${d}T${h}${mi}${s}Z`;
}

export function parseICalDateValue(value: string, tzid?: string): { date: Date; allDay: boolean } {
  const clean = value.replace(/[^0-9TZ]/g, '');
  const year = parseInt(clean.slice(0, 4), 10);
  const month = parseInt(clean.slice(4, 6), 10) - 1;
  const day = parseInt(clean.slice(6, 8), 10);

  if (clean.length <= 8) {
    return { date: new Date(year, month, day), allDay: true };
  }

  const hour = parseInt(clean.slice(9, 11), 10);
  const minute = parseInt(clean.slice(11, 13), 10);
  const second = parseInt(clean.slice(13, 15), 10);

  if (clean.endsWith('Z')) {
    return { date: new Date(Date.UTC(year, month, day, hour, minute, second)), allDay: false };
  }

  // If a TZID is specified, resolve the wall clock in that zone (host-independent).
  // DST gaps use the pre-gap offset and overlaps the first occurrence (RFC 5545 §3.3.5),
  // the same conversion recurrence expansion uses, so parsed EXDATEs match expanded
  // occurrences.
  if (tzid) {
    const instant = wallTimeToInstant(tzid, Date.UTC(year, month, day, hour, minute, second));
    if (instant !== null) return { date: new Date(instant), allDay: false };
    // Invalid TZID — fall through to local time interpretation
  }

  return { date: new Date(year, month, day, hour, minute, second), allDay: false };
}

/**
 * True for an RFC 5545 floating DATE-TIME: a timed value with neither a TZID parameter nor a
 * trailing Z. DATE values (VALUE=DATE or 8 digits) are never floating.
 */
export function isFloatingICalDateTime(value: string, params?: Record<string, string>): boolean {
  if (params?.['VALUE']?.toUpperCase() === 'DATE') return false;
  const clean = value.replace(/[^0-9TZ]/g, '');
  if (clean.length <= 8) return false;
  if (clean.endsWith('Z')) return false;
  return !params?.['TZID'];
}

/** Decode a `YYYYMMDDTHHMMSS` wall clock to civil ms (`Date.UTC(fields)`), or null. */
function wallClockToCivil(wall: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(wall);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

function civilToWallClock(civil: number): string {
  const d = new Date(civil);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/**
 * For a timed iCalendar wall-clock value (Z-less DATE-TIME text) in a zone Intl knows: returns the
 * normalized `YYYYMMDDTHHMMSS` value when that wall time does not round-trip through its resolved
 * instant (it lies in a DST gap); otherwise undefined.
 */
export function gapWallClock(timeZone: string | undefined, value: string): string | undefined {
  if (!timeZone || !isKnownTimeZone(timeZone)) return undefined;
  const clean = value.replace(/[^0-9TZ]/g, '');
  if (clean.length < 15 || clean.endsWith('Z')) return undefined;
  const wall = clean.slice(0, 15);
  const civil = wallClockToCivil(wall);
  if (civil === null) return undefined;
  const instant = wallTimeToInstant(timeZone, civil);
  if (instant === null) return undefined;
  return civilToWallClock(wallTimeInZone(timeZone, instant)) === wall ? undefined : wall;
}

/**
 * The event's `startWallClock` if it is still consistent with the event: timed, with a known
 * `timezone`, and resolving to exactly `startDate`. Otherwise undefined (callers then derive the
 * wall clock from `startDate`).
 */
export function validStartWallClock(
  event: Pick<CalendarEvent, 'allDay' | 'timezone' | 'startDate' | 'startWallClock'>,
): string | undefined {
  const wall = event.startWallClock;
  const timeZone = event.timezone;
  if (!wall || event.allDay || !timeZone || !isKnownTimeZone(timeZone)) return undefined;
  const civil = wallClockToCivil(wall);
  if (civil === null) return undefined;
  return wallTimeToInstant(timeZone, civil) === event.startDate.getTime() ? wall : undefined;
}

/**
 * The series wall clock (`YYYYMMDDTHHMMSS`) of the occurrence of a recurring TZID event at
 * `instance`, derived from the series' own recurrence stepping. Undefined when the event is not a
 * timed recurring event in a known zone, or `instance` is not exactly one generated occurrence.
 */
export function eventOccurrenceWallClock(master: CalendarEvent, instance: Date): string | undefined {
  const timeZone = master.timezone;
  if (!master.recurrenceRule || master.allDay || !timeZone || !isKnownTimeZone(timeZone)) return undefined;
  return occurrenceWallClock(master.recurrenceRule, master.startDate, instance, {
    timeZone,
    startWallClock: validStartWallClock(master),
  });
}

/**
 * The zone in which an event's recurrence repeats DTSTART's wall clock.
 * Precedence: all-day (host-local dates) > TZID > floating (host-local) > explicit UTC.
 * Returns undefined for host-local expansion.
 */
export function recurrenceTimeZone(
  event: Pick<CalendarEvent, 'allDay' | 'timezone' | 'floating'>,
): string | undefined {
  if (event.allDay) return undefined;
  if (event.timezone) return event.timezone;
  if (event.floating === true) return undefined;
  return 'UTC';
}

/**
 * The RRULE for a series that continues `master` from its occurrence at `instance` (a "this and
 * future" split). A COUNT keeps only the occurrences still to come from `instance` on, so the two
 * series together have as many occurrences as the original; other rules are returned unchanged.
 */
export function recurrenceRuleFrom(master: CalendarEvent, instance: Date): string | null {
  const rule = master.recurrenceRule;
  if (!rule) return rule;
  const parts = rule.split(';');
  const countIndex = parts.findIndex((part) => /^COUNT=/i.test(part));
  if (countIndex === -1) return rule;
  const count = Number.parseInt(parts[countIndex]!.slice('COUNT='.length), 10);
  if (!Number.isFinite(count)) return rule;
  const before = occurrencesBefore(rule, master.startDate, instance, {
    timeZone: recurrenceTimeZone(master),
    startWallClock: validStartWallClock(master),
  });
  parts[countIndex] = `COUNT=${Math.max(1, count - before)}`;
  return parts.join(';');
}

/**
 * Expand a recurring event's occurrences within `range`, in the event's own anchor zone,
 * excluding its EXDATEs. Returns [] for an event without a recurrence rule.
 */
export function expandEventRecurrence(event: CalendarEvent, range: DateRange): Date[] {
  if (!event.recurrenceRule) return [];
  return expandRecurrence(event.recurrenceRule, event.startDate, range, event.exceptions, {
    timeZone: recurrenceTimeZone(event),
    startWallClock: validStartWallClock(event),
  });
}

/**
 * End of an event that has DURATION instead of DTEND (RFC 5545 §3.3.6). Weeks and days are
 * nominal: they keep the wall clock in `timeZone` (host-local when undefined, as for all-day and
 * floating events), so P1D across a DST change is 23 or 25 hours. Hours, minutes and seconds are
 * exact. Null for a missing, negative, zero or unreadable duration, or a timed part on an all-day
 * event.
 */
function addICalDuration(start: Date, duration: string, allDay: boolean, timeZone: string | undefined): Date | null {
  const match = duration.match(/^\+?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!match) return null;
  const [weeks, days, hours, minutes, seconds] = match.slice(1, 6).map((v) => Number(v ?? 0)) as [
    number, number, number, number, number,
  ];
  if (weeks + days + hours + minutes + seconds === 0) return null;
  if (allDay && hours + minutes + seconds !== 0) return null;
  const nominalDays = weeks * 7 + days;
  let afterDays: number;
  if (timeZone === 'UTC' || nominalDays === 0) {
    afterDays = start.getTime() + nominalDays * 86_400_000;
  } else if (timeZone && isKnownTimeZone(timeZone)) {
    const wall = wallTimeInZone(timeZone, start.getTime()) + nominalDays * 86_400_000;
    const instant = wallTimeToInstant(timeZone, wall);
    if (instant === null) return null;
    afterDays = instant;
  } else {
    const local = new Date(start);
    local.setDate(local.getDate() + nominalDays);
    afterDays = local.getTime();
  }
  return new Date(afterDays + ((hours * 60 + minutes) * 60 + seconds) * 1000);
}

/** The event's source DURATION while it still gives `endDate` from `startDate`; otherwise undefined. */
function currentDuration(
  event: Pick<CalendarEvent, 'allDay' | 'timezone' | 'floating' | 'duration' | 'startDate' | 'endDate'>,
): string | undefined {
  if (event.duration === undefined) return undefined;
  const end = addICalDuration(event.startDate, event.duration, event.allDay, recurrenceTimeZone(event));
  return end?.getTime() === event.endDate.getTime() ? event.duration : undefined;
}

/**
 * Convert a CalendarEvent to an iCalendar VEVENT string.
 */
export function toVEvent(event: CalendarEvent): string {
  const tzid = event.allDay ? undefined : event.timezone;
  // Precedence: all-day > TZID > floating > explicit UTC. A floating source is written back
  // floating instead of being converted to a UTC instant.
  const floating = !event.allDay && !tzid && event.floating === true;
  const formatTimed = (d: Date): string =>
    tzid
      ? formatICalDateTimeLocal(d, tzid)
      : floating
        ? formatICalDateTimeFloating(d)
        : formatICalDate(d, event.allDay);

  // Keep the source DURATION while it still describes the event's length; otherwise write DTEND.
  const keepDuration = currentDuration(event) !== undefined;

  const vevent: VEvent = {
    uid: event.uid,
    // A DST-gap DTSTART is written with its intended wall clock, which the instant cannot recover.
    dtstart: validStartWallClock(event) ?? formatTimed(event.startDate),
    dtend: keepDuration ? undefined : formatTimed(event.endDate),
    duration: keepDuration ? event.duration : undefined,
    summary: event.title,
    description: event.description || undefined,
    location: event.location || undefined,
    rrule: event.recurrenceRule ?? undefined,
    exdate:
      event.exceptions.length > 0
        ? event.exceptions.map(formatTimed)
        : undefined,
    exdateParams:
      event.exceptions.length > 0 && tzid
        ? { TZID: tzid }
        : undefined,
    valarms: event.alarms.length > 0 ? event.alarms : undefined,
    categories: event.categories && event.categories.length > 0 ? event.categories : undefined,
    status: event.status,
    transp: event.transp,
    unknownProperties: event.unknownProperties,
    unknownComponents: event.unknownComponents,
    created: formatICalDateTime(event.created),
    lastModified: formatICalDateTime(event.updated),
  };

  if (event.allDay) {
    vevent.dtstartParams = { VALUE: 'DATE' };
    if (vevent.dtend) vevent.dtendParams = { VALUE: 'DATE' };
  } else if (tzid) {
    vevent.dtstartParams = { TZID: tzid };
    if (vevent.dtend) vevent.dtendParams = { TZID: tzid };
  }

  return generateVEvent(vevent);
}

/**
 * Parse an iCalendar VEVENT string into a CalendarEvent.
 */
export function fromVEvent(veventStr: string): CalendarEvent {
  const vevent = parseVEvent(veventStr);

  const isAllDay =
    vevent.dtstartParams?.['VALUE'] === 'DATE' || vevent.dtstart.length === 8;

  const startTzid = vevent.dtstartParams?.['TZID'];
  const endTzid = vevent.dtendParams?.['TZID'] ?? startTzid;
  const startParsed = parseICalDateValue(vevent.dtstart, startTzid);
  const startIsFloating = !isAllDay && isFloatingICalDateTime(vevent.dtstart, vevent.dtstartParams);
  const endFromDuration = !vevent.dtend && vevent.duration
    ? addICalDuration(
      startParsed.date,
      vevent.duration,
      isAllDay,
      recurrenceTimeZone({ allDay: isAllDay, timezone: startTzid, floating: startIsFloating || undefined }),
    )
    : null;
  const endParsed = vevent.dtend
    ? parseICalDateValue(vevent.dtend, endTzid)
    : { date: endFromDuration ?? new Date(startParsed.date.getTime()), allDay: startParsed.allDay };

  const exdateTzid = vevent.exdateParams?.['TZID'] ?? (isAllDay ? undefined : startTzid);
  const exceptions = (vevent.exdate ?? []).map(
    (d) => parseICalDateValue(d, exdateTzid).date,
  );

  // Captured from the wire value before parsing: a gap wall time cannot be recovered later.
  const startWallClock = isAllDay ? undefined : gapWallClock(startTzid, vevent.dtstart);

  const now = new Date();

  return {
    id: vevent.uid,
    uid: vevent.uid,
    title: vevent.summary ?? '',
    description: vevent.description ?? '',
    location: vevent.location ?? '',
    startDate: startParsed.date,
    endDate: endParsed.date,
    allDay: isAllDay,
    recurrenceRule: vevent.rrule ?? null,
    exceptions,
    alarms: vevent.valarms ?? [],
    // Preserve CATEGORIES for round-trip; default to [] for legacy records
    categories: vevent.categories ?? [],
    // Preserve the TZID from DTSTART so we can round-trip it correctly
    timezone: startTzid ?? undefined,
    ...(startIsFloating ? { floating: true as const } : {}),
    ...(startWallClock ? { startWallClock } : {}),
    ...(endFromDuration ? { duration: vevent.duration! } : {}),
    ...(vevent.status ? { status: vevent.status } : {}),
    ...(vevent.transp ? { transp: vevent.transp } : {}),
    ...(vevent.unknownProperties ? { unknownProperties: [...vevent.unknownProperties] } : {}),
    ...(vevent.unknownComponents
      ? { unknownComponents: vevent.unknownComponents.map((block) => [...block]) }
      : {}),
    created: vevent.created ? parseICalDateValue(vevent.created).date : now,
    updated: vevent.lastModified ? parseICalDateValue(vevent.lastModified).date : now,
  };
}

/**
 * End of the occurrence of `event` that starts at `start`: its source DURATION applied with
 * nominal days and weeks in the event's own zone while that DURATION still matches the event,
 * otherwise its fixed length.
 */
export function occurrenceEnd(
  event: Pick<CalendarEvent, 'allDay' | 'timezone' | 'floating' | 'duration' | 'startDate' | 'endDate'>,
  start: Date,
): Date {
  const duration = currentDuration(event);
  const nominal = duration !== undefined
    ? addICalDuration(start, duration, event.allDay, recurrenceTimeZone(event))
    : null;
  return nominal ?? new Date(start.getTime() + (event.endDate.getTime() - event.startDate.getTime()));
}

/**
 * Split an event's retained RDATE values at `cutoff`, for ending a series there. `before` is the
 * event's retained property lines without RDATE values at or after `cutoff`; `from` holds those
 * later RDATE lines. A value is compared as an instant, read with its own TZID, else the event's
 * zone for timed values, else host-local. Either is undefined when empty.
 */
export function splitRetainedRecurrenceDates(
  event: Pick<CalendarEvent, 'allDay' | 'timezone' | 'unknownProperties'>,
  cutoff: Date,
): { before?: string[]; from?: string[] } {
  const { rest, from } = partitionRetainedRDates(event.unknownProperties ?? [], (value, params) => {
    const isDate = (params['VALUE'] ?? '').toUpperCase() === 'DATE' || /^\d{8}$/.test(value);
    const tzid = params['TZID'] ?? (isDate || event.allDay ? undefined : event.timezone);
    return parseICalDateValue(value, tzid).date.getTime() >= cutoff.getTime();
  });
  return {
    ...(rest.length > 0 ? { before: rest } : {}),
    ...(from.length > 0 ? { from } : {}),
  };
}

/**
 * Build a VALARM trigger string from a number of minutes before the event.
 * E.g. 15 → '-PT15M', 60 → '-PT1H', 1440 → '-P1D'
 */
export function buildAlarmTrigger(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) return `-P${minutes / 1440}D`;
  if (minutes >= 60 && minutes % 60 === 0) return `-PT${minutes / 60}H`;
  return `-PT${minutes}M`;
}

/**
 * Parse a VALARM trigger string like '-PT15M', '-PT1H', '-P1D' into minutes.
 * Returns 0 if the trigger cannot be parsed.
 */
export function parseAlarmTriggerMinutes(trigger: string): number {
  if (trigger.startsWith('-P')) {
    const dayMatch = trigger.match(/-P(\d+)D/);
    if (dayMatch) return parseInt(dayMatch[1]!, 10) * 1440;

    const hourMatch = trigger.match(/-PT(\d+)H/);
    if (hourMatch) return parseInt(hourMatch[1]!, 10) * 60;

    const minMatch = trigger.match(/-PT(\d+)M/);
    if (minMatch) return parseInt(minMatch[1]!, 10);
  }
  return 0;
}

/**
 * Serialize a CalendarEvent to a string for Etebase item content.
 * Produces a complete VCALENDAR document (RFC 5545 compliant).
 */
export function serializeCalendarEvent(event: CalendarEvent): string {
  const vevent = toVEvent(event);
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SilentSuite//EN',
    vevent,
    'END:VCALENDAR',
  ].join('\r\n');
}

/**
 * Deserialize Etebase item content to a CalendarEvent.
 */
export function deserializeCalendarEvent(content: string): CalendarEvent {
  return fromVEvent(content);
}
