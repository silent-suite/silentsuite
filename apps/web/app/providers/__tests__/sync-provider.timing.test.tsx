import { render, waitFor } from '@testing-library/react'
import { StrictMode, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncProvider } from '../sync-provider'
import { bumpAccountEpoch } from '@/app/lib/account-epoch'

const order: string[] = []

const syncStoreMock = vi.hoisted(() => ({
  initializeSync: vi.fn(() => {
    order.push('initializeSync')
    return vi.fn()
  }),
  setSyncStatus: vi.fn((status: string) => order.push(`setSyncStatus:${status}`)),
  setLastSynced: vi.fn(() => order.push('setLastSynced')),
  setError: vi.fn((error: string | null) => order.push(`setError:${error ?? 'null'}`)),
  setPartialLoad: vi.fn((partial: boolean, count = 0) => order.push(`setPartialLoad:${partial}:${count}`)),
  replayOfflineQueue: vi.fn(async () => 0),
  simulateSyncCycle: vi.fn(() => order.push('simulateSyncCycle')),
}))

type DomainKey = 'calendar' | 'tasks' | 'contacts' | 'notes'
type OnDomainLoaded = (event: {
  type: DomainKey
  status: 'loaded' | 'failed'
  itemCount: number
  pageCount: number
  collectionCount: number
}) => void | Promise<void>
type OnCacheHydrate = () => void | Promise<void>

const etebaseMock = vi.hoisted(() => {
  let syncChangeHandler: ((event: { collectionType: string; collectionUid: string; itemUids: string[]; changeType: string }) => Promise<void>) | null = null
  let syncStatusHandler: ((status: string) => void) | null = null
  // Default initialize replays the real store contract: calendar → tasks →
  // contacts → notes, one terminal callback each, statuses driven by domainLoadState.
  async function defaultInitialize(options?: { onCacheHydrate?: OnCacheHydrate; onDomainLoaded?: OnDomainLoaded }) {
    order.push('etebaseInitialize')
    for (const type of ['calendar', 'tasks', 'contacts', 'notes'] as const) {
      const status = state.domainLoadState[type] === 'failed' ? 'failed' : 'loaded'
      await options?.onDomainLoaded?.({ type, status, itemCount: 0, pageCount: 1, collectionCount: 1 })
    }
  }
  const state = {
    initialize: vi.fn(defaultInitialize),
    fetchAllItems: vi.fn(async (type: DomainKey) => {
      order.push(`fetchAllItems:${type}`)
      return []
    }),
    onSyncChange: vi.fn((handler?: typeof syncChangeHandler) => {
      order.push('wireChangeHandler')
      syncChangeHandler = handler ?? null
      return vi.fn()
    }),
    onStatusChange: vi.fn((handler?: typeof syncStatusHandler) => {
      order.push('wireStatusHandler')
      syncStatusHandler = handler ?? null
      return vi.fn()
    }),
    isInitialized: false,
    refreshCollection: vi.fn(),
    domainLoadState: { tasks: 'loaded', contacts: 'loaded', calendar: 'loaded', notes: 'loaded', preferences: 'unknown' },
  }
  return {
    state,
    defaultInitialize,
    getSyncChangeHandler: () => syncChangeHandler,
    getSyncStatusHandler: () => syncStatusHandler,
    setSyncStatusHandler: (handler: typeof syncStatusHandler) => {
      syncStatusHandler = handler
    },
    setSyncChangeHandler: (handler: typeof syncChangeHandler) => {
      syncChangeHandler = handler
    },
  }
})

const taskStoreMock = vi.hoisted(() => ({ syncFromRemote: vi.fn(() => order.push('syncTasks')) }))
const contactStoreMock = vi.hoisted(() => ({ syncFromRemote: vi.fn(() => order.push('syncContacts')) }))
const calendarStoreMock = vi.hoisted(() => ({ syncFromRemote: vi.fn(() => order.push('syncCalendar')) }))
const noteStoreMock = vi.hoisted(() => ({ syncFromRemote: vi.fn(() => order.push('syncNotes')) }))
const preferencesSyncMock = vi.hoisted(() => ({
  operationGeneration: 7,
  beginRemoteRead: vi.fn(() => 11),
  initialize: vi.fn(async () => {}),
  loadFromRemote: vi.fn(async () => {}),
  recordRemoteReadFailure: vi.fn(),
  destroy: vi.fn(),
}))

