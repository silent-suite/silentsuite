import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  elapsedMs,
  getCalendarSyncStartedAt,
  isSyncTimingEnabled,
  logCalendarPaintTiming,
  logSyncTiming,
  markCalendarSyncStart,
} from '../sync-timing'

describe('sync timing helpers', () => {
  const originalNodeEnv = process.env.NODE_ENV

  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    delete (globalThis as unknown as Record<string, unknown>).__silentsuiteCalendarSyncStartedAt
    window.localStorage.clear()
    window.history.replaceState(null, '', '/')
    process.env.NODE_ENV = originalNodeEnv
  })

  it('rounds elapsed milliseconds without going negative', () => {
    expect(elapsedMs(10, 42.4)).toBe(32)
    expect(elapsedMs(42, 10)).toBe(0)
  })

  it('stores and reads the calendar sync start marker', () => {
    markCalendarSyncStart(123)
    expect(getCalendarSyncStartedAt()).toBe(123)
  })

  it('enables timing logs in production only when explicitly requested', () => {
    process.env.NODE_ENV = 'production'

    expect(isSyncTimingEnabled()).toBe(false)

    window.localStorage.setItem('silentsuite:syncTiming', 'true')
    expect(isSyncTimingEnabled()).toBe(true)

    window.localStorage.clear()
    window.history.replaceState(null, '', '/calendar?syncTiming=1')
    expect(isSyncTimingEnabled()).toBe(true)
  })

  it('logs privacy-safe sync timing fields when enabled', () => {
    process.env.NODE_ENV = 'production'
    window.localStorage.setItem('silentsuite:syncTiming', 'true')

    logSyncTiming('calendar-fetch', 100, { itemCount: 12, source: 'server' })

    expect(console.info).toHaveBeenCalledWith('[sync-provider] timing', expect.objectContaining({
      phase: 'calendar-fetch',
      itemCount: 12,
      source: 'server',
      elapsedMs: expect.any(Number),
    }))
  })

  it('logs first paint relative to the sync marker when available', () => {
    process.env.NODE_ENV = 'production'
    window.localStorage.setItem('silentsuite:syncTiming', 'true')
    markCalendarSyncStart(100)

    logCalendarPaintTiming({ eventCount: 5 })

    expect(console.info).toHaveBeenCalledWith('[calendar-grid] timing', expect.objectContaining({
      phase: 'first-events-paint',
      elapsedSinceSyncStartMs: expect.any(Number),
      eventCount: 5,
    }))
  })
})
