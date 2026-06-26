import { describe, expect, it } from 'vitest'
import {
  formatDayBoundary,
  hourToScheduleXTimePoint,
  toScheduleXDayBoundariesExternal,
  toScheduleXDayBoundariesInternal,
} from '../calendar-day-boundaries'

describe('calendar day boundaries', () => {
  it('formats external Schedule-X config as HH:00 strings', () => {
    expect(formatDayBoundary(0)).toBe('00:00')
    expect(formatDayBoundary(6)).toBe('06:00')
    expect(formatDayBoundary(24)).toBe('24:00')
    expect(toScheduleXDayBoundariesExternal(0, 24)).toEqual({ start: '00:00', end: '24:00' })
  })

  it('formats live Schedule-X signal updates as internal numeric time points', () => {
    expect(hourToScheduleXTimePoint(0)).toBe(0)
    expect(hourToScheduleXTimePoint(6)).toBe(600)
    expect(hourToScheduleXTimePoint(24)).toBe(2400)
    expect(toScheduleXDayBoundariesInternal(0, 24)).toEqual({ start: 0, end: 2400 })
  })
})
