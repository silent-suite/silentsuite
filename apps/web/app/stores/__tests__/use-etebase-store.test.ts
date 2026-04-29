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

function setupStoreWithMocks(itemManager: MockItemManager, syncEngine: MockSyncEngine) {
  const collection = { uid: 'col-1' }
  const account = {
    getCollectionManager: () => ({
      getItemManager: () => itemManager,
    }),
  }
  useEtebaseStore.setState({
    account: account as any,
    collections: { calendar: collection as any, tasks: null, contacts: null },
    itemCache: new Map(),
    itemTypeMap: new Map(),
    isInitialized: true,
    syncEngine: syncEngine as any,
  })
}

describe('useEtebaseStore.createItemsBatch', () => {
  beforeEach(() => {
    useEtebaseStore.setState({
      account: null,
      collections: { calendar: null, tasks: null, contacts: null },
      itemCache: new Map(),
      itemTypeMap: new Map(),
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
