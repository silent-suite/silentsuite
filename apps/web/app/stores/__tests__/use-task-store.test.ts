// @vitest-environment node
// The pinned Etebase SDK and libsodium reject byte arrays from the jsdom realm, so this file
// runs in node like the web744 suites; navigator.onLine keeps the browser's online default.
import { afterAll, afterEach, describe, it, expect, beforeEach, vi } from 'vitest'
import { deserializeTask, taskICalDateFromProperty } from '@silentsuite/core'
import { useTaskStore } from '../use-task-store'
import { useEtebaseStore } from '../use-etebase-store'
import { useAuthStore } from '../use-auth-store'
import { _setEncryptedQueuePersistenceAvailableForTests, getAll } from '@/app/lib/offline-queue'
import { TEST_FINGERPRINT, bumpEpochWhenQueuePutRuns, enqueueCreateFromStore, expectOwnedQueueEntry, expectQuietQueueCommitCancellation, queueGuard, replayOwnedEntry, resetRealOfflineQueue } from './offline-queue-store-test-utils'
import { EtebaseRequest, ReferenceServer, makeSavedNote } from './web744-sdk-fixture'

// Set before any module reads it; restored after the file.
const onLineDescriptor = vi.hoisted(() => {
  const original = Object.getOwnPropertyDescriptor(globalThis.navigator, 'onLine')
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, get: () => true })
  return original
})
afterAll(() => {
  if (onLineDescriptor) Object.defineProperty(globalThis.navigator, 'onLine', onLineDescriptor)
  else delete (globalThis.navigator as any).onLine
})

const toastMock = vi.hoisted(() => ({ showErrorToast: vi.fn() }))
vi.mock('@/app/stores/use-toast-store', () => toastMock)

// Mock the sync store to prevent side effects
vi.mock('@/app/stores/use-sync-store', () => ({
  useSyncStore: {
    getState: () => ({
      isOnline: false,
      simulateSyncCycle: vi.fn(),
    }),
  },
}))

function resetStore() {
  useTaskStore.setState({
    tasks: [],
    syncStatus: 'synced',
  })
  useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
  // Writable account, as these tests assumed under jsdom; pinned so the node realm cannot change it.
  useAuthStore.setState({ canWrite: () => true } as any)
}

function offlineAccount() {
  useEtebaseStore.setState({ account: {}, accountFingerprint: TEST_FINGERPRINT, itemCache: new Map(), createItem: vi.fn((type, content, tempId, collectionUid) => enqueueCreateFromStore(type, collectionUid, content, tempId!)) } as any)
}

/** The lower store acknowledging every create, update and delete, as a reachable account does. */
function acknowledgedAccount() {
  let sequence = 0
  const createItem = vi.fn(async () => {
    const uid = `remote-task-${++sequence}`
    useEtebaseStore.setState({ itemCache: new Map([...useEtebaseStore.getState().itemCache, [uid, {}]]) } as any)
    return uid
  })
  const updateItem = vi.fn(async () => 'remote')
  const deleteItem = vi.fn(async () => 'remote')
  useEtebaseStore.setState({ account: {}, accountFingerprint: TEST_FINGERPRINT, itemCache: new Map(), createItem, updateItem, deleteItem } as any)
  return { createItem, updateItem, deleteItem }
}

function queuedTask(id = 'temp-task') {
  return { id, uid: id, title: 'Task', description: '', start_date: null, due_date: null, priority: 'medium' as const, completed: false, status: 'needs-action' as const, percent_complete: 0, location: '', url: '', categories: [], listId: 'tasks-1', created_at: new Date(), updated_at: new Date() }
}

