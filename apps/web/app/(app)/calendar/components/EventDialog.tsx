'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Trash2, MapPin, Clock, AlignLeft, Repeat, Pencil, Bell, X, CalendarDays, Tag } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { LabelEditor } from '@/app/components/LabelEditor'
import { useCalendarStore } from '@/app/stores/use-calendar-store'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { useCalendarListStore } from '@/app/stores/use-calendar-list-store'
import { RecurrencePicker } from './RecurrencePicker'
import { RecurrenceScopeDialog, type RecurrenceScope } from './RecurrenceScopeDialog'
import type { CalendarEvent, DateFormat, VAlarm } from '@silentsuite/core'
import { buildAlarmTrigger, parseAlarmTriggerMinutes } from '@silentsuite/core'
import { useNotifications } from '@/app/providers/notification-provider'
import { usePreferencesStore } from '@/app/stores/use-preferences-store'
import { formatDate } from '@/app/lib/date'
import { Globe } from 'lucide-react'
import {
  formatDateForInputInZone,
  formatTimeForInputInZone,
  instantFromWallClock,
  resolveUserTimezone,
  shortTimezoneLabel,
} from '@/app/lib/tz'
import { inclusiveAllDayEndDate } from '../lib/all-day'

// ---------------------------------------------------------------------------
// Time formatting (respects user preference)
// ---------------------------------------------------------------------------

function makeFormatTime(hour12: boolean, tz: string) {
  return function formatTime(date: Date): string {
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12,
      timeZone: tz,
    })
  }
}
import { useFocusTrap } from '@/app/lib/use-focus-trap'

type EventTimeFormat = '12h' | '24h'

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

// formatTime is created per-render via makeFormatTime — see below

/** All-day events have undefined event.timezone and are stored as local-midnight
 * Date objects, so their wall-clock components are read in browser-local. Timed
 * events use the event's TZ (or user default) to read/write wall-clock components. */
function formatTimeForInput(date: Date, tz: string | undefined): string {
  if (!tz) {
    const h = String(date.getHours()).padStart(2, '0')
    const m = String(date.getMinutes()).padStart(2, '0')
    return `${h}:${m}`
  }
  return formatTimeForInputInZone(date, tz)
}

function normalizeTimeFormat(timeFormat: string): EventTimeFormat {
  return timeFormat === '24h' ? '24h' : '12h'
}

export function formatEventTimeInput(value: string, timeFormat: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) return value

  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return value

  if (normalizeTimeFormat(timeFormat) === '24h') {
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  }

  const meridiem = hour >= 12 ? 'PM' : 'AM'
  const displayHour = hour % 12 === 0 ? 12 : hour % 12
  return `${displayHour}:${String(minute).padStart(2, '0')} ${meridiem}`
}

export function parseEventTimeInput(input: string, timeFormat: string): string | null {
  const value = input.trim().replace(/\s+/g, ' ')
  if (!value) return null

  const meridiemMatch = /^(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?m\.?$/i.exec(value)
  if (meridiemMatch) {
    const rawHour = Number(meridiemMatch[1])
    const minute = Number(meridiemMatch[2] ?? '00')
    if (rawHour < 1 || rawHour > 12) return null
    const meridiem = meridiemMatch[3]!.toLowerCase()
    const hour = meridiem === 'p' ? (rawHour % 12) + 12 : rawHour % 12
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  }

  const twentyFourHourMatch = /^(\d{1,2}):([0-5]\d)$/.exec(value)
  if (!twentyFourHourMatch) return null

  const hour = Number(twentyFourHourMatch[1])
  const minute = Number(twentyFourHourMatch[2])
  if (hour > 23) return null

  if (normalizeTimeFormat(timeFormat) === '12h' && hour >= 1 && hour <= 12) {
    return null
  }

  // 12-hour users may still paste or type a stored 24-hour HH:mm value;
  // normalize it back to storage format and let the display formatter add AM/PM.
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function effectiveDateFormat(dateFormat: DateFormat): Exclude<DateFormat, 'system'> {
  return dateFormat === 'system' ? 'YYYY-MM-DD' : dateFormat
}

export function dateFormatExample(dateFormat: DateFormat): string {
  return formatEventDateInput('2026-06-09', dateFormat)
}

export function formatEventDateInput(isoDate: string, dateFormat: DateFormat): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)
  if (!match) return isoDate
  const [, y, m, d] = match

  switch (effectiveDateFormat(dateFormat)) {
    case 'DD/MM/YYYY':
      return `${d}/${m}/${y}`
    case 'MM/DD/YYYY':
      return `${m}/${d}/${y}`
    case 'DD.MM.YYYY':
      return `${d}.${m}.${y}`
    case 'YYYY/MM/DD':
      return `${y}/${m}/${d}`
    case 'YYYY-MM-DD':
      return `${y}-${m}-${d}`
  }
}

