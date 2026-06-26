'use client'

import { create } from 'zustand'
import type { Task, TaskStatus, Priority, SyncStatus } from '@silentsuite/core'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { enqueue } from '@/app/lib/offline-queue'
import { getSafeErrorDetails } from '@/app/lib/privacy-safe-errors'
import { showErrorToast } from '@/app/stores/use-toast-store'
import { useTaskListStore } from '@/app/stores/use-task-list-store'

interface NewTask {
  title: string
  description?: string
  start_date?: Date | null
  due_date?: Date | null
  priority?: Priority
  completed?: boolean
  status?: TaskStatus
  percent_complete?: number
  location?: string
  url?: string
  categories?: string[]
  listId?: string
}

interface TaskState {
  tasks: Task[]
  isLoading: boolean
  syncStatus: SyncStatus
}

interface TaskActions {
  createTask: (task: NewTask) => Promise<Task>
  updateTask: (id: string, patch: Partial<Task>) => Promise<void>
  deleteTask: (id: string) => Promise<void>
  toggleComplete: (id: string) => Promise<void>
  importTasks: (newTasks: NewTask[]) => Promise<number>
  syncFromRemote: (tasks: Task[]) => void
}

function defaultTaskListId(): string | undefined {
  const { lists, activeListId } = useTaskListStore.getState()
  if (activeListId !== 'all' && lists.some((list) => list.id === activeListId)) return activeListId
  return lists[0]?.id
}

