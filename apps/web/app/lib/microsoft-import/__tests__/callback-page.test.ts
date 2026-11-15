import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MICROSOFT_OAUTH_MESSAGE_TYPE, MICROSOFT_OAUTH_STATE_KEY } from '../oauth'

const ORIGIN = 'https://app.silentsuite.io'
const CODE = 'M.C507_BAY.2.U.secret-authorization-code'
const SCRIPT = readFileSync(path.resolve(__dirname, '../../../../public/oauth/microsoft-callback.js'), 'utf8')
const HTML = readFileSync(path.resolve(__dirname, '../../../../public/oauth/microsoft-callback.html'), 'utf8')

function runCallback(options: { fragment: string; search?: string; stored?: unknown; opener?: 'present' | 'missing' | 'closed' }) {
  const log: string[] = []
  const store = new Map<string, string>()
  if (options.stored !== undefined) store.set(MICROSOFT_OAUTH_STATE_KEY, JSON.stringify(options.stored))
  const location = { origin: ORIGIN, pathname: '/oauth/microsoft-callback.html', hash: options.fragment, search: options.search ?? '' }
  const status = { textContent: '' }
  const opener = {
    closed: options.opener === 'closed',
    postMessage: vi.fn((_message: unknown, _origin: string) => { log.push('postMessage') }),
  }
  const win = {
    location,
    history: {
      replaceState: vi.fn((_: unknown, __: string, url: string) => {
        log.push('replaceState')
        location.hash = ''
        location.search = ''
        location.pathname = url
      }),
    },
    localStorage: {
      getItem: (key: string) => { log.push('readState'); return store.get(key) ?? null },
      removeItem: (key: string) => { store.delete(key) },
    },
    opener: options.opener === 'missing' ? null : opener,
    close: vi.fn(() => { log.push('close') }),
    document: { readyState: 'complete', getElementById: () => status, addEventListener: vi.fn() },
  }
  new Function('window', SCRIPT)(win)
  return { win, opener, log, store, status }
}

const fresh = (state: string) => ({ state, expiresAt: Date.now() + 60_000 })
const fragment = (state: string) => `#code=${encodeURIComponent(CODE)}&state=${state}&session_state=abc`

