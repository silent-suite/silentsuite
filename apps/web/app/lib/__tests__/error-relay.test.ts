// @vitest-environment node
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CANARY_HEADER,
  createRateLimiter,
  forwardMode,
  glitchtipUpstream,
  loadEmittedChunks,
  relayErrorReport,
} from '../error-relay'

const CANARY = 'CANARY_51c0'
const PAGE_CHUNK = '/_next/static/chunks/app/(app)/calendar/page-0a1b2c3d.js'
const EMITTED = new Set([PAGE_CHUNK])
const DSN = 'https://0123456789abcdef0123456789abcdef@errors.silentsuite.io/3'
const SHA = 'a'.repeat(40)
const TOKEN = 't'.repeat(40)
const REPORT = { v: 1, type: 'TypeError', mechanism: 'onerror', handled: false, route: '/calendar', browser: 'firefox', frames: [{ file: PAGE_CHUNK, line: 7, col: 99 }] }

function relayRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1:3000/api/error', {
    method: 'POST',
    headers: {
      host: 'app.silentsuite.io',
      origin: 'https://app.silentsuite.io',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      'user-agent': `Mozilla/5.0 ${CANARY}`,
      'x-real-ip': '203.0.113.7',
      'cf-connecting-ip': '203.0.113.8',
      referer: `https://app.silentsuite.io/notes/${CANARY}`,
      cookie: `session=${CANARY}`,
      authorization: `Bearer ${CANARY}`,
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function upstream(status = 200) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status }))
}

function env(mode: string | null) {
  vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
  vi.stubEnv('GLITCHTIP_DSN', DSN)
  vi.stubEnv('SILENTSUITE_PUBLIC_BUILD_SHA', SHA)
  vi.stubEnv('GLITCHTIP_CANARY_TOKEN', TOKEN)
  if (mode === null) vi.stubEnv('GLITCHTIP_FORWARD', undefined)
  else vi.stubEnv('GLITCHTIP_FORWARD', mode)
}

const deps = (fetcher: ReturnType<typeof upstream>) => ({
  fetcher,
  emitted: () => EMITTED,
  allow: () => true,
  now: () => new Date('2026-11-14T10:00:00Z'),
  eventId: () => 'e'.repeat(32),
})

