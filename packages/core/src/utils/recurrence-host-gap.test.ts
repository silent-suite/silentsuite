import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { expandRecurrence, occurrenceWallClock } from './recurrence.js';
import { fromVEvent, expandEventRecurrence } from '../models/calendar-event.js';

// Host-default path (option omitted: floating, all-day and legacy callers) when an occurrence's
// wall time falls in a host DST gap. Admitted correction (plan-v2 §4.3): only that day's occurrence
// moves past the gap; later occurrences return to DTSTART's wall time instead of keeping the
// shifted hour. The weekly BYDAY branch already behaves this way today and is the control.
//
// This file pins the host zone. Node honours a runtime change of process.env.TZ; the first test
// verifies that, so a failed switch reports as setup, not as recurrence behaviour.
const previousTZ = process.env.TZ;
process.env.TZ = 'America/Los_Angeles';

afterAll(() => {
  if (previousTZ === undefined) delete process.env.TZ;
  else process.env.TZ = previousTZ;
});

const RANGE = { start: new Date('2026-02-01T08:00:00.000Z'), end: new Date('2026-04-01T07:00:00.000Z') };
const iso = (dates: Date[]) => dates.map((d) => d.toISOString());

describe('host-default recurrence across a host DST gap (America/Los_Angeles host)', () => {
  it('setup: the host zone switch is in effect', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/Los_Angeles');
    expect(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).getHours()).toBe(16);
  });

  it('WEEKLY at 02:30: 03-08 moves to 03:30 PDT, 03-15 returns to 02:30', () => {
    const out = expandRecurrence('FREQ=WEEKLY;COUNT=3', new Date(2026, 2, 1, 2, 30, 0), RANGE);
    expect(out).toHaveLength(3);
    // 02:30 PST = 10:30Z; 03:30 PDT = 10:30Z; 02:30 PDT = 09:30Z
    expect(iso(out)).toEqual(['2026-03-01T10:30:00.000Z', '2026-03-08T10:30:00.000Z', '2026-03-15T09:30:00.000Z']);
  });

  it('DAILY at 02:30: only 03-08 moves; 03-09 and 03-10 return to 02:30', () => {
    const out = expandRecurrence('FREQ=DAILY;COUNT=4', new Date(2026, 2, 7, 2, 30, 0), RANGE);
    expect(out).toHaveLength(4);
    expect(iso(out)).toEqual([
      '2026-03-07T10:30:00.000Z',
      '2026-03-08T10:30:00.000Z',
      '2026-03-09T09:30:00.000Z',
      '2026-03-10T09:30:00.000Z',
    ]);
  });

  it('control: WEEKLY;BYDAY=SU at 02:30 already returns to 02:30', () => {
    const out = expandRecurrence('FREQ=WEEKLY;BYDAY=SU;COUNT=3', new Date(2026, 2, 1, 2, 30, 0), RANGE);
    expect(out).toHaveLength(3);
    expect(iso(out)).toEqual(['2026-03-01T10:30:00.000Z', '2026-03-08T10:30:00.000Z', '2026-03-15T09:30:00.000Z']);
  });
});

