import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import LoginPage from '../page'

const replace = vi.fn()
let searchParams = new URLSearchParams()

const authState = {
  login: vi.fn(async () => {}),
  isLoading: false,
  error: null as string | null,
  clearError: vi.fn(),
  isAuthenticated: false,
}

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => searchParams,
}))

vi.mock('@/app/stores/use-auth-store', () => ({
  useAuthStore: Object.assign((selector?: (s: typeof authState) => unknown) =>
    selector ? selector(authState) : authState, { getState: () => authState }),
}))

// Avoid pulling the full etebase store (WASM / IndexedDB) into the test.
vi.mock('@/app/stores/use-etebase-store', () => ({
  normalizeServerUrl: (url: string) => url,
}))

beforeEach(() => {
  replace.mockClear()
  authState.login.mockClear().mockResolvedValue(undefined)
  authState.clearError.mockClear()
  authState.isAuthenticated = false
  authState.error = null
  searchParams = new URLSearchParams()
  localStorage.clear()
})

describe('LoginPage unlock route', () => {
  it('does NOT bounce an already-authenticated user on the unlock route, and shows unlock copy', () => {
    authState.isAuthenticated = true
    searchParams = new URLSearchParams('reason=unlock&returnTo=/calendar')

    render(<LoginPage />)

    expect(replace).not.toHaveBeenCalled()
    expect(screen.getByText(/Sign in again to unlock it on this browser/i)).toBeInTheDocument()
  })

  it('redirects to returnTo after a fresh successful unlock submit', async () => {
    authState.isAuthenticated = true
    searchParams = new URLSearchParams('reason=unlock&returnTo=/calendar')

    render(<LoginPage />)

    fireEvent.change(screen.getByLabelText(/Email address/i), {
      target: { value: 'user@example.com' },
    })
    fireEvent.change(screen.getByLabelText(/^Password$/i), {
      target: { value: 'correct-horse' },
    })
    fireEvent.submit(screen.getByRole('button', { name: /log in/i }))

    await waitFor(() => expect(authState.login).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/calendar'))
    expect(replace).toHaveBeenCalledTimes(1)
  })

  it('falls back to calendar for malicious or self-looping returnTo values', async () => {
    authState.isAuthenticated = true

    for (const rawReturnTo of ['//evil.example', 'https://evil.example', '/login?reason=unlock&returnTo=/calendar']) {
      replace.mockClear()
      searchParams = new URLSearchParams()
      searchParams.set('reason', 'unlock')
      searchParams.set('returnTo', rawReturnTo)

      const { unmount } = render(<LoginPage />)
      fireEvent.change(screen.getByLabelText(/Email address/i), {
        target: { value: 'user@example.com' },
      })
      fireEvent.change(screen.getByLabelText(/^Password$/i), {
        target: { value: 'correct-horse' },
      })
      fireEvent.submit(screen.getByRole('button', { name: /log in/i }))

      await waitFor(() => expect(replace).toHaveBeenCalledWith('/calendar'))
      unmount()
    }
  })

  it('preserves the normal authenticated bounce when reason is absent', () => {
    authState.isAuthenticated = true
    searchParams = new URLSearchParams('returnTo=/tasks')

    render(<LoginPage />)

    expect(replace).toHaveBeenCalledWith('/tasks')
  })
})
