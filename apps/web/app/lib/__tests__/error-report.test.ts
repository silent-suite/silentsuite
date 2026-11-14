import { describe, expect, it } from 'vitest'

import {
  browserFamily,
  buildErrorReport,
  chunkPathFromUrl,
  MAX_REPORT_BYTES,
  MAX_REPORT_FRAMES,
  parseErrorReport,
  routeTemplate,
} from '../error-report'

const CANARY = 'CANARY_7f3a'
const ORIGIN = 'https://app.silentsuite.io'
const PAGE_CHUNK = '/_next/static/chunks/app/(app)/calendar/page-0a1b2c3d.js'
const MAIN_CHUNK = '/_next/static/chunks/main-app-9f8e7d.js'
const LOADED = new Set([PAGE_CHUNK, MAIN_CHUNK])
const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

function context(pathname = '/calendar') {
  return { origin: ORIGIN, pathname, userAgent: CHROME, loadedChunks: LOADED }
}

/** A Sentry error event with a canary in every field that can carry user data. */
function canaryEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: `${CANARY}event`,
    message: `${CANARY} message`,
    level: 'error',
    platform: 'javascript',
    release: `${CANARY}-release`,
    environment: `${CANARY}-env`,
    transaction: `/notes/${CANARY}`,
    user: { id: CANARY, email: `${CANARY}@example.com`, ip_address: '203.0.113.9' },
    request: { url: `${ORIGIN}/notes/${CANARY}?q=${CANARY}`, headers: { Cookie: CANARY, Referer: CANARY } },
    tags: { note: CANARY },
    extra: { errorName: CANARY, digest: CANARY },
    contexts: { device: { name: CANARY } },
    breadcrumbs: [{ message: CANARY, data: { url: CANARY } }],
    fingerprint: [CANARY],
    exception: {
      values: [
        { type: `${CANARY}Cause`, value: `${CANARY} cause` },
        {
          type: 'TypeError',
          value: `Cannot read ${CANARY} of undefined`,
          module: CANARY,
          mechanism: { type: 'auto.browser.global_handlers.onerror', handled: false, data: { [CANARY]: CANARY } },
          stacktrace: {
            frames: [
              { filename: `https://evil.example/${CANARY}.js`, function: CANARY, lineno: 1, colno: 1 },
              { filename: `${ORIGIN}${MAIN_CHUNK}?${CANARY}=1#${CANARY}`, function: `${CANARY}Fn`, lineno: 1, colno: 200, in_app: true, vars: { a: CANARY }, context_line: CANARY, pre_context: [CANARY], abs_path: `${ORIGIN}/${CANARY}` },
              { filename: `${ORIGIN}/_next/static/chunks/${CANARY}-unloaded.js`, function: 'x', lineno: 3, colno: 4 },
              { filename: `${ORIGIN}${PAGE_CHUNK}`, function: `handle${CANARY}`, lineno: 12, colno: 3456, module: CANARY },
              { filename: '<anonymous>', function: CANARY, lineno: 1, colno: 1 },
              { filename: `blob:${ORIGIN}/${CANARY}`, lineno: 1, colno: 1 },
            ],
          },
        },
      ],
    },
    ...overrides,
  }
}

