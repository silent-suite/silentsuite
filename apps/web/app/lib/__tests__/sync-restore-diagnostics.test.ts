import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  RESTORE_DIAGNOSTICS_STORAGE_KEY,
  RestoreDiagnosticsRecorder,
  buildRestoreDiagnosticsCopyText,
  canExposeRestoreDiagnosticsCopy,
  classifySessionPersistence,
  createLoginSessionPersistenceDiagnostics,
  hasRestoreDiagnostics,
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
      sessionStorage,
    })
    expect(shouldExposeRestoreDiagnostics()).toBe(false)

    vi.stubGlobal('window', {
      location: { hostname: 'previewapp.silentsuite.io', search: '' },
      localStorage,
      sessionStorage,
    })
    expect(shouldExposeRestoreDiagnostics()).toBe(true)

    vi.stubGlobal('window', {
      location: { hostname: 'app.silentsuite.io', search: '?syncDebug=1' },
      localStorage,
      sessionStorage,
    })
    expect(shouldExposeRestoreDiagnostics()).toBe(true)
  })

  it('separates diagnostics presence from debug exposure policy', () => {
    vi.stubGlobal('window', {
      location: { hostname: 'app.silentsuite.io', search: '' },
      localStorage,
      sessionStorage,
    })
    expect(hasRestoreDiagnostics()).toBe(false)
    expect(canExposeRestoreDiagnosticsCopy()).toBe(false)

    sessionStorage.setItem(RESTORE_DIAGNOSTICS_STORAGE_KEY, JSON.stringify({
      version: 1,
      source: 'restore',
      generatedAtMs: 1,
      etebaseHost: 'server.silentsuite.io',
      billingHost: 'api.silentsuite.io',
      failedPhase: null,
      entries: [{ phase: 'syncEngineStart', status: 'ok' }],
    }))

    expect(hasRestoreDiagnostics()).toBe(true)
    expect(canExposeRestoreDiagnosticsCopy()).toBe(false)

    vi.stubGlobal('window', {
      location: { hostname: 'app.silentsuite.io', search: '?syncDebug=1' },
      localStorage,
      sessionStorage,
    })
    expect(hasRestoreDiagnostics()).toBe(true)
    expect(canExposeRestoreDiagnosticsCopy()).toBe(true)

    sessionStorage.setItem(RESTORE_DIAGNOSTICS_STORAGE_KEY, '{not-json')
    expect(hasRestoreDiagnostics()).toBe(false)
    expect(canExposeRestoreDiagnosticsCopy()).toBe(false)
  })

  it('drops unknown top-level and entry fields from copied diagnostics', () => {
    const copyText = buildRestoreDiagnosticsCopyText({
      version: 1,
      source: 'restore',
      generatedAtMs: 3_000,
      etebaseHost: 'https://server.silentsuite.io/private?token=secret',
      billingHost: 'api.silentsuite.io',
      failedPhase: null,
      entries: [{
        phase: 'listItems:calendar',
        status: 'ok',
        collectionType: 'calendar',
        collectionCount: 1,
        itemCount: 2,
        pageCount: 1,
        errorName: 'Error: user@example.com raw-session-secret',
        // Simulate a future/corrupt snapshot that somehow contains unsafe extras.
        collectionUid: 'collection-secret',
        itemUid: 'item-secret',
        content: 'plaintext-pim-secret',
        rawUrl: 'https://server.silentsuite.io/private?token=secret',
      } as never],
      rawEmail: 'user@example.com',
      sessionBlob: 'raw-session-secret',
    } as never)

    expect(copyText).toContain('"failedPhase":null')
    expect(copyText).toContain('"phase":"listItems:calendar"')
    expect(copyText).toContain('"itemCount":2')
    for (const forbidden of [
      'collection-secret',
      'item-secret',
      'plaintext-pim-secret',
      'token=secret',
      'user@example.com',
      'raw-session-secret',
      'collectionUid',
      'itemUid',
      'rawUrl',
      'sessionBlob',
    ]) {
      expect(copyText).not.toContain(forbidden)
    }
  })
})
