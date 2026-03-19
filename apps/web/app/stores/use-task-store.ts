'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Task, Priority, SyncStatus } from '@silentsuite/core'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'

interface NewTask {
  title: string
  description?: string
  due_date?: Date | null
  priority?: Priority
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
  syncFromRemote: (tasks: Task[]) => void
}

export const useTaskStore = create<TaskState & TaskActions>()(
  persist(
    (set, get) => ({
      tasks: [],
      isLoading: false,
      syncStatus: 'synced' as SyncStatus,

      createTask: async (newTask: NewTask) => {
        const tempId = crypto.randomUUID()
        const now = new Date()
        const task: Task = {
          id: tempId,
          uid: tempId,
          title: newTask.title,
          description: newTask.description ?? '',
          due_date: newTask.due_date ?? null,
          priority: newTask.priority ?? 'medium',
          completed: false,
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
            const itemUid = await etebase.createItem('tasks', content)
            if (itemUid) {
              // Replace temp id with real Etebase item UID
              set((state) => ({
                tasks: state.tasks.map((t) =>
                  t.id === tempId ? { ...t, id: itemUid, uid: itemUid } : t,
                ),
              }))
              return { ...task, id: itemUid, uid: itemUid }
            }
          } catch (err) {
            console.error('[task-store] Failed to sync new task to Etebase:', err)
          }
        }

        return task
      },

      updateTask: async (id: string, patch: Partial<Task>) => {
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
          try {
            const { serializeTask } = await import('@silentsuite/core')
            const content = serializeTask(updated)
            await etebase.updateItem('tasks', id, content)
          } catch (err) {
            console.error('[task-store] Failed to sync task update to Etebase:', err)
          }
        }
      },

      deleteTask: async (id: string) => {
        set((state) => ({ tasks: state.tasks.filter((t) => t.id !== id) }))

        // Sync to Etebase
        const etebase = useEtebaseStore.getState()
        if (etebase.account) {
          try {
            await etebase.deleteItem('tasks', id)
          } catch (err) {
            console.error('[task-store] Failed to sync task deletion to Etebase:', err)
          }
        }
      },

      toggleComplete: async (id: string) => {
        const { tasks } = get()
        const index = tasks.findIndex((t) => t.id === id)
        if (index === -1) return

        const task = tasks[index]!
        const updated = { ...task, completed: !task.completed, updated_at: new Date() }
        const next = [...tasks]
        next[index] = updated
        set({ tasks: next })

        // Sync to Etebase
        const etebase = useEtebaseStore.getState()
        if (etebase.account) {
          try {
            const { serializeTask } = await import('@silentsuite/core')
            const content = serializeTask(updated)
            await etebase.updateItem('tasks', id, content)
          } catch (err) {
            console.error('[task-store] Failed to sync task toggle to Etebase:', err)
          }
        }
      },

      syncFromRemote: (remoteTasks: Task[]) => {
        set({ tasks: remoteTasks, syncStatus: 'synced' })
      },
    }),
    {
      name: 'silentsuite-tasks',
      partialize: (state) => ({ tasks: state.tasks }),
      storage: {
        getItem: (name) => {
          const raw = localStorage.getItem(name)
          if (!raw) return null
          const parsed = JSON.parse(raw)
          if (parsed?.state?.tasks) {
            parsed.state.tasks = parsed.state.tasks.map((t: Record<string, unknown>) => ({
              ...t,
              due_date: t.due_date ? new Date(t.due_date as string) : null,
              created_at: new Date(t.created_at as string),
              updated_at: new Date(t.updated_at as string),
            }))
          }
          return parsed
        },
        setItem: (name, value) => localStorage.setItem(name, JSON.stringify(value)),
        removeItem: (name) => localStorage.removeItem(name),
      },
    },
  ),
)

export type { NewTask }
