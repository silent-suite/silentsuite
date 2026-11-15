import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bumpAccountEpoch } from '@/app/lib/account-epoch'

vi.mock('@/app/stores/use-auth-store', async () => {
  const { create } = await import('zustand')
  return { useAuthStore: create<{ user: { id: string } | null }>(() => ({ user: { id: 'user-1' } })) }
})

import { useAuthStore } from '@/app/stores/use-auth-store'
import {
  MICROSOFT_AUTHORITY,
  MICROSOFT_CALENDAR_SCOPE,
  MICROSOFT_CALLBACK_PATH,
  MICROSOFT_CONTACTS_SCOPE,
  MICROSOFT_EXCHANGE_TIMEOUT_MS,
  MICROSOFT_OAUTH_MESSAGE_TYPE,
  MICROSOFT_OAUTH_STATE_KEY,
  MICROSOFT_OAUTH_TIMEOUT_MS,
  MICROSOFT_POPUP_NAME,
  MicrosoftAuthError,
  clearMicrosoftAccessToken,
  getMicrosoftAccessToken,
  signInWithMicrosoft,
} from '../oauth'

const ORIGIN = 'https://app.silentsuite.io'
const CLIENT_ID = '11111111-2222-3333-4444-555555555555'
const TID = '9188040d-6c67-4c5b-b112-36a304b66dad'
const SUB = 'AAAAAAAAAAAAAAAAAAAAAIkzqFVrSaSaFHy782bbtaQ'
const CODE = 'M.C507_BAY.2.U.secret-authorization-code'
const TOKEN = 'EwBIA8l6BAAU.secret-access-token'
const REFRESH = 'M.C507_BAY.secret-refresh-token'

function b64url(text: string): string {
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function idToken(claims: Record<string, unknown> = { aud: CLIENT_ID, sub: SUB, tid: TID }): string {
  return `${b64url(JSON.stringify({ typ: 'JWT', alg: 'RS256' }))}.${b64url(JSON.stringify(claims))}.c2lnbmF0dXJl`
}

function tokenBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token_type: 'Bearer',
    scope: 'https://graph.microsoft.com/Calendars.Read openid',
    expires_in: 3599,
    ext_expires_in: 3599,
    access_token: TOKEN,
    id_token: idToken(),
    ...overrides,
  }
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** A token endpoint whose responses the test releases one by one. */
function deferredFetcher() {
  const calls: { url: string; init: RequestInit; resolve: (r: Response) => void; reject: (e: unknown) => void }[] = []
  const fetcher = vi.fn((url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    calls.push({ url, init, resolve, reject })
  }))
  return { fetcher: fetcher as unknown as typeof fetch, calls }
}

