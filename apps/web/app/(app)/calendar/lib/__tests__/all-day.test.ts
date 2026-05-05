import { describe, it, expect } from 'vitest'
import 'temporal-polyfill/global'
import { toAllDayEndPlainDate } from '../all-day'

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
})
