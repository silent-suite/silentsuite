import { describe, it, expect } from 'vitest';
import {
  toVEvent,
  fromVEvent,
  serializeCalendarEvent,
  deserializeCalendarEvent,
  buildAlarmTrigger,
  parseAlarmTriggerMinutes,
  parseICalDateValue,
} from './calendar-event.js';
import type { CalendarEvent } from './calendar-event.js';
import { expandRecurrence } from '../utils/recurrence.js';

// ── Helpers ──

function makeFullEvent(overrides?: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: 'evt-001',
    uid: 'evt-001',
    title: 'Sprint Planning',
    description: 'Plan the next sprint',
    location: 'Room 42',
    startDate: new Date(2026, 2, 15, 10, 0, 0), // March 15, 2026 10:00
    endDate: new Date(2026, 2, 15, 11, 30, 0), // March 15, 2026 11:30
    allDay: false,
    recurrenceRule: null,
    exceptions: [],
    alarms: [],
    categories: ['Work', 'Planning'],
    created: new Date(2026, 0, 1, 0, 0, 0),
    updated: new Date(2026, 2, 10, 12, 0, 0),
    ...overrides,
  };
}

function makeMinimalEvent(): CalendarEvent {
  return {
    id: 'min-001',
    uid: 'min-001',
    title: 'Quick Sync',
    description: '',
    location: '',
    startDate: new Date(2026, 2, 15, 14, 0, 0),
    endDate: new Date(2026, 2, 15, 14, 30, 0),
    allDay: false,
    recurrenceRule: null,
    exceptions: [],
    alarms: [],
    created: new Date(2026, 2, 15, 0, 0, 0),
    updated: new Date(2026, 2, 15, 0, 0, 0),
  };
}

// ── categories roundtrip (#291) ──

describe('categories roundtrip (#291)', () => {
  it('roundtrips multiple comma-separated categories', () => {
    const original = makeFullEvent({ categories: ['Work', 'Planning', 'Q1'] });
    const ical = toVEvent(original);

    expect(ical).toContain('CATEGORIES:Work,Planning,Q1');

    const restored = fromVEvent(ical);
    expect(restored.categories).toEqual(['Work', 'Planning', 'Q1']);
  });

  it('roundtrips a category containing an escaped comma', () => {
    const original = makeFullEvent({ categories: ['Travel, Inc.', 'Personal'] });
    const ical = toVEvent(original);

    // Comma inside a value must be escaped as \,
    expect(ical).toContain('CATEGORIES:Travel\\, Inc.,Personal');

    const restored = fromVEvent(ical);
    expect(restored.categories).toEqual(['Travel, Inc.', 'Personal']);
  });

  it('defaults categories to [] when deserializing a legacy record lacking CATEGORIES', () => {
    const legacy = [
      'BEGIN:VEVENT',
      'UID:legacy-nocat',
      'DTSTART:20260315T100000',
      'DTEND:20260315T110000',
      'SUMMARY:Legacy Event',
      'END:VEVENT',
    ].join('\r\n');

    const restored = deserializeCalendarEvent(legacy);
    expect(restored.categories).toEqual([]);
  });

  it('omits the CATEGORIES line when categories is empty', () => {
    const event = makeFullEvent({ categories: [] });
    const ical = toVEvent(event);

    expect(ical).not.toContain('CATEGORIES');
    expect(fromVEvent(ical).categories).toEqual([]);
  });

  it('omits the CATEGORIES line when categories is undefined', () => {
    const event = makeFullEvent();
    delete event.categories;
    const ical = toVEvent(event);

    expect(ical).not.toContain('CATEGORIES');
    expect(fromVEvent(ical).categories).toEqual([]);
  });
});

// ── toVEvent / fromVEvent roundtrip ──

