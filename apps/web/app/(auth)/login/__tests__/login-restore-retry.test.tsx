import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import LoginPage from '../page'
import { useAuthStore } from '@/app/stores/use-auth-store'

const replace = vi.fn()

const mocks = vi.hoisted(() => ({
  message: 'Your session could not be confirmed. Please retry restoring your session. Your encrypted data is safe.',
  restoreSession: vi.fn<() => Promise<void>>(),
  fetchSubscription: vi.fn<() => Promise<void>>(),
  login: vi.fn<(...args: unknown[]) => Promise<void>>(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(),
}))

// A real subscribable store, so the page reacts to restore outcomes without manual rerenders.
vi.mock('@/app/stores/use-auth-store', async () => {
  const { create } = await import('zustand')
  const useAuthStore = create(() => ({
    login: mocks.login,
    unlockEtebaseSession: vi.fn(async () => {}),
    restoreSession: mocks.restoreSession,
    fetchSubscription: mocks.fetchSubscription,
    isLoading: false,
    error: null as string | null,
    clearError: vi.fn(),
    isAuthenticated: false,
  }))
  return { AUTH_REFRESH_RETRY_MESSAGE: mocks.message, useAuthStore }
})

vi.mock('@/app/stores/use-etebase-store', () => ({
  normalizeServerUrl: (url: string) => url,
}))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

beforeEach(() => {
  replace.mockClear()
  mocks.restoreSession.mockReset()
  mocks.fetchSubscription.mockReset().mockResolvedValue(undefined)
  mocks.login.mockReset().mockResolvedValue(undefined)
  useAuthStore.setState({ isLoading: false, error: mocks.message, isAuthenticated: false })
})

afterEach(cleanup)

describe('LoginPage session restore retry', () => {
  it('offers Retry after automatic restore gives up, and keeps the login form', () => {
    render(<LoginPage />)

    expect(screen.getByRole('alert')).toHaveTextContent(/retry restoring your session/i)
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
    expect(screen.getByLabelText(/Email address/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /log in/i })).toBeInTheDocument()
  })

  it('does not offer Retry for other errors', () => {
    useAuthStore.setState({ error: 'Invalid email or password. Please try again.' })
    render(<LoginPage />)

    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })

  it('re-runs the restore path once, then reads the subscription, and redirects when it succeeds', async () => {
    const pending = deferred()
    mocks.restoreSession.mockImplementation(async () => {
      useAuthStore.setState({ isLoading: true, error: null })
      await pending.promise
      useAuthStore.setState({ isLoading: false, isAuthenticated: true })
    })
    render(<LoginPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    const retrying = await screen.findByRole('button', { name: 'Retrying...' })
    expect(retrying).toBeDisabled()
    fireEvent.click(retrying)
    expect(mocks.restoreSession).toHaveBeenCalledTimes(1)
    expect(mocks.fetchSubscription).not.toHaveBeenCalled()

    await act(async () => { pending.resolve() })

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/calendar'))
    expect(mocks.restoreSession).toHaveBeenCalledTimes(1)
    expect(mocks.fetchSubscription).toHaveBeenCalledTimes(1)
  })

  it('offers Retry again when the restore still cannot confirm the session', async () => {
    mocks.restoreSession.mockImplementation(async () => {
      useAuthStore.setState({ isLoading: true, error: null })
      await Promise.resolve()
      useAuthStore.setState({ isLoading: false, error: mocks.message })
    })
    render(<LoginPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled())
    expect(screen.getByRole('alert')).toHaveTextContent(/retry restoring your session/i)
    expect(replace).not.toHaveBeenCalled()
  })

  it('falls back to normal login when the restore ends signed out', async () => {
    mocks.restoreSession.mockImplementation(async () => {
      useAuthStore.setState({ isLoading: true, error: null })
      await Promise.resolve()
      useAuthStore.setState({ isLoading: false })
    })
    render(<LoginPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument())

    fireEvent.change(screen.getByLabelText(/Email address/i), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText(/^Password$/i), { target: { value: 'correct-horse' } })
    fireEvent.submit(screen.getByRole('button', { name: /log in/i }))

    await waitFor(() => expect(mocks.login).toHaveBeenCalledTimes(1))
  })
})
