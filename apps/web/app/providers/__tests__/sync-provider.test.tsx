import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { SyncProvider } from '../sync-provider'
import { useSyncStore } from '@/app/stores/use-sync-store'

const etebase = vi.hoisted(() => ({
  state: {
    initialize: vi.fn(),
    fetchAllItems: vi.fn(),
    loadCollectionItemsIncrementally: vi.fn(),
    startSyncEngine: vi.fn(),
    onSyncChange: vi.fn(() => vi.fn()),
    onStatusChange: vi.fn(() => vi.fn()),
    isInitialized: false,
  },
}))

const calendarStore = vi.hoisted(() => ({
  events: [] as unknown[],
  syncFromRemote: vi.fn(),
  upsertFromRemote: vi.fn(),
}))

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}))

vi.mock('@/app/stores/use-etebase-store', () => ({
  useEtebaseStore: Object.assign(
    (selector: (state: typeof etebase.state) => unknown) => selector(etebase.state),
    { getState: () => etebase.state },
  ),
}))

vi.mock('@/app/stores/use-task-store', () => ({
  useTaskStore: { getState: () => ({ tasks: [], syncFromRemote: vi.fn() }) },
}))

vi.mock('@/app/stores/use-contact-store', () => ({
  useContactStore: { getState: () => ({ contacts: [], syncFromRemote: vi.fn() }) },
}))

vi.mock('@/app/stores/use-calendar-store', () => ({
  useCalendarStore: {
    getState: () => ({
      events: calendarStore.events,
      syncFromRemote: calendarStore.syncFromRemote,
      upsertFromRemote: calendarStore.upsertFromRemote,
    }),
  },
}))

vi.mock('@/app/stores/use-preferences-sync-store', () => ({
  usePreferencesSyncStore: { getState: () => ({ initialize: vi.fn(), loadFromRemote: vi.fn(), destroy: vi.fn() }) },
}))

vi.mock('@/app/stores/use-label-suggestions-store', () => ({
  useLabelSuggestionsStore: { getState: () => ({ initialize: vi.fn(), loadFromRemote: vi.fn(), destroy: vi.fn() }) },
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

vi.mock('@/app/lib/data-cache', () => ({
  getItemsByType: vi.fn().mockResolvedValue([]),
  replaceItemsForType: vi.fn().mockResolvedValue(undefined),
  isCacheEnabled: vi.fn(() => false),
  getCacheCapabilityStatus: vi.fn(() => ({ enabled: false })),
}))

vi.mock('@/app/lib/sync-timing', () => ({
  logSyncTiming: vi.fn(),
  markCalendarSyncStart: vi.fn(() => 0),
  nowMs: vi.fn(() => 0),
}))

vi.mock('@/app/lib/privacy-safe-errors', () => ({
  createSafeOperationalError: vi.fn((component: string, operation: string) => new Error(`${component}:${operation}`)),
  getSafeErrorDetails: vi.fn(() => ({ message: 'safe error' })),
}))

vi.mock('@/app/lib/calendar-loading', () => ({
  partitionCalendarItemsForFastPaint: vi.fn((items: unknown[]) => ({ priority: items, backlog: [] })),
}))

vi.mock('@silentsuite/core', () => ({
  deserializeCalendarEvent: vi.fn(),
  deserializeTask: vi.fn(),
  deserializeContact: vi.fn(),
}))

function resetSyncStore() {
  useSyncStore.setState({
    syncStatus: 'synced',
    initialSyncState: 'synced',
    initialSyncBlocker: null,
    lastSyncedAt: null,
    isOnline: true,
    error: null,
    pendingQueueCount: 0,
    failedQueueCount: 0,
  })
}

describe('SyncProvider restore recovery blockers', () => {
  beforeEach(() => {
    resetSyncStore()
    calendarStore.events = []
    calendarStore.syncFromRemote.mockClear()
    calendarStore.upsertFromRemote.mockClear()
    etebase.state.initialize.mockReset().mockResolvedValue({ status: 'success' })
    etebase.state.fetchAllItems.mockReset().mockResolvedValue([])
    etebase.state.loadCollectionItemsIncrementally.mockReset().mockResolvedValue([])
    etebase.state.startSyncEngine.mockReset().mockResolvedValue(undefined)
    etebase.state.onSyncChange.mockClear()
    etebase.state.onStatusChange.mockClear()
  })

  it('sets the recovery blocker for a missing encrypted session', async () => {
    etebase.state.initialize.mockResolvedValueOnce({ status: 'no-session' })

    render(<SyncProvider><div>content</div></SyncProvider>)

    await waitFor(() => expect(useSyncStore.getState().initialSyncBlocker).toBe('missing-encrypted-session'))
    expect(useSyncStore.getState().initialSyncState).toBe('no-session')
    expect(useSyncStore.getState().syncStatus).toBe('error')
  })

  it('sets the recovery blocker for a restore failure', async () => {
    etebase.state.initialize.mockResolvedValueOnce({ status: 'error', error: new Error('restore failed') })

    render(<SyncProvider><div>content</div></SyncProvider>)

    await waitFor(() => expect(useSyncStore.getState().initialSyncBlocker).toBe('encrypted-session-restore-failed'))
    expect(useSyncStore.getState().initialSyncState).toBe('error')
  })

  it('does not set a recovery blocker when restore reports offline', async () => {
    etebase.state.initialize.mockResolvedValueOnce({ status: 'offline' })

    render(<SyncProvider><div>content</div></SyncProvider>)

    await waitFor(() => expect(useSyncStore.getState().initialSyncState).toBe('offline'))
    expect(useSyncStore.getState().initialSyncBlocker).toBeNull()
    expect(useSyncStore.getState().syncStatus).toBe('offline')
  })

  it('keeps the app usable and clears the recovery blocker for post-restore load errors', async () => {
    useSyncStore.setState({ initialSyncBlocker: 'missing-encrypted-session' })
    etebase.state.initialize.mockResolvedValueOnce({ status: 'success' })
    etebase.state.loadCollectionItemsIncrementally.mockRejectedValueOnce(new Error('calendar load failed'))

    render(<SyncProvider><div>content</div></SyncProvider>)

    await waitFor(() => expect(useSyncStore.getState().error).toBe('Some synced items could not be loaded'))
    expect(useSyncStore.getState().initialSyncState).toBe('empty')
    expect(useSyncStore.getState().initialSyncBlocker).toBeNull()
    expect(useSyncStore.getState().initialSyncProgress.active).toBe(false)
  })
})
