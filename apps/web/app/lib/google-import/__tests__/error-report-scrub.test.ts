import { describe, expect, it, vi } from 'vitest'
import { buildErrorReport } from '@/app/lib/error-report'
import { createErrorReportTransport } from '@/app/lib/error-report-client'
import { errorReportInitOptions } from '@/sentry.client.config'

vi.mock('@sentry/nextjs', () => ({
  init: vi.fn(),
  dedupeIntegration: () => ({ name: 'Dedupe' }),
  globalHandlersIntegration: () => ({ name: 'GlobalHandlers' }),
}))

const TOKEN = 'ya29.secret-access-token'
const IMPORTED = 'Dr. Ann Lee, ann@example.com, Standup (moved)'
const CHUNK = '/_next/static/chunks/app-123.js'

/** An error event carrying everything that must never reach a report. */
function leakyEvent() {
  return {
    message: `failed with ${TOKEN}`,
    exception: {
      values: [{
        type: 'TypeError',
        value: `Bearer ${TOKEN} while importing ${IMPORTED}`,
        mechanism: { type: 'onunhandledrejection', handled: false },
        stacktrace: {
          frames: [
            { filename: `https://app.silentsuite.io${CHUNK}`, lineno: 10, colno: 5, function: IMPORTED, vars: { token: TOKEN } },
            { filename: `https://app.silentsuite.io/oauth/google-callback.html#access_token=${TOKEN}`, lineno: 1, colno: 1 },
          ],
        },
      }],
    },
    request: {
      url: `https://app.silentsuite.io/oauth/google-callback.html#state=s&access_token=${TOKEN}`,
      headers: { Authorization: `Bearer ${TOKEN}` },
    },
    breadcrumbs: [{ category: 'fetch', data: { url: 'https://people.googleapis.com/v1/people/me/connections', Authorization: `Bearer ${TOKEN}` } }],
    extra: { contacts: IMPORTED, token: TOKEN },
    tags: { token: TOKEN },
    user: { email: 'ann@example.com' },
  }
}

const context = {
  origin: 'https://app.silentsuite.io',
  pathname: '/oauth/google-callback.html',
  userAgent: 'Mozilla/5.0 Chrome/130.0',
  loadedChunks: new Set([CHUNK]),
}

describe('browser error reports during a Google import (#1077)', () => {
  it('rebuild an event without the token, Authorization header, URL fragment or imported data', () => {
    const report = buildErrorReport(leakyEvent(), context)
    expect(report).toEqual({
      v: 1, type: 'TypeError', mechanism: 'unhandledrejection', handled: false, route: 'other', browser: 'chrome',
      frames: [{ file: CHUNK, line: 10, col: 5 }],
    })
    const text = JSON.stringify(report)
    for (const secret of [TOKEN, 'Bearer', 'access_token', 'googleapis', 'ann@example.com', 'Standup']) expect(text).not.toContain(secret)
  })

  it('post nothing secret through the transport, and the SDK keeps no breadcrumbs', () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }))
    const transport = createErrorReportTransport({ context: () => context, fetcher: fetcher as unknown as typeof fetch })
    void transport.send([{}, [[{ type: 'event' }, leakyEvent()], [{ type: 'attachment' }, TOKEN]]])
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(init.body)).not.toContain(TOKEN)
    expect(String(init.body)).not.toContain('ann@example.com')

    const options = errorReportInitOptions('https://key@example.invalid/1')
    expect(options.beforeBreadcrumb()).toBeNull()
    expect(options.maxBreadcrumbs).toBe(0)
    expect(options.sendDefaultPii).toBe(false)
  })
})
