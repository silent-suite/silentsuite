import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReadOnlyOverlay } from '../read-only-overlay'

// Mock the auth store
let mockSubscriptionStatus: string | null = 'cancelled'

vi.mock('@/app/stores/use-auth-store', () => ({
  useAuthStore: (selector: (s: { subscriptionStatus: string | null }) => unknown) =>
    selector({ subscriptionStatus: mockSubscriptionStatus }),
}))

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; className?: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}))

// Mock lucide-react
vi.mock('lucide-react', () => ({
  Lock: () => <svg data-testid="lock-icon" />,
}))

// Mock @silentsuite/ui
vi.mock('@silentsuite/ui', () => ({
  Button: ({ children, ...props }: { children: React.ReactNode; size?: string; className?: string }) => (
    <button {...props}>{children}</button>
  ),
}))

describe('ReadOnlyOverlay', () => {
  beforeEach(() => {
    mockSubscriptionStatus = 'cancelled'
  })

  it('renders overlay with subscription ended message', () => {
    render(<ReadOnlyOverlay />)
    expect(screen.getByText('Your subscription has ended')).toBeInTheDocument()
    expect(screen.getByText('Your data is safe and encrypted.')).toBeInTheDocument()
  })

  it('renders trial ended message for trialing status', () => {
    mockSubscriptionStatus = 'trialing'
    render(<ReadOnlyOverlay />)
    expect(screen.getByText('Your trial has ended')).toBeInTheDocument()
  })

  it('renders trial ended message for none status', () => {
    mockSubscriptionStatus = 'none'
    render(<ReadOnlyOverlay />)
    expect(screen.getByText('Your trial has ended')).toBeInTheDocument()
  })

  it('renders export data link', () => {
    render(<ReadOnlyOverlay />)
    const exportLink = screen.getByText('Export my data')
    expect(exportLink).toBeInTheDocument()
    expect(exportLink).toHaveAttribute('href', '/settings/account')
  })

  it('renders choose a plan button with link', () => {
    render(<ReadOnlyOverlay />)
    expect(screen.getByText('Choose a plan')).toBeInTheDocument()
  })
})
