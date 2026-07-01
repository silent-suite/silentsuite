import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { deserializeCalendarEvent, deserializeContact, deserializeTask } from '@silentsuite/core'
import { SyncProvider } from '../sync-provider'
import { useSyncStore } from '@/app/stores/use-sync-store'

const etebase = vi.hoisted(() => ({
  state: {
    initialize: vi.fn(),
    fetchAllItems: vi.fn(),
    loadCollectionItemsIncrementally: vi.fn(),
    refreshCollection: vi.fn(),
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

const taskStore = vi.hoisted(() => ({
  tasks: [] as unknown[],
  syncFromRemote: vi.fn(),
}))

const contactStore = vi.hoisted(() => ({
  contacts: [] as unknown[],
  syncFromRemote: vi.fn(),
}))

const preferencesSyncStore = vi.hoisted(() => ({
  initialize: vi.fn(),
  loadFromRemote: vi.fn(),
  destroy: vi.fn(),
}))

const labelSuggestionsStore = vi.hoisted(() => ({
  initialize: vi.fn(),
  loadFromRemote: vi.fn(),
  destroy: vi.fn(),
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
  useTaskStore: { getState: () => taskStore },
}))

vi.mock('@/app/stores/use-contact-store', () => ({
  useContactStore: { getState: () => contactStore },
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
  usePreferencesSyncStore: { getState: () => preferencesSyncStore },
}))

vi.mock('@/app/stores/use-label-suggestions-store', () => ({
  useLabelSuggestionsStore: { getState: () => labelSuggestionsStore },
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
  beginPassiveStartupToastCycle: vi.fn(),
  endPassiveStartupToastCycle: vi.fn(),
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

function incrementalResult(items: { uid: string; content: string; collectionUid: string }[] = []) {
  return {
    type: 'calendar',
    attemptedCount: items.length,
    decodedCount: items.length,
    decodeFailureCount: 0,
    enumerationErrorCount: 0,
    items,
    collections: [],
    trustworthyForFullReplacement: true,
  }
}

describe('SyncProvider restore recovery blockers', () => {
  beforeEach(() => {
    resetSyncStore()
    calendarStore.events = []
    calendarStore.syncFromRemote.mockClear()
    calendarStore.upsertFromRemote.mockClear()
    taskStore.tasks = []
    taskStore.syncFromRemote.mockClear()
    contactStore.contacts = []
    contactStore.syncFromRemote.mockClear()
    vi.mocked(deserializeCalendarEvent).mockReset().mockImplementation((content) => ({
      id: String(content),
      title: String(content),
      startDate: new Date('2026-01-01T00:00:00Z'),
      endDate: new Date('2026-01-01T01:00:00Z'),
      allDay: false,
      calendarId: 'calendar-1',
    }))
    vi.mocked(deserializeTask).mockReset().mockImplementation((content) => ({
      id: String(content),
      uid: String(content),
      title: String(content),
      completed: false,
      status: 'needs-action',
      percent_complete: 0,
    }))
    vi.mocked(deserializeContact).mockReset().mockImplementation((content) => ({
      id: String(content),
      uid: String(content),
      displayName: String(content),
    }))
    etebase.state.initialize.mockReset().mockResolvedValue({ status: 'success' })
    etebase.state.fetchAllItems.mockReset().mockResolvedValue([])
    etebase.state.loadCollectionItemsIncrementally.mockReset().mockResolvedValue(incrementalResult())
    etebase.state.refreshCollection.mockReset().mockResolvedValue([])
    etebase.state.startSyncEngine.mockReset().mockResolvedValue(undefined)
    etebase.state.onSyncChange.mockClear()
    etebase.state.onStatusChange.mockClear()
    preferencesSyncStore.initialize.mockReset().mockResolvedValue(undefined)
    preferencesSyncStore.loadFromRemote.mockReset().mockResolvedValue(undefined)
    preferencesSyncStore.destroy.mockClear()
    labelSuggestionsStore.initialize.mockReset().mockResolvedValue(undefined)
    labelSuggestionsStore.loadFromRemote.mockReset().mockResolvedValue(undefined)
    labelSuggestionsStore.destroy.mockClear()
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

  it('keeps the app usable and wires recovery when calendar enumeration fails', async () => {
    useSyncStore.setState({ initialSyncBlocker: 'missing-encrypted-session' })
    calendarStore.events = [{ id: 'existing-event', title: 'Existing event' }]
    etebase.state.initialize.mockResolvedValueOnce({ status: 'success' })
    etebase.state.loadCollectionItemsIncrementally.mockRejectedValueOnce(new Error('calendar load failed'))

    render(<SyncProvider><div>content</div></SyncProvider>)

    await waitFor(() => expect(etebase.state.startSyncEngine).toHaveBeenCalledTimes(1))
    expect(useSyncStore.getState().error).toBe('Some synced items could not be loaded')
    expect(useSyncStore.getState().initialSyncState).toBe('synced')
    expect(useSyncStore.getState().initialSyncBlocker).toBeNull()
    expect(useSyncStore.getState().initialSyncProgress.active).toBe(false)
    expect(etebase.state.onSyncChange).toHaveBeenCalledTimes(1)
    expect(etebase.state.onStatusChange).toHaveBeenCalledTimes(1)
    expect(calendarStore.syncFromRemote).not.toHaveBeenCalledWith([])
  })

  it('can recover a degraded calendar after a later SyncEngine change', async () => {
    let syncHandler: ((event: { changeType: string; collectionType: string; collectionUid: string; itemUids: string[] }) => Promise<void>) | null = null
    etebase.state.onSyncChange.mockImplementation((handler) => {
      syncHandler = handler
      return vi.fn()
    })
    etebase.state.initialize.mockResolvedValueOnce({ status: 'success' })
    etebase.state.loadCollectionItemsIncrementally.mockImplementation(async (type: string) => {
      if (type !== 'calendar') return incrementalResult()
      return {
        ...incrementalResult(),
        enumerationErrorCount: 1,
        trustworthyForFullReplacement: false,
      }
    })
    etebase.state.refreshCollection.mockResolvedValueOnce([{ uid: 'event-1', content: 'VEVENT', collectionUid: 'calendar-1' }])
    etebase.state.fetchAllItems.mockResolvedValueOnce([{ uid: 'event-1', content: 'VEVENT', collectionUid: 'calendar-1' }])

    render(<SyncProvider><div>content</div></SyncProvider>)

    await waitFor(() => expect(etebase.state.startSyncEngine).toHaveBeenCalledTimes(1))
    expect(syncHandler).toBeTruthy()
    await syncHandler!({ changeType: 'update', collectionType: 'etebase.vevent', collectionUid: 'calendar-1', itemUids: ['event-1'] })

    expect(calendarStore.syncFromRemote).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'event-1', calendarId: 'calendar-1' }),
    ])
  })

  it('wires SyncEngine when calendar loads but preferences startup fails', async () => {
    etebase.state.initialize.mockResolvedValueOnce({ status: 'success' })
    preferencesSyncStore.initialize.mockRejectedValueOnce(new Error('preferences write failed'))

    render(<SyncProvider><div>content</div></SyncProvider>)

    await waitFor(() => expect(etebase.state.startSyncEngine).toHaveBeenCalledTimes(1))
    expect(etebase.state.onSyncChange).toHaveBeenCalledTimes(1)
    expect(etebase.state.onStatusChange).toHaveBeenCalledTimes(1)
    expect(useSyncStore.getState().initialSyncBlocker).toBeNull()
    expect(useSyncStore.getState().error).toBe('Some synced metadata could not be loaded')
  })

  it('upserts successfully decoded calendar events when enumeration is partial and untrustworthy', async () => {
    const calendarItem = { uid: 'event-1', content: 'VEVENT', collectionUid: 'calendar-1' }
    etebase.state.loadCollectionItemsIncrementally.mockImplementation(async (type: string, options?: { onItems?: (items: typeof calendarItem[], progress: { loaded: number; done: boolean; collectionUid: string }) => Promise<void> | void }) => {
      if (type !== 'calendar') return incrementalResult()
      await options?.onItems?.([calendarItem], { loaded: 1, done: true, collectionUid: 'calendar-1' })
      return {
        ...incrementalResult([calendarItem]),
        enumerationErrorCount: 1,
        trustworthyForFullReplacement: false,
      }
    })

    render(<SyncProvider><div>content</div></SyncProvider>)

    await waitFor(() => expect(calendarStore.upsertFromRemote).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(etebase.state.startSyncEngine).toHaveBeenCalledTimes(1))
    expect(calendarStore.syncFromRemote).not.toHaveBeenCalled()
    expect(calendarStore.upsertFromRemote).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'event-1', calendarId: 'calendar-1' }),
    ])
  })

  it('keeps SyncEngine wired when one calendar item fails to deserialize', async () => {
    const calendarItem = { uid: 'broken-event', content: 'BROKEN', collectionUid: 'calendar-1' }
    vi.mocked(deserializeCalendarEvent).mockImplementationOnce(() => {
      throw new Error('broken calendar item')
    })
    etebase.state.loadCollectionItemsIncrementally.mockImplementation(async (type: string, options?: { onItems?: (items: typeof calendarItem[], progress: { loaded: number; done: boolean; collectionUid: string }) => Promise<void> | void }) => {
      if (type !== 'calendar') return incrementalResult()
      await options?.onItems?.([calendarItem], { loaded: 1, done: true, collectionUid: 'calendar-1' })
      return incrementalResult([calendarItem])
    })

    render(<SyncProvider><div>content</div></SyncProvider>)

    await waitFor(() => expect(etebase.state.startSyncEngine).toHaveBeenCalledTimes(1))
    expect(calendarStore.syncFromRemote).not.toHaveBeenCalled()
    expect(useSyncStore.getState().error).toBe('Some synced items could not be loaded')
  })

  it('merges visible task and contact items instead of full-replacing on partial enumeration', async () => {
    taskStore.tasks = [{ id: 'existing-task', title: 'Existing task' }]
    contactStore.contacts = [{ id: 'existing-contact', displayName: 'Existing contact' }]
    etebase.state.loadCollectionItemsIncrementally.mockImplementation(async (type: string) => {
      if (type === 'tasks') {
        return {
          ...incrementalResult([{ uid: 'task-new', content: 'Task new', collectionUid: 'tasks-1' }]),
          enumerationErrorCount: 1,
          trustworthyForFullReplacement: false,
        }
      }
      if (type === 'contacts') {
        return {
          ...incrementalResult([{ uid: 'contact-new', content: 'Contact new', collectionUid: 'contacts-1' }]),
          enumerationErrorCount: 1,
          trustworthyForFullReplacement: false,
        }
      }
      return incrementalResult()
    })

    render(<SyncProvider><div>content</div></SyncProvider>)

    await waitFor(() => expect(etebase.state.startSyncEngine).toHaveBeenCalledTimes(1))
    expect(taskStore.syncFromRemote).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ id: 'existing-task' }),
      expect.objectContaining({ id: 'task-new', listId: 'tasks-1' }),
    ]))
    expect(contactStore.syncFromRemote).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ id: 'existing-contact' }),
      expect.objectContaining({ id: 'contact-new', listId: 'contacts-1' }),
    ]))
    expect(useSyncStore.getState().error).toBe('Some synced items could not be loaded')
  })
})
