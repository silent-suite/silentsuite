import 'fake-indexeddb/auto'
import { act, cleanup as unmountAll, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAll } from '@/app/lib/offline-queue'
import { bumpAccountEpoch } from '@/app/lib/account-epoch'
import { TEST_FINGERPRINT, queueGuard, resetRealOfflineQueue } from '../../stores/__tests__/offline-queue-store-test-utils'

const coreMock = vi.hoisted(() => ({ deleteItem: vi.fn(), listItems: vi.fn(), restoreSession: vi.fn() }))
const toastMock = vi.hoisted(() => ({ showErrorToast: vi.fn() }))

// Only the remote SDK boundary and two unrelated side stores are replaced. The
// banner, the sync store, the Etebase store and the offline queue are real.
vi.mock('@silentsuite/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@silentsuite/core')>(),
  ...coreMock,
}))
vi.mock('@/app/stores/use-toast-store', () => toastMock)
vi.mock('@/app/stores/use-label-suggestions-store', () => ({ useLabelSuggestionsStore: { getState: () => ({ recordUsage: vi.fn() }) } }))

import { PendingSyncBanner } from '../PendingSyncBanner'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useSyncStore } from '@/app/stores/use-sync-store'

vi.setConfig({ testTimeout: 15_000 })

const restoredAccount = (fingerprint: string) => ({ account: { getCollectionManager: () => ({}) } as never, accountFingerprint: fingerprint })

describe('PendingSyncBanner startup count with the real stores and offline queue', () => {
  beforeEach(async () => {
    await resetRealOfflineQueue()
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    useSyncStore.setState(useSyncStore.getInitialState(), true)
    coreMock.deleteItem.mockReset()
    coreMock.listItems.mockReset()
    coreMock.restoreSession.mockReset()
    toastMock.showErrorToast.mockReset()
  })

  it('shows a change queued by a previous session once the account is restored after sync initialization', async () => {
    // A previous page load queued a note delete while offline.
    useEtebaseStore.setState(restoredAccount(TEST_FINGERPRINT))
    await expect(useEtebaseStore.getState().deleteItem('notes', 'note-1', { collectionUid: 'notes-1' })).resolves.toBe('queued')
    const [queued] = await getAll(queueGuard())
    expect(queued).toMatchObject({ type: 'delete', itemUid: 'note-1', status: 'pending', accountFingerprint: TEST_FINGERPRINT })

    // Reload: no account yet, in the same account epoch.
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    useSyncStore.setState({ pendingQueueCount: 0, failedQueueCount: 0 })
    let stopSync: (() => void) | null = null
    try {
      render(<PendingSyncBanner />)
      act(() => { stopSync = useSyncStore.getState().initializeSync() })

      // Let the count read that started without an account finish before one is published.
      await act(async () => {
        await vi.dynamicImportSettled()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(useSyncStore.getState().pendingQueueCount).toBe(0)
      expect(screen.queryByText(/waiting to sync/)).toBeNull()

      act(() => { useEtebaseStore.setState(restoredAccount(TEST_FINGERPRINT)) })

      expect(await screen.findByText('1 change waiting to sync')).toBeTruthy()
      expect(screen.queryByText(/failed/)).toBeNull()
      expect(await getAll(queueGuard())).toEqual([queued!])
      expect(coreMock.restoreSession).not.toHaveBeenCalled()
      expect(coreMock.listItems).not.toHaveBeenCalled()
      expect(coreMock.deleteItem).not.toHaveBeenCalled()

      // A different account has nothing queued: the old account's banner goes away.
      act(() => {
        bumpAccountEpoch()
        useEtebaseStore.setState(restoredAccount('new-account'))
      })
      await vi.waitFor(() => expect(screen.queryByText(/waiting to sync/)).toBeNull())
      expect((await getAll()).map((entry) => entry.accountFingerprint)).toEqual([TEST_FINGERPRINT])
    } finally {
      (stopSync as (() => void) | null)?.()
      unmountAll()
      useSyncStore.setState(useSyncStore.getInitialState(), true)
      useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
      await resetRealOfflineQueue()
    }
  })
})
