// @vitest-environment node
// Node environment: libsodium rejects jsdom-realm typed arrays (as in packages/core's SDK test).
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The hosted signup pass through the real patched etebase SDK (key derivation,
// msgpack, XMLHttpRequest transport) against an in-memory server. The store must
// branch on the SDK's error classes (ConflictError/PermissionDeniedError), never on text.

// etebase is a dependency of packages/core, not of apps/web; resolve it from there.
const require = createRequire(path.resolve(process.cwd(), '../../packages/core/package.json'))
const HEADER = 'x-silentsuite-registration-token'
const SERVER = 'https://server.test.invalid/'
const PASSWORD = 'SyntheticPass1'
const EMAIL = 'sdk@example.test'
const passes = ['A'.repeat(43), 'B'.repeat(43)]

vi.mock('@/app/lib/config', async (importOriginal) => ({ ...(await importOriginal<object>()), BILLING_API_URL: 'https://billing.test', ETEBASE_SERVER_URL: 'https://server.test.invalid/' }))
vi.mock('@/app/lib/self-hosted', () => ({ isSelfHosted: false, isCustomServer: () => false }))
vi.mock('@/app/lib/secure-storage', () => ({
  secureGet: vi.fn(), secureSet: vi.fn(), secureRemove: vi.fn(), secureRemoveIfEqual: vi.fn(), secureClear: vi.fn(), migrateFromLocalStorage: vi.fn(), SESSION_OWNER_KEY: 'owner',
}))

type Recorded = { url: string; headers: Record<string, string>; body?: Uint8Array }
type Codec = { msgpackEncode: (v: unknown) => Uint8Array; msgpackDecode: (v: ArrayLike<number>) => any }
const requests: Recorded[] = []
let codec: Codec
let signupBody: any
let signupStatus = 201
let loginChallengeStatus = 200

function respond(req: Recorded): { status: number; body: Uint8Array } {
  const path = new URL(req.url).pathname
  const user = () => ({ username: signupBody.user.username, email: signupBody.user.email, pubkey: signupBody.pubkey, encryptedContent: signupBody.encryptedContent })
  switch (path) {
    case '/api/v1/authentication/signup/':
      // A 409 models an account committed by an earlier attempt whose response was lost.
      signupBody = codec.msgpackDecode(req.body!)
      if (signupStatus === 201) return { status: 201, body: codec.msgpackEncode({ token: 'synthetic-token', user: user() }) }
      return { status: signupStatus, body: codec.msgpackEncode({ code: signupStatus === 409 ? 'user_exists' : 'registration_token_required', detail: 'x' }) }
    case '/api/v1/authentication/login_challenge/':
      if (loginChallengeStatus === 401) return { status: 401, body: codec.msgpackEncode({ code: 'user_not_init', detail: 'User not properly init' }) }
      return { status: 200, body: codec.msgpackEncode({ salt: signupBody.salt, challenge: new Uint8Array(32), version: 1 }) }
    case '/api/v1/authentication/login/':
      return { status: 200, body: codec.msgpackEncode({ token: 'synthetic-token-2', user: user() }) }
    default:
      return { status: 404, body: codec.msgpackEncode({ detail: 'not found' }) }
  }
}

class FakeXMLHttpRequest {
  responseType = ''; status = 0; statusText = ''; response: ArrayBuffer | null = null
  onload: (() => void) | null = null; onerror: (() => void) | null = null; ontimeout: (() => void) | null = null; onabort: (() => void) | null = null
  private url = ''; private headers: Record<string, string> = {}
  open(_method: string, url: string) { this.url = url }
  setRequestHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value }
  send(body?: Uint8Array) {
    const recorded = { url: this.url, headers: this.headers, body }
    requests.push(recorded)
    const result = respond(recorded)
    this.status = result.status
    this.response = result.body.slice().buffer
    queueMicrotask(() => this.onload?.())
  }
}

let store: typeof import('../use-auth-store')
let billingResponses: Response[] = []
const signups = () => requests.filter((r) => new URL(r.url).pathname === '/api/v1/authentication/signup/')
const passFetches = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === 'https://billing.test/auth/signup-pass/v2')

beforeAll(async () => {
  vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest)
  codec = require('etebase/dist/lib-cjs/Helpers.js')
  store = await import('../use-auth-store')
}, 120_000)
afterAll(() => { vi.unstubAllGlobals() })
beforeEach(() => {
  requests.length = 0
  signupBody = undefined
  signupStatus = 201
  loginChallengeStatus = 200
  billingResponses = []
  vi.stubGlobal('fetch', vi.fn(async () => billingResponses.shift() ?? new Response('{}', { status: 503 })))
  store.useAuthStore.setState({ pendingSignup: { email: EMAIL }, error: null, isLoading: false })
})
const pass = (value: string) => new Response(JSON.stringify({ signupPass: value, expiresIn: 600 }), { status: 200 })
const intent = { kind: 'intent' as const, checkoutIntentToken: 'signed.checkout.intent' }

describe('hosted signup pass through the real SDK', () => {
  it('sends the pass only as the signup header', async () => {
    billingResponses = [pass(passes[0])]
    await store.useAuthStore.getState().createEtebaseAccount(EMAIL, PASSWORD, undefined, undefined, intent)
    expect(signups()).toHaveLength(1)
    expect(signups()[0].headers[HEADER]).toBe(passes[0])
    for (const r of requests) if (r.body) expect(Buffer.from(r.body).toString('latin1')).not.toContain(passes[0])
  }, 120_000)

  it('ConflictError (committed, response lost) logs in to the existing account', async () => {
    billingResponses = [pass(passes[0])]
    signupStatus = 409
    await store.useAuthStore.getState().createEtebaseAccount(EMAIL, PASSWORD, undefined, undefined, intent)
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual(['/api/v1/authentication/signup/', '/api/v1/authentication/login_challenge/', '/api/v1/authentication/login/'])
    expect(store.useAuthStore.getState().pendingSignup?.etebaseAccountReady).toBe(true)
  }, 120_000)

  it('PermissionDeniedError gets one fresh pass and one retry, then a generic refusal', async () => {
    billingResponses = [pass(passes[0]), pass(passes[1])]
    signupStatus = 403
    await expect(store.useAuthStore.getState().createEtebaseAccount(EMAIL, PASSWORD, undefined, undefined, intent))
      .rejects.toBeInstanceOf(store.HostedSignupRefusedError)
    expect(passFetches()).toHaveLength(2)
    expect(signups().map((r) => r.headers[HEADER])).toEqual(passes)
  }, 120_000)

  it('the SDK user_not_init login fallback is refused (403) and fails closed', async () => {
    // An earlier signup body gives the fake server a user to describe.
    signupBody = { user: { username: EMAIL, email: EMAIL }, salt: new Uint8Array(32), pubkey: new Uint8Array(32), encryptedContent: new Uint8Array(32) }
    billingResponses = [new Response(JSON.stringify({ code: 'signup-name-taken' }), { status: 409 })]
    loginChallengeStatus = 401
    signupStatus = 403
    await expect(store.useAuthStore.getState().createEtebaseAccount(EMAIL, PASSWORD, undefined, undefined, intent))
      .rejects.toThrow('An account with this email already exists. Please log in instead.')
    expect(signups()).toHaveLength(1)
    expect(signups()[0].headers[HEADER]).toBeUndefined()
    expect(store.useAuthStore.getState().pendingSignup?.etebaseAccountReady).toBeUndefined()
  }, 120_000)
})
