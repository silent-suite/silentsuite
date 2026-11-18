import { describe, it, expect } from 'vitest';
import { expandRecurrence } from './recurrence.js';
import { fromVEvent } from '../models/calendar-event.js';
import type { DateRange } from '../models/types.js';

// Cost guard for zone-aware expansion (plan-v2 §4.2, F3). This is an implementation guard, not new
// behaviour RED: today's code ignores the zone and makes no Intl calls, so it passes. The repaired
// engine must reuse cached formatters and convert only near the range, so an old daily series
// viewed for one week stays bounded.

type ExpandWithOptions = (
  rrule: string,
  dtstart: Date,
  range: DateRange,
  exdates?: Date[],
  options?: { timeZone?: string },
) => Date[];
const expandZoned = expandRecurrence as unknown as ExpandWithOptions;

function countIntl<T>(run: () => T): { result: T; constructions: number; formatToParts: number } {
  const Original = Intl.DateTimeFormat;
  const originalFormatToParts = Original.prototype.formatToParts;
  let constructions = 0;
  let formatToParts = 0;
  const counting = new Proxy(Original, {
    construct(target, args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
      constructions++;
      return new target(...args);
    },
    apply(target, _thisArg, args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
      constructions++;
      return target(...args);
    },
  });
  Original.prototype.formatToParts = function (this: Intl.DateTimeFormat, ...args: [Date | number | undefined]) {
    formatToParts++;
    return originalFormatToParts.apply(this, args);
  };
  (Intl as { DateTimeFormat: typeof Intl.DateTimeFormat }).DateTimeFormat = counting;
  try {
    return { result: run(), constructions, formatToParts };
  } finally {
    (Intl as { DateTimeFormat: typeof Intl.DateTimeFormat }).DateTimeFormat = Original;
    Original.prototype.formatToParts = originalFormatToParts;
  }
}

describe('zone-aware expansion cost bound', () => {
  it('a daily LA series begun in 2020, viewed for one 2026 week: <=2 formatter constructions, <=60 formatToParts', () => {
    // Parse before counting: DTSTART decoding is not part of the expansion budget.
    const e = fromVEvent([
      'BEGIN:VEVENT',
      'UID:cost-fixture',
      'SUMMARY:Synthetic',
      'DTSTART;TZID=America/Los_Angeles:20200101T100000',
      'DTEND;TZID=America/Los_Angeles:20200101T110000',
      'RRULE:FREQ=DAILY',
      'END:VEVENT',
    ].join('\r\n'));
    const week: DateRange = { start: new Date('2026-03-02T00:00:00.000Z'), end: new Date('2026-03-09T00:00:00.000Z') };

    const { result, constructions, formatToParts } = countIntl(() =>
      expandZoned(e.recurrenceRule!, e.startDate, week, e.exceptions, { timeZone: 'America/Los_Angeles' }),
    );

    // Occurrence count is host-independent for this window (Mar 2-8, one per day).
    expect(result).toHaveLength(7);
    expect(constructions).toBeLessThanOrEqual(2);
    expect(formatToParts).toBeLessThanOrEqual(60);
  });
});

describe('old all-day series candidate cost', () => {
  it.each([
    ['FREQ=YEARLY', new Date(1972, 10, 17), new Date(2026, 10, 1), new Date(2026, 10, 30), new Date(2026, 10, 17), 1500],
    ['FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1', new Date(1972, 1, 29), new Date(2026, 1, 1), new Date(2026, 2, 1), new Date(2026, 1, 28), 1500],
    ['FREQ=MONTHLY', new Date(1972, 0, 17), new Date(2026, 10, 1), new Date(2026, 10, 30), new Date(2026, 10, 17), 12000],
  ] as const)('%s does not enumerate unrelated dates from 1972', (rule, start, from, to, expected, budget) => {
    const Original = Date;
    let constructions = 0;
    const CountingDate = new Proxy(Original, {
      construct(target, args) { constructions++; return Reflect.construct(target, args); },
    });
    globalThis.Date = CountingDate;
    let result: Date[];
    try {
      result = expandRecurrence(rule, start, { start: from, end: to });
    } finally {
      globalThis.Date = Original;
    }
    expect(result).toEqual([expected]);
    expect(constructions).toBeLessThan(budget);
  });
});