describe('useTaskStore', () => {
  beforeEach(() => {
    resetStore()
  })

  it('createTask adds a task to the store', async () => {
    acknowledgedAccount()
    const { createTask } = useTaskStore.getState()
    const task = await createTask({ title: 'Test task', priority: 'high' })

    const { tasks } = useTaskStore.getState()
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.title).toBe('Test task')
    expect(tasks[0]!.priority).toBe('high')
    expect(tasks[0]!.completed).toBe(false)
    expect(task.id).toBeDefined()
  })

  it('updateTask modifies an existing task', async () => {
    acknowledgedAccount()
    const { createTask } = useTaskStore.getState()
    const task = await createTask({ title: 'Original' })

    const { updateTask } = useTaskStore.getState()
    await updateTask(task.id, { title: 'Updated' })

    const { tasks } = useTaskStore.getState()
    expect(tasks[0]!.title).toBe('Updated')
  })

  it('updateTask does nothing for unknown id', async () => {
    acknowledgedAccount()
    const { createTask } = useTaskStore.getState()
    await createTask({ title: 'Only task' })

    const { updateTask } = useTaskStore.getState()
    await updateTask('nonexistent', { title: 'Ghost' })

    const { tasks } = useTaskStore.getState()
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.title).toBe('Only task')
  })

  it('deleteTask removes a task', async () => {
    acknowledgedAccount()
    const { createTask } = useTaskStore.getState()
    const task = await createTask({ title: 'To delete' })

    const { deleteTask } = useTaskStore.getState()
    await deleteTask(task.id)

    const { tasks } = useTaskStore.getState()
    expect(tasks).toHaveLength(0)
  })

  it('toggleComplete flips completion state', async () => {
    acknowledgedAccount()
    const { createTask } = useTaskStore.getState()
    const task = await createTask({ title: 'Toggle me' })
    expect(task.completed).toBe(false)

    const { toggleComplete } = useTaskStore.getState()
    await toggleComplete(task.id)

    let { tasks } = useTaskStore.getState()
    expect(tasks[0]!.completed).toBe(true)

    await useTaskStore.getState().toggleComplete(task.id)
    ;({ tasks } = useTaskStore.getState())
    expect(tasks[0]!.completed).toBe(false)
  })

  it('keeps the VTODO UID stable after replacing the local id with the Etebase item id', async () => {
    const createItem = vi.fn(async () => 'remote-task-item')
    const updateItem = vi.fn(async () => {})
    useEtebaseStore.setState({
      account: {},
      createItem,
      updateItem,
    } as any)

    const task = await useTaskStore.getState().createTask({ title: 'Sync me' })

    expect(task.id).toBe('remote-task-item')
    expect(task.uid).not.toBe('remote-task-item')
    expect(createItem.mock.calls[0]![1]).toContain(`UID:${task.uid}`)

    useEtebaseStore.setState({
      itemCache: new Map([['remote-task-item', {}]]),
    } as any)

    await useTaskStore.getState().toggleComplete('remote-task-item')

    const updatedContent = updateItem.mock.calls[0]![2] as string
    expect(updatedContent).toContain(`UID:${task.uid}`)
    expect(updatedContent).toContain('STATUS:COMPLETED')
    expect(updatedContent).toContain('PERCENT-COMPLETE:100')
  })

  const startLine = 'DTSTART;TZID=Europe/Berlin:20260530T080000'
  const dueLine = 'DUE;TZID=America/New_York:20260601T090000'
  const temporalLines = (content: string) => content.split('\r\n').filter((line) => line.startsWith('DTSTART') || line.startsWith('DUE'))

  /** A task another client wrote with zoned DTSTART and DUE, hydrated the way sync does. */
  function hydrateZonedTask() {
    const synced = deserializeTask([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Other Client//EN',
      'BEGIN:VTODO',
      'UID:synced-zoned-task',
      'SUMMARY:Zoned task',
      startLine,
      dueLine,
      'STATUS:NEEDS-ACTION',
      'END:VTODO',
      'END:VCALENDAR',
    ].join('\r\n'))
    const updateItem = vi.fn(async (_type: string, _id: string, _content: string) => {})
    useEtebaseStore.setState({
      account: {},
      itemCache: new Map([['synced-item', {}]]),
      updateItem,
    } as any)
    useTaskStore.setState({ tasks: [{ ...synced, id: 'synced-item', listId: 'tasks-1' }] })
    return { updateItem, savedContent: (call: number) => updateItem.mock.calls[call]![2] }
  }

  it('an explicit due date pick replaces the zoned DUE with the picked local day and keeps DTSTART (#66)', async () => {
    const { savedContent } = hydrateZonedTask()

    await useTaskStore.getState().updateTask('synced-item', { due_date: new Date(2026, 5, 3) })

    expect(temporalLines(savedContent(0))).toEqual([startLine, 'DUE;VALUE=DATE:20260603'])
  })

  it('an explicit start date pick replaces only the zoned DTSTART (#66)', async () => {
    const { savedContent } = hydrateZonedTask()

    await useTaskStore.getState().updateTask('synced-item', { start_date: new Date(2026, 4, 29) })

    expect(temporalLines(savedContent(0))).toEqual(['DTSTART;VALUE=DATE:20260529', dueLine])
  })

  it('clearing the due date removes DUE and keeps DTSTART (#66)', async () => {
    const { savedContent } = hydrateZonedTask()

    await useTaskStore.getState().updateTask('synced-item', { due_date: null })

    expect(temporalLines(savedContent(0))).toEqual([startLine])
    expect(useTaskStore.getState().tasks[0]!.due_ical).toBeUndefined()
  })

  it('createTask and importTasks write supplied DTSTART and DUE sources (#66)', async () => {
    const start = taskICalDateFromProperty('20260530T080000', { TZID: 'Europe/Berlin' })
    const due = taskICalDateFromProperty('20260601T090000Z')
    const zoned = { start_date: start.date, start_ical: start.source, due_date: due.date, due_ical: due.source }
    const { createItem } = acknowledgedAccount()
    const createItemsBatch = vi.fn(async (_type: string, items: { content: string }[]) => items.map((_, index) => `remote-import-${index}`))
    useEtebaseStore.setState({ createItemsBatch } as any)

    await useTaskStore.getState().createTask({ title: 'Created zoned', ...zoned })
    await useTaskStore.getState().importTasks([{ title: 'Imported zoned', ...zoned }])

    const expected = [startLine, 'DUE:20260601T090000Z']
    expect(temporalLines(createItem.mock.calls[0]![1] as string)).toEqual(expected)
    expect(temporalLines(createItemsBatch.mock.calls[0]![1][0]!.content)).toEqual(expected)
  })

  it('keeps synced DTSTART and DUE time zones through title and completion updates (#66)', async () => {
    const { updateItem } = hydrateZonedTask()

    await useTaskStore.getState().updateTask('synced-item', { title: 'Renamed zoned task' })
    await useTaskStore.getState().toggleComplete('synced-item')

    expect(updateItem).toHaveBeenCalledTimes(2)
    const savedLines = updateItem.mock.calls.map((call) => call[2].split('\r\n'))
    expect(savedLines[0]).toContain('SUMMARY:Renamed zoned task')
    expect(savedLines[1]).toContain('STATUS:COMPLETED')
    for (const lines of savedLines) {
      expect(lines.filter((line) => line.startsWith('DTSTART') || line.startsWith('DUE'))).toEqual([startLine, dueLine])
    }
  })

  it('preserves completed state during task import', async () => {
    // Every record acknowledged, as an import that succeeds.
    const createItemsBatch = vi.fn(async (_type: string, items: { tempId: string }[]) => items.map((_, index) => `remote-task-${index}`))
    useEtebaseStore.setState({ account: {}, accountFingerprint: TEST_FINGERPRINT, createItemsBatch } as any)
    await useTaskStore.getState().importTasks([
      { title: 'Already done', completed: true },
      { title: 'Still open', completed: false },
    ])

    const { tasks } = useTaskStore.getState()
    expect(tasks).toHaveLength(2)
    expect(tasks[0]!.completed).toBe(true)
    expect(tasks[1]!.completed).toBe(false)
  })

  describe('guarded offline queue integration', () => {
    beforeEach(async () => { await resetRealOfflineQueue(); resetStore(); offlineAccount(); toastMock.showErrorToast.mockReset() })

    it.each([
      ['create', 'create', async () => { await useTaskStore.getState().createTask({ title: 'Create', listId: 'tasks-1' }) }],
      ['update', 'update', async () => { useTaskStore.setState({ tasks: [queuedTask()] }); await useTaskStore.getState().updateTask('temp-task', { title: 'Update' }) }],
      ['delete', 'delete', async () => { useTaskStore.setState({ tasks: [queuedTask()] }); await useTaskStore.getState().deleteTask('temp-task') }],
      ['toggleComplete', 'update', async () => { useTaskStore.setState({ tasks: [queuedTask()] }); await useTaskStore.getState().toggleComplete('temp-task') }],
    ] as const)('%s persists and replays an owned offline mutation', async (_operation, type, mutate) => {
      await mutate()
      const entry = await expectOwnedQueueEntry(type, 'tasks')
      await replayOwnedEntry(entry)
    })

    it('quietly cancels at the real enqueue boundary', async () => {
      useTaskStore.setState({ tasks: [queuedTask()] })
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const putSpy = bumpEpochWhenQueuePutRuns(() => { useEtebaseStore.setState({ account: {}, accountFingerprint: 'new-account' } as any); useTaskStore.setState({ tasks: [] }) })
      await expect(useTaskStore.getState().updateTask('temp-task', { title: 'Stale' })).resolves.toBeUndefined()
      putSpy.mockRestore()
      await vi.waitFor(() => expect(useTaskStore.getState().tasks).toEqual([]))
      expect(await getAll(queueGuard('new-account'))).toEqual([])
      expect(await getAll()).toEqual([])
      expect(errorSpy).not.toHaveBeenCalled()
      expect(toastMock.showErrorToast).not.toHaveBeenCalled()
      errorSpy.mockRestore()
    })

    it('quietly cancels an uncached delete at the actual IndexedDB commit boundary', async () => {
      useTaskStore.setState({ tasks: [queuedTask()] })
      await expectQuietQueueCommitCancellation(
        () => useTaskStore.getState().deleteTask('temp-task'),
        () => { useEtebaseStore.setState({ account: {}, accountFingerprint: 'new-account' } as any); useTaskStore.setState({ tasks: [] }) },
        () => expect(useTaskStore.getState().tasks).toEqual([]),
        toastMock,
      )
    })

    it('quietly cancels an uncached toggle at the actual IndexedDB commit boundary', async () => {
      useTaskStore.setState({ tasks: [queuedTask()] })
      await expectQuietQueueCommitCancellation(
        () => useTaskStore.getState().toggleComplete('temp-task'),
        () => { useEtebaseStore.setState({ account: {}, accountFingerprint: 'new-account' } as any); useTaskStore.setState({ tasks: [] }) },
        () => expect(useTaskStore.getState().tasks).toEqual([]),
        toastMock,
      )
    })
  })
})

