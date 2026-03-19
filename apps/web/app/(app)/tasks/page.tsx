'use client'

import { useCallback, useMemo, useState, useRef, useEffect } from 'react'
import { X, ChevronDown, Calendar, Flag, WifiOff, Plus, AlignLeft, Pencil } from 'lucide-react'
import { useTaskStore } from '@/app/stores/use-task-store'
import { useTaskListStore } from '@/app/stores/use-task-list-store'
import { useSyncStore } from '@/app/stores/use-sync-store'

import { PullToRefresh } from '@/app/components/PullToRefresh'
import { ListSwitcher } from '@/app/components/ListSwitcher'
import { TasksEmptyState } from '@/app/components/empty-state'
import { ConfirmDialog } from '@/app/components/confirm-dialog'
import type { Task, Priority } from '@silentsuite/core'

// ── Priority config ──

const PRIORITY_ORDER: Record<Priority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
}

const PRIORITY_COLORS: Record<Priority, string> = {
  low: 'bg-emerald-500/20 text-emerald-400',
  medium: 'bg-amber-500/20 text-amber-400',
  high: 'bg-orange-500/20 text-orange-400',
  urgent: 'bg-red-500/20 text-red-400',
}

const PRIORITY_LABELS: Record<Priority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
}

// ── Helpers ──

function formatDueDate(date: Date): string {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const due = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const diffDays = Math.round((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Tomorrow'
  if (diffDays === -1) return 'Yesterday'
  if (diffDays < -1) return `${Math.abs(diffDays)}d overdue`
  if (diffDays <= 7) return `In ${diffDays}d`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function dueDateColor(date: Date): string {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const due = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const diffDays = Math.round((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))

  if (diffDays < 0) return 'text-red-400'
  if (diffDays === 0) return 'text-amber-400'
  return 'text-[rgb(var(--muted))]'
}

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    // Incomplete first
    if (a.completed !== b.completed) return a.completed ? 1 : -1
    // By due date (earliest first, null last)
    if (a.due_date !== b.due_date) {
      if (!a.due_date) return 1
      if (!b.due_date) return -1
      const diff = a.due_date.getTime() - b.due_date.getTime()
      if (diff !== 0) return diff
    }
    // By priority (urgent > high > medium > low)
    return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
  })
}

// ── TaskQuickAdd ──

function TaskQuickAdd() {
  const [title, setTitle] = useState('')
  const createTask = useTaskStore((s) => s.createTask)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const trimmed = title.trim()
      if (!trimmed) return
      createTask({ title: trimmed })
      setTitle('')
    },
    [title, createTask],
  )

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <input
        ref={inputRef}
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Add a task..."
        className="flex-1 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-3 py-2 text-sm text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
      />
      <button
        type="submit"
        disabled={!title.trim()}
        className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2"
      >
        Add
      </button>
    </form>
  )
}

// ── TaskDialog (full task creation/edit form) ──

const PRIORITY_BUTTON_ACTIVE: Record<Priority, string> = {
  low: 'bg-emerald-500/20 text-emerald-400',
  medium: 'bg-amber-500/20 text-amber-400',
  high: 'bg-orange-500/20 text-orange-400',
  urgent: 'bg-red-500/20 text-red-400',
}

