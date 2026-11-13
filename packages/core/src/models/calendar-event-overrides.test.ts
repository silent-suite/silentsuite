// WEB-03 remainder: saving a series keeps its VTIMEZONE blocks and RECURRENCE-ID overrides.
import { describe, it, expect } from 'vitest';
import { deserializeCalendarEvent, serializeCalendarEvent, overridesBefore, overridesWithout } from './calendar-event.js';
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

describe('overrides when the series changes', () => {
  const source = item(VTIMEZONE, MASTER, OVERRIDE, OVERRIDE_27);
  const overrideIds = (ics: string) => blocksOf(ics, 'VEVENT').slice(1)
    .map((b) => b.find((l) => l.startsWith('RECURRENCE-ID'))!);
  const BOTH = [
    'RECURRENCE-ID;TZID=Europe/Vienna:20260720T100000',
    'RECURRENCE-ID;TZID=Europe/Vienna:20260727T100000',
  ];

  it.each([
    ['a start moved by an hour', (e: CalendarEvent) => ({
      ...e,
      startDate: new Date(e.startDate.getTime() + 3_600_000),
      endDate: new Date(e.endDate.getTime() + 3_600_000),
    })],
    ['a shorter COUNT', (e: CalendarEvent) => ({ ...e, recurrenceRule: 'FREQ=WEEKLY;COUNT=2' })],
    ['an edited EXDATE list', (e: CalendarEvent) => ({ ...e, exceptions: [new Date('2026-07-13T08:00:00Z')] })],
    ['a removed recurrence', (e: CalendarEvent) => ({ ...e, recurrenceRule: null })],
  ] as const)('%s keeps every override as it is', (_name, edit) => {
    const saved = save(source, edit);

    expect(blocksOf(saved, 'VEVENT').slice(1)).toEqual([OVERRIDE, OVERRIDE_27]);
    expect(blocksOf(saved, 'VTIMEZONE')).toEqual([VTIMEZONE]);
  });

  it('overridesWithout drops only the override of the removed occurrence', () => {
    const event = deserializeCalendarEvent(source);
    const saved = serializeCalendarEvent({
      ...event,
      exceptions: [new Date('2026-07-20T08:00:00Z')],
      ...overridesWithout(event, new Date('2026-07-20T08:00:00Z')),
    });

    expect(overrideIds(saved)).toEqual([BOTH[1]]);
  });

  it('overridesBefore keeps only overrides before the cut', () => {
    const event = deserializeCalendarEvent(source);
    expect(overridesBefore(event, new Date('2026-07-27T08:00:00Z'))).toEqual({ overrides: [OVERRIDE], overridesForm: 'tzid' });
    expect(overridesBefore(event, new Date('2026-07-20T08:00:00Z'))).toEqual({ overrides: undefined, overridesForm: undefined });
  });

  it('review repro: an EXDATE on a monthly BYDAY=1MO series keeps the other occurrence\'s override', () => {
    const master = [
      'BEGIN:VEVENT', 'UID:monthly-001',
      'DTSTART;TZID=Europe/Vienna:20260706T100000', 'DTEND;TZID=Europe/Vienna:20260706T110000',
      'RRULE:FREQ=MONTHLY;BYDAY=1MO;COUNT=5', 'SUMMARY:Monthly', 'END:VEVENT',
    ];
    const august = [
      'BEGIN:VEVENT', 'UID:monthly-001', 'RECURRENCE-ID;TZID=Europe/Vienna:20260803T100000',
      'DTSTART;TZID=Europe/Vienna:20260804T100000', 'DTEND;TZID=Europe/Vienna:20260804T110000',
      'SUMMARY:Monthly (Tuesday)', 'END:VEVENT',
    ];
    const event = deserializeCalendarEvent(item(master, august));
    const removed = new Date('2026-07-06T08:00:00Z');
    const saved = serializeCalendarEvent({
      ...event,
      exceptions: [removed],
      ...overridesWithout(event, removed),
    });

    expect(blocksOf(saved, 'VEVENT').slice(1)).toEqual([august]);
  });

  it('review repro: a quoted TZID is read as that zone', () => {
    const quoted = OVERRIDE.map((l) => (l.startsWith('RECURRENCE-ID') ? 'RECURRENCE-ID;TZID="Europe/Vienna":20260720T100000' : l));
    const event = deserializeCalendarEvent(item(MASTER, quoted));

    expect(overridesWithout(event, new Date('2026-07-13T08:00:00Z')).overrides).toEqual([quoted]);
    expect(overridesWithout(event, new Date('2026-07-20T08:00:00Z')).overrides).toBeUndefined();
    expect(blocksOf(save(item(MASTER, quoted), (e) => ({ ...e, exceptions: [new Date('2026-07-13T08:00:00Z')] })), 'VEVENT')[1]).toEqual(quoted);
  });

  it('review repro: a DST-gap wall clock change keeps the overrides as they are', () => {
    const gapMaster = [
      'BEGIN:VEVENT', 'UID:gap-001',
      'DTSTART;TZID=America/New_York:20260308T023000', 'DTEND;TZID=America/New_York:20260308T033000',
      'RRULE:FREQ=WEEKLY;COUNT=4', 'SUMMARY:Gap', 'END:VEVENT',
    ];
    const gapOverride = [
      'BEGIN:VEVENT', 'UID:gap-001', 'RECURRENCE-ID;TZID=America/New_York:20260315T023000',
      'DTSTART;TZID=America/New_York:20260315T050000', 'SUMMARY:Gap moved', 'END:VEVENT',
    ];
    const saved = save(item(gapMaster, gapOverride), (e) => ({ ...e, startWallClock: undefined }));

    expect(blocksOf(saved, 'VEVENT')[1]).toEqual(gapOverride);
  });

  it('review repro: a timed series made all-day drops its DATE-TIME overrides', () => {
    const saved = save(source, (e) => ({ ...e, allDay: true, timezone: undefined }));

    expect(linesOf(saved)).toContain('DTSTART;VALUE=DATE:20260706');
    expect(overrideIds(saved)).toEqual([]);
  });

  it('an all-day series made timed drops its DATE overrides', () => {
    const master = [
      'BEGIN:VEVENT', 'UID:day-001', 'DTSTART;VALUE=DATE:20260706', 'DTEND;VALUE=DATE:20260707',
      'RRULE:FREQ=DAILY;COUNT=5', 'SUMMARY:Daily', 'END:VEVENT',
    ];
    const dayOverride = [
      'BEGIN:VEVENT', 'UID:day-001', 'RECURRENCE-ID;VALUE=DATE:20260707',
      'DTSTART;VALUE=DATE:20260708', 'SUMMARY:Moved day', 'END:VEVENT',
    ];
    const saved = save(item(master, dayOverride), (e) => ({ ...e, allDay: false, timezone: 'Europe/Vienna' }));

    expect(blocksOf(saved, 'VEVENT')).toHaveLength(1);
  });

  it('control: an all-day series keeps its DATE override on a title edit', () => {
    const master = [
      'BEGIN:VEVENT', 'UID:day-001', 'DTSTART;VALUE=DATE:20260706', 'DTEND;VALUE=DATE:20260707',
      'RRULE:FREQ=DAILY;COUNT=5', 'SUMMARY:Daily', 'END:VEVENT',
    ];
    const dayOverride = [
      'BEGIN:VEVENT', 'UID:day-001', 'RECURRENCE-ID;VALUE=DATE:20260707',
      'DTSTART;VALUE=DATE:20260708', 'SUMMARY:Moved day', 'END:VEVENT',
    ];
    const saved = save(item(master, dayOverride), (e) => ({ ...e, title: 'Renamed' }));

    expect(blocksOf(saved, 'VEVENT')[1]).toEqual(dayOverride);
  });

  it('review repro: a UTC series made floating rewrites the RECURRENCE-ID as floating', () => {
    const utcMaster = [
      'BEGIN:VEVENT', 'UID:utc-001', 'DTSTART:20260706T080000Z', 'DTEND:20260706T090000Z',
      'RRULE:FREQ=WEEKLY;COUNT=4', 'SUMMARY:UTC', 'END:VEVENT',
    ];
    const utcOverride = [
      'BEGIN:VEVENT', 'UID:utc-001', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20260720T080000Z',
      'DTSTART:20260720T120000Z', 'SUMMARY:UTC moved', 'END:VEVENT',
    ];
    const saved = save(item(utcMaster, utcOverride), (e) => ({ ...e, floating: true }));
    const local = new Date('2026-07-20T08:00:00Z');
    const pad = (n: number) => String(n).padStart(2, '0');
    const wall = `${local.getFullYear()}${pad(local.getMonth() + 1)}${pad(local.getDate())}T${pad(local.getHours())}${pad(local.getMinutes())}00`;

    expect(blocksOf(saved, 'VEVENT')[1]).toEqual(utcOverride.map((l) => (
      l.startsWith('RECURRENCE-ID') ? `RECURRENCE-ID;RANGE=THISANDFUTURE:${wall}` : l
    )));
  });

  it('a UTC series given a zone rewrites the RECURRENCE-ID in that zone', () => {
    const utcMaster = [
      'BEGIN:VEVENT', 'UID:utc-001', 'DTSTART:20260706T080000Z', 'DTEND:20260706T090000Z',
      'RRULE:FREQ=WEEKLY;COUNT=4', 'SUMMARY:UTC', 'END:VEVENT',
    ];
    const utcOverride = [
      'BEGIN:VEVENT', 'UID:utc-001', 'RECURRENCE-ID:20260720T080000Z',
      'DTSTART:20260720T120000Z', 'SUMMARY:UTC moved', 'END:VEVENT',
    ];
    const saved = save(item(utcMaster, utcOverride), (e) => ({ ...e, timezone: 'Europe/Vienna' }));

    expect(blocksOf(saved, 'VEVENT')[1]![2]).toBe('RECURRENCE-ID;TZID=Europe/Vienna:20260720T100000');
  });
});