describe('error report contract (client rebuild)', () => {
  it('keeps only allowlisted fields and never the canary', () => {
    const report = buildErrorReport(canaryEvent(), context('/notes/abc-123'))
    expect(report).toEqual({
      v: 1,
      type: 'TypeError',
      mechanism: 'onerror',
      handled: false,
      route: '/notes',
      browser: 'chrome',
      frames: [
        { file: MAIN_CHUNK, line: 1, col: 200 },
        { file: PAGE_CHUNK, line: 12, col: 3456 },
      ],
    })
    expect(JSON.stringify(report)).not.toContain(CANARY)
  })

  it('maps unknown error types to Error and keeps only the finite operation codes', () => {
    const custom = buildErrorReport({ exception: { values: [{ type: `${CANARY}Error`, value: 'sync-provider: sync notes failed', mechanism: { type: 'generic', handled: true } }] } }, context())
    expect(custom).toMatchObject({ type: 'Error', op: 'sync-provider: sync notes failed', mechanism: 'manual', handled: true, frames: [] })
    const free = buildErrorReport({ exception: { values: [{ type: 'Error', value: `sync-provider: ${CANARY} failed` }] } }, context())
    expect(free).not.toHaveProperty('op')
    expect(JSON.stringify(free)).not.toContain(CANARY)
  })

  it('classifies unhandled rejections', () => {
    const report = buildErrorReport({ exception: { values: [{ type: 'UnhandledRejection', value: CANARY, mechanism: { type: 'auto.browser.global_handlers.onunhandledrejection', handled: false } }] } }, context())
    expect(report).toMatchObject({ type: 'UnhandledRejection', mechanism: 'unhandledrejection', handled: false })
  })

  it.each([
    ['transaction', { type: 'transaction', exception: { values: [{ type: 'Error' }] } }],
    ['replay', { type: 'replay_event' }],
    ['feedback', { type: 'feedback', exception: { values: [{ type: 'Error' }] } }],
    ['message without exception', { message: CANARY }],
    ['empty values', { exception: { values: [] } }],
  ])('builds nothing for a %s', (_label, event) => {
    expect(buildErrorReport(event, context())).toBeUndefined()
  })

  it('keeps at most the newest frames and stays under the byte cap', () => {
    const frames = Array.from({ length: 200 }, (_, index) => ({ filename: `${ORIGIN}${PAGE_CHUNK}`, lineno: index, colno: 1 }))
    const report = buildErrorReport({ exception: { values: [{ type: 'Error', stacktrace: { frames } }] } }, context())!
    expect(report.frames).toHaveLength(MAX_REPORT_FRAMES)
    expect(report.frames.at(-1)?.line).toBe(199)
    expect(new TextEncoder().encode(JSON.stringify(report)).byteLength).toBeLessThanOrEqual(MAX_REPORT_BYTES)
  })

  it('reduces frame URLs to same-origin static chunk paths only', () => {
    expect(chunkPathFromUrl(`${ORIGIN}${PAGE_CHUNK}?dpl=x#y`, ORIGIN)).toBe(PAGE_CHUNK)
    expect(chunkPathFromUrl(`https://cdn.example${PAGE_CHUNK}`, ORIGIN)).toBeUndefined()
    expect(chunkPathFromUrl(`https://user:pw@app.silentsuite.io${PAGE_CHUNK}`, ORIGIN)).toBeUndefined()
    expect(chunkPathFromUrl(`${ORIGIN}/_next/static/chunks/../../notes/${CANARY}.js`, ORIGIN)).toBeUndefined()
    expect(chunkPathFromUrl(`${ORIGIN}/notes/${CANARY}.js`, ORIGIN)).toBeUndefined()
    expect(chunkPathFromUrl(`${ORIGIN}/_next/static/chunks/a%20b.js`, ORIGIN)).toBeUndefined()
    expect(chunkPathFromUrl('chrome-extension://abc/content.js', ORIGIN)).toBeUndefined()
  })

  it('maps routes to fixed templates', () => {
    expect(routeTemplate('/calendar')).toBe('/calendar')
    expect(routeTemplate('/contacts/9b2e')).toBe('/contacts')
    expect(routeTemplate('/settings/security/')).toBe('/settings/security')
    expect(routeTemplate(`/settings/${CANARY}`)).toBe('/settings')
    expect(routeTemplate(`/${CANARY}`)).toBe('other')
    expect(routeTemplate('/signup/plan')).toBe('/signup/plan')
  })

  it('reduces the user agent to a browser family', () => {
    expect(browserFamily(CHROME)).toBe('chrome')
    expect(browserFamily('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0')).toBe('edge')
    expect(browserFamily('Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0')).toBe('firefox')
    expect(browserFamily('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15')).toBe('safari')
    expect(browserFamily(CANARY)).toBe('other')
  })
})

describe('error report contract (relay parse)', () => {
  const valid = { v: 1, type: 'TypeError', mechanism: 'onerror', handled: false, route: '/calendar', browser: 'chrome', frames: [{ file: PAGE_CHUNK, line: 1, col: 2 }] }

  it('returns its own copy of a valid report', () => {
    const parsed = parseErrorReport(valid, LOADED)
    expect(parsed).toEqual(valid)
    expect(parsed).not.toBe(valid)
  })

  it('drops frames that are not emitted by this build or carry a query', () => {
    const parsed = parseErrorReport({
      ...valid,
      frames: [
        { file: '/_next/static/chunks/other-1234.js', line: 1, col: 2 },
        { file: `${PAGE_CHUNK}?${CANARY}`, line: 1, col: 2 },
        { file: `/${CANARY}.js`, line: 1, col: 2 },
        ...valid.frames,
      ],
    }, LOADED)
    expect(parsed?.frames).toEqual(valid.frames)
    expect(JSON.stringify(parsed)).not.toContain(CANARY)
  })

  it.each([
    ['extra top-level key', { ...valid, message: CANARY }],
    ['free-form op', { ...valid, op: CANARY }],
    ['unknown type', { ...valid, type: CANARY }],
    ['unknown route', { ...valid, route: `/notes/${CANARY}` }],
    ['unknown browser', { ...valid, browser: CANARY }],
    ['unknown mechanism', { ...valid, mechanism: CANARY }],
    ['non-boolean handled', { ...valid, handled: 'no' }],
    ['wrong version', { ...valid, v: 2 }],
    ['frame with function', { ...valid, frames: [{ file: PAGE_CHUNK, line: 1, col: 2, function: CANARY }] }],
    ['frame with negative line', { ...valid, frames: [{ file: PAGE_CHUNK, line: -1, col: 2 }] }],
    ['too many frames', { ...valid, frames: Array.from({ length: MAX_REPORT_FRAMES + 1 }, () => valid.frames[0]) }],
    ['array', [valid]],
    ['null', null],
  ])('rejects a report with %s', (_label, value) => {
    expect(parseErrorReport(value, LOADED)).toBeUndefined()
  })
})
