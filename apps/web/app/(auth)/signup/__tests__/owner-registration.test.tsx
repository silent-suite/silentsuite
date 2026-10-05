import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Opt-in owner registration for an installation-hosted (self-host) build.
// Real page, auth store, etebase-auth wrapper and core signUp/saveSession are exercised;
// only the external Etebase SDK, secure storage sink and browser network are faked.

const ORIGIN = 'https://silentsuite.umbrel.test:8443'
const OWNER_LOGIN_URL = `${ORIGIN}/api/v1/owner/login/`
const OWNER_PASSWORD = 'synthetic-installation-password-0123456789abcdef'
const ACCOUNT_PASSWORD = 'Synthetic-Account-Pass1'
const GRANT = 'synthetic-signed-signup-grant.not-a-secret:AbCdEf'
const TYPED_EMAIL = '  Owner.User@Example.Test '
const USERNAME = 'owner.user@example.test'

const sdk = vi.hoisted(() => ({ signup: vi.fn(), login: vi.fn(), restore: vi.fn() }))
const storage = vi.hoisted(() => ({ set: vi.fn(async (_key: string, _value: string) => {}) }))

// The external SDK, mocked at the exact module core resolves (packages/core dependency).
vi.mock('../../../../../../packages/core/node_modules/etebase', () => ({
  Account: { signup: sdk.signup, login: sdk.login, restore: sdk.restore },
  getPrettyFingerprint: vi.fn(() => 'synthetic fingerprint'),
}))
vi.mock('@/app/lib/secure-storage', () => ({
  secureGet: vi.fn(async () => null),
  secureSet: storage.set,
  secureRemove: vi.fn(), secureClear: vi.fn(), migrateFromLocalStorage: vi.fn(),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('@/app/components/stripe-payment-form', () => ({ default: () => null }))

/** Prospective operation-only options; never stored. */
type OwnerOperation = { ownerPassword: string; signal: AbortSignal }
type CreateWithOwner = (email: string, password: string, serverUrl?: string, owner?: OwnerOperation) => Promise<void>

function fakeAccount() {
  return {
    authToken: 'synthetic-auth-token',
    save: vi.fn(async () => 'synthetic-saved-session'),
    getInvitationManager: () => ({ pubkey: new Uint8Array(32) }),
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

async function load(ownerFlag: string | undefined) {
  const dom = (globalThis as { jsdom?: { reconfigure(options: { url: string }): void } }).jsdom
  if (!dom) throw new Error('fixture: vitest jsdom handle unavailable')
  dom.reconfigure({ url: `${ORIGIN}/signup` })
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
  vi.stubEnv('NEXT_PUBLIC_ETEBASE_SERVER_URL', '')
  if (ownerFlag === undefined) delete process.env.NEXT_PUBLIC_OWNER_REGISTRATION
  else vi.stubEnv('NEXT_PUBLIC_OWNER_REGISTRATION', ownerFlag)
  const { default: SignupPage } = await import('../page')
  const { useAuthStore } = await import('@/app/stores/use-auth-store')
  const auth = await import('@/app/lib/etebase-auth')
  return { SignupPage, useAuthStore, auth }
}

function fillAccountForm(withOwnerPassword: boolean) {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: TYPED_EMAIL } })
  fireEvent.change(screen.getByLabelText('Confirm email'), { target: { value: TYPED_EMAIL } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: ACCOUNT_PASSWORD } })
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: ACCOUNT_PASSWORD } })
  if (withOwnerPassword) {
    fireEvent.change(screen.getByLabelText(/installation password/i), { target: { value: OWNER_PASSWORD } })
  }
}

function ownerFetchCalls() {
  return vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/api/v1/owner/'))
}

