import { parseVEvent, generateVEvent } from '../utils/ical-parser.js';
import type { VEvent, VAlarm } from '../utils/ical-parser.js';
import { wallTimeToInstant } from '../utils/zoned-time.js';
import { expandRecurrence } from '../utils/recurrence.js';
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
 * Expand a recurring event's occurrences within `range`, in the event's own anchor zone,
 * excluding its EXDATEs. Returns [] for an event without a recurrence rule.
 */
export function expandEventRecurrence(event: CalendarEvent, range: DateRange): Date[] {
  if (!event.recurrenceRule) return [];
  return expandRecurrence(event.recurrenceRule, event.startDate, range, event.exceptions, {
    timeZone: recurrenceTimeZone(event),
  });
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

  const vevent: VEvent = {
    uid: event.uid,
    dtstart: formatTimed(event.startDate),
    dtend: formatTimed(event.endDate),
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
    created: formatICalDateTime(event.created),
    lastModified: formatICalDateTime(event.updated),
  };

  if (event.allDay) {
    vevent.dtstartParams = { VALUE: 'DATE' };
    vevent.dtendParams = { VALUE: 'DATE' };
  } else if (tzid) {
    vevent.dtstartParams = { TZID: tzid };
    vevent.dtendParams = { TZID: tzid };
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
  const endParsed = vevent.dtend
    ? parseICalDateValue(vevent.dtend, endTzid)
    : { date: new Date(startParsed.date.getTime()), allDay: startParsed.allDay };

  const exdateTzid = vevent.exdateParams?.['TZID'] ?? (isAllDay ? undefined : startTzid);
  const exceptions = (vevent.exdate ?? []).map(
    (d) => parseICalDateValue(d, exdateTzid).date,
  );

  const startIsFloating = !isAllDay && isFloatingICalDateTime(vevent.dtstart, vevent.dtstartParams);

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
    created: vevent.created ? parseICalDateValue(vevent.created).date : now,
    updated: vevent.lastModified ? parseICalDateValue(vevent.lastModified).date : now,
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
