import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useSyncStore } from '../use-sync-store'

function resetStore() {
  useSyncStore.setState({
    syncStatus: 'synced',
    lastSyncedAt: null,
    isOnline: true,
    error: null,
  })
}

describe('useSyncStore', () => {
  beforeEach(() => {
    resetStore()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
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

  it('simulateSyncCycle transitions synced→syncing→synced', () => {
    expect(useSyncStore.getState().syncStatus).toBe('synced')

    useSyncStore.getState().simulateSyncCycle()
    expect(useSyncStore.getState().syncStatus).toBe('syncing')

    vi.advanceTimersByTime(400)
    expect(useSyncStore.getState().syncStatus).toBe('synced')
    expect(useSyncStore.getState().lastSyncedAt).toBeInstanceOf(Date)
  })

  it('simulateSyncCycle does nothing when offline', () => {
    useSyncStore.getState().setOnline(false)
    useSyncStore.getState().simulateSyncCycle()

    // Should remain synced (not transition to syncing)
    expect(useSyncStore.getState().syncStatus).toBe('synced')
  })

  it('supports offline→syncing→synced transition', () => {
    // Go offline
    useSyncStore.getState().setSyncStatus('offline')
    useSyncStore.getState().setOnline(false)
    expect(useSyncStore.getState().syncStatus).toBe('offline')

    // Come back online
    useSyncStore.getState().setOnline(true)
    useSyncStore.getState().simulateSyncCycle()
    expect(useSyncStore.getState().syncStatus).toBe('syncing')

    vi.advanceTimersByTime(400)
    expect(useSyncStore.getState().syncStatus).toBe('synced')
  })
})
