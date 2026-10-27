import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import SecurityPage from '../page'

const mocks = vi.hoisted(() => {
  const logout = vi.fn()
  const push = vi.fn()
  const authStore = Object.assign(
    (selector?: (state: any) => unknown) => (selector ? selector({ logout }) : { logout }),
    { getState: () => ({ user: { email: 'fixture@example.test' }, logout }) },
  )
  const etebaseState = {
    accountFingerprint: 'fp-test-123',
    account: null,
  }
  const etebaseStore = Object.assign(
    (selector: (state: typeof etebaseState) => unknown) => selector(etebaseState),
    { getState: () => etebaseState },
  )
  return { logout, push, authStore, etebaseStore, selfHosted: false }
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
}))

vi.mock('@/app/stores/use-auth-store', () => ({
  useAuthStore: mocks.authStore,
}))

vi.mock('@/app/stores/use-etebase-store', () => ({
  useEtebaseStore: mocks.etebaseStore,
}))

vi.mock('@/app/lib/self-hosted', () => ({
  get isSelfHosted() {
    return mocks.selfHosted
  },
}))

vi.mock('@/app/lib/config', () => ({
  BILLING_API_URL: 'https://api.silentsuite.io',
  ETEBASE_SERVER_URL: 'https://server.silentsuite.io',
}))

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  sessionStorage.clear()
  vi.unstubAllGlobals()
  mocks.logout.mockReset()
  mocks.logout.mockResolvedValue(undefined)
  mocks.push.mockReset()
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
