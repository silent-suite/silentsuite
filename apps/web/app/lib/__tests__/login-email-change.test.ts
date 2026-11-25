import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { secureClear, secureGetSessionWithIdentity, secureSet } from '../secure-storage'
import { getSessionScope, setSessionScope, TAB_SESSION_KEY } from '../session-scope'

// A readable stand-in for the SDK's saved session: JSON of the restored account.
const core = vi.hoisted(() => ({
  restoreSession: vi.fn(async (_url: string, saved: string) => {
    const data = JSON.parse(saved)
    return { user: { username: data.username }, authToken: data.token, serverUrl: data.serverUrl }
  }),
  saveSession: vi.fn(async (account: any) => JSON.stringify({ username: account.user.username, token: account.authToken, serverUrl: account.serverUrl })),
  logIn: vi.fn(),
  logout: vi.fn(async () => undefined),
  signLoginEmailChange: vi.fn(async () => ({ response: new Uint8Array([1, 2]), signature: new Uint8Array([3]) })),
  encodeLoginEmailChangeRequest: vi.fn(() => new Uint8Array([0x82, 9])),
}))
const state = vi.hoisted(() => ({ user: null as any, live: null as any }))

vi.mock('@silentsuite/core', () => core)
vi.mock('@/app/lib/self-hosted', () => ({ isSelfHosted: false, isCustomServer: (url?: string) => !!url }))
vi.mock('@/app/lib/config', () => ({ BILLING_API_URL: 'https://billing.test', ETEBASE_SERVER_URL: 'https://server.test/' }))
vi.mock('@/app/stores/use-auth-store', () => ({ useAuthStore: { getState: () => ({ user: state.user }) } }))
vi.mock('@/app/stores/use-etebase-store', () => ({ useEtebaseStore: { getState: () => ({ account: state.live }) } }))

import {
  confirmLoginEmailChange,
  nextSessionIdentity,
  requestLoginEmailChange,
  syncLoginIdentity,
  verifySessionPrincipal,
} from '../login-email-change'

const session = (username: string, token = 'tok-saved') => JSON.stringify({ username, token, serverUrl: 'https://server.test/' })
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const fetchMock = vi.fn()
const whoami = (body: unknown, status = 200) => fetchMock.mockImplementationOnce(async () => json(status, body))

async function savedUsername() {
  const saved = await secureGetSessionWithIdentity()
  return saved ? { username: JSON.parse(saved.session).username, identity: saved.identity } : null
}

