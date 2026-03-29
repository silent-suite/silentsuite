'use client'

import { useCallback, useMemo, useState, useRef, useEffect } from 'react'
import { X, ChevronDown, Calendar, Flag, WifiOff, Plus, AlignLeft, Pencil, List } from 'lucide-react'
import { useTaskStore } from '@/app/stores/use-task-store'
import { useTaskListStore } from '@/app/stores/use-task-list-store'
import { useSyncStore } from '@/app/stores/use-sync-store'
import { useAuthStore } from '@/app/stores/use-auth-store'

import { PullToRefresh } from '@/app/components/PullToRefresh'
import { TasksEmptyState } from '@/app/components/empty-state'
import { ConfirmDialog } from '@/app/components/confirm-dialog'
import { useFocusTrap } from '@/app/lib/use-focus-trap'
import type { Task, Priority } from '@silentsuite/core'

// ── Priority config ──

const PRIORITY_ORDER: Record<Priority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
}

const PRIORITY_COLORS: Record<Priority, string> = {
  low: 'bg-emerald-500/30 text-emerald-300',
  medium: 'bg-amber-500/30 text-amber-300',
  high: 'bg-orange-500/30 text-orange-300',
  urgent: 'bg-red-500/30 text-red-300',
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
  const canWrite = useAuthStore((s) => s.canWrite())
  const taskLists = useTaskListStore((s) => s.lists)
  const inputRef = useRef<HTMLInputElement>(null)

  const defaultListId = useMemo(() => {
    const visible = taskLists.filter(l => l.visible)
    return visible.length === 1 ? visible[0]!.id : 'default'
  }, [taskLists])

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const trimmed = title.trim()
      if (!trimmed) return
      createTask({ title: trimmed, listId: defaultListId })
      setTitle('')
    },
    [title, createTask, defaultListId],
  )

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <input
        ref={inputRef}
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={canWrite ? 'Add a task...' : 'Read-only mode'}
        aria-label="Add a task"
        disabled={!canWrite}
        className={`flex-1 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-3 py-2 text-sm text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent ${!canWrite ? 'opacity-50 cursor-not-allowed' : ''}`}
        title={!canWrite ? 'Subscription required' : undefined}
      />
      <button
        type="submit"
        disabled={!title.trim() || !canWrite}
        className={`rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 ${canWrite ? 'hover:bg-emerald-500' : ''}`}
        title={!canWrite ? 'Subscription required' : undefined}
      >
        Add
      </button>
    </form>
  )
}

// ── TaskDialog (full task creation/edit form) ──

