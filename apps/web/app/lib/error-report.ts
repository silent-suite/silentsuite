/*
 * Browser error report contract, shared by the client transport
 * (error-report-client.ts) and the same-origin relay (error-relay.ts).
 *
 * A report is rebuilt from a fixed allowlist, never copied from the SDK event:
 * an error type from a finite list, an operation code from a finite list (the
 * message itself is never sent), the mechanism, a fixed route template, a
 * browser family and stack frames reduced to file, line and column. A frame
 * survives only when its file is one of this release's own emitted chunks.
 * The client checks against the chunks the document loaded; the relay checks
 * again against the files the deployed build emitted. Function names, source
 * context, variables, URLs, query strings, user, tags and extra never leave.
 */

export const ERROR_REPORT_VERSION = 1
export const MAX_REPORT_FRAMES = 40
export const MAX_REPORT_BYTES = 8192

export const ERROR_TYPES = [
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError',
  'DOMException', 'AbortError', 'NotFoundError', 'NotAllowedError', 'NotSupportedError', 'NotReadableError',
  'QuotaExceededError', 'InvalidStateError', 'SecurityError', 'NetworkError', 'TimeoutError', 'DataError',
  'DataCloneError', 'UnknownError', 'ChunkLoadError', 'UnhandledRejection',
] as const
export type ErrorReportType = typeof ERROR_TYPES[number]

// The only messages the app raises on purpose (createSafeOperationalError).
// Any other message is dropped, because it can carry decrypted content.
const SYNC_DOMAINS = ['tasks', 'contacts', 'calendar', 'notes'] as const
export const OPERATION_CODES = [
  ...['global', 'app', 'calendar', 'contacts', 'tasks'].map((boundary) => `error-boundary: ${boundary} failed`),
  'sync-provider: init failed',
  ...SYNC_DOMAINS.map((domain) => `sync-provider: load ${domain} failed`),
  'sync-provider: sync tasks failed',
  'sync-provider: sync contacts failed',
  'sync-provider: sync calendar events failed',
  'sync-provider: sync notes failed',
] as const

export const ERROR_MECHANISMS = ['onerror', 'unhandledrejection', 'manual'] as const
export type ErrorMechanism = typeof ERROR_MECHANISMS[number]

export const BROWSER_FAMILIES = ['chrome', 'edge', 'firefox', 'safari', 'other'] as const
export type BrowserFamily = typeof BROWSER_FAMILIES[number]

// Fixed route templates. Path segments past a known route (ids, names) are
// never sent; anything unknown is 'other'.
export const ROUTE_TEMPLATES = [
  '/', '/calendar', '/contacts', '/tasks', '/notes', '/admin',
  '/settings', '/settings/account', '/settings/desktop', '/settings/experimental', '/settings/export',
  '/settings/import', '/settings/mobile', '/settings/report', '/settings/security', '/settings/sharing',
  '/settings/subscription',
  '/login', '/verify-email', '/offline',
  '/signup', '/signup/plan', '/signup/verify-email', '/signup/pending-payment', '/signup/success', '/signup/cancel',
  'other',
] as const
export type RouteTemplate = typeof ROUTE_TEMPLATES[number]

export type ErrorReportFrame = { file: string; line: number; col: number }

export type ErrorReport = {
  v: typeof ERROR_REPORT_VERSION
  type: ErrorReportType
  op?: string
  mechanism: ErrorMechanism
  handled: boolean
  route: RouteTemplate
  browser: BrowserFamily
  frames: ErrorReportFrame[]
}

const STATIC_CHUNK_PATH = /^\/_next\/static\/[A-Za-z0-9_\-.~()[\]@+/]+\.js$/
const MAX_POSITION = 10_000_000

function includes<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value)
}

/** A path under /_next/static/ that names a JavaScript file and nothing else. */
export function isStaticChunkPath(path: string): boolean {
  return STATIC_CHUNK_PATH.test(path) && !path.split('/').some((segment) => segment === '..' || segment === '.')
}

/**
 * Reduces a frame URL to its static chunk path: same origin only, query and
 * fragment dropped. Returns undefined for anything else (foreign scripts,
 * inline code, extensions, blob: or data: URLs).
 */
export function chunkPathFromUrl(raw: unknown, origin: string): string | undefined {
  if (typeof raw !== 'string' || raw.length > 2048) return undefined
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.origin !== origin || url.username || url.password) return undefined
  return isStaticChunkPath(url.pathname) ? url.pathname : undefined
}

export function routeTemplate(pathname: string): RouteTemplate {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  if (includes(ROUTE_TEMPLATES, path)) return path
  // A known section with a deeper path (an item id, a sub view) keeps only the section.
  for (const section of ['/calendar', '/contacts', '/tasks', '/notes', '/admin', '/settings'] as const) {
    if (path.startsWith(`${section}/`)) return section
  }
  return 'other'
}