function TaskDialog({
  mode,
  task,
  onClose,
}: {
  mode: 'create' | 'edit'
  task?: Task
  onClose: () => void
}) {
  const createTask = useTaskStore((s) => s.createTask)
  const updateTask = useTaskStore((s) => s.updateTask)
  const titleRef = useRef<HTMLInputElement>(null)

  const [title, setTitle] = useState(task?.title ?? '')
  const [description, setDescription] = useState(task?.description ?? '')
  const [dueDate, setDueDate] = useState<string>(
    task?.due_date
      ? `${task.due_date.getFullYear()}-${String(task.due_date.getMonth() + 1).padStart(2, '0')}-${String(task.due_date.getDate()).padStart(2, '0')}`
      : '',
  )
  const [priority, setPriority] = useState<Priority>(task?.priority ?? 'medium')

  useEffect(() => {
    const timer = setTimeout(() => titleRef.current?.focus(), 50)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const handleSave = useCallback(() => {
    const trimmed = title.trim()
    if (!trimmed) return

    const parsedDue = dueDate
      ? (() => {
          const [y, m, d] = dueDate.split('-').map(Number)
          return new Date(y!, m! - 1, d!)
        })()
      : null

    if (mode === 'create') {
      createTask({
        title: trimmed,
        description,
        due_date: parsedDue,
        priority,
      })
    } else if (task) {
      updateTask(task.id, {
        title: trimmed,
        description,
        due_date: parsedDue,
        priority,
      })
    }
    onClose()
  }, [title, description, dueDate, priority, mode, task, createTask, updateTask, onClose])

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/40" onClick={onClose} />
      <div className="fixed inset-0 z-[61] flex items-end justify-center sm:items-center sm:p-4">
        <div className="flex w-full max-h-[90vh] flex-col bg-[rgb(var(--background))] sm:max-w-lg sm:rounded-xl sm:border sm:border-[rgb(var(--border))] sm:shadow-xl rounded-t-2xl">
          {/* Mobile drag handle */}
          <div className="mx-auto mt-2 mb-1 h-1 w-10 rounded-full bg-[rgb(var(--border))] sm:hidden" />

          {/* Header */}
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[rgb(var(--border))] px-4 py-3">
            <button
              onClick={onClose}
              className="shrink-0 rounded-md px-2 py-1 text-sm text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors"
            >
              Cancel
            </button>
            <span className="text-sm font-semibold text-[rgb(var(--foreground))]">
              {mode === 'create' ? 'New Task' : 'Edit Task'}
            </span>
            <button
              onClick={handleSave}
              disabled={!title.trim()}
              className="shrink-0 rounded-md bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {mode === 'create' ? 'Create' : 'Save'}
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-4">
            {/* Title */}
            <input
              ref={titleRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && title.trim()) handleSave()
              }}
              placeholder="Task title"
              className="w-full text-base font-medium bg-transparent text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] focus:outline-none border-b border-[rgb(var(--border))] pb-2"
            />

            {/* Due date */}
            <div className="flex items-center gap-3">
              <Calendar className="h-4 w-4 shrink-0 text-[rgb(var(--muted))]" />
              <div className="flex items-center gap-2">
                <span className="text-sm text-[rgb(var(--muted))]">Due date</span>
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-2 py-1.5 text-sm text-[rgb(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
                {dueDate && (
                  <button
                    type="button"
                    onClick={() => setDueDate('')}
                    className="rounded p-1 text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors"
                    aria-label="Clear due date"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Priority */}
            <div className="flex items-center gap-3">
              <Flag className="h-4 w-4 shrink-0 text-[rgb(var(--muted))]" />
              <div className="inline-flex rounded-lg border border-[rgb(var(--border))] overflow-hidden">
                {(['low', 'medium', 'high', 'urgent'] as Priority[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPriority(p)}
                    className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                      priority === p
                        ? PRIORITY_BUTTON_ACTIVE[p]
                        : 'bg-[rgb(var(--surface))] text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))]'
                    }`}
                  >
                    {PRIORITY_LABELS[p]}
                  </button>
                ))}
              </div>
            </div>

            {/* Description / Notes */}
            <div className="flex items-start gap-3">
              <AlignLeft className="mt-2 h-4 w-4 shrink-0 text-[rgb(var(--muted))]" />
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Add notes..."
                rows={4}
                className="flex-1 resize-none rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-3 py-2 text-sm text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

// ── PrioritySelector ──

function PrioritySelector({
  value,
  onChange,
}: {
  value: Priority
  onChange: (p: Priority) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${PRIORITY_COLORS[value]} hover:opacity-80 transition-opacity`}
      >
        <Flag className="h-3 w-3" />
        {PRIORITY_LABELS[value]}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-32 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--background))] py-1 shadow-lg">
          {(['urgent', 'high', 'medium', 'low'] as Priority[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => {
                onChange(p)
                setOpen(false)
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-[rgb(var(--surface))] transition-colors ${
                p === value ? 'font-medium' : ''
              }`}
            >
              <span className={`inline-block h-2 w-2 rounded-full ${PRIORITY_COLORS[p].split(' ')[0]}`} />
              <span className="text-[rgb(var(--foreground))]">{PRIORITY_LABELS[p]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── DateInput ──

function DateInput({
  value,
  onChange,
}: {
  value: Date | null
  onChange: (d: Date | null) => void
}) {
  const formatted = value
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    : ''

  return (
    <div className="flex items-center gap-1">
      <Calendar className="h-3.5 w-3.5 text-[rgb(var(--muted))]" />
      <input
        type="date"
        value={formatted}
        onChange={(e) => {
          if (e.target.value) {
            const [y, m, d] = e.target.value.split('-').map(Number)
            onChange(new Date(y!, m! - 1, d!))
          } else {
            onChange(null)
          }
        }}
        className="bg-transparent text-xs text-[rgb(var(--foreground))] focus:outline-none focus:ring-1 focus:ring-emerald-500 rounded px-1 py-0.5 border border-transparent hover:border-[rgb(var(--border))]"
      />
    </div>
  )
}

// ── TaskItem ──

function TaskItem({ task }: { task: Task }) {
  const updateTask = useTaskStore((s) => s.updateTask)
  const deleteTask = useTaskStore((s) => s.deleteTask)
  const toggleComplete = useTaskStore((s) => s.toggleComplete)

  const [expanded, setExpanded] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleValue, setTitleValue] = useState(task.title)
  const [descValue, setDescValue] = useState(task.description)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const titleInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setTitleValue(task.title)
    setDescValue(task.description)
  }, [task.title, task.description])

  useEffect(() => {
    if (editingTitle && titleInputRef.current) {
      titleInputRef.current.focus()
      titleInputRef.current.select()
    }
  }, [editingTitle])

  const handleTitleBlur = useCallback(() => {
    setEditingTitle(false)
    const trimmed = titleValue.trim()
    if (trimmed && trimmed !== task.title) {
      updateTask(task.id, { title: trimmed })
    } else {
      setTitleValue(task.title)
    }
  }, [titleValue, task.title, task.id, updateTask])

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        ;(e.target as HTMLInputElement).blur()
      }
      if (e.key === 'Escape') {
        setTitleValue(task.title)
        setEditingTitle(false)
      }
    },
    [task.title],
  )

  const handleDescBlur = useCallback(() => {
    if (descValue !== task.description) {
      updateTask(task.id, { description: descValue })
    }
  }, [descValue, task.description, task.id, updateTask])

  return (
    <div className="group rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] transition-colors hover:border-[rgb(var(--muted))]/30">
      {/* Main row */}
      <div className="flex items-center gap-3 px-3 py-2.5">
        {/* Checkbox */}
        <button
          type="button"
          onClick={() => toggleComplete(task.id)}
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
            task.completed
              ? 'border-emerald-500 bg-emerald-500'
              : 'border-[rgb(var(--muted))]/50 hover:border-emerald-500'
          }`}
          aria-label={task.completed ? 'Mark incomplete' : 'Mark complete'}
        >
          {task.completed && (
            <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          )}
        </button>

        {/* Title */}
        <div
          className="flex-1 min-w-0 cursor-pointer"
          onClick={() => {
            if (!editingTitle) setExpanded(!expanded)
          }}
        >
          {editingTitle ? (
            <input
              ref={titleInputRef}
              type="text"
              value={titleValue}
              onChange={(e) => setTitleValue(e.target.value)}
              onBlur={handleTitleBlur}
              onKeyDown={handleTitleKeyDown}
              className="w-full bg-transparent text-sm text-[rgb(var(--foreground))] focus:outline-none"
            />
          ) : (
            <span
              className={`text-sm block truncate ${
                task.completed
                  ? 'line-through text-[rgb(var(--muted))]'
                  : 'text-[rgb(var(--foreground))]'
              }`}
              onDoubleClick={(e) => {
                e.stopPropagation()
                setEditingTitle(true)
              }}
            >
              {task.title || 'Untitled task'}
            </span>
          )}
        </div>

        {/* Badges */}
        <div className="flex items-center gap-2 shrink-0">
          {task.due_date && !expanded && (
            <span className={`text-xs ${dueDateColor(task.due_date)}`}>
              {formatDueDate(task.due_date)}
            </span>
          )}
          {!expanded && (
            <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ${PRIORITY_COLORS[task.priority]}`}>
              {PRIORITY_LABELS[task.priority]}
            </span>
          )}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}
            className="no-min-size rounded p-1 text-[rgb(var(--muted))] opacity-0 group-hover:opacity-100 hover:text-[rgb(var(--primary))] transition-all focus:outline-none focus:opacity-100 md:p-0.5"
            aria-label="Edit task"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setConfirmDelete(true) }}
            className="no-min-size rounded p-1 text-[rgb(var(--muted))] opacity-0 group-hover:opacity-100 hover:text-red-400 transition-all focus:outline-none focus:opacity-100 md:p-0.5"
            aria-label="Delete task"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-[rgb(var(--border))] px-3 py-3 space-y-3">
          <div className="flex items-center gap-4 flex-wrap">
            <DateInput
              value={task.due_date}
              onChange={(d) => updateTask(task.id, { due_date: d })}
            />
            <PrioritySelector
              value={task.priority}
              onChange={(p) => updateTask(task.id, { priority: p })}
            />
          </div>
          <textarea
            value={descValue}
            onChange={(e) => setDescValue(e.target.value)}
            onBlur={handleDescBlur}
            placeholder="Add a description..."
            rows={3}
            className="w-full resize-none rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--background))] px-3 py-2 text-sm text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
        </div>
      )}

      {/* Delete confirmation */}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete task?"
          message={`"${task.title}" will be permanently deleted. This cannot be undone.`}
          confirmLabel="Delete task"
          onConfirm={() => { deleteTask(task.id); setConfirmDelete(false) }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  )
}

// ── TaskList Skeleton ──

function TaskSkeleton() {
  return (
    <div className="space-y-2">
      {[1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="flex items-center gap-3 rounded-lg border border-[rgb(var(--border))]/50 px-3 py-3">
          <div className="h-5 w-5 rounded-full skeleton-shimmer" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3.5 rounded skeleton-shimmer" style={{ width: `${60 + i * 5}%` }} />
          </div>
          <div className="h-5 w-14 rounded-md skeleton-shimmer" />
        </div>
      ))}
    </div>
  )
}

// ── Page ──

export default function TasksPage() {
  const tasks = useTaskStore((s) => s.tasks)
  const isLoading = useTaskStore((s) => s.isLoading)
  const isOnline = useSyncStore((s) => s.isOnline)
  const taskLists = useTaskListStore((s) => s.lists)
  const activeListId = useTaskListStore((s) => s.activeListId)
  const setActiveList = useTaskListStore((s) => s.setActiveList)
  const addTaskList = useTaskListStore((s) => s.addList)
  const removeTaskList = useTaskListStore((s) => s.removeList)
  const [showDialog, setShowDialog] = useState(false)
  const [editTask, setEditTask] = useState<Task | null>(null)

  // Filter tasks by active list (all tasks default to 'default' list)
  const filteredTasks = useMemo(
    () => tasks.filter((t) => (t.listId ?? 'default') === activeListId),
    [tasks, activeListId],
  )
  const sortedTasks = useMemo(() => sortTasks(filteredTasks), [filteredTasks])
  const isEmpty = tasks.length === 0 && !isLoading

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Offline banner */}
      {!isOnline && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          <WifiOff className="h-3.5 w-3.5 shrink-0" />
          You are offline. Changes will sync when reconnected.
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-[rgb(var(--foreground))]">Tasks</h2>
          <ListSwitcher
            lists={taskLists}
            activeListId={activeListId}
            onSelectList={setActiveList}
            onAddList={addTaskList}
            onRemoveList={removeTaskList}
            label="Task Lists"
          />
        </div>
        <button
          onClick={() => setShowDialog(true)}
          className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
        >
          <Plus className="h-4 w-4" />
          New task
        </button>
      </div>

      {/* Quick add */}
      <TaskQuickAdd />

      {/* Content */}
      {isLoading ? (
        <TaskSkeleton />
      ) : isEmpty ? (
        <TasksEmptyState />
      ) : (
        <PullToRefresh>
          <div className="space-y-1.5">
            {sortedTasks.map((task) => (
              <TaskItem key={task.id} task={task} />
            ))}
          </div>
        </PullToRefresh>
      )}

      {/* Task creation dialog */}
      {showDialog && (
        <TaskDialog
          mode="create"
          onClose={() => setShowDialog(false)}
        />
      )}

      {/* Task edit dialog */}
      {editTask && (
        <TaskDialog
          mode="edit"
          task={editTask}
          onClose={() => setEditTask(null)}
        />
      )}
    </div>
  )
}