beforeEach(async () => {
  await secureClear()
  localStorage.clear()
  sessionStorage.clear()
  setSessionScope(null)
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  Object.values(core).forEach((fn) => (fn as any).mockClear?.())
  state.user = { id: 'billing-1', email: 'contact@example.test', planId: 'annual', rememberDevice: false }
  state.live = null
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('nextSessionIdentity', () => {
  const saved = { id: 7, loginVersion: 1, username: 'a@example.test' }
  it('bootstraps from the first answer and then only accepts the same id with a higher version', () => {
    expect(nextSessionIdentity(null, saved)).toEqual(saved)
    expect(nextSessionIdentity(saved, { id: 7, loginVersion: 2, username: 'b@example.test' })).toEqual({ id: 7, loginVersion: 2, username: 'b@example.test' })
    expect(nextSessionIdentity(saved, { id: 7, loginVersion: 1, username: 'b@example.test' })).toBeNull()
    expect(nextSessionIdentity(saved, { id: 7, loginVersion: 0, username: 'b@example.test' })).toBeNull()
    expect(nextSessionIdentity(saved, { id: 8, loginVersion: 5, username: 'b@example.test' })).toBeNull()
  })
})

describe.each([
  ['tab-only (not remembered)', false],
  ['remembered device', true],
])('whoami identity in the %s scope', (_label, remembered) => {
  beforeEach(async () => {
    state.user.rememberDevice = remembered
    await secureSet('etebase_session', session('old@example.test'), { persist: remembered, owner: 'billing-1' })
    expect(getSessionScope()).toBe(remembered ? 'device' : 'tab')
  })

  it('stores the identity on first restore, then adopts a newer rename with its own token', async () => {
    whoami({ id: 7, loginVersion: 0, username: 'old@example.test' })
    await syncLoginIdentity()
    expect(fetchMock).toHaveBeenCalledWith('https://server.test/api/v1/authentication/whoami/', { headers: { Authorization: 'Token tok-saved' } })
    expect(await savedUsername()).toEqual({ username: 'old@example.test', identity: { id: 7, loginVersion: 0, username: 'old@example.test' } })

    state.live = { authToken: 'tok-saved', user: { username: 'old@example.test' } }
    whoami({ id: 7, loginVersion: 1, username: 'new@example.test' })
    await syncLoginIdentity()
    expect(await savedUsername()).toEqual({ username: 'new@example.test', identity: { id: 7, loginVersion: 1, username: 'new@example.test' } })
    expect(state.live.user.username).toBe('new@example.test')
    // Stored in the same scope as before, never moved.
    expect(getSessionScope()).toBe(remembered ? 'device' : 'tab')
    expect(sessionStorage.getItem(TAB_SESSION_KEY) !== null).toBe(!remembered)
  })

  it('ignores a stale version, another account id, an older server (404) and a malformed answer', async () => {
    whoami({ id: 7, loginVersion: 2, username: 'new@example.test' })
    await syncLoginIdentity()
    const before = await savedUsername()
    expect(before?.username).toBe('new@example.test')

    whoami({ id: 7, loginVersion: 1, username: 'older@example.test' })
    await syncLoginIdentity()
    whoami({ id: 8, loginVersion: 9, username: 'someone@example.test' })
    await syncLoginIdentity()
    whoami({ detail: 'not found' }, 404)
    await syncLoginIdentity()
    whoami({ id: '7', loginVersion: 3, username: 'x@example.test' })
    await syncLoginIdentity()
    expect(await savedUsername()).toEqual(before)
  })

  it('offline rename then restore: the first answer already carries the new name', async () => {
    whoami({ id: 7, loginVersion: 1, username: 'renamed@example.test' })
    await syncLoginIdentity()
    expect(await savedUsername()).toEqual({ username: 'renamed@example.test', identity: { id: 7, loginVersion: 1, username: 'renamed@example.test' } })
  })
})

describe('whoami scope guards', () => {
  it('does nothing for a custom server or when no session is saved', async () => {
    await syncLoginIdentity()
    expect(fetchMock).not.toHaveBeenCalled()
    localStorage.setItem('silentsuite-server-url', 'https://own.example.test')
    await secureSet('etebase_session', session('old@example.test'), { persist: false, owner: 'billing-1' })
    await syncLoginIdentity()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a password-change style re-save without identity bootstraps again later', async () => {
    await secureSet('etebase_session', session('old@example.test'), { persist: false, owner: 'billing-1', identity: { id: 7, loginVersion: 3, username: 'old@example.test' } })
    await secureSet('etebase_session', session('old@example.test', 'tok-2'), { persist: false, owner: 'billing-1' })
    expect((await secureGetSessionWithIdentity())?.identity).toBeNull()
  })
})

describe('requestLoginEmailChange', () => {
  const fresh = { authToken: 'tok-fresh', serverUrl: 'https://server.test/' }

  beforeEach(async () => {
    await secureSet('etebase_session', session('login@example.test'), { persist: false, owner: 'billing-1' })
    core.logIn.mockResolvedValue(fresh)
  })

  it('signs in with the saved session username, never the billing contact, and sends both steps', async () => {
    fetchMock
      .mockImplementationOnce(async () => json(200, { handoff: 'h'.repeat(43), expiresIn: 120 }))
      .mockImplementationOnce(async () => json(200, { status: 'sent' }))
    // Typo case: spaces and capitals are normalised once, for both requests.
    expect(await requestLoginEmailChange('  New@Example.TEST ', 'pw')).toBe('sent')
    expect(core.logIn).toHaveBeenCalledWith('https://server.test/', 'login@example.test', 'pw')
    expect(core.logIn.mock.calls.flat()).not.toContain('contact@example.test')
    expect(core.signLoginEmailChange).toHaveBeenCalledWith(fresh, 'new@example.test')
    const [serverUrl, serverInit] = fetchMock.mock.calls[0]
    expect(serverUrl).toBe('https://server.test/api/v1/billing/login-email/request/')
    expect(serverInit.headers).toEqual({ 'Content-Type': 'application/msgpack', Authorization: 'Token tok-fresh' })
    expect(Array.from(serverInit.body)).toEqual([0x82, 9])
    const [billingUrl, billingInit] = fetchMock.mock.calls[1]
    expect(billingUrl).toBe('https://billing.test/account/login-email/request')
    expect(billingInit.credentials).toBe('include')
    expect(JSON.parse(billingInit.body)).toEqual({ email: 'new@example.test', handoff: 'h'.repeat(43) })
    expect(core.logout).toHaveBeenCalledWith(fresh)
  })

  it.each([
    ['rejected delivery', [json(200, { handoff: 'h'.repeat(43) }), json(200, { status: 'rejected' })], 'rejected'],
    ['unknown delivery', [json(200, { handoff: 'h'.repeat(43) }), json(200, { status: 'unknown' })], 'unknown'],
    ['ineligible account', [json(200, { handoff: 'h'.repeat(43) }), json(409, { type: 'https://api.silentsuite.io/errors/email-change-unavailable' })], 'unavailable'],
    ['billing rate limit', [json(200, { handoff: 'h'.repeat(43) }), json(429, {})], 'rate-limited'],
    ['server same destination', [json(400, { code: 'same_destination' })], 'same-email'],
    ['server invalid destination', [json(400, { code: 'invalid_destination' })], 'invalid-email'],
    ['server signature refused', [json(401, { code: 'invalid_signature' })], 'failed'],
    ['older server without the route', [json(404, {})], 'failed'],
    ['server busy', [json(503, { code: 'try_again' })], 'try-again'],
  ])('%s maps to %s and always logs the fresh account out', async (_label, responses, expected) => {
    for (const response of responses as Response[]) fetchMock.mockImplementationOnce(async () => response)
    expect(await requestLoginEmailChange('new@example.test', 'pw')).toBe(expected)
    expect(core.logout).toHaveBeenCalledTimes(1)
    expect(core.logout).toHaveBeenCalledWith(fresh)
  })

  it('logs the fresh account out when signing or the network throws', async () => {
    core.signLoginEmailChange.mockRejectedValueOnce(new Error('challenge failed'))
    expect(await requestLoginEmailChange('new@example.test', 'pw')).toBe('failed')
    fetchMock.mockRejectedValueOnce(new TypeError('network'))
    expect(await requestLoginEmailChange('new@example.test', 'pw')).toBe('failed')
    expect(core.logout).toHaveBeenCalledTimes(2)
  })

  it('reports a wrong password without any further request', async () => {
    core.logIn.mockRejectedValueOnce(new Error('Wrong password for user.'))
    expect(await requestLoginEmailChange('new@example.test', 'bad')).toBe('wrong-password')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(core.logout).not.toHaveBeenCalled()
  })

  it('refuses the current login and an invalid address before signing in', async () => {
    expect(await requestLoginEmailChange('LOGIN@example.test', 'pw')).toBe('same-email')
    expect(await requestLoginEmailChange('not-an-email', 'pw')).toBe('invalid-email')
    expect(core.logIn).not.toHaveBeenCalled()
  })
})

describe('confirmLoginEmailChange', () => {
  it.each([
    [json(200, { status: 'completed', newLogin: 'n@example.test', contactUpdated: true, contactState: 'applied' }), { kind: 'done', newLogin: 'n@example.test', contactState: 'applied' }],
    [json(200, { status: 'committed', newLogin: 'n@example.test', contactUpdated: false, contactState: 'pending' }), { kind: 'done', newLogin: 'n@example.test', contactState: 'pending' }],
    [json(410, { type: 'x/link-expired' }), { kind: 'expired' }],
    [json(409, { type: 'x/email-change-refused', reason: 'taken' }), { kind: 'refused', reason: 'taken' }],
    [json(503, { type: 'x/try-again' }), { kind: 'try-again' }],
    [json(500, {}), { kind: 'failed' }],
  ])('maps the billing answer %#', async (response, expected) => {
    fetchMock.mockImplementationOnce(async () => response)
    expect(await confirmLoginEmailChange('tok')).toEqual(expected)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://billing.test/account/login-email/confirm')
    expect(JSON.parse(init.body)).toEqual({ token: 'tok' })
  })

  it('treats a network failure as try again', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('network'))
    expect(await confirmLoginEmailChange('tok')).toEqual({ kind: 'try-again' })
  })
})