// Preservation: the supplied DTSTART instant is the first occurrence on the host path, even when
// its local time is ambiguous (fall-back overlap). 2026-11-01 01:30 occurs twice in Los Angeles:
// 08:30Z (PDT) and 09:30Z (PST). Existing behaviour keeps whichever instant was supplied.
describe('host-default recurrence keeps a supplied DTSTART in a fall-back overlap (America/Los_Angeles host)', () => {
  it('setup: 01:30 on 2026-11-01 is ambiguous on this host', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/Los_Angeles');
    const second = new Date('2026-11-01T09:30:00.000Z');
    const first = new Date('2026-11-01T08:30:00.000Z');
    expect([first.getHours(), first.getMinutes(), second.getHours(), second.getMinutes()]).toEqual([1, 30, 1, 30]);
  });

  it('second-fold DTSTART (09:30Z) stays the first occurrence and COUNT=2 still yields two', () => {
    const dtstart = new Date('2026-11-01T09:30:00.000Z');
    const out = expandRecurrence('FREQ=WEEKLY;COUNT=2', dtstart, { start: dtstart, end: new Date('2026-11-10T00:00:00.000Z') });
    expect(iso(out)).toEqual(['2026-11-01T09:30:00.000Z', '2026-11-08T09:30:00.000Z']);
  });

  it('second-fold DTSTART with an earlier range start is returned unchanged', () => {
    const dtstart = new Date('2026-11-01T09:30:00.000Z');
    const out = expandRecurrence('FREQ=WEEKLY;COUNT=2', dtstart, { start: new Date('2026-10-25T00:00:00.000Z'), end: new Date('2026-11-10T00:00:00.000Z') });
    expect(iso(out)).toEqual(['2026-11-01T09:30:00.000Z', '2026-11-08T09:30:00.000Z']);
  });

  it('control: a first-fold DTSTART (08:30Z) keeps 08:30Z, then 01:30 PST the next week', () => {
    const dtstart = new Date('2026-11-01T08:30:00.000Z');
    const out = expandRecurrence('FREQ=WEEKLY;COUNT=2', dtstart, { start: dtstart, end: new Date('2026-11-10T00:00:00.000Z') });
    expect(iso(out)).toEqual(['2026-11-01T08:30:00.000Z', '2026-11-08T09:30:00.000Z']);
  });
});

