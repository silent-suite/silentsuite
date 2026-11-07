import { describe, it, expect } from 'vitest';
import {
  fromVEvent,
  toVEvent,
  expandEventRecurrence,
  parseICalDateValue,
} from './calendar-event.js';
import type { CalendarEvent } from './calendar-event.js';
import { expandRecurrence } from '../utils/recurrence.js';
import type { DateRange } from './types.js';

// #886 F1: a recurring TZID DTSTART whose own wall time falls in a DST gap. The first instance
// resolves with the pre-gap offset; later instances must repeat the ORIGINAL wall clock (not the
// normalized post-gap clock), EXDATEs at that clock must still match, and an unchanged save must
// write the original DTSTART back. Expectations are exact UTC instants (host-independent).

type ExpandWithOptions = (
  rrule: string,
  dtstart: Date,
  range: DateRange,
  exdates?: Date[],
  options?: { timeZone?: string; startWallClock?: string },
) => Date[];
const expandWithOptions = expandRecurrence as unknown as ExpandWithOptions;

const LA = 'America/Los_Angeles';
const NUUK = 'America/Nuuk';
const MARCH_2026: DateRange = { start: new Date('2026-03-01T00:00:00.000Z'), end: new Date('2026-04-01T00:00:00.000Z') };

function vevent(...props: string[]): string {
  return ['BEGIN:VEVENT', 'UID:gap-anchor', 'SUMMARY:Synthetic gap series', ...props, 'END:VEVENT'].join('\r\n');
}

const G = vevent(
  'DTSTART;TZID=America/Los_Angeles:20260308T023000',
  'DTEND;TZID=America/Los_Angeles:20260308T043000',
  'RRULE:FREQ=WEEKLY;COUNT=3',
);
const G_EXDATE = vevent(
  'DTSTART;TZID=America/Los_Angeles:20260308T023000',
  'DTEND;TZID=America/Los_Angeles:20260308T043000',
  'RRULE:FREQ=WEEKLY;COUNT=3',
  'EXDATE;TZID=America/Los_Angeles:20260315T023000',
);
const GS = vevent(
  'DTSTART;TZID=America/Los_Angeles:20260308T023045',
  'DTEND;TZID=America/Los_Angeles:20260308T043045',
  'RRULE:FREQ=WEEKLY;COUNT=3',
);
const N = vevent(
  'DTSTART;TZID=America/Nuuk:20260328T233000',
  'DTEND;TZID=America/Nuuk:20260329T003000',
  'RRULE:FREQ=WEEKLY;COUNT=60',
);

const iso = (dates: Date[]) => dates.map((d) => d.toISOString());
const dtstartLine = (ics: string) => ics.split('\r\n').find((l) => l.startsWith('DTSTART'));

describe('F1 gap-start DTSTART keeps its original wall clock (#886)', () => {
  it('row 1: later instances return to 02:30 after a gap-start first instance', () => {
    const event = fromVEvent(G);
    expect(event.startDate.toISOString()).toBe('2026-03-08T10:30:00.000Z'); // control: first instant
    expect(iso(expandEventRecurrence(event, MARCH_2026))).toEqual([
      '2026-03-08T10:30:00.000Z',
      '2026-03-15T09:30:00.000Z',
      '2026-03-22T09:30:00.000Z',
    ]);
  });

  it('row 2: an ordinary-time EXDATE at the original clock still removes its occurrence', () => {
    const event = fromVEvent(G_EXDATE);
    expect(iso(event.exceptions)).toEqual(['2026-03-15T09:30:00.000Z']); // control: parsed EXDATE
    const out = expandEventRecurrence(event, MARCH_2026);
    expect(out).toHaveLength(2);
    expect(iso(out)).toEqual(['2026-03-08T10:30:00.000Z', '2026-03-22T09:30:00.000Z']);
  });

  it('row 3: a title-only save writes the original DTSTART and reloads to the same series', () => {
    const event = fromVEvent(G);
    const ics = toVEvent({ ...event, title: 'Renamed' });
    expect(dtstartLine(ics)).toBe('DTSTART;TZID=America/Los_Angeles:20260308T023000');
    expect(iso(expandEventRecurrence(fromVEvent(ics), MARCH_2026))).toEqual([
      '2026-03-08T10:30:00.000Z',
      '2026-03-15T09:30:00.000Z',
      '2026-03-22T09:30:00.000Z',
    ]);
  });

  it('row 4: the engine option seeds the civil DTSTART from the supplied wall clock', () => {
    const event = fromVEvent(G);
    const out = expandWithOptions(event.recurrenceRule!, event.startDate, MARCH_2026, [], {
      timeZone: LA,
      startWallClock: '20260308T023000',
    });
    expect(iso(out)).toEqual(['2026-03-08T10:30:00.000Z', '2026-03-15T09:30:00.000Z', '2026-03-22T09:30:00.000Z']);
  });

  it('row 5: a gap DTSTART with seconds keeps them through save, reload and expansion', () => {
    const event = fromVEvent(GS);
    expect(event.startDate.toISOString()).toBe('2026-03-08T10:30:45.000Z'); // control
    const ics = toVEvent(event);
    expect(dtstartLine(ics)).toBe('DTSTART;TZID=America/Los_Angeles:20260308T023045');
    expect(iso(expandEventRecurrence(fromVEvent(ics), MARCH_2026))).toEqual([
      '2026-03-08T10:30:45.000Z',
      '2026-03-15T09:30:45.000Z',
      '2026-03-22T09:30:45.000Z',
    ]);
  });

  it('row N1: a Nuuk gap that crosses midnight keeps 23:30 for later instances', () => {
    const event = fromVEvent(N);
    expect(event.startDate.toISOString()).toBe('2026-03-29T01:30:00.000Z'); // control
    const out = expandEventRecurrence(event, { start: new Date('2026-03-28T00:00:00.000Z'), end: new Date('2026-04-06T00:00:00.000Z') });
    expect(iso(out)).toEqual([
      '2026-03-29T01:30:00.000Z',
      parseICalDateValue('20260404T233000', NUUK).date.toISOString(),
    ]);
  });

  it('row N2: the engine option keeps the Nuuk 23:30 clock across the next year gap', () => {
    const event = fromVEvent(N);
    const out = expandWithOptions(event.recurrenceRule!, event.startDate,
      { start: new Date('2027-03-20T00:00:00.000Z'), end: new Date('2027-04-10T00:00:00.000Z') }, [],
      { timeZone: NUUK, startWallClock: '20260328T233000' });
    expect(iso(out)).toEqual([
      parseICalDateValue('20270320T233000', NUUK).date.toISOString(),
      '2027-03-28T01:30:00.000Z',
      '2027-04-04T00:30:00.000Z',
    ]);
  });
});

