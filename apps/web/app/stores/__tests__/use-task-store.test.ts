import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useTaskStore } from '../use-task-store'

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
})
