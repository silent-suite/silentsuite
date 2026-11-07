'use client'

import { create } from 'zustand'
import type { Task, TaskICalDate, TaskStatus, Priority, SyncStatus } from '@silentsuite/core'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { enqueue, readOutstanding } from '@/app/lib/offline-queue'
import { assertOfflineQueueAccountGuard, captureOfflineQueueAccountGuard, isOfflineQueueBoundaryCancellation } from '@/app/lib/offline-queue-account'
import { getSafeErrorDetails } from '@/app/lib/privacy-safe-errors'
import { ImportIncompleteError } from '@/app/lib/import-outcome'
import { showErrorToast } from '@/app/stores/use-toast-store'
import { useTaskListStore } from '@/app/stores/use-task-list-store'
import { useLabelSuggestionsStore } from '@/app/stores/use-label-suggestions-store'

interface NewTask {
  title: string
  description?: string
  start_date?: Date | null
  due_date?: Date | null
  /** Source DTSTART/DUE identity, e.g. from an imported file; must describe the matching date. */
  start_ical?: TaskICalDate
  due_ical?: TaskICalDate
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
  syncStatus: SyncStatus
}

/**
 * A task create the server did not acknowledge. `unconfirmed` is false only when nothing was
 * sent; otherwise the task may still exist remotely (a lost response), so it is never called absent.
 */
export class TaskSaveError extends Error {
  constructor(readonly unconfirmed: boolean) {
    super(unconfirmed ? 'Task save not confirmed' : 'Task not saved')
    this.name = 'TaskSaveError'
  }
}

interface TaskActions {
  /**
   * Resolves once the server acknowledged the task, or once the create is held in the offline
   * queue; otherwise removes the temp task and rejects with TaskSaveError.
   */
  createTask: (task: NewTask) => Promise<Task>
  updateTask: (id: string, patch: Partial<Task>) => Promise<void>
  deleteTask: (id: string) => Promise<void>
  toggleComplete: (id: string) => Promise<void>
  /** Resolves the requested count only when every task was acknowledged; otherwise rejects with ImportIncompleteError. */
  importTasks: (newTasks: NewTask[]) => Promise<number>
  syncFromRemote: (tasks: Task[]) => void
}

/** Source identity for a new task's dates, kept only where the matching date is set. */
function temporalSources(task: NewTask): Pick<Task, 'start_ical' | 'due_ical'> {
  return {
    ...(task.start_date && task.start_ical ? { start_ical: task.start_ical } : {}),
    ...(task.due_date && task.due_ical ? { due_ical: task.due_ical } : {}),
  }
}

/** A date patched without its source no longer matches the old source, so that source is dropped. */
function applyTaskPatch(task: Task, patch: Partial<Task>): Task {
  const updated = { ...task, ...patch, updated_at: new Date() }
  if ('start_date' in patch && !('start_ical' in patch)) delete updated.start_ical
  if ('due_date' in patch && !('due_ical' in patch)) delete updated.due_ical
  return updated
}

function defaultTaskListId(): string | undefined {
  const { lists, activeListId } = useTaskListStore.getState()
  if (activeListId !== 'all' && lists.some((list) => list.id === activeListId)) return activeListId
  return lists[0]?.id
}