function isValidIsoDate(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > 31) return false
  const date = new Date(y, m - 1, d)
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d
}

export function parseEventDateInput(input: string, dateFormat: DateFormat): string | null {
  const value = input.trim()
  if (!value) return null

  const format = effectiveDateFormat(dateFormat)
  const separator = format.includes('.') ? '\\.' : format.includes('/') ? '/' : '-'
  const match = new RegExp(`^(\\d{1,4})${separator}(\\d{1,2})${separator}(\\d{1,4})$`).exec(value)
  if (!match) return null

  const a = Number(match[1])
  const b = Number(match[2])
  const c = Number(match[3])
  let y: number
  let m: number
  let d: number

  switch (format) {
    case 'DD/MM/YYYY':
    case 'DD.MM.YYYY':
      d = a; m = b; y = c
      break
    case 'MM/DD/YYYY':
      m = a; d = b; y = c
      break
    case 'YYYY/MM/DD':
    case 'YYYY-MM-DD':
      y = a; m = b; d = c
      break
  }

  if (y < 1000 || !isValidIsoDate(y, m, d)) return null
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

const PRESET_ALARM_MINUTES = ['5', '15', '30', '60', '1440'] as const

function isPresetAlarm(value: string): boolean {
  return PRESET_ALARM_MINUTES.includes(value as typeof PRESET_ALARM_MINUTES[number])
}

function normalizeAlarmMinutes(value: string): string | null {
  const minutes = Number(value)
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 525600) return null
  return String(minutes)
}

function alarmLabel(value: string): string {
  if (value === '60') return '1 hour before'
  if (value === '1440') return '1 day before'
  return `${value} minutes before`
}

function alarmToVAlarm(minutes: string, title: string): VAlarm | null {
  const normalized = normalizeAlarmMinutes(minutes)
  if (!normalized) return null
  return {
    action: 'DISPLAY' as const,
    trigger: buildAlarmTrigger(Number(normalized)),
    description: title.trim(),
  }
}