async function flush(times = 10) {
  for (let i = 0; i < times; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

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
  const authUrl = () => new URL(popup.location.replace.mock.calls[0]![0] as unknown as string)
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
  const grant = (overrides: Record<string, unknown> = {}) => send({ type: MICROSOFT_OAUTH_MESSAGE_TYPE, state: state(), code: CODE, ...overrides })
  /** The callback's behaviour: post the code, then close itself. */
  const grantAndClose = () => {
    grant()
    popup.closed = true
  }
  return { win: win as unknown as Window, popup, open, authUrl, state, send, grant, grantAndClose }
}

/** Waits for the PKCE challenge, after which the popup is sent to Microsoft. */
async function started(f: ReturnType<typeof fakeWindow>) {
  for (let i = 0; i < 10_000 && f.popup.location.replace.mock.calls.length === 0; i++) await flush(1)
  expect(f.popup.location.replace).toHaveBeenCalledTimes(1)
}

function storageText(): string {
  return [window.localStorage, window.sessionStorage].flatMap((store) =>
    Array.from({ length: store.length }, (_, i) => `${store.key(i)}=${store.getItem(store.key(i)!)}`)).join('\n')
}

async function sha256Url(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  let binary = ''
  for (const byte of digest) binary += String.fromCharCode(byte)
  return b64url(binary)
}

function begin(options: { scope?: string; blocked?: boolean; timeoutMs?: number; exchangeTimeoutMs?: number } = {}) {
  const f = fakeWindow({ blocked: options.blocked })
  const t = deferredFetcher()
  const pending = signInWithMicrosoft({
    clientId: CLIENT_ID,
    scope: options.scope ?? MICROSOFT_CALENDAR_SCOPE,
    win: f.win,
    fetcher: t.fetcher,
    timeoutMs: options.timeoutMs,
    exchangeTimeoutMs: options.exchangeTimeoutMs,
  })
  // Keep a rejection from being reported as unhandled before the test awaits it.
  pending.catch(() => undefined)
  return { ...f, ...t, pending }
}

/** Signs in through to a pending token POST. */
async function exchanging(options: Parameters<typeof begin>[0] = {}) {
  const s = begin(options)
  await started(s)
  s.grantAndClose()
  await flush()
  expect(s.calls).toHaveLength(1)
  return s
}

async function signedIn() {
  const s = await exchanging()
  s.calls[0]!.resolve(jsonResponse(tokenBody()))
  await expect(s.pending).resolves.toEqual({ accountId: `${TID}.${SUB}`, token: expect.any(Function), release: expect.any(Function) })
  expect(getMicrosoftAccessToken()).toBe(TOKEN)
  return s
}

describe('Microsoft import sign-in', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    window.localStorage.clear()
    window.sessionStorage.clear()
    useAuthStore.setState({ user: { id: 'user-1' } })
  })
  afterEach(() => {
    clearMicrosoftAccessToken()
    vi.useRealTimers()
  })

  it('opens Microsoft with code + PKCE S256, fragment mode, an exact callback and openid plus one read scope', async () => {
    const s = begin()
    expect(s.open).toHaveBeenCalledWith('about:blank', MICROSOFT_POPUP_NAME, expect.any(String))
    await started(s)
    const url = s.authUrl()
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: `${ORIGIN}${MICROSOFT_CALLBACK_PATH}`,
      response_mode: 'fragment',
      scope: 'openid https://graph.microsoft.com/Calendars.Read',
      state: s.state(),
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    })
    expect(url.searchParams.get('scope')).not.toMatch(/offline_access|profile|User\.Read/i)
    expect(s.state()).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(JSON.parse(window.localStorage.getItem(MICROSOFT_OAUTH_STATE_KEY)!).state).toBe(s.state())

    const other = begin({ scope: MICROSOFT_CONTACTS_SCOPE })
    await started(other)
    expect(other.authUrl().searchParams.get('scope')).toBe('openid https://graph.microsoft.com/Contacts.Read')
    expect(other.state()).not.toBe(s.state())
    await expect(s.pending).rejects.toMatchObject({ reason: 'cancelled' })
  })

  it('refuses a scope other than the two Graph read scopes', async () => {
    const f = fakeWindow()
    await expect(signInWithMicrosoft({ clientId: CLIENT_ID, scope: 'offline_access', win: f.win })).rejects.toMatchObject({ reason: 'invalid' })
    expect(f.open).not.toHaveBeenCalled()
  })

  it('exchanges the code with the in-memory verifier in an exact POST and keeps the token only in memory', async () => {
    const s = begin()
    await started(s)
    const challenge = s.authUrl().searchParams.get('code_challenge')!
    s.grantAndClose()
    await flush()
    expect(s.calls).toHaveLength(1)
    const { url, init } = s.calls[0]!
    expect(url).toBe(`${MICROSOFT_AUTHORITY}/token`)
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    })
    expect(init.signal).toBeInstanceOf(AbortSignal)
    const body = new URLSearchParams(String(init.body))
    expect([...body.keys()]).toEqual(['client_id', 'grant_type', 'code', 'redirect_uri', 'code_verifier', 'scope'])
    expect(Object.fromEntries(body)).toEqual({
      client_id: CLIENT_ID,
      grant_type: 'authorization_code',
      code: CODE,
      redirect_uri: `${ORIGIN}${MICROSOFT_CALLBACK_PATH}`,
      code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      scope: 'openid https://graph.microsoft.com/Calendars.Read',
    })
    const verifier = body.get('code_verifier')!
    expect(await sha256Url(verifier)).toBe(challenge)
    expect(storageText()).not.toContain(verifier)
    expect(String(s.popup.location.replace.mock.calls[0]![0])).not.toContain(verifier)

    s.calls[0]!.resolve(jsonResponse(tokenBody({ refresh_token: REFRESH })))
    await expect(s.pending).resolves.toEqual({ accountId: `${TID}.${SUB}`, token: expect.any(Function), release: expect.any(Function) })
    expect(getMicrosoftAccessToken()).toBe(TOKEN)
    const stored = storageText()
    for (const secret of [verifier, TOKEN, REFRESH, CODE]) expect(stored).not.toContain(secret)
    expect(window.localStorage.getItem(MICROSOFT_OAUTH_STATE_KEY)).toBeNull()
  })

  it('uses sub alone as the account id when the id_token has no tid', async () => {
    const s = await exchanging()
    s.calls[0]!.resolve(jsonResponse(tokenBody({ id_token: idToken({ aud: CLIENT_ID, sub: SUB }) })))
    await expect(s.pending).resolves.toEqual({ accountId: SUB, token: expect.any(Function), release: expect.any(Function) })
  })

  it.each([
    'openid Calendars.Read',
    'https://graph.microsoft.com/Calendars.Read openid profile email',
    'openid calendars.read',
    'HTTPS://GRAPH.MICROSOFT.COM/CALENDARS.READ',
  ])('accepts the granted scope %j', async (scope) => {
    const s = await exchanging()
    s.calls[0]!.resolve(jsonResponse(tokenBody({ scope })))
    await expect(s.pending).resolves.toBeTruthy()
    expect(getMicrosoftAccessToken()).toBe(TOKEN)
  })

  it.each([
    ['scope', { scope: 'openid https://graph.microsoft.com/Contacts.Read' }],
    ['scope', { scope: 'openid' }],
    ['scope', { scope: undefined }],
    ['scope', { scope: 'openid https://graph.microsoft.com/Calendars.ReadWrite' }],
    ['invalid', { id_token: idToken({ aud: 'another-client', sub: SUB }) }],
    ['invalid', { id_token: idToken({ aud: [CLIENT_ID], sub: SUB }) }],
    ['invalid', { id_token: idToken({ aud: CLIENT_ID, sub: '' }) }],
    ['invalid', { id_token: idToken({ aud: CLIENT_ID }) }],
    ['invalid', { id_token: idToken({ aud: CLIENT_ID, sub: SUB, tid: '' }) }],
    ['invalid', { id_token: 'not-a-jwt' }],
    ['invalid', { id_token: undefined }],
    ['invalid', { token_type: 'pop' }],
    ['invalid', { access_token: '' }],
    ['invalid', { access_token: 'x'.repeat(20000) }],
    ['invalid', { expires_in: undefined }],
  ])('fails as %s for a token response with %j and keeps no token', async (reason, overrides) => {
    const s = await exchanging()
    s.calls[0]!.resolve(jsonResponse(tokenBody(overrides)))
    await expect(s.pending).rejects.toMatchObject({ reason })
    expect(getMicrosoftAccessToken()).toBeNull()
  })

  it.each([
    ['invalid', { error: 'invalid_grant', error_description: 'AADSTS70008: expired', error_codes: [70008] }],
    ['admin', { error: 'invalid_grant', error_description: 'AADSTS65001: consent', error_codes: [65001] }],
  ])('maps a token endpoint error to %s', async (reason, body) => {
    const s = await exchanging()
    s.calls[0]!.resolve(jsonResponse(body, 400))
    await expect(s.pending).rejects.toMatchObject({ reason })
  })

  it('fails invalid when the token POST cannot be sent', async () => {
    const s = await exchanging()
    s.calls[0]!.reject(new TypeError('Failed to fetch'))
    await expect(s.pending).rejects.toMatchObject({ reason: 'invalid' })
  })

  it.each([
    ['denied', 'access_denied', []],
    ['denied', 'access_denied', ['65004']],
    ['admin', 'consent_required', ['65001']],
    ['admin', 'interaction_required', ['90094']],
    ['admin', 'access_denied', ['90095']],
    ['admin', 'invalid_request', ['50011', '65001']],
    ['invalid', 'server_error', ['50000']],
    ['invalid', 'invalid_response', []],
  ])('fails as %s for a callback error %s %j without a token POST', async (reason, error, errorCodes) => {
    const s = begin()
    await started(s)
    s.send({ type: MICROSOFT_OAUTH_MESSAGE_TYPE, state: s.state(), error, errorCodes })
    await expect(s.pending).rejects.toMatchObject({ reason })
    expect(s.calls).toHaveLength(0)
  })

  it('gives the admin failure a message about organization approval', () => {
    expect(new MicrosoftAuthError('admin').message).toBe('Your organization needs an administrator to approve SilentSuite before you can import from this account.')
    expect(new MicrosoftAuthError('admin').name).toBe('MicrosoftAuthError')
  })

  it('ignores messages from another origin, another window or of another type, then accepts the popup', async () => {
    const s = begin()
    await started(s)
    const evil = { type: MICROSOFT_OAUTH_MESSAGE_TYPE, state: s.state(), code: 'evil' }
    s.send(evil, { origin: 'https://evil.example' })
    s.send(evil, { source: {} })
    s.send(evil, { source: null })
    s.send({ ...evil, type: 'silentsuite-google-import-oauth' })
    await flush()
    expect(s.calls).toHaveLength(0)
    s.grant()
    await flush()
    expect(s.calls).toHaveLength(1)
    expect(new URLSearchParams(String(s.calls[0]!.init.body)).get('code')).toBe(CODE)
  })

  it('rejects a wrong state from the popup without a token POST', async () => {
    const s = begin()
    await started(s)
    s.grant({ state: 'not-the-state' })
    await expect(s.pending).rejects.toMatchObject({ reason: 'invalid' })
    expect(s.calls).toHaveLength(0)
  })

  it('uses the first code only: a second message during the exchange is ignored', async () => {
    const s = await exchanging()
    s.grant({ code: 'second-code' })
    await flush()
    expect(s.calls).toHaveLength(1)
    s.calls[0]!.resolve(jsonResponse(tokenBody()))
    await expect(s.pending).resolves.toBeTruthy()
  })

  it('reports a blocked popup, and a null popup from the click', async () => {
    const s = begin({ blocked: true })
    await expect(s.pending).rejects.toMatchObject({ reason: 'blocked' })
    expect(window.localStorage.getItem(MICROSOFT_OAUTH_STATE_KEY)).toBeNull()
    const f = fakeWindow()
    await expect(signInWithMicrosoft({ clientId: CLIENT_ID, scope: MICROSOFT_CALENDAR_SCOPE, win: f.win, popup: null })).rejects.toMatchObject({ reason: 'blocked' })
  })

  it('uses a popup opened during the click', async () => {
    const f = fakeWindow()
    const pending = signInWithMicrosoft({ clientId: CLIENT_ID, scope: MICROSOFT_CALENDAR_SCOPE, win: f.win, popup: f.popup as unknown as Window })
    pending.catch(() => undefined)
    await started(f)
    expect(f.open).not.toHaveBeenCalled()
    clearMicrosoftAccessToken()
    await expect(pending).rejects.toMatchObject({ reason: 'cancelled' })
  })

  it('reports a popup closed before it sent a code', async () => {
    const s = begin()
    await started(s)
    s.popup.closed = true
    vi.advanceTimersByTime(1000)
    await expect(s.pending).rejects.toMatchObject({ reason: 'closed' })
  })

  it('times out while waiting for the popup', async () => {
    const s = begin()
    await started(s)
    vi.advanceTimersByTime(MICROSOFT_OAUTH_TIMEOUT_MS)
    await expect(s.pending).rejects.toMatchObject({ reason: 'timeout' })
    expect(s.popup.close).toHaveBeenCalled()
  })

  describe('run lifecycle with a pending token exchange', () => {
    it('succeeds when the callback closed and the exchange outlasts the closed-poll window and the popup timeout', async () => {
      const s = await exchanging({ timeoutMs: 2000 })
      vi.advanceTimersByTime(10_000)
      await flush()
      s.calls[0]!.resolve(jsonResponse(tokenBody()))
      await expect(s.pending).resolves.toEqual({ accountId: `${TID}.${SUB}`, token: expect.any(Function), release: expect.any(Function) })
      expect(getMicrosoftAccessToken()).toBe(TOKEN)
    })

    it('cancel aborts the POST and a late response sets no token', async () => {
      const s = await exchanging()
      clearMicrosoftAccessToken()
      await expect(s.pending).rejects.toMatchObject({ reason: 'cancelled' })
      expect(s.calls[0]!.init.signal!.aborted).toBe(true)
      s.calls[0]!.resolve(jsonResponse(tokenBody()))
      await flush()
      expect(getMicrosoftAccessToken()).toBeNull()
    })

    it.each([
      ['logout', null],
      ['account switch', { id: 'user-2' }],
    ])('%s aborts the POST as account-changed and a late response sets no token', async (_, user) => {
      const s = await exchanging()
      useAuthStore.setState({ user })
      await expect(s.pending).rejects.toMatchObject({ reason: 'account-changed' })
      expect(s.calls[0]!.init.signal!.aborted).toBe(true)
      s.calls[0]!.resolve(jsonResponse(tokenBody()))
      await flush()
      useAuthStore.setState({ user: { id: 'user-1' } })
      expect(getMicrosoftAccessToken()).toBeNull()
    })

    it('discards a response that arrives after the account epoch moved on', async () => {
      const s = await exchanging()
      bumpAccountEpoch()
      s.calls[0]!.resolve(jsonResponse(tokenBody()))
      await expect(s.pending).rejects.toMatchObject({ reason: 'account-changed' })
      expect(getMicrosoftAccessToken()).toBeNull()
    })

    it('a new sign-in aborts the old run; the old run\'s late success is ignored and the new token stays', async () => {
      const old = await exchanging()
      const next = await exchanging()
      await expect(old.pending).rejects.toMatchObject({ reason: 'cancelled' })
      expect(old.calls[0]!.init.signal!.aborted).toBe(true)
      next.calls[0]!.resolve(jsonResponse(tokenBody({ access_token: 'new-token' })))
      await expect(next.pending).resolves.toBeTruthy()
      old.calls[0]!.resolve(jsonResponse(tokenBody({ access_token: 'old-token' })))
      await flush()
      expect(getMicrosoftAccessToken()).toBe('new-token')
    })

    it('an old run whose fetch ignores the abort cannot publish before the new run finishes', async () => {
      const old = await exchanging()
      const next = await exchanging()
      old.calls[0]!.resolve(jsonResponse(tokenBody({ access_token: 'old-token' })))
      await flush()
      expect(getMicrosoftAccessToken()).toBeNull()
      next.calls[0]!.resolve(jsonResponse(tokenBody({ access_token: 'new-token' })))
      await expect(next.pending).resolves.toBeTruthy()
      expect(getMicrosoftAccessToken()).toBe('new-token')
    })

    it('times out at the exchange deadline, aborting the POST', async () => {
      const s = await exchanging()
      vi.advanceTimersByTime(MICROSOFT_EXCHANGE_TIMEOUT_MS)
      await expect(s.pending).rejects.toMatchObject({ reason: 'timeout' })
      expect(s.calls[0]!.init.signal!.aborted).toBe(true)
      s.calls[0]!.resolve(jsonResponse(tokenBody()))
      await flush()
      expect(getMicrosoftAccessToken()).toBeNull()
    })

    it('abort also covers reading the response body', async () => {
      const s = await exchanging()
      let release!: (text: string) => void
      const slowBody = { ok: true, status: 200, text: () => new Promise<string>((resolve) => { release = resolve }) }
      s.calls[0]!.resolve(slowBody as unknown as Response)
      await flush()
      expect(release).toBeTypeOf('function')
      clearMicrosoftAccessToken()
      await expect(s.pending).rejects.toMatchObject({ reason: 'cancelled' })
      release(JSON.stringify(tokenBody()))
      await flush()
      expect(getMicrosoftAccessToken()).toBeNull()
    })

    it('the deadline also covers reading the response body', async () => {
      const s = await exchanging()
      const slowBody = { ok: true, status: 200, text: () => new Promise<string>(() => undefined) }
      s.calls[0]!.resolve(slowBody as unknown as Response)
      await flush()
      vi.advanceTimersByTime(MICROSOFT_EXCHANGE_TIMEOUT_MS)
      await expect(s.pending).rejects.toMatchObject({ reason: 'timeout' })
    })
  })

  describe('token holder', () => {
    it('clears the token on cancel / completion', async () => {
      await signedIn()
      clearMicrosoftAccessToken()
      expect(getMicrosoftAccessToken()).toBeNull()
    })

    it('clears the token at logout', async () => {
      await signedIn()
      useAuthStore.setState({ user: null })
      expect(getMicrosoftAccessToken()).toBeNull()
      useAuthStore.setState({ user: { id: 'user-1' } })
      expect(getMicrosoftAccessToken()).toBeNull()
    })

    it('clears the token at an account switch', async () => {
      await signedIn()
      useAuthStore.setState({ user: { id: 'user-2' } })
      expect(getMicrosoftAccessToken()).toBeNull()
    })

    it('clears the token when the account epoch moves on', async () => {
      await signedIn()
      bumpAccountEpoch()
      expect(getMicrosoftAccessToken()).toBeNull()
    })

    it('drops an expired token, and caps the lifetime at one hour', async () => {
      await signedIn()
      vi.advanceTimersByTime(3599 * 1000)
      expect(getMicrosoftAccessToken()).toBeNull()

      const s = await exchanging()
      s.calls[0]!.resolve(jsonResponse(tokenBody({ expires_in: 86400 })))
      await s.pending
      expect(getMicrosoftAccessToken(Date.now() + 3599 * 1000)).toBe(TOKEN)
      expect(getMicrosoftAccessToken(Date.now() + 3600 * 1000)).toBeNull()
    })

    it('a new sign-in drops the token held from an earlier one', async () => {
      await signedIn()
      begin()
      expect(getMicrosoftAccessToken()).toBeNull()
    })

    it("an earlier sign-in's reads never get a newer sign-in's token", async () => {
      const first = await signedIn()
      const a = (await first.pending) as { token: () => string | null }
      expect(a.token()).toBe(TOKEN)

      const s = await exchanging()
      s.calls[0]!.resolve(jsonResponse(tokenBody({ access_token: 'token-of-account-b' })))
      const b = (await s.pending) as { token: () => string | null }

      expect(b.token()).toBe('token-of-account-b')
      expect(a.token()).toBeNull()
    })
  })
})