// C3a import-store contract (PLAN §4, §7 R1–R4, R3b, R3c). The real bridge drives the pinned,
// patched Etebase SDK against the reference server. Item batch requests are numbered and
// logged at the transport, so each case proves which chunk was applied before its outcome is read.
type ChunkFault = { chunk: number; kind: 'offline-before-apply' | 'refused' | 'response-lost' }

const isItemBatch = (method: string, path: string) => method === 'post' && /(^|\/)item\/batch$/.test(path)
const originalRequest = EtebaseRequest.default

async function installReferenceAccount(collectionType: string, fault?: ChunkFault) {
  const server = new ReferenceServer()
  const { account } = await makeSavedNote('C3a store contract', '')
  const collection = await account.getCollectionManager().create(collectionType, { name: 'C3a', mtime: 1 }, '')
  collection.encryptedCollection.__markSaved()
  server.seed(collection, [])
  const batches: string[] = []
  EtebaseRequest.default = async (url: string, options: any = {}) => {
    const method = String(options.method ?? 'get').toLowerCase()
    const path = new URL(url).pathname.split('/').filter(Boolean).join('/')
    if (!isItemBatch(method, path)) return server.handle(url, options)
    const request = batches.length + 1
    if (fault?.kind === 'offline-before-apply' && request === fault.chunk) {
      batches.push('network-failure')
      throw new TypeError('Network request failed')
    }
    if (fault?.kind === 'refused' && request >= fault.chunk) {
      // An unregistered route: the reference server answers 500 and leaves the collection as it is.
      const response = await server.handle(url.replace(/item\/batch\/?/, 'item/refused/'), options)
      batches.push(`status-${response.status}`)
      return response
    }
    const response = await server.handle(url, options)
    if (fault?.kind === 'response-lost' && request === fault.chunk) {
      batches.push('applied-response-lost')
      throw new TypeError('Network request failed')
    }
    batches.push(response.ok ? 'acknowledged' : `status-${response.status}`)
    return response
  }
  useEtebaseStore.setState({
    account,
    accountFingerprint: TEST_FINGERPRINT,
    collections: { calendar: [], tasks: [collection], contacts: [], notes: [], preferences: [] },
    itemCache: new Map(),
    itemTypeMap: new Map(),
    itemCollectionMap: new Map(),
    domainLoadState: { calendar: 'loaded', tasks: 'loaded', contacts: 'loaded', notes: 'loaded', preferences: 'unknown' },
    isInitialized: true,
    syncEngine: null,
  } as any)
  const serverItems = async (): Promise<any[]> =>
    (await account.getCollectionManager().getItemManager(collection).list()).data.filter((item: any) => !item.isDeleted)
  return { collection, batches, serverItems }
}