export const useTaskStore = create<TaskState & TaskActions>()(
    (set, get) => ({
      tasks: [],
      syncStatus: 'synced' as SyncStatus,

      createTask: async (newTask: NewTask) => {
        // Refused before anything is listed or sent: a known, definite non-save.
        if (!useAuthStore.getState().canWrite()) throw new TaskSaveError(false)
        const tempId = crypto.randomUUID()
        const now = new Date()
        const task: Task = {
          id: tempId,
          uid: tempId,
          title: newTask.title,
          description: newTask.description ?? '',
          start_date: newTask.start_date ?? null,
          due_date: newTask.due_date ?? null,
          ...temporalSources(newTask),
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
        // An unacknowledged temp task would vanish on the next refresh; the caller keeps the draft.
        const withdraw = (unconfirmed: boolean): never => {
          set((state) => {
            const remaining = state.tasks.filter((t) => t.id !== tempId)
            return remaining.length === state.tasks.length ? state : { tasks: remaining }
          })
          throw new TaskSaveError(unconfirmed)
        }

        // Sync to Etebase
        const etebase = useEtebaseStore.getState()
        if (!etebase.account) return withdraw(false)
        let dispatched = false
        try {
          const { serializeTask } = await import('@silentsuite/core')
          const content = serializeTask(task)
          dispatched = true
          const itemUid = await etebase.createItem('tasks', content, tempId, task.listId)
          if (itemUid) {
            void useLabelSuggestionsStore.getState().recordUsage('tasks', task.categories ?? [])
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

        // Not acknowledged. A create admitted to the offline queue is durable local custody
        // awaiting replay, so the temp task stays; anything else may or may not exist remotely.
        if (dispatched) {
          const guard = captureOfflineQueueAccountGuard(etebase)
          if (guard) {
            try {
              const outstanding = await readOutstanding({ collectionType: 'tasks', itemUid: tempId }, guard)
              if (outstanding.some((entry) => entry.type === 'create')) return task
            } catch {
              // An unreadable queue proves nothing: the create stays unconfirmed.
            }
          }
        }
        return withdraw(dispatched)
      },

      updateTask: async (id: string, patch: Partial<Task>) => {
        if (!useAuthStore.getState().canWrite()) throw new Error('Your subscription has ended. Upgrade to make changes.')
        const { tasks } = get()
        const index = tasks.findIndex((t) => t.id === id)
        if (index === -1) return

        const updated = applyTaskPatch(tasks[index]!, patch)
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
              void useLabelSuggestionsStore.getState().recordUsage('tasks', updated.categories ?? [])
            } catch (err) {
              console.error('[task-store] Failed to sync task update to Etebase', getSafeErrorDetails(err))
              showErrorToast('Failed to save task. Please try again.')
            }
          } else {
            const guard = captureOfflineQueueAccountGuard(etebase)
            if (!guard) return
            // Item was created offline — enqueue update with tempId so compaction merges into create
            const { serializeTask } = await import('@silentsuite/core')
            assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState())
            const content = serializeTask(updated)
            assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState())
            try {
              await enqueue({ type: 'update', collectionType: 'tasks', collectionUid: updated.listId, content, tempId: id }, guard)
              assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState())
            } catch (error) {
              if (isOfflineQueueBoundaryCancellation(error)) return
              throw error
            }
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
            const guard = captureOfflineQueueAccountGuard(etebase)
            if (!guard) return
            // Item was created offline and not yet synced — enqueue delete with tempId for compaction
            try {
              assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState())
              await enqueue({ type: 'delete', collectionType: 'tasks', collectionUid: taskToDelete?.listId, tempId: id }, guard)
              assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState())
            } catch (error) {
              if (isOfflineQueueBoundaryCancellation(error)) return
              throw error
            }
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
              void useLabelSuggestionsStore.getState().recordUsage('tasks', updated.categories ?? [])
            } catch (err) {
              console.error('[task-store] Failed to sync task toggle to Etebase', getSafeErrorDetails(err))
              showErrorToast('Failed to save task. Please try again.')
            }
          } else {
            const guard = captureOfflineQueueAccountGuard(etebase)
            if (!guard) return
            const { serializeTask } = await import('@silentsuite/core')
            assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState())
            const content = serializeTask(updated)
            assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState())
            try {
              await enqueue({ type: 'update', collectionType: 'tasks', collectionUid: updated.listId, content, tempId: id }, guard)
              assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState())
            } catch (error) {
              if (isOfflineQueueBoundaryCancellation(error)) return
              throw error
            }
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
            ...temporalSources(nt),
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

        // Batch sync to Etebase. Input positions the server acknowledged; the rest are rolled back.
        const acknowledged = new Set<number>()
        let sent = false
        const etebase = useEtebaseStore.getState()
        if (etebase.account) {
          try {
            const { serializeTask } = await import('@silentsuite/core')
            const groups = new Map<string | undefined, number[]>()
            tasks.forEach((task, position) => {
              groups.set(task.listId, [...(groups.get(task.listId) ?? []), position])
            })

            for (const [targetCollectionUid, positions] of groups) {
              const contents = positions.map((position) => ({
                content: serializeTask(tasks[position]!),
                tempId: tasks[position]!.id,
              }))
              sent = true
              const uids = await etebase.createItemsBatch('tasks', contents, targetCollectionUid)
              // Each acknowledged task takes its item id and keeps its own VTODO UID.
              const itemIds = new Map<string, string>()
              positions.forEach((position, index) => {
                const itemUid = uids[index]
                if (!itemUid) return
                itemIds.set(tasks[position]!.id, itemUid)
                acknowledged.add(position)
              })
              if (itemIds.size === 0) continue
              set((state) => ({
                tasks: state.tasks.map((t) => {
                  const itemUid = itemIds.get(t.id)
                  return itemUid ? { ...t, id: itemUid } : t
                }),
              }))
            }
          } catch (err) {
            console.error('[task-store] Failed to batch import tasks', getSafeErrorDetails(err))
          }
        }

        if (acknowledged.size === tasks.length) return tasks.length
        const unsaved = tasks.map((_, position) => position).filter((position) => !acknowledged.has(position))
        // Unacknowledged temp tasks would vanish on the next refresh; the importer keeps their input.
        const tempIds = new Set(unsaved.map((position) => tasks[position]!.id))
        set((state) => {
          const remaining = state.tasks.filter((t) => !tempIds.has(t.id))
          return remaining.length === state.tasks.length ? state : { tasks: remaining }
        })
        throw new ImportIncompleteError(acknowledged.size, unsaved, sent)
      },

      syncFromRemote: (remoteTasks: Task[]) => {
        set({ tasks: remoteTasks, syncStatus: 'synced' })
      },
    }),
)

export type { NewTask }
