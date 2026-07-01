import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import LoginPage from '../page'

const routerReplace = vi.fn()
const search = vi.hoisted(() => ({ value: new URLSearchParams() }))
const auth = vi.hoisted(() => ({
  state: {
    login: vi.fn(async () => {}),
    isLoading: false,
    error: null as string | null,
    clearError: vi.fn(),
    isAuthenticated: false,
  },
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: routerReplace }),
  useSearchParams: () => search.value,
}))

vi.mock('@/app/stores/use-auth-store', () => {
  const useAuthStore = () => auth.state
  useAuthStore.getState = () => auth.state
  return { useAuthStore }
})

vi.mock('@/app/stores/use-etebase-store', () => ({
  normalizeServerUrl: (url: string) => url.replace(/\/+$/, ''),
}))

vi.mock('lucide-react', () => ({
  ChevronRight: () => <svg data-testid="chevron-right" />,
}))

describe('LoginPage unlock mode', () => {
  beforeEach(() => {
    routerReplace.mockClear()
    auth.state.login.mockReset().mockResolvedValue(undefined)
    auth.state.clearError.mockClear()
    auth.state.isLoading = false
    auth.state.error = null
    auth.state.isAuthenticated = false
    search.value = new URLSearchParams()
    localStorage.clear()
  })

  it('bypasses the authenticated redirect and renders the credential form for unlock mode', () => {
    auth.state.isAuthenticated = true
    search.value = new URLSearchParams('reason=unlock&returnTo=%2Ftasks')

    render(<LoginPage />)

    expect(routerReplace).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Unlock your encrypted data' })).toBeInTheDocument()
    expect(screen.getByLabelText('Email address')).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Unlock data' })).toBeInTheDocument()
  })

  it('submits through login and navigates to the safe return target after unlock succeeds', async () => {
    search.value = new URLSearchParams('reason=unlock&returnTo=%2Ftasks')
    auth.state.login.mockImplementationOnce(async () => {
      auth.state.isAuthenticated = true
    })

    render(<LoginPage />)

    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse battery staple' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock data' }))

    await waitFor(() => expect(auth.state.login).toHaveBeenCalledWith('user@example.com', 'correct horse battery staple', undefined))
    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/tasks'))
  })

  it('falls back to /calendar for unsafe return targets after unlock succeeds', async () => {
    search.value = new URLSearchParams('reason=unlock&returnTo=https%3A%2F%2Fevil.example')
    auth.state.login.mockImplementationOnce(async () => {
      auth.state.isAuthenticated = true
    })

    render(<LoginPage />)

    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock data' }))

    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith('/calendar'))
  })
})
