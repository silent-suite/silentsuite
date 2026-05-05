import { describe, it, expect } from 'vitest'
import {
  partsInZone,
  formatDateForInputInZone,
  formatTimeForInputInZone,
  instantFromWallClock,
  resolveUserTimezone,
} from '../tz'

describe('tz helpers', () => {
  it('reads wall-clock parts in the requested zone', () => {
    // 2025-06-15 12:00 UTC = 14:00 Europe/Berlin (CEST)
    const utcInstant = new Date(Date.UTC(2025, 5, 15, 12, 0, 0))
    const berlin = partsInZone(utcInstant, 'Europe/Berlin')
    expect(berlin).toEqual({ year: 2025, month: 6, day: 15, hour: 14, minute: 0, second: 0 })

    const tokyo = partsInZone(utcInstant, 'Asia/Tokyo')
    expect(tokyo).toEqual({ year: 2025, month: 6, day: 15, hour: 21, minute: 0, second: 0 })
  })

  it('round-trips a wall-clock through instantFromWallClock + partsInZone', () => {
    const tz = 'America/New_York'
    const instant = instantFromWallClock(2025, 11, 4, 9, 30, tz)
    const parts = partsInZone(instant, tz)
    expect(parts).toEqual({ year: 2025, month: 11, day: 4, hour: 9, minute: 30, second: 0 })
  })

  it('handles different DST/standard time correctly', () => {
    // 09:00 NY in June (EDT, UTC-4) -> 13:00 UTC
    const summer = instantFromWallClock(2025, 6, 15, 9, 0, 'America/New_York')
    expect(summer.toISOString()).toBe('2025-06-15T13:00:00.000Z')

    // 09:00 NY in January (EST, UTC-5) -> 14:00 UTC
    const winter = instantFromWallClock(2025, 1, 15, 9, 0, 'America/New_York')
    expect(winter.toISOString()).toBe('2025-01-15T14:00:00.000Z')
  })

  it('formats date/time inputs in the target zone', () => {
    // 2025-06-15 23:30 UTC = 2025-06-16 08:30 Tokyo
    const instant = new Date(Date.UTC(2025, 5, 15, 23, 30, 0))
    expect(formatDateForInputInZone(instant, 'Asia/Tokyo')).toBe('2025-06-16')
    expect(formatTimeForInputInZone(instant, 'Asia/Tokyo')).toBe('08:30')
    expect(formatDateForInputInZone(instant, 'America/New_York')).toBe('2025-06-15')
    expect(formatTimeForInputInZone(instant, 'America/New_York')).toBe('19:30')
  })

  it('falls back to browser-local when the preferred TZ is invalid', () => {
    const browser = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(resolveUserTimezone(undefined)).toBe(browser)
    expect(resolveUserTimezone('Not/A_Real_Zone')).toBe(browser)
    expect(resolveUserTimezone('Europe/Berlin')).toBe('Europe/Berlin')
  })
})
