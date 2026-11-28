import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HostedSignupRefusedError, useAuthStore } from '../use-auth-store'

// Hosted signup pass (contract v2, task-evidence contract.md). The shared JSON
// fixture was not available when these tests were written; the shapes below
// follow contract.md: POST /auth/signup-pass/v2 → 200 {signupPass, expiresIn} |
// 400 ownership-required/unsupported-address | 404 not_available | 409 signup-name-taken | 503.

const mocks = vi.hoisted(() => ({ signUp: vi.fn(), logIn: vi.fn(), session: null as string | null }))
vi.mock('@/app/lib/etebase-auth', () => ({ etebaseSignUp: mocks.signUp, etebaseLogIn: mocks.logIn, issueBillingLinkProof: vi.fn() }))
vi.mock('@/app/lib/secure-storage', () => ({
  secureGet: vi.fn(async () => mocks.session), secureSet: vi.fn(async (_key: string, value: string) => { mocks.session = value }),
  secureRemove: vi.fn(), secureRemoveIfEqual: vi.fn(), secureClear: vi.fn(), migrateFromLocalStorage: vi.fn(), SESSION_OWNER_KEY: 'owner',
}))
vi.mock('@/app/lib/config', async (importOriginal) => ({ ...(await importOriginal<object>()), BILLING_API_URL: 'https://billing.test' }))
vi.mock('@/app/lib/self-hosted', () => ({ isSelfHosted: false, isCustomServer: (url?: string) => !!url && url !== 'https://server.silentsuite.io' }))

const email = 'owner@example.test'
const password = 'ValidPass1'
const pass = 'P'.repeat(43)
const intent = { kind: 'intent' as const, checkoutIntentToken: 'signed.checkout.intent' }
const sdkError = (name: string) => Object.assign(new Error('server text is never parsed'), { name })
const ok = { savedSession: 'saved-session', authToken: 'unused' }
const KEY = 'silentsuite-signup-redirect-state'

let passResponses: Array<Response | Error> = []
function billing(status: number, body: unknown) { return new Response(JSON.stringify(body), { status }) }
function passCalls() { return vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === 'https://billing.test/auth/signup-pass/v2') }

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  mocks.session = null
  passResponses = []
  mocks.signUp.mockResolvedValue(ok)
  mocks.logIn.mockResolvedValue(ok)
  vi.stubGlobal('fetch', vi.fn(async () => {
    const next = passResponses.shift() ?? billing(503, {})
    if (next instanceof Error) throw next
    return next
  }))
  useAuthStore.setState({ pendingSignup: { email }, error: null, isLoading: false })
})

