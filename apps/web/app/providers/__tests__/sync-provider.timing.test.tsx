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
}))

const etebaseMock = vi.hoisted(() => {
  const state = {
    initialize: vi.fn(async () => order.push('etebaseInitialize')),
    fetchAllItems: vi.fn(async (type: 'tasks' | 'contacts' | 'calendar') => {
      order.push(`fetchAllItems:${type}`)
      return []
    }),
    onSyncChange: vi.fn(() => {
      order.push('wireChangeHandler')
      return vi.fn()
    }),
    onStatusChange: vi.fn(() => {
      order.push('wireStatusHandler')
      return vi.fn()
    }),
    isInitialized: false,
    refreshCollection: vi.fn(),
  }
  return { state }
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
  useSyncStore: (selector: (state: typeof syncStoreMock) => unknown) => selector(syncStoreMock),
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
    etebaseMock.state.initialize.mockImplementation(async () => order.push('etebaseInitialize'))
    etebaseMock.state.fetchAllItems.mockImplementation(async (type: 'tasks' | 'contacts' | 'calendar') => {
      order.push(`fetchAllItems:${type}`)
      return []
    })
    etebaseMock.state.onSyncChange.mockImplementation(() => {
      order.push('wireChangeHandler')
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

  it('preserves the existing startup order while recording timings', async () => {
    renderProvider()

    await waitFor(() => expect(syncStoreMock.setLastSynced).toHaveBeenCalledTimes(1))

    expect(order).toEqual([
      'initializeSync',
      'setSyncStatus:syncing',
      'etebaseInitialize',
      'fetchAllItems:tasks',
      'fetchAllItems:contacts',
      'fetchAllItems:calendar',
      'wireChangeHandler',
      'wireStatusHandler',
      'setSyncStatus:synced',
      'setLastSynced',
    ])
    expect(timingMock.logSyncTiming).toHaveBeenCalledWith('cache-capability', 100, expect.any(Object))
    expect(timingMock.logSyncTiming).toHaveBeenCalledWith('initial-sync-complete', 100, {})
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
})
