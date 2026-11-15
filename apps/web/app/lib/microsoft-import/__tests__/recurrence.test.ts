import { describe, expect, it } from 'vitest'
import { rruleFor, seriesPattern, type GraphRecurrence } from '../recurrence'
import { evaluateRRule } from './rfc5545-evaluator'

const noEnd = (startDate: string) => ({ type: 'noEnd', startDate })

/** The series' own expansion, the emitted RRULE, and DTSTART + RRULE through the RFC 5545 evaluator. */
function check(recurrence: GraphRecurrence, until?: string) {
  const series = seriesPattern(recurrence)
  if (!series) throw new Error('pattern rejected')
  const rrule = rruleFor(series, until)!
  return { series, rrule, rfc: (n: number) => evaluateRRule({ date: series.first }, rrule, n), own: (n: number) => series.expand(n) }
}

describe('Graph recurrence: Microsoft guide example (start Aug 29 2017, every 2 months, first Thursday)', () => {
  const pattern = { type: 'relativeMonthly', interval: 2, daysOfWeek: ['thursday'], index: 'first', firstDayOfWeek: 'sunday', month: 0, dayOfMonth: 0 }
  const expected = ['2017-09-07', '2017-11-02', '2018-01-04', '2018-03-01']

  it('starts at the first matching date and counts the interval from its month', () => {
    const { series, rrule, rfc, own } = check({ pattern, range: noEnd('2017-08-29') })
    expect(series.first).toBe('2017-09-07')
    expect(rrule).toBe('FREQ=MONTHLY;INTERVAL=2;BYDAY=1TH')
    expect(own(4)).toEqual(expected)
    expect(rfc(4)).toEqual(expected)
    expect(series.matches('2017-11-02')).toBe(true)
    expect(series.matches('2017-10-05')).toBe(false) // October is off phase
    expect(series.matches('2017-08-03')).toBe(false) // before the first occurrence
    expect(series.matches('2017-11-09')).toBe(false) // second Thursday
  })

  it('ends after COUNT occurrences', () => {
    const { series, rrule, rfc, own } = check({ pattern, range: { type: 'numbered', startDate: '2017-08-29', numberOfOccurrences: 3 } })
    expect(rrule).toBe('FREQ=MONTHLY;INTERVAL=2;BYDAY=1TH;COUNT=3')
    expect(own(10)).toEqual(expected.slice(0, 3))
    expect(rfc(10)).toEqual(expected.slice(0, 3))
    expect(series.matches('2018-01-04')).toBe(true)
    expect(series.matches('2018-03-01')).toBe(false)
  })

  it('ends at the end date (UNTIL)', () => {
    const { series, rrule, rfc, own } = check({ pattern, range: { type: 'endDate', startDate: '2017-08-29', endDate: '2018-03-01' } }, '20180301')
    expect(series.end).toEqual({ kind: 'until', date: '2018-03-01' })
    expect(rrule).toBe('FREQ=MONTHLY;INTERVAL=2;BYDAY=1TH;UNTIL=20180301')
    expect(own(10)).toEqual(expected)
    expect(rfc(10)).toEqual(expected)
    expect(series.matches('2018-05-03')).toBe(false)
  })
})

