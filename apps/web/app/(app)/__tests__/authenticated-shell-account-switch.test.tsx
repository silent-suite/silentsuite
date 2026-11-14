import type { ReactNode } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AuthenticatedShell from '@/app/(app)/authenticated-shell'
import { useAuthStore } from '@/app/stores/use-auth-store'

const fixture = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }))

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))
vi.mock('@/app/stores/use-auth-store', async () => {
  const { create } = await import('zustand')
  const useAuthStore = create(() => ({
    user: { id: 'user-a' } as { id: string } | null,
    isDegraded: () => false,
    isReadOnly: () => false,
  }))
  return { useAuthStore }
})
// SyncProvider initializes the account once per mount; count mounts here.
vi.mock('@/app/providers/sync-provider', async () => {
  const { useEffect } = await import('react')
  return {
    SyncProvider: ({ children }: { children: ReactNode }) => {
      useEffect(() => {
        fixture.mounts += 1
        return () => { fixture.unmounts += 1 }
      }, [])
      return <>{children}</>
    },
  }
})
vi.mock('@/app/providers/notification-provider', () => ({ NotificationProvider: ({ children }: { children: ReactNode }) => <>{children}</> }))
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

beforeEach(() => {
  useAuthStore.setState({ user: { id: 'user-a' } })
})

afterEach(() => {
  cleanup()
  fixture.mounts = 0
  fixture.unmounts = 0
})

it('restarts sync when the signed-in account changes without leaving the shell', () => {
  render(<AuthenticatedShell><div /></AuthenticatedShell>)
  expect(fixture.mounts).toBe(1)

  // A session refresh that returns another account resets every store in place.
  act(() => { useAuthStore.setState({ user: { id: 'user-b' } }) })

  expect(fixture.unmounts).toBe(1)
  expect(fixture.mounts).toBe(2)
})

it('keeps the running sync when a refresh confirms the same account', () => {
  render(<AuthenticatedShell><div /></AuthenticatedShell>)

  act(() => { useAuthStore.setState({ user: { id: 'user-a' } }) })

  expect(fixture.mounts).toBe(1)
  expect(fixture.unmounts).toBe(0)
})
