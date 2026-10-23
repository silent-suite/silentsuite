import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import LoginPage from '../page'

const observation = vi.hoisted(() => ({ etebaseImports: 0 }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/app/stores/use-auth-store', () => {
  const state = { login: vi.fn(), unlockEtebaseSession: vi.fn(), isLoading: false, error: null, clearError: vi.fn(), isAuthenticated: false }
  return { useAuthStore: Object.assign(() => state, { getState: () => state }) }
})
vi.mock('@/app/stores/use-etebase-store', () => {
  observation.etebaseImports += 1
  return { normalizeServerUrl: (url: string) => url }
})
afterEach(cleanup)

it('renders the login form without importing the workspace store just to normalize a URL', () => {
  render(<LoginPage />)
  expect(screen.getByLabelText(/Email address/i)).toBeInTheDocument()
  expect(observation.etebaseImports).toBe(0)
})