function allBrowserState(useAuthStore: { getState(): unknown }) {
  return [
    JSON.stringify(useAuthStore.getState()),
    JSON.stringify({ ...localStorage }),
    JSON.stringify({ ...sessionStorage }),
    JSON.stringify(storage.set.mock.calls),
  ].join('\n')
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  sdk.signup.mockResolvedValue(fakeAccount())
  sdk.login.mockResolvedValue(fakeAccount())
  vi.stubGlobal('XMLHttpRequest', class {
    constructor() { throw new Error('fixture: real SDK transport reached; SDK mock not applied') }
  })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (
    String(url) === OWNER_LOGIN_URL ? json({ registration_token: GRANT, expires_in: 120 }) : json({}, 404)
  )))
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('opted-in owner registration (self-host build)', () => {
  it('logs in as owner once, then passes the grant only as the SDK signup option', async () => {
    const { SignupPage, useAuthStore, auth } = await load('true')
    render(<SignupPage />)

    fillAccountForm(true)
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))

    await waitFor(() => expect(sdk.signup).toHaveBeenCalledTimes(1))
    const owner = ownerFetchCalls()
    expect(owner).toHaveLength(1)
    const [url, init] = owner[0] as [string, RequestInit]
    expect(url).toBe(OWNER_LOGIN_URL)
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    const body = JSON.parse(String(init.body))
    expect(Object.keys(body).sort()).toEqual(['password', 'username'])
    expect(body).toEqual({ password: OWNER_PASSWORD, username: USERNAME })

    expect(sdk.signup).toHaveBeenCalledWith(
      { username: USERNAME, email: USERNAME }, ACCOUNT_PASSWORD, ORIGIN, { registrationToken: GRANT },
    )
    await waitFor(() => expect(storage.set).toHaveBeenCalledWith('etebase_session', 'synthetic-saved-session'))
    const state = allBrowserState(useAuthStore)
    expect(state).not.toContain(OWNER_PASSWORD)
    expect(state).not.toContain(GRANT)

    // A later ordinary login carries no owner credential or grant.
    await auth.etebaseLogIn(USERNAME, ACCOUNT_PASSWORD)
    expect(sdk.login).toHaveBeenLastCalledWith(USERNAME, ACCOUNT_PASSWORD, ORIGIN)
    expect(ownerFetchCalls()).toHaveLength(1)
  })

  it('stops on a rejected installation password without SDK signup, login or session', async () => {
    vi.mocked(fetch).mockImplementation(async () => json({ code: 'owner_login_failed' }, 403))
    const { SignupPage, useAuthStore } = await load('true')
    render(<SignupPage />)

    fillAccountForm(true)
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/installation password/i)
    expect(alert).not.toHaveTextContent(/already exists|log in instead/i)
    expect(ownerFetchCalls()).toHaveLength(1)
    expect(sdk.signup).not.toHaveBeenCalled()
    expect(sdk.login).not.toHaveBeenCalled()
    expect(storage.set).not.toHaveBeenCalled()
    expect(useAuthStore.getState().pendingSignup?.etebaseAccountReady).not.toBe(true)
    expect(allBrowserState(useAuthStore)).not.toContain(OWNER_PASSWORD)
  })

  it('reports a typed owner-auth error from the store, not 409 recovery', async () => {
    vi.mocked(fetch).mockImplementation(async () => json({ code: 'owner_login_failed' }, 403))
    const { useAuthStore } = await load('true')
    const create = useAuthStore.getState().createEtebaseAccount as unknown as CreateWithOwner

    const error = await create(USERNAME, ACCOUNT_PASSWORD, undefined, {
      ownerPassword: OWNER_PASSWORD, signal: new AbortController().signal,
    }).then(() => null, (err: Error) => err)

    expect(error?.name).toBe('OwnerAuthError')
    expect(error?.message).not.toMatch(/already exists|log in instead|account password/i)
    expect(sdk.signup).not.toHaveBeenCalled()
    expect(sdk.login).not.toHaveBeenCalled()
    expect(storage.set).not.toHaveBeenCalled()
  })

  it.each([
    ['a foreign origin', 'https://other-server.example.test'],
    ['a non-root prefix', `${ORIGIN}/prefix`],
  ])('sends no owner credentials to %s', async (_label, serverUrl) => {
    const { useAuthStore } = await load('true')
    const create = useAuthStore.getState().createEtebaseAccount as unknown as CreateWithOwner

    const outcome = await create(USERNAME, ACCOUNT_PASSWORD, serverUrl, {
      ownerPassword: OWNER_PASSWORD, signal: new AbortController().signal,
    }).then(() => 'resolved', () => 'rejected')

    expect(outcome).toBe('rejected')
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => String(init?.body ?? '').includes(OWNER_PASSWORD))).toBe(false)
    expect(sdk.signup).not.toHaveBeenCalled()
    expect(storage.set).not.toHaveBeenCalled()
  })
})

describe('owner registration off (default build)', () => {
  it('keeps the existing self-host signup and legacy 409 recovery unchanged', async () => {
    sdk.signup.mockRejectedValueOnce(new Error('Conflict: 409 user already exists'))
    const { SignupPage, useAuthStore } = await load(undefined)
    render(<SignupPage />)

    expect(screen.queryByLabelText(/installation password/i)).not.toBeInTheDocument()
    fillAccountForm(false)
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))

    await waitFor(() => expect(sdk.login).toHaveBeenCalledWith(USERNAME, ACCOUNT_PASSWORD, ORIGIN))
    expect(sdk.signup).toHaveBeenCalledTimes(1)
    expect(sdk.signup.mock.calls[0][3]).toBeUndefined()
    expect(ownerFetchCalls()).toHaveLength(0)
    await waitFor(() => expect(storage.set).toHaveBeenCalledWith('etebase_session', 'synthetic-saved-session'))
    expect(useAuthStore.getState().pendingSignup?.etebaseAccountReady).toBe(true)
  })
})
