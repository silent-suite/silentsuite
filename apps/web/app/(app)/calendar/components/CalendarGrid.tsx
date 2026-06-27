'use client'

import { useEffect, useInsertionEffect, useMemo, useState, useCallback, useRef } from 'react'
import { useNextCalendarApp, ScheduleXCalendar } from '@schedule-x/react'
import {
  createViewWeek,
  createViewMonthGrid,
  type CalendarEventExternal,
} from '@schedule-x/calendar'
import { createEventsServicePlugin } from '@schedule-x/events-service'
import { useTheme } from 'next-themes'
import { useCalendarStore, type CalendarView } from '@/app/stores/use-calendar-store'
import { useCalendarListStore } from '@/app/stores/use-calendar-list-store'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { usePreferencesStore } from '@/app/stores/use-preferences-store'
import { logCalendarPaintTiming } from '@/app/lib/sync-timing'
import type { CalendarEvent, DateRange, FirstDayOfWeek } from '@silentsuite/core'
import { resolveUserTimezone, instantFromWallClock } from '@/app/lib/tz'
import { startOfWeek, endOfWeek } from '@/app/lib/date'
import { expandEventsForRange, toScheduleXEvents, type DisplayEvent } from '../lib/calendar-grid-events'
import {
  toScheduleXDayBoundariesExternal,
  toScheduleXDayBoundariesInternal,
} from '../lib/calendar-day-boundaries'

import '@schedule-x/theme-default/dist/index.css'

// Temporal polyfill — patches globalThis.Temporal and registers types
import 'temporal-polyfill/global'

type CalendarGridDisplayView = CalendarView | 'threeDay' | 'sevenDay'

const VIEW_MAP: Record<CalendarGridDisplayView, string> = {
  threeDay: 'week',
  sevenDay: 'week',
  week: 'week',
  month: 'month-grid',
}

function toScheduleXWeekday(date: Date): number {
  const day = date.getDay()
  return day === 0 ? 7 : day
}

function toPlainDate(date: Date): Temporal.PlainDate {
  return Temporal.PlainDate.from({
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  })
}

/** Convert a JS Date to a Temporal.ZonedDateTime in the given timezone.
 * Schedule-X v4 requires a real ZonedDateTime — it calls .withTimeZone() on the
 * stored value to convert into the calendar's configured timezone, so the input
 * zone here is effectively a label; what matters is the underlying instant.
 */
function toScheduleXDateTime(date: Date, tz: string): Temporal.ZonedDateTime {
  return Temporal.Instant.fromEpochMilliseconds(date.getTime()).toZonedDateTimeISO(tz)
}

/** Get the visible date range for the current view, honoring the first-day preference */
function getViewRange(currentDate: Date, view: CalendarGridDisplayView, firstDay: FirstDayOfWeek): DateRange {
  const d = new Date(currentDate)
  switch (view) {
    case 'threeDay':
    case 'sevenDay': {
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate())
      const end = new Date(start)
      end.setDate(start.getDate() + (view === 'threeDay' ? 2 : 6))
      end.setHours(23, 59, 59, 999)
      return { start, end }
    }
    case 'week': {
      const start = startOfWeek(d, firstDay)
      const end = new Date(start)
      end.setDate(start.getDate() + 6)
      end.setHours(23, 59, 59, 999)
      return { start, end }
    }
    case 'month': {
      const monthStart = new Date(d.getFullYear(), d.getMonth(), 1)
      const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999)
      // Extend to cover partial weeks at start/end of month
      const start = startOfWeek(monthStart, firstDay)
      const end = endOfWeek(monthEnd, firstDay)
      return { start, end }
    }
  }
}

/** Convert a Temporal.ZonedDateTime to a JS Date */
function zonedToDate(zdt: Temporal.ZonedDateTime): Date {
  return new Date(zdt.epochMilliseconds)
}

/** Convert a Temporal.PlainDate to a JS Date (midnight local) */
function plainDateToDate(pd: Temporal.PlainDate): Date {
  return new Date(pd.year, pd.month - 1, pd.day)
}

/** Snap a Date to the nearest 30-minute boundary */
function snapTo30Min(date: Date): Date {
  const snapped = new Date(date)
  const minutes = snapped.getMinutes()
  const remainder = minutes % 30
  if (remainder < 15) {
    snapped.setMinutes(minutes - remainder, 0, 0)
  } else {
    snapped.setMinutes(minutes + (30 - remainder), 0, 0)
  }
  return snapped
}

const DEFAULT_DAY_START_HOUR = 7
const DEFAULT_DAY_END_HOUR = 23

/** Find the display event under the cursor by matching click coordinates to day column + time */
function findEventAtPosition(
  clientX: number,
  clientY: number,
  wrapperEl: HTMLElement,
  gridEl: HTMLElement,
  viewRange: DateRange,
  displayEvents: DisplayEvent[],
  getTimeFromY: (clientY: number, gridEl: HTMLElement) => number,
): DisplayEvent | null {
  // Determine which day column the click is in
  const dayCols = wrapperEl.querySelectorAll('.sx__time-grid-day')
  let dayIndex = -1
  for (let i = 0; i < dayCols.length; i++) {
    const rect = (dayCols[i] as HTMLElement).getBoundingClientRect()
    if (clientX >= rect.left && clientX <= rect.right) {
      dayIndex = i
      break
    }
  }
  if (dayIndex < 0) return null

  const colDate = new Date(viewRange.start)
  colDate.setDate(colDate.getDate() + dayIndex)

  // Determine the fractional hour from Y coordinate
  const hour = getTimeFromY(clientY, gridEl)
  const clickTime = new Date(
    colDate.getFullYear(),
    colDate.getMonth(),
    colDate.getDate(),
    Math.floor(hour),
    Math.round((hour % 1) * 60),
  )

  // Find timed events on this day that contain the click time
  const candidates = displayEvents.filter((ev) => {
    if (ev.allDay) return false
    const sameDay =
      ev.startDate.getFullYear() === colDate.getFullYear() &&
      ev.startDate.getMonth() === colDate.getMonth() &&
      ev.startDate.getDate() === colDate.getDate()
    return sameDay && ev.startDate <= clickTime && ev.endDate > clickTime
  })

  if (candidates.length === 0) return null
  // When overlapping, prefer the shortest event (most specific)
  return candidates.sort(
    (a, b) =>
      a.endDate.getTime() -
      a.startDate.getTime() -
      (b.endDate.getTime() - b.startDate.getTime()),
  )[0]
}

export interface SlotClickEvent {
  startDate: Date
  endDate: Date
  allDay: boolean
  position: { x: number; y: number }
}

export interface EventClickInfo {
  eventId: string
  /** The master event ID (for recurring instances) */
  masterEventId: string
  /** The instance date for this occurrence */
  instanceDate: Date
  position: { x: number; y: number }
}

interface CalendarGridProps {
  events: CalendarEvent[]
  displayView?: CalendarGridDisplayView
  onSlotClick?: (event: SlotClickEvent) => void
  onEventClick?: (info: EventClickInfo) => void
}

