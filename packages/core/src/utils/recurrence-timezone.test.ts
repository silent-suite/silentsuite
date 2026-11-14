import { describe, it, expect } from 'vitest';
import { expandRecurrence } from './recurrence.js';
import { fromVEvent, toVEvent } from '../models/calendar-event.js';
import type { CalendarEvent } from '../models/calendar-event.js';
import type { DateRange } from '../models/types.js';

// Recurrence must repeat DTSTART's wall clock in the event's own anchor (TZID zone, or UTC for a
// `Z` value), independent of the host zone (#886). Every expectation below is an exact UTC instant,
// so results must not depend on the machine's TZ. Fixtures are synthetic inline ICS parsed through
// the real `fromVEvent`.
//
// `expandRecurrence` gains an optional fifth `{ timeZone }` argument in the planned repair. It is
// passed through a typed alias so these tests load against both the current and the repaired API.

type ExpandWithOptions = (
  rrule: string,
  dtstart: Date,
  range: DateRange,
  exdates?: Date[],
  options?: { timeZone?: string },
) => Date[];
const expandZoned = expandRecurrence as unknown as ExpandWithOptions;

const WIDE: DateRange = {
  start: new Date('2025-12-01T00:00:00.000Z'),
  end: new Date('2031-01-01T00:00:00.000Z'),
};

function vevent(...props: string[]): CalendarEvent {
  return fromVEvent(['BEGIN:VEVENT', 'UID:tz-fixture', 'SUMMARY:Synthetic', ...props, 'END:VEVENT'].join('\r\n'));
}

function zoned(event: CalendarEvent, timeZone: string, range: DateRange = WIDE): string[] {
  return expandZoned(event.recurrenceRule!, event.startDate, range, event.exceptions, { timeZone })
    .map((d) => d.toISOString());
}

// ── UTC anchor ──

describe('UTC-anchored (Z) series repeat at a fixed UTC time', () => {
  it('weekly 18:00Z stays 18:00Z across the US and EU DST starts', () => {
    const e = vevent('DTSTART:20260223T180000Z', 'DTEND:20260223T190000Z', 'RRULE:FREQ=WEEKLY;COUNT=6');
    const out = zoned(e, 'UTC');
    expect(out).toHaveLength(6);
    expect(out).toEqual([
      '2026-02-23T18:00:00.000Z',
      '2026-03-02T18:00:00.000Z',
      '2026-03-09T18:00:00.000Z',
      '2026-03-16T18:00:00.000Z',
      '2026-03-23T18:00:00.000Z',
      '2026-03-30T18:00:00.000Z',
    ]);
  });

  it('monthly from the 31st keeps the existing month-end clamp at 18:00Z', () => {
    const e = vevent('DTSTART:20260131T180000Z', 'DTEND:20260131T190000Z', 'RRULE:FREQ=MONTHLY;COUNT=4');
    const out = zoned(e, 'UTC');
    expect(out).toHaveLength(4);
    expect(out).toEqual([
      '2026-01-31T18:00:00.000Z',
      '2026-02-28T18:00:00.000Z',
      '2026-03-31T18:00:00.000Z',
      '2026-04-30T18:00:00.000Z',
    ]);
  });
});

// ── Regional TZID anchors across their own transitions ──