const PRIORITY_BUTTON_ACTIVE: Record<Priority, string> = {
  low: 'bg-emerald-500/30 text-emerald-300',
  medium: 'bg-amber-500/30 text-amber-300',
  high: 'bg-orange-500/30 text-orange-300',
  urgent: 'bg-red-500/30 text-red-300',
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
  const taskLists = useTaskListStore((s) => s.lists)
  const titleRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  // Focus trap: keep Tab cycling within the dialog
  useFocusTrap(dialogRef)

  const defaultListId = useMemo(() => {
    const visible = taskLists.filter(l => l.visible)
    return visible.length === 1 ? visible[0]!.id : 'default'
  }, [taskLists])

  const [title, setTitle] = useState(task?.title ?? '')
  const [description, setDescription] = useState(task?.description ?? '')
  const [dueDate, setDueDate] = useState<string>(
    task?.due_date
      ? `${task.due_date.getFullYear()}-${String(task.due_date.getMonth() + 1).padStart(2, '0')}-${String(task.due_date.getDate()).padStart(2, '0')}`
      : '',
  )
  const [priority, setPriority] = useState<Priority>(task?.priority ?? 'medium')
  const [selectedListId, setSelectedListId] = useState(task?.listId ?? defaultListId)

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
        listId: selectedListId,
      })
    } else if (task) {
      updateTask(task.id, {
        title: trimmed,
        description,
        due_date: parsedDue,
        priority,
        listId: selectedListId,
      })
    }
    onClose()
  }, [title, description, dueDate, priority, selectedListId, mode, task, createTask, updateTask, onClose])

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/40" aria-hidden="true" onClick={onClose} />
      <div className="fixed inset-0 z-[61] flex items-end justify-center sm:items-center sm:p-4">
        <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={mode === 'create' ? 'New Task' : 'Edit Task'} className="flex w-full max-h-[90vh] flex-col bg-[rgb(var(--background))] sm:max-w-lg sm:rounded-xl sm:border sm:border-[rgb(var(--border))] sm:shadow-xl rounded-t-2xl">
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
                  aria-label="Due date"
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

            {/* List selector — colored pill buttons */}
            <div className="flex items-center gap-3">
              <List className="h-4 w-4 shrink-0 text-[rgb(var(--muted))]" />
              <div className="flex flex-wrap gap-1.5">
                {taskLists.map((list) => (
                  <button
                    key={list.id}
                    type="button"
                    onClick={() => setSelectedListId(list.id)}
                    className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors border ${
                      selectedListId === list.id
                        ? 'border-transparent text-white'
                        : 'border-[rgb(var(--border))] text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] bg-[rgb(var(--surface))]'
                    }`}
                    style={selectedListId === list.id ? { backgroundColor: list.color } : undefined}
                  >
                    <div
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: list.color }}
                    />
                    {list.name}
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
  disabled = false,
}: {
  value: Priority
  onChange: (p: Priority) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const optionsRef = useRef<(HTMLButtonElement | null)[]>([])
  const priorities: Priority[] = ['urgent', 'high', 'medium', 'low']

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  // Auto-focus selected option on open
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        const idx = priorities.indexOf(value)
        optionsRef.current[idx >= 0 ? idx : 0]?.focus()
      })
    }
  }, [open, value])

  const handleListKeyDown = (e: React.KeyboardEvent) => {
    const items = optionsRef.current.filter(Boolean) as HTMLElement[]
    const idx = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      items[(idx + 1) % items.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      items[(idx - 1 + items.length) % items.length]?.focus()
    } else if (e.key === 'Home') {
      e.preventDefault()
      items[0]?.focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      items[items.length - 1]?.focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${PRIORITY_COLORS[value]} transition-opacity ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-80'}`}
        title={disabled ? 'Subscription required' : undefined}
      >
        <Flag className="h-3 w-3" />
        {PRIORITY_LABELS[value]}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full z-30 mt-1 w-32 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--background))] py-1 shadow-lg"
          role="listbox"
          aria-label="Priority"
          aria-activedescendant={`priority-${value}`}
          onKeyDown={handleListKeyDown}
        >
          {priorities.map((p, i) => (
            <button
              key={p}
              ref={(el) => { optionsRef.current[i] = el }}
              id={`priority-${p}`}
              type="button"
              role="option"
              aria-selected={p === value}
              tabIndex={-1}
              onClick={() => {
                onChange(p)
                setOpen(false)
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-[rgb(var(--surface))] focus:bg-[rgb(var(--surface))] focus:outline-none transition-colors ${
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
  disabled = false,
}: {
  value: Date | null
  onChange: (d: Date | null) => void
  disabled?: boolean
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
        readOnly={disabled}
        aria-label="Task due date"
        className={`bg-transparent text-xs text-[rgb(var(--foreground))] focus:outline-none focus:ring-1 focus:ring-emerald-500 rounded px-2 py-1.5 border border-transparent hover:border-[rgb(var(--border))] ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        title={disabled ? 'Subscription required' : undefined}
      />
    </div>
  )
}

// ── TaskItem ──

function TaskItem({ task }: { task: Task }) {
  const updateTask = useTaskStore((s) => s.updateTask)
  const deleteTask = useTaskStore((s) => s.deleteTask)
  const toggleComplete = useTaskStore((s) => s.toggleComplete)
  const canWrite = useAuthStore((s) => s.canWrite())

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
          onClick={() => canWrite && toggleComplete(task.id)}
          disabled={!canWrite}
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
            task.completed
              ? 'border-emerald-500 bg-emerald-500'
              : 'border-[rgb(var(--muted))]/50 hover:border-emerald-500'
          } ${!canWrite ? 'opacity-50 cursor-not-allowed' : ''}`}
          aria-label={task.completed ? 'Mark incomplete' : 'Mark complete'}
          title={!canWrite ? 'Subscription required' : undefined}
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
                if (!canWrite) return
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
            className="rounded p-1 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 flex items-center justify-center text-[rgb(var(--muted))] md:opacity-0 md:group-hover:opacity-100 hover:text-[rgb(var(--primary))] transition-all focus:outline-none focus:opacity-100 md:p-0.5"
            aria-label="Edit task"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          {canWrite && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setConfirmDelete(true) }}
              className="rounded p-1 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 flex items-center justify-center text-[rgb(var(--muted))] md:opacity-0 md:group-hover:opacity-100 hover:text-red-400 transition-all focus:outline-none focus:opacity-100 md:p-0.5"
              aria-label="Delete task"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-[rgb(var(--border))] px-3 py-3 space-y-3">
          <div className="flex items-center gap-4 flex-wrap">
            <DateInput
              value={task.due_date}
              onChange={(d) => canWrite && updateTask(task.id, { due_date: d })}
              disabled={!canWrite}
            />
            <PrioritySelector
              value={task.priority}
              onChange={(p) => canWrite && updateTask(task.id, { priority: p })}
              disabled={!canWrite}
            />
          </div>
          <textarea
            value={descValue}
            onChange={(e) => setDescValue(e.target.value)}
            onBlur={handleDescBlur}
            placeholder="Add a description..."
            rows={3}
            readOnly={!canWrite}
            className={`w-full resize-none rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--background))] px-3 py-2 text-sm text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] focus:outline-none focus:ring-1 focus:ring-emerald-500 ${!canWrite ? 'opacity-60' : ''}`}
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
  const canWrite = useAuthStore((s) => s.canWrite())
  const tasks = useTaskStore((s) => s.tasks)
  const isLoading = useTaskStore((s) => s.isLoading)
  const isOnline = useSyncStore((s) => s.isOnline)
  const taskLists = useTaskListStore((s) => s.lists)
  const [showDialog, setShowDialog] = useState(false)
  const [editTask, setEditTask] = useState<Task | null>(null)

  // Filter tasks by visible lists
  const visibleListIds = useMemo(() => new Set(taskLists.filter(l => l.visible).map(l => l.id)), [taskLists])
  const filteredTasks = useMemo(
    () => tasks.filter((t) => visibleListIds.has(t.listId ?? 'default')),
    [tasks, visibleListIds],
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
        </div>
        <button
          onClick={() => setShowDialog(true)}
          disabled={!canWrite}
          className={`flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 ${!canWrite ? 'opacity-50 cursor-not-allowed' : 'hover:bg-emerald-500'}`}
          title={!canWrite ? 'Subscription required' : undefined}
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
