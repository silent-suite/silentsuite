import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useEtebaseStore } from '../use-etebase-store'

// Stub the offline queue so isOfflineError + enqueue don't try to open IndexedDB.
vi.mock('@/app/lib/offline-queue', () => ({
  enqueue: vi.fn(async () => {}),
  isOfflineError: () => false,
}))

vi.mock('@/app/lib/secure-storage', () => ({
  secureGet: vi.fn(async () => null),
  secureSet: vi.fn(async () => {}),
  secureRemove: vi.fn(async () => {}),
  secureClear: vi.fn(async () => {}),
  migrateFromLocalStorage: vi.fn(async () => {}),
}))

vi.mock('@/app/stores/use-toast-store', () => ({
  showErrorToast: vi.fn(),
}))

interface MockItemManager {
  create: ReturnType<typeof vi.fn>
  batch: ReturnType<typeof vi.fn>
}

interface MockSyncEngine {
  pause: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
}

function mockItem(uid: string, content: string, isDeleted = false) {
  return {
    uid,
    isDeleted,
    getContent: vi.fn(async () => content),
  }
}

function setupStoreWithMocks(itemManager: MockItemManager, syncEngine: MockSyncEngine) {
  const collection = { uid: 'col-1' }
  const account = {
    getCollectionManager: () => ({
      getItemManager: () => itemManager,
    }),
  }
  useEtebaseStore.setState({
    account: account as any,
    collections: { calendar: [collection as any], tasks: [], contacts: [] },
    itemCache: new Map(),
    itemTypeMap: new Map(),
    itemCollectionMap: new Map(),
    isInitialized: true,
    syncEngine: syncEngine as any,
  })
}

function setupStoreWithCollections(itemManagerByUid: Record<string, MockItemManager>, syncEngine: MockSyncEngine) {
  const collections = [{ uid: 'col-1' }, { uid: 'col-2' }]
  const account = {
    getCollectionManager: () => ({
      getItemManager: (collection: { uid: string }) => itemManagerByUid[collection.uid],
    }),
  }
  useEtebaseStore.setState({
    account: account as any,
    collections: { calendar: collections as any[], tasks: [], contacts: [] },
    itemCache: new Map(),
    itemTypeMap: new Map(),
    itemCollectionMap: new Map(),
    isInitialized: true,
    syncEngine: syncEngine as any,
  })
}

