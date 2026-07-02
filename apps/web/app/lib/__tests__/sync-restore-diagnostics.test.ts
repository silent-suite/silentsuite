import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  RESTORE_DIAGNOSTICS_STORAGE_KEY,
  RestoreDiagnosticsRecorder,
  buildRestoreDiagnosticsCopyText,
  classifySessionPersistence,
  createLoginSessionPersistenceDiagnostics,
  readRestoreDiagnostics,
  shouldExposeRestoreDiagnostics,
} from '../sync-restore-diagnostics'

describe('sync restore diagnostics', () => {
  beforeEach(() => {
    sessionStorage.clear()
    localStorage.clear()
    vi.unstubAllGlobals()
  })

  it('classifies session persistence without exposing the saved session value', () => {
    const classification = classifySessionPersistence('{"secret":"session-token-value"}')

    expect(classification).toEqual({ present: true, parseableJson: true, shape: 'json' })
    expect(JSON.stringify(classification)).not.toContain('session-token-value')
  })

  it('stores only hostnames, phase codes, counts, durations, and safe error names', () => {
    const recorder = new RestoreDiagnosticsRecorder({
      source: 'restore',
      etebaseServerUrl: 'https://server.silentsuite.io/private/path?token=secret',
      billingApiUrl: 'https://api.silentsuite.io/auth/token-exchange?email=user@example.com',
      now: () => 1_000,
    })

    recorder.completePhase('sessionRead', {
      session: classifySessionPersistence('raw-session-secret'),
    })
    recorder.startPhase('listItems:calendar')
    recorder.completePhase('listItems:calendar', {
      collectionCount: 2,
      itemCount: 42,
      pageCount: 3,
      now: 1_075,
    })
    recorder.startPhase('syncEngineStart')
    recorder.failActivePhase(new Error('contains raw-session-secret and user@example.com'), 1_090)
    recorder.persist()

    const copyText = buildRestoreDiagnosticsCopyText(readRestoreDiagnostics())
    expect(copyText).toContain('"etebaseHost":"server.silentsuite.io"')
    expect(copyText).toContain('"billingHost":"api.silentsuite.io"')
    expect(copyText).toContain('"phase":"syncEngineStart"')
    expect(copyText).toContain('"errorName":"Error"')
    expect(copyText).toContain('"itemCount":42')
    expect(copyText).not.toContain('raw-session-secret')
    expect(copyText).not.toContain('user@example.com')
    expect(copyText).not.toContain('/private/path')
    expect(copyText).not.toContain('token=secret')
  })

  it('records login session roundtrip diagnostics without persisting the session blob', () => {
    createLoginSessionPersistenceDiagnostics({
      etebaseServerUrl: 'https://server.silentsuite.io',
      billingApiUrl: 'https://api.silentsuite.io',
      savedSession: 'login-session-secret',
      rereadSession: 'login-session-secret',
      now: () => 2_000,
    }).persist()

    const raw = sessionStorage.getItem(RESTORE_DIAGNOSTICS_STORAGE_KEY) ?? ''
    expect(raw).toContain('"phase":"sessionPersistence"')
    expect(raw).toContain('"status":"ok"')
    expect(raw).toContain('"roundtripMatch":true')
    expect(raw).not.toContain('login-session-secret')
  })

  it('exposes copy UI only on preview/local or explicit syncDebug opt-in', () => {
    vi.stubGlobal('window', {
      location: { hostname: 'app.silentsuite.io', search: '' },
      localStorage,
    })
    expect(shouldExposeRestoreDiagnostics()).toBe(false)

    vi.stubGlobal('window', {
      location: { hostname: 'previewapp.silentsuite.io', search: '' },
      localStorage,
    })
    expect(shouldExposeRestoreDiagnostics()).toBe(true)

    vi.stubGlobal('window', {
      location: { hostname: 'app.silentsuite.io', search: '?syncDebug=1' },
      localStorage,
    })
    expect(shouldExposeRestoreDiagnostics()).toBe(true)
  })
})
