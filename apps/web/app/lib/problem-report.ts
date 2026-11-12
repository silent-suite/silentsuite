/**
 * "Report a problem" payload builder (contract: contracts/problem-report.schema.json, v1).
 *
 * Everything here is pure. Diagnostics are built only from allowlisted, finite
 * values: error codes come from explicit table lookups, never from error names,
 * messages, URLs, hostnames or account data. Anything unmapped becomes "other".
 */

import { REPORT_RELAY_URL } from '@/app/lib/config'

export { REPORT_RELAY_URL }

export const SUPPORT_EMAIL = 'support@silentsuite.io'
export const PRIVACY_POLICY_URL = 'https://silentsuite.io/privacy#problem-reports'
/** Months a report is kept after it is closed, shown in the disclosure. Change it here only. */
export const REPORT_RETENTION_MONTHS = 12
/** How long Send waits for the relay before showing the unknown-outcome message. */
export const REPORT_SEND_TIMEOUT_MS = 15_000

export const SUMMARY_MAX_CHARS = 120
export const SUMMARY_MAX_BYTES = 480
export const DESCRIPTION_MAX_CHARS = 4000
export const DESCRIPTION_MAX_BYTES = 16000
export const CONTACT_MAX_CHARS = 254
export const BODY_MAX_BYTES = 32768

export type ReportKind = 'problem' | 'feature'
export type WebErrorCode =
  | 'sync_init_failed'
  | 'sync_failed'
  | 'calendar_load_failed'
  | 'contacts_load_failed'
  | 'tasks_load_failed'
  | 'notes_load_failed'
  | 'restore_failed'
  | 'other'
export type DomainLoad = 'unknown' | 'loaded' | 'failed'
export type RestoreStatus = 'ok' | 'failed' | 'skipped' | 'none'
export type SyncStatusBucket = 'synced' | 'syncing' | 'offline' | 'error' | 'unknown'
export type LastSuccessBucket = 'under_1h' | 'under_1d' | 'under_7d' | 'over_7d' | 'never' | 'unknown'

export interface WebDiagnosticsFields {
  build_sha?: string
  domain_calendar: DomainLoad
  domain_contacts: DomainLoad
  domain_tasks: DomainLoad
  domain_notes: DomainLoad
  restore_status: RestoreStatus
}

export interface WebDiagnostics {
  app_version: string
  platform: string
  server: 'hosted' | 'custom'
  sync_status: SyncStatusBucket
  last_success: LastSuccessBucket
  error_codes: WebErrorCode[]
  fields: WebDiagnosticsFields
}

