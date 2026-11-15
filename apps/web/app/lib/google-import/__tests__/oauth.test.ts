import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bumpAccountEpoch } from '@/app/lib/account-epoch'

vi.mock('@/app/stores/use-auth-store', async () => {
  const { create } = await import('zustand')
  return { useAuthStore: create<{ user: { id: string } | null }>(() => ({ user: { id: 'user-1' } })) }
})

import { useAuthStore } from '@/app/stores/use-auth-store'
import {
  GOOGLE_CALENDAR_SCOPE,
  GOOGLE_CALLBACK_PATH,
  OAUTH_MESSAGE_TYPE,
  OAUTH_STATE_KEY,
  OAUTH_TIMEOUT_MS,
  clearGoogleAccessToken,
  getGoogleAccessToken,
  signInWithGoogle,
} from '../oauth'

const ORIGIN = 'https://app.silentsuite.io'
const TOKEN = 'ya29.secret-access-token'

function fakeWindow(options: { blocked?: boolean } = {}) {
  const target = new EventTarget()
  const popup = {
    closed: false,
    close: vi.fn(() => { popup.closed = true }),
    location: { replace: vi.fn() },
  }
  const open = vi.fn(() => (options.blocked ? null : popup))
  const win = {
    location: { origin: ORIGIN },
    localStorage: window.localStorage,
    open,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  }
  const authUrl = () => new URL(open.mock.calls[0]![0] as unknown as string)
  const state = () => authUrl().searchParams.get('state')!
  const send = (data: unknown, from: { origin?: string; source?: unknown } = {}) => {
    const event = new Event('message')
    Object.defineProperties(event, {
      origin: { value: from.origin ?? ORIGIN },
      source: { value: 'source' in from ? from.source : popup },
      data: { value: data },
    })
    target.dispatchEvent(event)
  }
  const grant = (overrides: Record<string, unknown> = {}) => send({
    type: OAUTH_MESSAGE_TYPE, state: state(), accessToken: TOKEN, expiresIn: '3599', scope: GOOGLE_CALENDAR_SCOPE, ...overrides,
  })
  return { win: win as unknown as Window, popup, open, authUrl, state, send, grant }
}

function storageHoldsToken(): boolean {
  const all = [window.localStorage, window.sessionStorage].flatMap((store) =>
    Array.from({ length: store.length }, (_, i) => `${store.key(i)}=${store.getItem(store.key(i)!)}`))
  return all.some((entry) => entry.includes(TOKEN))
}

const signIn = (win: Window) => signInWithGoogle({ clientId: 'client-1.apps.googleusercontent.com', scopes: [GOOGLE_CALENDAR_SCOPE], win })