// Preservation: a host that skipped a whole calendar date. Pacific/Apia moved from -10 to +14 at
// the end of 2011-12-29, so 2011-12-30 does not exist locally. Existing host-local DATE stepping
// lands on each real date once: Dec 29, Dec 31, Jan 1 (no duplicate, no lost date).
describe('host-default DATE recurrence across a skipped host date (Pacific/Apia host)', () => {
  beforeAll(() => {
    process.env.TZ = 'Pacific/Apia';
  });
  afterAll(() => {
    process.env.TZ = 'America/Los_Angeles';
  });

  const localDays = (dates: Date[]) => dates.map((d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`);
  const range = { start: new Date(Date.UTC(2011, 11, 27)), end: new Date(Date.UTC(2012, 0, 10)) };

  it('setup: the host zone is Pacific/Apia and 2011-12-30 does not exist', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Pacific/Apia');
    const skipped = new Date(2011, 11, 30);
    expect([skipped.getMonth(), skipped.getDate()]).toEqual([11, 31]);
  });

  it('DAILY;COUNT=3 from Dec 29 yields Dec 29, Dec 31 and Jan 1, each once', () => {
    const out = expandRecurrence('FREQ=DAILY;COUNT=3', new Date(2011, 11, 29), range);
    expect(localDays(out)).toEqual(['2011-12-29', '2011-12-31', '2012-1-1']);
    expect(new Set(out.map((d) => d.getTime())).size).toBe(out.length);
  });

  it('control: DAILY;COUNT=3 from Jan 2 (no skipped date) yields Jan 2, 3 and 4', () => {
    const out = expandRecurrence('FREQ=DAILY;COUNT=3', new Date(2012, 0, 2), range);
    expect(localDays(out)).toEqual(['2012-1-2', '2012-1-3', '2012-1-4']);
  });

  // Calendar filters apply to the real host date: the skipped Friday Dec 30 resolves to Saturday
  // Dec 31, which is not a Friday occurrence.
  const winter = { start: new Date(Date.UTC(2011, 10, 1)), end: new Date(Date.UTC(2012, 1, 15)) };

  it('DAILY;BYDAY=FR;COUNT=2 from Dec 29 yields the real Fridays Jan 6 and Jan 13', () => {
    const out = expandRecurrence('FREQ=DAILY;BYDAY=FR;COUNT=2', new Date(2011, 11, 29), winter);
    expect(localDays(out)).toEqual(['2012-1-6', '2012-1-13']);
    expect(out.map((d) => d.getDay())).toEqual([5, 5]);
  });

  it('control: DAILY;BYDAY=FR;COUNT=2 from Jan 2 yields Jan 6 and Jan 13', () => {
    const out = expandRecurrence('FREQ=DAILY;BYDAY=FR;COUNT=2', new Date(2012, 0, 2), winter);
    expect(localDays(out)).toEqual(['2012-1-6', '2012-1-13']);
  });

  it('MONTHLY;BYMONTHDAY=30;COUNT=2 from Nov 30 skips December (no real 30th) and yields Jan 30', () => {
    const out = expandRecurrence('FREQ=MONTHLY;BYMONTHDAY=30;COUNT=2', new Date(2011, 10, 30), winter);
    expect(localDays(out)).toEqual(['2011-11-30', '2012-1-30']);
  });

  it('control: MONTHLY;COUNT=3 from Nov 30 yields Nov 30, the resolved Dec 31 and Jan 30', () => {
    const out = expandRecurrence('FREQ=MONTHLY;COUNT=3', new Date(2011, 10, 30), winter);
    expect(localDays(out)).toEqual(['2011-11-30', '2011-12-31', '2012-1-30']);
  });
});

// Event-zone (TZID) path in a zone that skipped a whole date. Pacific/Apia had no 2011-12-30;
// the civil Dec 30 10:00 candidate resolves (pre-gap offset) to the same instant as Dec 31 10:00.
// Consumers must see each occurrence instant once. COUNT still counts civil candidates in order
// (no refund), and the occurrence lookup still reports the collision as ambiguous.
describe('TZID recurrence across a skipped zone date emits unique occurrences (Pacific/Apia)', () => {
  const apiaDaily = (count: number) => fromVEvent([
    'BEGIN:VEVENT',
    'UID:apia-daily',
    'SUMMARY:Synthetic',
    'DTSTART;TZID=Pacific/Apia:20111229T100000',
    'DTEND;TZID=Pacific/Apia:20111229T110000',
    `RRULE:FREQ=DAILY;COUNT=${count}`,
    'END:VEVENT',
  ].join('\r\n'));
  const window = { start: new Date('2011-12-28T00:00:00.000Z'), end: new Date('2012-01-03T00:00:00.000Z') };

  it('setup: DTSTART resolves to 2011-12-29T20:00Z', () => {
    expect(apiaDaily(3).startDate.toISOString()).toBe('2011-12-29T20:00:00.000Z');
  });

  it('DAILY;COUNT=3 emits the two distinct instants once each', () => {
    const out = iso(expandEventRecurrence(apiaDaily(3), window));
    expect(out).toEqual(['2011-12-29T20:00:00.000Z', '2011-12-30T20:00:00.000Z']);
  });

  it('DAILY;COUNT=4 keeps civil COUNT ordering: Jan 1 is the last candidate, no refund to Jan 2', () => {
    const out = iso(expandEventRecurrence(apiaDaily(4), window));
    expect(out).toEqual(['2011-12-29T20:00:00.000Z', '2011-12-30T20:00:00.000Z', '2011-12-31T20:00:00.000Z']);
  });

  it('control: the occurrence lookup reports the colliding instant as ambiguous and resolves a unique one', () => {
    const event = apiaDaily(3);
    const options = { timeZone: 'Pacific/Apia' };
    expect(occurrenceWallClock(event.recurrenceRule!, event.startDate, new Date('2011-12-30T20:00:00.000Z'), options)).toBeUndefined();
    expect(occurrenceWallClock(event.recurrenceRule!, event.startDate, new Date('2011-12-29T20:00:00.000Z'), options)).toBe('20111229T100000');
  });

  it('control: an Apia DAILY series after the skip emits each day once', () => {
    const event = fromVEvent([
      'BEGIN:VEVENT', 'UID:apia-jan', 'SUMMARY:Synthetic',
      'DTSTART;TZID=Pacific/Apia:20120102T100000', 'DTEND;TZID=Pacific/Apia:20120102T110000',
      'RRULE:FREQ=DAILY;COUNT=3', 'END:VEVENT',
    ].join('\r\n'));
    const out = iso(expandEventRecurrence(event, { start: new Date('2012-01-01T00:00:00.000Z'), end: new Date('2012-01-10T00:00:00.000Z') }));
    expect(out).toEqual(['2012-01-01T20:00:00.000Z', '2012-01-02T20:00:00.000Z', '2012-01-03T20:00:00.000Z']);
  });
});
