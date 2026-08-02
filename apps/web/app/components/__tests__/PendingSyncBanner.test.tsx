import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PendingSyncBanner } from '../PendingSyncBanner'

const syncState = {
  pendingQueueCount: 2,
  failedQueueCount: 1,
  isOnline: true,
  replayOfflineQueue: vi.fn(),
}

const etebaseState = {
  account: {},
  accountFingerprint: 'account-fingerprint',
}

vi.mock('@/app/stores/use-sync-store', () => ({
  useSyncStore: (selector: (state: typeof syncState) => unknown) => selector(syncState),
}))

vi.mock('@/app/stores/use-etebase-store', () => ({
  useEtebaseStore: (selector: (state: typeof etebaseState) => unknown) => selector(etebaseState),
}))

vi.mock('@/app/lib/offline-queue', () => ({
  MAX_QUEUE_SIZE: 2,
  clearFailed: vi.fn(),
  retryFailed: vi.fn(),
  getStaleEntries: vi.fn().mockResolvedValue([{}]),
}))

vi.mock('@/app/lib/account-epoch', () => ({
  AccountBoundaryChangedError: class AccountBoundaryChangedError extends Error {},
  getAccountEpoch: () => 1,
}))

describe('PendingSyncBanner', () => {
  it('uses contrasting foregrounds for every light and dark warning state', async () => {
    const { container } = render(<PendingSyncBanner />)

    const mainBanner = container.firstElementChild?.firstElementChild
    expect(mainBanner).toHaveClass('text-amber-800', 'dark:text-amber-200')
    expect(screen.getByRole('button', { name: /retry/i })).toHaveClass(
      'text-amber-800',
      'dark:text-amber-300',
    )
    expect(screen.getByRole('button', { name: /discard/i })).toHaveClass(
      'text-red-800',
      'dark:text-red-400',
    )

    expect(screen.getByText(/Offline queue is full/i).parentElement).toHaveClass(
      'text-red-800',
      'dark:text-red-200',
    )

    await waitFor(() => {
      expect(screen.getByText(/pending for over 24 hours/i).parentElement).toHaveClass(
        'text-orange-800',
        'dark:text-orange-200',
      )
    })
  })
})
