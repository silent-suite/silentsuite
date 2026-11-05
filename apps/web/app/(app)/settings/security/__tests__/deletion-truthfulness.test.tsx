import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import type { StoreApi, UseBoundStore } from 'zustand'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import messages from '@/messages/en.json'
import { useAuthStore, type User } from '@/app/stores/use-auth-store'
import {
  LOGOUT_GENERATION_KEY,
  bumpAccountEpoch,
  establishLogoutGeneration,
  releaseLogoutGeneration,
  writeLogoutGeneration,
} from '@/app/lib/account-epoch'
import SecurityPage from '../page'

const mocks = vi.hoisted(() => {
  const logout = vi.fn()
  const push = vi.fn()
  const etebaseState: { accountFingerprint: string; account: unknown } = {
    accountFingerprint: 'fp-test-123',
    account: null,
  }
  const etebaseStore = Object.assign(
    (selector: (state: typeof etebaseState) => unknown) => selector(etebaseState),
    { getState: () => etebaseState },
  )
  const core = {
    logIn: vi.fn(),
    logout: vi.fn(),
    changePassword: vi.fn(),
    saveSession: vi.fn(),
  }
  const secureStorage = {
    secureSet: vi.fn(),
    secureRemoveIfEqual: vi.fn(),
  }
  return { logout, push, etebaseState, etebaseStore, core, secureStorage, selfHosted: false }
})

vi.mock('@silentsuite/core', () => mocks.core)

vi.mock('@/app/lib/secure-storage', () => mocks.secureStorage)

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
}))

// A real Zustand store so the page's selector subscriptions and getState() reads
// behave as they do against the production auth store.
vi.mock('@/app/stores/use-auth-store', async () => {
  const { create } = await import('zustand')
  return {
    useAuthStore: create(() => ({ user: null as unknown, logout: mocks.logout })),
  }
})

vi.mock('@/app/stores/use-etebase-store', () => ({
  useEtebaseStore: mocks.etebaseStore,
}))

// Only the build-time flag is overridden; isCustomServer and the rest of the
// module are the real implementation, evaluated against the mocked config below.
vi.mock('@/app/lib/self-hosted', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/lib/self-hosted')>()
  return {
    ...actual,
    get isSelfHosted() {
      return mocks.selfHosted
    },
  }
})

vi.mock('@/app/lib/config', () => ({
  BILLING_API_URL: 'https://api.silentsuite.io',
  ETEBASE_SERVER_URL: 'https://server.silentsuite.io',
}))

type AuthFixtureState = { user: User | null; logout: typeof mocks.logout }
const authStore = useAuthStore as unknown as UseBoundStore<StoreApi<AuthFixtureState>>

const SERVER_URL_KEY = 'silentsuite-server-url'
const CUSTOM_SERVER_URL = 'https://sync.example.test'
const HOSTED_USER: User = { id: 'hosted-user-1', email: 'fixture@example.test', planId: 'annual' }
const SELF_HOSTED_USER: User = { id: 'self-hosted', email: 'fixture@example.test', planId: 'self-hosted', isAdmin: true, onboardedAt: null }