export interface ProblemReportPayload {
  schema: 1
  kind: ReportKind
  surface: 'web'
  summary: string
  description: string
  contact_email?: string
  diagnostics?: WebDiagnostics
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** The fixed strings the sync provider and sync store put in `useSyncStore.error`. */
const SYNC_ERROR_CODES: Readonly<Record<string, WebErrorCode>> = {
  'Sync initialization failed': 'sync_init_failed',
  'Sync error occurred': 'sync_failed',
  'Sync failed': 'sync_failed',
}

const SYNC_STATUS_BUCKETS: Readonly<Record<string, SyncStatusBucket>> = {
  synced: 'synced',
  syncing: 'syncing',
  offline: 'offline',
  error: 'error',
}

const DOMAIN_LOAD_VALUES: Readonly<Record<string, DomainLoad>> = {
  unknown: 'unknown',
  loaded: 'loaded',
  failed: 'failed',
}

const DOMAINS = ['calendar', 'contacts', 'tasks', 'notes'] as const
type Domain = (typeof DOMAINS)[number]

const DOMAIN_FAILURE_CODES: Readonly<Record<Domain, WebErrorCode>> = {
  calendar: 'calendar_load_failed',
  contacts: 'contacts_load_failed',
  tasks: 'tasks_load_failed',
  notes: 'notes_load_failed',
}

function lookup<T>(table: Readonly<Record<string, T>>, key: unknown): T | undefined {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined
}

/** Coarse browser + OS family from fixed labels only; the user agent itself is never returned. */
export function platformLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? ''
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? 'edge'
    : /OPR\/|Opera/.test(ua)
      ? 'opera'
      : /Firefox\/|FxiOS\//.test(ua)
        ? 'firefox'
        : /Chrome\/|Chromium\/|CriOS\//.test(ua)
          ? 'chrome'
          : /Safari\//.test(ua)
            ? 'safari'
            : 'other'
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'ios'
    : /Android/.test(ua)
      ? 'android'
      : /CrOS/.test(ua)
        ? 'chromeos'
        : /Windows/.test(ua)
          ? 'windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'macos'
            : /Linux|X11/.test(ua)
              ? 'linux'
              : 'other'
  return `${browser}-${os}`
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export function lastSuccessBucket(lastSyncedAt: Date | null | undefined, nowMs: number): LastSuccessBucket {
  if (lastSyncedAt == null) return 'never'
  const at = lastSyncedAt instanceof Date ? lastSyncedAt.getTime() : NaN
  if (!Number.isFinite(at)) return 'unknown'
  const age = nowMs - at
  if (age < 0) return 'unknown'
  if (age < HOUR_MS) return 'under_1h'
  if (age < DAY_MS) return 'under_1d'
  if (age < 7 * DAY_MS) return 'under_7d'
  return 'over_7d'
}

/** Restore outcome from the sanitized restore-diagnostics snapshot (status values only). */
export function restoreStatus(
  snapshot: { failedPhase?: unknown; entries?: ReadonlyArray<{ status?: unknown }> } | null | undefined,
): RestoreStatus {
  if (!snapshot || !Array.isArray(snapshot.entries)) return 'none'
  if (snapshot.failedPhase != null || snapshot.entries.some((entry) => entry?.status === 'failed')) return 'failed'
  if (snapshot.entries.length > 0 && snapshot.entries.every((entry) => entry?.status === 'skipped')) return 'skipped'
  return 'ok'
}

/** 7–12 lowercase hex characters from a full deployment SHA, or undefined. */
export function shortBuildSha(publicSha: unknown): string | undefined {
  return typeof publicSha === 'string' && /^[0-9a-f]{40}$/.test(publicSha) ? publicSha.slice(0, 12) : undefined
}

export interface DiagnosticsInput {
  appVersion: string
  userAgent: string | undefined
  customServer: boolean
  isOnline: boolean
  syncStatus: unknown
  syncError: unknown
  lastSyncedAt: Date | null | undefined
  domainLoadState: Partial<Record<string, unknown>> | null | undefined
  restoreSnapshot: Parameters<typeof restoreStatus>[0]
  buildSha?: string
  nowMs: number
}

export function buildWebDiagnostics(input: DiagnosticsInput): WebDiagnostics {
  const codes: WebErrorCode[] = []
  const addCode = (code: WebErrorCode) => {
    if (!codes.includes(code) && codes.length < 10) codes.push(code)
  }

  if (input.syncError != null && input.syncError !== '') addCode(lookup(SYNC_ERROR_CODES, input.syncError) ?? 'other')

  const domainStates = {} as Record<Domain, DomainLoad>
  for (const domain of DOMAINS) {
    const state = lookup(DOMAIN_LOAD_VALUES, input.domainLoadState?.[domain]) ?? 'unknown'
    domainStates[domain] = state
    if (state === 'failed') addCode(DOMAIN_FAILURE_CODES[domain])
  }

  const restore = restoreStatus(input.restoreSnapshot)
  if (restore === 'failed') addCode('restore_failed')

  const appVersion = /^[A-Za-z0-9._+-]{1,32}$/.test(input.appVersion) ? input.appVersion : 'unknown'
  const buildSha = typeof input.buildSha === 'string' && /^[0-9a-f]{7,12}$/.test(input.buildSha) ? input.buildSha : undefined

  return {
    app_version: appVersion,
    platform: platformLabel(input.userAgent),
    server: input.customServer ? 'custom' : 'hosted',
    sync_status: input.isOnline ? lookup(SYNC_STATUS_BUCKETS, input.syncStatus) ?? 'unknown' : 'offline',
    last_success: lastSuccessBucket(input.lastSyncedAt, input.nowMs),
    error_codes: codes,
    fields: {
      ...(buildSha ? { build_sha: buildSha } : {}),
      domain_calendar: domainStates.calendar,
      domain_contacts: domainStates.contacts,
      domain_tasks: domainStates.tasks,
      domain_notes: domainStates.notes,
      restore_status: restore,
    },
  }
}

/** The exact diagnostics text shown in the preview; the same object is sent. */
export function formatDiagnostics(diagnostics: WebDiagnostics): string {
  return JSON.stringify(diagnostics, null, 2)
}

// ---------------------------------------------------------------------------
// User text and payload
// ---------------------------------------------------------------------------

const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/
/** With the u flag a valid surrogate pair is one code point, so this matches lone surrogates only. */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u
const CONTACT_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9.-]{1,189}$/

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length
}