describe('Microsoft OAuth callback page', () => {
  it('loads only its own same-origin script and sends no referrer', () => {
    const scripts = [...HTML.matchAll(/<script\b[^>]*>/g)].map((m) => m[0])
    expect(scripts).toEqual(['<script src="/oauth/microsoft-callback.js">'])
    expect(HTML).toContain('<meta name="referrer" content="no-referrer">')
    expect(HTML).not.toMatch(/https?:\/\//)
    expect(HTML).not.toMatch(/<link\b|<img\b|<iframe\b/i)
  })

  it('keeps its constants in step with oauth.ts', () => {
    expect(SCRIPT).toContain(`'${MICROSOFT_OAUTH_STATE_KEY}'`)
    expect(SCRIPT).toContain(`'${MICROSOFT_OAUTH_MESSAGE_TYPE}'`)
  })

  it('strips the code fragment before anything else, then posts only the code to the opener at our exact origin and closes', () => {
    const run = runCallback({ fragment: fragment('s1'), stored: fresh('s1') })
    expect(run.log[0]).toBe('replaceState')
    expect(run.win.location.hash).toBe('')
    expect(run.win.history.replaceState).toHaveBeenCalledWith(null, '', '/oauth/microsoft-callback.html')
    expect(run.opener.postMessage).toHaveBeenCalledTimes(1)
    expect(run.opener.postMessage).toHaveBeenCalledWith({ type: MICROSOFT_OAUTH_MESSAGE_TYPE, state: 's1', code: CODE }, ORIGIN)
    expect(run.log.slice(-2)).toEqual(['postMessage', 'close'])
    expect(run.store.has(MICROSOFT_OAUTH_STATE_KEY)).toBe(false)
    expect(run.status.textContent).not.toContain(CODE)
  })

  it('never forwards token-shaped data even if the fragment carries some', () => {
    const run = runCallback({ fragment: `${fragment('s1')}&access_token=at-secret&id_token=id-secret&refresh_token=rt-secret`, stored: fresh('s1') })
    const [message] = run.opener.postMessage.mock.calls[0]!
    expect(Object.keys(message as object).sort()).toEqual(['code', 'state', 'type'])
    expect(JSON.stringify(message)).not.toMatch(/at-secret|id-secret|rt-secret/)
  })

  it.each([
    ['a different state', fresh('other')],
    ['no stored state', undefined],
    ['an expired state', { state: 's1', expiresAt: Date.now() - 1 }],
  ])('posts nothing for %s', (_, stored) => {
    const run = runCallback({ fragment: fragment('s1'), stored })
    expect(run.log[0]).toBe('replaceState')
    expect(run.opener.postMessage).not.toHaveBeenCalled()
    expect(run.store.has(MICROSOFT_OAUTH_STATE_KEY)).toBe(false)
  })

  it('uses the stored state only once', () => {
    const first = runCallback({ fragment: fragment('s1'), stored: fresh('s1') })
    expect(first.opener.postMessage).toHaveBeenCalledTimes(1)
    expect(first.store.size).toBe(0)
  })

  it('forwards an error with only the AADSTS numbers, never the description text', () => {
    const description = 'AADSTS65001: The user or administrator has not consented to use the application with ID ann@example.com. Trace ID: 1234 AADSTS90094: admin'
    const run = runCallback({
      fragment: `#error=consent_required&error_description=${encodeURIComponent(description)}&state=s1&error_uri=${encodeURIComponent('https://login.microsoftonline.com/error?code=65001')}`,
      stored: fresh('s1'),
    })
    expect(run.opener.postMessage).toHaveBeenCalledWith({
      type: MICROSOFT_OAUTH_MESSAGE_TYPE, state: 's1', error: 'consent_required', errorCodes: ['65001', '90094'],
    }, ORIGIN)
    const text = JSON.stringify(run.opener.postMessage.mock.calls[0])
    for (const leak of ['ann@example.com', 'Trace', 'consented', 'login.microsoftonline']) expect(text).not.toContain(leak)
  })

  it('passes a denial on without a code, and bounds the error codes', () => {
    const many = Array.from({ length: 20 }, (_, i) => `AADSTS${65000 + i}`).join(' ')
    const run = runCallback({ fragment: `#error=access_denied&error_description=${encodeURIComponent(many)}&state=s1&code=x`, stored: fresh('s1') })
    const [message] = run.opener.postMessage.mock.calls[0]! as [Record<string, unknown>, string]
    expect(message).toMatchObject({ type: MICROSOFT_OAUTH_MESSAGE_TYPE, state: 's1', error: 'access_denied' })
    expect(message.code).toBeUndefined()
    expect((message.errorCodes as string[]).length).toBe(5)
    expect((message.errorCodes as string[]).every((code) => /^\d+$/.test(code))).toBe(true)
  })

  it('replaces an error that is not a plain OAuth code', () => {
    const run = runCallback({ fragment: `#error=${encodeURIComponent('free text <b>ann@example.com</b>')}&state=s1`, stored: fresh('s1') })
    expect(run.opener.postMessage).toHaveBeenCalledWith({ type: MICROSOFT_OAUTH_MESSAGE_TYPE, state: 's1', error: 'invalid_response', errorCodes: [] }, ORIGIN)
  })

  it('reports a response with neither code nor error as invalid', () => {
    const run = runCallback({ fragment: '#state=s1', stored: fresh('s1') })
    expect(run.opener.postMessage).toHaveBeenCalledWith({ type: MICROSOFT_OAUTH_MESSAGE_TYPE, state: 's1', error: 'invalid_response', errorCodes: [] }, ORIGIN)
  })

  it.each(['missing', 'closed'] as const)('posts nothing when the opener is %s', (opener) => {
    const run = runCallback({ fragment: fragment('s1'), stored: fresh('s1'), opener })
    expect(run.opener.postMessage).not.toHaveBeenCalled()
    expect(run.win.location.hash).toBe('')
  })
})
