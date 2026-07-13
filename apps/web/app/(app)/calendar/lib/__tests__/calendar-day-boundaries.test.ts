import { describe, expect, it } from 'vitest'
import {
  formatDayBoundary,
  getScheduleXWeekLayout,
  hourToScheduleXTimePoint,
  toScheduleXDayBoundariesExternal,
  toScheduleXDayBoundariesInternal,
} from '../calendar-day-boundaries'

describe('calendar day boundaries', () => {
  it('formats external Schedule-X config as HH:00 strings', () => {
    expect(formatDayBoundary(0)).toBe('00:00')
    expect(formatDayBoundary(6)).toBe('06:00')
    expect(formatDayBoundary(24)).toBe('24:00')
    expect(toScheduleXDayBoundariesExternal(7, 23)).toEqual({ start: '07:00', end: '23:00' })
  })

  it('formats live Schedule-X signal updates as internal numeric time points', () => {
    expect(hourToScheduleXTimePoint(0)).toBe(0)
    expect(hourToScheduleXTimePoint(6)).toBe(600)
    expect(hourToScheduleXTimePoint(24)).toBe(2400)
    expect(toScheduleXDayBoundariesInternal(7, 23)).toEqual({ start: 700, end: 2300 })
  })

  it('keeps hour rows within a readable adaptive density range', () => {
    expect(getScheduleXWeekLayout(8, 22, 900)).toEqual({ startHour: 8, endHour: 22, gridHeight: 900 })
    expect(getScheduleXWeekLayout(8, 22, 1600)).toEqual({ startHour: 1, endHour: 24, gridHeight: 1600 })
    expect(getScheduleXWeekLayout(9, 10, 900)).toEqual({ startHour: 3, endHour: 16, gridHeight: 900 })
    expect(getScheduleXWeekLayout(8, 22, 500)).toEqual({ startHour: 8, endHour: 22, gridHeight: 672 })
  })

  it('expands outward to include required timed-event hours without shrinking preferences', () => {
    expect(getScheduleXWeekLayout(7, 23, 0, { startHour: 2, endHour: 3 })).toEqual({
      startHour: 2,
      endHour: 23,
      gridHeight: 1344,
    })
    expect(getScheduleXWeekLayout(7, 23, 0, { startHour: 0, endHour: 24 })).toEqual({
      startHour: 0,
      endHour: 24,
      gridHeight: 1536,
    })
  })
})