function billingAccountDeleteCalls() {
  return fetchMock.mock.calls.filter(([url, init]) =>
    url === 'https://api.silentsuite.io/account' && (init as RequestInit | undefined)?.method === 'DELETE')
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  vi.unstubAllGlobals()
  releaseLogoutGeneration()
  establishLogoutGeneration(writeLogoutGeneration())
  mocks.logout.mockReset()
  // Like the real logout, clear the signed-in user before the first await.
  mocks.logout.mockImplementation(async () => {
    authStore.setState({ user: null })
  })
  mocks.push.mockReset()
  authStore.setState({ user: HOSTED_USER, logout: mocks.logout })
  mocks.etebaseState.account = null
  for (const fn of [...Object.values(mocks.core), ...Object.values(mocks.secureStorage)]) fn.mockReset()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

describe('Security page account action when self-hosted', () => {
  beforeEach(() => {
    mocks.selfHosted = true
  })

  it('describes signing out of this device instead of promising account deletion', () => {
    renderWithIntl(<SecurityPage />)

    expect(screen.getByRole('button', { name: 'Sign out of this device' })).toBeInTheDocument()
    expect(screen.getByText(/your account and data on your server are not deleted/i)).toBeInTheDocument()

    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/permanent/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/will be deleted/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/cannot be recovered/i)).not.toBeInTheDocument()
  })

  it('keeps the typed confirmation but asks for SIGNOUT with sign-out wording', () => {
    renderWithIntl(<SecurityPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Sign out of this device' }))

    expect(screen.getByRole('heading', { name: 'Confirm sign out' })).toBeInTheDocument()
    expect(screen.getByText('SIGNOUT')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Type SIGNOUT')).toBeInTheDocument()

    expect(screen.queryByRole('heading', { name: /deletion/i })).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/DELETE/)).not.toBeInTheDocument()
    expect(screen.queryByText('DELETE')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })

  it('enables sign-out only after the exact SIGNOUT token', () => {
    renderWithIntl(<SecurityPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Sign out of this device' }))

    const confirm = screen.getByRole('button', { name: 'Sign out' })
    const input = screen.getByPlaceholderText('Type SIGNOUT')
    expect(confirm).toBeDisabled()

    fireEvent.click(confirm)
    expect(mocks.logout).not.toHaveBeenCalled()

    for (const wrong of ['DELETE', 'signout', 'SIGN OUT', 'SIGNOUT ']) {
      fireEvent.change(input, { target: { value: wrong } })
      expect(confirm).toBeDisabled()
    }

    fireEvent.change(input, { target: { value: 'SIGNOUT' } })
    expect(confirm).toBeEnabled()
    expect(mocks.logout).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows a sign-out loading label while signing out', async () => {
    mocks.logout.mockReturnValue(new Promise<void>(() => {}))
    renderWithIntl(<SecurityPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Sign out of this device' }))
    fireEvent.change(screen.getByPlaceholderText('Type SIGNOUT'), { target: { value: 'SIGNOUT' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    expect(await screen.findByRole('button', { name: 'Signing out...' })).toBeDisabled()
    expect(screen.queryByText(/deleting/i)).not.toBeInTheDocument()
  })

  it('only signs out locally and never calls the billing account DELETE', async () => {
    renderWithIntl(<SecurityPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Sign out of this device' }))
    fireEvent.change(screen.getByPlaceholderText('Type SIGNOUT'), { target: { value: 'SIGNOUT' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/'))
    expect(mocks.logout).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('cancelling the sign-out confirmation does nothing', () => {
    renderWithIntl(<SecurityPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Sign out of this device' }))
    fireEvent.change(screen.getByPlaceholderText('Type SIGNOUT'), { target: { value: 'SIGNOUT' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('heading', { name: 'Confirm sign out' })).not.toBeInTheDocument()
    expect(mocks.logout).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('Security page account action when hosted (control)', () => {
  beforeEach(() => {
    mocks.selfHosted = false
  })

  it('keeps the permanent deletion copy and typed DELETE confirmation', () => {
    renderWithIntl(<SecurityPage />)

    expect(screen.getByText('This action is permanent. All your data will be deleted and cannot be recovered.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign out of this device' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }))

    expect(screen.getByRole('heading', { name: 'Confirm Account Deletion' })).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Type SIGNOUT')).not.toBeInTheDocument()
    const confirm = screen.getByRole('button', { name: 'Confirm Delete' })
    expect(confirm).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText('Type DELETE'), { target: { value: 'delete' } })
    expect(confirm).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText('Type DELETE'), { target: { value: 'DELETE' } })
    expect(confirm).toBeEnabled()
  })

  it('sends the billing account DELETE, then signs out and redirects', async () => {
    let resolveFetch: (res: unknown) => void = () => {}
    fetchMock.mockReturnValue(new Promise((resolve) => { resolveFetch = resolve }))
    renderWithIntl(<SecurityPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }))
    fireEvent.change(screen.getByPlaceholderText('Type DELETE'), { target: { value: 'DELETE' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Delete' }))

    expect(await screen.findByRole('button', { name: 'Deleting...' })).toBeDisabled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('https://api.silentsuite.io/account', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: 'DELETE' }),
      credentials: 'include',
    })
    expect(mocks.logout).not.toHaveBeenCalled()

    resolveFetch({ ok: true, json: async () => ({}) })

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/'))
    expect(mocks.logout).toHaveBeenCalledTimes(1)
  })

  it('shows the billing error and stays signed in when deletion fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ detail: 'Deletion refused' }) })
    renderWithIntl(<SecurityPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }))
    fireEvent.change(screen.getByPlaceholderText('Type DELETE'), { target: { value: 'DELETE' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Delete' }))

    expect(await screen.findByText('Deletion refused')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm Delete' })).toBeEnabled()
    expect(mocks.logout).not.toHaveBeenCalled()
    expect(mocks.push).not.toHaveBeenCalled()
  })
})

// Issue #935: the hosted web app (build flag off) connected to a custom server.
describe('Security page account action on the hosted frontend with a self-hosted session', () => {
  beforeEach(() => {
    mocks.selfHosted = false
    // A billing DELETE would succeed here, as it could with a stale hosted cookie,
    // so only routing keeps a self-hosted session away from it.
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) })
  })

  function expectNoAccountAction() {
    expect(screen.queryByRole('button', { name: /delete my account/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign out of this device' })).not.toBeInTheDocument()
    expect(screen.queryByText(/permanent/i)).not.toBeInTheDocument()
  }

  async function signOutThroughDangerZone() {
    expect(screen.queryByRole('button', { name: /delete my account/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/permanent/i)).not.toBeInTheDocument()
    expect(screen.getByText(/your account and data on your server are not deleted/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Sign out of this device' }))
    fireEvent.change(screen.getByPlaceholderText('Type SIGNOUT'), { target: { value: 'SIGNOUT' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/'))
    expect(mocks.logout).toHaveBeenCalledTimes(1)
    expect(billingAccountDeleteCalls()).toEqual([])
  }

  it.each([
    ['self-hosted marker', SELF_HOSTED_USER],
    ['hosted-id', HOSTED_USER],
  ])('routes a stored custom server URL with a %s user to device sign-out without the billing account DELETE', async (_label, user) => {
    localStorage.setItem(SERVER_URL_KEY, CUSTOM_SERVER_URL)
    authStore.setState({ user })
    renderWithIntl(<SecurityPage />)

    await signOutThroughDangerZone()
  })

  it('routes a self-hosted marker user with no stored server URL to device sign-out without the billing account DELETE', async () => {
    authStore.setState({ user: SELF_HOSTED_USER })
    renderWithIntl(<SecurityPage />)

    await signOutThroughDangerZone()
  })

  it('offers no account action while the signed-in identity is unresolved', () => {
    authStore.setState({ user: null })
    renderWithIntl(<SecurityPage />)

    expectNoAccountAction()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('offers no account action when the stored server URL cannot be read', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage access denied', 'SecurityError')
    })
    try {
      renderWithIntl(<SecurityPage />)

      expectNoAccountAction()
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      getItem.mockRestore()
    }
  })

  it('renders no hosted deletion action on the server before the account mode is known', () => {
    const html = renderToString(
      <NextIntlClientProvider locale="en" messages={messages}>
        <SecurityPage />
      </NextIntlClientProvider>,
    )

    expect(html).toContain('Change Password')
    expect(html).not.toContain('Delete my account')
    expect(html).not.toContain('This action is permanent')
    expect(html).not.toContain('Sign out of this device')
  })

  // Characterization: a hosted identity on the default server keeps deletion.
  it('keeps hosted deletion for a hosted identity whose stored server is the default', () => {
    localStorage.setItem(SERVER_URL_KEY, 'https://server.silentsuite.io')
    renderWithIntl(<SecurityPage />)

    expect(screen.getByRole('button', { name: 'Delete my account' })).toBeInTheDocument()
    expect(screen.getByText('This action is permanent. All your data will be deleted and cannot be recovered.')).toBeInTheDocument()
  })
})

const LIVE_ACCOUNT = { fixture: 'live-etebase-account' }
const TEST_ACCOUNT = { fixture: 'verification-session' }
const PASSWORD_PATCH_URL = 'https://api.silentsuite.io/account/password'
const SUCCESS_TEXT = 'Password updated successfully. Other sessions have been signed out.'
const BILLING_WARNING = 'Password changed, but other sessions may not have been signed out.'
const SERVER_UNKNOWN = "We couldn't confirm which server this account uses. Please sign in again."

function passwordPatchCalls() {
  return fetchMock.mock.calls.filter(([url]) => url === PASSWORD_PATCH_URL)
}

function submitPasswordChange() {
  fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'OldPassw0rd' } })
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'NewPassw0rd' } })
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'NewPassw0rd' } })
  fireEvent.click(screen.getByRole('button', { name: 'Update password' }))
}

describe('Security page password change billing boundary', () => {
  beforeEach(() => {
    mocks.selfHosted = false
    mocks.etebaseState.account = LIVE_ACCOUNT
    mocks.core.logIn.mockResolvedValue(TEST_ACCOUNT)
    mocks.core.logout.mockResolvedValue(undefined)
    mocks.core.changePassword.mockResolvedValue(undefined)
    mocks.core.saveSession.mockResolvedValue('saved-session')
    mocks.secureStorage.secureSet.mockResolvedValue(undefined)
    mocks.secureStorage.secureRemoveIfEqual.mockResolvedValue(undefined)
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) })
  })

  // Characterization: hosted default-server behaviour is unchanged.
  it('changes the password on the hosted server and sends the billing password PATCH for a hosted account', async () => {
    renderWithIntl(<SecurityPage />)
    submitPasswordChange()

    expect(await screen.findByText(SUCCESS_TEXT)).toBeInTheDocument()
    expect(mocks.core.logIn).toHaveBeenCalledWith('https://server.silentsuite.io', 'fixture@example.test', 'OldPassw0rd')
    expect(mocks.core.changePassword).toHaveBeenCalledWith(LIVE_ACCOUNT, 'NewPassw0rd')
    expect(mocks.secureStorage.secureSet).toHaveBeenCalledWith('etebase_session', 'saved-session')
    expect(passwordPatchCalls()).toEqual([[PASSWORD_PATCH_URL, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      credentials: 'include',
    }]])
    expect(screen.queryByText(BILLING_WARNING)).not.toBeInTheDocument()
  })

  it('changes the password on the custom server without the billing password PATCH and keeps the sessions warning', async () => {
    localStorage.setItem(SERVER_URL_KEY, CUSTOM_SERVER_URL)
    authStore.setState({ user: SELF_HOSTED_USER })
    renderWithIntl(<SecurityPage />)
    submitPasswordChange()

    expect(await screen.findByText(BILLING_WARNING)).toBeInTheDocument()
    expect(mocks.core.logIn).toHaveBeenCalledWith(CUSTOM_SERVER_URL, 'fixture@example.test', 'OldPassw0rd')
    expect(mocks.core.changePassword).toHaveBeenCalledWith(LIVE_ACCOUNT, 'NewPassw0rd')
    expect(mocks.secureStorage.secureSet).toHaveBeenCalledWith('etebase_session', 'saved-session')
    expect(passwordPatchCalls()).toEqual([])
  })

  // Characterization: standalone self-hosted builds never sent the PATCH.
  it('changes the password on the build server without the billing password PATCH in a self-hosted build', async () => {
    mocks.selfHosted = true
    authStore.setState({ user: SELF_HOSTED_USER })
    renderWithIntl(<SecurityPage />)
    submitPasswordChange()

    expect(await screen.findByText(SUCCESS_TEXT)).toBeInTheDocument()
    expect(mocks.core.logIn).toHaveBeenCalledWith('https://server.silentsuite.io', 'fixture@example.test', 'OldPassw0rd')
    expect(mocks.core.changePassword).toHaveBeenCalledWith(LIVE_ACCOUNT, 'NewPassw0rd')
    expect(passwordPatchCalls()).toEqual([])
  })

  function expectAbortedBeforeAnyChange() {
    expect(mocks.core.logIn).not.toHaveBeenCalled()
    expect(mocks.core.changePassword).not.toHaveBeenCalled()
    expect(mocks.secureStorage.secureSet).not.toHaveBeenCalled()
    expect(passwordPatchCalls()).toEqual([])
    expect(screen.queryByText(SUCCESS_TEXT)).not.toBeInTheDocument()
    expect(screen.queryByText(BILLING_WARNING)).not.toBeInTheDocument()
  }

  it('stops before verifying the password when the stored server URL cannot be read', async () => {
    renderWithIntl(<SecurityPage />)
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage access denied', 'SecurityError')
    })
    try {
      submitPasswordChange()
      expect(await screen.findByText(SERVER_UNKNOWN)).toBeInTheDocument()
      expectAbortedBeforeAnyChange()
    } finally {
      getItem.mockRestore()
    }
  })

  it('stops before verifying the password for a self-hosted marker user with no stored server URL', async () => {
    authStore.setState({ user: SELF_HOSTED_USER })
    renderWithIntl(<SecurityPage />)
    submitPasswordChange()

    expect(await screen.findByText(SERVER_UNKNOWN)).toBeInTheDocument()
    expectAbortedBeforeAnyChange()
  })

  // Characterization: a missing user already stops with the existing message.
  it('stops before verifying the password when no user is signed in', async () => {
    authStore.setState({ user: null })
    renderWithIntl(<SecurityPage />)
    submitPasswordChange()

    expect(await screen.findByText('Unable to determine your account email. Please sign in again.')).toBeInTheDocument()
    expectAbortedBeforeAnyChange()
  })
})

// ---------------------------------------------------------------------------
// Account boundaries while an action is open or in flight
// ---------------------------------------------------------------------------

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

const ACCOUNT_CHANGED_DIALOG = 'Your account changed. Close this dialog and try again.'
const ACCOUNT_CHANGED_PASSWORD = 'Your account changed during the password update. Please sign in again.'
const OTHER_HOSTED_USER: User = { id: 'hosted-user-2', email: 'other@example.test', planId: 'annual' }

const ACTION_MODES = [
  {
    label: 'local sign-out',
    user: SELF_HOSTED_USER,
    storedUrl: CUSTOM_SERVER_URL as string | null,
    open: 'Sign out of this device',
    token: 'SIGNOUT',
    confirm: 'Sign out',
  },
  {
    label: 'hosted deletion',
    user: HOSTED_USER,
    storedUrl: null as string | null,
    open: 'Delete my account',
    token: 'DELETE',
    confirm: 'Confirm Delete',
  },
]

const BOUNDARY_CHANGES: Array<[string, (user: User) => void]> = [
  ['same-id account replacement', (user) => { bumpAccountEpoch(); authStore.setState({ user: { ...user } }) }],
  ['account epoch change', () => { bumpAccountEpoch() }],
  ['logout in another tab', () => { localStorage.setItem(LOGOUT_GENERATION_KEY, 'other-tab-logout') }],
]

describe('Security page account action across account boundaries', () => {
  beforeEach(() => {
    mocks.selfHosted = false
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) })
  })

  function openAndConfirmReady(mode: typeof ACTION_MODES[number]) {
    if (mode.storedUrl) localStorage.setItem(SERVER_URL_KEY, mode.storedUrl)
    authStore.setState({ user: mode.user })
    renderWithIntl(<SecurityPage />)
    fireEvent.click(screen.getByRole('button', { name: mode.open }))
    fireEvent.change(screen.getByPlaceholderText(`Type ${mode.token}`), { target: { value: mode.token } })
  }

  for (const mode of ACTION_MODES) {
    it.each(BOUNDARY_CHANGES)(`does not run the ${mode.label} after a %s while the dialog is open`, async (_label, change) => {
      openAndConfirmReady(mode)
      act(() => change(mode.user))

      fireEvent.click(screen.getByRole('button', { name: mode.confirm }))

      expect(await screen.findByText(ACCOUNT_CHANGED_DIALOG)).toBeInTheDocument()
      expect(mocks.logout).not.toHaveBeenCalled()
      expect(mocks.push).not.toHaveBeenCalled()
      expect(billingAccountDeleteCalls()).toEqual([])
    })

    // Characterization: a logout that finishes with nobody signed in redirects.
    it(`redirects after the ${mode.label} logout completes with nobody signed in`, async () => {
      const pendingLogout = deferred()
      mocks.logout.mockImplementation(() => {
        authStore.setState({ user: null })
        return pendingLogout.promise
      })
      openAndConfirmReady(mode)
      fireEvent.click(screen.getByRole('button', { name: mode.confirm }))

      await waitFor(() => expect(mocks.logout).toHaveBeenCalledTimes(1))
      expect(mocks.push).not.toHaveBeenCalled()
      await act(async () => pendingLogout.resolve())
      await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/'))
    })

    it(`does not redirect a newer account that signs in while the ${mode.label} logout is pending`, async () => {
      const pendingLogout = deferred()
      mocks.logout.mockImplementation(() => {
        authStore.setState({ user: null })
        return pendingLogout.promise
      })
      openAndConfirmReady(mode)
      fireEvent.click(screen.getByRole('button', { name: mode.confirm }))

      await waitFor(() => expect(mocks.logout).toHaveBeenCalledTimes(1))
      act(() => { bumpAccountEpoch(); authStore.setState({ user: OTHER_HOSTED_USER }) })
      await act(async () => pendingLogout.resolve())

      expect(mocks.push).not.toHaveBeenCalled()
    })
  }

  it('does not sign out a newer account when the account changes while the hosted DELETE is pending', async () => {
    const pendingDelete = deferred<{ ok: boolean; json: () => Promise<unknown> }>()
    fetchMock.mockReturnValue(pendingDelete.promise)
    openAndConfirmReady(ACTION_MODES[1])
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Delete' }))

    expect(billingAccountDeleteCalls()).toHaveLength(1)
    act(() => { bumpAccountEpoch(); authStore.setState({ user: OTHER_HOSTED_USER }) })
    await act(async () => pendingDelete.resolve({ ok: true, json: async () => ({}) }))

    expect(mocks.logout).not.toHaveBeenCalled()
    expect(mocks.push).not.toHaveBeenCalled()
  })
})

describe('Security page password change across account boundaries', () => {
  beforeEach(() => {
    mocks.selfHosted = false
    mocks.etebaseState.account = LIVE_ACCOUNT
    mocks.core.logIn.mockResolvedValue(TEST_ACCOUNT)
    mocks.core.logout.mockResolvedValue(undefined)
    mocks.core.changePassword.mockResolvedValue(undefined)
    mocks.core.saveSession.mockResolvedValue('saved-session')
    mocks.secureStorage.secureSet.mockResolvedValue(undefined)
    mocks.secureStorage.secureRemoveIfEqual.mockResolvedValue(undefined)
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) })
  })

  function switchAccount() {
    act(() => { bumpAccountEpoch(); authStore.setState({ user: OTHER_HOSTED_USER }) })
  }

  it('does not change the live account password when the account changes during verification', async () => {
    const pendingLogIn = deferred<typeof TEST_ACCOUNT>()
    mocks.core.logIn.mockReturnValue(pendingLogIn.promise)
    renderWithIntl(<SecurityPage />)
    submitPasswordChange()

    await waitFor(() => expect(mocks.core.logIn).toHaveBeenCalledTimes(1))
    switchAccount()
    await act(async () => pendingLogIn.resolve(TEST_ACCOUNT))

    expect(await screen.findByText(ACCOUNT_CHANGED_PASSWORD)).toBeInTheDocument()
    expect(mocks.core.changePassword).not.toHaveBeenCalled()
    expect(mocks.core.saveSession).not.toHaveBeenCalled()
    expect(mocks.secureStorage.secureSet).not.toHaveBeenCalled()
    expect(passwordPatchCalls()).toEqual([])
    expect(screen.queryByText(SUCCESS_TEXT)).not.toBeInTheDocument()
  })

  it('does not persist the session when the account changes while it is being saved', async () => {
    const pendingSave = deferred<string>()
    mocks.core.saveSession.mockReturnValue(pendingSave.promise)
    renderWithIntl(<SecurityPage />)
    submitPasswordChange()

    await waitFor(() => expect(mocks.core.saveSession).toHaveBeenCalledTimes(1))
    switchAccount()
    await act(async () => pendingSave.resolve('saved-session'))

    expect(await screen.findByText(ACCOUNT_CHANGED_PASSWORD)).toBeInTheDocument()
    expect(mocks.secureStorage.secureSet).not.toHaveBeenCalled()
    expect(passwordPatchCalls()).toEqual([])
    expect(screen.queryByText(SUCCESS_TEXT)).not.toBeInTheDocument()
  })

  it('removes its own persisted session and skips the PATCH when the account changes during persistence', async () => {
    const pendingPersist = deferred()
    mocks.secureStorage.secureSet.mockReturnValue(pendingPersist.promise)
    renderWithIntl(<SecurityPage />)
    submitPasswordChange()

    await waitFor(() => expect(mocks.secureStorage.secureSet).toHaveBeenCalledTimes(1))
    switchAccount()
    await act(async () => pendingPersist.resolve())

    expect(await screen.findByText(ACCOUNT_CHANGED_PASSWORD)).toBeInTheDocument()
    expect(mocks.secureStorage.secureRemoveIfEqual).toHaveBeenCalledWith('etebase_session', 'saved-session')
    expect(passwordPatchCalls()).toEqual([])
    expect(screen.queryByText(SUCCESS_TEXT)).not.toBeInTheDocument()
  })

  it('skips the billing password PATCH when the session stops being hosted before it is sent', async () => {
    const pendingPersist = deferred()
    mocks.secureStorage.secureSet.mockReturnValue(pendingPersist.promise)
    renderWithIntl(<SecurityPage />)
    submitPasswordChange()

    await waitFor(() => expect(mocks.secureStorage.secureSet).toHaveBeenCalledTimes(1))
    localStorage.setItem(SERVER_URL_KEY, CUSTOM_SERVER_URL)
    await act(async () => pendingPersist.resolve())

    expect(await screen.findByText(BILLING_WARNING)).toBeInTheDocument()
    expect(passwordPatchCalls()).toEqual([])
    expect(mocks.secureStorage.secureRemoveIfEqual).not.toHaveBeenCalled()
  })
})