export function CalendarGrid({ events, displayView, onSlotClick, onEventClick }: CalendarGridProps) {
  const { resolvedTheme } = useTheme()
  const canWrite = useAuthStore((s) => s.canWrite())
  const currentView = useCalendarStore((s) => s.currentView)
  const effectiveView = displayView ?? currentView
  const currentDate = useCalendarStore((s) => s.currentDate)
  const setSelectedEvent = useCalendarStore((s) => s.setSelectedEvent)
  const setCurrentView = useCalendarStore((s) => s.setCurrentView)
  const setCurrentDate = useCalendarStore((s) => s.setCurrentDate)
  const updateEvent = useCalendarStore((s) => s.updateEvent)

  const timeFormat = usePreferencesStore((s) => s.timeFormat)
  const use12h = timeFormat !== '24h'
  const defaultTimezone = usePreferencesStore((s) => s.defaultTimezone)
  const userTz = useMemo(() => resolveUserTimezone(defaultTimezone), [defaultTimezone])
  const firstDayOfWeek = usePreferencesStore((s) => s.firstDayOfWeek)
  const dayStartHour = usePreferencesStore((s) => s.dayStartHour ?? DEFAULT_DAY_START_HOUR)
  const dayEndHour = usePreferencesStore((s) => s.dayEndHour ?? DEFAULT_DAY_END_HOUR)
  // Schedule-X WeekDay enum: MONDAY = 1 … SUNDAY = 7 (not 0-indexed).
  const sxFirstDayOfWeek = firstDayOfWeek === 'sunday' ? 7 : 1
  const currentDateTs = currentDate instanceof Date ? currentDate.getTime() : new Date(currentDate).getTime()
  const currentDateForSx = useMemo(
    () => (currentDate instanceof Date ? currentDate : new Date(currentDate)),
    [currentDateTs],
  )
  const effectiveSxFirstDayOfWeek = effectiveView === 'threeDay' || effectiveView === 'sevenDay'
    ? toScheduleXWeekday(currentDateForSx)
    : sxFirstDayOfWeek
  const effectiveWeekDays = effectiveView === 'threeDay' ? 3 : 7

  const rootRef = useRef<HTMLDivElement>(null)
  const lastClickPos = useRef<{ x: number; y: number }>({ x: 0, y: 0 })

  // Ref to prevent feedback loops between store↔Schedule-X sync
  const isSyncingToSxRef = useRef(false)

  const calendars = useCalendarListStore((s) => s.calendars)
  const calendarColors = useMemo(() => {
    const map = new Map<string, string>()
    for (const cal of calendars) map.set(cal.id, cal.color)
    return map
  }, [calendars])

  const [eventsPlugin] = useState(() => createEventsServicePlugin())

  // Expand recurring events for the visible range
  const viewRange = useMemo(() => getViewRange(currentDate, effectiveView, firstDayOfWeek), [currentDate, effectiveView, firstDayOfWeek])
  const displayEvents = useMemo(() => expandEventsForRange(events, viewRange), [events, viewRange])

  // Keep a ref map to look up display events by schedule-x id
  const displayEventMap = useMemo(() => {
    const map = new Map<string, DisplayEvent>()
    for (const de of displayEvents) {
      map.set(de.id, de)
    }
    return map
  }, [displayEvents])
  const displayEventMapRef = useRef(displayEventMap)
  displayEventMapRef.current = displayEventMap

  const sxEvents = useMemo(
    () => toScheduleXEvents(displayEvents, calendarColors, userTz, effectiveView === 'threeDay' || effectiveView === 'sevenDay' ? 'week' : effectiveView, toScheduleXDateTime),
    [displayEvents, calendarColors, userTz, effectiveView],
  )

  // Inject calendar color styles via useInsertionEffect (avoids dangerouslySetInnerHTML)
  useInsertionEffect(() => {
    const styleId = 'sx-calendar-colors'
    let style = document.getElementById(styleId) as HTMLStyleElement | null
    if (!style) {
      style = document.createElement('style')
      style.id = styleId
      document.head.appendChild(style)
    }
    style.textContent = Array.from(calendarColors.entries())
      .map(([id, color]) => {
        const cls = `sx-cal-color-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
        const safeColor = /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : '#10b981'
        // Schedule-X nests text spans inside event chips; keep descendants readable on custom colors.
        return `.${cls} { background-color: ${safeColor} !important; color: #fff !important; }
.${cls} * { color: #fff !important; }`
      })
      .join('\n')
    // Keep the shared style node in place across multiple CalendarGrid instances
    // (desktop hidden grid + mobile 3-day grid can be mounted together).
  }, [calendarColors])

  const selectedDate = useMemo(() => toPlainDate(currentDate), [currentDate])

  // Drag-to-move state
  const isDragMovingRef = useRef(false)
  const dragMoveStartRef = useRef<{
    eventId: string
    masterId: string
    originalStart: Date
    originalEnd: Date
    duration: number
    startY: number
    startX: number
    startTime: number // Date.now() for hold detection
  } | null>(null)
  const [dragMovePreview, setDragMovePreview] = useState<{
    left: number
    top: number
    width: number
    height: number
    title: string
    timeLabel: string
    newStart: Date
    newEnd: Date
  } | null>(null)

  // Drag-to-select state
  const isDraggingRef = useRef(false)
  const dragStartRef = useRef<{
    x: number
    y: number
    time: number
    date: Date | null
    dayColRect: DOMRect | null
  } | null>(null)
  const selectionRef = useRef<HTMLDivElement>(null)
  const [dragSelection, setDragSelection] = useState<{
    left: number
    top: number
    width: number
    height: number
    startTime: Date | null
    endTime: Date | null
  } | null>(null)
  const dragEndTimeRef = useRef<Date | null>(null)

  // Phase 2A: Auto-scroll animation ref
  const scrollAnimRef = useRef<number | null>(null)

  // Phase 2B: Undo toast state
  const [undoToast, setUndoToast] = useState<{
    eventId: string
    originalStart: Date
    originalEnd: Date
  } | null>(null)
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Phase 2C: Touch long-press timer
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Phase 3: Drag-to-resize state
  const isDragResizingRef = useRef(false)
  const dragResizeStartRef = useRef<{
    eventId: string
    masterId: string
    originalStart: Date
    originalEnd: Date
    startY: number
  } | null>(null)
  const [dragResizePreview, setDragResizePreview] = useState<{
    left: number
    top: number
    width: number
    height: number
    timeLabel: string
    newEnd: Date
  } | null>(null)

  const handleClickDateTime = useCallback(
    (dateTime: Temporal.ZonedDateTime, e?: UIEvent) => {
      // If we just finished a drag (select or move), skip the click handler
      if (isDraggingRef.current || isDragMovingRef.current) return

      const raw = zonedToDate(dateTime)
      const start = snapTo30Min(raw)
      const end = new Date(start)
      end.setHours(end.getHours() + 1) // 1 hour default

      const mouseEvent = e as MouseEvent | undefined
      const position = mouseEvent
        ? { x: mouseEvent.clientX, y: mouseEvent.clientY }
        : { x: window.innerWidth / 2, y: window.innerHeight / 3 }

      onSlotClick?.({ startDate: start, endDate: end, allDay: false, position })
    },
    [onSlotClick],
  )

  const handleClickDate = useCallback(
    (date: Temporal.PlainDate, _e?: UIEvent) => {
      // Month view date click → switch to day view for that date
      const jsDate = plainDateToDate(date)
      setCurrentDate(jsDate)
      setCurrentView('week')
    },
    [setCurrentDate, setCurrentView],
  )

  // Create views once and never re-create
  const viewsRef = useRef<[ReturnType<typeof createViewWeek>, ...Array<ReturnType<typeof createViewWeek>>]>([createViewWeek(), createViewMonthGrid()])
  const views = viewsRef.current

  // Capture initial view so useNextCalendarApp config doesn't change on view switch
  const initialViewRef = useRef(VIEW_MAP[effectiveView])
  const initialDateRef = useRef(selectedDate)
  // Capture time format at mount — Schedule-X locale can't change after init
  const initialLocaleRef = useRef(timeFormat === '24h' ? 'en-GB' : 'en-US')
  // Capture initial timezone for Schedule-X config (changes are pushed via signal below)
  const initialTimezoneRef = useRef(userTz)
  // Capture initial first-day-of-week for Schedule-X config (changes pushed via signal below)
  const initialFirstDayRef = useRef(effectiveSxFirstDayOfWeek)
  const initialDayBoundariesRef = useRef(toScheduleXDayBoundariesExternal(dayStartHour, dayEndHour))

  // Memoize the event click handler
  const handleEventClick = useCallback(
    (event: CalendarEventExternal) => {
      const sxId = String(event.id)
      const de = displayEventMapRef.current.get(sxId)
      if (de) {
        setSelectedEvent(de.masterId)
        onEventClick?.({
          eventId: sxId,
          masterEventId: de.masterId,
          instanceDate: de.instanceDate,
          position: { ...lastClickPos.current },
        })
      } else {
        setSelectedEvent(sxId)
        onEventClick?.({
          eventId: sxId,
          masterEventId: sxId,
          instanceDate: new Date(),
          position: { ...lastClickPos.current },
        })
      }
    },
    [setSelectedEvent, onEventClick],
  )

  const calendar = useNextCalendarApp({
    views,
    events: [],
    selectedDate: initialDateRef.current,
    defaultView: initialViewRef.current,
    isDark: resolvedTheme === 'dark',
    locale: initialLocaleRef.current,
    // Derived from the firstDayOfWeek preference; live changes pushed via signal below.
    firstDayOfWeek: initialFirstDayRef.current,
    dayBoundaries: initialDayBoundariesRef.current,
    timezone: initialTimezoneRef.current,
    weekOptions: {
      gridHeight: 800,
      eventWidth: 95,
      // Concurrent (overlapping) events — e.g. from different collections — must
      // render in side-by-side columns instead of stacking on top of each other.
      // Schedule-X defaults eventOverlap to true, which paints each event at full
      // eventWidth and lets them visually hide one another. Setting it to false
      // makes Schedule-X divide the day column among concurrent events so both
      // are visible. See issue #330.
      eventOverlap: false,
      nDays: effectiveWeekDays,
    },
    plugins: [eventsPlugin],
    callbacks: {
      onEventClick: handleEventClick,
      onClickDateTime: handleClickDateTime,
      onClickDate: handleClickDate,
    },
  })

  // Push timezone changes to the Schedule-X config signal so the grid re-renders
  // when the user updates their preference in Settings without a full page reload.
  useEffect(() => {
    if (!calendar) return
    try {
      const app = (calendar as any).$app
      const tzSignal = app?.config?.timezone
      if (tzSignal && tzSignal.value !== userTz) {
        tzSignal.value = userTz
      }
    } catch {
      // Schedule-X internals may not be ready
    }
  }, [calendar, userTz])

  // Push first-day-of-week changes to the Schedule-X config signal. Week/month
  // use the user's preference; mobile 3-day mode anchors the first rendered
  // column to currentDate so Schedule-X's nDays=3 range matches getViewRange().
  useEffect(() => {
    if (!calendar) return
    try {
      const app = (calendar as any).$app
      const fdowSignal = app?.config?.firstDayOfWeek
      if (fdowSignal && fdowSignal.value !== effectiveSxFirstDayOfWeek) {
        fdowSignal.value = effectiveSxFirstDayOfWeek
      }
    } catch {
      // Schedule-X internals may not be ready
    }
  }, [calendar, effectiveSxFirstDayOfWeek])

  // Push the effective week column count through Schedule-X. The mobile 3-day
  // views reuse the week renderer with nDays=3 or nDays=7; normal week/month keep 7 days.
  useEffect(() => {
    if (!calendar) return
    try {
      const app = (calendar as any).$app
      const weekOptionsSignal = app?.config?.weekOptions
      if (weekOptionsSignal?.value && weekOptionsSignal.value.nDays !== effectiveWeekDays) {
        weekOptionsSignal.value = { ...weekOptionsSignal.value, nDays: effectiveWeekDays }
      }
    } catch {
      // Schedule-X internals may not be ready
    }
  }, [calendar, effectiveWeekDays])

  // Push day-boundary preference changes into Schedule-X and our drag/select math.
  useEffect(() => {
    if (!calendar) return
    try {
      const app = (calendar as any).$app
      const boundariesSignal = app?.config?.dayBoundaries
      const next = toScheduleXDayBoundariesInternal(dayStartHour, dayEndHour)
      if (boundariesSignal) {
        boundariesSignal.value = next
      }
    } catch {
      // Schedule-X internals may not be ready
    }
  }, [calendar, dayStartHour, dayEndHour])

  // Sync view AND date changes from store → Schedule-X via internal API.
  // CalendarApp has NO public navigation methods. We access the private $app
  // singleton which exposes calendarState.setView(viewName, date) and
  // calendarState.setRange(date). Both operate on Preact signals internally.
  //
  // Use currentDateTs as dependency to ensure React detects Date changes
  // (Date objects compared by reference would miss updates).
  useEffect(() => {
    if (!calendar) return
    const sxViewName = VIEW_MAP[effectiveView]
    try {
      const app = (calendar as any).$app
      if (!app?.calendarState) return
      isSyncingToSxRef.current = true
      const date = currentDate instanceof Date ? currentDate : new Date(currentDate)
      const pd = toPlainDate(date)
      app.calendarState.setView(sxViewName, pd)
      // Move the visible range to the target date (setView only changes view type)
      app.calendarState.setRange(pd)
      // Sync the date picker highlight if present
      if (app.datePickerState?.selectedDate) {
        app.datePickerState.selectedDate.value = pd
      }
    } catch (e) {
      console.debug('[CalendarGrid] setView/setRange failed:', e)
    }
    // Clear sync flag after SX signals settle (next animation frame)
    const raf = requestAnimationFrame(() => {
      isSyncingToSxRef.current = false
    })
    return () => {
      cancelAnimationFrame(raf)
      isSyncingToSxRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendar, effectiveView, currentDateTs])

  // Reverse sync: Schedule-X → store.
  // Schedule-X maintains its own internal date state via Preact signals.
  // If it drifts (e.g. from internal interactions), we detect the mismatch
  // by polling $app.calendarState.range and update the Zustand store.
  useEffect(() => {
    if (!calendar) return

    let lastSeenStart = ''

    const checkSxRange = () => {
      // Don't read back while we're pushing a change TO Schedule-X
      if (isSyncingToSxRef.current) return

      try {
        const app = (calendar as any).$app
        if (!app?.calendarState) return

        // $app.calendarState.range is a Preact signal — read via .value
        const rangeSignal = app.calendarState.range
        const range = rangeSignal?.value ?? rangeSignal
        if (!range?.start) return

        const startStr = typeof range.start === 'string' ? range.start : String(range.start)
        if (startStr === lastSeenStart) return // No change in SX
        lastSeenStart = startStr

        // Parse the SX range start (YYYY-MM-DD)
        const parts = startStr.split('-').map(Number)
        if (parts.length < 3 || parts.some(isNaN)) return
        const [y, m, d] = parts
        const sxRangeStart = new Date(y!, m! - 1, d!)

        // Compare with the store's expected range for the current view
        const storeState = useCalendarStore.getState()
        const currentFirstDay = usePreferencesStore.getState().firstDayOfWeek
        const storeRange = getViewRange(storeState.currentDate, effectiveView, currentFirstDay)

        // Allow 1-day tolerance (month views may extend into adjacent months)
        const startDiff = Math.abs(sxRangeStart.getTime() - storeRange.start.getTime())
        if (startDiff < 86400000) return // Close enough — no drift

        // SX is showing a different range — update store to match.
        // Pick a representative date from the SX range for currentDate:
        // Mobile multi-day views → range start; week view → Wednesday; month view → middle.
        let newDate: Date
        if (effectiveView === 'threeDay' || effectiveView === 'sevenDay') {
          newDate = new Date(sxRangeStart)
        } else if (storeState.currentView === 'week') {
          newDate = new Date(sxRangeStart)
          newDate.setDate(newDate.getDate() + 3) // mid-week avoids boundary issues
        } else {
          const endStr = typeof range.end === 'string' ? range.end : String(range.end)
          const endParts = endStr.split('-').map(Number)
          if (endParts.length >= 3 && !endParts.some(isNaN)) {
            const sxRangeEnd = new Date(endParts[0]!, endParts[1]! - 1, endParts[2]!)
            newDate = new Date((sxRangeStart.getTime() + sxRangeEnd.getTime()) / 2)
          } else {
            newDate = new Date(sxRangeStart)
            newDate.setDate(newDate.getDate() + 15)
          }
        }

        // Push to store — set flag to avoid re-triggering store→SX effect
        isSyncingToSxRef.current = true
        setCurrentDate(newDate)
        requestAnimationFrame(() => {
          isSyncingToSxRef.current = false
        })
      } catch {
        // Silently ignore — SX internals may not be ready yet
      }
    }

    const interval = setInterval(checkSxRange, 1000)
    return () => clearInterval(interval)
  }, [calendar, setCurrentDate])

  // Sync events to schedule-x when they change
  useEffect(() => {
    if (!eventsPlugin) return
    try {
      eventsPlugin.set(sxEvents)
    } catch {
      // events service may not be ready yet
    }
  }, [sxEvents, eventsPlugin])

  // Log the first browser paint after Schedule-X receives events. This keeps
  // the sync-speed investigation grounded in a visible-calendar milestone,
  // without logging event titles, times, labels, or other PIM content.
  const firstEventsPaintLoggedRef = useRef(false)
  useEffect(() => {
    if (firstEventsPaintLoggedRef.current || sxEvents.length === 0) return
    firstEventsPaintLoggedRef.current = true
    const raf = requestAnimationFrame(() => {
      logCalendarPaintTiming({
        scheduleXEventCount: sxEvents.length,
        displayEventCount: displayEvents.length,
        rawEventCount: events.length,
        view: effectiveView,
      })
    })
    return () => cancelAnimationFrame(raf)
  }, [effectiveView, displayEvents.length, events.length, sxEvents.length])

  // #331: Reveal the full title on short/clipped calendar events and mark event
  // chips by rendered height so CSS can hide low-priority metadata before it
  // gets half-clipped. Schedule-X lays out timed events with inline heights, so
  // this must be measured after render rather than inferred from duration.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    const selector = '.sx__time-grid-event, .sx__month-grid-event, .sx__day-grid-event'
    let raf = 0
    let resizeObserver: ResizeObserver | null = null

    const applyAll = () => {
      root.querySelectorAll(selector).forEach((el) => {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim()
        if (text && el.getAttribute('title') !== text) {
          el.setAttribute('title', text)
        }

        if (el.classList.contains('sx__time-grid-event')) {
          const timedEvent = el as HTMLElement
          resizeObserver?.observe(timedEvent)
          const height = timedEvent.getBoundingClientRect().height
          const size = height < 34 ? 'tiny' : height < 58 ? 'small' : height < 92 ? 'medium' : 'large'
          if (timedEvent.dataset.ssEventSize !== size) {
            timedEvent.dataset.ssEventSize = size
          }
        }
      })
    }

    const schedule = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        applyAll()
      })
    }

    resizeObserver = new ResizeObserver(schedule)
    applyAll()
    const observer = new MutationObserver(schedule)
    observer.observe(root, { childList: true, subtree: true })
    return () => {
      if (raf) cancelAnimationFrame(raf)
      resizeObserver.disconnect()
      observer.disconnect()
    }
  }, [sxEvents, effectiveView])

  /** Find the time grid scrollable container and calculate time from Y */
  const getTimeFromY = useCallback(
    (clientY: number, gridEl: HTMLElement): number => {
      const rect = gridEl.getBoundingClientRect()
      const relativeY = clientY - rect.top + gridEl.scrollTop
      const totalHours = dayEndHour - dayStartHour
      const pixelsPerHour = gridEl.scrollHeight / totalHours
      return dayStartHour + relativeY / pixelsPerHour
    },
    [dayStartHour, dayEndHour],
  )

  /** Find which day column the X coordinate is within */
  const getDayColumnInfo = useCallback(
    (
      clientX: number,
      wrapperEl: HTMLElement,
    ): { date: Date; rect: DOMRect } | null => {
      const dayCols = wrapperEl.querySelectorAll('.sx__time-grid-day')
      for (let i = 0; i < dayCols.length; i++) {
        const col = dayCols[i] as HTMLElement
        const colRect = col.getBoundingClientRect()
        if (clientX >= colRect.left && clientX <= colRect.right) {
          // Determine the date for this column using viewRange start + index
          const colDate = new Date(viewRange.start)
          colDate.setDate(colDate.getDate() + i)
          return { date: colDate, rect: colRect }
        }
      }
      return null
    },
    [viewRange],
  )

  /** Build a Date from a day + fractional hour, interpreting the wall-clock in userTz.
   * `day` carries the user's clicked day as browser-local Y/M/D (constructed from
   * viewRange.start). We treat those Y/M/D as the wall-clock day in userTz so the
   * resulting instant aligns with the rendered grid regardless of browser TZ. */
  const buildDateFromHour = useCallback(
    (day: Date, hour: number): Date => {
      const h = Math.floor(hour)
      const m = Math.round((hour - h) * 60)
      return instantFromWallClock(
        day.getFullYear(),
        day.getMonth() + 1,
        day.getDate(),
        h,
        m,
        userTz,
      )
    },
    [userTz],
  )

  /** Shared helper: compute drag-move preview from cursor coordinates */
  const updateDragMovePosition = useCallback(
    (clientX: number, clientY: number, wrapper: HTMLElement, gridEl: HTMLElement) => {
      const dayInfo = getDayColumnInfo(clientX, wrapper)
      if (!dayInfo || !dragMoveStartRef.current) return

      const hour = getTimeFromY(clientY, gridEl)
      const snappedHour = Math.round(hour * 2) / 2

      const durationHours = dragMoveStartRef.current.duration / (60 * 60 * 1000)
      const maxStartHour = dayEndHour - durationHours
      const clampedHour = Math.max(dayStartHour, Math.min(snappedHour, maxStartHour))
      const clampedStart = buildDateFromHour(dayInfo.date, clampedHour)
      const clampedEnd = new Date(clampedStart.getTime() + dragMoveStartRef.current.duration)

      const totalHours = dayEndHour - dayStartHour
      const pixelsPerHour = gridEl.scrollHeight / totalHours
      const gridRect = gridEl.getBoundingClientRect()
      const wrapperRect = wrapper.getBoundingClientRect()

      const topY =
        (clampedHour - dayStartHour) * pixelsPerHour -
        gridEl.scrollTop +
        gridRect.top -
        wrapperRect.top
      const heightPx = durationHours * pixelsPerHour

      const timeLabel = `${clampedStart.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: use12h,
        timeZone: userTz,
      })} \u2013 ${clampedEnd.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: use12h,
        timeZone: userTz,
      })}`

      const de = displayEventMapRef.current.get(dragMoveStartRef.current.eventId)

      setDragMovePreview({
        left: dayInfo.rect.left - wrapperRect.left,
        top: topY,
        width: dayInfo.rect.width,
        height: heightPx,
        title: de?.title || '',
        timeLabel,
        newStart: clampedStart,
        newEnd: clampedEnd,
      })
    },
    [getDayColumnInfo, getTimeFromY, buildDateFromHour, use12h, userTz],
  )

  /** Shared helper: complete drag-move drop */
  const completeDragMove = useCallback(
    (clientX: number, clientY: number, wrapper: HTMLElement) => {
      const wasMoving = isDragMovingRef.current
      const moveStart = dragMoveStartRef.current
      dragMoveStartRef.current = null
      isDragMovingRef.current = false
      setDragMovePreview(null)
      document.body.classList.remove('is-drag-moving')

      // Cancel auto-scroll
      if (scrollAnimRef.current) {
        cancelAnimationFrame(scrollAnimRef.current)
        scrollAnimRef.current = null
      }

      if (!wasMoving || !moveStart) return

      const gridEl = wrapper.querySelector(
        '.sx__week-grid, .sx__day-grid-wrapper, .sx__time-grid',
      ) as HTMLElement | null
      if (!gridEl) return

      const dayInfo = getDayColumnInfo(clientX, wrapper)
      if (!dayInfo) return

      const hour = getTimeFromY(clientY, gridEl)
      const snappedHour = Math.round(hour * 2) / 2
      const durationHours = moveStart.duration / (60 * 60 * 1000)
      const maxStartHour = dayEndHour - durationHours
      const clampedHour = Math.max(dayStartHour, Math.min(snappedHour, maxStartHour))
      const newStart = buildDateFromHour(dayInfo.date, clampedHour)
      const newEnd = new Date(newStart.getTime() + moveStart.duration)

      if (newStart.getTime() !== moveStart.originalStart.getTime()) {
        if (moveStart.eventId.includes('__')) {
          setSelectedEvent(moveStart.masterId)
        } else {
          void updateEvent(moveStart.masterId, { startDate: newStart, endDate: newEnd })
          // Phase 2B: Show undo toast
          if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
          setUndoToast({
            eventId: moveStart.masterId,
            originalStart: moveStart.originalStart,
            originalEnd: moveStart.originalEnd,
          })
          undoTimerRef.current = setTimeout(() => setUndoToast(null), 5000)
        }
      }

      // Suppress the Schedule-X click handler
      isDragMovingRef.current = true
      setTimeout(() => {
        isDragMovingRef.current = false
      }, 100)
    },
    [getDayColumnInfo, getTimeFromY, buildDateFromHour, setSelectedEvent, updateEvent],
  )

  // Track mouse position for event click anchoring + drag-to-select start
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      lastClickPos.current = { x: e.clientX, y: e.clientY }

      // Only enable drag in day/week views
      if (effectiveView === 'month') return

      const target = e.target as HTMLElement
      const wrapper = e.currentTarget as HTMLElement
      const gridEl = wrapper.querySelector(
        '.sx__week-grid, .sx__day-grid-wrapper, .sx__time-grid',
      ) as HTMLElement | null

      // Clicking on an event element → check resize vs move
      if (target.closest('.sx__time-grid-event')) {
        if (!gridEl) return

        // Only allow drag-to-move/resize when canWrite
        if (!canWrite) return

        const eventEl = target.closest('.sx__time-grid-event') as HTMLElement
        const eventRect = eventEl.getBoundingClientRect()
        const isNearBottom = e.clientY > eventRect.bottom - 6

        const event = findEventAtPosition(
          e.clientX,
          e.clientY,
          wrapper,
          gridEl,
          viewRange,
          displayEvents,
          getTimeFromY,
        )
        if (!event) return

        if (isNearBottom) {
          // Phase 3: Start potential resize
          dragResizeStartRef.current = {
            eventId: event.id,
            masterId: event.masterId,
            originalStart: event.startDate,
            originalEnd: event.endDate,
            startY: e.clientY,
          }
          isDragResizingRef.current = false
          e.preventDefault()
          return
        }

        // Start potential drag-to-move
        dragMoveStartRef.current = {
          eventId: event.id,
          masterId: event.masterId,
          originalStart: event.startDate,
          originalEnd: event.endDate,
          duration: event.endDate.getTime() - event.startDate.getTime(),
          startY: e.clientY,
          startX: e.clientX,
          startTime: Date.now(),
        }
        isDragMovingRef.current = false
        e.preventDefault() // Prevent text selection
        return
      }

      if (!gridEl) return

      // Only allow drag-to-select when canWrite
      if (!canWrite) return

      const dayInfo = getDayColumnInfo(e.clientX, wrapper)
      if (!dayInfo) return

      const hour = getTimeFromY(e.clientY, gridEl)
      const startDate = buildDateFromHour(dayInfo.date, hour)

      dragStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        time: Date.now(),
        date: startDate,
        dayColRect: dayInfo.rect,
      }
      isDraggingRef.current = false
      dragEndTimeRef.current = null
    },
    [effectiveView, getDayColumnInfo, getTimeFromY, buildDateFromHour, viewRange, displayEvents],
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      // Phase 3: Resize cursor hint when hovering near bottom edge of events
      if (!dragMoveStartRef.current && !dragStartRef.current && !dragResizeStartRef.current) {
        const target = e.target as HTMLElement
        const eventEl = target.closest('.sx__time-grid-event') as HTMLElement | null
        if (eventEl) {
          if (!canWrite) {
            eventEl.style.cursor = 'default'
          } else {
            const rect = eventEl.getBoundingClientRect()
            if (e.clientY > rect.bottom - 6) {
              eventEl.style.cursor = 'ns-resize'
            } else {
              eventEl.style.cursor = 'grab'
            }
          }
        }
      }

      // --- Phase 3: Drag-to-resize logic ---
      if (dragResizeStartRef.current) {
        const dy = Math.abs(e.clientY - dragResizeStartRef.current.startY)

        // Activation threshold: 5px
        if (!isDragResizingRef.current && dy < 5) return

        isDragResizingRef.current = true
        e.preventDefault()
        document.body.classList.add('is-drag-resizing')

        const wrapper = e.currentTarget as HTMLElement
        const gridEl = wrapper.querySelector(
          '.sx__week-grid, .sx__day-grid-wrapper, .sx__time-grid',
        ) as HTMLElement | null
        if (!gridEl) return

        const hour = getTimeFromY(e.clientY, gridEl)
        const snappedHour = Math.round(hour * 2) / 2 // snap to 30min

        // Compute original start hour for minimum enforcement (30 min minimum)
        const origStart = dragResizeStartRef.current.originalStart
        const origStartHour =
          origStart.getHours() + origStart.getMinutes() / 60
        const minEndHour = origStartHour + 0.5 // 30 min minimum
        const clampedEndHour = Math.max(minEndHour, Math.min(snappedHour, dayEndHour))

        const newEnd = buildDateFromHour(origStart, clampedEndHour)

        // Compute ghost overlay
        const totalHours = dayEndHour - dayStartHour
        const pixelsPerHour = gridEl.scrollHeight / totalHours
        const gridRect = gridEl.getBoundingClientRect()
        const wrapperRect = wrapper.getBoundingClientRect()

        // Find the day column for this event
        const dayInfo = getDayColumnInfo(
          // Use original event's column (don't allow horizontal movement during resize)
          wrapper.querySelectorAll('.sx__time-grid-day').length > 0
            ? (() => {
                const dayCols = wrapper.querySelectorAll('.sx__time-grid-day')
                for (let i = 0; i < dayCols.length; i++) {
                  const colDate = new Date(viewRange.start)
                  colDate.setDate(colDate.getDate() + i)
                  if (
                    colDate.getFullYear() === origStart.getFullYear() &&
                    colDate.getMonth() === origStart.getMonth() &&
                    colDate.getDate() === origStart.getDate()
                  ) {
                    return (dayCols[i] as HTMLElement).getBoundingClientRect().left + 1
                  }
                }
                return e.clientX
              })()
            : e.clientX,
          wrapper,
        )
        if (!dayInfo) return

        const topY =
          (origStartHour - dayStartHour) * pixelsPerHour -
          gridEl.scrollTop +
          gridRect.top -
          wrapperRect.top
        const heightPx = (clampedEndHour - origStartHour) * pixelsPerHour

        const timeLabel = `${origStart.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: use12h,
          timeZone: userTz,
        })} \u2013 ${newEnd.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: use12h,
          timeZone: userTz,
        })}`

        setDragResizePreview({
          left: dayInfo.rect.left - wrapperRect.left,
          top: topY,
          width: dayInfo.rect.width,
          height: heightPx,
          timeLabel,
          newEnd,
        })

        // Phase 2A: Auto-scroll during resize
        const SCROLL_ZONE = 50
        const startAutoScroll = (direction: 'up' | 'down') => {
          const scroll = () => {
            if (!isDragResizingRef.current) return
            gridEl.scrollTop += direction === 'down' ? 4 : -4
            scrollAnimRef.current = requestAnimationFrame(scroll)
          }
          if (scrollAnimRef.current) cancelAnimationFrame(scrollAnimRef.current)
          scrollAnimRef.current = requestAnimationFrame(scroll)
        }

        if (e.clientY < gridRect.top + SCROLL_ZONE) {
          startAutoScroll('up')
        } else if (e.clientY > gridRect.bottom - SCROLL_ZONE) {
          startAutoScroll('down')
        } else if (scrollAnimRef.current) {
          cancelAnimationFrame(scrollAnimRef.current)
          scrollAnimRef.current = null
        }

        return
      }

      // --- Drag-to-move logic ---
      if (dragMoveStartRef.current) {
        const dx = e.clientX - dragMoveStartRef.current.startX
        const dy = e.clientY - dragMoveStartRef.current.startY
        const dist = Math.sqrt(dx * dx + dy * dy)
        const elapsed = Date.now() - dragMoveStartRef.current.startTime

        // Activation: 5px movement OR 300ms hold
        if (!isDragMovingRef.current && dist < 5 && elapsed < 300) return

        isDragMovingRef.current = true
        e.preventDefault()

        // Add body class for cursor
        document.body.classList.add('is-drag-moving')

        const wrapper = e.currentTarget as HTMLElement
        const gridEl = wrapper.querySelector(
          '.sx__week-grid, .sx__day-grid-wrapper, .sx__time-grid',
        ) as HTMLElement | null
        if (!gridEl) return

        // Use shared helper for position computation
        updateDragMovePosition(e.clientX, e.clientY, wrapper, gridEl)

        // Phase 2A: Auto-scroll when near edges
        const SCROLL_ZONE = 50
        const gridRect = gridEl.getBoundingClientRect()

        const startAutoScroll = (direction: 'up' | 'down') => {
          const scroll = () => {
            if (!isDragMovingRef.current) return
            gridEl.scrollTop += direction === 'down' ? 4 : -4
            scrollAnimRef.current = requestAnimationFrame(scroll)
          }
          if (scrollAnimRef.current) cancelAnimationFrame(scrollAnimRef.current)
          scrollAnimRef.current = requestAnimationFrame(scroll)
        }

        if (e.clientY < gridRect.top + SCROLL_ZONE) {
          startAutoScroll('up')
        } else if (e.clientY > gridRect.bottom - SCROLL_ZONE) {
          startAutoScroll('down')
        } else if (scrollAnimRef.current) {
          cancelAnimationFrame(scrollAnimRef.current)
          scrollAnimRef.current = null
        }

        return // Don't fall through to drag-to-select
      }

      if (!dragStartRef.current) return

      const dx = e.clientX - dragStartRef.current.x
      const dy = e.clientY - dragStartRef.current.y
      const dist = Math.sqrt(dx * dx + dy * dy)

      // Need at least 10px of movement to start drag
      if (dist < 10) return

      // Prevent text selection
      e.preventDefault()
      isDraggingRef.current = true

      const wrapper = e.currentTarget as HTMLElement
      const gridEl = wrapper.querySelector(
        '.sx__week-grid, .sx__day-grid-wrapper, .sx__time-grid',
      ) as HTMLElement | null
      if (!gridEl || !dragStartRef.current.date) return

      // Calculate raw hours
      const startHour = getTimeFromY(dragStartRef.current.y, gridEl)
      const endHour = getTimeFromY(e.clientY, gridEl)

      // Snap to 30-min boundaries
      const snapHour = (h: number) => Math.round(h * 2) / 2
      const snappedStart = snapHour(Math.min(startHour, endHour))
      const snappedEnd = snapHour(Math.max(startHour, endHour))

      // Convert snapped hours back to pixel positions
      const totalHours = dayEndHour - dayStartHour
      const pixelsPerHour = gridEl.scrollHeight / totalHours
      const gridRect = gridEl.getBoundingClientRect()
      const wrapperRect = wrapper.getBoundingClientRect()

      const snappedTopY = (snappedStart - dayStartHour) * pixelsPerHour - gridEl.scrollTop + gridRect.top - wrapperRect.top
      const snappedBottomY = (snappedEnd - dayStartHour) * pixelsPerHour - gridEl.scrollTop + gridRect.top - wrapperRect.top

      const colRect = dragStartRef.current.dayColRect
      if (!colRect) return

      // Build display times
      const dayDate = dragStartRef.current.date
      const startTime = buildDateFromHour(dayDate, snappedStart)
      const endTime = buildDateFromHour(dayDate, snappedEnd)
      dragEndTimeRef.current = endTime

      setDragSelection({
        left: colRect.left - wrapperRect.left,
        top: snappedTopY,
        width: colRect.width,
        height: Math.max(snappedBottomY - snappedTopY, pixelsPerHour * 0.5),
        startTime,
        endTime,
      })
    },
    [getTimeFromY, buildDateFromHour, getDayColumnInfo, updateDragMovePosition, viewRange, use12h, userTz],
  )

  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      // --- Phase 3: Drag-to-resize completion ---
      if (dragResizeStartRef.current) {
        const wasResizing = isDragResizingRef.current
        const resizeStart = dragResizeStartRef.current
        dragResizeStartRef.current = null
        isDragResizingRef.current = false
        setDragResizePreview(null)
        document.body.classList.remove('is-drag-resizing')

        // Cancel auto-scroll
        if (scrollAnimRef.current) {
          cancelAnimationFrame(scrollAnimRef.current)
          scrollAnimRef.current = null
        }

        if (!wasResizing) return

        const wrapper = e.currentTarget as HTMLElement
        const gridEl = wrapper.querySelector(
          '.sx__week-grid, .sx__day-grid-wrapper, .sx__time-grid',
        ) as HTMLElement | null
        if (!gridEl) return

        const hour = getTimeFromY(e.clientY, gridEl)
        const snappedHour = Math.round(hour * 2) / 2
        const origStart = resizeStart.originalStart
        const origStartHour = origStart.getHours() + origStart.getMinutes() / 60
        const minEndHour = origStartHour + 0.5
        const clampedEndHour = Math.max(minEndHour, Math.min(snappedHour, dayEndHour))
        const newEnd = buildDateFromHour(origStart, clampedEndHour)

        if (newEnd.getTime() !== resizeStart.originalEnd.getTime()) {
          if (resizeStart.eventId.includes('__')) {
            setSelectedEvent(resizeStart.masterId)
          } else {
            void updateEvent(resizeStart.masterId, { endDate: newEnd })
            // Phase 2B: Show undo toast for resize
            if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
            setUndoToast({
              eventId: resizeStart.masterId,
              originalStart: resizeStart.originalStart,
              originalEnd: resizeStart.originalEnd,
            })
            undoTimerRef.current = setTimeout(() => setUndoToast(null), 5000)
          }
        }

        // Suppress click handler
        isDragResizingRef.current = true
        setTimeout(() => {
          isDragResizingRef.current = false
        }, 100)

        return
      }

      // --- Drag-to-move completion (using shared helper) ---
      if (dragMoveStartRef.current) {
        if (!isDragMovingRef.current) {
          // Was a click, not a drag — let Schedule-X handle the event click
          dragMoveStartRef.current = null
          return
        }

        completeDragMove(e.clientX, e.clientY, e.currentTarget as HTMLElement)
        return
      }

      const dragStart = dragStartRef.current
      dragStartRef.current = null
      setDragSelection(null)

      if (!isDraggingRef.current || !dragStart?.date || !dragEndTimeRef.current) {
        isDraggingRef.current = false
        return
      }

      // Compute snapped start and end
      let start = snapTo30Min(dragStart.date)
      let end = snapTo30Min(dragEndTimeRef.current)

      // Ensure start is before end (user may drag upward)
      if (start > end) {
        const tmp = start
        start = end
        end = tmp
      }

      // If start === end, make it 1 hour
      if (start.getTime() === end.getTime()) {
        end = new Date(start)
        end.setHours(end.getHours() + 1)
      }

      const position = { x: e.clientX, y: e.clientY }
      onSlotClick?.({ startDate: start, endDate: end, allDay: false, position })

      // Keep isDraggingRef true briefly to suppress the Schedule-X click handler
      setTimeout(() => {
        isDraggingRef.current = false
      }, 100)
    },
    [onSlotClick, getTimeFromY, buildDateFromHour, setSelectedEvent, updateEvent, completeDragMove],
  )

  // ESC key handler for cancelling drag-to-move and drag-to-resize
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (isDragMovingRef.current || dragMoveStartRef.current) {
          dragMoveStartRef.current = null
          isDragMovingRef.current = false
          setDragMovePreview(null)
          document.body.classList.remove('is-drag-moving')
        }
        if (isDragResizingRef.current || dragResizeStartRef.current) {
          dragResizeStartRef.current = null
          isDragResizingRef.current = false
          setDragResizePreview(null)
          document.body.classList.remove('is-drag-resizing')
        }
        // Cancel auto-scroll
        if (scrollAnimRef.current) {
          cancelAnimationFrame(scrollAnimRef.current)
          scrollAnimRef.current = null
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Phase 2C: Touch handlers for mobile long-press drag
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (effectiveView === 'month') return
      const touch = e.touches[0]
      const target = touch.target as HTMLElement
      if (!target.closest('.sx__time-grid-event')) return

      const wrapper = e.currentTarget as HTMLElement
      const gridEl = wrapper.querySelector(
        '.sx__week-grid, .sx__day-grid-wrapper, .sx__time-grid',
      ) as HTMLElement | null
      if (!gridEl) return

      const event = findEventAtPosition(
        touch.clientX,
        touch.clientY,
        wrapper,
        gridEl,
        viewRange,
        displayEvents,
        getTimeFromY,
      )
      if (!event) return

      const startX = touch.clientX
      const startY = touch.clientY

      // Start long-press timer
      longPressTimerRef.current = setTimeout(() => {
        // Activate drag
        dragMoveStartRef.current = {
          eventId: event.id,
          masterId: event.masterId,
          originalStart: event.startDate,
          originalEnd: event.endDate,
          duration: event.endDate.getTime() - event.startDate.getTime(),
          startY,
          startX,
          startTime: 0, // Already past threshold
        }
        isDragMovingRef.current = true
        document.body.classList.add('is-drag-moving')
        // Haptic feedback if available
        if (navigator.vibrate) navigator.vibrate(50)
      }, 500)
    },
    [effectiveView, viewRange, displayEvents, getTimeFromY],
  )

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (longPressTimerRef.current && !isDragMovingRef.current) {
        // Cancel long-press if finger moves before 500ms
        const touch = e.touches[0]
        const dx = touch.clientX - (dragMoveStartRef.current?.startX ?? touch.clientX)
        const dy = touch.clientY - (dragMoveStartRef.current?.startY ?? touch.clientY)
        if (Math.sqrt(dx * dx + dy * dy) > 10) {
          clearTimeout(longPressTimerRef.current)
          longPressTimerRef.current = null
          return
        }
      }

      if (!isDragMovingRef.current || !dragMoveStartRef.current) return
      e.preventDefault() // Prevent page scroll

      const touch = e.touches[0]
      const wrapper = e.currentTarget as HTMLElement
      const gridEl = wrapper.querySelector(
        '.sx__week-grid, .sx__day-grid-wrapper, .sx__time-grid',
      ) as HTMLElement | null
      if (!gridEl) return

      // Shared position computation
      updateDragMovePosition(touch.clientX, touch.clientY, wrapper, gridEl)

      // Auto-scroll near edges
      const SCROLL_ZONE = 50
      const gridRect = gridEl.getBoundingClientRect()

      const startAutoScroll = (direction: 'up' | 'down') => {
        const scroll = () => {
          if (!isDragMovingRef.current) return
          gridEl.scrollTop += direction === 'down' ? 4 : -4
          scrollAnimRef.current = requestAnimationFrame(scroll)
        }
        if (scrollAnimRef.current) cancelAnimationFrame(scrollAnimRef.current)
        scrollAnimRef.current = requestAnimationFrame(scroll)
      }

      if (touch.clientY < gridRect.top + SCROLL_ZONE) {
        startAutoScroll('up')
      } else if (touch.clientY > gridRect.bottom - SCROLL_ZONE) {
        startAutoScroll('down')
      } else if (scrollAnimRef.current) {
        cancelAnimationFrame(scrollAnimRef.current)
        scrollAnimRef.current = null
      }
    },
    [updateDragMovePosition],
  )

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current)
        longPressTimerRef.current = null
      }

      if (!isDragMovingRef.current || !dragMoveStartRef.current) return

      const touch = e.changedTouches[0]
      // Complete the drop using shared helper
      completeDragMove(touch.clientX, touch.clientY, e.currentTarget as HTMLElement)
    },
    [completeDragMove],
  )

  // Cleanup auto-scroll and timers on unmount
  useEffect(() => {
    return () => {
      if (scrollAnimRef.current) cancelAnimationFrame(scrollAnimRef.current)
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    }
  }, [])

  return (
    <>
      <div
        ref={rootRef}
        className="sx-silentsuite-calendar relative flex-1 min-h-0"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {/* Calendar color styles injected via useInsertionEffect above */}
        <ScheduleXCalendar calendarApp={calendar} />
        {dragSelection && (
          <div
            ref={selectionRef}
            className="pointer-events-none absolute rounded-lg bg-[rgb(var(--primary))]/15 border-2 border-[rgb(var(--primary))]/50 z-20 flex flex-col justify-between py-1 px-2"
            style={{
              left: dragSelection.left,
              top: dragSelection.top,
              width: dragSelection.width,
              height: dragSelection.height,
            }}
          >
            {dragSelection.startTime && dragSelection.endTime && (
              <>
                <span className="text-[11px] font-medium text-[rgb(var(--primary))] leading-none">
                  {dragSelection.startTime.toLocaleTimeString('en-US', {
                    hour: 'numeric',
                    minute: '2-digit',
                    hour12: use12h,
                    timeZone: userTz,
                  })}
                </span>
                <span className="text-[11px] font-medium text-[rgb(var(--primary))] leading-none self-end">
                  {dragSelection.endTime.toLocaleTimeString('en-US', {
                    hour: 'numeric',
                    minute: '2-digit',
                    hour12: use12h,
                    timeZone: userTz,
                  })}
                </span>
              </>
            )}
          </div>
        )}
        {/* Drag-to-move ghost */}
        {dragMovePreview && (
          <div
            className="pointer-events-none absolute rounded-lg bg-emerald-500/20 border-2 border-emerald-500/60 z-20 flex flex-col justify-between py-1 px-2 shadow-lg"
            style={{
              left: dragMovePreview.left,
              top: dragMovePreview.top,
              width: dragMovePreview.width,
              height: dragMovePreview.height,
            }}
          >
            <span className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 leading-none truncate">
              {dragMovePreview.title}
            </span>
            <span className="text-[10px] font-medium text-emerald-600/80 dark:text-emerald-400/80 leading-none">
              {dragMovePreview.timeLabel}
            </span>
          </div>
        )}
        {/* Phase 3: Drag-to-resize ghost */}
        {dragResizePreview && (
          <div
            className="pointer-events-none absolute rounded-lg bg-blue-500/20 border-2 border-blue-500/60 z-20 flex flex-col justify-end py-1 px-2 shadow-lg"
            style={{
              left: dragResizePreview.left,
              top: dragResizePreview.top,
              width: dragResizePreview.width,
              height: dragResizePreview.height,
            }}
          >
            <span className="text-[10px] font-medium text-blue-600/80 dark:text-blue-400/80 leading-none">
              {dragResizePreview.timeLabel}
            </span>
          </div>
        )}
      </div>
      {/* Phase 2B: Undo toast — OUTSIDE the calendar wrapper to avoid pointer-events-none during drag */}
      {undoToast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-lg bg-[rgb(var(--foreground))] px-4 py-3 text-sm text-[rgb(var(--background))] shadow-xl animate-in slide-in-from-bottom-2">
          <span>Event moved</span>
          <button
            onClick={() => {
              void updateEvent(undoToast.eventId, {
                startDate: undoToast.originalStart,
                endDate: undoToast.originalEnd,
              })
              setUndoToast(null)
              if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
            }}
            className="font-medium text-emerald-400 hover:text-emerald-300 transition-colors"
          >
            Undo
          </button>
          <button
            onClick={() => {
              setUndoToast(null)
              if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
            }}
            className="ml-1 text-[rgb(var(--background))]/60 hover:text-[rgb(var(--background))] transition-colors"
            aria-label="Dismiss"
          >
            &times;
          </button>
        </div>
      )}
    </>
  )
}
