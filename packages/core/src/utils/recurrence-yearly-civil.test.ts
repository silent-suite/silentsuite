import { describe, it, expect } from 'vitest';
import { expandRecurrence } from './recurrence.js';
import { fromVEvent, expandEventRecurrence, eventOccurrenceWallClock } from '../models/calendar-event.js';
import type { CalendarEvent } from '../models/calendar-event.js';
import type { DateRange } from '../models/types.js';

// YEARLY (#916: per-year generation from DTSTART, Feb 29 only in leap years, BYMONTH x BYMONTHDAY
// generated, negative BYMONTHDAY from the month end) on the event zone's calendar (#964: TZID
// wall clock, raw UNTIL, startWallClock gap anchor, supplied first instant, COUNT before EXDATE,
// unique instants, ambiguous wall-clock lookup). Zone rows parse synthetic ICS through the real
// `fromVEvent` and expect exact UTC instants, so they hold on any host. Host rows (option omitted)
// build expectations with local constructors. #916 host rows already in recurrence.test.ts are not
// repeated here.

function vevent(...props: string[]): CalendarEvent {
  return fromVEvent(['BEGIN:VEVENT', 'UID:yearly-civil-fixture', 'SUMMARY:Synthetic', ...props, 'END:VEVENT'].join('\r\n'));
}