describe('pass fetch outcomes on hosted signup', () => {
  it('sends a pass from the intent kind as the registration token', async () => {
    passResponses = [billing(200, { signupPass: pass, expiresIn: 600 })]
    await useAuthStore.getState().createEtebaseAccount(email, password, undefined, undefined, intent)
    expect(passCalls()).toHaveLength(1)
    const [, init] = passCalls()[0]
    expect(JSON.parse(String(init?.body))).toEqual({ contractVersion: 2, kind: 'intent', email, checkoutIntentToken: intent.checkoutIntentToken })
    expect(init?.method).toBe('POST')
    expect(mocks.signUp).toHaveBeenCalledWith(email, password, undefined, undefined, pass)
    expect(useAuthStore.getState().pendingSignup?.etebaseAccountReady).toBe(true)
  })

  it('logs in on Billing 409 signup-name-taken and never signs up', async () => {
    passResponses = [billing(409, { code: 'signup-name-taken' })]
    await useAuthStore.getState().createEtebaseAccount(email, password, undefined, undefined, intent)
    expect(mocks.signUp).not.toHaveBeenCalled()
    expect(mocks.logIn).toHaveBeenCalledWith(email, password, undefined)
  })

  it('a wrong password after name-taken shows the existing "account exists" message', async () => {
    passResponses = [billing(409, { code: 'signup-name-taken' })]
    mocks.logIn.mockRejectedValueOnce(sdkError('UnauthorizedError'))
    await expect(useAuthStore.getState().createEtebaseAccount(email, password, undefined, undefined, intent))
      .rejects.toThrow('An account with this email already exists. Please log in instead.')
    expect(mocks.signUp).not.toHaveBeenCalled()
  })

  it.each([
    ['404 not_available', () => billing(404, { code: 'not_available' })],
    ['400 ownership-required', () => billing(400, { code: 'ownership-required' })],
    ['400 unsupported-address', () => billing(400, { code: 'unsupported-address' })],
    ['503', () => billing(503, {})],
    ['a network failure', () => new TypeError('Failed to fetch')],
    ['a malformed pass', () => billing(200, { signupPass: 'short', expiresIn: 600 })],
    ['a 409 with another code', () => billing(409, { code: 'authority-in-progress' })],
  ])('signs up without a pass after %s and lets the server decide', async (_label, response) => {
    passResponses = [response()]
    await useAuthStore.getState().createEtebaseAccount(email, password, undefined, undefined, intent)
    expect(mocks.signUp).toHaveBeenCalledWith(email, password, undefined)
    expect(mocks.logIn).not.toHaveBeenCalled()
  })

  it('sends the ownership kind with its exact fields', async () => {
    const { requestSignupPass } = await import('@/app/lib/billing-v2')
    passResponses = [billing(200, { signupPass: pass, expiresIn: 600 })]
    const outcome = await requestSignupPass({ fetcher: fetch, billingApiUrl: 'https://billing.test/', email,
      authority: { kind: 'ownership', requestId: 'request-1', emailOwnershipToken: 'signed.ownership.token' } })
    expect(outcome).toEqual({ kind: 'pass', signupPass: pass })
    expect(JSON.parse(String(passCalls()[0][1]?.body))).toEqual({ contractVersion: 2, kind: 'ownership', email, requestId: 'request-1', emailOwnershipToken: 'signed.ownership.token' })
  })

  it('never fetches a pass or sends a token for a custom server', async () => {
    await useAuthStore.getState().createEtebaseAccount(email, password, 'https://sync.example.test', undefined, intent)
    expect(fetch).not.toHaveBeenCalled()
    expect(mocks.signUp).toHaveBeenCalledWith(email, password, 'https://sync.example.test')
  })
})

describe('typed SDK errors at hosted signup', () => {
  it('ConflictError logs in, then the provision/finalize recovery continues from a ready account', async () => {
    passResponses = [billing(200, { signupPass: pass, expiresIn: 600 })]
    mocks.signUp.mockRejectedValueOnce(sdkError('ConflictError'))
    await useAuthStore.getState().createEtebaseAccount(email, password, undefined, undefined, intent)
    expect(mocks.logIn).toHaveBeenCalledTimes(1)
    expect(useAuthStore.getState().pendingSignup?.etebaseAccountReady).toBe(true)
  })

  it('a plain error mentioning "conflict" is not treated as an existing account on hosted', async () => {
    mocks.signUp.mockRejectedValueOnce(new Error('409 conflict'))
    await expect(useAuthStore.getState().createEtebaseAccount(email, password, undefined, undefined, intent)).rejects.toThrow()
    expect(mocks.logIn).not.toHaveBeenCalled()
  })

  it('PermissionDeniedError gets one fresh pass and one retry', async () => {
    passResponses = [billing(200, { signupPass: pass, expiresIn: 600 }), billing(200, { signupPass: 'Q'.repeat(43), expiresIn: 600 })]
    mocks.signUp.mockRejectedValueOnce(sdkError('PermissionDeniedError'))
    await useAuthStore.getState().createEtebaseAccount(email, password, undefined, undefined, intent)
    expect(passCalls()).toHaveLength(2)
    expect(mocks.signUp.mock.calls.map((call) => call[4])).toEqual([pass, 'Q'.repeat(43)])
  })

  it('a second 403 is a generic, typed refusal with no further attempts', async () => {
    passResponses = [billing(200, { signupPass: pass, expiresIn: 600 }), billing(200, { signupPass: pass, expiresIn: 600 })]
    mocks.signUp.mockRejectedValue(sdkError('PermissionDeniedError'))
    const attempt = useAuthStore.getState().createEtebaseAccount(email, password, undefined, undefined, intent)
    await expect(attempt).rejects.toBeInstanceOf(HostedSignupRefusedError)
    await attempt.catch((err: Error) => expect(err.message).toMatch(/Contact support@silentsuite\.io/))
    expect(passCalls()).toHaveLength(2)
    expect(mocks.signUp).toHaveBeenCalledTimes(2)
    expect(useAuthStore.getState().pendingSignup?.etebaseAccountReady).toBeUndefined()
  })

  it('the SDK user_not_init fallback refused by the server (409 or 403) fails closed', async () => {
    for (const name of ['ConflictError', 'PermissionDeniedError']) {
      passResponses = [billing(409, { code: 'signup-name-taken' })]
      mocks.logIn.mockRejectedValueOnce(sdkError(name))
      await expect(useAuthStore.getState().createEtebaseAccount(email, password, undefined, undefined, intent))
        .rejects.toThrow('An account with this email already exists. Please log in instead.')
    }
    expect(mocks.signUp).not.toHaveBeenCalled()
  })
})

