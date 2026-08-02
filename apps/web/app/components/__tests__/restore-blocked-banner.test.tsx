import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RestoreBlockedBanner } from '../restore-blocked-banner'

const etebaseState = {
  restoreBlocked: false,
}

const authState = {
  isAuthenticated: false,
}

vi.mock('@/app/stores/use-etebase-store', () => ({
  useEtebaseStore: (selector: (s: typeof etebaseState) => unknown) => selector(etebaseState),
}))

vi.mock('@/app/stores/use-auth-store', () => ({
  useAuthStore: (selector: (s: typeof authState) => unknown) => selector(authState),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/calendar',
}))

describe('RestoreBlockedBanner', () => {
  beforeEach(() => {
    etebaseState.restoreBlocked = false
    authState.isAuthenticated = false
  })

  it('renders nothing when restore is not blocked', () => {
    etebaseState.restoreBlocked = false
    authState.isAuthenticated = true
    const { container } = render(<RestoreBlockedBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when blocked but not authenticated', () => {
    etebaseState.restoreBlocked = true
    authState.isAuthenticated = false
    const { container } = render(<RestoreBlockedBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders reassurance copy and an unlock link when blocked and authenticated', () => {
    etebaseState.restoreBlocked = true
    authState.isAuthenticated = true
    render(<RestoreBlockedBanner />)

    expect(
      screen.getByText(/Your data is encrypted and safe on the server/i),
    ).toBeInTheDocument()

    const link = screen.getByRole('link', { name: /unlock now/i })
    expect(link).toHaveAttribute('href', '/login?reason=unlock&returnTo=%2Fcalendar')
  })

  it('uses contrasting foregrounds in both light and dark modes', () => {
    etebaseState.restoreBlocked = true
    authState.isAuthenticated = true
    const { container } = render(<RestoreBlockedBanner />)

    expect(container.firstElementChild).toHaveClass('text-emerald-800', 'dark:text-emerald-200')
    expect(screen.getByRole('link', { name: /unlock now/i })).toHaveClass(
      'bg-emerald-700',
      'hover:bg-emerald-800',
      'dark:bg-emerald-400',
      'dark:hover:bg-emerald-300',
    )
  })

  it('renders reassuring copy that contains no error/failure/phase wording', () => {
    etebaseState.restoreBlocked = true
    authState.isAuthenticated = true
    const { container } = render(<RestoreBlockedBanner />)

    const text = container.textContent ?? ''
    expect(text).not.toMatch(/error/i)
    expect(text).not.toMatch(/failed/i)
    expect(text).not.toMatch(/restoreSession|sessionRead|listItems|syncEngine/i)
  })
})
