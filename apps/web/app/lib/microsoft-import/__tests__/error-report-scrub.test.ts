import { describe, expect, it, vi } from 'vitest'
import { buildErrorReport } from '@/app/lib/error-report'
import { createErrorReportTransport } from '@/app/lib/error-report-client'

vi.mock('@sentry/nextjs', () => ({
  init: vi.fn(),
  dedupeIntegration: () => ({ name: 'Dedupe' }),
  globalHandlersIntegration: () => ({ name: 'GlobalHandlers' }),
}))

const CODE = 'M.C507_BAY.2.U.secret-authorization-code'
const TOKEN = 'EwBIA8l6BAAU.secret-access-token'
const IMPORTED = 'Dr. Ann Lee, ann@example.com, Quarterly review (moved)'
const GRAPH_URL = 'https://graph.microsoft.com/v1.0/me/calendars/AAMkAD%3D/events?$select=subject'
const CALLBACK = `https://app.silentsuite.io/oauth/microsoft-callback.html#code=${CODE}&state=s&error_description=AADSTS65001`
const CHUNK = '/_next/static/chunks/app-456.js'

/** An error event carrying everything from a Microsoft import that must never reach a report. */
function leakyEvent() {
  return {
    message: `failed with ${TOKEN} at ${GRAPH_URL}`,
    exception: {
      values: [{
        type: 'GraphApiError',
        value: `Bearer ${TOKEN} while importing ${IMPORTED} from ${GRAPH_URL}`,
        mechanism: { type: 'onunhandledrejection', handled: false },
        stacktrace: {
          frames: [
            { filename: `https://app.silentsuite.io${CHUNK}`, lineno: 12, colno: 7, function: IMPORTED, vars: { token: TOKEN, code: CODE } },
            { filename: CALLBACK, lineno: 1, colno: 1 },
            { filename: GRAPH_URL, lineno: 1, colno: 1 },
          ],
        },
      }],
    },
    request: { url: CALLBACK, headers: { Authorization: `Bearer ${TOKEN}` } },
    breadcrumbs: [{ category: 'fetch', data: { url: GRAPH_URL, Authorization: `Bearer ${TOKEN}` } }],
    extra: { events: IMPORTED, token: TOKEN, code: CODE },
    tags: { token: TOKEN },
    user: { email: 'ann@example.com' },
  }
}

const context = {
  origin: 'https://app.silentsuite.io',
  pathname: '/oauth/microsoft-callback.html',
  userAgent: 'Mozilla/5.0 Firefox/132.0',
  loadedChunks: new Set([CHUNK]),
}

const SECRETS = [TOKEN, CODE, 'Bearer', 'AADSTS', '65001', 'graph.microsoft.com', 'microsoft-callback', 'ann@example.com', 'Quarterly', 'Ann Lee']

describe('browser error reports during a Microsoft import (#1077)', () => {
  it('rebuild an event without the token, code, AADSTS code, Graph URL or imported data', () => {
    const report = buildErrorReport(leakyEvent(), context)
    expect(report).toMatchObject({ v: 1, mechanism: 'unhandledrejection', handled: false, route: 'other', frames: [{ file: CHUNK, line: 12, col: 7 }] })
    const text = JSON.stringify(report)
    for (const secret of SECRETS) expect(text).not.toContain(secret)
  })

  it('post nothing secret through the transport', () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }))
    const transport = createErrorReportTransport({ context: () => context, fetcher: fetcher as unknown as typeof fetch })
    void transport.send([{}, [[{ type: 'event' }, leakyEvent()], [{ type: 'attachment' }, `${TOKEN} ${CODE}`]]])
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    for (const secret of SECRETS) expect(String(init.body)).not.toContain(secret)
  })
})
