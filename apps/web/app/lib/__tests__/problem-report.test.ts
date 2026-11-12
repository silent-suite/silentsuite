import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BODY_MAX_BYTES,
  buildProblemReport,
  buildWebDiagnostics,
  formatDiagnostics,
  formatReportText,
  lastSuccessBucket,
  platformLabel,
  reportMailtoHref,
  restoreStatus,
  shortBuildSha,
  utf8Bytes,
  type DiagnosticsInput,
  type ProblemReportPayload,
} from '../problem-report'

const schema = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../../../contracts/problem-report.schema.json'), 'utf8'),
)

const FIREFOX_LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'
const NOW = Date.UTC(2026, 10, 12, 12, 0, 0)

function diagnosticsInput(overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    appVersion: '0.5.18-beta',
    userAgent: FIREFOX_LINUX_UA,
    customServer: false,
    isOnline: true,
    syncStatus: 'synced',
    syncError: null,
    lastSyncedAt: new Date(NOW - 5 * 60 * 1000),
    domainLoadState: { calendar: 'loaded', contacts: 'loaded', tasks: 'loaded', notes: 'unknown', preferences: 'loaded' },
    restoreSnapshot: null,
    buildSha: undefined,
    nowMs: NOW,
    ...overrides,
  }
}

const codePointLength = (value: string) => [...value].length

/** Checks a web payload against the shared contract: keys, required, enums, patterns, lengths. */
function expectMatchesSchema(payload: ProblemReportPayload) {
  const props = schema.properties
  expect(Object.keys(payload).every((key) => key in props)).toBe(true)
  for (const key of schema.required) expect(payload).toHaveProperty(key)
  expect(payload.schema).toBe(props.schema.const)
  expect(props.kind.enum).toContain(payload.kind)
  expect(props.surface.enum).toContain(payload.surface)
  const userText = new RegExp(schema.$defs.userText.pattern, 'u')
  for (const key of ['summary', 'description'] as const) {
    expect(userText.test(payload[key])).toBe(true)
    expect(codePointLength(payload[key])).toBeGreaterThanOrEqual(props[key].minLength)
    expect(codePointLength(payload[key])).toBeLessThanOrEqual(props[key].maxLength)
  }
  if (payload.contact_email !== undefined) {
    expect(new RegExp(props.contact_email.pattern).test(payload.contact_email)).toBe(true)
    expect(payload.contact_email.length).toBeLessThanOrEqual(props.contact_email.maxLength)
  }
  const d = payload.diagnostics
  if (!d) return
  const dp = props.diagnostics.properties
  expect(Object.keys(d).sort()).toEqual([...props.diagnostics.required].sort())
  expect(new RegExp(dp.app_version.pattern).test(d.app_version)).toBe(true)
  expect(new RegExp(dp.platform.pattern).test(d.platform)).toBe(true)
  expect(dp.server.enum).toContain(d.server)
  expect(dp.sync_status.enum).toContain(d.sync_status)
  expect(dp.last_success.enum).toContain(d.last_success)
  expect(d.error_codes.length).toBeLessThanOrEqual(dp.error_codes.maxItems)
  expect(new Set(d.error_codes).size).toBe(d.error_codes.length)
  for (const code of d.error_codes) expect(schema.$defs.webErrorCode.enum).toContain(code)
  const webFields = schema.$defs.webFields.properties
  for (const [key, value] of Object.entries(d.fields)) {
    expect(key in webFields).toBe(true)
    const def = webFields[key]
    const allowed = def.$ref ? schema.$defs[def.$ref.split('/').pop()].enum : def.enum
    if (allowed) expect(allowed).toContain(value)
    else expect(new RegExp(def.pattern).test(value as string)).toBe(true)
  }
}

