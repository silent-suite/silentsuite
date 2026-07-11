import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useTaskStore } from '../use-task-store'
import { useEtebaseStore } from '../use-etebase-store'
import { getAll } from '@/app/lib/offline-queue'
import { TEST_FINGERPRINT, bumpEpochWhenQueuePutRuns, enqueueCreateFromStore, expectOwnedQueueEntry, expectQuietQueueCommitCancellation, queueGuard, replayOwnedEntry, resetRealOfflineQueue } from './offline-queue-store-test-utils'

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
    isLoading: false,
    syncStatus: 'synced',
  })
  useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
}

function offlineAccount() {
  useEtebaseStore.setState({ account: {}, accountFingerprint: TEST_FINGERPRINT, itemCache: new Map(), createItem: vi.fn((type, content, tempId, collectionUid) => enqueueCreateFromStore(type, collectionUid, content, tempId!)) } as any)
}

function queuedTask(id = 'temp-task') {
  return { id, uid: id, title: 'Task', description: '', start_date: null, due_date: null, priority: 'medium' as const, completed: false, status: 'needs-action' as const, percent_complete: 0, location: '', url: '', categories: [], listId: 'tasks-1', created_at: new Date(), updated_at: new Date() }
}

describe('useTaskStore', () => {
  beforeEach(() => {
    resetStore()
  })

  it('createTask adds a task to the store', async () => {
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
    const { createTask } = useTaskStore.getState()
    const task = await createTask({ title: 'Original' })

    const { updateTask } = useTaskStore.getState()
    await updateTask(task.id, { title: 'Updated' })

    const { tasks } = useTaskStore.getState()
    expect(tasks[0]!.title).toBe('Updated')
  })

  it('updateTask does nothing for unknown id', async () => {
    const { createTask } = useTaskStore.getState()
    await createTask({ title: 'Only task' })

    const { updateTask } = useTaskStore.getState()
    await updateTask('nonexistent', { title: 'Ghost' })

    const { tasks } = useTaskStore.getState()
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.title).toBe('Only task')
  })

  it('deleteTask removes a task', async () => {
    const { createTask } = useTaskStore.getState()
    const task = await createTask({ title: 'To delete' })

    const { deleteTask } = useTaskStore.getState()
    await deleteTask(task.id)

    const { tasks } = useTaskStore.getState()
    expect(tasks).toHaveLength(0)
  })

  it('toggleComplete flips completion state', async () => {
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

  it('preserves completed state during task import', async () => {
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