const settle = <T>(promise: Promise<T>) => promise.then((value) => ({ resolved: value }), (error: unknown) => ({ rejected: error }))
const positions = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => from + index)

const importContractCases: {
  id: string
  label: string
  setup: 'reference' | 'missing-collection' | 'no-account'
  count: number
  fault?: ChunkFault
  batches: string[]
  serverCount: number
  saved: number
  unsaved: number[]
  uncertain: boolean
}[] = [
  { id: 'C3a-R1', label: 'missing collection', setup: 'missing-collection', count: 2, batches: [], serverCount: 0, saved: 0, unsaved: [0, 1], uncertain: true },
  { id: 'C3a-R2', label: 'offline before the first chunk is applied', setup: 'reference', count: 2, fault: { chunk: 1, kind: 'offline-before-apply' }, batches: ['network-failure'], serverCount: 0, saved: 0, unsaved: [0, 1], uncertain: true },
  { id: 'C3a-R3', label: 'server refuses the second chunk', setup: 'reference', count: 21, fault: { chunk: 2, kind: 'refused' }, batches: ['acknowledged', 'status-500', 'status-500', 'status-500'], serverCount: 20, saved: 20, unsaved: [20], uncertain: true },
  { id: 'C3a-R3b', label: 'offline before the second chunk is applied', setup: 'reference', count: 25, fault: { chunk: 2, kind: 'offline-before-apply' }, batches: ['acknowledged', 'network-failure'], serverCount: 20, saved: 20, unsaved: positions(20, 25), uncertain: true },
  { id: 'C3a-R3c', label: 'second chunk applied but its response lost', setup: 'reference', count: 25, fault: { chunk: 2, kind: 'response-lost' }, batches: ['acknowledged', 'applied-response-lost'], serverCount: 25, saved: 20, unsaved: positions(20, 25), uncertain: true },
  { id: 'C3a-R4', label: 'no account', setup: 'no-account', count: 2, batches: [], serverCount: 0, saved: 0, unsaved: [0, 1], uncertain: false },
]

