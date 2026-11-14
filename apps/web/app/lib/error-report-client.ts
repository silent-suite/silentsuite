import { buildErrorReport, chunkPathFromUrl, type ErrorReport } from './error-report'

/*
 * Browser side of the error reports (see error-report.ts for the contract).
 *
 * The Sentry SDK only captures errors here; its own transport is replaced, so
 * nothing reaches the DSN host. Each error event in an envelope is rebuilt into
 * an ErrorReport and posted to the same-origin relay POST /api/error. Every
 * other envelope item (sessions, transactions, client reports, replays,
 * attachments) is discarded. Reporting runs only in hosted production builds
 * that were given NEXT_PUBLIC_SENTRY_DSN, on https://app.silentsuite.io.
 */

export const ERROR_RELAY_ENDPOINT = '/api/error'
export const MAX_REPORTS_PER_DOCUMENT = 10
const APP_HOST = 'app.silentsuite.io'

export function errorReportingEnabled(
  location: Pick<URL, 'protocol' | 'hostname'>,
  dsn: string | undefined,
  selfHosted: string | undefined,
): boolean {
  return Boolean(dsn) && selfHosted !== 'true' && location.protocol === 'https:' && location.hostname === APP_HOST
}

/** Static chunks this document loaded from its own origin. */
export function documentChunkPaths(doc: Document = document, perf: Pick<Performance, 'getEntriesByType'> | undefined = globalThis.performance): Set<string> {
  const origin = doc.location?.origin ?? ''
  const paths = new Set<string>()
  const add = (url: string) => {
    const path = chunkPathFromUrl(url, origin)
    if (path) paths.add(path)
  }
  for (const script of Array.from(doc.scripts)) if (script.src) add(script.src)
  try {
    for (const entry of perf?.getEntriesByType('resource') ?? []) {
      if ((entry as PerformanceResourceTiming).initiatorType === 'script') add(entry.name)
    }
  } catch {
    // Resource timing is optional; the script elements above still count.
  }
  return paths
}

type EnvelopeItem = [{ type?: unknown }, unknown]
type Envelope = [unknown, EnvelopeItem[]]

export type ErrorReportTransportDeps = {
  context: () => { origin: string; pathname: string; userAgent: string; loadedChunks: ReadonlySet<string> }
  beacon?: (url: string, data: Blob) => boolean
  fetcher?: typeof fetch
  maxReports?: number
}

function post(body: string, beacon: ErrorReportTransportDeps['beacon'], fetcher: typeof fetch): void {
  try {
    if (beacon && beacon(ERROR_RELAY_ENDPOINT, new Blob([body], { type: 'application/json' }))) return
    void fetcher(ERROR_RELAY_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true, credentials: 'omit' })
      .catch(() => undefined)
  } catch {
    // Reporting never affects the app.
  }
}

/** A Sentry Transport that forwards only rebuilt error reports, at most maxReports per document. */
export function createErrorReportTransport({ context, beacon, fetcher = fetch, maxReports = MAX_REPORTS_PER_DOCUMENT }: ErrorReportTransportDeps) {
  let sent = 0
  const seen = new Set<string>()
  return {
    send(envelope: unknown): Promise<Record<string, never>> {
      try {
        const items = Array.isArray(envelope) && Array.isArray((envelope as Envelope)[1]) ? (envelope as Envelope)[1] : []
        for (const item of items) {
          if (!Array.isArray(item) || item[0]?.type !== 'event') continue
          if (sent >= maxReports) break
          const report: ErrorReport | undefined = buildErrorReport(item[1], context())
          if (!report) continue
          const body = JSON.stringify(report)
          if (seen.has(body)) continue
          seen.add(body)
          sent += 1
          post(body, beacon, fetcher)
        }
      } catch {
        // Reporting never affects the app.
      }
      return Promise.resolve({})
    },
    flush(): Promise<boolean> {
      return Promise.resolve(true)
    },
  }
}

export function browserReportContext() {
  return {
    origin: window.location.origin,
    pathname: window.location.pathname,
    userAgent: navigator.userAgent,
    loadedChunks: documentChunkPaths(),
  }
}
