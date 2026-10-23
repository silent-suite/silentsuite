import type { ComponentType, ReactNode } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AuthProvider } from '@/app/providers/auth-provider'
import AppLayout from '@/app/(app)/layout'

const fixture = vi.hoisted(() => {
  function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>((done) => { resolve = done })
    return { promise, resolve }
  }
  return {
    restore: deferred(), subscription: deferred(), chunk: deferred(),
    shellImports: 0, shellMounts: 0, dynamicRequests: 0,
    replace: vi.fn(), fetchSubscription: vi.fn(),
    setAuth: null as unknown as (state: { isAuthenticated: boolean; isLoading: boolean }) => void,
  }
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: fixture.replace }),
  usePathname: () => '/calendar',
}))
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))
vi.mock('@/app/stores/use-auth-store', async () => {
  const { create } = await import('zustand')
  const useAuthStore = create(() => ({
    isAuthenticated: false, isLoading: true,
    restoreSession: () => fixture.restore.promise,
    fetchSubscription: () => {
      fixture.fetchSubscription()
      return fixture.subscription.promise
    },
    retryBillingConnection: async () => {},
    isDegraded: () => false, isReadOnly: () => false,
  }))
  fixture.setAuth = useAuthStore.setState
  return { useAuthStore, watchSignedOutElsewhere: () => () => {} }
})
// Control chunk delivery only. The real provider and protection logic run below;
// the production build/browser comparison separately verifies Next's real loader.
vi.mock('next/dynamic', async () => {
  const { lazy, Suspense } = await import('react')
  return {
    default: (loader: () => Promise<{ default: ComponentType<{ children?: ReactNode }> }>) => {
      const Lazy = lazy(async () => {
        fixture.dynamicRequests += 1
        await fixture.chunk.promise
        return loader()
      })
      return function DeferredShell(props: { children?: ReactNode }) {
        return <Suspense fallback={null}><Lazy {...props} /></Suspense>
      }
    },
  }
})
vi.mock('@/app/providers/sync-provider', async () => {
  const { useEffect } = await import('react')
  fixture.shellImports += 1
  return {
    SyncProvider: ({ children }: { children: ReactNode }) => {
      useEffect(() => { fixture.shellMounts += 1 }, [])
      return <div data-testid="sync-provider">{children}</div>
    },
  }
})
vi.mock('@/app/providers/notification-provider', () => ({
  NotificationProvider: ({ children }: { children: ReactNode }) => <div data-testid="notification-provider">{children}</div>,
}))
vi.mock('@/app/components/sidebar', () => ({ Sidebar: () => null }))
vi.mock('@/app/components/header', () => ({ Header: () => null }))
vi.mock('@/app/components/bottom-nav', () => ({ BottomNav: () => null }))
vi.mock('@/app/components/read-only-overlay', () => ({ ReadOnlyBanner: () => null, DegradedModeBanner: () => null }))
vi.mock('@/app/components/restore-blocked-banner', () => ({ RestoreBlockedBanner: () => null }))
vi.mock('@/app/components/partial-load-banner', () => ({ PartialLoadBanner: () => null }))
vi.mock('@/app/components/PendingSyncBanner', () => ({ PendingSyncBanner: () => null }))
vi.mock('@/app/components/OfflineToast', () => ({ OfflineToast: () => null }))
vi.mock('@/app/components/Toast', () => ({ ToastContainer: () => null }))
vi.mock('@/app/components/EmailVerificationBanner', () => ({ EmailVerificationBanner: () => null }))

afterEach(cleanup)

it('defers shell imports through real restoration and never mounts a late chunk after logout', async () => {
  render(<AuthProvider><AppLayout><span>Protected workspace child</span></AppLayout></AuthProvider>)
  expect(screen.getByText('Decrypting your workspace...')).toBeInTheDocument()
  expect(fixture.shellImports).toBe(0)
  expect(fixture.dynamicRequests).toBe(0)

  await act(async () => {
    fixture.setAuth({ isAuthenticated: true, isLoading: true })
    fixture.restore.resolve()
  })
  await waitFor(() => expect(fixture.fetchSubscription).toHaveBeenCalledTimes(1))
  expect(fixture.dynamicRequests).toBe(0)
  expect(screen.queryByText('Protected workspace child')).not.toBeInTheDocument()

  await act(async () => { fixture.subscription.resolve() })
  await waitFor(() => expect(fixture.dynamicRequests).toBe(1))
  // Preserve ProtectedRoute's existing authenticated/loading behavior, rather
  // than adding a blanket isLoading gate after restoration has completed.
  expect(fixture.shellMounts).toBe(0)

  act(() => fixture.setAuth({ isAuthenticated: false, isLoading: false }))
  await waitFor(() => expect(fixture.replace).toHaveBeenCalledWith('/login?returnTo=%2Fcalendar'))
  await act(async () => { fixture.chunk.resolve() })
  await waitFor(() => expect(fixture.shellImports).toBe(1))
  expect(fixture.shellMounts).toBe(0)
  expect(screen.queryByText('Protected workspace child')).not.toBeInTheDocument()

  act(() => fixture.setAuth({ isAuthenticated: true, isLoading: true }))
  expect(await screen.findByText('Protected workspace child')).toBeInTheDocument()
  expect(fixture.shellMounts).toBe(1)
  expect(screen.getByTestId('notification-provider').parentElement).toBe(screen.getByTestId('sync-provider'))
  expect(screen.getByText('Protected workspace child').closest('main')).toHaveAttribute('id', 'main-content')
})
