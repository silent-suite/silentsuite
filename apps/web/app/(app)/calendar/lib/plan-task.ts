import type { Task } from '@silentsuite/core'
import { getAccountEpoch, isCurrentAccountEpoch } from '@/app/lib/account-epoch'
import { canWriteCollection, findItemCollection } from '@/app/lib/collection-access'
import { selectManagedBirthdayCalendarIds, useBirthdayMarkerStore } from '@/app/lib/birthday-calendar/markers'
import { resolveUserTimezone } from '@/app/lib/tz'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { CalendarSaveError, useCalendarStore } from '@/app/stores/use-calendar-store'
import { useCalendarListStore } from '@/app/stores/use-calendar-list-store'
import type { PlanningDisposition } from '@/app/stores/use-experimental-store'
import { usePreferencesStore } from '@/app/stores/use-preferences-store'
import { useTaskListStore } from '@/app/stores/use-task-list-store'
import { useTaskStore } from '@/app/stores/use-task-store'

/** Written as a task category; a fixed string so the filter works in every language. */
export const SCHEDULED_LABEL = 'Scheduled'
export const PLANNED_EVENT_MINUTES = 30
/** MIME type carrying a task id while it is dragged onto the calendar. */
export const TASK_DRAG_TYPE = 'application/x-silentsuite-task'

const RECURRENCE_LINE = /^(RRULE|RDATE|EXDATE|RECURRENCE-ID)[;:]/i

export function isRecurringTask(task: Task): boolean {
  return (task.unknownProperties ?? []).some((line) => RECURRENCE_LINE.test(line))
}

export function isOpenTask(task: Task): boolean {
  return !task.completed && task.status !== 'completed' && task.status !== 'cancelled'
}

export function hasScheduledLabel(task: Task): boolean {
  return (task.categories ?? []).some((c) => c.toLowerCase() === SCHEDULED_LABEL.toLowerCase())
}

/** Why a task cannot be placed, or null when it can. */
export function planBlockReason(task: Task): string | null {
  if (!isOpenTask(task)) return 'Only open tasks can be planned.'
  if (isRecurringTask(task)) return 'Repeating tasks can’t be planned yet.'
  const list = findItemCollection(useTaskListStore.getState().lists, task.listId)
  if (!canWriteCollection(list)) return 'This task list is read-only.'
  return null
}

/** Calendars an event can be planned into: writable and not app-managed (Birthdays). */
export function plannableCalendars() {
  const managed = selectManagedBirthdayCalendarIds(
    useBirthdayMarkerStore.getState().snapshot, getAccountEpoch(), useEtebaseStore.getState().accountFingerprint)
  return useCalendarListStore.getState().calendars.filter((c) => canWriteCollection(c) && !managed.includes(c.id))
}

export type PlanTaskResult =
  | { kind: 'done'; message: string }
  | { kind: 'error'; message: string }

const inFlight = new Set<string>()

function disposeTask(task: Task, disposition: PlanningDisposition): Promise<void> {
  const tasks = useTaskStore.getState()
  if (disposition === 'delete') return tasks.deleteTask(task.id)
  if (disposition === 'complete') {
    return tasks.updateTask(task.id, { completed: true, status: 'completed', percent_complete: 100 })
  }
  if (hasScheduledLabel(task)) return Promise.resolve()
  return tasks.updateTask(task.id, { categories: [...(task.categories ?? []), SCHEDULED_LABEL] })
}

function copiedFieldsUnchanged(copied: Task, current: Task): boolean {
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  return new Date(copied.updated_at).getTime() === new Date(current.updated_at).getTime()
    && same(copied.title, current.title)
    && same(copied.description, current.description)
    && same(copied.url, current.url)
    && same(copied.location, current.location)
    && same(copied.categories, current.categories)
}

const DISPOSITION_DONE: Record<PlanningDisposition, string> = {
  label: 'The task is labelled “Scheduled”.',
  complete: 'The task is marked completed.',
  delete: 'The task was deleted.',
}

/**
 * Creates a 30-minute event for the task at `start`, then, only once the server has confirmed the
 * event, applies the chosen disposition to the task. Any failure or offline-only save leaves the
 * task untouched.
 */
export async function planTask(
  taskId: string,
  start: Date,
  calendarId: string,
  disposition: PlanningDisposition,
): Promise<PlanTaskResult> {
  if (inFlight.has(taskId)) return { kind: 'error', message: 'This task is already being added.' }
  const task = useTaskStore.getState().tasks.find((t) => t.id === taskId)
  if (!task) return { kind: 'error', message: 'This task no longer exists.' }
  if (!useAuthStore.getState().canWrite()) return { kind: 'error', message: 'Your account is currently read-only.' }
  const blocked = planBlockReason(task)
  if (blocked) return { kind: 'error', message: blocked }
  if (!plannableCalendars().some((c) => c.id === calendarId)) {
    return { kind: 'error', message: 'Choose a calendar you can add events to.' }
  }

  inFlight.add(taskId)
  const epoch = getAccountEpoch()
  try {
    const description = [task.description?.trim(), task.url?.trim()].filter(Boolean).join('\n\n')
    let created
    try {
      created = await useCalendarStore.getState().createEvent({
        title: task.title,
        description: description || undefined,
        location: task.location?.trim() || undefined,
        categories: (task.categories ?? []).filter((c) => c.toLowerCase() !== SCHEDULED_LABEL.toLowerCase()),
        startDate: start,
        endDate: new Date(start.getTime() + PLANNED_EVENT_MINUTES * 60_000),
        timezone: resolveUserTimezone(usePreferencesStore.getState().defaultTimezone),
        calendarId,
      })
    } catch (err) {
      if (err instanceof CalendarSaveError && err.unconfirmed) {
        return { kind: 'error', message: 'The event may not have been saved. Check the calendar before trying again. The task was not changed.' }
      }
      return { kind: 'error', message: 'Could not add the event. The task was not changed.' }
    }

    // An acknowledged create carries the server item id; a create held in the offline queue keeps
    // its temporary id, which is also its UID. Only an acknowledged event may change the task.
    if (created.id === created.uid) {
      return { kind: 'done', message: `Added “${task.title}” to the calendar. It will sync when you are back online; the task was left unchanged.` }
    }
    if (!isCurrentAccountEpoch(epoch)) return { kind: 'error', message: 'The account changed; the task was not changed.' }
    // Re-check: the task or its list may have changed while the event was saving.
    const current = useTaskStore.getState().tasks.find((t) => t.id === taskId)
    const unchanged = !!current && copiedFieldsUnchanged(task, current)
    // Labelling and completing act on the current task, so newer labels survive. Deleting would
    // lose anything edited since the event was copied, so it needs the task exactly as copied.
    if (!current || planBlockReason(current) || !useAuthStore.getState().canWrite() || (disposition === 'delete' && !unchanged)) {
      return { kind: 'done', message: `Added “${task.title}” to the calendar. The task was not changed because it was edited meanwhile.` }
    }
    try {
      await disposeTask(current, disposition)
    } catch {
      return { kind: 'error', message: `Added “${task.title}” to the calendar, but the task could not be updated.` }
    }
    return { kind: 'done', message: `Added “${task.title}” to the calendar. ${DISPOSITION_DONE[disposition]}` }
  } finally {
    inFlight.delete(taskId)
  }
}
