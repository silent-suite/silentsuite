import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  globalHandlersIntegration: vi.fn(() => ({ name: 'GlobalHandlers' })),
  dedupeIntegration: vi.fn(() => ({ name: 'Dedupe' })),
}))
vi.mock('@sentry/nextjs', () => sentry)

import {
  createErrorReportTransport,
  documentChunkPaths,
  ERROR_RELAY_ENDPOINT,
  errorReportingEnabled,
  MAX_REPORTS_PER_DOCUMENT,
} from '../error-report-client'

const CANARY = 'CANARY_c11e'
const ORIGIN = 'https://app.silentsuite.io'
const CHUNK = '/_next/static/chunks/app/(app)/notes/page-77aa.js'
const context = () => ({ origin: ORIGIN, pathname: `/notes/${CANARY}`, userAgent: 'Firefox/132.0', loadedChunks: new Set([CHUNK]) })

function errorItem(type = 'TypeError', value = CANARY) {
  return [{ type: 'event' }, {
    message: CANARY,
    user: { email: CANARY },
    request: { url: `${ORIGIN}/notes/${CANARY}` },
    exception: { values: [{ type, value, stacktrace: { frames: [{ filename: `${ORIGIN}${CHUNK}?${CANARY}`, function: CANARY, lineno: 1, colno: 2 }] } }] },
  }]
}

function envelope(...items: unknown[]) {
  return [{ dsn: CANARY, sdk: { name: CANARY }, trace: { trace_id: CANARY } }, items]
}

function capture() {
  const bodies: string[] = []
  const urls: string[] = []
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(url))
    bodies.push(String(init?.body))
    expect(init?.credentials).toBe('omit')
    return new Response(null, { status: 204 })
  })
  return { bodies, urls, fetcher }
}

