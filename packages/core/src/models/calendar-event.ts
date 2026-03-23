import { parseVEvent, generateVEvent } from '../utils/ical-parser.js';
import type { VEvent, VAlarm } from '../utils/ical-parser.js';

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
  calendarId?: string;
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

function formatICalDateTime(date: Date): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}${mo}${d}T${h}${mi}${s}`;
}

function parseICalDateValue(value: string, tzid?: string): { date: Date; allDay: boolean } {
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

  // If a TZID is specified and differs from local timezone, convert via
  // Intl.DateTimeFormat so the displayed time matches the original timezone.
  if (tzid) {
    try {
      // Build a UTC date from the face-value components, then compute the
      // offset for that instant in the given timezone so we can shift it.
      const utcGuess = Date.UTC(year, month, day, hour, minute, second);
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tzid,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
      });
      // Find the offset between the tzid timezone and UTC for this instant
      const parts = formatter.formatToParts(new Date(utcGuess));
      const p = (type: string) => parseInt(parts.find((x) => x.type === type)?.value ?? '0', 10);
      const tzDate = new Date(p('year'), p('month') - 1, p('day'), p('hour'), p('minute'), p('second'));
      const offsetMs = tzDate.getTime() - utcGuess;
      // The actual UTC instant is: face-value components treated as tzid local time
      // So actual UTC = utcGuess - offsetMs
      return { date: new Date(utcGuess - offsetMs), allDay: false };
    } catch {
      // Invalid TZID — fall through to local time interpretation
    }
  }

  return { date: new Date(year, month, day, hour, minute, second), allDay: false };
}

/**
 * Convert a CalendarEvent to an iCalendar VEVENT string.
 */
export function toVEvent(event: CalendarEvent): string {
  const vevent: VEvent = {
    uid: event.uid,
    dtstart: formatICalDate(event.startDate, event.allDay),
    dtend: formatICalDate(event.endDate, event.allDay),
    summary: event.title,
    description: event.description || undefined,
    location: event.location || undefined,
    rrule: event.recurrenceRule ?? undefined,
    exdate:
      event.exceptions.length > 0
        ? event.exceptions.map((d) => formatICalDate(d, event.allDay))
        : undefined,
    valarms: event.alarms.length > 0 ? event.alarms : undefined,
    created: formatICalDateTime(event.created),
    lastModified: formatICalDateTime(event.updated),
  };

  if (event.allDay) {
    vevent.dtstartParams = { VALUE: 'DATE' };
    vevent.dtendParams = { VALUE: 'DATE' };
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

  const exceptions = (vevent.exdate ?? []).map(
    (d) => parseICalDateValue(d).date,
  );

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
 */
export function serializeCalendarEvent(event: CalendarEvent): string {
  return toVEvent(event);
}

/**
 * Deserialize Etebase item content to a CalendarEvent.
 */
export function deserializeCalendarEvent(content: string): CalendarEvent {
  return fromVEvent(content);
}