describe('toVEvent / fromVEvent roundtrip', () => {
  it('roundtrips a fully populated event', () => {
    const original = makeFullEvent();
    const ical = toVEvent(original);
    const restored = fromVEvent(ical);

    expect(restored.uid).toBe(original.uid);
    expect(restored.title).toBe(original.title);
    expect(restored.description).toBe(original.description);
    expect(restored.location).toBe(original.location);
    expect(restored.startDate.getTime()).toBe(original.startDate.getTime());
    expect(restored.endDate.getTime()).toBe(original.endDate.getTime());
    expect(restored.allDay).toBe(false);
    expect(restored.recurrenceRule).toBeNull();
    expect(restored.exceptions).toEqual([]);
  });

  it('roundtrips a minimal event (title + dates only)', () => {
    const original = makeMinimalEvent();
    const ical = toVEvent(original);
    const restored = fromVEvent(ical);

    expect(restored.uid).toBe(original.uid);
    expect(restored.title).toBe(original.title);
    expect(restored.startDate.getTime()).toBe(original.startDate.getTime());
    expect(restored.endDate.getTime()).toBe(original.endDate.getTime());
    expect(restored.allDay).toBe(false);
    // Empty strings become empty strings in roundtrip
    expect(restored.description).toBe('');
    expect(restored.location).toBe('');
  });

  it('preserves id and uid (both set from vevent UID)', () => {
    const original = makeFullEvent({ id: 'my-id', uid: 'my-id' });
    const ical = toVEvent(original);
    const restored = fromVEvent(ical);

    expect(restored.id).toBe('my-id');
    expect(restored.uid).toBe('my-id');
  });
});

// ── All-day event serialization ──

describe('all-day event serialization', () => {
  it('serializes an all-day event with VALUE=DATE params', () => {
    const event = makeFullEvent({
      allDay: true,
      startDate: new Date(2026, 2, 15), // March 15
      endDate: new Date(2026, 2, 16), // March 16
    });

    const ical = toVEvent(event);
    expect(ical).toContain('DTSTART;VALUE=DATE:20260315');
    expect(ical).toContain('DTEND;VALUE=DATE:20260316');
  });

  it('roundtrips an all-day event', () => {
    const original = makeFullEvent({
      allDay: true,
      startDate: new Date(2026, 2, 15),
      endDate: new Date(2026, 2, 16),
    });

    const ical = toVEvent(original);
    const restored = fromVEvent(ical);

    expect(restored.allDay).toBe(true);
    expect(restored.startDate.getFullYear()).toBe(2026);
    expect(restored.startDate.getMonth()).toBe(2);
    expect(restored.startDate.getDate()).toBe(15);
    expect(restored.endDate.getDate()).toBe(16);
  });

  it('detects all-day from 8-digit DTSTART without VALUE param', () => {
    const ical = [
      'BEGIN:VEVENT',
      'UID:allday-novalue',
      'DTSTART:20260315',
      'DTEND:20260316',
      'SUMMARY:All Day Event',
      'END:VEVENT',
    ].join('\r\n');

    const event = fromVEvent(ical);
    expect(event.allDay).toBe(true);
  });
});

// ── Recurring event with RRULE + EXDATE ──