describe('useEtebaseStore.createItemsBatch', () => {
  beforeEach(() => {
    useEtebaseStore.setState({
      account: null,
      collections: { calendar: [], tasks: [], contacts: [] },
      itemCache: new Map(),
      itemTypeMap: new Map(),
      itemCollectionMap: new Map(),
      isInitialized: false,
      syncEngine: null,
    })
  })

  it('uploads items in batches of 20 (not 50)', async () => {
    let nextUid = 0
    const itemManager: MockItemManager = {
      create: vi.fn(async () => ({ uid: `item-${nextUid++}` })),
      batch: vi.fn(async () => {}),
    }
    const syncEngine: MockSyncEngine = { pause: vi.fn(), resume: vi.fn() }
    setupStoreWithMocks(itemManager, syncEngine)

    const contents = Array.from({ length: 50 }, (_, i) => ({
      content: `c${i}`,
      tempId: `t${i}`,
    }))
    const uids = await useEtebaseStore.getState().createItemsBatch('calendar', contents)

    // 50 items / 20-per-batch = 3 batches (20, 20, 10)
    expect(itemManager.batch).toHaveBeenCalledTimes(3)
    expect(itemManager.batch.mock.calls[0]![0]).toHaveLength(20)
    expect(itemManager.batch.mock.calls[1]![0]).toHaveLength(20)
    expect(itemManager.batch.mock.calls[2]![0]).toHaveLength(10)
    expect(uids.filter((u) => u !== null)).toHaveLength(50)
  })

  it('pauses the sync engine for the duration of the import', async () => {
    const itemManager: MockItemManager = {
      create: vi.fn(async () => ({ uid: 'x' })),
      batch: vi.fn(async () => {}),
    }
    const syncEngine: MockSyncEngine = { pause: vi.fn(), resume: vi.fn() }
    setupStoreWithMocks(itemManager, syncEngine)

    await useEtebaseStore.getState().createItemsBatch('calendar', [
      { content: 'a', tempId: 't1' },
    ])

    expect(syncEngine.pause).toHaveBeenCalledTimes(1)
    expect(syncEngine.resume).toHaveBeenCalledTimes(1)
  })

  it('routes batch creates to the requested collection uid', async () => {
    const firstManager: MockItemManager = {
      create: vi.fn(async () => ({ uid: 'wrong' })),
      batch: vi.fn(async () => {}),
    }
    const secondManager: MockItemManager = {
      create: vi.fn(async () => ({ uid: 'right' })),
      batch: vi.fn(async () => {}),
    }
    const syncEngine: MockSyncEngine = { pause: vi.fn(), resume: vi.fn() }
    setupStoreWithCollections({ 'col-1': firstManager, 'col-2': secondManager }, syncEngine)

    const uids = await useEtebaseStore.getState().createItemsBatch('calendar', [
      { content: 'a', tempId: 't1' },
    ], 'col-2')

    expect(firstManager.create).not.toHaveBeenCalled()
    expect(secondManager.create).toHaveBeenCalledTimes(1)
    expect(uids).toEqual(['right'])
    expect(useEtebaseStore.getState().itemCollectionMap.get('right')).toBe('col-2')
  })

  it('resumes the sync engine even when the import throws', async () => {
    const itemManager: MockItemManager = {
      create: vi.fn(async () => {
        throw new Error('crypto blew up')
      }),
      batch: vi.fn(),
    }
    const syncEngine: MockSyncEngine = { pause: vi.fn(), resume: vi.fn() }
    setupStoreWithMocks(itemManager, syncEngine)

    await useEtebaseStore.getState().createItemsBatch('calendar', [
      { content: 'a', tempId: 't1' },
    ])

    expect(syncEngine.pause).toHaveBeenCalledTimes(1)
    expect(syncEngine.resume).toHaveBeenCalledTimes(1)
  })

  it('retries a transient batch failure with backoff and recovers', async () => {
    let nextUid = 0
    let batchCallCount = 0
    const itemManager: MockItemManager = {
      create: vi.fn(async () => ({ uid: `item-${nextUid++}` })),
      batch: vi.fn(async () => {
        batchCallCount++
        if (batchCallCount === 1) throw new Error('500 server error')
      }),
    }
    const syncEngine: MockSyncEngine = { pause: vi.fn(), resume: vi.fn() }
    setupStoreWithMocks(itemManager, syncEngine)

    vi.useFakeTimers()
    const promise = useEtebaseStore
      .getState()
      .createItemsBatch(
        'calendar',
        Array.from({ length: 5 }, (_, i) => ({ content: `c${i}`, tempId: `t${i}` })),
      )
    // Drain the retry backoff timers (1s) plus the local-crypto + post awaits.
    await vi.runAllTimersAsync()
    const uids = await promise
    vi.useRealTimers()

    expect(itemManager.batch).toHaveBeenCalledTimes(2)
    expect(uids.filter((u) => u !== null)).toHaveLength(5)
  })

  it('returns partial uids and stops when retries are exhausted', async () => {
    let nextUid = 0
    let batchCallCount = 0
    const itemManager: MockItemManager = {
      create: vi.fn(async () => ({ uid: `item-${nextUid++}` })),
      batch: vi.fn(async () => {
        batchCallCount++
        // First batch (items 0-19) succeeds; second batch fails permanently.
        if (batchCallCount === 1) return
        throw new Error('500 server error')
      }),
    }
    const syncEngine: MockSyncEngine = { pause: vi.fn(), resume: vi.fn() }
    setupStoreWithMocks(itemManager, syncEngine)

    vi.useFakeTimers()
    const promise = useEtebaseStore.getState().createItemsBatch(
      'calendar',
      Array.from({ length: 30 }, (_, i) => ({ content: `c${i}`, tempId: `t${i}` })),
    )
    await vi.runAllTimersAsync()
    const uids = await promise
    vi.useRealTimers()

    // First batch (20) succeeded; second batch retried 3 times then gave up.
    expect(itemManager.batch).toHaveBeenCalledTimes(1 + 3)
    expect(uids.slice(0, 20).every((u) => typeof u === 'string')).toBe(true)
    expect(uids.slice(20).every((u) => u === null)).toBe(true)
  })
})