describe('F1 guards and precedence controls (#886)', () => {
  it('row 6a: the engine ignores a wall clock that does not resolve to DTSTART', () => {
    const start = parseICalDateValue('20260309T100000', LA).date;
    const out = expandWithOptions('FREQ=WEEKLY;COUNT=2', start, MARCH_2026, [], {
      timeZone: LA,
      startWallClock: '20260308T023000',
    });
    expect(iso(out)).toEqual(['2026-03-09T17:00:00.000Z', '2026-03-16T17:00:00.000Z']);
  });

  it('row 6b: an unknown zone falls back to host-local expansion and ignores the wall clock', () => {
    const start = new Date(2026, 2, 2, 10, 0, 0);
    const out = expandWithOptions('FREQ=WEEKLY;COUNT=2', start, MARCH_2026, [], {
      timeZone: 'Mars/Olympus_Mons',
      startWallClock: '20260302T023000',
    });
    expect(out.map((d) => d.getTime())).toEqual([new Date(2026, 2, 2, 10).getTime(), new Date(2026, 2, 9, 10).getTime()]);
  });

  it('row 6c: an all-day event never writes a stale wall clock', () => {
    const event: CalendarEvent = {
      ...fromVEvent(vevent('DTSTART;VALUE=DATE:20260308', 'DTEND;VALUE=DATE:20260309')),
      startWallClock: '20260308T023000',
    } as CalendarEvent;
    expect(dtstartLine(toVEvent(event))).toBe('DTSTART;VALUE=DATE:20260308');
  });

  it('row 6d: a non-equivalent zone change derives DTSTART from the instant in the new zone', () => {
    const event = { ...fromVEvent(G), timezone: 'Europe/Berlin', startWallClock: '20260308T023000' } as CalendarEvent;
    expect(dtstartLine(toVEvent(event))).toBe('DTSTART;TZID=Europe/Berlin:20260308T113000');
  });

  it('row 6e: a moved start derives DTSTART from the new instant', () => {
    const moved = { ...fromVEvent(G), startDate: new Date('2026-03-09T17:00:00.000Z'), startWallClock: '20260308T023000' } as CalendarEvent;
    expect(dtstartLine(toVEvent(moved))).toBe('DTSTART;TZID=America/Los_Angeles:20260309T100000');
  });

  it('row 7: ordinary TZID, UTC, floating and DATE events carry no wall-clock field and serialize as before', () => {
    const cases: Array<[string, string]> = [
      [vevent('DTSTART;TZID=America/Los_Angeles:20260302T100000', 'DTEND;TZID=America/Los_Angeles:20260302T110000'), 'DTSTART;TZID=America/Los_Angeles:20260302T100000'],
      [vevent('DTSTART:20260302T180000Z', 'DTEND:20260302T190000Z'), 'DTSTART:20260302T180000Z'],
      [vevent('DTSTART:20260302T100000', 'DTEND:20260302T110000'), 'DTSTART:20260302T100000'],
      [vevent('DTSTART;VALUE=DATE:20260302', 'DTEND;VALUE=DATE:20260303'), 'DTSTART;VALUE=DATE:20260302'],
    ];
    for (const [ics, expected] of cases) {
      const event = fromVEvent(ics);
      expect(event).not.toHaveProperty('startWallClock');
      expect(dtstartLine(toVEvent(event))).toBe(expected);
    }
  });
});