describe('Microsoft import runs started from both buttons (#48)', () => {
  it('a contacts import started while the calendar sign-in is pending is not cancelled by the first run ending', async () => {
    const { loadMicrosoftCalendars, loadMicrosoftContacts } = await import('../importer')
    const { createGraphFake } = await import('./graph-fake')
    const graph = createGraphFake({ contacts: [{ id: 'imm-1', displayName: 'Ann' }] })
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === `${MICROSOFT_AUTHORITY}/token`) {
        return jsonResponse(tokenBody({ access_token: 'graph-token', scope: 'https://graph.microsoft.com/Contacts.Read openid' }))
      }
      return graph.fetch(input, init)
    }) as typeof fetch
    const sleep = async () => undefined

    const calendarWin = fakeWindow()
    const first = loadMicrosoftCalendars({ clientId: CLIENT_ID, win: calendarWin.win, fetcher, sleep })
    const firstOutcome = first.then(() => 'loaded', (err: unknown) => (err as MicrosoftAuthError).reason)
    await started(calendarWin)

    const contactsWin = fakeWindow()
    const second = loadMicrosoftContacts({ clientId: CLIENT_ID, win: contactsWin.win, fetcher, sleep })
    expect(await firstOutcome).toBe('cancelled')
    await started(contactsWin)
    contactsWin.grantAndClose()
    const cards = await second
    expect(cards.map((c) => c.fn)).toEqual(['Ann'])
    // The finished run released its own token.
    expect(getMicrosoftAccessToken()).toBeNull()
  })
})
