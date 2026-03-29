import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSyncStore } from '../use-sync-store'

// Mock the heavy dependencies that simulateSyncCycle imports dynamically
vi.mock('@/app/stores/use-etebase-store', () => ({
  useEtebaseStore: {
    getState: () => ({
      account: null,
      syncEngine: null,
      refreshCollection: vi.fn().mockResolvedValue([]),
    }),
  },
}))

vi.mock('@silentsuite/core', () => ({
  deserializeTask: vi.fn(),
  deserializeContact: vi.fn(),
  deserializeCalendarEvent: vi.fn(),
}))

vi.mock('@/app/stores/use-task-store', () => ({
  useTaskStore: { getState: () => ({ syncFromRemote: vi.fn() }) },
}))

vi.mock('@/app/stores/use-contact-store', () => ({
  useContactStore: { getState: () => ({ syncFromRemote: vi.fn() }) },
}))

vi.mock('@/app/stores/use-calendar-store', () => ({
  useCalendarStore: { getState: () => ({ syncFromRemote: vi.fn() }) },
}))

vi.mock('@/app/lib/offline-queue', () => ({
  replay: vi.fn().mockResolvedValue([]),
  getPendingCount: vi.fn().mockResolvedValue(0),
  getFailedCount: vi.fn().mockResolvedValue(0),
  onCountChange: vi.fn().mockReturnValue(() => {}),
  getStaleEntries: vi.fn().mockResolvedValue([]),
  remove: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/app/stores/use-toast-store', () => ({
  showErrorToast: vi.fn(),
}))

function resetStore() {
  useSyncStore.setState({
    syncStatus: 'synced',
    lastSyncedAt: null,
    isOnline: true,
    error: null,
    pendingQueueCount: 0,
    failedQueueCount: 0,
  })
}

/** Wait for all pending microtasks/promises to flush */
function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('useSyncStore', () => {
  beforeEach(() => {
    resetStore()
  })

  it('setSyncStatus updates the status', () => {
    useSyncStore.getState().setSyncStatus('syncing')
    expect(useSyncStore.getState().syncStatus).toBe('syncing')
  })

  it('setOnline updates online state', () => {
    useSyncStore.getState().setOnline(false)
    expect(useSyncStore.getState().isOnline).toBe(false)
  })

  it('setError updates error state', () => {
    useSyncStore.getState().setError('Connection lost')
    expect(useSyncStore.getState().error).toBe('Connection lost')

    useSyncStore.getState().setError(null)
    expect(useSyncStore.getState().error).toBeNull()
  })

  it('simulateSyncCycle transitions synced→syncing→synced', async () => {
    expect(useSyncStore.getState().syncStatus).toBe('synced')

    useSyncStore.getState().simulateSyncCycle()
    expect(useSyncStore.getState().syncStatus).toBe('syncing')

    // The cycle uses dynamic imports and Promises — wait for them to resolve
    await flushPromises()
    expect(useSyncStore.getState().syncStatus).toBe('synced')
    expect(useSyncStore.getState().lastSyncedAt).toBeInstanceOf(Date)
  })

  it('simulateSyncCycle does nothing when offline', () => {
    useSyncStore.getState().setOnline(false)
    useSyncStore.getState().simulateSyncCycle()

    // Should remain synced (not transition to syncing)
    expect(useSyncStore.getState().syncStatus).toBe('synced')
  })

  it('supports offline→syncing→synced transition', async () => {
    // Go offline
    useSyncStore.getState().setSyncStatus('offline')
    useSyncStore.getState().setOnline(false)
    expect(useSyncStore.getState().syncStatus).toBe('offline')

    // Come back online
    useSyncStore.getState().setOnline(true)
    useSyncStore.getState().simulateSyncCycle()
    expect(useSyncStore.getState().syncStatus).toBe('syncing')

    await flushPromises()
    expect(useSyncStore.getState().syncStatus).toBe('synced')
  })
})