describe('recurring event', () => {
  it('roundtrips an event with RRULE', () => {
    const original = makeFullEvent({
      recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=52',
    });

    const ical = toVEvent(original);
    const restored = fromVEvent(ical);

    expect(restored.recurrenceRule).toBe('FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=52');
  });

  it('roundtrips an event with RRULE + EXDATE', () => {
    const original = makeFullEvent({
      recurrenceRule: 'FREQ=DAILY;COUNT=10',
      exceptions: [
        new Date(2026, 2, 17, 10, 0, 0),
        new Date(2026, 2, 19, 10, 0, 0),
      ],
    });

    const ical = toVEvent(original);
    const restored = fromVEvent(ical);

    expect(restored.recurrenceRule).toBe('FREQ=DAILY;COUNT=10');
    expect(restored.exceptions).toHaveLength(2);
    expect(restored.exceptions[0]!.getDate()).toBe(17);
    expect(restored.exceptions[1]!.getDate()).toBe(19);
  });

  it('roundtrips timezone-aware EXDATE values so deleted occurrences stay removed after reload', () => {
    const original = makeFullEvent({
      startDate: new Date('2026-06-01T13:00:00.000Z'),
      endDate: new Date('2026-06-01T14:00:00.000Z'),
      timezone: 'America/New_York',
      recurrenceRule: 'FREQ=DAILY;COUNT=5',
      exceptions: [new Date('2026-06-03T13:00:00.000Z')],
    });

    const ical = toVEvent(original);
    expect(ical).toContain('DTSTART;TZID=America/New_York:20260601T090000');
    expect(ical).toContain('EXDATE;TZID=America/New_York:20260603T090000');

    const restored = fromVEvent(ical);
    expect(restored.timezone).toBe('America/New_York');
    expect(restored.exceptions[0]!.toISOString()).toBe('2026-06-03T13:00:00.000Z');

    const displayedStarts = expandRecurrence(
      restored.recurrenceRule!,
      restored.startDate,
      {
        start: new Date('2026-06-01T00:00:00.000Z'),
        end: new Date('2026-06-05T23:59:59.000Z'),
      },
      restored.exceptions,
    ).map((date) => date.toISOString());

    expect(displayedStarts).toEqual([
      '2026-06-01T13:00:00.000Z',
      '2026-06-02T13:00:00.000Z',
      '2026-06-04T13:00:00.000Z',
      '2026-06-05T13:00:00.000Z',
    ]);
  });

  it('roundtrips an all-day recurring event with EXDATE', () => {
    const original = makeFullEvent({
      allDay: true,
      startDate: new Date(2026, 2, 15),
      endDate: new Date(2026, 2, 16),
      recurrenceRule: 'FREQ=DAILY;COUNT=7',
      exceptions: [new Date(2026, 2, 17), new Date(2026, 2, 20)],
    });

    const ical = toVEvent(original);
    const restored = fromVEvent(ical);

    expect(restored.allDay).toBe(true);
    expect(restored.recurrenceRule).toBe('FREQ=DAILY;COUNT=7');
    expect(restored.exceptions).toHaveLength(2);
  });
});

// ── CalendarEvent with all fields populated ──

describe('alarm trigger helpers', () => {
  it('roundtrips custom minute offsets as simple negative-duration VALARMs', () => {
    expect(parseAlarmTriggerMinutes('-PT11M')).toBe(11);
    expect(buildAlarmTrigger(11)).toBe('-PT11M');
  });
});

// ── CalendarEvent with all fields populated ──

describe('CalendarEvent with all fields', () => {
  it('generates VEVENT containing all properties', () => {
    const event = makeFullEvent({
      title: 'Team Standup, Q1',
      description: 'Discuss blockers\nReview PRs',
      location: 'Room A; Floor 3',
      recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO',
      exceptions: [new Date(2026, 2, 22, 10, 0, 0)],
    });

    const ical = toVEvent(event);
    expect(ical).toContain('UID:evt-001');
    expect(ical).toContain('SUMMARY:Team Standup\\, Q1');
    expect(ical).toContain('DESCRIPTION:Discuss blockers\\nReview PRs');
    expect(ical).toContain('LOCATION:Room A\\; Floor 3');
    expect(ical).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO');
    expect(ical).toContain('EXDATE:');
    expect(ical).toContain('CREATED:');
    expect(ical).toContain('LAST-MODIFIED:');
  });
});

// ── CalendarEvent with minimal fields ──

describe('CalendarEvent with minimal fields', () => {
  it('generates a valid VEVENT with just title and dates', () => {
    const event = makeMinimalEvent();
    const ical = toVEvent(event);

    expect(ical).toContain('UID:min-001');
    expect(ical).toContain('SUMMARY:Quick Sync');
    expect(ical).toContain('DTSTART:');
    expect(ical).toContain('DTEND:');
    // Empty description/location should not appear
    expect(ical).not.toContain('DESCRIPTION:');
    expect(ical).not.toContain('LOCATION:');
    // No RRULE/EXDATE
    expect(ical).not.toContain('RRULE');
    expect(ical).not.toContain('EXDATE');
  });
});

// ── serializeCalendarEvent / deserializeCalendarEvent ──

