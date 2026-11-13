// WEB-03 remainder: saving a series keeps its VTIMEZONE blocks and RECURRENCE-ID overrides.
import { describe, it, expect } from 'vitest';
import { deserializeCalendarEvent, serializeCalendarEvent } from './calendar-event.js';
import type { CalendarEvent } from './calendar-event.js';

const CRLF = '\r\n';

const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Vienna',
  'BEGIN:STANDARD',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
];

const MASTER = [
  'BEGIN:VEVENT',
  'UID:series-001',
  'DTSTART;TZID=Europe/Vienna:20260706T100000',
  'DTEND;TZID=Europe/Vienna:20260706T110000',
  'RRULE:FREQ=WEEKLY;COUNT=4',
  'SUMMARY:Planning',
  'END:VEVENT',
];

/** The 20 July occurrence moved to 14:00 with its own title and an alarm. */
const OVERRIDE = [
  'BEGIN:VEVENT',
  'UID:series-001',
  'RECURRENCE-ID;TZID=Europe/Vienna:20260720T100000',
  'DTSTART;TZID=Europe/Vienna:20260720T140000',
  'DTEND;TZID=Europe/Vienna:20260720T150000',
  'SUMMARY:Planning (moved)',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'TRIGGER:-PT5M',
  'DESCRIPTION:Moved',
  'END:VALARM',
  'END:VEVENT',
];

/** The 27 July occurrence with only a new location. */
const OVERRIDE_27 = [
  'BEGIN:VEVENT',
  'UID:series-001',
  'RECURRENCE-ID;TZID=Europe/Vienna:20260727T100000',
  'DTSTART;TZID=Europe/Vienna:20260727T100000',
  'DTEND;TZID=Europe/Vienna:20260727T110000',
  'SUMMARY:Planning',
  'LOCATION:Room 2',
  'END:VEVENT',
];

function item(...blocks: string[][]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Other Client//EN', ...blocks.flat(), 'END:VCALENDAR'].join(CRLF);
}

/** Logical lines of the saved item (unfolded). */
function linesOf(ics: string): string[] {
  return ics.replace(/\r\n[ \t]/g, '').split(CRLF);
}

/** The saved item's top-level blocks named `name`. */
function blocksOf(ics: string, name: string): string[][] {
  const lines = linesOf(ics);
  const blocks: string[][] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== `BEGIN:${name}`) continue;
    const end = lines.indexOf(`END:${name}`, i);
    blocks.push(lines.slice(i, end + 1));
    i = end;
  }
  return blocks;
}

function save(source: string, edit: (event: CalendarEvent) => CalendarEvent): string {
  return serializeCalendarEvent(edit(deserializeCalendarEvent(source)));
}

describe('a series keeps its VTIMEZONE and overrides on save', () => {
  it('a title edit writes the VTIMEZONE and the override back unchanged', () => {
    const saved = save(item(VTIMEZONE, MASTER, OVERRIDE), (e) => ({ ...e, title: 'Renamed' }));

    expect(blocksOf(saved, 'VTIMEZONE')).toEqual([VTIMEZONE]);
    const events = blocksOf(saved, 'VEVENT');
    expect(events).toHaveLength(2);
    expect(events[0]).toContain('SUMMARY:Renamed');
    expect(events[0]!.some((l) => l.startsWith('RECURRENCE-ID'))).toBe(false);
    expect(events[1]).toEqual(OVERRIDE);
  });

  it('reads the series, not the override, when the override comes first', () => {
    const event = deserializeCalendarEvent(item(OVERRIDE, VTIMEZONE, MASTER));

    expect(event.title).toBe('Planning');
    expect(event.recurrenceRule).toBe('FREQ=WEEKLY;COUNT=4');
    const events = blocksOf(serializeCalendarEvent(event), 'VEVENT');
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual(OVERRIDE);
  });

  it('a description, location or end-time edit keeps every override', () => {
    const source = item(MASTER, OVERRIDE, OVERRIDE_27);
    for (const edit of [
      (e: CalendarEvent) => ({ ...e, description: 'Agenda' }),
      (e: CalendarEvent) => ({ ...e, location: 'Room 1' }),
      (e: CalendarEvent) => ({ ...e, endDate: new Date(e.endDate.getTime() + 30 * 60_000) }),
    ]) {
      expect(blocksOf(save(source, edit), 'VEVENT').slice(1)).toEqual([OVERRIDE, OVERRIDE_27]);
    }
  });

  it('a long override line is folded again on write and reads back the same', () => {
    const long = OVERRIDE.map((l) => (l.startsWith('SUMMARY:') ? `SUMMARY:${'x'.repeat(120)}` : l));
    const saved = save(item(MASTER, long), (e) => ({ ...e, title: 'Renamed' }));

    expect(saved.split(CRLF).every((l) => Buffer.byteLength(l, 'utf8') <= 75)).toBe(true);
    expect(blocksOf(saved, 'VEVENT')[1]).toEqual(long);
  });

  it('control: an item without VTIMEZONE or overrides serializes as before', () => {
    const saved = save(item(MASTER), (e) => ({ ...e, title: 'Renamed' }));

    expect(blocksOf(saved, 'VTIMEZONE')).toEqual([]);
    expect(blocksOf(saved, 'VEVENT')).toHaveLength(1);
  });

  it('does not keep VEVENTs of another UID or same-UID VEVENTs without RECURRENCE-ID', () => {
    const other = MASTER.map((l) => (l === 'UID:series-001' ? 'UID:other-uid' : l));
    const otherOverride = OVERRIDE.map((l) => (l === 'UID:series-001' ? 'UID:other-uid' : l));
    const duplicate = MASTER.map((l) => (l === 'SUMMARY:Planning' ? 'SUMMARY:Duplicate' : l));
    const saved = save(item(MASTER, other, otherOverride, duplicate), (e) => e);

    expect(blocksOf(saved, 'VEVENT')).toHaveLength(1);
  });

  it('does not keep a malformed override', () => {
    const injected = [...OVERRIDE.slice(0, -1), 'BEGIN:VTODO', 'UID:x', 'END:VTODO', 'END:VEVENT'];
    const saved = save(item(MASTER, injected), (e) => e);

    expect(blocksOf(saved, 'VEVENT')).toHaveLength(1);
    expect(saved).not.toContain('VTODO');
  });
});