const local = (y: number, m: number, d: number): Date => new Date(y, m - 1, d);
const range = (start: Date, end: Date): DateRange => ({ start, end });
const utc = (s: string): Date => new Date(s);
const iso = (dates: Date[]): string[] => dates.map((x) => x.toISOString());
const localDays = (dates: Date[]): string[] =>
  dates.map((x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`);

describe('host-local YEARLY (option omitted)', () => {
  it('a Feb 29 event with INTERVAL=2 skips the non-leap interval years', () => {
    const out = expandRecurrence('FREQ=YEARLY;INTERVAL=2;COUNT=3', local(2024, 2, 29), range(local(2024, 1, 1), local(2040, 12, 31)));
    expect(localDays(out)).toEqual(['2024-02-29', '2028-02-29', '2032-02-29']);
  });

  it('last day of February: COUNT counts the EXDATE-removed candidate', () => {
    const out = expandRecurrence(
      'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1;COUNT=3',
      local(2026, 2, 28),
      range(local(2026, 1, 1), local(2035, 12, 31)),
      [local(2027, 2, 28)],
    );
    expect(localDays(out)).toEqual(['2026-02-28', '2028-02-29']);
  });

  it('BYMONTH x BYMONTHDAY generates every listed month and day in order', () => {
    const out = expandRecurrence('FREQ=YEARLY;BYMONTH=1,7;BYMONTHDAY=1,15;COUNT=6', local(2026, 1, 1), range(local(2026, 1, 1), local(2030, 12, 31)));
    expect(localDays(out)).toEqual(['2026-01-01', '2026-01-15', '2026-07-01', '2026-07-15', '2027-01-01', '2027-01-15']);
  });

  it('a generated series stops at the range end', () => {
    const out = expandRecurrence('FREQ=YEARLY;BYMONTH=1,7;BYMONTHDAY=1', local(2026, 1, 1), range(local(2026, 1, 1), local(2026, 6, 30)));
    expect(localDays(out)).toEqual(['2026-01-01']);
  });
});

describe('YEARLY on the event zone calendar', () => {
  const TOKYO_JAN_1 = ['DTSTART;TZID=Asia/Tokyo:20260101T080000', 'DTEND;TZID=Asia/Tokyo:20260101T090000'];
  const TOKYO_RANGE = range(utc('2025-12-01T00:00:00Z'), utc('2031-01-01T00:00:00Z'));

  it('Asia/Tokyo BYMONTH=1;BYMONTHDAY=1 08:00 is Dec 31 23:00Z', () => {
    const e = vevent(...TOKYO_JAN_1, 'RRULE:FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1;COUNT=2');
    expect(iso(expandEventRecurrence(e, TOKYO_RANGE))).toEqual(['2025-12-31T23:00:00.000Z', '2026-12-31T23:00:00.000Z']);
  });

  it('Asia/Tokyo negative BYMONTHDAY is the last day of January in Tokyo', () => {
    const e = vevent(...TOKYO_JAN_1, 'RRULE:FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=-1;COUNT=2');
    expect(iso(expandEventRecurrence(e, TOKYO_RANGE))).toEqual(['2026-01-30T23:00:00.000Z', '2027-01-30T23:00:00.000Z']);
  });

  it('Asia/Tokyo BYDAY=MO is evaluated in Tokyo (Sunday in UTC and Los Angeles)', () => {
    // 2026-01-05 08:00 JST is a Monday; Jan 5 is next a Monday in 2032.
    const e = vevent('DTSTART;TZID=Asia/Tokyo:20260105T080000', 'DTEND;TZID=Asia/Tokyo:20260105T090000', 'RRULE:FREQ=YEARLY;BYDAY=MO;COUNT=2');
    const out = expandEventRecurrence(e, range(utc('2026-01-01T00:00:00Z'), utc('2033-01-01T00:00:00Z')));
    expect(iso(out)).toEqual(['2026-01-04T23:00:00.000Z', '2032-01-04T23:00:00.000Z']);
  });

  it('Australia/Sydney Feb 29 with a Z UNTIL stops after the last leap day before it', () => {
    const e = vevent(
      'DTSTART;TZID=Australia/Sydney:20240229T090000',
      'DTEND;TZID=Australia/Sydney:20240229T100000',
      'RRULE:FREQ=YEARLY;UNTIL=20330101T000000Z',
    );
    const out = expandEventRecurrence(e, range(utc('2024-01-01T00:00:00Z'), utc('2040-01-01T00:00:00Z')));
    expect(iso(out)).toEqual(['2024-02-28T22:00:00.000Z', '2028-02-28T22:00:00.000Z', '2032-02-28T22:00:00.000Z']);
  });

  it('Australia/Sydney 2032 occurrence has the Feb 29 wall clock', () => {
    const e = vevent('DTSTART;TZID=Australia/Sydney:20280229T090000', 'DTEND;TZID=Australia/Sydney:20280229T100000', 'RRULE:FREQ=YEARLY');
    expect(eventOccurrenceWallClock(e, utc('2032-02-28T22:00:00Z'))).toBe('20320229T090000');
  });
});

describe('YEARLY keeps the zone UNTIL, range and DTSTART contracts', () => {
  const BERLIN = ['DTSTART;TZID=Europe/Berlin:20260310T090000', 'DTEND;TZID=Europe/Berlin:20260310T100000'];
  const BERLIN_RANGE = range(utc('2026-01-01T00:00:00Z'), utc('2031-01-01T00:00:00Z'));
  const berlin = (rrule: string, r: DateRange = BERLIN_RANGE) => iso(expandEventRecurrence(vevent(...BERLIN, rrule), r));

  it('a Z UNTIL is an inclusive instant', () => {
    expect(berlin('RRULE:FREQ=YEARLY;UNTIL=20280310T080000Z'))
      .toEqual(['2026-03-10T08:00:00.000Z', '2027-03-10T08:00:00.000Z', '2028-03-10T08:00:00.000Z']);
  });

  it('a date-only UNTIL is midnight in the event zone', () => {
    expect(berlin('RRULE:FREQ=YEARLY;UNTIL=20280310')).toEqual(['2026-03-10T08:00:00.000Z', '2027-03-10T08:00:00.000Z']);
  });

  it('a floating datetime UNTIL is an inclusive Berlin wall clock', () => {
    expect(berlin('RRULE:FREQ=YEARLY;UNTIL=20280310T090000'))
      .toEqual(['2026-03-10T08:00:00.000Z', '2027-03-10T08:00:00.000Z', '2028-03-10T08:00:00.000Z']);
  });

  it('a floating datetime UNTIL one second earlier is read in Berlin, not UTC', () => {
    expect(berlin('RRULE:FREQ=YEARLY;UNTIL=20280310T085959')).toEqual(['2026-03-10T08:00:00.000Z', '2027-03-10T08:00:00.000Z']);
  });

  it('range carry-in returns the same later instants', () => {
    expect(berlin('RRULE:FREQ=YEARLY;COUNT=4', range(utc('2027-06-01T00:00:00Z'), utc('2031-01-01T00:00:00Z'))))
      .toEqual(['2028-03-10T08:00:00.000Z', '2029-03-10T08:00:00.000Z']);
  });

  it('a Los Angeles DST-gap DTSTART repeats its 02:30 wall clock next year', () => {
    const e = vevent(
      'DTSTART;TZID=America/Los_Angeles:20300310T023000',
      'DTEND;TZID=America/Los_Angeles:20300310T033000',
      'RRULE:FREQ=YEARLY;COUNT=2',
    );
    expect(e.startDate.toISOString()).toBe('2030-03-10T10:30:00.000Z');
    const out = expandEventRecurrence(e, range(utc('2030-01-01T00:00:00Z'), utc('2032-01-01T00:00:00Z')));
    expect(iso(out)).toEqual(['2030-03-10T10:30:00.000Z', '2031-03-10T09:30:00.000Z']);
  });

  it('a supplied later-fold DTSTART stays the first instance (H1)', () => {
    // 2026-11-01 01:30 occurs at 08:30Z (PDT) and 09:30Z (PST). Parsing picks the earlier fold, so
    // the later instant is supplied explicitly; 2027-11-01 is still PDT (01:30 = 08:30Z).
    const parsed = vevent(
      'DTSTART;TZID=America/Los_Angeles:20261101T013000',
      'DTEND;TZID=America/Los_Angeles:20261101T023000',
      'RRULE:FREQ=YEARLY;COUNT=2',
    );
    expect(parsed.startDate.toISOString()).toBe('2026-11-01T08:30:00.000Z');
    const e: CalendarEvent = { ...parsed, startDate: utc('2026-11-01T09:30:00Z') };
    const out = expandEventRecurrence(e, range(utc('2026-10-01T00:00:00Z'), utc('2028-01-01T00:00:00Z')));
    expect(iso(out)).toEqual(['2026-11-01T09:30:00.000Z', '2027-11-01T08:30:00.000Z']);
  });
});

describe('YEARLY generated dates across a skipped zone date (Pacific/Apia, 2011-12-30)', () => {
  // Apia went from Dec 29 24:00 (-10) to Dec 31 00:00 (+14). Generated civil Dec 30 10:00 takes the
  // pre-gap offset (20:00Z), the same instant as Dec 31 10:00 +14.
  const APIA = ['DTSTART;TZID=Pacific/Apia:20111229T100000', 'DTEND;TZID=Pacific/Apia:20111229T110000'];
  const RULE = 'RRULE:FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=29,30,31';
  const APIA_RANGE = range(utc('2011-12-01T00:00:00Z'), utc('2014-01-01T00:00:00Z'));

  it('emits each instant once', () => {
    const e = vevent(...APIA, `${RULE};COUNT=3`);
    expect(e.startDate.toISOString()).toBe('2011-12-29T20:00:00.000Z');
    expect(iso(expandEventRecurrence(e, APIA_RANGE))).toEqual(['2011-12-29T20:00:00.000Z', '2011-12-30T20:00:00.000Z']);
  });

  it('counts both colliding civil candidates before EXDATE removes their instant', () => {
    const e = vevent(...APIA, `${RULE};COUNT=4`, 'EXDATE:20111230T200000Z');
    expect(iso(e.exceptions ?? [])).toEqual(['2011-12-30T20:00:00.000Z']);
    // Dec 29, 30, 31 (2011) and Dec 29 2012 (+14 = 2012-12-28T20:00Z).
    expect(iso(expandEventRecurrence(e, APIA_RANGE))).toEqual(['2011-12-29T20:00:00.000Z', '2012-12-28T20:00:00.000Z']);
  });

  it('has no single wall clock at the collision instant, and a unique one elsewhere', () => {
    const e = vevent(...APIA, `${RULE};COUNT=6`);
    expect(eventOccurrenceWallClock(e, utc('2011-12-30T20:00:00Z'))).toBeUndefined();
    expect(eventOccurrenceWallClock(e, utc('2011-12-29T20:00:00Z'))).toBe('20111229T100000');
    // 2012-12-31 10:00 +14 = 2012-12-30T20:00Z (the sixth candidate).
    expect(eventOccurrenceWallClock(e, utc('2012-12-30T20:00:00Z'))).toBe('20121231T100000');
  });
});

describe('YEARLY in UTC keeps a low civil year (preservation)', () => {
  it('years 1-3 stay years 1-3, not 1901-1903', () => {
    const out = expandRecurrence('FREQ=YEARLY;COUNT=3', utc('0001-01-15T00:00:00.000Z'),
      range(utc('0001-01-01T00:00:00.000Z'), utc('0010-01-01T00:00:00.000Z')), [], { timeZone: 'UTC' });
    expect(iso(out)).toEqual(['0001-01-15T00:00:00.000Z', '0002-01-15T00:00:00.000Z', '0003-01-15T00:00:00.000Z']);
  });
});
