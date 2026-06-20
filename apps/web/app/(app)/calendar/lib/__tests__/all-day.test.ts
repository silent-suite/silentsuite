import { describe, it, expect } from 'vitest'
import 'temporal-polyfill/global'
import {
  isMultiDayTimedRange,
  toAllDayEndPlainDate,
  inclusiveAllDayEndDate,
  toTimedMonthEndPlainDate,
} from '../all-day'

describe('toAllDayEndPlainDate', () => {
  it('returns the start day for a single-day event with iCal-exclusive DTEND', () => {
    // Birthday on 2026-05-05 — iCal: DTSTART:20260505 DTEND:20260506
    const start = new Date(2026, 4, 5)
    const end = new Date(2026, 4, 6)
    const pd = toAllDayEndPlainDate(start, end)
    expect(pd.toString()).toBe('2026-05-05')
  })

  it('returns the inclusive last day for a multi-day event', () => {
    // 3-day event 2026-05-05 → 2026-05-07 — iCal: DTSTART:20260505 DTEND:20260508
    const start = new Date(2026, 4, 5)
    const end = new Date(2026, 4, 8)
    const pd = toAllDayEndPlainDate(start, end)
    expect(pd.toString()).toBe('2026-05-07')
  })

  it('clamps to start when DTEND === DTSTART (zero-duration / malformed event)', () => {
    const start = new Date(2026, 4, 5)
    const end = new Date(2026, 4, 5)
    const pd = toAllDayEndPlainDate(start, end)
    expect(pd.toString()).toBe('2026-05-05')
  })

  it('handles month boundaries', () => {
    // Event on 2026-05-31 — iCal: DTSTART:20260531 DTEND:20260601
    const start = new Date(2026, 4, 31)
    const end = new Date(2026, 5, 1)
    const pd = toAllDayEndPlainDate(start, end)
    expect(pd.toString()).toBe('2026-05-31')
  })

  it('handles year boundaries', () => {
    // Event on 2026-12-31 — iCal: DTSTART:20261231 DTEND:20270101
    const start = new Date(2026, 11, 31)
    const end = new Date(2027, 0, 1)
    const pd = toAllDayEndPlainDate(start, end)
    expect(pd.toString()).toBe('2026-12-31')
  })

  it('preserves the calendar day across a leap day', () => {
    // 4-year event ending 2028-02-29 — iCal: DTSTART:20280225 DTEND:20280301
    const start = new Date(2028, 1, 25)
    const end = new Date(2028, 2, 1)
    const pd = toAllDayEndPlainDate(start, end)
    expect(pd.toString()).toBe('2028-02-29')
  })
})

describe('inclusiveAllDayEndDate', () => {
  it('subtracts one calendar day from an iCal-exclusive end date', () => {
    const exclusive = new Date(2026, 4, 6, 0, 0, 0, 0)
    const inclusive = inclusiveAllDayEndDate(exclusive)
    expect(inclusive.getFullYear()).toBe(2026)
    expect(inclusive.getMonth()).toBe(4)
    expect(inclusive.getDate()).toBe(5)
    // Must be local-midnight, not 23:00 — otherwise getDate() in DST zones drifts.
    expect(inclusive.getHours()).toBe(0)
    expect(inclusive.getMinutes()).toBe(0)
  })

  it('lands on the correct calendar day across spring-forward', () => {
    // 2026-03-29 is the Berlin DST start (02:00 → 03:00). The day has 23 hours.
    // An event ending 2026-03-30 (iCal-exclusive) should yield 2026-03-29 in the form,
    // not 2026-03-28 (which raw `getTime() - 86_400_000` would produce in Berlin).
    const exclusive = new Date(2026, 2, 30, 0, 0, 0, 0)
    const inclusive = inclusiveAllDayEndDate(exclusive)
    expect(inclusive.getFullYear()).toBe(2026)
    expect(inclusive.getMonth()).toBe(2)
    expect(inclusive.getDate()).toBe(29)
  })

  it('handles year boundaries', () => {
    const exclusive = new Date(2027, 0, 1, 0, 0, 0, 0)
    const inclusive = inclusiveAllDayEndDate(exclusive)
    expect(inclusive.getFullYear()).toBe(2026)
    expect(inclusive.getMonth()).toBe(11)
    expect(inclusive.getDate()).toBe(31)
  })
})

describe('timed multi-day month rendering helpers', () => {
  it('detects timed ranges that cross a local date boundary', () => {
    expect(
      isMultiDayTimedRange(
        new Date(2026, 4, 5, 22, 0),
        new Date(2026, 4, 6, 1, 0),
      ),
    ).toBe(true)

    expect(
      isMultiDayTimedRange(
        new Date(2026, 4, 5, 9, 0),
        new Date(2026, 4, 5, 17, 0),
      ),
    ).toBe(false)
  })

  it('uses the end date as the inclusive month-bar end for timed multi-day appointments', () => {
    const start = new Date(2026, 4, 5, 9, 0)
    const end = new Date(2026, 4, 7, 11, 30)

    expect(toTimedMonthEndPlainDate(start, end).toString()).toBe('2026-05-07')
  })

  it('does not paint a timed appointment onto a final midnight-only day', () => {
    const start = new Date(2026, 4, 5, 9, 0)
    const end = new Date(2026, 4, 7, 0, 0, 0, 0)

    expect(toTimedMonthEndPlainDate(start, end).toString()).toBe('2026-05-06')
  })

  it('clamps malformed timed month ranges to the start day', () => {
    const start = new Date(2026, 4, 5, 9, 0)
    const end = new Date(2026, 4, 4, 11, 0)

    expect(toTimedMonthEndPlainDate(start, end).toString()).toBe('2026-05-05')
  })
})
