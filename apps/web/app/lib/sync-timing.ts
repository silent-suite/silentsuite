const GLOBAL_CALENDAR_SYNC_STARTED_AT = '__silentsuiteCalendarSyncStartedAt'
const LOCAL_STORAGE_SYNC_TIMING = 'silentsuite:syncTiming'

export interface SyncTimingFields {
  [key: string]: string | number | boolean | null | undefined
}

export function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

export function elapsedMs(startedAt: number, endedAt = nowMs()): number {
  return Math.max(0, Math.round(endedAt - startedAt))
}

export function markCalendarSyncStart(startedAt = nowMs()): number {
  ;(globalThis as unknown as Record<string, number>)[GLOBAL_CALENDAR_SYNC_STARTED_AT] = startedAt
  return startedAt
}

export function getCalendarSyncStartedAt(): number | null {
  const value = (globalThis as unknown as Record<string, unknown>)[GLOBAL_CALENDAR_SYNC_STARTED_AT]
  return typeof value === 'number' ? value : null
}

/**
 * Timing logs are enabled automatically in local development. Production and
 * Cloudflare preview builds can enable them before reload with:
 *
 *   localStorage.setItem('silentsuite:syncTiming', 'true')
 *
 * or on a single page load with `?syncTiming=1`. Logged fields are counts,
 * booleans, phase names, and durations only — never PIM content or IDs.
 */
export function isSyncTimingEnabled(): boolean {
  if (process.env.NODE_ENV !== 'production') return true
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(LOCAL_STORAGE_SYNC_TIMING) === 'true' ||
      new URLSearchParams(window.location.search).get('syncTiming') === '1'
  } catch {
    return false
  }
}

function logTiming(label: string, payload: SyncTimingFields): void {
  if (!isSyncTimingEnabled()) return
  console.info(label, payload)
}

export function logSyncTiming(phase: string, startedAt: number, fields: SyncTimingFields = {}): void {
  logTiming('[sync-provider] timing', {
    phase,
    elapsedMs: elapsedMs(startedAt),
    ...fields,
  })
}

export function logCalendarPaintTiming(fields: SyncTimingFields = {}): void {
  const syncStartedAt = getCalendarSyncStartedAt()
  logTiming('[calendar-grid] timing', {
    phase: 'first-events-paint',
    elapsedSinceSyncStartMs: syncStartedAt === null ? null : elapsedMs(syncStartedAt),
    ...fields,
  })
}