export function browserFamily(userAgent: string): BrowserFamily {
  if (/\bEdg(?:e|A|iOS)?\//.test(userAgent)) return 'edge'
  if (/\b(?:Firefox|FxiOS)\//.test(userAgent)) return 'firefox'
  if (/\b(?:Chrome|CriOS|Chromium)\//.test(userAgent)) return 'chrome'
  if (/\bSafari\//.test(userAgent)) return 'safari'
  return 'other'
}

function errorType(raw: unknown): ErrorReportType {
  return includes(ERROR_TYPES, raw) ? raw : 'Error'
}

function mechanismOf(raw: unknown): ErrorMechanism {
  if (typeof raw !== 'string') return 'manual'
  if (raw.includes('onunhandledrejection')) return 'unhandledrejection'
  if (raw.includes('onerror')) return 'onerror'
  return 'manual'
}

function position(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= MAX_POSITION ? raw : undefined
}

type SdkFrame = { filename?: unknown; abs_path?: unknown; lineno?: unknown; colno?: unknown }
type SdkException = { type?: unknown; value?: unknown; mechanism?: { type?: unknown; handled?: unknown }; stacktrace?: { frames?: unknown } }
type SdkEvent = { type?: unknown; exception?: { values?: unknown } }

export type ErrorReportContext = {
  /** location.origin of the reporting document. */
  origin: string
  pathname: string
  userAgent: string
  /** Static chunk paths this document loaded from its own origin. */
  loadedChunks: ReadonlySet<string>
}

function framesFrom(raw: unknown, origin: string, allowed: ReadonlySet<string>): ErrorReportFrame[] {
  if (!Array.isArray(raw)) return []
  const frames: ErrorReportFrame[] = []
  for (const frame of raw as SdkFrame[]) {
    if (!frame || typeof frame !== 'object') continue
    const file = chunkPathFromUrl(frame.filename, origin)
    const line = position(frame.lineno)
    const col = position(frame.colno)
    if (!file || !allowed.has(file) || line === undefined || col === undefined) continue
    frames.push({ file, line, col })
  }
  // Sentry orders frames oldest first; the frames nearest the throw are last.
  return frames.slice(-MAX_REPORT_FRAMES)
}

/** Fits a report into MAX_REPORT_BYTES by dropping the oldest frames. */
function capped(report: ErrorReport): ErrorReport {
  const result = { ...report, frames: [...report.frames] }
  while (result.frames.length > 0 && new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_REPORT_BYTES) {
    result.frames.shift()
  }
  return result
}

/** Client side: rebuilds a report from a Sentry error event, or undefined for any other event. */
export function buildErrorReport(event: unknown, context: ErrorReportContext): ErrorReport | undefined {
  if (!event || typeof event !== 'object') return undefined
  const sdkEvent = event as SdkEvent
  if (sdkEvent.type !== undefined) return undefined // transactions, replays, feedback, profiles
  const values = sdkEvent.exception?.values
  if (!Array.isArray(values) || values.length === 0) return undefined
  // With linked errors the primary exception is last.
  const primary = values[values.length - 1] as SdkException
  if (!primary || typeof primary !== 'object') return undefined
  const op = includes(OPERATION_CODES, primary.value) ? primary.value : undefined
  return capped({
    v: ERROR_REPORT_VERSION,
    type: errorType(primary.type),
    ...(op ? { op } : {}),
    mechanism: mechanismOf(primary.mechanism?.type),
    handled: primary.mechanism?.handled !== false,
    route: routeTemplate(context.pathname),
    browser: browserFamily(context.userAgent),
    frames: framesFrom(primary.stacktrace?.frames, context.origin, context.loadedChunks),
  })
}

const REPORT_KEYS = new Set(['v', 'type', 'op', 'mechanism', 'handled', 'route', 'browser', 'frames'])
const FRAME_KEYS = new Set(['file', 'line', 'col'])

function hasOnlyKeys(value: object, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key))
}

/**
 * Relay side: accepts a posted report only when every field is in the
 * contract, and returns the relay's own copy. Frames whose file is not one of
 * the deployed build's emitted chunks are dropped, not trusted.
 */
export function parseErrorReport(value: unknown, emittedChunks: ReadonlySet<string>): ErrorReport | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const report = value as Record<string, unknown>
  if (!hasOnlyKeys(report, REPORT_KEYS)) return undefined
  if (report.v !== ERROR_REPORT_VERSION) return undefined
  if (!includes(ERROR_TYPES, report.type)) return undefined
  if (report.op !== undefined && !includes(OPERATION_CODES, report.op)) return undefined
  if (!includes(ERROR_MECHANISMS, report.mechanism)) return undefined
  if (typeof report.handled !== 'boolean') return undefined
  if (!includes(ROUTE_TEMPLATES, report.route)) return undefined
  if (!includes(BROWSER_FAMILIES, report.browser)) return undefined
  if (!Array.isArray(report.frames) || report.frames.length > MAX_REPORT_FRAMES) return undefined
  const frames: ErrorReportFrame[] = []
  for (const raw of report.frames) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !hasOnlyKeys(raw, FRAME_KEYS)) return undefined
    const frame = raw as Record<string, unknown>
    const line = position(frame.line)
    const col = position(frame.col)
    if (typeof frame.file !== 'string' || line === undefined || col === undefined) return undefined
    if (!isStaticChunkPath(frame.file) || !emittedChunks.has(frame.file)) continue
    frames.push({ file: frame.file, line, col })
  }
  return {
    v: ERROR_REPORT_VERSION,
    type: report.type,
    ...(report.op !== undefined ? { op: report.op as string } : {}),
    mechanism: report.mechanism,
    handled: report.handled,
    route: report.route,
    browser: report.browser,
    frames,
  }
}
