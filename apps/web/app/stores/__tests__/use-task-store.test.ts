import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useTaskStore } from '../use-task-store'
import { useEtebaseStore } from '../use-etebase-store'

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
})