describe('buildWebDiagnostics', () => {
  it('returns only allowlisted keys and coarse values', () => {
    const d = buildWebDiagnostics(diagnosticsInput({ buildSha: 'abcdef012345' }))
    expect(d).toEqual({
      app_version: '0.5.18-beta',
      platform: 'firefox-linux',
      server: 'hosted',
      sync_status: 'synced',
      last_success: 'under_1h',
      error_codes: [],
      fields: {
        build_sha: 'abcdef012345',
        domain_calendar: 'loaded',
        domain_contacts: 'loaded',
        domain_tasks: 'loaded',
        domain_notes: 'unknown',
        restore_status: 'none',
      },
    })
  })

  it('maps the fixed sync errors, failed domains and a failed restore by table lookup', () => {
    const d = buildWebDiagnostics(
      diagnosticsInput({
        syncStatus: 'error',
        syncError: 'Sync initialization failed',
        domainLoadState: { calendar: 'failed', contacts: 'failed', tasks: 'failed', notes: 'failed' },
        restoreSnapshot: { failedPhase: 'restoreSession', entries: [{ status: 'failed' }] },
        customServer: true,
      }),
    )
    expect(d.error_codes).toEqual([
      'sync_init_failed',
      'calendar_load_failed',
      'contacts_load_failed',
      'tasks_load_failed',
      'notes_load_failed',
      'restore_failed',
    ])
    expect(d.server).toBe('custom')
    expect(d.sync_status).toBe('error')
    expect(buildWebDiagnostics(diagnosticsInput({ syncError: 'Sync error occurred' })).error_codes).toEqual(['sync_failed'])
    expect(buildWebDiagnostics(diagnosticsInput({ syncError: 'Sync failed' })).error_codes).toEqual(['sync_failed'])
  })

  it('turns hostile or unknown inputs into "other"/"unknown" and never copies them', () => {
    const hostile = [
      'Private_Meeting_Title',
      'Failed to sync alice@example.com at https://cal.example.org/dav/Private_Meeting_Title',
      'TypeError: Cannot read properties of undefined\n    at secretFn (https://app.example/x.js:1:2)',
      'toString',
      '__proto__',
    ]
    for (const syncError of hostile) {
      const d = buildWebDiagnostics(
        diagnosticsInput({
          syncError,
          syncStatus: 'Private_Meeting_Title',
          appVersion: 'alice@example.com',
          domainLoadState: { calendar: 'Private_Meeting_Title', contacts: 'constructor', tasks: syncError, notes: undefined },
          restoreSnapshot: {
            failedPhase: null,
            entries: [{ status: 'ok', phase: 'Private_Meeting_Title', errorName: 'Private_Meeting_Title' } as { status: string }],
          },
          userAgent: `${FIREFOX_LINUX_UA} Private_Meeting_Title alice@example.com`,
        }),
      )
      expect(d.error_codes).toEqual(['other'])
      expect(d.sync_status).toBe('unknown')
      expect(d.app_version).toBe('unknown')
      expect(d.fields.domain_calendar).toBe('unknown')
      expect(d.fields.domain_contacts).toBe('unknown')
      expect(d.fields.domain_tasks).toBe('unknown')
      const report = buildProblemReport({ kind: 'problem', summary: 'S', description: 'D', contactEmail: '', diagnostics: d })
      expect(report.ok).toBe(true)
      if (!report.ok) return
      const outputs = [report.body, formatDiagnostics(d), formatReportText(report.payload), decodeURIComponent(reportMailtoHref(report.payload))]
      for (const out of outputs) {
        for (const needle of ['Private_Meeting_Title', 'alice@example.com', 'example.org', 'https://', 'TypeError', 'secretFn', 'Mozilla', 'Gecko', '140.0']) {
          expect(out).not.toContain(needle)
        }
      }
      expectMatchesSchema(report.payload)
    }
  })

  it('reports offline when the browser is offline and buckets the last success', () => {
    expect(buildWebDiagnostics(diagnosticsInput({ isOnline: false, syncStatus: 'synced' })).sync_status).toBe('offline')
    expect(lastSuccessBucket(null, NOW)).toBe('never')
    expect(lastSuccessBucket(new Date(NOW - 2 * 3600_000), NOW)).toBe('under_1d')
    expect(lastSuccessBucket(new Date(NOW - 3 * 86400_000), NOW)).toBe('under_7d')
    expect(lastSuccessBucket(new Date(NOW - 30 * 86400_000), NOW)).toBe('over_7d')
    expect(lastSuccessBucket(new Date(NOW + 60_000), NOW)).toBe('unknown')
    expect(lastSuccessBucket(new Date(Number.NaN), NOW)).toBe('unknown')
  })

  it('labels platforms with fixed families only', () => {
    expect(platformLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0')).toBe('edge-windows')
    expect(platformLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15')).toBe('safari-macos')
    expect(platformLabel('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36')).toBe('chrome-android')
    expect(platformLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/140.0 Mobile/15E148 Safari/605.1.15')).toBe('firefox-ios')
    expect(platformLabel(undefined)).toBe('other-other')
    expect(platformLabel('Private_Meeting_Title')).toBe('other-other')
  })

  it('derives restore status and the build sha from validated values only', () => {
    expect(restoreStatus(null)).toBe('none')
    expect(restoreStatus({ failedPhase: null, entries: [{ status: 'ok' }] })).toBe('ok')
    expect(restoreStatus({ failedPhase: null, entries: [{ status: 'skipped' }] })).toBe('skipped')
    expect(restoreStatus({ failedPhase: 'unknown', entries: [] })).toBe('failed')
    expect(shortBuildSha('0123456789abcdef0123456789abcdef01234567')).toBe('0123456789ab')
    expect(shortBuildSha('not-a-sha')).toBeUndefined()
    expect(shortBuildSha('https://example.org/0123456789abcdef0123456789abcdef01234567')).toBeUndefined()
    expect(buildWebDiagnostics(diagnosticsInput({ buildSha: 'XYZ' })).fields).not.toHaveProperty('build_sha')
  })
})

describe('buildProblemReport', () => {
  const base = { kind: 'problem' as const, summary: 'Summary', description: 'Description', contactEmail: '', diagnostics: null }

  it('builds a schema-shaped payload without optional keys when they are empty', () => {
    const report = buildProblemReport(base)
    expect(report.ok).toBe(true)
    if (!report.ok) return
    expect(report.payload).toEqual({ schema: 1, kind: 'problem', surface: 'web', summary: 'Summary', description: 'Description' })
    expect(JSON.parse(report.body)).toEqual(report.payload)
    expectMatchesSchema(report.payload)
  })

  it('accepts maximum 4-byte text, a maximum contact and full diagnostics, and rejects one character over', () => {
    const summary = '😀'.repeat(120)
    const description = '𝄞'.repeat(4000)
    const contactEmail = `${'a'.repeat(64)}@${'b'.repeat(185)}.com`
    expect(contactEmail).toHaveLength(254)
    const diagnostics = buildWebDiagnostics(
      diagnosticsInput({
        buildSha: '0123456789ab',
        syncError: 'x',
        domainLoadState: { calendar: 'failed', contacts: 'failed', tasks: 'failed', notes: 'failed' },
        restoreSnapshot: { failedPhase: 'unknown', entries: [] },
      }),
    )
    const report = buildProblemReport({ kind: 'feature', summary, description, contactEmail, diagnostics })
    expect(report.ok).toBe(true)
    if (!report.ok) return
    expect(utf8Bytes(report.payload.summary)).toBe(480)
    expect(utf8Bytes(report.payload.description)).toBe(16000)
    expect(utf8Bytes(report.body)).toBeLessThanOrEqual(20 * 1024)
    expect(report.body).toContain('😀') // not ASCII-escaped
    expectMatchesSchema(report.payload)

    expect(buildProblemReport({ ...base, summary: `${summary}😀` })).toEqual({ ok: false, errors: { summary: 'too_long' } })
    expect(buildProblemReport({ ...base, description: `${description}𝄞` })).toEqual({ ok: false, errors: { description: 'too_long' } })
    expect(buildProblemReport({ ...base, contactEmail: `a${contactEmail}` })).toEqual({ ok: false, errors: { contactEmail: 'invalid' } })
  })

  it('accepts maximum escaped characters within the byte limits and rejects one over', () => {
    const description = '"\\\n\t'.repeat(1000)
    const summary = '"\\'.repeat(60)
    const report = buildProblemReport({ ...base, summary, description })
    expect(report.ok).toBe(true)
    if (!report.ok) return
    expect(utf8Bytes(report.body)).toBeLessThanOrEqual(BODY_MAX_BYTES)
    expect(JSON.parse(report.body).description).toBe(description)
    expectMatchesSchema(report.payload)
    expect(buildProblemReport({ ...base, description: `${description}"` }).ok).toBe(false)
    expect(buildProblemReport({ ...base, summary: `${summary}"` }).ok).toBe(false)
  })

  it('rejects control characters except tab and newline, and normalises CRLF', () => {
    for (const control of ['\u0000', '\u0007', '\u000B', '\u000C', '\r', '\u001B', '\u007F', '\u0085', '\u009F']) {
      expect(buildProblemReport({ ...base, description: `a${control}b` })).toEqual({ ok: false, errors: { description: 'control_chars' } })
      expect(buildProblemReport({ ...base, summary: `a${control}b` })).toEqual({ ok: false, errors: { summary: 'control_chars' } })
    }
    const report = buildProblemReport({ ...base, description: 'line 1\r\nline 2\tend' })
    expect(report.ok && report.payload.description).toBe('line 1\nline 2\tend')
  })

  it('rejects lone UTF-16 surrogates but accepts valid pairs', () => {
    for (const lone of ['\uD83D', '\uDE00', 'a\uDE00\uD83D', '\uD83Dx']) {
      expect(buildProblemReport({ ...base, description: lone })).toEqual({ ok: false, errors: { description: 'control_chars' } })
      expect(buildProblemReport({ ...base, summary: lone })).toEqual({ ok: false, errors: { summary: 'control_chars' } })
    }
    expect(buildProblemReport({ ...base, summary: '\uD83D\uDE00', description: '\uD834\uDD1E' }).ok).toBe(true)
  })

  it('accepts exactly one address that fully matches the schema pattern', () => {
    for (const contactEmail of ['a@x.io\r', 'a@x.io\n', 'a@\nx.io', 'a@x.io\t', '\ta@x.io', 'a@x.io\r\nb@y.io', 'a@x.io,b@y.io', 'Name <a@x.io>', ' a@x.io', '   ']) {
      expect(buildProblemReport({ ...base, contactEmail })).toEqual({ ok: false, errors: { contactEmail: 'invalid' } })
    }
    const report = buildProblemReport({ ...base, contactEmail: 'a@x.io' })
    expect(report.ok && report.payload.contact_email).toBe('a@x.io')
  })

  it('requires summary and description', () => {
    expect(buildProblemReport({ ...base, summary: '  ', description: '' })).toEqual({
      ok: false,
      errors: { summary: 'required', description: 'required' },
    })
  })
})