describe('serializeForEtebase / deserializeFromEtebase', () => {
  it('serialize produces a VCALENDAR-wrapped VEVENT string', () => {
    const event = makeFullEvent();
    const serialized = serializeCalendarEvent(event);

    expect(typeof serialized).toBe('string');
    expect(serialized).toContain('BEGIN:VCALENDAR');
    expect(serialized).toContain('VERSION:2.0');
    expect(serialized).toContain('PRODID:-//SilentSuite//EN');
    expect(serialized).toContain('BEGIN:VEVENT');
    expect(serialized).toContain('END:VEVENT');
    expect(serialized).toContain('END:VCALENDAR');
  });

  it('deserialize restores a CalendarEvent from VCALENDAR-wrapped string', () => {
    const event = makeFullEvent();
    const serialized = serializeCalendarEvent(event);
    const restored = deserializeCalendarEvent(serialized);

    expect(restored.uid).toBe(event.uid);
    expect(restored.title).toBe(event.title);
    expect(restored.description).toBe(event.description);
    expect(restored.location).toBe(event.location);
  });

  it('roundtrips through serialize/deserialize', () => {
    const original = makeFullEvent({
      title: 'Roundtrip Test, Special; chars',
      description: 'Multi\nline\ndescription',
      recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=1',
      exceptions: [new Date(2026, 3, 1, 10, 0, 0)],
    });

    const serialized = serializeCalendarEvent(original);
    const restored = deserializeCalendarEvent(serialized);

    expect(restored.uid).toBe(original.uid);
    expect(restored.title).toBe(original.title);
    expect(restored.description).toBe(original.description);
    expect(restored.startDate.getTime()).toBe(original.startDate.getTime());
    expect(restored.endDate.getTime()).toBe(original.endDate.getTime());
    expect(restored.recurrenceRule).toBe(original.recurrenceRule);
    expect(restored.exceptions).toHaveLength(1);
  });

  // P1: backward compatibility — existing Etebase items stored as bare VEVENT
  it('deserialize handles legacy bare VEVENT (backward compatibility)', () => {
    const bareVEvent = [
      'BEGIN:VEVENT',
      'UID:legacy-001',
      'DTSTART:20260315T100000',
      'DTEND:20260315T110000',
      'SUMMARY:Legacy Event',
      'CREATED:20260101T000000',
      'LAST-MODIFIED:20260310T120000',
      'END:VEVENT',
    ].join('\r\n');

    const restored = deserializeCalendarEvent(bareVEvent);
    expect(restored.uid).toBe('legacy-001');
    expect(restored.title).toBe('Legacy Event');
    expect(restored.startDate.getHours()).toBe(10);
  });

  // P1: forward compatibility — new VCALENDAR-wrapped items
  it('deserialize handles VCALENDAR-wrapped VEVENT (forward compatibility)', () => {
    const wrapped = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//SilentSuite//EN',
      'BEGIN:VEVENT',
      'UID:wrapped-001',
      'DTSTART:20260315T100000',
      'DTEND:20260315T110000',
      'SUMMARY:Wrapped Event',
      'CREATED:20260101T000000',
      'LAST-MODIFIED:20260310T120000',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const restored = deserializeCalendarEvent(wrapped);
    expect(restored.uid).toBe('wrapped-001');
    expect(restored.title).toBe('Wrapped Event');
    expect(restored.startDate.getHours()).toBe(10);
  });
});

// ── Edge cases ──

