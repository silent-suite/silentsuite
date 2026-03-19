'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Trash2, MapPin, Clock, AlignLeft, Repeat, Pencil, Bell, X, CalendarDays } from 'lucide-react'
import { useCalendarStore } from '@/app/stores/use-calendar-store'
import { useCalendarListStore } from '@/app/stores/use-calendar-list-store'
import { RecurrencePicker } from './RecurrencePicker'
import { RecurrenceScopeDialog, type RecurrenceScope } from './RecurrenceScopeDialog'
import type { CalendarEvent, VAlarm } from '@silentsuite/core'
import { buildAlarmTrigger, parseAlarmTriggerMinutes } from '@silentsuite/core'
import { useNotifications } from '@/app/providers/notification-provider'
import { usePreferencesStore } from '@/app/stores/use-preferences-store'
import { useFocusTrap } from '@/app/lib/use-focus-trap'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface EventDialogProps {
  /** 'create' or 'edit' mode */
  mode: 'create' | 'edit'
  /** Pre-filled start date (from clicked time slot) */
  startDate?: Date
  /** Pre-filled end date */
  endDate?: Date
  /** Pre-filled all-day flag */
  allDay?: boolean
  /** Existing event for edit mode */
  event?: CalendarEvent
  /** Instance date for recurring event operations */
  instanceDate?: Date
  /** Close handler */
  onClose: () => void
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

function formatTimeForInput(date: Date): string {
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

function formatDateForInput(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function formatDateForDisplay(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EventDialog({
  mode,
  startDate: initialStartDate,
  endDate: initialEndDate,
  allDay: initialAllDay = false,
  event,
  instanceDate,
  onClose,
}: EventDialogProps) {
  // Store actions
  const createEvent = useCalendarStore((s) => s.createEvent)
  const updateEvent = useCalendarStore((s) => s.updateEvent)
  const deleteEvent = useCalendarStore((s) => s.deleteEvent)
  const updateRecurringEvent = useCalendarStore((s) => s.updateRecurringEvent)
  const deleteRecurringEvent = useCalendarStore((s) => s.deleteRecurringEvent)

  const notifications = useNotifications()
  const defaultReminder = usePreferencesStore((s) => s.defaultReminder)

  // ---------------------------------------------------------------------------
  // Derive initial state
  // ---------------------------------------------------------------------------

  const isEdit = mode === 'edit' && !!event
  const isRecurring = isEdit && !!event.recurrenceRule
  const effectiveInstanceDate = instanceDate ?? event?.startDate ?? new Date()

  const defaultStart = isEdit ? event.startDate : (initialStartDate ?? new Date())
  const defaultEnd = isEdit
    ? event.endDate
    : (initialEndDate ?? new Date(defaultStart.getTime() + 30 * 60 * 1000))

  // ---------------------------------------------------------------------------
  // Form state
  // ---------------------------------------------------------------------------

  const [title, setTitle] = useState(isEdit ? event.title : '')
  const [location, setLocation] = useState(isEdit ? (event.location || '') : '')
  const [description, setDescription] = useState(isEdit ? (event.description || '') : '')
  const [allDay, setAllDay] = useState(isEdit ? event.allDay : initialAllDay)
  const [startDate, setStartDate] = useState(formatDateForInput(defaultStart))
  const [startTime, setStartTime] = useState(formatTimeForInput(defaultStart))
  const [endDate, setEndDate] = useState(formatDateForInput(defaultEnd))
  const [endTime, setEndTime] = useState(formatTimeForInput(defaultEnd))
  const [recurrenceRule, setRecurrenceRule] = useState<string | null>(
    isEdit ? event.recurrenceRule : null,
  )
  const [alarms, setAlarms] = useState<string[]>(() => {
    if (isEdit && event.alarms && event.alarms.length > 0) {
      return event.alarms
        .map((a) => {
          const mins = parseAlarmTriggerMinutes(a.trigger)
          return mins > 0 ? String(mins) : 'none'
        })
        .filter((v) => v !== 'none')
    }
    return defaultReminder !== 'none' ? [defaultReminder] : []
  })

  // Calendar selection
  const calendarLists = useCalendarListStore((s) => s.calendars)
  const defaultCalendarId = useCalendarListStore((s) => s.defaultCalendarId)
  const [selectedCalendarId, setSelectedCalendarId] = useState(
    isEdit ? (event.calendarId ?? defaultCalendarId) : defaultCalendarId,
  )

  // Saving state to prevent double-submission
  const [saving, setSaving] = useState(false)

  // Scope dialog state (recurring edit/delete)
  const [scopeDialog, setScopeDialog] = useState<{
    mode: 'edit' | 'delete'
    pendingPatch?: Partial<CalendarEvent>
  } | null>(null)

  // Refs
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  // Focus trap
  useFocusTrap(dialogRef)

  // ---------------------------------------------------------------------------
  // Auto-focus title input on mount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    // Short delay to ensure the dialog animation has started
    const timer = setTimeout(() => {
      titleRef.current?.focus()
    }, 50)
    return () => clearTimeout(timer)
  }, [])

  // ---------------------------------------------------------------------------
  // Keyboard handler: Escape to close
  // ---------------------------------------------------------------------------

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (scopeDialog) {
          setScopeDialog(null)
          return
        }
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose, scopeDialog])

  // ---------------------------------------------------------------------------
  // Build date objects from form state
  // ---------------------------------------------------------------------------

  const buildStartDate = useCallback((): Date => {
    const [y, m, d] = startDate.split('-').map(Number)
    if (allDay) {
      const dt = new Date(y, m - 1, d, 0, 0, 0, 0)
      return dt
    }
    const [h, min] = startTime.split(':').map(Number)
    return new Date(y, m - 1, d, h, min, 0, 0)
  }, [startDate, startTime, allDay])

  const buildEndDate = useCallback((): Date => {
    const [y, m, d] = endDate.split('-').map(Number)
    if (allDay) {
      const dt = new Date(y, m - 1, d, 23, 59, 59, 0)
      return dt
    }
    const [h, min] = endTime.split(':').map(Number)
    return new Date(y, m - 1, d, h, min, 0, 0)
  }, [endDate, endTime, allDay])

  // ---------------------------------------------------------------------------
  // Save handler
  // ---------------------------------------------------------------------------

  const handleSave = useCallback(async () => {
    if (!title.trim() || saving) return

    const newStart = buildStartDate()
    const newEnd = buildEndDate()

    // Ensure end is after start
    const effectiveEnd = newEnd > newStart ? newEnd : new Date(newStart.getTime() + 30 * 60 * 1000)

    setSaving(true)

    try {
      if (isEdit) {
        const patch: Partial<CalendarEvent> = {}

        if (title.trim() !== event.title) patch.title = title.trim()
        if ((description.trim() || '') !== (event.description || ''))
          patch.description = description.trim()
        if ((location.trim() || '') !== (event.location || '')) patch.location = location.trim()
        if (allDay !== event.allDay) patch.allDay = allDay
        if (newStart.getTime() !== event.startDate.getTime()) patch.startDate = newStart
        if (effectiveEnd.getTime() !== event.endDate.getTime()) patch.endDate = effectiveEnd
        if (recurrenceRule !== event.recurrenceRule) patch.recurrenceRule = recurrenceRule

        // Compare alarms
        const eventAlarms: VAlarm[] = alarms
          .filter((a) => a !== 'none')
          .map((a) => ({
            action: 'DISPLAY' as const,
            trigger: buildAlarmTrigger(parseInt(a)),
            description: title.trim(),
          }))
        const existingTriggers = (event.alarms ?? []).map((a) => a.trigger).sort().join(',')
        const newTriggers = eventAlarms.map((a) => a.trigger).sort().join(',')
        if (existingTriggers !== newTriggers) {
          patch.alarms = eventAlarms
        }

        if (Object.keys(patch).length === 0) {
          // No changes — just close
          onClose()
          return
        }

        if (isRecurring) {
          // Show scope dialog for recurring events
          setScopeDialog({ mode: 'edit', pendingPatch: patch })
          setSaving(false)
          return
        }

        await updateEvent(event.id, patch)
      } else {
        await createEvent({
          title: title.trim(),
          description: description.trim() || undefined,
          location: location.trim() || undefined,
          startDate: newStart,
          endDate: effectiveEnd,
          allDay,
          recurrenceRule,
          calendarId: selectedCalendarId,
          alarms: alarms
            .filter((a) => a !== 'none')
            .map((a) => ({
              action: 'DISPLAY' as const,
              trigger: buildAlarmTrigger(parseInt(a)),
              description: title.trim(),
            })),
        })
      }

      onClose()
    } finally {
      setSaving(false)
    }
  }, [
    title,
    description,
    location,
    allDay,
    recurrenceRule,
    alarms,
    selectedCalendarId,
    saving,
    isEdit,
    isRecurring,
    event,
    buildStartDate,
    buildEndDate,
    createEvent,
    updateEvent,
    onClose,
  ])

  // ---------------------------------------------------------------------------
  // Delete handler
  // ---------------------------------------------------------------------------

  const handleDelete = useCallback(() => {
    if (!isEdit) return

    if (isRecurring) {
      setScopeDialog({ mode: 'delete' })
    } else {
      void deleteEvent(event.id)
      onClose()
    }
  }, [isEdit, isRecurring, event, deleteEvent, onClose])

  // ---------------------------------------------------------------------------
  // Scope dialog confirm / cancel
  // ---------------------------------------------------------------------------

  const handleScopeConfirm = useCallback(
    (scope: RecurrenceScope) => {
      if (!scopeDialog || !isEdit) return

      if (scopeDialog.mode === 'delete') {
        void deleteRecurringEvent(event.id, scope, effectiveInstanceDate)
        setScopeDialog(null)
        onClose()
      } else if (scopeDialog.mode === 'edit' && scopeDialog.pendingPatch) {
        void updateRecurringEvent(
          event.id,
          scopeDialog.pendingPatch,
          scope,
          effectiveInstanceDate,
        )
        setScopeDialog(null)
        onClose()
      }
    },
    [
      scopeDialog,
      isEdit,
      event,
      effectiveInstanceDate,
      updateRecurringEvent,
      deleteRecurringEvent,
      onClose,
    ],
  )

  const handleScopeCancel = useCallback(() => {
    setScopeDialog(null)
  }, [])

  // ---------------------------------------------------------------------------
  // Date/time change handlers
  // ---------------------------------------------------------------------------

  const handleStartDateChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value
      setStartDate(value)
      // If end date is before start date, push it forward
      if (value > endDate) {
        setEndDate(value)
      }
    },
    [endDate],
  )

  const handleStartTimeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value
      setStartTime(value)
      // Auto-adjust end time to 30 min after start if on same day
      if (startDate === endDate) {
        const [h, m] = value.split(':').map(Number)
        const newEnd = new Date(2000, 0, 1, h, m + 30)
        setEndTime(formatTimeForInput(newEnd))
      }
    },
    [startDate, endDate],
  )

  const handleEndDateChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setEndDate(e.target.value)
  }, [])

  const handleEndTimeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setEndTime(e.target.value)
  }, [])

  const handleAllDayToggle = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setAllDay(e.target.checked)
  }, [])

  // ---------------------------------------------------------------------------
  // Title Enter key — save in create mode
  // ---------------------------------------------------------------------------

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        if (title.trim()) {
          void handleSave()
        }
      }
    },
    [title, handleSave],
  )

  // ---------------------------------------------------------------------------
  // Subtitle text
  // ---------------------------------------------------------------------------

  const subtitle = (() => {
    if (allDay) {
      const sd = formatDateForDisplay(buildStartDate())
      const ed = formatDateForDisplay(buildEndDate())
      return startDate === endDate ? sd : `${sd} – ${ed}`
    }
    const s = buildStartDate()
    const e = buildEndDate()
    if (startDate === endDate) {
      return `${formatDateForDisplay(s)}, ${formatTime(s)} – ${formatTime(e)}`
    }
    return `${formatDateForDisplay(s)}, ${formatTime(s)} – ${formatDateForDisplay(e)}, ${formatTime(e)}`
  })()

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const canSave = title.trim().length > 0

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[60] bg-black/40 transition-opacity"
        onClick={onClose}
      />

      {/* Dialog container — centered on desktop, full-screen on mobile */}
      <div className="fixed inset-0 z-[61] flex items-center justify-center p-0 sm:p-4">
        <div
          ref={dialogRef}
          role="dialog"
          aria-label={isEdit ? 'Edit event' : 'New event'}
          aria-modal="true"
          className="flex h-full w-full flex-col bg-[rgb(var(--background))] sm:h-auto sm:max-h-[85vh] sm:w-full sm:max-w-md sm:rounded-xl sm:border sm:border-[rgb(var(--border))] sm:shadow-xl"
        >
          {/* ----------------------------------------------------------------- */}
          {/* Header: Cancel | Title + Subtitle | Done                          */}
          {/* ----------------------------------------------------------------- */}
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[rgb(var(--border))] px-4 py-3">
            {/* Cancel button */}
            <button
              onClick={onClose}
              className="shrink-0 rounded-md px-2 py-1 text-sm text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500"
            >
              Cancel
            </button>

            {/* Center title + subtitle */}
            <div className="flex min-w-0 flex-1 flex-col items-center">
              <span className="text-sm font-semibold text-[rgb(var(--foreground))]">
                {isEdit ? 'Edit Event' : 'New Event'}
              </span>
              <span className="max-w-full truncate text-xs text-[rgb(var(--muted))]">
                {subtitle}
              </span>
            </div>

            {/* Done button */}
            <button
              onClick={() => void handleSave()}
              disabled={!canSave || saving}
              className="shrink-0 rounded-md bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2"
            >
              {saving ? 'Saving…' : 'Done'}
            </button>
          </div>

          {/* ----------------------------------------------------------------- */}
          {/* Body — scrollable                                                 */}
          {/* ----------------------------------------------------------------- */}
          <div className="flex-1 overflow-y-auto">
            <div className="px-4 py-4 flex flex-col gap-4">
              {/* ---- Title input ---- */}
              <div className="flex items-center gap-3">
                <Pencil className="h-4 w-4 shrink-0 text-[rgb(var(--muted))]" />
                <input
                  ref={titleRef}
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={handleTitleKeyDown}
                  placeholder="Event title"
                  aria-label="Event title"
                  className="flex-1 rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-3 py-2 text-sm text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              {/* ---- Location input ---- */}
              <div className="flex items-center gap-3">
                <MapPin className="h-4 w-4 shrink-0 text-[rgb(var(--muted))]" />
                <input
                  type="text"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="Add location"
                  aria-label="Event location"
                  className="flex-1 rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-3 py-2 text-sm text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              {/* ---- Calendar selector ---- */}
              {calendarLists.length > 1 && (
                <div className="flex items-center gap-3">
                  <CalendarDays className="h-4 w-4 shrink-0 text-[rgb(var(--muted))]" />
                  <select
                    value={selectedCalendarId}
                    onChange={(e) => setSelectedCalendarId(e.target.value)}
                    aria-label="Calendar"
                    className="flex-1 rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-3 py-2 text-sm text-[rgb(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  >
                    {calendarLists.map((cal) => (
                      <option key={cal.id} value={cal.id}>
                        {cal.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* ---- Divider ---- */}
              <div className="border-t border-[rgb(var(--border))]" />

              {/* ---- Schedule section ---- */}
              <div className="flex flex-col gap-3">
                <span className="text-xs font-semibold uppercase tracking-wide text-[rgb(var(--muted))]">
                  Schedule
                </span>

                {/* All Day toggle */}
                <label className="flex items-center justify-between cursor-pointer">
                  <div className="flex items-center gap-3">
                    <Clock className="h-4 w-4 shrink-0 text-[rgb(var(--muted))]" />
                    <span className="text-sm text-[rgb(var(--foreground))]">All Day</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={allDay}
                    onChange={handleAllDayToggle}
                    className="h-4 w-4 rounded border-[rgb(var(--border))] accent-emerald-500"
                  />
                </label>

                {/* Starts row */}
                <div className="flex items-center gap-3">
                  <div className="h-4 w-4 shrink-0" /> {/* spacer to align with icons */}
                  <div className="flex flex-1 items-center justify-between gap-2">
                    <span className="text-sm text-[rgb(var(--muted))]">Starts</span>
                    <div className="flex items-center gap-2">
                      <input
                        type="date"
                        value={startDate}
                        onChange={handleStartDateChange}
                        aria-label="Start date"
                        className="rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-2 py-1.5 text-xs text-[rgb(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                      {!allDay && (
                        <input
                          type="time"
                          value={startTime}
                          onChange={handleStartTimeChange}
                          aria-label="Start time"
                          className="w-[6.5rem] rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-2 py-1.5 text-xs text-[rgb(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                      )}
                    </div>
                  </div>
                </div>

                {/* Ends row */}
                <div className="flex items-center gap-3">
                  <div className="h-4 w-4 shrink-0" /> {/* spacer */}
                  <div className="flex flex-1 items-center justify-between gap-2">
                    <span className="text-sm text-[rgb(var(--muted))]">Ends</span>
                    <div className="flex items-center gap-2">
                      <input
                        type="date"
                        value={endDate}
                        onChange={handleEndDateChange}
                        aria-label="End date"
                        className="rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-2 py-1.5 text-xs text-[rgb(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                      {!allDay && (
                        <input
                          type="time"
                          value={endTime}
                          onChange={handleEndTimeChange}
                          aria-label="End time"
                          className="w-[6.5rem] rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-2 py-1.5 text-xs text-[rgb(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                      )}
                    </div>
                  </div>
                </div>

                {/* Repeat row */}
                <div className="flex items-start gap-3">
                  <Repeat className="mt-1.5 h-4 w-4 shrink-0 text-[rgb(var(--muted))]" />
                  <div className="flex-1">
                    <RecurrencePicker value={recurrenceRule} onChange={setRecurrenceRule} />
                  </div>
                </div>

                {/* ---- Notifications section ---- */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Bell className="h-4 w-4 shrink-0 text-[rgb(var(--muted))]" />
                      <span className="text-sm text-[rgb(var(--foreground))]">Reminders</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setAlarms((prev) => [...prev, '15'])}
                      className="text-xs text-emerald-500 hover:text-emerald-400 transition-colors"
                    >
                      + Add
                    </button>
                  </div>

                  {alarms.length === 0 && (
                    <div className="ml-7 text-xs text-[rgb(var(--muted))]">No reminders</div>
                  )}

                  {alarms.map((alarm, i) => (
                    <div key={i} className="flex items-center gap-2 ml-7">
                      <select
                        value={alarm}
                        onChange={(e) => {
                          const next = [...alarms]
                          next[i] = e.target.value
                          setAlarms(next)
                        }}
                        className="flex-1 rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-2 py-1.5 text-xs text-[rgb(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-emerald-500"
                      >
                        <option value="5">5 minutes before</option>
                        <option value="15">15 minutes before</option>
                        <option value="30">30 minutes before</option>
                        <option value="60">1 hour before</option>
                        <option value="1440">1 day before</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => setAlarms((prev) => prev.filter((_, j) => j !== i))}
                        className="rounded p-1 text-[rgb(var(--muted))] hover:text-red-500 transition-colors"
                        aria-label="Remove reminder"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>

                {/* Notification permission prompt */}
                {alarms.length > 0 && notifications.permission === 'default' && (
                  <div className="ml-7 flex items-center gap-2 rounded-md bg-amber-500/10 border border-amber-500/20 px-3 py-2">
                    <span className="text-xs text-amber-600 dark:text-amber-400">
                      Allow notifications to get reminders in this browser
                    </span>
                    <button
                      type="button"
                      onClick={() => void notifications.requestPermission()}
                      className="rounded bg-amber-500 px-2 py-0.5 text-xs font-medium text-white hover:bg-amber-600 transition-colors"
                    >
                      Allow
                    </button>
                  </div>
                )}
              </div>

              {/* ---- Divider ---- */}
              <div className="border-t border-[rgb(var(--border))]" />

              {/* ---- Description textarea ---- */}
              <div className="flex items-start gap-3">
                <AlignLeft className="mt-2 h-4 w-4 shrink-0 text-[rgb(var(--muted))]" />
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Add description"
                  aria-label="Event description"
                  rows={3}
                  className="flex-1 resize-none rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-3 py-2 text-sm text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
            </div>
          </div>

          {/* ----------------------------------------------------------------- */}
          {/* Footer: Delete button (edit mode only)                            */}
          {/* ----------------------------------------------------------------- */}
          {isEdit && (
            <div className="shrink-0 border-t border-[rgb(var(--border))] px-4 py-3">
              <button
                onClick={handleDelete}
                className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm text-red-500 hover:bg-red-500/10 transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
              >
                <Trash2 className="h-4 w-4" />
                Delete event
              </button>
            </div>
          )}
        </div>
      </div>

      {/* RecurrenceScopeDialog for recurring events */}
      {scopeDialog && (
        <RecurrenceScopeDialog
          mode={scopeDialog.mode}
          onConfirm={handleScopeConfirm}
          onCancel={handleScopeCancel}
        />
      )}
    </>
  )
}