describe('C3a import-store contract: importTasks', () => {
  beforeEach(async () => {
    await resetRealOfflineQueue()
    // Production queue configuration: plaintext create content is refused.
    _setEncryptedQueuePersistenceAvailableForTests(false)
    resetStore()
    toastMock.showErrorToast.mockReset()
  })

  afterEach(() => {
    EtebaseRequest.default = originalRequest
  })

  it.each(importContractCases)('$id tasks: $label reports only acknowledged tasks and keeps no unacknowledged temp', async (c) => {
    let reference: Awaited<ReturnType<typeof installReferenceAccount>> | null = null
    if (c.setup === 'reference') reference = await installReferenceAccount('etebase.vtodo', c.fault)
    if (c.setup === 'missing-collection') {
      useEtebaseStore.setState({ account: {}, accountFingerprint: TEST_FINGERPRINT, collections: { calendar: [], tasks: [], contacts: [], notes: [], preferences: [] } } as any)
    }
    const listId = reference?.collection.uid ?? 'missing-task-list'
    const inputs = Array.from({ length: c.count }, (_, index) => ({ title: `C3a task ${index}`, listId }))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const outcome = await settle(useTaskStore.getState().importTasks(inputs))

      // Fixture proof: which chunks reached and were applied by the server, and an empty production queue.
      expect(reference?.batches ?? []).toEqual(c.batches)
      const serverItems = reference ? await reference.serverItems() : []
      expect(serverItems).toHaveLength(c.serverCount)
      expect(await getAll(queueGuard())).toEqual([])

      // Contract: never the requested count; only acknowledged positions are saved.
      expect(outcome).toMatchObject({ rejected: { name: 'ImportIncompleteError', saved: c.saved, unsaved: c.unsaved, uncertain: c.uncertain } })

      // Settlement: acknowledged tasks carry server item ids and keep their own VTODO UID; no temp remains.
      const tasks = useTaskStore.getState().tasks
      expect(tasks.map((task) => task.title)).toEqual(inputs.slice(0, c.saved).map((input) => input.title))
      const serverByUid = new Map<string, any>(serverItems.map((item) => [item.uid, item] as [string, any]))
      for (const task of tasks) {
        const item = serverByUid.get(task.id)
        expect(item, `server item for ${task.title}`).toBeDefined()
        expect(task.uid).not.toBe(task.id)
        expect(new TextDecoder().decode(await item.getContent())).toContain(`UID:${task.uid}`)
      }
    } finally {
      errorSpy.mockRestore()
    }
  }, 20_000)
})