describe('edge cases', () => {
  it('handles event with no description or location', () => {
    const event = makeFullEvent({ description: '', location: '' });
    const ical = toVEvent(event);
    const restored = fromVEvent(ical);

    expect(restored.description).toBe('');
    expect(restored.location).toBe('');
  });

  it('sets id equal to uid from VEVENT', () => {
    const ical = [
      'BEGIN:VEVENT',
      'UID:unique-id-123',
      'DTSTART:20260315T100000',
      'SUMMARY:Test',
      'END:VEVENT',
    ].join('\r\n');

    const event = fromVEvent(ical);
    expect(event.id).toBe('unique-id-123');
    expect(event.uid).toBe('unique-id-123');
  });

  it('defaults created/updated to current time when missing from VEVENT', () => {
    const before = Date.now();
    const ical = [
      'BEGIN:VEVENT',
      'UID:no-dates',
      'DTSTART:20260315T100000',
      'SUMMARY:No created',
      'END:VEVENT',
    ].join('\r\n');

    const event = fromVEvent(ical);
    const after = Date.now();

    expect(event.created.getTime()).toBeGreaterThanOrEqual(before);
    expect(event.created.getTime()).toBeLessThanOrEqual(after);
    expect(event.updated.getTime()).toBeGreaterThanOrEqual(before);
    expect(event.updated.getTime()).toBeLessThanOrEqual(after);
  });

  it('handles missing DTEND (defaults to DTSTART)', () => {
    const ical = [
      'BEGIN:VEVENT',
      'UID:no-end',
      'DTSTART:20260315T100000',
      'SUMMARY:No End',
      'END:VEVENT',
    ].join('\r\n');

    const event = fromVEvent(ical);
    expect(event.startDate.getTime()).toBe(event.endDate.getTime());
  });

  it('handles missing SUMMARY', () => {
    const ical = [
      'BEGIN:VEVENT',
      'UID:no-summary',
      'DTSTART:20260315T100000',
      'END:VEVENT',
    ].join('\r\n');

    const event = fromVEvent(ical);
    expect(event.title).toBe('Untitled');
  });
});

// ── DST / timezone conversion ──

