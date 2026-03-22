import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ReadOnlyBanner, DegradedModeBanner } from '../read-only-overlay'

// Mock the auth store
let mockSubscriptionStatus: string | null = 'cancelled'
let mockRetryBillingConnection = vi.fn().mockResolvedValue(true)

vi.mock('@/app/stores/use-auth-store', () => ({
  useAuthStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      subscriptionStatus: mockSubscriptionStatus,
      retryBillingConnection: mockRetryBillingConnection,
    }),
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
  WifiOff: () => <svg data-testid="wifi-off-icon" />,
  RefreshCw: ({ className }: { className?: string }) => <svg data-testid="refresh-icon" className={className} />,
  ExternalLink: () => <svg data-testid="external-link-icon" />,
}))

describe('ReadOnlyBanner', () => {
  beforeEach(() => {
    mockSubscriptionStatus = 'cancelled'
  })

  it('renders non-blocking banner with subscription ended message', () => {
    render(<ReadOnlyBanner />)
    expect(screen.getByText(/Your subscription has ended\./)).toBeInTheDocument()
    expect(screen.getByText(/Your data is safe and read-only\./)).toBeInTheDocument()
  })

  it('renders trial ended message for none status', () => {
    mockSubscriptionStatus = 'none'
    render(<ReadOnlyBanner />)
    expect(screen.getByText(/Your trial has ended\./)).toBeInTheDocument()
  })

  it('renders choose a plan and export data links', () => {
    render(<ReadOnlyBanner />)
    const planLink = screen.getByText('Choose a plan')
    expect(planLink.closest('a')).toHaveAttribute('href', '/settings/subscription')

    const exportLink = screen.getByText('Export data')
    expect(exportLink.closest('a')).toHaveAttribute('href', '/settings/export')
  })

  it('is a banner (not a full-screen overlay)', () => {
    const { container } = render(<ReadOnlyBanner />)
    // Should NOT have fixed inset-0 (full-screen overlay classes)
    const root = container.firstElementChild!
    expect(root.className).not.toContain('fixed')
    expect(root.className).not.toContain('inset-0')
    // Should be a banner-style element
    expect(root.className).toContain('rounded-lg')
  })
})

describe('DegradedModeBanner', () => {
  beforeEach(() => {
    mockRetryBillingConnection = vi.fn().mockResolvedValue(true)
  })

  it('renders degraded mode banner with correct message', () => {
    render(<DegradedModeBanner />)
    expect(screen.getByText('Billing service temporarily unavailable. Your data is safe.')).toBeInTheDocument()
  })

  it('renders retry button', () => {
    render(<DegradedModeBanner />)
    expect(screen.getByText('Retry')).toBeInTheDocument()
  })

  it('calls retryBillingConnection when retry is clicked', async () => {
    render(<DegradedModeBanner />)
    fireEvent.click(screen.getByText('Retry'))
    expect(mockRetryBillingConnection).toHaveBeenCalledOnce()
  })

  it('is a non-blocking banner (not overlay)', () => {
    const { container } = render(<DegradedModeBanner />)
    const root = container.firstElementChild!
    expect(root.className).not.toContain('fixed')
    expect(root.className).not.toContain('inset-0')
    expect(root.className).toContain('rounded-lg')
  })
})