describe('browser error relay', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('forwards the relay-built event to the fixed GlitchTip store URL with no client headers', async () => {
    env('on')
    const fetcher = upstream()
    const response = await relayErrorReport(relayRequest(REPORT), deps(fetcher))

    expect(response.status).toBe(202)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('https://errors.silentsuite.io/api/3/store/')
    expect(init?.redirect).toBe('error')
    const headers = new Headers(init?.headers)
    expect([...headers.keys()].sort()).toEqual(['content-type', 'user-agent', 'x-sentry-auth'])
    expect(headers.get('user-agent')).toBe('silentsuite-error-relay/1.0')
    expect(headers.get('x-sentry-auth')).toBe('Sentry sentry_version=7, sentry_key=0123456789abcdef0123456789abcdef, sentry_client=silentsuite-error-relay/1.0')
    const body = String(init?.body)
    expect(body).not.toContain(CANARY)
    expect(body).not.toContain('203.0.113')
    expect(JSON.parse(body)).toEqual({
      event_id: 'e'.repeat(32),
      timestamp: '2026-11-14T10:00:00.000Z',
      platform: 'javascript',
      level: 'error',
      environment: 'production',
      release: SHA,
      exception: {
        values: [{
          type: 'TypeError',
          mechanism: { type: 'onerror', handled: false },
          stacktrace: { frames: [{ filename: `https://app.silentsuite.io${PAGE_CHUNK}`, abs_path: `https://app.silentsuite.io${PAGE_CHUNK}`, lineno: 7, colno: 99, in_app: true }] },
        }],
      },
      tags: { route: '/calendar', browser: 'firefox' },
    })
  })

  it('omits an invalid release and drops frames the build did not emit', async () => {
    env('on')
    vi.stubEnv('SILENTSUITE_PUBLIC_BUILD_SHA', CANARY)
    const fetcher = upstream()
    const report = { ...REPORT, op: 'sync-provider: init failed', frames: [{ file: '/_next/static/chunks/foreign-1.js', line: 1, col: 1 }] }
    expect((await relayErrorReport(relayRequest(report), deps(fetcher))).status).toBe(202)
    const event = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
    expect(event).not.toHaveProperty('release')
    expect(event.exception.values[0]).toEqual({ type: 'TypeError', value: 'sync-provider: init failed', mechanism: { type: 'onerror', handled: false } })
  })

  it.each([
    ['forwarding unset', () => env(null), {}],
    ['forwarding off', () => env('off'), {}],
    ['unknown forward mode', () => env('yes'), {}],
    ['self-hosted build', () => { env('on'); vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true') }, {}],
    ['no DSN', () => { env('on'); vi.stubEnv('GLITCHTIP_DSN', '') }, {}],
    ['plain-http DSN', () => { env('on'); vi.stubEnv('GLITCHTIP_DSN', DSN.replace('https:', 'http:')) }, {}],
    ['foreign host', () => env('on'), { host: 'preview.pages.dev' }],
    ['foreign origin', () => env('on'), { origin: 'https://evil.example' }],
    ['cross-site fetch', () => env('on'), { 'sec-fetch-site': 'cross-site' }],
    ['form content type', () => env('on'), { 'content-type': 'application/x-www-form-urlencoded' }],
    ['declared oversize body', () => env('on'), { 'content-length': '9000' }],
    ['canary mode without token', () => env('canary'), {}],
    ['canary mode with wrong token', () => env('canary'), { [CANARY_HEADER]: 'x'.repeat(40) }],
  ])('answers 204 without forwarding for %s', async (_label, setup, headers) => {
    setup()
    const fetcher = upstream()
    const response = await relayErrorReport(relayRequest(REPORT, headers as Record<string, string>), deps(fetcher))
    expect(response.status).toBe(204)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    ['malformed JSON', '{'],
    ['undeclared oversize body', JSON.stringify({ ...REPORT, pad: 'x'.repeat(9000) })],
    ['message field', { ...REPORT, message: CANARY }],
    ['free-form op', { ...REPORT, op: CANARY }],
    ['raw Sentry event', { exception: { values: [{ type: 'Error', value: CANARY }] } }],
  ])('answers 204 without forwarding for a body with %s', async (_label, body) => {
    env('on')
    const fetcher = upstream()
    expect((await relayErrorReport(relayRequest(body), deps(fetcher))).status).toBe(204)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('forwards in canary mode only with the server-held token', async () => {
    env('canary')
    const fetcher = upstream()
    expect((await relayErrorReport(relayRequest(REPORT, { [CANARY_HEADER]: TOKEN }), deps(fetcher))).status).toBe(202)
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).has(CANARY_HEADER)).toBe(false)
    vi.stubEnv('GLITCHTIP_CANARY_TOKEN', 'short')
    expect((await relayErrorReport(relayRequest(REPORT, { [CANARY_HEADER]: 'short' }), deps(fetcher))).status).toBe(204)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('answers 204 when the upstream fails, rejects or is over the rate cap', async () => {
    env('on')
    expect((await relayErrorReport(relayRequest(REPORT), deps(upstream(500)))).status).toBe(204)
    const failing = vi.fn(async () => { throw new Error('down') })
    expect((await relayErrorReport(relayRequest(REPORT), { ...deps(upstream()), fetcher: failing })).status).toBe(204)
    const capped = upstream()
    expect((await relayErrorReport(relayRequest(REPORT), { ...deps(capped), allow: () => false })).status).toBe(204)
    expect(capped).not.toHaveBeenCalled()
  })

  it('caps forwards per window', () => {
    const allow = createRateLimiter(2, 1000)
    expect([allow(0), allow(10), allow(20), allow(999), allow(1000)]).toEqual([true, true, false, false, true])
  })

  it('parses only https DSNs with a key and numeric project', () => {
    expect(glitchtipUpstream(DSN)?.storeUrl).toBe('https://errors.silentsuite.io/api/3/store/')
    expect(glitchtipUpstream('https://errors.silentsuite.io/3')).toBeUndefined()
    expect(glitchtipUpstream('https://0123456789abcdef0123456789abcdef@errors.silentsuite.io/x')).toBeUndefined()
    expect(glitchtipUpstream(`${DSN}?x=1`)).toBeUndefined()
    expect(glitchtipUpstream('not a url')).toBeUndefined()
    expect(forwardMode(undefined)).toBe('off')
  })

  it('lists the emitted JavaScript chunks of a build directory', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'emitted-'))
    mkdirSync(path.join(root, 'chunks', 'app', '(app)', 'calendar'), { recursive: true })
    mkdirSync(path.join(root, 'build-id'), { recursive: true })
    writeFileSync(path.join(root, 'chunks', 'app', '(app)', 'calendar', 'page-0a1b2c3d.js'), '')
    writeFileSync(path.join(root, 'chunks', 'main-1.js'), '')
    writeFileSync(path.join(root, 'chunks', 'main-1.js.map'), '')
    writeFileSync(path.join(root, 'build-id', '_buildManifest.js'), '')
    writeFileSync(path.join(root, 'chunks', 'style.css'), '')
    expect([...loadEmittedChunks(root)].sort()).toEqual([
      '/_next/static/build-id/_buildManifest.js',
      PAGE_CHUNK,
      '/_next/static/chunks/main-1.js',
    ])
    expect(loadEmittedChunks(path.join(root, 'missing')).size).toBe(0)
  })
})