export function codePoints(value: string): number {
  return [...value].length
}

export function normalizeUserText(value: string): string {
  return value.replace(/\r\n/g, '\n')
}

export type TextProblem = 'required' | 'too_long' | 'control_chars'

export function checkUserText(value: string, maxChars: number, maxBytes: number): TextProblem | null {
  const text = normalizeUserText(value)
  if (text.trim().length === 0) return 'required'
  if (CONTROL_CHARS.test(text) || LONE_SURROGATE.test(text)) return 'control_chars'
  if (codePoints(text) > maxChars || utf8Bytes(text) > maxBytes) return 'too_long'
  return null
}

export function checkContactEmail(value: string): 'invalid' | null {
  const email = value.trim()
  if (email === '') return null
  return email.length <= CONTACT_MAX_CHARS && CONTACT_PATTERN.test(email) ? null : 'invalid'
}

export interface ReportInput {
  kind: ReportKind
  summary: string
  description: string
  contactEmail: string
  diagnostics: WebDiagnostics | null
}

export type BuildResult =
  | { ok: true; payload: ProblemReportPayload; body: string }
  | { ok: false; errors: { summary?: TextProblem; description?: TextProblem; contactEmail?: 'invalid'; body?: 'too_long' } }

export function buildProblemReport(input: ReportInput): BuildResult {
  const errors: Extract<BuildResult, { ok: false }>['errors'] = {}
  const summaryProblem = checkUserText(input.summary, SUMMARY_MAX_CHARS, SUMMARY_MAX_BYTES)
  const descriptionProblem = checkUserText(input.description, DESCRIPTION_MAX_CHARS, DESCRIPTION_MAX_BYTES)
  const contactProblem = checkContactEmail(input.contactEmail)
  if (summaryProblem) errors.summary = summaryProblem
  if (descriptionProblem) errors.description = descriptionProblem
  if (contactProblem) errors.contactEmail = contactProblem
  if (Object.keys(errors).length > 0) return { ok: false, errors }

  const contact = input.contactEmail.trim()
  const payload: ProblemReportPayload = {
    schema: 1,
    kind: input.kind,
    surface: 'web',
    summary: normalizeUserText(input.summary),
    description: normalizeUserText(input.description),
    ...(contact ? { contact_email: contact } : {}),
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  }
  const body = JSON.stringify(payload)
  if (utf8Bytes(body) > BODY_MAX_BYTES) return { ok: false, errors: { body: 'too_long' } }
  return { ok: true, payload, body }
}

/** Plain-text report for Copy and the email body. */
export function formatReportText(payload: ProblemReportPayload): string {
  const lines = [
    `Kind: ${payload.kind === 'problem' ? 'Problem' : 'Feature request'}`,
    `Surface: web`,
    `Summary: ${payload.summary}`,
    '',
    'Description:',
    payload.description,
  ]
  if (payload.contact_email) lines.push('', `Reply email: ${payload.contact_email}`)
  if (payload.diagnostics) lines.push('', 'Diagnostic info:', formatDiagnostics(payload.diagnostics))
  return lines.join('\n')
}

export function reportMailtoHref(payload: ProblemReportPayload): string {
  const subject = `${payload.kind === 'problem' ? 'Problem' : 'Feature request'}: ${payload.summary}`
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(formatReportText(payload))}`
}