const cacheMock = vi.hoisted(() => ({
  getItemsByType: vi.fn(async (type: string) => {
    order.push(`cacheGet:${type}`)
    return []
  }),
  replaceItemsForType: vi.fn(async (type: string) => order.push(`cacheReplace:${type}`)),
  isCacheEnabled: vi.fn(() => false),
  getCacheCapabilityStatus: vi.fn(() => ({
    featureFlagEnabled: false,
    encryptedEnvelopeAvailable: false,
    enabled: false,
  })),
}))

const timingMock = vi.hoisted(() => ({
  logSyncTiming: vi.fn(() => {}),
  markSyncTimingStart: vi.fn(() => 100),
  nowMs: vi.fn(() => 100),
  safeTimingErrorCategory: vi.fn(() => 'unknown'),
}))

const sentryMock = vi.hoisted(() => ({ captureException: vi.fn() }))

vi.mock('@sentry/nextjs', () => sentryMock)

vi.mock('@/app/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/app/lib/privacy-safe-errors', () => ({
  createSafeOperationalError: vi.fn((_component: string, operation: string) => new Error(operation)),
  getSafeErrorDetails: vi.fn(() => ({ name: 'Error' })),
}))

vi.mock('@/app/lib/data-cache', () => cacheMock)
vi.mock('@/app/lib/sync-timing', () => timingMock)

vi.mock('@/app/stores/use-sync-store', () => ({
  useSyncStore: Object.assign(
    (selector: (state: typeof syncStoreMock) => unknown) => selector(syncStoreMock),
    { getState: () => syncStoreMock },
  ),
}))

vi.mock('@/app/stores/use-etebase-store', () => ({
  useEtebaseStore: Object.assign(
    (selector: (state: typeof etebaseMock.state) => unknown) => selector(etebaseMock.state),
    { getState: () => etebaseMock.state },
  ),
  keepPendingCacheRecords: vi.fn(async (_type: string, records: unknown[]) => records),
}))

vi.mock('@/app/stores/use-task-store', () => ({
  useTaskStore: { getState: () => taskStoreMock },
}))

vi.mock('@/app/stores/use-contact-store', () => ({
  useContactStore: { getState: () => contactStoreMock },
}))

vi.mock('@/app/stores/use-calendar-store', () => ({
  useCalendarStore: { getState: () => calendarStoreMock },
}))

vi.mock('@/app/stores/use-note-store', () => ({
  useNoteStore: { getState: () => noteStoreMock, setState: vi.fn() },
}))

vi.mock('@silentsuite/core', () => ({
  deserializeTask: vi.fn(() => ({ title: 'task' })),
  deserializeContact: vi.fn(() => ({ name: 'contact' })),
  deserializeCalendarEvent: vi.fn(() => ({ title: 'event' })),
  deserializeNote: vi.fn(() => ({ title: 'note' })),
  isMarkdownNoteItem: vi.fn(() => true),
  noteFromEtebaseItem: vi.fn((uid: string, content: string) => ({ id: uid, uid, title: 'note', content })),
  serializeNote: vi.fn((note: { title: string; content: string }) => JSON.stringify(note)),
}))

vi.mock('@/app/stores/use-label-suggestions-store', () => ({
  useLabelSuggestionsStore: {
    getState: () => ({ initialize: vi.fn(async () => {}), seedFromVisibleItems: vi.fn(), refreshFromRemote: vi.fn(async () => {}) }),
  },
}))

vi.mock('@/app/stores/use-preferences-sync-store', () => ({
  usePreferencesSyncStore: {
    getState: () => preferencesSyncMock,
  },
}))

function renderProvider() {
  return render(<SyncProvider><div>child</div></SyncProvider>)
}

