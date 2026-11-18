import { describe, expect, it } from 'vitest';
import { expandRecurrence } from './recurrence.js';

function dates(rule: string, start: string, end: string) {
  return expandRecurrence(rule, new Date(`${start}T10:00:00Z`), { start: new Date(`${start}T00:00:00Z`), end: new Date(`${end}T23:59:59Z`) }, [], { timeZone: 'UTC' })
    .map(date => date.toISOString().slice(0, 10));
}

describe('recurrence dates within calendar periods', () => {
  it.each([
    ['BYDAY=2MO', '2026-01-12', ['2026-01-12', '2026-02-09', '2026-03-09', '2026-04-13', '2026-05-11', '2026-06-08']],
    ['BYDAY=-1FR', '2026-01-30', ['2026-01-30', '2026-02-27', '2026-03-27', '2026-04-24', '2026-05-29', '2026-06-26']],
    ['BYMONTHDAY=1,15;COUNT=6', '2026-01-01', ['2026-01-01', '2026-01-15', '2026-02-01', '2026-02-15', '2026-03-01', '2026-03-15']],
    ['BYMONTHDAY=-1;COUNT=4', '2026-01-31', ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']],
    ['BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1;COUNT=4', '2026-01-01', ['2026-01-01', '2026-02-02', '2026-03-02', '2026-04-01']],
    ['BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=4', '2026-01-30', ['2026-01-30', '2026-02-27', '2026-03-31', '2026-04-30']],
  ] as const)('expands monthly %s', (rule, start, expected) => expect(dates(`FREQ=MONTHLY;${rule}`, start, '2026-06-30')).toEqual(expected));

  it('expands yearly ordinals within November', () => {
    expect(dates('FREQ=YEARLY;BYMONTH=11;BYDAY=4TH', '2026-11-26', '2028-12-31')).toEqual(['2026-11-26', '2027-11-25', '2028-11-23']);
  });
  it('counts yearly ordinals across the year without BYMONTH', () => {
    expect(dates('FREQ=YEARLY;BYDAY=2MO;COUNT=3', '2026-01-12', '2028-12-31')).toEqual(['2026-01-12', '2027-01-11', '2028-01-10']);
  });
  it('applies yearly BYSETPOS across all selected months', () => {
    expect(dates('FREQ=YEARLY;BYMONTH=1,2;BYDAY=MO;BYSETPOS=-1;COUNT=3', '2026-02-23', '2028-12-31')).toEqual(['2026-02-23', '2027-02-22', '2028-02-28']);
  });
  it('skips nonexistent monthly dates instead of clamping', () => {
    expect(dates('FREQ=MONTHLY;COUNT=3', '2026-01-31', '2026-06-30')).toEqual(['2026-01-31', '2026-03-31', '2026-05-31']);
  });

  it.each([
    ['MO,FR;WKST=MO;COUNT=4', '2026-06-05', '2026-06-30', ['2026-06-05', '2026-06-15', '2026-06-19', '2026-06-29']],
    ['MO;COUNT=4', '2026-03-17', '2026-04-30', ['2026-03-17', '2026-03-30', '2026-04-13', '2026-04-27']],
    ['TU,TH;COUNT=7', '2026-03-19', '2026-04-30', ['2026-03-19', '2026-03-31', '2026-04-02', '2026-04-14', '2026-04-16', '2026-04-28', '2026-04-30']],
    // RFC 5545 section 3.8.5.3: changing WKST changes the Sunday occurrences.
    ['TU,SU;WKST=MO;COUNT=4', '1997-08-05', '1997-09-01', ['1997-08-05', '1997-08-10', '1997-08-19', '1997-08-24']],
    ['TU,SU;WKST=SU;COUNT=4', '1997-08-05', '1997-09-01', ['1997-08-05', '1997-08-17', '1997-08-19', '1997-08-31']],
  ] as const)('anchors alternating weeks for %s', (rule, start, end, expected) => expect(dates(`FREQ=WEEKLY;INTERVAL=2;BYDAY=${rule}`, start, end)).toEqual(expected));

  it('matches the RFC second-to-last weekday example', () => {
    expect(dates('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-2;COUNT=3', '1997-09-29', '1997-12-01')).toEqual(['1997-09-29', '1997-10-30', '1997-11-27']);
  });
  it('keeps the ordinal wall clock through a New York DST change', () => {
    const out = expandRecurrence('FREQ=MONTHLY;BYDAY=2MO;COUNT=3', new Date('2026-02-09T15:00Z'), { start: new Date('2026-02-01Z'), end: new Date('2026-05-01Z') }, [], { timeZone: 'America/New_York' });
    expect(out.map(d => d.toISOString())).toEqual(['2026-02-09T15:00:00.000Z', '2026-03-09T14:00:00.000Z', '2026-04-13T14:00:00.000Z']);
  });
  it('does not replace an excluded DTSTART with an extra COUNT occurrence', () => {
    const start = new Date('2026-01-12T10:00Z');
    const out = expandRecurrence('FREQ=MONTHLY;BYDAY=2MO;COUNT=2', start, { start, end: new Date('2026-06-01Z') }, [start], { timeZone: 'UTC' });
    expect(out.map(d => d.toISOString().slice(0, 10))).toEqual(['2026-02-09']);
  });
  it('bounds rules that never match', () => {
    expect(dates('FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=31', '2026-01-01', '9999-12-31')).toEqual(['2026-01-01']);
  });
});

describe('unsupported sub-daily recurrence compatibility', () => {
  it.each(['HOURLY', 'MINUTELY', 'SECONDLY'])('keeps only DTSTART for %s', (frequency) => {
    const start = new Date('2026-11-17T09:00:00Z');
    const range = { start: new Date('2026-11-17Z'), end: new Date('2026-11-18Z') };
    expect(expandRecurrence(`FREQ=${frequency}`, start, range, [], { timeZone: 'UTC' })).toEqual([start]);
    expect(expandRecurrence(`FREQ=${frequency}`, start, range, [start], { timeZone: 'UTC' })).toEqual([]);
    expect(expandRecurrence(`FREQ=${frequency};UNTIL=20261117T080000Z`, start, range, [], { timeZone: 'UTC' })).toEqual([]);
    expect(expandRecurrence(`FREQ=${frequency}`, start, { ...range, start: new Date('2026-11-17T10:00:00Z') }, [], { timeZone: 'UTC' })).toEqual([]);
  });
});
