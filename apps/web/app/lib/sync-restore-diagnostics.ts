import { BILLING_API_URL, ETEBASE_SERVER_URL } from '@/app/lib/config'
import { getSafeErrorName } from '@/app/lib/privacy-safe-errors'

export const RESTORE_DIAGNOSTICS_STORAGE_KEY = 'silentsuite.restore-diagnostics.v1'

export type RestoreDiagnosticPhase =
  | 'sessionRead'
  | 'sessionPersistence'
  | 'restoreSession'
  | 'ensureCollections'
  | 'hydrateLists'
  | 'listItems:calendar'
  | 'listItems:tasks'
  | 'listItems:contacts'
  | 'syncEngineTrackCollections'
  | 'syncEngineStart'
  | 'unknown'

export type RestoreDiagnosticStatus = 'ok' | 'failed' | 'skipped'

export interface SessionPersistenceShape {
  present: boolean
  parseableJson: boolean
  shape: 'missing' | 'empty' | 'json' | 'string'
}

export interface RestoreDiagnosticEntry {
  phase: RestoreDiagnosticPhase
  status: RestoreDiagnosticStatus
  durationMs?: number
  errorName?: string
  session?: SessionPersistenceShape
  roundtripMatch?: boolean
  collectionType?: 'calendar' | 'tasks' | 'contacts'
  collectionCount?: number
  itemCount?: number
  pageCount?: number
}

export interface RestoreDiagnosticsSnapshot {
  version: 1
  source: 'login' | 'restore'
  generatedAtMs: number
  etebaseHost: string
  billingHost: string
  failedPhase: RestoreDiagnosticPhase | null
  entries: RestoreDiagnosticEntry[]
}

interface RecorderInit {
  source: 'login' | 'restore'
  etebaseServerUrl?: string
  billingApiUrl?: string
  now?: () => number
}

interface PhaseStart {
  phase: RestoreDiagnosticPhase
  startedAtMs: number
}

function safeHostname(url: string | undefined, fallback: string): string {
  if (!url) return fallback
  try {
    return new URL(url).hostname || fallback
  } catch {
    return fallback
  }
}

function safeStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage ?? null
  } catch {
    return null
  }
}

function safeLocalStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage ?? null
  } catch {
    return null
  }
}

export function classifySessionPersistence(value: string | null | undefined): SessionPersistenceShape {
  if (value == null) return { present: false, parseableJson: false, shape: 'missing' }
  if (value === '') return { present: false, parseableJson: false, shape: 'empty' }
  try {
    JSON.parse(value)
    return { present: true, parseableJson: true, shape: 'json' }
  } catch {
    return { present: true, parseableJson: false, shape: 'string' }
  }
}

export class RestoreDiagnosticsRecorder {
  private readonly now: () => number
  private readonly entries: RestoreDiagnosticEntry[] = []
  private readonly source: 'login' | 'restore'
  private readonly etebaseHost: string
  private readonly billingHost: string
  private generatedAtMs: number
  private activePhase: PhaseStart | null = null
  private failedPhase: RestoreDiagnosticPhase | null = null

  constructor(init: RecorderInit) {
    this.now = init.now ?? (() => Date.now())
    this.generatedAtMs = this.now()
    this.source = init.source
    this.etebaseHost = safeHostname(init.etebaseServerUrl ?? ETEBASE_SERVER_URL, 'unknown')
    this.billingHost = safeHostname(init.billingApiUrl ?? BILLING_API_URL, 'unknown')
  }

  startPhase(phase: RestoreDiagnosticPhase, now = this.now()): void {
    this.activePhase = { phase, startedAtMs: now }
  }

  completePhase(
    phase: RestoreDiagnosticPhase,
    details: Omit<RestoreDiagnosticEntry, 'phase' | 'status' | 'durationMs'> & { now?: number } = {},
  ): void {
    const { now, ...safeDetails } = details
    const finishedAtMs = now ?? this.now()
    const active = this.activePhase?.phase === phase ? this.activePhase : null
    const durationMs = active ? Math.max(0, Math.round(finishedAtMs - active.startedAtMs)) : undefined
    this.entries.push({
      phase,
      status: 'ok',
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...safeDetails,
    })
    if (active) this.activePhase = null
    this.generatedAtMs = finishedAtMs
  }

  skipPhase(phase: RestoreDiagnosticPhase, details: Omit<RestoreDiagnosticEntry, 'phase' | 'status'> = {}): void {
    this.entries.push({ phase, status: 'skipped', ...details })
  }

  failActivePhase(error: unknown, now = this.now()): void {
    const active = this.activePhase ?? { phase: 'unknown' as RestoreDiagnosticPhase, startedAtMs: now }
    const durationMs = Math.max(0, Math.round(now - active.startedAtMs))
    this.failedPhase = active.phase
    this.entries.push({
      phase: active.phase,
      status: 'failed',
      durationMs,
      errorName: getSafeErrorName(error),
    })
    this.activePhase = null
    this.generatedAtMs = now
  }

  snapshot(): RestoreDiagnosticsSnapshot {
    return {
      version: 1,
      source: this.source,
      generatedAtMs: this.generatedAtMs,
      etebaseHost: this.etebaseHost,
      billingHost: this.billingHost,
      failedPhase: this.failedPhase,
      entries: [...this.entries],
    }
  }

  persist(): void {
    persistRestoreDiagnostics(this.snapshot())
  }
}