describe('DST timezone conversion (two-pass offset)', () => {
  it('handles Europe/Berlin spring-forward DST edge case', () => {
    // 2026-03-29 is spring-forward in Europe/Berlin (CET→CEST, clocks jump 2:00→3:00)
    // Event at 02:30 local Berlin time → should be 01:30 UTC (CET = UTC+1 before transition)
    // Note: 02:30 is in the "gap" — Intl treats it as CEST (UTC+2), so 00:30 UTC
    const ical = [
      'BEGIN:VEVENT',
      'UID:dst-berlin',
      'DTSTART;TZID=Europe/Berlin:20260329T023000',
      'DTEND;TZID=Europe/Berlin:20260329T033000',
      'SUMMARY:DST Berlin',
      'END:VEVENT',
    ].join('\r\n');

    const event = fromVEvent(ical);
    // The key assertion: the two-pass approach should produce a stable result
    // that represents the intended local time converted to UTC.
    // 02:30 is in the gap; runtime resolves to CET (UTC+1) → 01:30 UTC
    expect(event.startDate.getUTCHours()).toBe(1);
    expect(event.startDate.getUTCMinutes()).toBe(30);
    expect(event.startDate.getUTCDate()).toBe(29);
  });

  it('handles America/New_York spring-forward DST edge case', () => {
    // 2026-03-08 is spring-forward in America/New_York (EST→EDT, clocks jump 2:00→3:00)
    // Event at 02:30 local → gap time. RFC 5545 §3.3.5 interprets a nonexistent local time with
    // the offset before the gap (EST, UTC-5) → 07:30 UTC, i.e. 03:30 EDT (the RFC's own
    // New York example). 06:30 UTC would be 01:30 EST, an hour before the intended time.
    const ical = [
      'BEGIN:VEVENT',
      'UID:dst-nyc',
      'DTSTART;TZID=America/New_York:20260308T023000',
      'DTEND;TZID=America/New_York:20260308T033000',
      'SUMMARY:DST NYC',
      'END:VEVENT',
    ].join('\r\n');

    const event = fromVEvent(ical);
    expect(event.startDate.getUTCHours()).toBe(7);
    expect(event.startDate.getUTCMinutes()).toBe(30);
    expect(event.startDate.getUTCDate()).toBe(8);
    expect(event.startDate.toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(event.startDate.toISOString()).not.toBe('2026-03-08T06:30:00.000Z');
  });

  it('converts normal time (no DST transition) correctly', () => {
    // 2026-06-15 14:00 Europe/Berlin → CEST (UTC+2) → 12:00 UTC
    const ical = [
      'BEGIN:VEVENT',
      'UID:no-dst',
      'DTSTART;TZID=Europe/Berlin:20260615T140000',
      'DTEND;TZID=Europe/Berlin:20260615T150000',
      'SUMMARY:Normal Time',
      'END:VEVENT',
    ].join('\r\n');

    const event = fromVEvent(ical);
    expect(event.startDate.getUTCHours()).toBe(12);
    expect(event.startDate.getUTCMinutes()).toBe(0);
    expect(event.startDate.getUTCDate()).toBe(15);
  });

  it('leaves UTC-suffixed dates unaffected by TZID logic', () => {
    // Z suffix means UTC — TZID should be ignored
    const ical = [
      'BEGIN:VEVENT',
      'UID:utc-event',
      'DTSTART:20260315T100000Z',
      'DTEND:20260315T110000Z',
      'SUMMARY:UTC Event',
      'END:VEVENT',
    ].join('\r\n');

    const event = fromVEvent(ical);
    expect(event.startDate.getUTCHours()).toBe(10);
    expect(event.startDate.getUTCMinutes()).toBe(0);
  });

  it('returns the same UTC instant regardless of runtime TZ for TZID values', () => {
    // Regression for #109: parseICalDateValue used `new Date(y, m, ...)` which
    // interprets in the runtime's local TZ, causing the parsed instant to drift
    // by the runtime's UTC offset whenever it wasn't UTC. Vitest defaults to
    // TZ=UTC so the bug was invisible — this test pins the expected absolute
    // UTC instant so any reintroduction of the local-time math will fail.
    const ical = [
      'BEGIN:VEVENT',
      'UID:tzid-stability',
      'DTSTART;TZID=Europe/Vienna:20250604T100000', // 10:00 Vienna in CEST = 08:00 UTC
      'DTEND;TZID=Europe/Vienna:20250604T110000',   // 11:00 Vienna in CEST = 09:00 UTC
      'SUMMARY:Vienna 10am',
      'END:VEVENT',
    ].join('\r\n');

    const event = fromVEvent(ical);
    expect(event.startDate.toISOString()).toBe('2025-06-04T08:00:00.000Z');
    expect(event.endDate.toISOString()).toBe('2025-06-04T09:00:00.000Z');
  });

  it('uses local time when no TZID is provided', () => {
    // No TZID and no Z → local time interpretation
    const ical = [
      'BEGIN:VEVENT',
      'UID:local-event',
      'DTSTART:20260315T100000',
      'DTEND:20260315T110000',
      'SUMMARY:Local Event',
      'END:VEVENT',
    ].join('\r\n');

    const event = fromVEvent(ical);
    // Should be interpreted as local time: hour/minute match face value
    expect(event.startDate.getHours()).toBe(10);
    expect(event.startDate.getMinutes()).toBe(0);
  });
});

// ── DTSTART kind preservation through toVEvent (#886) ──

function veventLines(...props: string[]): string {
  return ['BEGIN:VEVENT', 'UID:kind-fixture', 'SUMMARY:Synthetic', ...props, 'END:VEVENT'].join('\r\n');
}

describe('floating DTSTART identity survives serialization (#886)', () => {
  const floatingIcs = veventLines(
    'DTSTART:20260302T100000',
    'DTEND:20260302T110000',
    'RRULE:FREQ=WEEKLY;COUNT=3',
    'EXDATE:20260309T100000',
  );

  it('writes floating DTSTART, DTEND and EXDATE back as floating wall times (no Z)', () => {
    const lines = toVEvent(fromVEvent(floatingIcs)).split('\r\n');
    expect(lines).toContain('DTSTART:20260302T100000');
    expect(lines).toContain('DTEND:20260302T110000');
    expect(lines).toContain('EXDATE:20260309T100000');
    expect(lines.filter((l) => /^(DTSTART|DTEND|EXDATE)[:;].*Z$/.test(l))).toEqual([]);
  });

  it('control: reloading the written floating event keeps the same host-local instants', () => {
    const reloaded = fromVEvent(toVEvent(fromVEvent(floatingIcs)));
    expect(reloaded.startDate.getTime()).toBe(new Date(2026, 2, 2, 10, 0, 0).getTime());
    expect(reloaded.endDate.getTime()).toBe(new Date(2026, 2, 2, 11, 0, 0).getTime());
    expect(reloaded.exceptions.map((d) => d.getTime())).toEqual([new Date(2026, 2, 9, 10, 0, 0).getTime()]);
    expect(reloaded.timezone).toBeUndefined();
  });
});

describe('UTC, TZID and all-day DTSTART output stays unchanged (controls)', () => {
  it('explicit UTC stays Z', () => {
    const lines = toVEvent(fromVEvent(veventLines('DTSTART:20260223T180000Z', 'DTEND:20260223T190000Z', 'RRULE:FREQ=WEEKLY;COUNT=2'))).split('\r\n');
    expect(lines).toContain('DTSTART:20260223T180000Z');
    expect(lines).toContain('DTEND:20260223T190000Z');
  });

  it('TZID wall time and parameter are kept', () => {
    const lines = toVEvent(fromVEvent(veventLines(
      'DTSTART;TZID=America/Los_Angeles:20260302T100000',
      'DTEND;TZID=America/Los_Angeles:20260302T110000',
      'RRULE:FREQ=WEEKLY;COUNT=2',
      'EXDATE;TZID=America/Los_Angeles:20260309T100000',
    ))).split('\r\n');
    expect(lines).toContain('DTSTART;TZID=America/Los_Angeles:20260302T100000');
    expect(lines).toContain('DTEND;TZID=America/Los_Angeles:20260302T110000');
    expect(lines).toContain('EXDATE;TZID=America/Los_Angeles:20260309T100000');
  });

  it('all-day VALUE=DATE stays a date', () => {
    const lines = toVEvent(fromVEvent(veventLines('DTSTART;VALUE=DATE:20260302', 'DTEND;VALUE=DATE:20260303', 'RRULE:FREQ=WEEKLY;COUNT=2'))).split('\r\n');
    expect(lines).toContain('DTSTART;VALUE=DATE:20260302');
    expect(lines).toContain('DTEND;VALUE=DATE:20260303');
  });
});

// ── TZID wall times inside DST transitions (RFC 5545 §3.3.5 via §3.3.10, Verified Erratum 4271) ──
// A nonexistent wall time uses the offset before the gap; an ambiguous one is its first occurrence.

describe('parseICalDateValue resolves TZID wall times in DST gaps and overlaps per RFC 5545', () => {
  it('America/Los_Angeles gap 2026-03-08 02:30 -> 10:30Z (pre-gap -08)', () => {
    expect(parseICalDateValue('20260308T023000', 'America/Los_Angeles').date.toISOString()).toBe('2026-03-08T10:30:00.000Z');
  });

  it('Europe/Berlin overlap 2026-10-25 02:30 -> 00:30Z (first occurrence, +02)', () => {
    expect(parseICalDateValue('20261025T023000', 'Europe/Berlin').date.toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  it('Australia/Sydney overlap 2026-04-05 02:30 -> 15:30Z (first occurrence, +11)', () => {
    expect(parseICalDateValue('20260405T023000', 'Australia/Sydney').date.toISOString()).toBe('2026-04-04T15:30:00.000Z');
  });

  it('Australia/Lord_Howe overlap 2026-04-05 01:45 -> 14:45Z (first occurrence, +11)', () => {
    expect(parseICalDateValue('20260405T014500', 'Australia/Lord_Howe').date.toISOString()).toBe('2026-04-04T14:45:00.000Z');
  });

  it('control: America/Los_Angeles overlap 2026-11-01 01:30 -> 08:30Z', () => {
    expect(parseICalDateValue('20261101T013000', 'America/Los_Angeles').date.toISOString()).toBe('2026-11-01T08:30:00.000Z');
  });

  it('control: Europe/Berlin gap 2026-03-29 02:30 -> 01:30Z', () => {
    expect(parseICalDateValue('20260329T023000', 'Europe/Berlin').date.toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });

  it('control: Australia/Sydney gap 2026-10-04 02:30 -> 16:30Z', () => {
    expect(parseICalDateValue('20261004T023000', 'Australia/Sydney').date.toISOString()).toBe('2026-10-03T16:30:00.000Z');
  });

  it('control: Australia/Lord_Howe gap 2026-10-04 02:15 -> 15:45Z', () => {
    expect(parseICalDateValue('20261004T021500', 'Australia/Lord_Howe').date.toISOString()).toBe('2026-10-03T15:45:00.000Z');
  });
});