function formatDateForInput(date: Date, tz: string | undefined): string {
  if (!tz) {
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  return formatDateForInputInZone(date, tz)
}

function formatDateForDisplay(date: Date, tz: string | undefined): string {
  const pref = usePreferencesStore.getState().dateFormat
  if (pref === 'system') {
    return date.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      ...(tz ? { timeZone: tz } : {}),
    })
  }

  const weekday = date.toLocaleDateString(undefined, { weekday: 'short', ...(tz ? { timeZone: tz } : {}) })
  const datePart = formatDate(date, pref)
  return `${weekday} ${datePart}`
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

  const canWrite = useAuthStore((s) => s.canWrite())
  const notifications = useNotifications()
  const t = useTranslations('Labels')
  const defaultReminder = usePreferencesStore((s) => s.defaultReminder)
  const timeFormat = usePreferencesStore((s) => s.timeFormat)
  const dateFormat = usePreferencesStore((s) => s.dateFormat)
  const defaultTimezonePref = usePreferencesStore((s) => s.defaultTimezone)
  const userTz = resolveUserTimezone(defaultTimezonePref)
  const defaultTimezone = userTz

  // ---------------------------------------------------------------------------
  // Derive initial state
  // ---------------------------------------------------------------------------

  const isEdit = mode === 'edit' && !!event
  const isRecurring = isEdit && !!event.recurrenceRule
  const effectiveInstanceDate = instanceDate ?? event?.startDate ?? new Date()

  const defaultStart = isEdit ? event.startDate : (initialStartDate ?? new Date())
  // For all-day events, `event.endDate` follows iCal DTEND;VALUE=DATE convention
  // (exclusive — the day *after* the last day of the event). The form picker shows
  // the inclusive last day, so subtract one day before formatting.
  const defaultEnd = isEdit
    ? (event.allDay ? inclusiveAllDayEndDate(event.endDate) : event.endDate)
    : (initialEndDate ?? new Date(defaultStart.getTime() + 30 * 60 * 1000))

  // Initial all-day flag — needed before form state so we can pick the right
  // TZ for formatting the initial date/time strings.
  const initialIsAllDay = isEdit ? event.allDay : initialAllDay
  const initialFormTz: string | undefined = initialIsAllDay
    ? undefined
    : isEdit
      ? (event.timezone ?? userTz)
      : userTz

  // ---------------------------------------------------------------------------
  // Form state
  // ---------------------------------------------------------------------------

  const [title, setTitle] = useState(isEdit ? event.title : '')
  const [location, setLocation] = useState(isEdit ? (event.location || '') : '')
  const [description, setDescription] = useState(isEdit ? (event.description || '') : '')
  const [allDay, setAllDay] = useState(initialIsAllDay)
  const initialStartTime = formatTimeForInput(defaultStart, initialFormTz)
  const initialEndTime = formatTimeForInput(defaultEnd, initialFormTz)
  const initialStartDateIso = formatDateForInput(defaultStart, initialFormTz)
  const initialEndDateIso = formatDateForInput(defaultEnd, initialFormTz)
  const [startDate, setStartDate] = useState(initialStartDateIso)
  const [startDateInput, setStartDateInput] = useState(() => formatEventDateInput(initialStartDateIso, dateFormat))
  const [startDateError, setStartDateError] = useState<string | null>(null)
  const [startTime, setStartTime] = useState(initialStartTime)
  const [startTimeInput, setStartTimeInput] = useState(() => formatEventTimeInput(initialStartTime, timeFormat))
  const [endDate, setEndDate] = useState(initialEndDateIso)
  const [endDateInput, setEndDateInput] = useState(() => formatEventDateInput(initialEndDateIso, dateFormat))
  const [endDateError, setEndDateError] = useState<string | null>(null)
  const [endTime, setEndTime] = useState(initialEndTime)
  const [endTimeInput, setEndTimeInput] = useState(() => formatEventTimeInput(initialEndTime, timeFormat))
  const [recurrenceRule, setRecurrenceRule] = useState<string | null>(
    isEdit ? event.recurrenceRule : null,
  )
  const [categories, setCategories] = useState<string[]>(
    isEdit ? (event.categories ?? []) : [],
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

  // Timezone state — per-event override, defaults to user preference
  const [timezone, setTimezone] = useState(
    isEdit ? (event.timezone ?? defaultTimezone) : defaultTimezone,
  )
  // Active TZ for form fields and subtitle: undefined for all-day (local-midnight)
  // semantics, otherwise the picker's value.
  const formTz: string | undefined = allDay ? undefined : timezone
  const formatTime = makeFormatTime(timeFormat !== '24h', formTz ?? userTz)
  const allTimezones = (() => {
    try { return Intl.supportedValuesOf('timeZone') } catch { return ['UTC'] }
  })()

  useEffect(() => {
    setStartTimeInput(formatEventTimeInput(startTime, timeFormat))
  }, [startTime, timeFormat])

  useEffect(() => {
    setEndTimeInput(formatEventTimeInput(endTime, timeFormat))
  }, [endTime, timeFormat])

  useEffect(() => {
    if (!startDateError) setStartDateInput(formatEventDateInput(startDate, dateFormat))
    if (!endDateError) setEndDateInput(formatEventDateInput(endDate, dateFormat))
    // Re-render displayed dates when the account preference changes; regular
    // typing is normalized on blur so partial-but-valid entries are not clobbered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFormat])

  // Calendar selection
  const calendarLists = useCalendarListStore((s) => s.calendars)
  const defaultCalendarId = useCalendarListStore((s) => s.defaultCalendarId)
  const [selectedCalendarId, setSelectedCalendarId] = useState(
    isEdit ? (event.calendarId ?? defaultCalendarId) : defaultCalendarId,
  )

  useEffect(() => {
    if (isEdit || calendarLists.length === 0) return
    if (calendarLists.some((calendar) => calendar.id === selectedCalendarId)) return
    setSelectedCalendarId(
      calendarLists.some((calendar) => calendar.id === defaultCalendarId)
        ? defaultCalendarId
        : calendarLists[0]!.id,
    )
  }, [calendarLists, defaultCalendarId, isEdit, selectedCalendarId])

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
      // All-day events stored as browser-local midnight; matches how the
      // import path and core ical parser handle DATE-only DTSTART.
      return new Date(y, m - 1, d, 0, 0, 0, 0)
    }
    const [h, min] = startTime.split(':').map(Number)
    return instantFromWallClock(y, m, d, h, min, timezone)
  }, [startDate, startTime, allDay, timezone])

  const buildEndDate = useCallback((): Date => {
    const [y, m, d] = endDate.split('-').map(Number)
    if (allDay) {
      // RFC 5545: VALUE=DATE DTEND is exclusive — i.e. the day after the last day
      // of the event. Stored as the next day's local-midnight to match how the
      // ical parser surfaces DTEND for events synced from upstream.
      return new Date(y, m - 1, d + 1, 0, 0, 0, 0)
    }
    const [h, min] = endTime.split(':').map(Number)
    return instantFromWallClock(y, m, d, h, min, timezone)
  }, [endDate, endTime, allDay, timezone])

  // ---------------------------------------------------------------------------
  // Save handler
  // ---------------------------------------------------------------------------

  const handleSave = useCallback(async () => {
    if (!title.trim() || saving) return
    if (startDateError || endDateError) return

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
        if (JSON.stringify(categories) !== JSON.stringify(event.categories ?? [])) patch.categories = categories
        if (timezone !== (event.timezone ?? defaultTimezone)) patch.timezone = timezone
        if (selectedCalendarId !== (event.calendarId ?? defaultCalendarId)) patch.calendarId = selectedCalendarId

        // Compare alarms
        const eventAlarms: VAlarm[] = alarms
          .map((a) => alarmToVAlarm(a, title))
          .filter((a): a is VAlarm => a !== null)
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
          categories,
          timezone,
          calendarId: selectedCalendarId,
          alarms: alarms
            .map((a) => alarmToVAlarm(a, title))
            .filter((a): a is VAlarm => a !== null),
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
    categories,
    alarms,
    selectedCalendarId,
    timezone,
    defaultTimezone,
    saving,
    startDateError,
    endDateError,
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
      setStartDateInput(value)
      const parsedDate = parseEventDateInput(value, dateFormat)
      if (!parsedDate) {
        setStartDateError(`Use ${dateFormatExample(dateFormat)} format`)
        return
      }

      setStartDateError(null)
      setStartDate(parsedDate)
      // If end date is before start date, push it forward
      if (parsedDate > endDate) {
        setEndDate(parsedDate)
        setEndDateInput(formatEventDateInput(parsedDate, dateFormat))
        setEndDateError(null)
      }
    },
    [dateFormat, endDate],
  )

  const handleStartTimeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value
      setStartTimeInput(value)
      const parsedTime = parseEventTimeInput(value, timeFormat)
      if (!parsedTime) return

      setStartTime(parsedTime)
      // Auto-adjust end time to 30 min after start if on same day. Pure HH:MM
      // arithmetic via a synthetic local Date; format back as browser-local
      // since we only need the wall-clock string back.
      if (startDate === endDate) {
        const [h, m] = parsedTime.split(':').map(Number)
        const newEnd = new Date(2000, 0, 1, h, m + 30)
        setEndTime(formatTimeForInput(newEnd, undefined))
      }
    },
    [startDate, endDate, timeFormat],
  )

  const handleEndDateChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setEndDateInput(value)
    const parsedDate = parseEventDateInput(value, dateFormat)
    if (!parsedDate) {
      setEndDateError(`Use ${dateFormatExample(dateFormat)} format`)
      return
    }

    setEndDateError(null)
    setEndDate(parsedDate)
  }, [dateFormat])

  const handleEndTimeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setEndTimeInput(value)
    const parsedTime = parseEventTimeInput(value, timeFormat)
    if (parsedTime) setEndTime(parsedTime)
  }, [timeFormat])

  const handleStartTimeBlur = useCallback(() => {
    setStartTimeInput(formatEventTimeInput(startTime, timeFormat))
  }, [startTime, timeFormat])

  const handleEndTimeBlur = useCallback(() => {
    setEndTimeInput(formatEventTimeInput(endTime, timeFormat))
  }, [endTime, timeFormat])

  const handleStartDateBlur = useCallback(() => {
    if (!startDateError) setStartDateInput(formatEventDateInput(startDate, dateFormat))
  }, [dateFormat, startDate, startDateError])

  const handleEndDateBlur = useCallback(() => {
    if (!endDateError) setEndDateInput(formatEventDateInput(endDate, dateFormat))
  }, [dateFormat, endDate, endDateError])

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
      const sd = formatDateForDisplay(buildStartDate(), undefined)
      // buildEndDate returns iCal-exclusive next-day midnight; subtract a day for human display.
      const ed = formatDateForDisplay(inclusiveAllDayEndDate(buildEndDate()), undefined)
      return startDate === endDate ? sd : `${sd} – ${ed}`
    }
    const s = buildStartDate()
    const e = buildEndDate()
    if (startDate === endDate) {
      return `${formatDateForDisplay(s, formTz)}, ${formatTime(s)} – ${formatTime(e)}`
    }
    return `${formatDateForDisplay(s, formTz)}, ${formatTime(s)} – ${formatDateForDisplay(e, formTz)}, ${formatTime(e)}`
  })()

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const canSave = title.trim().length > 0 && !startDateError && !endDateError
  const datePlaceholder = dateFormatExample(dateFormat)
  const focusRing = 'focus:outline-none focus:ring-2 focus:ring-emerald-500/80 focus:ring-offset-2 focus:ring-offset-[rgb(var(--background))]'
  const fieldClass = `min-h-11 rounded-xl border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-3.5 py-2.5 text-sm text-[rgb(var(--foreground))] shadow-sm shadow-black/5 transition-colors placeholder:text-[rgb(var(--muted))] hover:border-emerald-500/40 focus:border-emerald-500 ${focusRing}`
  const compactFieldClass = `min-h-10 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] px-3 py-2 text-sm text-[rgb(var(--foreground))] shadow-sm shadow-black/5 transition-colors hover:border-emerald-500/40 focus:border-emerald-500 ${focusRing}`
  const disabledClass = !canWrite ? 'opacity-60 cursor-not-allowed' : ''
  const sectionClass = 'rounded-2xl border border-[rgb(var(--border))] bg-[rgb(var(--surface))]/55 p-4 shadow-sm shadow-black/5 dark:bg-white/[0.03]'
  const sectionTitleClass = 'text-[11px] font-semibold uppercase tracking-[0.16em] text-[rgb(var(--muted))]'
  const iconClass = 'h-4 w-4 shrink-0 text-emerald-500/80'

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[200] bg-slate-950/55 backdrop-blur-sm transition-opacity dark:bg-black/75"
        aria-hidden="true"
        onClick={onClose}
      />

      {/* Dialog container — centered on desktop, full-screen on mobile */}
      <div className="fixed inset-0 z-[201] flex items-end justify-center p-0 sm:items-center sm:p-6">
        <div
          ref={dialogRef}
          role="dialog"
          aria-label={isEdit ? 'Edit event' : 'New event'}
          aria-modal="true"
          className="flex h-full w-full flex-col overflow-hidden bg-[rgb(var(--background))] text-[rgb(var(--foreground))] shadow-2xl shadow-black/25 pb-[env(safe-area-inset-bottom)] sm:h-auto sm:max-h-[88vh] sm:w-full sm:max-w-2xl sm:rounded-3xl sm:border sm:border-[rgb(var(--border))] dark:shadow-black/60"
        >
          {/* Mobile drag handle / swipe indicator */}
          <div className="flex justify-center bg-[rgb(var(--background))] pt-2 sm:hidden" aria-hidden="true">
            <div className="h-1.5 w-12 rounded-full bg-[rgb(var(--border))]" />
          </div>

          {/* Header */}
          <div className="sticky top-0 z-10 shrink-0 border-b border-[rgb(var(--border))] bg-[rgb(var(--background))]/95 px-4 py-4 pt-[max(1rem,env(safe-area-inset-top))] backdrop-blur sm:px-6">
            <div className="flex items-center justify-between gap-3">
              <button
                onClick={onClose}
                className={`shrink-0 rounded-full border border-transparent px-3 py-2 text-sm font-medium text-[rgb(var(--muted))] transition-colors hover:border-[rgb(var(--border))] hover:bg-[rgb(var(--surface))] hover:text-[rgb(var(--foreground))] ${focusRing}`}
              >
                Cancel
              </button>

              <div className="flex min-w-0 flex-1 flex-col items-center px-1 text-center">
                <span className="text-base font-semibold tracking-tight text-[rgb(var(--foreground))]">
                  {isEdit ? 'Edit event' : 'New event'}
                </span>
                <span className="mt-0.5 max-w-full truncate text-xs text-[rgb(var(--muted))] sm:text-sm">
                  {subtitle}
                </span>
              </div>

              <button
                onClick={() => void handleSave()}
                disabled={!canSave || saving || !canWrite}
                className={`shrink-0 rounded-full bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-emerald-950/20 transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`}
                title={!canWrite ? 'Subscription required' : undefined}
              >
                {saving ? 'Saving…' : 'Done'}
              </button>
            </div>
          </div>

          {/* Body — scrollable */}
          <div className="flex-1 overflow-y-auto overscroll-contain">
            <div className="flex flex-col gap-4 px-4 py-5 sm:px-6 sm:py-6">
              {/* Details */}
              <section className={`${sectionClass} space-y-4`}>
                <div className="flex items-center gap-2">
                  <Pencil className={iconClass} />
                  <span className={sectionTitleClass}>Details</span>
                </div>

                <input
                  ref={titleRef}
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={handleTitleKeyDown}
                  placeholder="Event title"
                  aria-label="Event title"
                  readOnly={!canWrite}
                  className={`w-full ${fieldClass} text-base font-medium ${disabledClass}`}
                />

                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                  <div className="flex items-center gap-2 rounded-xl border border-[rgb(var(--border))] bg-[rgb(var(--background))]/60 px-3 py-2.5">
                    <MapPin className={iconClass} />
                    <input
                      type="text"
                      value={location}
                      onChange={(e) => setLocation(e.target.value)}
                      placeholder="Add location"
                      aria-label="Event location"
                      readOnly={!canWrite}
                      className={`min-w-0 flex-1 bg-transparent text-sm text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] ${focusRing} ${disabledClass}`}
                    />
                  </div>

                  <div className="flex items-start gap-2 rounded-xl border border-[rgb(var(--border))] bg-[rgb(var(--background))]/60 px-3 py-2.5 sm:min-w-[14rem]">
                    <Tag className={`${iconClass} mt-1`} />
                    <div className="min-w-0 flex-1">
                      <LabelEditor
                        labels={categories}
                        onChange={setCategories}
                        disabled={!canWrite}
                        aria-label={t('eventLabels')}
                      />
                    </div>
                  </div>
                </div>

                {calendarLists.length > 0 && (
                  <div className="flex flex-col gap-2 rounded-xl border border-[rgb(var(--border))] bg-[rgb(var(--background))]/60 px-3 py-3">
                    <div className="flex items-center gap-2">
                      <CalendarDays className={iconClass} />
                      <span className="text-sm font-medium text-[rgb(var(--foreground))]">Calendar</span>
                    </div>
                    <div className="flex flex-wrap gap-2 pl-0 sm:pl-6">
                      {calendarLists.map((cal) => (
                        <button
                          key={cal.id}
                          type="button"
                          onClick={() => setSelectedCalendarId(cal.id)}
                          className={`inline-flex min-h-9 items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${focusRing} ${
                            selectedCalendarId === cal.id
                              ? 'border-transparent text-white shadow-sm shadow-black/10'
                              : 'border-[rgb(var(--border))] bg-[rgb(var(--surface))] text-[rgb(var(--muted))] hover:border-emerald-500/40 hover:text-[rgb(var(--foreground))]'
                          }`}
                          style={selectedCalendarId === cal.id ? { backgroundColor: cal.color } : undefined}
                        >
                          <div
                            className="h-2.5 w-2.5 rounded-full ring-1 ring-white/40"
                            style={{ backgroundColor: cal.color }}
                          />
                          {cal.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </section>

              {/* Schedule section */}
              <section className={`${sectionClass} space-y-4`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Clock className={iconClass} />
                    <span className={sectionTitleClass}>Schedule</span>
                  </div>
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-[rgb(var(--border))] bg-[rgb(var(--background))]/70 px-3 py-2 text-sm font-medium text-[rgb(var(--foreground))] transition-colors hover:border-emerald-500/40">
                    <input
                      type="checkbox"
                      checked={allDay}
                      onChange={handleAllDayToggle}
                      disabled={!canWrite}
                      className={`h-4 w-4 rounded border-[rgb(var(--border))] accent-emerald-500 ${disabledClass}`}
                    />
                    All day
                  </label>
                </div>

                <div className="grid gap-3">
                  <div className="rounded-xl border border-[rgb(var(--border))] bg-[rgb(var(--background))]/60 p-3">
                    <div className="grid gap-2 sm:grid-cols-[5rem_minmax(0,1fr)_7.5rem] sm:items-center">
                      <span className="text-sm font-medium text-[rgb(var(--muted))]">Starts</span>
                      <div>
                        <input
                          type="text"
                          inputMode="numeric"
                          placeholder={datePlaceholder}
                          value={startDateInput}
                          onChange={handleStartDateChange}
                          onBlur={handleStartDateBlur}
                          aria-label="Start date"
                          aria-invalid={startDateError ? 'true' : undefined}
                          aria-describedby={startDateError ? 'start-date-error' : undefined}
                          readOnly={!canWrite}
                          className={`w-full ${compactFieldClass} ${disabledClass}`}
                        />
                        {startDateError && (
                          <p id="start-date-error" className="mt-1 text-xs text-red-500" role="alert">
                            {startDateError}
                          </p>
                        )}
                      </div>
                      {!allDay && (
                        <input
                          type="text"
                          inputMode="text"
                          pattern={timeFormat === '24h' ? '[0-2]?[0-9]:[0-5][0-9]' : undefined}
                          placeholder={timeFormat === '24h' ? '14:00' : '2:00 PM'}
                          value={startTimeInput}
                          onChange={handleStartTimeChange}
                          onBlur={handleStartTimeBlur}
                          aria-label="Start time"
                          readOnly={!canWrite}
                          className={`w-full ${compactFieldClass} ${disabledClass}`}
                        />
                      )}
                    </div>
                  </div>

                  <div className="rounded-xl border border-[rgb(var(--border))] bg-[rgb(var(--background))]/60 p-3">
                    <div className="grid gap-2 sm:grid-cols-[5rem_minmax(0,1fr)_7.5rem] sm:items-center">
                      <span className="text-sm font-medium text-[rgb(var(--muted))]">Ends</span>
                      <div>
                        <input
                          type="text"
                          inputMode="numeric"
                          placeholder={datePlaceholder}
                          value={endDateInput}
                          onChange={handleEndDateChange}
                          onBlur={handleEndDateBlur}
                          aria-label="End date"
                          aria-invalid={endDateError ? 'true' : undefined}
                          aria-describedby={endDateError ? 'end-date-error' : undefined}
                          readOnly={!canWrite}
                          className={`w-full ${compactFieldClass} ${disabledClass}`}
                        />
                        {endDateError && (
                          <p id="end-date-error" className="mt-1 text-xs text-red-500" role="alert">
                            {endDateError}
                          </p>
                        )}
                      </div>
                      {!allDay && (
                        <input
                          type="text"
                          inputMode="text"
                          pattern={timeFormat === '24h' ? '[0-2]?[0-9]:[0-5][0-9]' : undefined}
                          placeholder={timeFormat === '24h' ? '14:30' : '2:30 PM'}
                          value={endTimeInput}
                          onChange={handleEndTimeChange}
                          onBlur={handleEndTimeBlur}
                          aria-label="End time"
                          readOnly={!canWrite}
                          className={`w-full ${compactFieldClass} ${disabledClass}`}
                        />
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-start gap-3 rounded-xl border border-[rgb(var(--border))] bg-[rgb(var(--background))]/60 p-3">
                  <Repeat className={`${iconClass} mt-2`} />
                  <div className="min-w-0 flex-1">
                    <RecurrencePicker value={recurrenceRule} onChange={setRecurrenceRule} />
                  </div>
                </div>

                {!allDay && (
                  <div className="space-y-2 rounded-xl border border-[rgb(var(--border))] bg-[rgb(var(--background))]/60 p-3">
                    <div className="flex items-center gap-3">
                      <Globe className={iconClass} />
                      <select
                        value={timezone}
                        onChange={(e) => setTimezone(e.target.value)}
                        disabled={!canWrite}
                        aria-label="Event timezone"
                        className={`min-w-0 flex-1 ${compactFieldClass} ${disabledClass}`}
                      >
                        {allTimezones.map((tz) => (
                          <option key={tz} value={tz}>{tz.replace(/_/g, ' ')}</option>
                        ))}
                      </select>
                    </div>
                    {timezone !== userTz && (
                      <span className="block pl-7 text-xs leading-relaxed text-[rgb(var(--muted))]">
                        Event anchored in {shortTimezoneLabel(timezone, buildStartDate())}; your calendar shows {shortTimezoneLabel(userTz, buildStartDate())}.
                      </span>
                    )}
                  </div>
                )}
              </section>

              {/* Reminders */}
              <section className={`${sectionClass} space-y-3`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Bell className={iconClass} />
                    <span className={sectionTitleClass}>Reminders</span>
                  </div>
                  {canWrite && (
                    <button
                      type="button"
                      onClick={() => setAlarms((prev) => [...prev, '15'])}
                      className={`rounded-full border border-emerald-500/30 px-3 py-1.5 text-xs font-semibold text-emerald-600 transition-colors hover:bg-emerald-500/10 dark:text-emerald-400 ${focusRing}`}
                    >
                      + Add
                    </button>
                  )}
                </div>

                {alarms.length === 0 && (
                  <div className="rounded-xl border border-dashed border-[rgb(var(--border))] bg-[rgb(var(--background))]/45 px-3 py-3 text-sm text-[rgb(var(--muted))]">
                    No reminders
                  </div>
                )}

                {alarms.map((alarm, i) => {
                  const isCustomAlarm = !isPresetAlarm(alarm)
                  return (
                  <div key={i} className="flex flex-col gap-2 rounded-xl border border-[rgb(var(--border))] bg-[rgb(var(--background))]/60 p-2 sm:flex-row sm:items-start">
                    <select
                      value={isCustomAlarm ? 'custom' : alarm}
                      onChange={(e) => {
                        const next = [...alarms]
                        next[i] = e.target.value === 'custom' ? '10' : e.target.value
                        setAlarms(next)
                      }}
                      disabled={!canWrite}
                      aria-label={`Reminder ${i + 1}`}
                      className={`min-w-0 flex-1 ${compactFieldClass} ${disabledClass}`}
                    >
                      <option value="5">5 minutes before</option>
                      <option value="15">15 minutes before</option>
                      <option value="30">30 minutes before</option>
                      <option value="60">1 hour before</option>
                      <option value="1440">1 day before</option>
                      <option value="custom">Custom…</option>
                    </select>
                    {isCustomAlarm && (
                      <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-[rgb(var(--muted))] sm:max-w-[14rem]">
                        <input
                          type="number"
                          min="1"
                          max="525600"
                          step="1"
                          value={alarm}
                          onChange={(e) => {
                            const next = [...alarms]
                            next[i] = e.target.value
                            setAlarms(next)
                          }}
                          onBlur={(e) => {
                            const next = [...alarms]
                            next[i] = normalizeAlarmMinutes(e.target.value) ?? '15'
                            setAlarms(next)
                          }}
                          aria-label={`Custom reminder ${i + 1} minutes before`}
                          readOnly={!canWrite}
                          className={`w-24 ${compactFieldClass} ${disabledClass}`}
                        />
                        minutes before
                      </label>
                    )}
                    {!isCustomAlarm && (
                      <span className="sr-only">{alarmLabel(alarm)}</span>
                    )}
                    <button
                      type="button"
                      onClick={() => setAlarms((prev) => prev.filter((_, j) => j !== i))}
                      disabled={!canWrite}
                      className={`self-start rounded-full p-2 text-[rgb(var(--muted))] transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`}
                      aria-label="Remove reminder"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  )
                })}

                {alarms.length > 0 && notifications.permission === 'default' && (
                  <div className="flex flex-col gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <span className="text-sm text-amber-700 dark:text-amber-300">
                      Allow notifications to get reminders in this browser
                    </span>
                    <button
                      type="button"
                      onClick={() => void notifications.requestPermission()}
                      className={`rounded-full bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-amber-600 ${focusRing}`}
                    >
                      Allow
                    </button>
                  </div>
                )}
              </section>

              {/* Description */}
              <section className={`${sectionClass} space-y-3`}>
                <div className="flex items-center gap-2">
                  <AlignLeft className={iconClass} />
                  <span className={sectionTitleClass}>Notes</span>
                </div>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Add description"
                  aria-label="Event description"
                  rows={4}
                  readOnly={!canWrite}
                  className={`w-full resize-none ${fieldClass} ${disabledClass}`}
                />
              </section>

              {isEdit && canWrite && (
                <section className="rounded-2xl border border-red-500/20 bg-red-500/5 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h3 className="text-sm font-semibold text-red-600 dark:text-red-400">Delete event</h3>
                      <p className="mt-1 text-xs text-[rgb(var(--muted))]">Remove this event from the selected calendar.</p>
                    </div>
                    <button
                      onClick={handleDelete}
                      className={`inline-flex items-center justify-center gap-2 rounded-full border border-red-500/30 px-4 py-2 text-sm font-semibold text-red-600 transition-colors hover:bg-red-500/10 dark:text-red-400 ${focusRing}`}
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete event
                    </button>
                  </div>
                </section>
              )}
            </div>
          </div>
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