export function createLoginSessionPersistenceDiagnostics(init: {
  etebaseServerUrl?: string
  billingApiUrl?: string
  savedSession: string | null | undefined
  rereadSession: string | null | undefined
  now?: () => number
}): RestoreDiagnosticsRecorder {
  const recorder = new RestoreDiagnosticsRecorder({
    source: 'login',
    etebaseServerUrl: init.etebaseServerUrl,
    billingApiUrl: init.billingApiUrl,
    now: init.now,
  })
  recorder.completePhase('sessionPersistence', {
    session: classifySessionPersistence(init.rereadSession),
    roundtripMatch: Boolean(init.savedSession) && init.savedSession === init.rereadSession,
  })
  return recorder
}

export function persistRestoreDiagnostics(snapshot: RestoreDiagnosticsSnapshot): void {
  const storage = safeStorage()
  if (!storage) return
  try {
    storage.setItem(RESTORE_DIAGNOSTICS_STORAGE_KEY, buildRestoreDiagnosticsCopyText(snapshot))
  } catch {
    // Diagnostics are best-effort only.
  }
}

export function readRestoreDiagnostics(): RestoreDiagnosticsSnapshot | null {
  const storage = safeStorage()
  if (!storage) return null
  try {
    const raw = storage.getItem(RESTORE_DIAGNOSTICS_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as RestoreDiagnosticsSnapshot
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return null
    return parsed
  } catch {
    return null
  }
}

const VALID_PHASES = new Set<RestoreDiagnosticPhase>([
  'sessionRead',
  'sessionPersistence',
  'restoreSession',
  'ensureCollections',
  'hydrateLists',
  'listItems:calendar',
  'listItems:tasks',
  'listItems:contacts',
  'syncEngineTrackCollections',
  'syncEngineStart',
  'unknown',
])

const VALID_STATUSES = new Set<RestoreDiagnosticStatus>(['ok', 'failed', 'skipped'])

function sanitizeHostValue(host: unknown): string {
  if (typeof host !== 'string' || host.length === 0) return 'unknown'
  if (/^[a-z0-9.-]+$/i.test(host)) return host
  return safeHostname(host, 'unknown')
}

function sanitizeErrorNameValue(errorName: string): string | undefined {
  return /^[A-Za-z][A-Za-z0-9_.]*$/.test(errorName) ? errorName : undefined
}

function sanitizeSessionPersistence(session: SessionPersistenceShape | undefined): SessionPersistenceShape | undefined {
  if (!session) return undefined
  if (typeof session.present !== 'boolean') return undefined
  if (typeof session.parseableJson !== 'boolean') return undefined
  if (!['missing', 'empty', 'json', 'string'].includes(session.shape)) return undefined
  return {
    present: session.present,
    parseableJson: session.parseableJson,
    shape: session.shape,
  }
}

function sanitizeDiagnosticsEntry(entry: RestoreDiagnosticEntry): RestoreDiagnosticEntry | null {
  if (!VALID_PHASES.has(entry.phase) || !VALID_STATUSES.has(entry.status)) return null
  const safe: RestoreDiagnosticEntry = {
    phase: entry.phase,
    status: entry.status,
  }
  if (typeof entry.durationMs === 'number') safe.durationMs = entry.durationMs
  const errorName = typeof entry.errorName === 'string' ? sanitizeErrorNameValue(entry.errorName) : undefined
  if (errorName) safe.errorName = errorName
  const session = sanitizeSessionPersistence(entry.session)
  if (session) safe.session = session
  if (typeof entry.roundtripMatch === 'boolean') safe.roundtripMatch = entry.roundtripMatch
  if (['calendar', 'tasks', 'contacts'].includes(entry.collectionType ?? '')) {
    safe.collectionType = entry.collectionType
  }
  if (typeof entry.collectionCount === 'number') safe.collectionCount = entry.collectionCount
  if (typeof entry.itemCount === 'number') safe.itemCount = entry.itemCount
  if (typeof entry.pageCount === 'number') safe.pageCount = entry.pageCount
  return safe
}

function sanitizeDiagnosticsSnapshot(snapshot: RestoreDiagnosticsSnapshot): RestoreDiagnosticsSnapshot {
  return {
    version: 1,
    source: snapshot.source === 'login' ? 'login' : 'restore',
    generatedAtMs: typeof snapshot.generatedAtMs === 'number' ? snapshot.generatedAtMs : 0,
    etebaseHost: sanitizeHostValue(snapshot.etebaseHost),
    billingHost: sanitizeHostValue(snapshot.billingHost),
    failedPhase: snapshot.failedPhase && VALID_PHASES.has(snapshot.failedPhase) ? snapshot.failedPhase : null,
    entries: snapshot.entries.map(sanitizeDiagnosticsEntry).filter((entry): entry is RestoreDiagnosticEntry => entry !== null),
  }
}

export function buildRestoreDiagnosticsCopyText(snapshot: RestoreDiagnosticsSnapshot | null): string {
  if (!snapshot) return JSON.stringify({ version: 1, error: 'no_restore_diagnostics_recorded' })
  return JSON.stringify(sanitizeDiagnosticsSnapshot(snapshot))
}

export function hasRestoreDiagnostics(): boolean {
  return readRestoreDiagnostics() !== null
}

export function shouldExposeRestoreDiagnostics(): boolean {
  if (typeof window === 'undefined') return false
  const hostname = window.location.hostname
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === 'previewapp.silentsuite.io') {
    return true
  }
  const params = new URLSearchParams(window.location.search)
  if (params.get('syncDebug') === '1') return true
  return safeLocalStorage()?.getItem('silentsuite-sync-debug') === '1'
}

export function canExposeRestoreDiagnosticsCopy(): boolean {
  return shouldExposeRestoreDiagnostics() && hasRestoreDiagnostics()
}
