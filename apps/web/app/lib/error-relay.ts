import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { readdirSync } from 'node:fs'
import path from 'node:path'

import { hostedBuild, isAcceptedRequest, readCappedBody, respond } from './analytics-relay'
import { isStaticChunkPath, MAX_REPORT_BYTES, parseErrorReport, type ErrorReport } from './error-report'

/*
 * Same-origin browser error relay for app.silentsuite.io (POST /api/error).
 *
 * Dormant by default. Forwarding needs a hosted build, GLITCHTIP_DSN and
 * GLITCHTIP_FORWARD set on the server:
 *   off (default)  nothing is forwarded;
 *   canary         only requests carrying the server-held GLITCHTIP_CANARY_TOKEN
 *                  in X-SilentSuite-Error-Canary are forwarded (activation checks);
 *   on             every valid report is forwarded.
 * The posted JSON must match the ErrorReport contract exactly; the relay builds
 * its own event from it, keeps only frames that name this build's emitted
 * chunks, adds the release from SILENTSUITE_PUBLIC_BUILD_SHA and posts it to the
 * fixed GlitchTip store URL derived from GLITCHTIP_DSN. No client address,
 * cookies, referrer, User-Agent or other request header travels upstream.
 * Every rejection or upstream failure answers 204; nothing is logged.
 */

const UPSTREAM_TIMEOUT_MS = 3000
export const CANARY_HEADER = 'x-silentsuite-error-canary'
export const MAX_FORWARDS_PER_MINUTE = 30
const APP_ORIGIN = 'https://app.silentsuite.io'
const RELEASE = /^[0-9a-f]{40}$/
const MAX_EMITTED_FILES = 20000

export type ForwardMode = 'off' | 'canary' | 'on'

export function forwardMode(raw = process.env.GLITCHTIP_FORWARD): ForwardMode {
  return raw === 'on' || raw === 'canary' ? raw : 'off'
}

export type GlitchtipUpstream = { storeUrl: string; auth: string }

/** Parses https://<key>@<host>/<project> into the fixed store endpoint and auth header. */
export function glitchtipUpstream(dsn = process.env.GLITCHTIP_DSN): GlitchtipUpstream | undefined {
  if (!dsn) return undefined
  let url: URL
  try {
    url = new URL(dsn)
  } catch {
    return undefined
  }
  const project = url.pathname.replace(/^\/+/, '')
  if (url.protocol !== 'https:' || !/^[A-Za-z0-9]{16,64}$/.test(url.username) || url.password || url.search || url.hash || !/^\d{1,12}$/.test(project)) {
    return undefined
  }
  return {
    storeUrl: `https://${url.host}/api/${project}/store/`,
    auth: `Sentry sentry_version=7, sentry_key=${url.username}, sentry_client=silentsuite-error-relay/1.0`,
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

export function canaryAuthorized(request: Request, token = process.env.GLITCHTIP_CANARY_TOKEN): boolean {
  const presented = request.headers.get(CANARY_HEADER)
  if (!token || token.length < 32 || !presented) return false
  return timingSafeEqual(digest(presented), digest(token))
}

let emittedChunks: ReadonlySet<string> | undefined

/** JavaScript files the deployed build emitted under .next/static, as served paths. */
export function loadEmittedChunks(staticDir = path.join(process.cwd(), '.next', 'static')): ReadonlySet<string> {
  const files = new Set<string>()
  const walk = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (files.size >= MAX_EMITTED_FILES) return
      const served = `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(path.join(directory, entry.name), served)
      else if (entry.isFile() && isStaticChunkPath(served)) files.add(served)
    }
  }
  try {
    walk(staticDir, '/_next/static')
  } catch {
    // Without the build output no frame can be verified, so none is forwarded.
  }
  return files
}

function cachedEmittedChunks(): ReadonlySet<string> {
  emittedChunks ??= loadEmittedChunks()
  return emittedChunks
}

/** Fixed-window cap per server process. */
export function createRateLimiter(limit = MAX_FORWARDS_PER_MINUTE, windowMs = 60_000) {
  let windowStart = 0
  let count = 0
  return (now: number): boolean => {
    if (now - windowStart >= windowMs) {
      windowStart = now
      count = 0
    }
    if (count >= limit) return false
    count += 1
    return true
  }
}

const defaultLimiter = createRateLimiter()

/** The event the relay itself writes for GlitchTip; nothing in it is copied verbatim from the request. */
export function glitchtipEvent(report: ErrorReport, release: string | undefined, eventId: string, now: Date) {
  const frames = report.frames.map((frame) => {
    const url = `${APP_ORIGIN}${frame.file}`
    return { filename: url, abs_path: url, lineno: frame.line, colno: frame.col, in_app: true }
  })
  return {
    event_id: eventId,
    timestamp: now.toISOString(),
    platform: 'javascript',
    level: 'error',
    environment: 'production',
    ...(release ? { release } : {}),
    exception: {
      values: [{
        type: report.type,
        ...(report.op ? { value: report.op } : {}),
        mechanism: { type: report.mechanism === 'manual' ? 'generic' : report.mechanism, handled: report.handled },
        ...(frames.length ? { stacktrace: { frames } } : {}),
      }],
    },
    tags: { route: report.route, browser: report.browser },
  }
}

export type ErrorRelayDeps = {
  fetcher?: typeof fetch
  emitted?: () => ReadonlySet<string>
  allow?: (now: number) => boolean
  now?: () => Date
  eventId?: () => string
}

export async function relayErrorReport(request: Request, deps: ErrorRelayDeps = {}): Promise<Response> {
  const {
    fetcher = fetch,
    emitted = cachedEmittedChunks,
    allow = defaultLimiter,
    now = () => new Date(),
    eventId = () => randomUUID().replaceAll('-', ''),
  } = deps
  if (!hostedBuild() || !isAcceptedRequest(request, MAX_REPORT_BYTES)) return respond(204)
  const mode = forwardMode()
  const upstream = glitchtipUpstream()
  if (mode === 'off' || !upstream) return respond(204)
  if (mode === 'canary' && !canaryAuthorized(request)) return respond(204)

  const raw = await readCappedBody(request, MAX_REPORT_BYTES)
  if (raw === undefined) return respond(204)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return respond(204)
  }
  const report = parseErrorReport(parsed, emitted())
  if (!report) return respond(204)

  const at = now()
  if (!allow(at.getTime())) return respond(204)
  const release = process.env.SILENTSUITE_PUBLIC_BUILD_SHA
  const event = glitchtipEvent(report, release && RELEASE.test(release) ? release : undefined, eventId(), at)

  try {
    const response = await fetcher(upstream.storeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sentry-Auth': upstream.auth,
        'User-Agent': 'silentsuite-error-relay/1.0',
      },
      body: JSON.stringify(event),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    if (!response.ok) return respond(204)
  } catch {
    // An outage drops the report; it never slows or breaks the app.
    return respond(204)
  }
  return respond(202)
}
