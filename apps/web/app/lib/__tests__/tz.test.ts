import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  partsInZone,
  formatDateForInputInZone,
  formatTimeForInputInZone,
  instantFromWallClock,
  resolveUserTimezone,
  shortTimezoneLabel,
  timezoneOptions,
  timezoneDisplayName,
  zonesShowDifferentTimes,
} from '../tz'

describe('tz helpers', () => {
  afterEach(() => vi.useRealTimers())

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
  describe('shortTimezoneLabel', () => {
    it('returns the short label for a valid timezone at a fixed reference date', () => {
      const fixedDate = new Date('2026-01-15T12:00:00Z')
      expect(shortTimezoneLabel('UTC', fixedDate)).toBe('UTC')
    })

    it('returns the original timezone when the zone is invalid', () => {
      const fixedDate = new Date('2026-01-15T12:00:00Z')
      expect(shortTimezoneLabel('Not/A_Real_Zone', fixedDate)).toBe('Not/A_Real_Zone')
    })

    it('uses the current date when the reference date is omitted', () => {
      const fixedDate = new Date('2026-01-15T12:00:00Z')
      vi.useFakeTimers()
      vi.setSystemTime(fixedDate)

      expect(shortTimezoneLabel('Europe/Berlin')).toBe(
        shortTimezoneLabel('Europe/Berlin', fixedDate),
      )
    })
  })

  describe('timezoneOptions', () => {
    it('always offers UTC first, once', () => {
      const options = timezoneOptions('UTC')
      expect(options[0]).toBe('UTC')
      expect(options.filter((tz) => tz === 'UTC')).toHaveLength(1)
      expect(options).toContain('Europe/Berlin')
    })

    it('keeps a stored zone the browser does not list, such as a legacy alias', () => {
      const options = timezoneOptions('US/Pacific')
      expect(options.slice(0, 2)).toEqual(['US/Pacific', 'UTC'])
    })

    it('does not move a listed zone out of order', () => {
      const options = timezoneOptions('Europe/Berlin')
      expect(options[0]).toBe('UTC')
      expect(options.filter((tz) => tz === 'Europe/Berlin')).toHaveLength(1)
    })

    it('still offers UTC and the stored zone when the list is unavailable', () => {
      const spy = vi.spyOn(Intl, 'supportedValuesOf').mockImplementation(() => {
        throw new TypeError('unsupported')
      })
      try {
        expect(timezoneOptions('Europe/Berlin')).toEqual(['Europe/Berlin', 'UTC'])
        expect(timezoneOptions()).toEqual(['UTC'])
      } finally {
        spy.mockRestore()
      }
    })
  })

  describe('timezoneDisplayName', () => {
    it('names the zone and its offset on the given date', () => {
      expect(timezoneDisplayName('Europe/Berlin', new Date(Date.UTC(2026, 0, 15)))).toBe('Europe/Berlin (GMT+1)')
      expect(timezoneDisplayName('Europe/Berlin', new Date(Date.UTC(2026, 6, 15)))).toBe('Europe/Berlin (GMT+2)')
    })

    it('reads underscores as spaces and does not repeat UTC', () => {
      expect(timezoneDisplayName('America/New_York', new Date(Date.UTC(2026, 0, 15)))).toBe('America/New York (EST)')
      expect(timezoneDisplayName('UTC')).toBe('UTC')
    })
  })

  describe('zonesShowDifferentTimes', () => {
    it('is false for the same zone or zones on the same clock', () => {
      const winter = new Date(Date.UTC(2026, 0, 15, 12))
      expect(zonesShowDifferentTimes('Europe/Berlin', 'Europe/Berlin', winter)).toBe(false)
      expect(zonesShowDifferentTimes('Europe/Berlin', 'Europe/Paris', winter)).toBe(false)
    })

    it('is true when the clocks read differently', () => {
      const winter = new Date(Date.UTC(2026, 0, 15, 12))
      expect(zonesShowDifferentTimes('Europe/Berlin', 'UTC', winter)).toBe(true)
      expect(zonesShowDifferentTimes('Europe/Berlin', 'America/New_York', winter)).toBe(true)
    })
  })
})
