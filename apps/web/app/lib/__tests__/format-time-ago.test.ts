import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatTimeAgo } from '../format-time-ago'

const NOW = new Date(2026, 5, 9, 12, 0, 0)

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms)
}

describe('formatTimeAgo', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns "just now" at 4 seconds', () => {
    expect(formatTimeAgo(ago(4 * SECOND))).toBe('just now')
  })

  it('returns seconds at 5 seconds', () => {
    expect(formatTimeAgo(ago(5 * SECOND))).toBe('5s ago')
  })

  it('returns seconds at 59 seconds', () => {
    expect(formatTimeAgo(ago(59 * SECOND))).toBe('59s ago')
  })

  it('returns minutes at 60 seconds', () => {
    expect(formatTimeAgo(ago(60 * SECOND))).toBe('1 min ago')
  })

  it('returns minutes at 59 minutes', () => {
    expect(formatTimeAgo(ago(59 * MINUTE))).toBe('59 min ago')
  })

  it('returns hours at 60 minutes', () => {
    expect(formatTimeAgo(ago(60 * MINUTE))).toBe('1 hr ago')
  })

  it('returns hours at 23 hours', () => {
    expect(formatTimeAgo(ago(23 * HOUR))).toBe('23 hr ago')
  })

  it('returns days at 24 hours', () => {
    expect(formatTimeAgo(ago(24 * HOUR))).toBe('1d ago')
  })

  it('returns "just now" for a future timestamp', () => {
    expect(formatTimeAgo(ago(-10 * SECOND))).toBe('just now')
  })
})