describe('Graph recurrence patterns', () => {
  it('relative monthly with several days uses BYSETPOS, never several ordinal BYDAYs', () => {
    const first = check({ pattern: { type: 'relativeMonthly', interval: 1, daysOfWeek: ['friday', 'thursday'], index: 'first' }, range: noEnd('2026-11-01') })
    expect(first.rrule).toBe('FREQ=MONTHLY;INTERVAL=1;BYDAY=TH,FR;BYSETPOS=1')
    expect(first.own(3)).toEqual(['2026-11-05', '2026-12-03', '2027-01-01'])
    expect(first.rfc(3)).toEqual(['2026-11-05', '2026-12-03', '2027-01-01'])
    expect(first.series.matches('2026-11-06')).toBe(false)

    const last = check({ pattern: { type: 'relativeMonthly', interval: 1, daysOfWeek: ['thursday', 'friday'], index: 'last' }, range: noEnd('2026-11-01') })
    expect(last.rrule).toBe('FREQ=MONTHLY;INTERVAL=1;BYDAY=TH,FR;BYSETPOS=-1')
    expect(last.own(3)).toEqual(['2026-11-27', '2026-12-31', '2027-01-29'])
    expect(last.rfc(3)).toEqual(['2026-11-27', '2026-12-31', '2027-01-29'])
  })

  it('relative yearly: first Thursday-or-Friday of November 2026 is Nov 5 only', () => {
    const multi = check({ pattern: { type: 'relativeYearly', interval: 1, month: 11, daysOfWeek: ['thursday', 'friday'], index: 'first' }, range: noEnd('2026-01-01') })
    expect(multi.rrule).toBe('FREQ=YEARLY;INTERVAL=1;BYMONTH=11;BYDAY=TH,FR;BYSETPOS=1')
    expect(multi.own(3)).toEqual(['2026-11-05', '2027-11-04', '2028-11-02'])
    expect(multi.rfc(3)).toEqual(['2026-11-05', '2027-11-04', '2028-11-02'])

    const single = check({ pattern: { type: 'relativeYearly', interval: 1, month: 11, daysOfWeek: ['thursday'], index: 'fourth' }, range: { type: 'numbered', startDate: '2026-12-01', numberOfOccurrences: 2 } })
    expect(single.rrule).toBe('FREQ=YEARLY;INTERVAL=1;BYMONTH=11;BYDAY=4TH;COUNT=2')
    expect(single.own(5)).toEqual(['2027-11-25', '2028-11-23'])
    expect(single.rfc(5)).toEqual(['2027-11-25', '2028-11-23'])
  })

  it('weekly with an interval counts from the week of the first occurrence, with WKST from firstDayOfWeek', () => {
    const offPattern = check({ pattern: { type: 'weekly', interval: 2, daysOfWeek: ['monday', 'wednesday'], firstDayOfWeek: 'monday' }, range: noEnd('2026-06-04') })
    expect(offPattern.series.first).toBe('2026-06-08')
    expect(offPattern.rrule).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;WKST=MO')
    expect(offPattern.own(4)).toEqual(['2026-06-08', '2026-06-10', '2026-06-22', '2026-06-24'])
    expect(offPattern.rfc(4)).toEqual(['2026-06-08', '2026-06-10', '2026-06-22', '2026-06-24'])

    const sundayWeeks = check({ pattern: { type: 'weekly', interval: 2, daysOfWeek: ['saturday', 'sunday'], firstDayOfWeek: 'sunday' }, range: noEnd('2026-06-06') })
    expect(sundayWeeks.rrule).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,SA;WKST=SU')
    expect(sundayWeeks.own(4)).toEqual(['2026-06-06', '2026-06-14', '2026-06-20', '2026-06-28'])
    expect(sundayWeeks.rfc(4)).toEqual(['2026-06-06', '2026-06-14', '2026-06-20', '2026-06-28'])

    const mondayWeeks = check({ pattern: { type: 'weekly', interval: 2, daysOfWeek: ['saturday', 'sunday'], firstDayOfWeek: 'monday' }, range: noEnd('2026-06-06') })
    expect(mondayWeeks.rrule).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,SA;WKST=MO')
    expect(mondayWeeks.own(4)).toEqual(['2026-06-06', '2026-06-07', '2026-06-20', '2026-06-21'])
    expect(mondayWeeks.rfc(4)).toEqual(['2026-06-06', '2026-06-07', '2026-06-20', '2026-06-21'])
  })

  it('daily, absolute monthly and absolute yearly, with interval and off-pattern starts', () => {
    const daily = check({ pattern: { type: 'daily', interval: 3, daysOfWeek: [] }, range: { type: 'numbered', startDate: '2026-03-27', numberOfOccurrences: 4 } })
    expect(daily.rrule).toBe('FREQ=DAILY;INTERVAL=3;COUNT=4')
    expect(daily.own(10)).toEqual(['2026-03-27', '2026-03-30', '2026-04-02', '2026-04-05'])
    expect(daily.rfc(10)).toEqual(daily.own(10))
    expect(daily.series.matches('2026-03-28')).toBe(false)

    const monthly = check({ pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 15 }, range: noEnd('2026-01-20') })
    expect(monthly.rrule).toBe('FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15')
    expect(monthly.own(3)).toEqual(['2026-02-15', '2026-03-15', '2026-04-15'])
    expect(monthly.rfc(3)).toEqual(monthly.own(3))

    const yearly = check({ pattern: { type: 'absoluteYearly', interval: 2, month: 3, dayOfMonth: 1 }, range: noEnd('2026-04-01') })
    expect(yearly.rrule).toBe('FREQ=YEARLY;INTERVAL=2;BYMONTH=3;BYMONTHDAY=1')
    expect(yearly.own(3)).toEqual(['2027-03-01', '2029-03-01', '2031-03-01'])
    expect(yearly.rfc(3)).toEqual(yearly.own(3))
    expect(yearly.series.matches('2028-03-01')).toBe(false)
  })

  it('rejects what it cannot map exactly', () => {
    const bad: GraphRecurrence[] = [
      { pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 31 }, range: noEnd('2026-01-01') }, // short months undocumented
      { pattern: { type: 'absoluteYearly', interval: 1, month: 2, dayOfMonth: 29 }, range: noEnd('2026-01-01') },
      { pattern: { type: 'absoluteYearly', interval: 1, month: 4, dayOfMonth: 31 }, range: noEnd('2026-01-01') },
      { pattern: { type: 'hourly', interval: 1 }, range: noEnd('2026-01-01') },
      { pattern: { type: 'daily', interval: 0 }, range: noEnd('2026-01-01') },
      { pattern: { type: 'daily', interval: 1.5 }, range: noEnd('2026-01-01') },
      { pattern: { type: 'weekly', interval: 1, daysOfWeek: [] }, range: noEnd('2026-01-01') },
      { pattern: { type: 'weekly', interval: 1, daysOfWeek: ['funday'] }, range: noEnd('2026-01-01') },
      { pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday'], firstDayOfWeek: 'someday' }, range: noEnd('2026-01-01') },
      { pattern: { type: 'relativeMonthly', interval: 1, daysOfWeek: ['monday'], index: 'fifth' }, range: noEnd('2026-01-01') },
      { pattern: { type: 'relativeYearly', interval: 1, daysOfWeek: ['monday'], index: 'first' }, range: noEnd('2026-01-01') },
      { pattern: { type: 'daily', interval: 1 }, range: { type: 'noEnd' } },
      { pattern: { type: 'daily', interval: 1 }, range: noEnd('2026-02-30') },
      { pattern: { type: 'daily', interval: 1 }, range: { type: 'endDate', startDate: '2026-02-10', endDate: '2026-02-01' } },
      { pattern: { type: 'daily', interval: 1 }, range: { type: 'numbered', startDate: '2026-02-10', numberOfOccurrences: 0 } },
      { pattern: { type: 'daily', interval: 1 }, range: { type: 'forever', startDate: '2026-02-10' } },
      { range: noEnd('2026-01-01') },
    ]
    for (const recurrence of bad) expect(seriesPattern(recurrence), JSON.stringify(recurrence)).toBeNull()
    expect(seriesPattern(null)).toBeNull()
  })

  it('needs an UNTIL value for an end-date range', () => {
    const series = seriesPattern({ pattern: { type: 'daily', interval: 1 }, range: { type: 'endDate', startDate: '2026-01-01', endDate: '2026-01-05' } })!
    expect(rruleFor(series)).toBeNull()
    expect(rruleFor(series, '20260105T225959Z')).toBe('FREQ=DAILY;INTERVAL=1;UNTIL=20260105T225959Z')
  })
})