export const useTaskStore = create<TaskState & TaskActions>()(
    (set, get) => ({
      tasks: [],
      isLoading: false,
      syncStatus: 'synced' as SyncStatus,

      createTask: async (newTask: NewTask) => {
        if (!useAuthStore.getState().canWrite()) throw new Error('Your subscription has ended. Upgrade to make changes.')
        const tempId = crypto.randomUUID()
        const now = new Date()
        const task: Task = {
          id: tempId,
          uid: tempId,
          title: newTask.title,
          description: newTask.description ?? '',
          start_date: newTask.start_date ?? null,
          due_date: newTask.due_date ?? null,
          priority: newTask.priority ?? 'medium',
          completed: newTask.completed ?? false,
          status: newTask.status ?? (newTask.completed ? 'completed' : 'needs-action'),
          percent_complete: newTask.percent_complete ?? (newTask.completed ? 100 : 0),
          location: newTask.location ?? '',
          url: newTask.url ?? '',
          categories: newTask.categories ?? [],
          listId: newTask.listId ?? defaultTaskListId(),
          created_at: now,
          updated_at: now,
        }

        // Optimistic local update
        set((state) => ({ tasks: [...state.tasks, task] }))

        // Sync to Etebase
        const etebase = useEtebaseStore.getState()
        if (etebase.account) {
          try {
            const { serializeTask } = await import('@silentsuite/core')
            const content = serializeTask(task)
            const itemUid = await etebase.createItem('tasks', content, tempId, task.listId)
            if (itemUid) {
              // Replace temp id with real Etebase item UID
              set((state) => ({
                tasks: state.tasks.map((t) =>
                  t.id === tempId ? { ...t, id: itemUid } : t,
                ),
              }))
              return { ...task, id: itemUid }
            }
          } catch (err) {
            console.error('[task-store] Failed to sync new task to Etebase', getSafeErrorDetails(err))
            showErrorToast('Failed to save task. Please try again.')
          }
        }

        return task
      },

      updateTask: async (id: string, patch: Partial<Task>) => {
        if (!useAuthStore.getState().canWrite()) throw new Error('Your subscription has ended. Upgrade to make changes.')
        const { tasks } = get()
        const index = tasks.findIndex((t) => t.id === id)
        if (index === -1) return

        const updated = { ...tasks[index], ...patch, updated_at: new Date() }
        const next = [...tasks]
        next[index] = updated
        set({ tasks: next })

        // Sync to Etebase
        const etebase = useEtebaseStore.getState()
        if (etebase.account) {
          const itemInCache = etebase.itemCache.has(id)
          if (itemInCache) {
            try {
              const { serializeTask } = await import('@silentsuite/core')
              const content = serializeTask(updated)
              await etebase.updateItem('tasks', id, content)
            } catch (err) {
              console.error('[task-store] Failed to sync task update to Etebase', getSafeErrorDetails(err))
              showErrorToast('Failed to save task. Please try again.')
            }
          } else {
            // Item was created offline — enqueue update with tempId so compaction merges into create
            const { serializeTask } = await import('@silentsuite/core')
            const content = serializeTask(updated)
            await enqueue({ type: 'update', collectionType: 'tasks', collectionUid: updated.listId, content, tempId: id })
          }
        }
      },

      deleteTask: async (id: string) => {
        if (!useAuthStore.getState().canWrite()) throw new Error('Your subscription has ended. Upgrade to make changes.')
        const taskToDelete = get().tasks.find((t) => t.id === id)
        set((state) => ({ tasks: state.tasks.filter((t) => t.id !== id) }))

        // Sync to Etebase
        const etebase = useEtebaseStore.getState()
        if (etebase.account) {
          // Check if item exists in etebase cache — if not, it may be an offline-created item
          const itemInCache = etebase.itemCache.has(id)
          if (itemInCache) {
            try {
              await etebase.deleteItem('tasks', id)
            } catch (err) {
              console.error('[task-store] Failed to sync task deletion to Etebase', getSafeErrorDetails(err))
              showErrorToast('Failed to delete task. Please try again.')
            }
          } else {
            // Item was created offline and not yet synced — enqueue delete with tempId for compaction
            await enqueue({ type: 'delete', collectionType: 'tasks', collectionUid: taskToDelete?.listId, tempId: id })
          }
        }
      },

      toggleComplete: async (id: string) => {
        if (!useAuthStore.getState().canWrite()) throw new Error('Your subscription has ended. Upgrade to make changes.')
        const { tasks } = get()
        const index = tasks.findIndex((t) => t.id === id)
        if (index === -1) return

        const task = tasks[index]!
        const nextCompleted = !task.completed
        const updated = {
          ...task,
          completed: nextCompleted,
          status: nextCompleted ? 'completed' as const : 'needs-action' as const,
          percent_complete: nextCompleted ? 100 : 0,
          updated_at: new Date(),
        }
        const next = [...tasks]
        next[index] = updated
        set({ tasks: next })

        // Sync to Etebase
        const etebase = useEtebaseStore.getState()
        if (etebase.account) {
          const itemInCache = etebase.itemCache.has(id)
          if (itemInCache) {
            try {
              const { serializeTask } = await import('@silentsuite/core')
              const content = serializeTask(updated)
              await etebase.updateItem('tasks', id, content)
            } catch (err) {
              console.error('[task-store] Failed to sync task toggle to Etebase', getSafeErrorDetails(err))
              showErrorToast('Failed to save task. Please try again.')
            }
          } else {
            const { serializeTask } = await import('@silentsuite/core')
            const content = serializeTask(updated)
            await enqueue({ type: 'update', collectionType: 'tasks', collectionUid: updated.listId, content, tempId: id })
          }
        }
      },

      importTasks: async (newTasks: NewTask[]) => {
        if (!useAuthStore.getState().canWrite()) throw new Error('Your subscription has ended. Upgrade to make changes.')
        if (newTasks.length === 0) return 0

        const now = new Date()
        const tasks: Task[] = newTasks.map((nt) => {
          const tempId = crypto.randomUUID()
          return {
            id: tempId,
            uid: tempId,
            title: nt.title,
            description: nt.description ?? '',
            start_date: nt.start_date ?? null,
            due_date: nt.due_date ?? null,
            priority: nt.priority ?? 'medium',
            completed: nt.completed ?? false,
            status: nt.status ?? (nt.completed ? 'completed' : 'needs-action'),
            percent_complete: nt.percent_complete ?? (nt.completed ? 100 : 0),
            location: nt.location ?? '',
            url: nt.url ?? '',
            categories: nt.categories ?? [],
            listId: nt.listId ?? defaultTaskListId(),
            created_at: now,
            updated_at: now,
          }
        })

        // Optimistic local update — add all at once
        set((state) => ({ tasks: [...state.tasks, ...tasks] }))

        // Batch sync to Etebase
        const etebase = useEtebaseStore.getState()
        if (etebase.account) {
          try {
            const { serializeTask } = await import('@silentsuite/core')
            const groups = new Map<string | undefined, Task[]>()
            for (const task of tasks) {
              const key = task.listId
              groups.set(key, [...(groups.get(key) ?? []), task])
            }

            for (const [targetCollectionUid, groupTasks] of groups) {
              const contents = groupTasks.map((t) => ({
                content: serializeTask(t),
                tempId: t.id,
              }))
              const uids = await etebase.createItemsBatch('tasks', contents, targetCollectionUid)
              set((state) => ({
                tasks: state.tasks.map((t) => {
                  const idx = groupTasks.findIndex((task) => task.id === t.id)
                  if (idx !== -1 && uids[idx]) {
                    return { ...t, id: uids[idx]! }
                  }
                  return t
                }),
              }))
            }
          } catch (err) {
            console.error('[task-store] Failed to batch import tasks', getSafeErrorDetails(err))
          }
        }

        return tasks.length
      },

      syncFromRemote: (remoteTasks: Task[]) => {
        set({ tasks: remoteTasks, syncStatus: 'synced' })
      },
    }),
)

export type { NewTask }
