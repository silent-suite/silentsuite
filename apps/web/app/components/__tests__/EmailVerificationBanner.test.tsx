import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EmailVerificationBanner } from '../EmailVerificationBanner'

let mockUser: { id: string; email: string; planId: string; emailVerified?: boolean } | null = null
const mockRefreshSession = vi.fn(async () => true)

vi.mock('@/app/stores/use-auth-store', () => ({
  useAuthStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      user: mockUser,
      refreshSession: mockRefreshSession,
    }),
}))

vi.mock('@/app/lib/self-hosted', () => ({
  isSelfHosted: false,
}))

vi.mock('lucide-react', () => ({
  MailWarning: () => <svg data-testid="mail-warning-icon" />,
  Loader2: () => <svg data-testid="loader-icon" />,
}))

vi.stubGlobal('fetch', vi.fn())

describe('EmailVerificationBanner', () => {
  beforeEach(() => {
    mockUser = { id: 'user-1', email: 'typo@gmial.com', planId: 'early_annual', emailVerified: false }
    mockRefreshSession.mockClear()
    vi.mocked(fetch).mockReset()
  })

  it('renders persistent unverified copy and both recovery actions', () => {
    render(<EmailVerificationBanner />)

    expect(screen.getByText('Please verify your email so you can receive account and billing messages.')).toBeInTheDocument()
    expect(screen.getByText('Resend email')).toBeInTheDocument()
    expect(screen.getByText('Change email')).toBeInTheDocument()
  })

  it('opens a change email form with confirmation and careful contact-email copy', () => {
    render(<EmailVerificationBanner />)

    fireEvent.click(screen.getByText('Change email'))

    expect(screen.getByLabelText('New email')).toBeInTheDocument()
    expect(screen.getByLabelText('Confirm new email')).toBeInTheDocument()
    expect(screen.getByText('This changes the email we use for account and billing messages. Your current login email may stay the same for now.')).toBeInTheDocument()
  })

  it('submits normalized contact email changes to billing and refreshes the session', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ email: 'correct@gmail.com', emailVerified: false }),
    } as Response)
    render(<EmailVerificationBanner />)

    fireEvent.click(screen.getByText('Change email'))
    fireEvent.change(screen.getByLabelText('New email'), { target: { value: ' Correct@GMail.com ' } })
    fireEvent.change(screen.getByLabelText('Confirm new email'), { target: { value: 'correct@gmail.COM' } })
    fireEvent.click(screen.getByText('Save email'))

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/account/email/change'),
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: expect.objectContaining({ 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }),
        body: JSON.stringify({ email: 'correct@gmail.com' }),
      }),
    ))
    await waitFor(() => expect(mockRefreshSession).toHaveBeenCalled())
    expect(await screen.findByText('Verification email sent to correct@gmail.com.')).toBeInTheDocument()
  })

  it('shows a recoverable message when billing changes the email but sending fails', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ email: 'correct@gmail.com', emailVerified: false, sent: false }),
    } as Response)
    render(<EmailVerificationBanner />)

    fireEvent.click(screen.getByText('Change email'))
    fireEvent.change(screen.getByLabelText('New email'), { target: { value: 'correct@gmail.com' } })
    fireEvent.change(screen.getByLabelText('Confirm new email'), { target: { value: 'correct@gmail.com' } })
    fireEvent.click(screen.getByText('Save email'))

    expect(await screen.findByText('Email changed to correct@gmail.com, but the verification email could not be sent. Try Resend email in a moment.')).toBeInTheDocument()
  })

  it('blocks mismatched changed-email confirmation before calling billing', () => {
    render(<EmailVerificationBanner />)

    fireEvent.click(screen.getByText('Change email'))
    fireEvent.change(screen.getByLabelText('New email'), { target: { value: 'one@example.com' } })
    fireEvent.change(screen.getByLabelText('Confirm new email'), { target: { value: 'two@example.com' } })
    fireEvent.click(screen.getByText('Save email'))

    expect(screen.getByText('Email addresses do not match.')).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })
})