describe('etebaseAccountReady in the redirect checkpoint', () => {
  const recovery = { paymentSessionToken: 'R'.repeat(43), paymentSessionRequestKey: '5fd4d86d-34de-4b82-9a66-9598ddf6e02f', paymentMethod: 'stripe' as const, billingContractVersion: 2 as const }

  function saveAndReload(pending: Record<string, unknown>) {
    useAuthStore.setState({ pendingSignup: { email, serverUrl: 'https://server.silentsuite.io', ...recovery, ...pending } })
    useAuthStore.getState().saveSignupStateForRedirect('annual')
    const stored = JSON.parse(sessionStorage.getItem(KEY)!)
    useAuthStore.setState({ pendingSignup: null })
    useAuthStore.getState().restoreSignupStateFromRedirect({ retainForRecovery: true })
    return stored
  }

  it('survives the checkpoint, and the restored page logs in without fetching a pass', async () => {
    const stored = saveAndReload({ etebaseAccountReady: true })
    expect(stored.pendingSignup.etebaseAccountReady).toBe(true)
    await useAuthStore.getState().createEtebaseAccount(email, password, 'https://server.silentsuite.io')
    expect(mocks.logIn).toHaveBeenCalledWith(email, password, 'https://server.silentsuite.io')
    expect(mocks.signUp).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    // The payment token is kept through finalization.
    expect(useAuthStore.getState().pendingSignup).toMatchObject({ ...recovery, etebaseAccountReady: true })
  })

  it('an old-shape checkpoint (flag off) signs up without a pass, as today', async () => {
    // A distinct payment identity: an old-web attempt, not this document's earlier one.
    const oldToken = { paymentSessionToken: 'S'.repeat(43) }
    const stored = saveAndReload(oldToken)
    expect('etebaseAccountReady' in stored.pendingSignup).toBe(false)
    await useAuthStore.getState().createEtebaseAccount(email, password, 'https://server.silentsuite.io')
    expect(mocks.signUp).toHaveBeenCalledWith(email, password, 'https://server.silentsuite.io')
    expect(useAuthStore.getState().pendingSignup).toMatchObject({ ...recovery, ...oldToken, etebaseAccountReady: true })
  })

  it('an old-shape checkpoint (flag on) gets the support refusal after one signup, keeping the checkpoint', async () => {
    const oldToken = { paymentSessionToken: 'T'.repeat(43) }
    saveAndReload(oldToken)
    mocks.signUp.mockRejectedValue(sdkError('PermissionDeniedError'))
    await expect(useAuthStore.getState().createEtebaseAccount(email, password, 'https://server.silentsuite.io')).rejects.toBeInstanceOf(HostedSignupRefusedError)
    expect(mocks.signUp).toHaveBeenCalledTimes(1)
    expect(JSON.parse(sessionStorage.getItem(KEY)!).pendingSignup).toEqual({ email, serverUrl: 'https://server.silentsuite.io', ...recovery, ...oldToken })
  })

  it('rejects anything but literal true when parsing', () => {
    sessionStorage.setItem(KEY, JSON.stringify({ selectedInterval: 'annual', savedAt: Date.now(), pendingSignup: { email, ...recovery, etebaseAccountReady: 'yes' } }))
    expect(useAuthStore.getState().restoreSignupStateFromRedirect()?.pendingSignup.etebaseAccountReady).toBeUndefined()
  })
})
