import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSyncStore } from '../use-sync-store'
import { getPendingCount, replay } from '@/app/lib/offline-queue'

const etebaseMock = vi.hoisted(() => ({
  state: {
    account: null as unknown,
    syncEngine: null as { syncNow: ReturnType<typeof vi.fn> } | null,
    reconcileCollections: vi.fn().mockResolvedValue(undefined),
    refreshCollection: vi.fn().mockResolvedValue([]),
    moveItem: vi.fn(),
  },
}))

const calendarStoreMock = vi.hoisted(() => ({
  events: [] as { id: string; calendarId?: string }[],
  syncFromRemote: vi.fn(),
}))

// Mock the heavy dependencies that simulateSyncCycle imports dynamically
vi.mock('@/app/stores/use-etebase-store', () => ({
  useEtebaseStore: {
    getState: () => etebaseMock.state,
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
  useCalendarStore: {
    getState: () => ({
      events: calendarStoreMock.events,
      syncFromRemote: (events: { id: string; calendarId?: string }[]) => {
        calendarStoreMock.events = events
        calendarStoreMock.syncFromRemote(events)
      },
    }),
  },
}))

vi.mock('@/app/stores/use-preferences-sync-store', () => ({
  usePreferencesSyncStore: { getState: () => ({ loadFromRemote: vi.fn(), setRemoteItemUid: vi.fn() }) },
}))

vi.mock('@/app/stores/use-label-suggestions-store', () => ({
  useLabelSuggestionsStore: { getState: () => ({ loadFromRemote: vi.fn() }) },
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
  etebaseMock.state.account = null
  etebaseMock.state.syncEngine = null
  etebaseMock.state.reconcileCollections.mockReset().mockResolvedValue(undefined)
  etebaseMock.state.refreshCollection.mockReset().mockResolvedValue([])
  etebaseMock.state.moveItem.mockReset()
  calendarStoreMock.events = []
  calendarStoreMock.syncFromRemote.mockReset()
  useSyncStore.setState({
    syncStatus: 'synced',
    initialSyncState: 'synced',
    initialSyncBlocker: null,
    lastSyncedAt: null,
    isOnline: true,
    error: null,
    pendingQueueCount: 0,
    failedQueueCount: 0,
    initialSyncProgress: {
      active: false,
      phase: 'idle',
      calendar: { loaded: 0, knownTotal: null, done: false },
      tasks: { loaded: 0, knownTotal: null, done: false },
      contacts: { loaded: 0, knownTotal: null, done: false },
      message: null,
    },
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

  it('tracks explicit initial sync state transitions', () => {
    expect(useSyncStore.getState().initialSyncState).toBe('synced')

    useSyncStore.getState().setInitialSyncState('restoring')
    expect(useSyncStore.getState().initialSyncState).toBe('restoring')

    useSyncStore.getState().setInitialSyncState('empty')
    expect(useSyncStore.getState().initialSyncState).toBe('empty')
  })

  it('tracks explicit initial sync blocker transitions', () => {
    expect(useSyncStore.getState().initialSyncBlocker).toBeNull()

    useSyncStore.getState().setInitialSyncBlocker('missing-encrypted-session')
    expect(useSyncStore.getState().initialSyncBlocker).toBe('missing-encrypted-session')

    useSyncStore.getState().setInitialSyncBlocker('encrypted-session-restore-failed')
    expect(useSyncStore.getState().initialSyncBlocker).toBe('encrypted-session-restore-failed')

    useSyncStore.getState().setInitialSyncBlocker(null)
    expect(useSyncStore.getState().initialSyncBlocker).toBeNull()
  })

  it('tracks initial sync progress phases and counts', () => {
    useSyncStore.getState().startInitialSyncProgress({ calendar: 3000 })
    expect(useSyncStore.getState().initialSyncProgress.active).toBe(true)
    expect(useSyncStore.getState().initialSyncProgress.calendar.knownTotal).toBe(3000)

    useSyncStore.getState().setInitialSyncProgressPhase('calendar')
    useSyncStore.getState().updateInitialSyncProgress('calendar', 600, undefined, false)
    expect(useSyncStore.getState().initialSyncProgress.phase).toBe('calendar')
    expect(useSyncStore.getState().initialSyncProgress.calendar.loaded).toBe(600)
    expect(useSyncStore.getState().initialSyncProgress.calendar.done).toBe(false)

    useSyncStore.getState().finishInitialSyncProgress()
    expect(useSyncStore.getState().initialSyncProgress.active).toBe(false)
    expect(useSyncStore.getState().initialSyncProgress.phase).toBe('complete')
    expect(useSyncStore.getState().initialSyncProgress.contacts.done).toBe(true)

    useSyncStore.getState().resetInitialSyncProgress()
    expect(useSyncStore.getState().initialSyncProgress.phase).toBe('idle')
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

  it('reconciles collection deletion from another device before refreshing items', async () => {
    const syncNow = vi.fn().mockResolvedValue(undefined)
    etebaseMock.state.syncEngine = { syncNow }

    useSyncStore.getState().simulateSyncCycle()

    await flushPromises()
    await flushPromises()
    expect(etebaseMock.state.reconcileCollections).toHaveBeenCalledTimes(1)
    expect(syncNow).toHaveBeenCalledTimes(1)
    expect(etebaseMock.state.refreshCollection).toHaveBeenCalledTimes(5)
    expect(etebaseMock.state.refreshCollection).toHaveBeenCalledWith('tasks')
    expect(etebaseMock.state.refreshCollection).toHaveBeenCalledWith('contacts')
    expect(etebaseMock.state.refreshCollection).toHaveBeenCalledWith('calendar')
    expect(etebaseMock.state.refreshCollection).toHaveBeenCalledWith('preferences')
    expect(etebaseMock.state.refreshCollection).toHaveBeenCalledWith('labelIndex')

    const reconcileOrder = etebaseMock.state.reconcileCollections.mock.invocationCallOrder[0]!
    const firstRefreshOrder = etebaseMock.state.refreshCollection.mock.invocationCallOrder[0]!
    expect(reconcileOrder).toBeLessThan(firstRefreshOrder)
  })

  it('replays queued collection moves and remaps the calendar event id', async () => {
    etebaseMock.state.account = {}
    etebaseMock.state.moveItem.mockResolvedValue('item-new')
    calendarStoreMock.events = [{ id: 'item-old', calendarId: 'cal-a' }]
    vi.mocked(getPendingCount).mockResolvedValueOnce(1)
    vi.mocked(replay).mockImplementationOnce(async (executeMutation) => {
      const entry = {
        id: 'queue-1',
        type: 'move' as const,
        collectionType: 'calendar' as const,
        collectionUid: 'cal-a',
        targetCollectionUid: 'cal-b',
        itemUid: 'item-old',
        content: 'VEVENT content',
        createdAt: 1,
        retryCount: 0,
        status: 'pending' as const,
      }
      const result = await executeMutation(entry)
      return [{ entry, success: true, itemUid: result.itemUid }]
    })

    await useSyncStore.getState().replayOfflineQueue()

    expect(etebaseMock.state.moveItem).toHaveBeenCalledWith('calendar', 'item-old', 'VEVENT content', 'cal-b', 'cal-a')
    expect(calendarStoreMock.syncFromRemote).toHaveBeenCalledWith([{ id: 'item-new', calendarId: 'cal-b' }])
  })
})
