import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { EncryptedSessionRecoveryScreen } from '../EncryptedSessionRecoveryScreen'
import { useSyncStore } from '@/app/stores/use-sync-store'

const routerPush = vi.fn()
const logout = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush }),
}))

vi.mock('@/app/stores/use-auth-store', () => ({
  useAuthStore: (selector: (state: { logout: typeof logout }) => unknown) => selector({ logout }),
}))

vi.mock('lucide-react', () => ({
  LockKeyhole: () => <svg data-testid="lock-icon" />,
  LogOut: () => <svg data-testid="logout-icon" />,
}))

describe('EncryptedSessionRecoveryScreen', () => {
  beforeEach(() => {
    routerPush.mockClear()
    logout.mockClear()
    useSyncStore.setState({ initialSyncBlocker: null, error: null })
  })

  it('renders recovery copy and unlock CTA for a missing encrypted session', () => {
    useSyncStore.setState({
      initialSyncBlocker: 'missing-encrypted-session',
      error: 'Encrypted session was not restored. Sign in again to unlock your data.',
    })

    render(<EncryptedSessionRecoveryScreen />)

    expect(screen.getByRole('heading', { name: 'Unlock your encrypted data' })).toBeInTheDocument()
    expect(screen.getByText('You are signed in')).toBeInTheDocument()
    expect(screen.getByText(/could not find the encrypted vault keys/i)).toBeInTheDocument()
    expect(screen.getByText(/Your data has not been deleted/i)).toBeInTheDocument()
    expect(screen.getByText(/Encryption keys stay local to this browser or device/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Sign in again to unlock data' }))
    expect(routerPush).toHaveBeenCalledWith('/login?reason=unlock&returnTo=%2Fcalendar')
  })

  it('calls the existing logout action from the secondary CTA', () => {
    useSyncStore.setState({ initialSyncBlocker: 'encrypted-session-restore-failed' })

    render(<EncryptedSessionRecoveryScreen />)
    fireEvent.click(screen.getByRole('button', { name: /Sign out/i }))

    expect(logout).toHaveBeenCalledTimes(1)
  })
})
