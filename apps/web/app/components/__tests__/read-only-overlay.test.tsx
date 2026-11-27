import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ReadOnlyBanner, DegradedModeBanner } from '../read-only-overlay'

// Mock the auth store
let mockSubscriptionStatus: string | null = 'cancelled'
// Not declared on the store yet; the mocked state carries it so the banner can read it.
let mockHostedAccess: unknown = null
let mockEndedHistory: unknown = null
let mockRetryBillingConnection = vi.fn().mockResolvedValue(true)

vi.mock('@/app/stores/use-auth-store', () => ({
  useAuthStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      subscriptionStatus: mockSubscriptionStatus,
      hostedAccess: mockHostedAccess,
      endedHistory: mockEndedHistory,
      retryBillingConnection: mockRetryBillingConnection,
    }),
}))

let mockIsOnline = true
vi.mock('@/app/stores/use-sync-store', () => ({
  useSyncStore: (selector: (s: Record<string, unknown>) => unknown) => selector({ isOnline: mockIsOnline }),
}))

let mockPathname = '/calendar'
vi.mock('next/navigation', () => ({ usePathname: () => mockPathname }))

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
}))

describe('ReadOnlyBanner', () => {
  beforeEach(() => {
    mockSubscriptionStatus = 'cancelled'
    mockHostedAccess = null
    mockEndedHistory = null
    mockPathname = '/calendar'
  })

  // SIGNUP-04: Billing's read names what ended, whatever the status alone would say.
  it.each([
    ['trial', 'expired', 'Your free trial ended. Your data is safe and read-only.'],
    ['subscription', 'expired', 'Your subscription ended. Your data is safe and read-only.'],
    ['unpaid', 'none', "You haven't finished paying. Your data is safe and read-only."],
  ])('words an ended %s from Billing', (endedHistory, status, text) => {
    mockEndedHistory = endedHistory
    mockSubscriptionStatus = status
    render(<ReadOnlyBanner />)
    expect(screen.getByText(text)).toBeInTheDocument()
  })

  it('renders non-blocking banner with subscription ended message', () => {
    render(<ReadOnlyBanner />)
    expect(screen.getByText(/Your subscription ended\./)).toBeInTheDocument()
    expect(screen.getByText(/Your data is safe and read-only\./)).toBeInTheDocument()
  })

  it('renders trial ended message for none status', () => {
    mockSubscriptionStatus = 'none'
    render(<ReadOnlyBanner />)
    expect(screen.getByText(/Your free trial ended\./)).toBeInTheDocument()
  })

  it('[RED] renders the existing trial ended message for trialing with hostedAccess trial_ended', () => {
    mockSubscriptionStatus = 'trialing'
    mockHostedAccess = 'trial_ended'
    render(<ReadOnlyBanner />)
    expect(screen.getByText(/Your free trial ended\. Your data is safe and read-only\./)).toBeInTheDocument()
    expect(screen.queryByText(/Your subscription ended\./)).not.toBeInTheDocument()
  })

  // Whether the banner renders at all is decided by isReadOnly in the shell
  // (store tests); these rows only pin the copy for non-restricting access.
  it.each([
    ['unknown', 'unknown'],
    ['entitled', 'entitled'],
    ['null', null],
    ['unrecognized', 'trial_expired'],
  ])('[CTRL] keeps the existing copy for trialing with hostedAccess %s', (_label, hostedAccess) => {
    mockSubscriptionStatus = 'trialing'
    mockHostedAccess = hostedAccess
    render(<ReadOnlyBanner />)
    expect(screen.getByText(/Your subscription ended\./)).toBeInTheDocument()
    expect(screen.queryByText(/Your free trial ended\./)).not.toBeInTheDocument()
  })

  it('[CTRL] keeps the existing copy for none and cancelled when hostedAccess is trial_ended', () => {
    mockHostedAccess = 'trial_ended'
    mockSubscriptionStatus = 'none'
    const { unmount } = render(<ReadOnlyBanner />)
    expect(screen.getByText(/Your free trial ended\./)).toBeInTheDocument()
    unmount()

    mockSubscriptionStatus = 'cancelled'
    render(<ReadOnlyBanner />)
    expect(screen.getByText(/Your subscription ended\./)).toBeInTheDocument()
  })

  it('renders the plan and export data links', () => {
    render(<ReadOnlyBanner />)
    const planLink = screen.getByRole('link', { name: 'Reactivate' })
    expect(planLink).toHaveAttribute('href', '/settings/subscription')

    const exportLink = screen.getByText('Export data')
    expect(exportLink.closest('a')).toHaveAttribute('href', '/settings/export')
  })

  // SIGNUP-08: the button names the same action as the subscription page it opens.
  it.each([
    ['trial', 'Subscribe'],
    ['subscription', 'Reactivate'],
    ['unpaid', 'Subscribe'],
  ])('labels the plan link for an ended %s', (endedHistory, label) => {
    mockEndedHistory = endedHistory
    render(<ReadOnlyBanner />)
    expect(screen.getByRole('link', { name: label })).toHaveAttribute('href', '/settings/subscription')
    expect(screen.queryByText('Choose a plan')).not.toBeInTheDocument()
  })

  it('shows no external-link icon on the in-app plan link (SIGNUP-08)', () => {
    render(<ReadOnlyBanner />)
    expect(screen.queryByTestId('external-link-icon')).not.toBeInTheDocument()
  })

  it('stays hidden on the subscription page, whose card says the same (SIGNUP-08)', () => {
    mockPathname = '/settings/subscription'
    const { container } = render(<ReadOnlyBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows on other settings pages (SIGNUP-08)', () => {
    mockPathname = '/settings/export'
    render(<ReadOnlyBanner />)
    expect(screen.getByText(/Your subscription ended\./)).toBeInTheDocument()
  })

  it('stacks the text above the actions below the sm breakpoint (SIGNUP-08)', () => {
    const { container } = render(<ReadOnlyBanner />)
    expect(container.firstElementChild).toHaveClass('flex-col', 'sm:flex-row')
    expect(container.firstElementChild).not.toHaveClass('flex-wrap')
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

  it('uses contrasting foregrounds in both light and dark modes', () => {
    const { container } = render(<ReadOnlyBanner />)
    expect(container.firstElementChild).toHaveClass('text-amber-800', 'dark:text-amber-200')
    expect(screen.getByRole('link', { name: 'Reactivate' })).toHaveClass(
      'bg-amber-700',
      'hover:bg-amber-800',
      'dark:bg-amber-400',
      'dark:hover:bg-amber-300',
    )
  })
})

describe('DegradedModeBanner', () => {
  beforeEach(() => {
    mockRetryBillingConnection = vi.fn().mockResolvedValue(true)
    mockIsOnline = true
  })

  it('does not blame billing while the browser is offline (WEB-01)', () => {
    mockIsOnline = false
    const { container } = render(<DegradedModeBanner />)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByText(/Billing service temporarily unavailable/)).not.toBeInTheDocument()
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

  it('uses contrasting foregrounds in both light and dark modes', () => {
    const { container } = render(<DegradedModeBanner />)
    expect(container.firstElementChild).toHaveClass('text-blue-800', 'dark:text-blue-200')
    expect(screen.getByRole('button', { name: /retry/i })).toHaveClass(
      'text-blue-700',
      'dark:text-blue-300',
    )
  })
})