describe('verifySessionPrincipal (unlock)', () => {
  it('accepts only a whoami id equal to the principal, using the fresh session token', async () => {
    whoami({ id: 7, loginVersion: 1, username: 'new@example.test' })
    expect(await verifySessionPrincipal(session('new@example.test', 'tok-fresh'), 7)).toEqual({ ok: true, identity: { id: 7, loginVersion: 1, username: 'new@example.test' } })
    expect(fetchMock).toHaveBeenCalledWith('https://server.test/api/v1/authentication/whoami/', { headers: { Authorization: 'Token tok-fresh' } })
    expect(core.logout).not.toHaveBeenCalled()
  })

  it.each([
    ['another id', () => whoami({ id: 8, loginVersion: 1, username: 'x@example.test' }), 'mismatch'],
    ['an older server', () => whoami({ detail: 'nope' }, 404), 'unavailable'],
    ['a network failure', () => fetchMock.mockRejectedValueOnce(new TypeError('network')), 'unavailable'],
  ])('refuses %s and logs the fresh session out', async (_label, arrange, reason) => {
    arrange()
    expect(await verifySessionPrincipal(session('x@example.test', 'tok-fresh'), 7)).toEqual({ ok: false, reason })
    expect(core.logout).toHaveBeenCalledTimes(1)
    expect((core.logout.mock.calls[0] as any[])[0]).toMatchObject({ authToken: 'tok-fresh' })
  })
})
