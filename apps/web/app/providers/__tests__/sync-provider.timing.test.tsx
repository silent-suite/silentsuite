import { render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncProvider } from '../sync-provider'

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
}))

type DomainKey = 'calendar' | 'tasks' | 'contacts'
type OnDomainLoaded = (event: {
  type: DomainKey
  status: 'loaded' | 'failed'
  itemCount: number
  pageCount: number
  collectionCount: number
}) => void | Promise<void>

const etebaseMock = vi.hoisted(() => {
  let syncChangeHandler: ((event: { collectionType: string; collectionUid: string; itemUids: string[]; changeType: string }) => Promise<void>) | null = null
  // Default initialize replays the real store contract: calendar → tasks →
  // contacts, one terminal callback each, statuses driven by domainLoadState.
  async function defaultInitialize(options?: { onDomainLoaded?: OnDomainLoaded }) {
    order.push('etebaseInitialize')
    for (const type of ['calendar', 'tasks', 'contacts'] as const) {
      const status = state.domainLoadState[type] === 'failed' ? 'failed' : 'loaded'
      await options?.onDomainLoaded?.({ type, status, itemCount: 0, pageCount: 1, collectionCount: 1 })
    }
  }
  const state = {
    initialize: vi.fn(defaultInitialize),
    fetchAllItems: vi.fn(async (type: 'tasks' | 'contacts' | 'calendar') => {
      order.push(`fetchAllItems:${type}`)
      return []
    }),
    onSyncChange: vi.fn((handler?: typeof syncChangeHandler) => {
      order.push('wireChangeHandler')
      syncChangeHandler = handler ?? null
      return vi.fn()
    }),
    onStatusChange: vi.fn(() => {
      order.push('wireStatusHandler')
      return vi.fn()
    }),
    isInitialized: false,
    refreshCollection: vi.fn(),
    domainLoadState: { tasks: 'loaded', contacts: 'loaded', calendar: 'loaded', preferences: 'unknown' },
  }
  return {
    state,
    defaultInitialize,
    getSyncChangeHandler: () => syncChangeHandler,
    setSyncChangeHandler: (handler: typeof syncChangeHandler) => {
      syncChangeHandler = handler
    },
  }
})

const taskStoreMock = vi.hoisted(() => ({ syncFromRemote: vi.fn(() => order.push('syncTasks')) }))
const contactStoreMock = vi.hoisted(() => ({ syncFromRemote: vi.fn(() => order.push('syncContacts')) }))
const calendarStoreMock = vi.hoisted(() => ({ syncFromRemote: vi.fn(() => order.push('syncCalendar')) }))

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

vi.mock('@silentsuite/core', () => ({
  deserializeTask: vi.fn(() => ({ title: 'task' })),
  deserializeContact: vi.fn(() => ({ name: 'contact' })),
  deserializeCalendarEvent: vi.fn(() => ({ title: 'event' })),
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
    etebaseMock.state.domainLoadState = { tasks: 'loaded', contacts: 'loaded', calendar: 'loaded', preferences: 'unknown' }
    etebaseMock.state.initialize.mockImplementation(etebaseMock.defaultInitialize)
    etebaseMock.state.fetchAllItems.mockImplementation(async (type: 'tasks' | 'contacts' | 'calendar') => {
      order.push(`fetchAllItems:${type}`)
      return []
    })
    etebaseMock.state.refreshCollection.mockImplementation(async () => [])
    etebaseMock.state.onSyncChange.mockImplementation((handler?: Parameters<typeof etebaseMock.state.onSyncChange>[0]) => {
      order.push('wireChangeHandler')
      etebaseMock.setSyncChangeHandler(handler ?? null)
      return vi.fn()
    })
    etebaseMock.state.onStatusChange.mockImplementation(() => {
      order.push('wireStatusHandler')
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
    expect(order).toContain('syncCalendar')
    expect(order).not.toContain('syncTasks')

    releaseLater()

    await waitFor(() => expect(syncStoreMock.setLastSynced).toHaveBeenCalledTimes(1))
    expect(taskStoreMock.syncFromRemote).toHaveBeenCalledTimes(1)
    expect(contactStoreMock.syncFromRemote).toHaveBeenCalledTimes(1)
    // Calendar was replaced exactly once, never re-run by a later catch-up pass.
    expect(calendarStoreMock.syncFromRemote).toHaveBeenCalledTimes(1)
  })

  it('keeps calendar and flags partial load when tasks fail after calendar succeeds', async () => {
    etebaseMock.state.domainLoadState = { tasks: 'failed', contacts: 'loaded', calendar: 'loaded', preferences: 'unknown' }
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
    expect(order.filter((entry) => entry === 'syncCalendar')).toHaveLength(1)
  })

  it('hydrates cache only when cache is enabled and still continues startup', async () => {
    cacheMock.isCacheEnabled.mockReturnValue(true)

    renderProvider()

    await waitFor(() => expect(syncStoreMock.setLastSynced).toHaveBeenCalledTimes(1))
    expect(order.slice(0, 6)).toEqual([
      'initializeSync',
      'setSyncStatus:syncing',
      'cacheGet:tasks',
      'cacheGet:contacts',
      'cacheGet:calendar',
      'etebaseInitialize',
    ])
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
    etebaseMock.state.fetchAllItems.mockImplementation(async (type: 'tasks' | 'contacts' | 'calendar') => {
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
    etebaseMock.state.domainLoadState = { tasks: 'loaded', contacts: 'loaded', calendar: 'failed', preferences: 'unknown' }
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
})