describe('TZID series keep their wall clock across the zone transitions', () => {
  it('America/Los_Angeles 10:00 across 2026-03-08', () => {
    const e = vevent('DTSTART;TZID=America/Los_Angeles:20260302T100000', 'DTEND;TZID=America/Los_Angeles:20260302T110000', 'RRULE:FREQ=WEEKLY;COUNT=3');
    const out = zoned(e, 'America/Los_Angeles');
    expect(out).toHaveLength(3);
    expect(out).toEqual(['2026-03-02T18:00:00.000Z', '2026-03-09T17:00:00.000Z', '2026-03-16T17:00:00.000Z']);
  });

  it('America/Los_Angeles 10:00 across 2026-11-01', () => {
    const e = vevent('DTSTART;TZID=America/Los_Angeles:20261026T100000', 'DTEND;TZID=America/Los_Angeles:20261026T110000', 'RRULE:FREQ=WEEKLY;COUNT=3');
    const out = zoned(e, 'America/Los_Angeles');
    expect(out).toHaveLength(3);
    expect(out).toEqual(['2026-10-26T17:00:00.000Z', '2026-11-02T18:00:00.000Z', '2026-11-09T18:00:00.000Z']);
  });

  it('Europe/Berlin 09:00 across 2026-03-29', () => {
    const e = vevent('DTSTART;TZID=Europe/Berlin:20260323T090000', 'DTEND;TZID=Europe/Berlin:20260323T100000', 'RRULE:FREQ=WEEKLY;COUNT=3');
    const out = zoned(e, 'Europe/Berlin');
    expect(out).toHaveLength(3);
    expect(out).toEqual(['2026-03-23T08:00:00.000Z', '2026-03-30T07:00:00.000Z', '2026-04-06T07:00:00.000Z']);
  });

  it('Europe/Berlin 09:00 across 2026-10-25', () => {
    const e = vevent('DTSTART;TZID=Europe/Berlin:20261019T090000', 'DTEND;TZID=Europe/Berlin:20261019T100000', 'RRULE:FREQ=WEEKLY;COUNT=3');
    const out = zoned(e, 'Europe/Berlin');
    expect(out).toHaveLength(3);
    expect(out).toEqual(['2026-10-19T07:00:00.000Z', '2026-10-26T08:00:00.000Z', '2026-11-02T08:00:00.000Z']);
  });

  it('Australia/Sydney 09:00 across the 2026-04-05 DST end (southern hemisphere)', () => {
    const e = vevent('DTSTART;TZID=Australia/Sydney:20260330T090000', 'DTEND;TZID=Australia/Sydney:20260330T100000', 'RRULE:FREQ=WEEKLY;COUNT=3');
    const out = zoned(e, 'Australia/Sydney');
    expect(out).toHaveLength(3);
    expect(out).toEqual(['2026-03-29T22:00:00.000Z', '2026-04-05T23:00:00.000Z', '2026-04-12T23:00:00.000Z']);
  });

  it('Australia/Sydney 09:00 across the 2026-10-04 DST start', () => {
    const e = vevent('DTSTART;TZID=Australia/Sydney:20260928T090000', 'DTEND;TZID=Australia/Sydney:20260928T100000', 'RRULE:FREQ=WEEKLY;COUNT=3');
    const out = zoned(e, 'Australia/Sydney');
    expect(out).toHaveLength(3);
    expect(out).toEqual(['2026-09-27T23:00:00.000Z', '2026-10-04T22:00:00.000Z', '2026-10-11T22:00:00.000Z']);
  });

  it('Australia/Lord_Howe 09:00 across its 30-minute DST end', () => {
    const e = vevent('DTSTART;TZID=Australia/Lord_Howe:20260330T090000', 'DTEND;TZID=Australia/Lord_Howe:20260330T100000', 'RRULE:FREQ=WEEKLY;COUNT=3');
    const out = zoned(e, 'Australia/Lord_Howe');
    expect(out).toHaveLength(3);
    expect(out).toEqual(['2026-03-29T22:00:00.000Z', '2026-04-05T22:30:00.000Z', '2026-04-12T22:30:00.000Z']);
  });

  it('Etc/GMT+8 (fixed -08) stays 18:00Z while US zones change on 2026-03-08', () => {
    const e = vevent('DTSTART;TZID=Etc/GMT+8:20260302T100000', 'DTEND;TZID=Etc/GMT+8:20260302T110000', 'RRULE:FREQ=WEEKLY;COUNT=3');
    const out = zoned(e, 'Etc/GMT+8');
    expect(out).toHaveLength(3);
    expect(out).toEqual(['2026-03-02T18:00:00.000Z', '2026-03-09T18:00:00.000Z', '2026-03-16T18:00:00.000Z']);
  });
});

// ── Weekday and month-day rules evaluated in the event zone ──

