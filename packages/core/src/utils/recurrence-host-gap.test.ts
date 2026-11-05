import { afterAll, describe, it, expect } from 'vitest';
import { expandRecurrence } from './recurrence.js';

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