describe('Google import sign-in', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    window.localStorage.clear()
    useAuthStore.setState({ user: { id: 'user-1' } })
  })
  afterEach(() => {
    clearGoogleAccessToken()
    vi.useRealTimers()
  })

  it('opens Google with the token flow, an exact callback and a random single-use state', async () => {
    const a = fakeWindow()
    const pending = signIn(a.win)
    const url = a.authUrl()
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('response_type')).toBe('token')
    expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}${GOOGLE_CALLBACK_PATH}`)
    expect(url.searchParams.get('scope')).toBe(GOOGLE_CALENDAR_SCOPE)
    expect(a.state()).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(JSON.parse(window.localStorage.getItem(OAUTH_STATE_KEY)!).state).toBe(a.state())

    const b = fakeWindow()
    void signIn(b.win).catch(() => undefined)
    expect(b.state()).not.toBe(a.state())
    await expect(pending).rejects.toMatchObject({ reason: 'cancelled' })
  })

  it('keeps a verified token only in memory and removes the state', async () => {
    const f = fakeWindow()
    const pending = signIn(f.win)
    f.grant()
    await pending
    expect(getGoogleAccessToken()).toBe(TOKEN)
    expect(window.localStorage.getItem(OAUTH_STATE_KEY)).toBeNull()
    expect(storageHoldsToken()).toBe(false)
    expect(f.popup.close).toHaveBeenCalled()
  })

  it('ignores messages from another origin or another window, then accepts the popup', async () => {
    const g = fakeWindow()
    const second = signIn(g.win)
    g.send({ type: OAUTH_MESSAGE_TYPE, state: g.state(), accessToken: 'evil', scope: GOOGLE_CALENDAR_SCOPE }, { origin: 'https://evil.example' })
    g.send({ type: OAUTH_MESSAGE_TYPE, state: g.state(), accessToken: 'evil', scope: GOOGLE_CALENDAR_SCOPE }, { source: {} })
    g.send({ type: OAUTH_MESSAGE_TYPE, state: g.state(), accessToken: 'evil', scope: GOOGLE_CALENDAR_SCOPE }, { source: null })
    expect(getGoogleAccessToken()).toBeNull()
    g.grant()
    await second
    expect(getGoogleAccessToken()).toBe(TOKEN)
  })

  it('rejects a wrong state from the popup and keeps no token', async () => {
    const f = fakeWindow()
    const pending = signIn(f.win)
    f.grant({ state: 'not-the-state' })
    await expect(pending).rejects.toMatchObject({ reason: 'invalid' })
    expect(getGoogleAccessToken()).toBeNull()
  })

  it.each([
    ['denied', { error: 'access_denied', accessToken: undefined }],
    ['scope', { scope: 'https://www.googleapis.com/auth/userinfo.email' }],
    ['invalid', { accessToken: '' }],
  ])('fails as %s and keeps no token', async (reason, overrides) => {
    const f = fakeWindow()
    const pending = signIn(f.win)
    f.grant(overrides)
    await expect(pending).rejects.toMatchObject({ reason })
    expect(getGoogleAccessToken()).toBeNull()
  })

  it('reports a blocked popup', async () => {
    const f = fakeWindow({ blocked: true })
    await expect(signIn(f.win)).rejects.toMatchObject({ reason: 'blocked' })
    expect(window.localStorage.getItem(OAUTH_STATE_KEY)).toBeNull()
  })

  it('reports a popup closed before it finished', async () => {
    const f = fakeWindow()
    const pending = signIn(f.win)
    f.popup.closed = true
    vi.advanceTimersByTime(1000)
    await expect(pending).rejects.toMatchObject({ reason: 'closed' })
  })

  it('times out', async () => {
    const f = fakeWindow()
    const pending = signIn(f.win)
    vi.advanceTimersByTime(OAUTH_TIMEOUT_MS)
    await expect(pending).rejects.toMatchObject({ reason: 'timeout' })
    expect(f.popup.close).toHaveBeenCalled()
  })

  it('cancel stops a waiting sign-in', async () => {
    const f = fakeWindow()
    const pending = signIn(f.win)
    clearGoogleAccessToken()
    await expect(pending).rejects.toMatchObject({ reason: 'cancelled' })
    f.grant()
    expect(getGoogleAccessToken()).toBeNull()
  })

  async function signedIn() {
    const f = fakeWindow()
    const pending = signIn(f.win)
    f.grant()
    await pending
    expect(getGoogleAccessToken()).toBe(TOKEN)
  }

  it('clears the token on cancel / completion', async () => {
    await signedIn()
    clearGoogleAccessToken()
    expect(getGoogleAccessToken()).toBeNull()
  })

  it('clears the token at logout', async () => {
    await signedIn()
    useAuthStore.setState({ user: null })
    expect(getGoogleAccessToken()).toBeNull()
    useAuthStore.setState({ user: { id: 'user-1' } })
    expect(getGoogleAccessToken()).toBeNull()
  })

  it('clears the token at an account switch', async () => {
    await signedIn()
    useAuthStore.setState({ user: { id: 'user-2' } })
    expect(getGoogleAccessToken()).toBeNull()
  })

  it('clears the token when the account epoch moves on', async () => {
    await signedIn()
    bumpAccountEpoch()
    expect(getGoogleAccessToken()).toBeNull()
  })

  it('refuses a sign-in that finishes after an account switch', async () => {
    const f = fakeWindow()
    const pending = signIn(f.win)
    useAuthStore.setState({ user: { id: 'user-2' } })
    f.grant()
    await expect(pending).rejects.toMatchObject({ reason: 'account-changed' })
    expect(getGoogleAccessToken()).toBeNull()
  })

  it('drops an expired token', async () => {
    await signedIn()
    vi.advanceTimersByTime(3600 * 1000)
    expect(getGoogleAccessToken()).toBeNull()
  })
})