describe('error report transport', () => {
  it('posts only rebuilt error events to the same-origin relay', async () => {
    const { bodies, urls, fetcher } = capture()
    const transport = createErrorReportTransport({ context, fetcher })
    await transport.send(envelope(
      [{ type: 'session' }, { sid: CANARY }],
      [{ type: 'transaction' }, { transaction: CANARY, type: 'transaction' }],
      [{ type: 'replay_event' }, { replay_id: CANARY }],
      [{ type: 'replay_recording' }, CANARY],
      [{ type: 'client_report' }, { discarded_events: [] }],
      [{ type: 'attachment', filename: CANARY }, CANARY],
      [{ type: 'feedback' }, { contexts: { feedback: { message: CANARY } } }],
      errorItem(),
    ))

    expect(urls).toEqual([ERROR_RELAY_ENDPOINT])
    expect(bodies[0]).not.toContain(CANARY)
    expect(JSON.parse(bodies[0])).toEqual({
      v: 1, type: 'TypeError', mechanism: 'manual', handled: true, route: '/notes', browser: 'firefox', frames: [{ file: CHUNK, line: 1, col: 2 }],
    })
  })

  it('prefers sendBeacon and falls back to keepalive fetch', async () => {
    const { fetcher } = capture()
    const beacon = vi.fn(() => true)
    await createErrorReportTransport({ context, fetcher, beacon }).send(envelope(errorItem()))
    expect(beacon).toHaveBeenCalledWith(ERROR_RELAY_ENDPOINT, expect.any(Blob))
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('sends each distinct report once and at most the per-document cap', async () => {
    const { bodies, fetcher } = capture()
    const transport = createErrorReportTransport({ context, fetcher })
    await transport.send(envelope(errorItem()))
    await transport.send(envelope(errorItem()))
    expect(bodies).toHaveLength(1)
    const types = ['RangeError', 'SyntaxError', 'URIError', 'EvalError', 'AbortError', 'DataError', 'NetworkError', 'TimeoutError', 'SecurityError', 'NotFoundError', 'UnknownError']
    for (const type of types) await transport.send(envelope(errorItem(type)))
    expect(bodies).toHaveLength(MAX_REPORTS_PER_DOCUMENT)
  })

  it('never throws on malformed envelopes or a failing network', async () => {
    const fetcher = vi.fn(async () => { throw new Error('offline') })
    const transport = createErrorReportTransport({ context, fetcher })
    await expect(transport.send(null)).resolves.toEqual({})
    await expect(transport.send([{}, [null, 'x', [{ type: 'event' }, null]]])).resolves.toEqual({})
    await expect(transport.send(envelope(errorItem()))).resolves.toEqual({})
    await expect(transport.flush()).resolves.toBe(true)
  })
})

describe('error reporting gate', () => {
  it('is on only for hosted https://app.silentsuite.io builds with a DSN', () => {
    const app = new URL('https://app.silentsuite.io/calendar')
    expect(errorReportingEnabled(app, 'https://k@e/1', 'false')).toBe(true)
    expect(errorReportingEnabled(app, undefined, 'false')).toBe(false)
    expect(errorReportingEnabled(app, '', 'false')).toBe(false)
    expect(errorReportingEnabled(app, 'https://k@e/1', 'true')).toBe(false)
    expect(errorReportingEnabled(new URL('https://abc.silentsuite-web.pages.dev/'), 'https://k@e/1', 'false')).toBe(false)
    expect(errorReportingEnabled(new URL('http://app.silentsuite.io/'), 'https://k@e/1', 'false')).toBe(false)
  })

  it('collects only same-origin static chunks the document loaded', () => {
    document.head.innerHTML = [
      `<script src="${CHUNK}?dpl=1"></script>`,
      '<script src="https://cdn.example/_next/static/chunks/x.js"></script>',
      `<script src="/notes/${CANARY}.js"></script>`,
      '<script>inline()</script>',
    ].join('')
    const perf = { getEntriesByType: () => [
      { name: `${window.location.origin}/_next/static/chunks/lazy-1.js`, initiatorType: 'script' },
      { name: `${window.location.origin}/_next/static/chunks/data-1.js`, initiatorType: 'fetch' },
    ] } as unknown as Performance
    expect([...documentChunkPaths(document, perf)].sort()).toEqual(['/_next/static/chunks/app/(app)/notes/page-77aa.js', '/_next/static/chunks/lazy-1.js'])
    document.head.innerHTML = ''
  })
})

describe('Sentry runtime configs', () => {
  beforeEach(() => {
    vi.resetModules()
    sentry.init.mockClear()
  })
  afterEach(() => vi.unstubAllEnvs())

  it('client config does not initialise without a DSN', async () => {
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', '')
    await import('../../../sentry.client.config')
    expect(sentry.init).not.toHaveBeenCalled()
  })

  it('client config does not initialise off the hosted origin even with a DSN', async () => {
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://0123456789abcdef@errors.example/1')
    await import('../../../sentry.client.config')
    expect(window.location.hostname).not.toBe('app.silentsuite.io')
    expect(sentry.init).not.toHaveBeenCalled()
  })

  it('client options disable tracing, replay, sessions, breadcrumbs, PII and the default transport', async () => {
    const { errorReportInitOptions } = await import('../../../sentry.client.config')
    const options = errorReportInitOptions('https://0123456789abcdef@errors.example/1') as Record<string, unknown>
    expect(options.defaultIntegrations).toBe(false)
    expect(options.sendDefaultPii).toBe(false)
    expect(options.maxBreadcrumbs).toBe(0)
    expect(options.sendClientReports).toBe(false)
    expect((options.integrations as Array<{ name: string }>).map((integration) => integration.name)).toEqual(['GlobalHandlers', 'Dedupe'])
    for (const key of ['tracesSampleRate', 'tracesSampler', 'profilesSampleRate', 'replaysSessionSampleRate', 'replaysOnErrorSampleRate', 'tunnel', 'release', 'enableLogs']) {
      expect(options).not.toHaveProperty(key)
    }
    expect((options.beforeSendTransaction as () => unknown)()).toBeNull()
    expect((options.beforeBreadcrumb as () => unknown)()).toBeNull()
    expect(typeof options.transport).toBe('function')
  })

  it('server and edge configs never initialise the SDK', async () => {
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://0123456789abcdef@errors.example/1')
    await import('../../../sentry.server.config')
    await import('../../../sentry.edge.config')
    expect(sentry.init).not.toHaveBeenCalled()
  })
})
