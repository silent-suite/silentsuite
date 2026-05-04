import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { User } from '@/app/stores/use-auth-store'

// In-memory replica of the auth store the modal reads from. We mock the
// entire module so we don't need to wire up the real Zustand store, the
// secure storage, etc. — the modal only uses two slices: `user` and
// `markOnboarded`.
const mockState = {
  user: null as User | null,
  markOnboarded: vi.fn(async () => true),
}

vi.mock('@/app/stores/use-auth-store', () => ({
  useAuthStore: <T,>(selector: (s: typeof mockState) => T) => selector(mockState),
}))

// next-themes pulls in matchMedia which jsdom doesn't provide; mock it to
// keep the welcome / theme-choice slides happy without polluting the test.
vi.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'system', setTheme: vi.fn() }),
}))

// Heavy import slides are out of scope for the gate tests — stub them so
// rendering a deeper step (we never do, but defensive) doesn't blow up on
// the etebase dependency tree.
vi.mock('@/app/components/import/CalendarImport', () => ({
  default: () => null,
}))
vi.mock('@/app/components/import/TaskImport', () => ({
  default: () => null,
}))
vi.mock('@/app/components/import/ContactImport', () => ({
  default: () => null,
}))

import { OnboardingModal } from '../OnboardingModal'

function setUser(user: User | null) {
  mockState.user = user
}

describe('OnboardingModal — gate logic (issue #113)', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    setUser(null)
    mockState.markOnboarded.mockClear()
    mockState.markOnboarded.mockResolvedValue(true)
  })

  it('does not render while user is null (auth still hydrating)', () => {
    setUser(null)
    const { container } = render(<OnboardingModal />)
    expect(container.firstChild).toBeNull()
  })

  it('renders when user.onboardedAt is null', () => {
    setUser({ id: 'u1', email: 'a@b.com', planId: 'pro', onboardedAt: null })
    render(<OnboardingModal />)
    expect(screen.getByLabelText('Close onboarding')).toBeInTheDocument()
  })

  it('does not render when user.onboardedAt is a recent timestamp', () => {
    setUser({
      id: 'u1',
      email: 'a@b.com',
      planId: 'pro',
      onboardedAt: new Date().toISOString(),
    })
    const { container } = render(<OnboardingModal />)
    expect(container.firstChild).toBeNull()
  })

  it('does not render when user.onboardedAt is an old timestamp', () => {
    setUser({
      id: 'u1',
      email: 'a@b.com',
      planId: 'pro',
      onboardedAt: '2024-01-01T00:00:00.000Z',
    })
    const { container } = render(<OnboardingModal />)
    expect(container.firstChild).toBeNull()
  })

  it('respects the localStorage flash-suppression hint when set', () => {
    // Even if server says onboardedAt is null, the synchronous hint
    // suppresses the modal so we don't flash it on top of an
    // already-onboarded session before the auth store hydrates.
    localStorage.setItem('onboardingCompleted', 'true')
    setUser({ id: 'u1', email: 'a@b.com', planId: 'pro', onboardedAt: null })
    const { container } = render(<OnboardingModal />)
    expect(container.firstChild).toBeNull()
  })

  it('writes the localStorage hint when onboardedAt is non-null', () => {
    setUser({
      id: 'u1',
      email: 'a@b.com',
      planId: 'pro',
      onboardedAt: '2025-06-01T00:00:00.000Z',
    })
    render(<OnboardingModal />)
    expect(localStorage.getItem('onboardingCompleted')).toBe('true')
  })

  it('X button calls markOnboarded and sets the localStorage hint', () => {
    setUser({ id: 'u1', email: 'a@b.com', planId: 'pro', onboardedAt: null })
    render(<OnboardingModal />)

    fireEvent.click(screen.getByLabelText('Close onboarding'))

    expect(mockState.markOnboarded).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('onboardingCompleted')).toBe('true')
  })

  it('Skip all button calls markOnboarded and sets the localStorage hint', () => {
    setUser({ id: 'u1', email: 'a@b.com', planId: 'pro', onboardedAt: null })
    render(<OnboardingModal />)

    fireEvent.click(screen.getByText('Skip all'))

    expect(mockState.markOnboarded).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('onboardingCompleted')).toBe('true')
  })

  it('Escape key calls markOnboarded and sets the localStorage hint', () => {
    setUser({ id: 'u1', email: 'a@b.com', planId: 'pro', onboardedAt: null })
    render(<OnboardingModal />)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(mockState.markOnboarded).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('onboardingCompleted')).toBe('true')
  })

  it('does not block dismissal when markOnboarded fails', () => {
    // Network error — markOnboarded resolves false; the modal must still
    // close and the localStorage hint must still be set so the user
    // isn't trapped in the popup for the rest of this session.
    mockState.markOnboarded.mockResolvedValueOnce(false)
    setUser({ id: 'u1', email: 'a@b.com', planId: 'pro', onboardedAt: null })
    render(<OnboardingModal />)

    fireEvent.click(screen.getByLabelText('Close onboarding'))

    expect(mockState.markOnboarded).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('onboardingCompleted')).toBe('true')
  })
})
