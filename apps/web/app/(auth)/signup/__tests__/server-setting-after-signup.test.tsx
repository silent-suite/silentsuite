import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The signup page must keep the saved server selection until an account exists
// on the chosen server. Real page, auth store and etebase-auth wrapper; only the
// Etebase SDK, secure storage and browser network are faked.

const ORIGIN = 'https://silentsuite.selfhost.test'
const KEY = 'silentsuite-server-url'
const SAVED = 'https://saved.example.test'
const TYPED = 'https://typed.example.test'
const PASSWORD = 'Synthetic-Account-Pass1'

const sdk = vi.hoisted(() => ({ signup: vi.fn(), login: vi.fn(), restore: vi.fn() }))

vi.mock('../../../../../../packages/core/node_modules/etebase', () => ({
  Account: { signup: sdk.signup, login: sdk.login, restore: sdk.restore },
  getPrettyFingerprint: vi.fn(() => 'synthetic fingerprint'),
}))
vi.mock('@/app/lib/secure-storage', () => ({
  secureGet: vi.fn(async () => null),
  secureSet: vi.fn(async () => {}),
  secureRemove: vi.fn(), secureRemoveIfEqual: vi.fn(), secureClear: vi.fn(), migrateFromLocalStorage: vi.fn(),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('@/app/components/stripe-payment-form', () => ({ default: () => null }))

function fakeAccount() {
  return {
    authToken: 'synthetic-auth-token',
    save: vi.fn(async () => 'synthetic-saved-session'),
    getInvitationManager: () => ({ pubkey: new Uint8Array(32) }),
  }
}

async function renderSelfHostedSignup() {
  const dom = (globalThis as { jsdom?: { reconfigure(options: { url: string }): void } }).jsdom
  if (!dom) throw new Error('fixture: vitest jsdom handle unavailable')
  dom.reconfigure({ url: `${ORIGIN}/signup` })
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
  vi.stubEnv('NEXT_PUBLIC_ETEBASE_SERVER_URL', '')
  delete process.env.NEXT_PUBLIC_OWNER_REGISTRATION
  const { default: SignupPage } = await import('../page')
  render(<SignupPage />)
}

async function submit(serverUrl: string) {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'person@example.test' } })
  fireEvent.change(screen.getByLabelText('Confirm email'), { target: { value: 'person@example.test' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: PASSWORD } })
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: PASSWORD } })
  fireEvent.change(screen.getByPlaceholderText('https://sync.example.com'), { target: { value: serverUrl } })
  const button = await screen.findByRole('button', { name: 'Continue' })
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(button)
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
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
})

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('signup saves the server selection only after the account is created', { timeout: 20_000 }, () => {
  it('a failed signup with a blank server field keeps the saved server', async () => {
    sdk.signup.mockRejectedValue(new Error('network unavailable'))
    localStorage.setItem(KEY, SAVED)
    await renderSelfHostedSignup()

    await submit('')

    await waitFor(() => expect(sdk.signup).toHaveBeenCalledTimes(1))
    await screen.findByRole('alert')
    expect(localStorage.getItem(KEY)).toBe(SAVED)
  })

  it('a failed signup with a new server URL does not save it', async () => {
    sdk.signup.mockRejectedValue(new Error('network unavailable'))
    localStorage.setItem(KEY, SAVED)
    await renderSelfHostedSignup()

    await submit(TYPED)

    await waitFor(() => expect(sdk.signup).toHaveBeenCalledTimes(1))
    await screen.findByRole('alert')
    expect(localStorage.getItem(KEY)).toBe(SAVED)
  })

  it('a created account saves the server it was created on', async () => {
    localStorage.setItem(KEY, SAVED)
    await renderSelfHostedSignup()

    await submit(TYPED)

    await waitFor(() => expect(localStorage.getItem(KEY)).toBe(TYPED))
  })

  it('a created account with a blank server field drops a stale saved server', async () => {
    localStorage.setItem(KEY, SAVED)
    await renderSelfHostedSignup()

    await submit('')

    await waitFor(() => expect(sdk.signup).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(localStorage.getItem(KEY)).toBeNull())
  })
})
