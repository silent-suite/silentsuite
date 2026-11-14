'use client'

import { useEffect, useMemo, useState } from 'react'
import type { Task } from '@silentsuite/core'
import { findItemCollection } from '@/app/lib/collection-access'
import { useBirthdayMarkerStore } from '@/app/lib/birthday-calendar/markers'
import { useCalendarListStore } from '@/app/stores/use-calendar-list-store'
import { useTaskListStore } from '@/app/stores/use-task-list-store'
import { useTaskStore } from '@/app/stores/use-task-store'
import { hasScheduledLabel, isOpenTask, planBlockReason, plannableCalendars, TASK_DRAG_TYPE } from '../lib/plan-task'

const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 }

function comparePlanningTasks(a: Task, b: Task): number {
  const aDue = a.due_date ? new Date(a.due_date).getTime() : Infinity
  const bDue = b.due_date ? new Date(b.due_date).getTime() : Infinity
  if (aDue !== bDue) return aDue - bDue
  const priority = (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2)
  if (priority !== 0) return priority
  return a.title.localeCompare(b.title)
}

interface PlanningPanelProps {
  calendarId: string | undefined
  onCalendarChange: (calendarId: string) => void
  armedTaskId: string | null
  onArm: (taskId: string | null) => void
  pendingTaskIds: ReadonlySet<string>
}

/** Open tasks that can be dragged onto the week grid, or armed and placed with a slot click. */
export function PlanningPanel({ calendarId, onCalendarChange, armedTaskId, onArm, pendingTaskIds }: PlanningPanelProps) {
  const tasks = useTaskStore((s) => s.tasks)
  const taskLists = useTaskListStore((s) => s.lists)
  const calendarLists = useCalendarListStore((s) => s.calendars)
  const birthdayMarkers = useBirthdayMarkerStore((s) => s.snapshot)
  // plannableCalendars reads both stores; these subscriptions keep the list current.
  const calendars = useMemo(() => plannableCalendars(), [calendarLists, birthdayMarkers]) // eslint-disable-line react-hooks/exhaustive-deps
  const [showScheduled, setShowScheduled] = useState(false)

  const visibleTasks = useMemo(
    () => tasks
      .filter((task) => isOpenTask(task)
        && (findItemCollection(taskLists, task.listId)?.visible ?? true)
        && (showScheduled || !hasScheduledLabel(task)))
      .sort(comparePlanningTasks),
    [tasks, taskLists, showScheduled],
  )

  useEffect(() => {
    if (!armedTaskId) return
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onArm(null) }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [armedTaskId, onArm])

  return (
    <aside aria-label="Tasks to plan" className="flex w-72 shrink-0 flex-col gap-3 overflow-hidden rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] p-3">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-[rgb(var(--foreground))]">Tasks</h3>
        <p className="text-xs text-[rgb(var(--muted))]">
          Drag a task into a time slot, or choose Place and then click a slot.
        </p>
      </div>
      <label className="flex flex-col gap-1 text-xs text-[rgb(var(--muted))]">
        Add events to
        <select
          value={calendarId ?? ''}
          onChange={(e) => onCalendarChange(e.target.value)}
          disabled={calendars.length === 0}
          className="rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--background))] px-2 py-1 text-sm text-[rgb(var(--foreground))]"
        >
          {calendars.length === 0 && <option value="">No calendar available</option>}
          {calendars.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-2 text-xs text-[rgb(var(--muted))]">
        <input type="checkbox" checked={showScheduled} onChange={(e) => setShowScheduled(e.target.checked)} className="accent-emerald-600" />
        Show tasks labelled &ldquo;Scheduled&rdquo;
      </label>
      {armedTaskId && (
        <p role="status" className="text-xs text-[rgb(var(--foreground))]">Click a time slot to place the task. Press Escape to cancel.</p>
      )}
      <ul className="-mx-1 flex-1 space-y-1 overflow-y-auto px-1">
        {visibleTasks.map((task) => {
          const reason = planBlockReason(task)
          const pending = pendingTaskIds.has(task.id)
          const armed = armedTaskId === task.id
          const usable = !reason && !pending && !!calendarId
          return (
            <li
              key={task.id}
              draggable={usable}
              onDragStart={(e) => {
                e.dataTransfer.setData(TASK_DRAG_TYPE, task.id)
                e.dataTransfer.effectAllowed = 'move'
              }}
              className={`rounded-md border px-2 py-1.5 text-sm ${armed ? 'border-emerald-500 bg-emerald-500/10' : 'border-[rgb(var(--border))] bg-[rgb(var(--background))]'} ${usable ? 'cursor-grab' : 'opacity-60'}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[rgb(var(--foreground))]">{task.title || 'Untitled'}</span>
                <button
                  type="button"
                  onClick={() => onArm(armed ? null : task.id)}
                  disabled={!usable}
                  aria-pressed={armed}
                  aria-label={`${armed ? 'Cancel placing' : 'Place'} ${task.title || 'Untitled'}`}
                  className="no-min-size shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-[rgb(var(--primary))] hover:bg-[rgb(var(--surface))] disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                >
                  {pending ? 'Adding…' : armed ? 'Cancel' : 'Place'}
                </button>
              </div>
              {reason && <p className="mt-0.5 text-xs text-[rgb(var(--muted))]">{reason}</p>}
            </li>
          )
        })}
        {visibleTasks.length === 0 && <li className="text-xs text-[rgb(var(--muted))]">No open tasks to plan.</li>}
      </ul>
    </aside>
  )
}
