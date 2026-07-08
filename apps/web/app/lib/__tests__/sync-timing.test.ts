import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  elapsedMs,
  getSyncTimingStartedAt,
  isSyncTimingEnabled,
  logCalendarPaintTiming,
  logSyncTiming,
  markSyncTimingStart,
  safeTimingErrorCategory,
  sanitizeSyncTimingPayload,
} from '../sync-timing'

describe('sync timing helpers', () => {
  const originalNodeEnv = process.env.NODE_ENV

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    delete (globalThis as unknown as Record<string, unknown>).__silentsuiteSyncTimingStartedAt
    window.localStorage.clear()
    window.history.replaceState(null, '', '/')
    process.env.NODE_ENV = originalNodeEnv
  })

  it('rounds elapsed milliseconds without going negative', () => {
    expect(elapsedMs(10, 42.4)).toBe(32)
    expect(elapsedMs(42, 10)).toBe(0)
    expect(elapsedMs(Number.NaN, 10)).toBe(0)
  })

  it('stores and reads a module-level sync start marker', () => {
    markSyncTimingStart(123)
    expect(getSyncTimingStartedAt()).toBe(123)
    expect(window.sessionStorage.getItem('__silentsuiteSyncTimingStartedAt')).toBeNull()
    expect(window.localStorage.getItem('__silentsuiteSyncTimingStartedAt')).toBeNull()
  })

  it('does not enable preview or production timing without explicit opt-in', () => {
    process.env.NODE_ENV = 'production'
    window.history.replaceState(null, '', '/calendar')
    expect(isSyncTimingEnabled()).toBe(false)

    window.history.replaceState(null, '', '/calendar')
    expect(isSyncTimingEnabled()).toBe(false)
  })

  it('enables timing in production only for exact query or localStorage opt-in', () => {
    process.env.NODE_ENV = 'production'

    window.history.replaceState(null, '', '/calendar?syncTiming=true')
    expect(isSyncTimingEnabled()).toBe(false)

    window.history.replaceState(null, '', '/calendar?syncTiming=0')
    expect(isSyncTimingEnabled()).toBe(false)

    window.history.replaceState(null, '', '/calendar?syncTiming=1')
    expect(isSyncTimingEnabled()).toBe(true)

    window.history.replaceState(null, '', '/calendar')
    window.localStorage.setItem('silentsuite:syncTiming', 'yes')
    expect(isSyncTimingEnabled()).toBe(false)

    window.localStorage.setItem('silentsuite:syncTiming', 'true')
    expect(isSyncTimingEnabled()).toBe(true)
  })

  it('sanitizes payloads and drops unknown or unsafe values', () => {
    const sanitized = sanitizeSyncTimingPayload({
      phase: 'calendar-load',
      source: 'server',
      itemCount: 12.3,
      cacheEnabled: true,
      unknownSecret: 'token=secret',
      itemUid: 'item-secret',
      collectionUid: 'collection-secret',
      url: 'https://server.example/private?token=secret',
      view: 'week',
      status: 'ok',
      errorCategory: 'user@example.com token=secret',
      rawError: new Error('secret'),
      negative: -1,
    })

    expect(sanitized).toEqual({
      phase: 'calendar-load',
      source: 'server',
      itemCount: 12,
      cacheEnabled: true,
      view: 'week',
      status: 'ok',
      errorCategory: 'unknown',
    })
    expect(JSON.stringify(sanitized)).not.toContain('secret')
    expect(JSON.stringify(sanitized)).not.toContain('item-secret')
    expect(JSON.stringify(sanitized)).not.toContain('collection-secret')
  })

  it('never trusts unsafe error names', () => {
    expect(safeTimingErrorCategory('cache')).toBe('cache')
    expect(safeTimingErrorCategory('user@example.com token=secret')).toBe('unknown')
    expect(safeTimingErrorCategory(new Error('message'))).toBe('unknown')
  })

  it('emits only a sanitized JSON copy, not the caller payload object', () => {
    process.env.NODE_ENV = 'production'
    window.localStorage.setItem('silentsuite:syncTiming', 'true')
    const payload = { itemCount: 1, itemUid: 'item-secret' }

    logSyncTiming('calendar-load', 100, payload)

    expect(console.info).toHaveBeenCalledTimes(1)
    const [label, json] = vi.mocked(console.info).mock.calls[0]!
    expect(label).toBe('[silentsuite-sync-timing]')
    expect(typeof json).toBe('string')
    expect(json).toContain('calendar-load')
    expect(json).not.toContain('item-secret')
  })

  it('logs first calendar content paint relative to the sync marker', () => {
    process.env.NODE_ENV = 'production'
    window.history.replaceState(null, '', '/calendar?syncTiming=1')
    markSyncTimingStart(100)

    logCalendarPaintTiming({ view: 'week', visibleEventCount: 2, totalEventCount: 3, hasEvents: true })

    expect(console.info).toHaveBeenCalledTimes(1)
    const json = vi.mocked(console.info).mock.calls[0]![1] as string
    expect(json).toContain('first-calendar-content-paint')
    expect(json).toContain('visibleEventCount')
    expect(json).not.toContain('calendarId')
  })

  it('does not throw when localStorage or console are unavailable', () => {
    process.env.NODE_ENV = 'production'
    vi.spyOn(window.localStorage.__proto__, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked')
    })
    vi.mocked(console.info).mockImplementation(() => {
      throw new Error('console blocked')
    })

    expect(() => logSyncTiming('cache-capability', 1, { enabled: true })).not.toThrow()
  })
})