describe('overrides when the series recurrence changes', () => {
  const source = item(VTIMEZONE, MASTER, OVERRIDE, OVERRIDE_27);
  const overrideIds = (ics: string) => blocksOf(ics, 'VEVENT').slice(1)
    .map((b) => b.find((l) => l.startsWith('RECURRENCE-ID'))!);

  it('a series start moved to another time drops overrides that no longer name an occurrence', () => {
    const saved = save(source, (e) => ({
      ...e,
      startDate: new Date(e.startDate.getTime() + 3_600_000),
      endDate: new Date(e.endDate.getTime() + 3_600_000),
    }));

    expect(overrideIds(saved)).toEqual([]);
    expect(blocksOf(saved, 'VTIMEZONE')).toEqual([VTIMEZONE]);
  });

  it('a series start moved by whole weeks keeps overrides that still name an occurrence', () => {
    const week = 7 * 86_400_000;
    const saved = save(source, (e) => ({
      ...e,
      startDate: new Date(e.startDate.getTime() + week),
      endDate: new Date(e.endDate.getTime() + week),
    }));

    expect(overrideIds(saved)).toEqual([
      'RECURRENCE-ID;TZID=Europe/Vienna:20260720T100000',
      'RECURRENCE-ID;TZID=Europe/Vienna:20260727T100000',
    ]);
  });

  it('a shorter COUNT drops overrides after the new end and keeps the ones before it', () => {
    const saved = save(source, (e) => ({ ...e, recurrenceRule: 'FREQ=WEEKLY;COUNT=3' }));

    expect(overrideIds(saved)).toEqual(['RECURRENCE-ID;TZID=Europe/Vienna:20260720T100000']);
  });

  it('an UNTIL that ends the series before an override drops it (a "this and future" split)', () => {
    const saved = save(source, (e) => ({ ...e, recurrenceRule: 'FREQ=WEEKLY;UNTIL=20260726T235959Z' }));

    expect(overrideIds(saved)).toEqual(['RECURRENCE-ID;TZID=Europe/Vienna:20260720T100000']);
  });

  it('an EXDATE on an overridden occurrence drops that override (a deleted occurrence)', () => {
    const saved = save(source, (e) => ({ ...e, exceptions: [new Date('2026-07-20T08:00:00Z')] }));

    expect(overrideIds(saved)).toEqual(['RECURRENCE-ID;TZID=Europe/Vienna:20260727T100000']);
  });

  it('removing the recurrence drops every override', () => {
    const saved = save(source, (e) => ({ ...e, recurrenceRule: null }));

    expect(overrideIds(saved)).toEqual([]);
  });

  it('control: an override that names no occurrence in the source is kept while the recurrence is unchanged', () => {
    const stray = OVERRIDE.map((l) => (l.startsWith('RECURRENCE-ID') ? 'RECURRENCE-ID;TZID=Europe/Vienna:20260721T100000' : l));
    const saved = save(item(MASTER, stray), (e) => ({ ...e, title: 'Renamed' }));

    expect(blocksOf(saved, 'VEVENT')[1]).toEqual(stray);
  });

  it('a UTC RECURRENCE-ID is matched as an instant', () => {
    const utc = OVERRIDE.map((l) => (l.startsWith('RECURRENCE-ID') ? 'RECURRENCE-ID:20260720T080000Z' : l));
    const saved = save(item(MASTER, utc), (e) => ({ ...e, recurrenceRule: 'FREQ=WEEKLY;COUNT=5' }));

    expect(blocksOf(saved, 'VEVENT')[1]).toEqual(utc);
  });

  it('an all-day series keeps a DATE override on an occurrence and drops one past the end', () => {
    const allDay = (rid: string) => [
      'BEGIN:VEVENT', 'UID:day-001', `RECURRENCE-ID;VALUE=DATE:${rid}`,
      `DTSTART;VALUE=DATE:${rid}`, 'SUMMARY:Changed day', 'END:VEVENT',
    ];
    const master = [
      'BEGIN:VEVENT', 'UID:day-001', 'DTSTART;VALUE=DATE:20260706', 'DTEND;VALUE=DATE:20260707',
      'RRULE:FREQ=DAILY;COUNT=5', 'SUMMARY:Daily', 'END:VEVENT',
    ];
    const saved = save(item(master, allDay('20260707'), allDay('20260710')), (e) => ({ ...e, recurrenceRule: 'FREQ=DAILY;COUNT=3' }));

    expect(blocksOf(saved, 'VEVENT').slice(1)).toEqual([allDay('20260707')]);
  });
});