describe('BYDAY / BYMONTHDAY use the event zone calendar, not the host calendar', () => {
  it('Asia/Tokyo BYDAY=MO at 08:00 lands on Tokyo Mondays (Sunday 23:00Z)', () => {
    const e = vevent('DTSTART;TZID=Asia/Tokyo:20260105T080000', 'DTEND;TZID=Asia/Tokyo:20260105T090000', 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3');
    const out = zoned(e, 'Asia/Tokyo');
    expect(out).toHaveLength(3);
    expect(out).toEqual(['2026-01-04T23:00:00.000Z', '2026-01-11T23:00:00.000Z', '2026-01-18T23:00:00.000Z']);
  });

  it('America/Phoenix BYDAY=MO at 18:00 lands on Phoenix Mondays (Tuesday 01:00Z)', () => {
    const e = vevent('DTSTART;TZID=America/Phoenix:20260105T180000', 'DTEND;TZID=America/Phoenix:20260105T190000', 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3');
    const out = zoned(e, 'America/Phoenix');
    expect(out).toHaveLength(3);
    expect(out).toEqual(['2026-01-06T01:00:00.000Z', '2026-01-13T01:00:00.000Z', '2026-01-20T01:00:00.000Z']);
  });

  it('Etc/GMT+8 BYDAY=MO at 20:00 lands on -08 Mondays (Tuesday 04:00Z)', () => {
    const e = vevent('DTSTART;TZID=Etc/GMT+8:20260105T200000', 'DTEND;TZID=Etc/GMT+8:20260105T210000', 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3');
    const out = zoned(e, 'Etc/GMT+8');
    expect(out).toHaveLength(3);
    expect(out).toEqual(['2026-01-06T04:00:00.000Z', '2026-01-13T04:00:00.000Z', '2026-01-20T04:00:00.000Z']);
  });

  it('Asia/Tokyo MONTHLY;BYMONTHDAY=1 at 08:00 yields every Tokyo first-of-month', () => {
    const e = vevent('DTSTART;TZID=Asia/Tokyo:20260101T080000', 'DTEND;TZID=Asia/Tokyo:20260101T090000', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=1;COUNT=4');
    const out = zoned(e, 'Asia/Tokyo');
    expect(out).toHaveLength(4);
    expect(out).toEqual([
      '2025-12-31T23:00:00.000Z',
      '2026-01-31T23:00:00.000Z',
      '2026-02-28T23:00:00.000Z',
      '2026-03-31T23:00:00.000Z',
    ]);
  });
});

// ── YEARLY ──

describe('YEARLY in a zone', () => {
  it('Europe/Berlin 09:00 on March 10 stays 08:00Z (host DST dates differ by year)', () => {
    const e = vevent('DTSTART;TZID=Europe/Berlin:20260310T090000', 'DTEND;TZID=Europe/Berlin:20260310T100000', 'RRULE:FREQ=YEARLY;COUNT=2');
    const out = zoned(e, 'Europe/Berlin');
    expect(out).toHaveLength(2);
    expect(out).toEqual(['2026-03-10T08:00:00.000Z', '2027-03-10T08:00:00.000Z']);
  });

  it('repeats a Feb 29 event in Australia/Sydney only in leap years', () => {
    const e = vevent('DTSTART;TZID=Australia/Sydney:20280229T090000', 'DTEND;TZID=Australia/Sydney:20280229T100000', 'RRULE:FREQ=YEARLY;COUNT=3');
    const out = zoned(e, 'Australia/Sydney', { start: WIDE.start, end: new Date('2037-01-01T00:00:00.000Z') });
    expect(out).toHaveLength(3);
    expect(out).toEqual(['2028-02-28T22:00:00.000Z', '2032-02-28T22:00:00.000Z', '2036-02-28T22:00:00.000Z']);
  });
});

// ── COUNT, EXDATE, range carry-in, UNTIL ──

describe('COUNT, EXDATE, range and UNTIL keep their contracts in the event zone', () => {
  it('COUNT counts an excluded occurrence; the TZID EXDATE removes exactly that instance', () => {
    const e = vevent(
      'DTSTART;TZID=America/Los_Angeles:20260302T100000',
      'DTEND;TZID=America/Los_Angeles:20260302T110000',
      'RRULE:FREQ=WEEKLY;COUNT=4',
      'EXDATE;TZID=America/Los_Angeles:20260316T100000',
    );
    expect(e.exceptions.map((d) => d.toISOString())).toEqual(['2026-03-16T17:00:00.000Z']);
    const out = zoned(e, 'America/Los_Angeles');
    expect(out).toHaveLength(3);
    expect(out).toEqual(['2026-03-02T18:00:00.000Z', '2026-03-09T17:00:00.000Z', '2026-03-23T17:00:00.000Z']);
  });

  it('range carry-in returns the same instants as the full expansion', () => {
    const e = vevent('DTSTART;TZID=America/Los_Angeles:20260302T100000', 'DTEND;TZID=America/Los_Angeles:20260302T110000', 'RRULE:FREQ=WEEKLY;COUNT=6');
    const full = zoned(e, 'America/Los_Angeles');
    expect(full).toEqual([
      '2026-03-02T18:00:00.000Z',
      '2026-03-09T17:00:00.000Z',
      '2026-03-16T17:00:00.000Z',
      '2026-03-23T17:00:00.000Z',
      '2026-03-30T17:00:00.000Z',
      '2026-04-06T17:00:00.000Z',
    ]);
    const tail = zoned(e, 'America/Los_Angeles', { start: new Date('2026-03-10T00:00:00.000Z'), end: WIDE.end });
    expect(tail).toHaveLength(4);
    expect(tail).toEqual(full.slice(2));
  });

  it('UNTIL with Z is an inclusive instant', () => {
    const e = vevent('DTSTART;TZID=America/Los_Angeles:20260306T100000', 'DTEND;TZID=America/Los_Angeles:20260306T110000', 'RRULE:FREQ=DAILY;UNTIL=20260309T170000Z');
    const out = zoned(e, 'America/Los_Angeles');
    expect(out).toHaveLength(4);
    expect(out).toEqual([
      '2026-03-06T18:00:00.000Z',
      '2026-03-07T18:00:00.000Z',
      '2026-03-08T17:00:00.000Z',
      '2026-03-09T17:00:00.000Z',
    ]);
  });

  it('date-only UNTIL means midnight of that date in the event zone', () => {
    const e = vevent('DTSTART;TZID=Asia/Tokyo:20260105T080000', 'DTEND;TZID=Asia/Tokyo:20260105T090000', 'RRULE:FREQ=DAILY;UNTIL=20260107');
    const out = zoned(e, 'Asia/Tokyo');
    expect(out).toHaveLength(2);
    expect(out).toEqual(['2026-01-04T23:00:00.000Z', '2026-01-05T23:00:00.000Z']);
  });

  it('a UTC EXDATE survives toVEvent -> fromVEvent and removes exactly one occurrence', () => {
    const base = vevent('DTSTART:20260223T180000Z', 'DTEND:20260223T190000Z', 'RRULE:FREQ=WEEKLY;COUNT=5');
    const withException: CalendarEvent = { ...base, exceptions: [new Date('2026-03-16T18:00:00.000Z')] };
    const ical = toVEvent(withException);
    expect(ical.split('\r\n')).toContain('EXDATE:20260316T180000Z');
    const reloaded = fromVEvent(ical);
    const out = zoned(reloaded, 'UTC');
    expect(out).toHaveLength(4);
    expect(out).toEqual([
      '2026-02-23T18:00:00.000Z',
      '2026-03-02T18:00:00.000Z',
      '2026-03-09T18:00:00.000Z',
      '2026-03-23T18:00:00.000Z',
    ]);
  });
});

// ── DST gap / overlap (RFC 5545 §3.3.10 applying §3.3.5, Verified Erratum 4271) ──

describe('DST gap and overlap occurrences', () => {
  it('a nonexistent 02:30 uses the pre-gap offset that day and returns to 02:30 the next week', () => {
    const e = vevent('DTSTART;TZID=America/Los_Angeles:20260301T023000', 'DTEND;TZID=America/Los_Angeles:20260301T033000', 'RRULE:FREQ=WEEKLY;COUNT=3');
    const out = zoned(e, 'America/Los_Angeles');
    expect(out).toHaveLength(3);
    expect(out).toEqual(['2026-03-01T10:30:00.000Z', '2026-03-08T10:30:00.000Z', '2026-03-15T09:30:00.000Z']);
  });

  it('an ambiguous 02:30 resolves to its first occurrence (control)', () => {
    const e = vevent('DTSTART;TZID=Europe/Berlin:20261018T023000', 'DTEND;TZID=Europe/Berlin:20261018T033000', 'RRULE:FREQ=WEEKLY;COUNT=2');
    const out = zoned(e, 'Europe/Berlin');
    expect(out).toHaveLength(2);
    expect(out).toEqual(['2026-10-18T00:30:00.000Z', '2026-10-25T00:30:00.000Z']);
  });
});

// ── Controls that should already pass on common hosts ──

describe('controls', () => {
  it('stable zone without DST: Asia/Tokyo weekly 10:00 in January', () => {
    const e = vevent('DTSTART;TZID=Asia/Tokyo:20260105T100000', 'DTEND;TZID=Asia/Tokyo:20260105T110000', 'RRULE:FREQ=WEEKLY;COUNT=3');
    const out = zoned(e, 'Asia/Tokyo');
    expect(out).toHaveLength(3);
    expect(out).toEqual(['2026-01-05T01:00:00.000Z', '2026-01-12T01:00:00.000Z', '2026-01-19T01:00:00.000Z']);
  });

  it('stable half-hour zone: Asia/Kolkata weekly 09:30 in January', () => {
    const e = vevent('DTSTART;TZID=Asia/Kolkata:20260105T093000', 'DTEND;TZID=Asia/Kolkata:20260105T103000', 'RRULE:FREQ=WEEKLY;COUNT=2');
    const out = zoned(e, 'Asia/Kolkata');
    expect(out).toHaveLength(2);
    expect(out).toEqual(['2026-01-05T04:00:00.000Z', '2026-01-12T04:00:00.000Z']);
  });

  it('unknown TZID falls back to host-local wall time, as the parser does', () => {
    const e = vevent('DTSTART;TZID=Mars/Olympus_Mons:20260302T100000', 'DTEND;TZID=Mars/Olympus_Mons:20260302T110000', 'RRULE:FREQ=WEEKLY;COUNT=2');
    expect(e.timezone).toBe('Mars/Olympus_Mons');
    expect(e.startDate.getTime()).toBe(new Date(2026, 2, 2, 10, 0, 0).getTime());
    const out = expandZoned(e.recurrenceRule!, e.startDate, WIDE, e.exceptions, { timeZone: 'Mars/Olympus_Mons' });
    expect(out.map((d) => d.getTime())).toEqual([
      new Date(2026, 2, 2, 10, 0, 0).getTime(),
      new Date(2026, 2, 9, 10, 0, 0).getTime(),
    ]);
  });

  it('floating series with the option omitted stays host-local', () => {
    const e = vevent('DTSTART:20260105T100000', 'DTEND:20260105T110000', 'RRULE:FREQ=WEEKLY;COUNT=2');
    const out = expandRecurrence(e.recurrenceRule!, e.startDate, WIDE, e.exceptions);
    expect(out.map((d) => d.getTime())).toEqual([
      new Date(2026, 0, 5, 10, 0, 0).getTime(),
      new Date(2026, 0, 12, 10, 0, 0).getTime(),
    ]);
  });

  it('all-day (VALUE=DATE) series with the option omitted stays on host-local midnights', () => {
    const e = vevent('DTSTART;VALUE=DATE:20260302', 'DTEND;VALUE=DATE:20260303', 'RRULE:FREQ=WEEKLY;COUNT=2');
    expect(e.allDay).toBe(true);
    const out = expandRecurrence(e.recurrenceRule!, e.startDate, WIDE, e.exceptions);
    expect(out.map((d) => d.getTime())).toEqual([
      new Date(2026, 2, 2).getTime(),
      new Date(2026, 2, 9).getTime(),
    ]);
  });
});