describe('SyncProvider timing instrumentation', () => {
  beforeEach(() => {
    order.length = 0
    vi.clearAllMocks()
    syncStoreMock.initializeSync.mockImplementation(() => {
      order.push('initializeSync')
      return vi.fn()
    })
    syncStoreMock.setSyncStatus.mockImplementation((status: string) => order.push(`setSyncStatus:${status}`))
    syncStoreMock.setLastSynced.mockImplementation(() => order.push('setLastSynced'))
    syncStoreMock.setError.mockImplementation((error: string | null) => order.push(`setError:${error ?? 'null'}`))
    syncStoreMock.setPartialLoad.mockImplementation((partial: boolean, count = 0) => order.push(`setPartialLoad:${partial}:${count}`))
    syncStoreMock.replayOfflineQueue.mockResolvedValue(0)
    syncStoreMock.simulateSyncCycle.mockClear()
    etebaseMock.state.domainLoadState = { tasks: 'loaded', contacts: 'loaded', calendar: 'loaded', notes: 'loaded', preferences: 'unknown' }
    etebaseMock.state.initialize.mockImplementation(etebaseMock.defaultInitialize)
    etebaseMock.state.fetchAllItems.mockImplementation(async (type: DomainKey) => {
      order.push(`fetchAllItems:${type}`)
      return []
    })
    etebaseMock.state.refreshCollection.mockImplementation(async () => [])
    etebaseMock.state.onSyncChange.mockImplementation((handler?: Parameters<typeof etebaseMock.state.onSyncChange>[0]) => {
      order.push('wireChangeHandler')
      etebaseMock.setSyncChangeHandler(handler ?? null)
      return vi.fn()
    })
    etebaseMock.state.onStatusChange.mockImplementation((handler?: Parameters<typeof etebaseMock.state.onStatusChange>[0]) => {
      order.push('wireStatusHandler')
      etebaseMock.setSyncStatusHandler(handler ?? null)
      return vi.fn()
    })
    cacheMock.isCacheEnabled.mockReturnValue(false)
    cacheMock.getItemsByType.mockImplementation(async (type: string) => {
      order.push(`cacheGet:${type}`)
      return []
    })
    timingMock.logSyncTiming.mockImplementation(() => {})
    timingMock.markSyncTimingStart.mockReturnValue(100)
    timingMock.nowMs.mockReturnValue(100)
  })

  it('publishes provider-owned preference refresher failures for the captured operation', async () => {
    etebaseMock.state.refreshCollection.mockRejectedValueOnce(new Error('transport details'))
    renderProvider()
    await waitFor(() => expect(etebaseMock.getSyncChangeHandler()).not.toBeNull())

    await etebaseMock.getSyncChangeHandler()?.({
      collectionType: 'silentsuite.preferences',
      collectionUid: 'preferences',
      itemUids: [],
      changeType: 'update',
    })

    expect(preferencesSyncMock.recordRemoteReadFailure).toHaveBeenCalledWith(expect.any(Number), 7, 11)
    expect(preferencesSyncMock.loadFromRemote).not.toHaveBeenCalled()
  })

  it('does not reset preference readiness during React Strict Mode effect replay', async () => {
    render(<StrictMode><SyncProvider><div>child</div></SyncProvider></StrictMode>)

    await waitFor(() => expect(preferencesSyncMock.initialize).toHaveBeenCalledTimes(1))
    expect(preferencesSyncMock.destroy).not.toHaveBeenCalled()
  })

  it('loads each domain into its store as the domain callback fires (calendar first)', async () => {
    renderProvider()

    await waitFor(() => expect(syncStoreMock.setLastSynced).toHaveBeenCalledTimes(1))

    expect(order).toEqual([
      'initializeSync',
      'setSyncStatus:syncing',
      'etebaseInitialize',
      'fetchAllItems:calendar',
      'syncCalendar',
      'setPartialLoad:false:0',
      'fetchAllItems:tasks',
      'syncTasks',
      'setPartialLoad:false:0',
      'fetchAllItems:contacts',
      'syncContacts',
      'setPartialLoad:false:0',
      'fetchAllItems:notes',
      'syncNotes',
      'setPartialLoad:false:0',
      'wireChangeHandler',
      'wireStatusHandler',
      'setSyncStatus:synced',
      'setLastSynced',
    ])
    expect(timingMock.logSyncTiming).toHaveBeenCalledWith('cache-capability', 100, expect.any(Object))
    expect(timingMock.logSyncTiming).toHaveBeenCalledWith('initial-sync-complete', 100, {})
  })

  it('paints calendar as soon as its domain callback fires, before delayed tasks/contacts', async () => {
    let releaseLater: () => void = () => {}
    const laterGate = new Promise<void>((resolve) => {
      releaseLater = resolve
    })
    etebaseMock.state.initialize.mockImplementation(async (options?: { onDomainLoaded?: OnDomainLoaded }) => {
      order.push('etebaseInitialize')
      await options?.onDomainLoaded?.({ type: 'calendar', status: 'loaded', itemCount: 1, pageCount: 1, collectionCount: 1 })
      order.push('calendarCallbackDone')
      await laterGate
      await options?.onDomainLoaded?.({ type: 'tasks', status: 'loaded', itemCount: 0, pageCount: 1, collectionCount: 1 })
      await options?.onDomainLoaded?.({ type: 'contacts', status: 'loaded', itemCount: 0, pageCount: 1, collectionCount: 1 })
      await options?.onDomainLoaded?.({ type: 'notes', status: 'loaded', itemCount: 0, pageCount: 1, collectionCount: 1 })
    })
    etebaseMock.state.fetchAllItems.mockImplementation(async (type: DomainKey) => {
      order.push(`fetchAllItems:${type}`)
      if (type === 'calendar') return [{ uid: 'evt-1', content: 'VEVENT', collectionUid: 'cal-1' }]
      return []
    })

    renderProvider()

    // Calendar paints while tasks/contacts are still gated behind laterGate.
    await waitFor(() => expect(calendarStoreMock.syncFromRemote).toHaveBeenCalledTimes(1))
    expect(taskStoreMock.syncFromRemote).not.toHaveBeenCalled()
    expect(contactStoreMock.syncFromRemote).not.toHaveBeenCalled()
    expect(noteStoreMock.syncFromRemote).not.toHaveBeenCalled()
    expect(order).toContain('syncCalendar')
    expect(order).not.toContain('syncTasks')

    releaseLater()

    await waitFor(() => expect(syncStoreMock.setLastSynced).toHaveBeenCalledTimes(1))
    expect(taskStoreMock.syncFromRemote).toHaveBeenCalledTimes(1)
    expect(contactStoreMock.syncFromRemote).toHaveBeenCalledTimes(1)
    expect(noteStoreMock.syncFromRemote).toHaveBeenCalledTimes(1)
    expect(calendarStoreMock.syncFromRemote).toHaveBeenCalledTimes(1)
  })

  it('keeps calendar and flags partial load when tasks fail after calendar succeeds', async () => {
    etebaseMock.state.domainLoadState = { tasks: 'failed', contacts: 'loaded', calendar: 'loaded', notes: 'loaded', preferences: 'unknown' }
    etebaseMock.state.fetchAllItems.mockImplementation(async (type: DomainKey) => {
      order.push(`fetchAllItems:${type}`)
      if (type === 'calendar') return [{ uid: 'evt-1', content: 'VEVENT', collectionUid: 'cal-1' }]
      return []
    })

    renderProvider()

    await waitFor(() => expect(syncStoreMock.setLastSynced).toHaveBeenCalledTimes(1))
    expect(calendarStoreMock.syncFromRemote).toHaveBeenCalledTimes(1)
    expect(taskStoreMock.syncFromRemote).not.toHaveBeenCalled()
    expect(contactStoreMock.syncFromRemote).toHaveBeenCalledTimes(1)
    expect(syncStoreMock.setPartialLoad).toHaveBeenCalledWith(true, 1)
    expect(order).not.toContain('syncTasks')
  })

  it('replaces the calendar store only once during initial load', async () => {
    renderProvider()

    await waitFor(() => expect(syncStoreMock.setLastSynced).toHaveBeenCalledTimes(1))
    expect(calendarStoreMock.syncFromRemote).toHaveBeenCalledTimes(1)
    expect(taskStoreMock.syncFromRemote).toHaveBeenCalledTimes(1)
    expect(contactStoreMock.syncFromRemote).toHaveBeenCalledTimes(1)
    expect(noteStoreMock.syncFromRemote).toHaveBeenCalledTimes(1)
    expect(order.filter((entry) => entry === 'syncCalendar')).toHaveLength(1)
  })

  it('hydrates cache through the verified Etebase callback and still continues startup', async () => {
    cacheMock.isCacheEnabled.mockReturnValue(true)
    etebaseMock.state.initialize.mockImplementation(async (options?: { onCacheHydrate?: OnCacheHydrate; onDomainLoaded?: OnDomainLoaded }) => {
      order.push('etebaseInitialize')
      await options?.onCacheHydrate?.()
      for (const type of ['calendar', 'tasks', 'contacts', 'notes'] as const) {
        await options?.onDomainLoaded?.({ type, status: 'loaded', itemCount: 0, pageCount: 1, collectionCount: 1 })
      }
    })

    renderProvider()

    await waitFor(() => expect(syncStoreMock.setLastSynced).toHaveBeenCalledTimes(1))
    expect(order.slice(0, 8)).toEqual([
      'initializeSync',
      'setSyncStatus:syncing',
      'etebaseInitialize',
      'cacheGet:tasks',
      'cacheGet:contacts',
      'cacheGet:calendar',
      'cacheGet:notes',
      'fetchAllItems:calendar',
    ])
    expect(cacheMock.replaceItemsForType).toHaveBeenCalledWith('calendar', [], expect.any(Number))
    expect(cacheMock.replaceItemsForType).toHaveBeenCalledWith('tasks', [], expect.any(Number))
    expect(cacheMock.replaceItemsForType).toHaveBeenCalledWith('contacts', [], expect.any(Number))
    expect(cacheMock.replaceItemsForType).toHaveBeenCalledWith('notes', [], expect.any(Number))
  })

  it('lets cache hydrate first and then overwrites calendar with server truth', async () => {
    cacheMock.isCacheEnabled.mockReturnValue(true)
    cacheMock.getItemsByType.mockImplementation(async (type: string) => {
      order.push(`cacheGet:${type}`)
      if (type === 'calendar') return [{ itemUid: 'cached-event', collectionUid: 'cal-1', content: 'VCALENDAR:CACHED' }]
      return []
    })
    etebaseMock.state.initialize.mockImplementation(async (options?: { onCacheHydrate?: OnCacheHydrate; onDomainLoaded?: OnDomainLoaded }) => {
      order.push('etebaseInitialize')
      await options?.onCacheHydrate?.()
      await options?.onDomainLoaded?.({ type: 'calendar', status: 'loaded', itemCount: 1, pageCount: 1, collectionCount: 1 })
      await options?.onDomainLoaded?.({ type: 'tasks', status: 'loaded', itemCount: 0, pageCount: 1, collectionCount: 1 })
      await options?.onDomainLoaded?.({ type: 'contacts', status: 'loaded', itemCount: 0, pageCount: 1, collectionCount: 1 })
      await options?.onDomainLoaded?.({ type: 'notes', status: 'loaded', itemCount: 0, pageCount: 1, collectionCount: 1 })
    })
    etebaseMock.state.fetchAllItems.mockImplementation(async (type: DomainKey) => {
      order.push(`fetchAllItems:${type}`)
      if (type === 'calendar') return [{ uid: 'server-event', content: 'VEVENT:SERVER', collectionUid: 'cal-1' }]
      return []
    })

    renderProvider()

    await waitFor(() => expect(syncStoreMock.setLastSynced).toHaveBeenCalledTimes(1))
    expect(order.filter((entry) => entry === 'syncCalendar')).toHaveLength(2)
    expect(order.indexOf('cacheGet:calendar')).toBeLessThan(order.indexOf('fetchAllItems:calendar'))
  })

  it('does not let timing helper failures change sync status flow', async () => {
    timingMock.logSyncTiming.mockImplementation(() => {
      throw new Error('timing broke')
    })

    renderProvider()

    await waitFor(() => expect(syncStoreMock.setLastSynced).toHaveBeenCalledTimes(1))
    expect(syncStoreMock.setSyncStatus).toHaveBeenCalledWith('synced')
    expect(syncStoreMock.setError).not.toHaveBeenCalledWith('Sync initialization failed')
  })

  it('keeps domain load errors non-fatal and completes initialization', async () => {
    etebaseMock.state.fetchAllItems.mockImplementation(async (type: DomainKey) => {
      order.push(`fetchAllItems:${type}`)
      if (type === 'contacts') throw new Error('contact load failed')
      return []
    })

    renderProvider()

    await waitFor(() => expect(syncStoreMock.setLastSynced).toHaveBeenCalledTimes(1))
    expect(syncStoreMock.setSyncStatus).toHaveBeenCalledWith('synced')
    expect(sentryMock.captureException).toHaveBeenCalled()
  })

  it('does not full-replace a failed domain after a scoped change refresh succeeds', async () => {
    renderProvider()

    await waitFor(() => expect(syncStoreMock.setLastSynced).toHaveBeenCalledTimes(1))
    vi.clearAllMocks()
    order.length = 0
    etebaseMock.state.domainLoadState = { tasks: 'loaded', contacts: 'loaded', calendar: 'failed', notes: 'loaded', preferences: 'unknown' }
    etebaseMock.state.refreshCollection.mockImplementation(async () => {
      order.push('refreshCalendarScoped')
      return []
    })

    const handler = etebaseMock.getSyncChangeHandler()
    expect(handler).toBeTruthy()
    await handler!({
      collectionType: 'etebase.vevent',
      collectionUid: 'calendar-one',
      itemUids: ['redacted-item'],
      changeType: 'change',
    })

    expect(etebaseMock.state.refreshCollection).toHaveBeenCalledWith('calendar', 'calendar-one')
    expect(calendarStoreMock.syncFromRemote).not.toHaveBeenCalled()
    expect(syncStoreMock.setPartialLoad).toHaveBeenCalledWith(true, 1)
    expect(order).toContain('refreshCalendarScoped')
    expect(order).not.toContain('syncCalendar')
  })

  it('does not publish an in-flight old-account change after the account epoch changes', async () => {
    renderProvider()

    await waitFor(() => expect(syncStoreMock.setLastSynced).toHaveBeenCalledTimes(1))
    vi.clearAllMocks()
    order.length = 0

    let releaseRefresh!: (items: never[]) => void
    let markRefreshStarted!: () => void
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve
    })
    etebaseMock.state.refreshCollection.mockImplementation(() => {
      markRefreshStarted()
      return new Promise<never[]>((resolve) => {
        releaseRefresh = resolve
      })
    })
    etebaseMock.state.fetchAllItems.mockResolvedValue([
      { uid: 'old-account-event', content: 'VEVENT:OLD', collectionUid: 'old-calendar' },
    ])

    const handler = etebaseMock.getSyncChangeHandler()
    const change = handler!({
      collectionType: 'etebase.vevent',
      collectionUid: 'old-calendar',
      itemUids: ['old-account-event'],
      changeType: 'change',
    })
    await refreshStarted

    bumpAccountEpoch()
    releaseRefresh([])
    await change

    expect(calendarStoreMock.syncFromRemote).not.toHaveBeenCalled()
    expect(syncStoreMock.setLastSynced).not.toHaveBeenCalled()
    expect(sentryMock.captureException).not.toHaveBeenCalled()
  })

  it('ignores status callbacks from an old account epoch', async () => {
    renderProvider()
    await waitFor(() => expect(syncStoreMock.setLastSynced).toHaveBeenCalledTimes(1))

    const statusHandler = etebaseMock.getSyncStatusHandler()
    expect(statusHandler).toBeTruthy()
    vi.clearAllMocks()

    bumpAccountEpoch()
    statusHandler!('error')

    expect(syncStoreMock.setSyncStatus).not.toHaveBeenCalled()
    expect(syncStoreMock.setLastSynced).not.toHaveBeenCalled()
    expect(syncStoreMock.setError).not.toHaveBeenCalled()
  })

  it('does not publish partial-load state after an initialization callback crosses the account boundary', async () => {
    let releaseFetch!: (items: never[]) => void
    let markFetchStarted!: () => void
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve
    })
    let markInitializeFinished!: () => void
    const initializeFinished = new Promise<void>((resolve) => {
      markInitializeFinished = resolve
    })
    etebaseMock.state.fetchAllItems.mockImplementation(() => {
      markFetchStarted()
      return new Promise<never[]>((resolve) => {
        releaseFetch = resolve
      })
    })
    etebaseMock.state.initialize.mockImplementation(async (options) => {
      try {
        await options?.onDomainLoaded?.({
          type: 'calendar',
          status: 'loaded',
          itemCount: 1,
          pageCount: 1,
          collectionCount: 1,
        })
      } finally {
        markInitializeFinished()
      }
    })

    renderProvider()
    await fetchStarted
    vi.clearAllMocks()

    bumpAccountEpoch()
    releaseFetch([])
    await initializeFinished

    expect(syncStoreMock.setPartialLoad).not.toHaveBeenCalled()
    expect(syncStoreMock.setSyncStatus).not.toHaveBeenCalled()
    expect(syncStoreMock.setError).not.toHaveBeenCalled()
  })

  it('suppresses an ordinary initialization rejection after the account epoch changes', async () => {
    let rejectInitialize!: (error: Error) => void
    let markInitializeStarted!: () => void
    const initializeStarted = new Promise<void>((resolve) => {
      markInitializeStarted = resolve
    })
    etebaseMock.state.initialize.mockImplementation(() => {
      markInitializeStarted()
      return new Promise<void>((_resolve, reject) => {
        rejectInitialize = reject
      })
    })

    renderProvider()
    await initializeStarted
    vi.clearAllMocks()

    bumpAccountEpoch()
    rejectInitialize(new Error('old account request failed'))
    await Promise.resolve()
    await Promise.resolve()

    expect(sentryMock.captureException).not.toHaveBeenCalled()
    expect(syncStoreMock.setSyncStatus).not.toHaveBeenCalled()
    expect(syncStoreMock.setError).not.toHaveBeenCalled()
  })
})