// C3b single-create outcome contract (PLAN §4, §7 R9, R11). A create that the server never
// acknowledged must not resolve as a saved temporary task, and its optimistic record must not
// stay listed. The real-SDK refusal and lost-response cases (R10, R10b) live in the node
// integration test, which hosts the pinned SDK and reference transport.
describe('C3b createTask outcome contract', () => {
  beforeEach(async () => {
    await resetRealOfflineQueue()
    // Production queue configuration: plaintext create content is refused.
    _setEncryptedQueuePersistenceAvailableForTests(false)
    resetStore()
    toastMock.showErrorToast.mockReset()
  })

  it('C3b-R9 createTask: a missing task list rejects as unconfirmed and leaves no optimistic task', async () => {
    // The real lower store: an account with no collection for the requested list.
    useEtebaseStore.setState({ account: {}, accountFingerprint: TEST_FINGERPRINT, collections: { calendar: [], tasks: [], contacts: [], notes: [], preferences: [] } } as any)

    const outcome = await settle(useTaskStore.getState().createTask({ title: 'C3b missing list', listId: 'missing-task-list' }))

    expect(await getAll(queueGuard())).toEqual([])
    expect(outcome).toMatchObject({ rejected: { name: 'TaskSaveError', unconfirmed: true } })
    expect(useTaskStore.getState().tasks).toEqual([])
  })

  it('C3b-R11 createTask: without an account nothing is sent, so it rejects as definitely unsaved and leaves no optimistic task', async () => {
    const createItem = vi.fn()
    useEtebaseStore.setState({ createItem } as any)

    const outcome = await settle(useTaskStore.getState().createTask({ title: 'C3b no account' }))

    expect(createItem).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ rejected: { name: 'TaskSaveError', unconfirmed: false } })
    expect(useTaskStore.getState().tasks).toEqual([])
  })

  it('C3b createTask: a refused write (no write access) rejects as definitely unsaved, with no dispatch and no optimistic task', async () => {
    const { createItem } = acknowledgedAccount()
    useAuthStore.setState({ canWrite: () => false } as any)
    const listed: number[] = []
    const stopRecording = useTaskStore.subscribe((state) => { listed.push(state.tasks.length) })

    const outcome = await settle(useTaskStore.getState().createTask({ title: 'C3b refused write' }))
    stopRecording()

    // The refusal keeps its authority: nothing is sent and nothing was ever listed.
    expect(createItem).not.toHaveBeenCalled()
    expect(listed).toEqual([])
    expect(useTaskStore.getState().tasks).toEqual([])
    // Known not sent, so it must be the definite outcome the page reports as "not saved".
    expect(outcome).toMatchObject({ rejected: { name: 'TaskSaveError', unconfirmed: false } })
  })

  it('C3b createTask control: an acknowledged create still resolves with its item id and stays listed', async () => {
    acknowledgedAccount()

    const outcome = await settle(useTaskStore.getState().createTask({ title: 'C3b acknowledged' }))

    expect(outcome).toMatchObject({ resolved: { id: 'remote-task-1', title: 'C3b acknowledged' } })
    expect(useTaskStore.getState().tasks.map((task) => [task.id, task.title])).toEqual([['remote-task-1', 'C3b acknowledged']])
  })
})
