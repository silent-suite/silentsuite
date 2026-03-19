import { describe, it, expect } from 'vitest';
import {
  toVEvent,
  fromVEvent,
  serializeCalendarEvent,
  deserializeCalendarEvent,
} from './calendar-event.js';
import type { CalendarEvent } from './calendar-event.js';

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
  it('serialize produces a VEVENT string', () => {
    const event = makeFullEvent();
    const serialized = serializeCalendarEvent(event);

    expect(typeof serialized).toBe('string');
    expect(serialized).toContain('BEGIN:VEVENT');
    expect(serialized).toContain('END:VEVENT');
  });

  it('deserialize restores a CalendarEvent from VEVENT string', () => {
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