describe('useEtebaseStore.refreshCollection', () => {
  beforeEach(() => {
    useEtebaseStore.setState({
      account: null,
      collections: { calendar: [], tasks: [], contacts: [] },
      itemCache: new Map(),
      itemTypeMap: new Map(),
      itemCollectionMap: new Map(),
      isInitialized: false,
      syncEngine: null,
    })
  })

  it('refreshes one concrete collection without removing same-type items from others', async () => {
    const staleItem = mockItem('old-col-1', 'old calendar')
    const survivorItem = mockItem('keep-col-2', 'other calendar')
    const freshItem = mockItem('new-col-1', 'fresh calendar')
    const collections = [{ uid: 'col-1' }, { uid: 'col-2' }]
    const itemManagers = {
      'col-1': {
        list: vi.fn(async () => ({ data: [freshItem], stoken: null, done: true })),
      },
      'col-2': {
        list: vi.fn(async () => ({ data: [], stoken: null, done: true })),
      },
    }
    const account = {
      getCollectionManager: () => ({
        fetch: vi.fn(async (uid: string) => ({ uid })),
        getItemManager: (collection: { uid: keyof typeof itemManagers }) => itemManagers[collection.uid],
      }),
    }

    useEtebaseStore.setState({
      account: account as any,
      collections: { calendar: collections as any[], tasks: [], contacts: [] },
      itemCache: new Map([
        ['old-col-1', staleItem],
        ['keep-col-2', survivorItem],
      ]),
      itemTypeMap: new Map([
        ['old-col-1', 'calendar'],
        ['keep-col-2', 'calendar'],
      ]),
      itemCollectionMap: new Map([
        ['old-col-1', 'col-1'],
        ['keep-col-2', 'col-2'],
      ]),
      isInitialized: true,
      syncEngine: null,
    })

    const result = await useEtebaseStore.getState().refreshCollection('calendar', 'col-1')
    const state = useEtebaseStore.getState()

    expect(result).toEqual([{ uid: 'new-col-1', content: 'fresh calendar', collectionUid: 'col-1' }])
    expect(state.itemCache.has('old-col-1')).toBe(false)
    expect(state.itemCache.get('new-col-1')).toBe(freshItem)
    expect(state.itemCollectionMap.get('new-col-1')).toBe('col-1')
    expect(state.itemCache.get('keep-col-2')).toBe(survivorItem)
    expect(state.itemCollectionMap.get('keep-col-2')).toBe('col-2')
    expect(itemManagers['col-2'].list).not.toHaveBeenCalled()
  })

  it('preserves and returns existing items when a network refresh fails', async () => {
    const existingItem = mockItem('existing', 'existing calendar')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const account = {
      getCollectionManager: () => ({
        fetch: vi.fn(async () => {
          throw new Error('network down')
        }),
      }),
    }

    useEtebaseStore.setState({
      account: account as any,
      collections: { calendar: [{ uid: 'col-1' }] as any[], tasks: [], contacts: [] },
      itemCache: new Map([['existing', existingItem]]),
      itemTypeMap: new Map([['existing', 'calendar']]),
      itemCollectionMap: new Map([['existing', 'col-1']]),
      isInitialized: true,
      syncEngine: null,
    })

    const result = await useEtebaseStore.getState().refreshCollection('calendar')
    const state = useEtebaseStore.getState()

    expect(result).toEqual([{ uid: 'existing', content: 'existing calendar', collectionUid: 'col-1' }])
    expect(state.itemCache.get('existing')).toBe(existingItem)
    expect(state.itemCollectionMap.get('existing')).toBe('col-1')
    errorSpy.mockRestore()
  })
})
