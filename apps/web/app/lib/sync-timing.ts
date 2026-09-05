const GLOBAL_SYNC_TIMING_STARTED_AT = '__silentsuiteSyncTimingStartedAt'
const LOCAL_STORAGE_SYNC_TIMING = 'silentsuite:syncTiming'
const CONSOLE_LABEL = '[silentsuite-sync-timing]'

export type SyncTimingPhase =
  | 'cache-capability'
  | 'cache-hydrate'
  | 'cache-hydrate-failed'
  | 'cache-mirror'
  | 'cache-mirror-failed'
  | 'etebase-initialize'
  | 'load-items'
  | 'tasks-load'
  | 'contacts-load'
  | 'calendar-load'
  | 'notes-load'
  | 'wire-change-handler'
  | 'wire-status-handler'
  | 'initial-sync-complete'
  | 'initial-sync-failed'
  | 'first-calendar-content-paint'

export type SyncTimingErrorCategory =
  | 'unknown'
  | 'network'
  | 'storage'
  | 'deserialize'
  | 'cache'
  | 'etebase'
  | 'syncEngine'
  | 'Error'

export interface SyncTimingFields {
  [key: string]: unknown
}

type SafeTimingValue = string | number | boolean | null

type SafeTimingPayload = Record<string, SafeTimingValue>

const VALID_PHASES = new Set<SyncTimingPhase>([
  'cache-capability',
  'cache-hydrate',
  'cache-hydrate-failed',
  'cache-mirror',
  'cache-mirror-failed',
  'etebase-initialize',
  'load-items',
  'tasks-load',
  'contacts-load',
  'calendar-load',
  'notes-load',
  'wire-change-handler',
  'wire-status-handler',
  'initial-sync-complete',
  'initial-sync-failed',
  'first-calendar-content-paint',
])

const VALID_STRING_FIELDS: Record<string, Set<string>> = {
  phase: VALID_PHASES,
  source: new Set(['cache', 'server', 'provider', 'calendar-page']),
  status: new Set(['ok', 'failed', 'skipped']),
  group: new Set(['startup', 'cache', 'server', 'handlers', 'calendar']),
  type: new Set(['tasks', 'contacts', 'calendar', 'notes']),
  view: new Set(['day', 'week', 'month', 'threeDay', 'sevenDay', 'agenda']),
  errorCategory: new Set(['unknown', 'network', 'storage', 'deserialize', 'cache', 'etebase', 'syncEngine', 'Error']),
}

const VALID_FIELD_NAMES = new Set([
  'phase',
  'elapsedMs',
  'elapsedSinceSyncStartMs',
  'source',
  'status',
  'group',
  'type',
  'view',
  'errorCategory',
  'featureFlagEnabled',
  'encryptedEnvelopeAvailable',
  'enabled',
  'cacheEnabled',
  'hadErrors',
  'hasEvents',
  'itemCount',
  'taskItemCount',
  'contactItemCount',
  'calendarItemCount',
  'noteItemCount',
  'taskCount',
  'contactCount',
  'eventCount',
  'noteCount',
  'visibleEventCount',
  'totalEventCount',
  'visibleCalendarCount',
])

function safeWindow(): Window | null {
  if (typeof window === 'undefined') return null
  return window
}

function readTimingOptIn(): boolean {
  const win = safeWindow()
  if (!win) return false
  try {
    if (new URLSearchParams(win.location.search).get('syncTiming') === '1') return true
  } catch {
    // Best-effort debug gate only.
  }
  try {
    return win.localStorage?.getItem(LOCAL_STORAGE_SYNC_TIMING) === 'true'
  } catch {
    return false
  }
}

export function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

export function elapsedMs(startedAt: number, endedAt = nowMs()): number {
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return 0
  return Math.max(0, Math.round(endedAt - startedAt))
}

export function markSyncTimingStart(startedAt = nowMs()): number {
  ;(globalThis as unknown as Record<string, number>)[GLOBAL_SYNC_TIMING_STARTED_AT] = startedAt
  return startedAt
}

export function getSyncTimingStartedAt(): number | null {
  const value = (globalThis as unknown as Record<string, unknown>)[GLOBAL_SYNC_TIMING_STARTED_AT]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function isSyncTimingEnabled(): boolean {
  if (process.env.NODE_ENV !== 'production') return true
  return readTimingOptIn()
}

export function safeTimingErrorCategory(value: unknown): SyncTimingErrorCategory {
  if (typeof value !== 'string') return 'unknown'
  if (VALID_STRING_FIELDS.errorCategory.has(value)) return value as SyncTimingErrorCategory
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value) ? 'Error' : 'unknown'
}

export function sanitizeSyncTimingPayload(payload: SyncTimingFields): SafeTimingPayload {
  const safe: SafeTimingPayload = {}
  for (const [key, value] of Object.entries(payload)) {
    if (!VALID_FIELD_NAMES.has(key)) continue
    if (typeof value === 'boolean' || value === null) {
      safe[key] = value
      continue
    }
    if (typeof value === 'number') {
      if (Number.isFinite(value) && value >= 0) safe[key] = Math.round(value)
      continue
    }
    if (typeof value === 'string') {
      const validValues = VALID_STRING_FIELDS[key]
      if (key === 'errorCategory') {
        safe[key] = safeTimingErrorCategory(value)
      } else if (validValues?.has(value)) {
        safe[key] = value
      }
    }
  }
  return safe
}

function emitTiming(payload: SafeTimingPayload): void {
  if (!isSyncTimingEnabled()) return
  try {
    console.info(CONSOLE_LABEL, JSON.stringify(Object.freeze({ ...payload })))
  } catch {
    // Timing diagnostics must never affect app behavior.
  }
}

export function logSyncTiming(phase: SyncTimingPhase, startedAt: number, fields: SyncTimingFields = {}): void {
  try {
    emitTiming(sanitizeSyncTimingPayload({
      phase,
      elapsedMs: elapsedMs(startedAt),
      ...fields,
    }))
  } catch {
    // Timing diagnostics must never affect app behavior.
  }
}

export function logCalendarPaintTiming(fields: SyncTimingFields = {}): void {
  try {
    const syncStartedAt = getSyncTimingStartedAt()
    emitTiming(sanitizeSyncTimingPayload({
      phase: 'first-calendar-content-paint',
      elapsedSinceSyncStartMs: syncStartedAt === null ? null : elapsedMs(syncStartedAt),
      source: 'calendar-page',
      ...fields,
    }))
  } catch {
    // Timing diagnostics must never affect app behavior.
  }
}
