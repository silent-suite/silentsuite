import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OAUTH_MESSAGE_TYPE, OAUTH_STATE_KEY } from '../oauth'

const ORIGIN = 'https://app.silentsuite.io'
const TOKEN = 'ya29.secret-access-token'
const SCRIPT = readFileSync(path.resolve(__dirname, '../../../../public/oauth/google-callback.js'), 'utf8')
const HTML = readFileSync(path.resolve(__dirname, '../../../../public/oauth/google-callback.html'), 'utf8')

function runCallback(options: { fragment: string; stored?: unknown; opener?: 'present' | 'missing' | 'closed' }) {
  const log: string[] = []
  const store = new Map<string, string>()
  if (options.stored !== undefined) store.set(OAUTH_STATE_KEY, JSON.stringify(options.stored))
  const location = { origin: ORIGIN, pathname: '/oauth/google-callback.html', hash: options.fragment, search: '' }
  const status = { textContent: '' }
  const opener = {
    closed: options.opener === 'closed',
    postMessage: vi.fn(() => { log.push('postMessage') }),
  }
  const win = {
    location,
    history: {
      replaceState: vi.fn((_: unknown, __: string, url: string) => {
        log.push('replaceState')
        location.hash = ''
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
const fragment = (state: string) => `#state=${state}&access_token=${TOKEN}&token_type=Bearer&expires_in=3599&scope=${encodeURIComponent('https://www.googleapis.com/auth/calendar.readonly')}`

describe('Google OAuth callback page', () => {
  it('loads only its own same-origin script and sends no referrer', () => {
    const scripts = [...HTML.matchAll(/<script\b[^>]*>/g)].map((m) => m[0])
    expect(scripts).toEqual(['<script src="/oauth/google-callback.js">'])
    expect(HTML).toContain('<meta name="referrer" content="no-referrer">')
    expect(HTML).not.toMatch(/https?:\/\//)
  })

  it('strips the token fragment before anything else, then posts to the opener at our exact origin and closes', () => {
    const run = runCallback({ fragment: fragment('s1'), stored: fresh('s1') })
    expect(run.log[0]).toBe('replaceState')
    expect(run.win.location.hash).toBe('')
    expect(run.win.history.replaceState).toHaveBeenCalledWith(null, '', '/oauth/google-callback.html')
    expect(run.opener.postMessage).toHaveBeenCalledWith({
      type: OAUTH_MESSAGE_TYPE,
      state: 's1',
      accessToken: TOKEN,
      expiresIn: '3599',
      scope: 'https://www.googleapis.com/auth/calendar.readonly',
    }, ORIGIN)
    expect(run.log.slice(-2)).toEqual(['postMessage', 'close'])
    expect(run.store.has(OAUTH_STATE_KEY)).toBe(false)
    expect(run.status.textContent).not.toContain(TOKEN)
  })

  it.each([
    ['a different state', fresh('other')],
    ['no stored state', undefined],
    ['an expired state', { state: 's1', expiresAt: Date.now() - 1 }],
  ])('posts nothing for %s', (_, stored) => {
    const run = runCallback({ fragment: fragment('s1'), stored })
    expect(run.log[0]).toBe('replaceState')
    expect(run.opener.postMessage).not.toHaveBeenCalled()
    expect(run.store.has(OAUTH_STATE_KEY)).toBe(false)
  })

  it('uses the stored state only once', () => {
    const first = runCallback({ fragment: fragment('s1'), stored: fresh('s1') })
    expect(first.opener.postMessage).toHaveBeenCalledTimes(1)
    expect(first.store.size).toBe(0)
  })

  it('passes a denial on without a token', () => {
    const run = runCallback({ fragment: '#error=access_denied&state=s1', stored: fresh('s1') })
    expect(run.opener.postMessage).toHaveBeenCalledWith({ type: OAUTH_MESSAGE_TYPE, state: 's1', error: 'access_denied' }, ORIGIN)
  })

  it.each(['missing', 'closed'] as const)('posts nothing when the opener is %s', (opener) => {
    const run = runCallback({ fragment: fragment('s1'), stored: fresh('s1'), opener })
    expect(run.opener.postMessage).not.toHaveBeenCalled()
    expect(run.win.location.hash).toBe('')
  })
})
