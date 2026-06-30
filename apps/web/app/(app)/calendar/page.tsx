'use client'

import { useCallback, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronLeft, ChevronRight, Plus, Folder, Search as SearchIcon } from 'lucide-react'
import { usePreferencesStore } from '@/app/stores/use-preferences-store'
import { formatDate, startOfWeek, getWeekNumber } from '@/app/lib/date'
import { useCalendarStore } from '@/app/stores/use-calendar-store'
import { useCalendarListStore } from '@/app/stores/use-calendar-list-store'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { useSyncStore } from '@/app/stores/use-sync-store'
import { SyncStartupState } from '@/app/components/empty-state'
import { PullToRefresh } from '@/app/components/PullToRefresh'
import { MobileCollectionSheet } from '@/app/components/MobileCollectionSheet'
import { CalendarViewSwitcher } from './components/CalendarViewSwitcher'
import { CalendarGrid, type SlotClickEvent, type EventClickInfo } from './components/CalendarGrid'
import { AgendaView } from './components/AgendaView'
import { EventDialog } from './components/EventDialog'
import { FloatingAddButton } from './components/FloatingAddButton'
import { resolveUserTimezone } from '@/app/lib/tz'

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

function formatSearchResultDate(
  date: Date,
  dateFormat: import('@silentsuite/core').DateFormat,
  timeFormat: string,
  timeZone: string,
  allDay: boolean,
): string {
  const dateLabel = formatDate(date, dateFormat, { dateStyle: 'medium' })
  if (allDay) return dateLabel

  const timeLabel = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: timeFormat !== '24h',
    timeZone,
  })
  return `${dateLabel}, ${timeLabel}`
}

type CalendarDateLabelView = 'week' | 'month' | 'threeDay' | 'sevenDay'
type MobileCalendarMode = 'agenda' | 'threeDay' | 'sevenDay'

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function formatDateRange(
  date: Date,
  view: CalendarDateLabelView,
  dateFormat: import('@silentsuite/core').DateFormat,
  firstDay: import('@silentsuite/core').FirstDayOfWeek,
): string {
  const opts: Intl.DateTimeFormatOptions = { month: 'long', year: 'numeric' }

  if (view === 'month') {
    return formatDate(date, dateFormat, opts)
  }

  if (view === 'threeDay' || view === 'sevenDay') {
    const rangeStart = new Date(date.getFullYear(), date.getMonth(), date.getDate())
    const rangeEnd = addDays(rangeStart, view === 'threeDay' ? 2 : 6)
    const startMonth = formatDate(rangeStart, 'system', { month: 'short' })
    const endMonth = formatDate(rangeEnd, 'system', { month: 'short' })

    if (rangeStart.getFullYear() !== rangeEnd.getFullYear()) {
      return `${startMonth} ${rangeStart.getDate()}, ${rangeStart.getFullYear()} – ${endMonth} ${rangeEnd.getDate()}, ${rangeEnd.getFullYear()}`
    }
    if (rangeStart.getMonth() !== rangeEnd.getMonth()) {
      return `${startMonth} ${rangeStart.getDate()} – ${endMonth} ${rangeEnd.getDate()}, ${rangeStart.getFullYear()}`
    }
    return `${startMonth} ${rangeStart.getDate()}–${rangeEnd.getDate()}, ${rangeStart.getFullYear()}`
  }

  // Week view: derive the week start/end from the first-day preference
  const weekStart = startOfWeek(date, firstDay)
  const weekEnd = new Date(weekStart)
  weekEnd.setDate(weekStart.getDate() + 6)

  const startMonth = formatDate(weekStart, 'system', { month: 'long' })
  const endMonth = formatDate(weekEnd, 'system', { month: 'long' })

  if (weekStart.getMonth() === weekEnd.getMonth()) {
    return `${startMonth} ${weekStart.getDate()}–${weekEnd.getDate()}, ${weekStart.getFullYear()}`
  }
  if (weekStart.getFullYear() === weekEnd.getFullYear()) {
    return `${startMonth} ${weekStart.getDate()} – ${endMonth} ${weekEnd.getDate()}, ${weekStart.getFullYear()}`
  }
  return `${startMonth} ${weekStart.getDate()}, ${weekStart.getFullYear()} – ${endMonth} ${weekEnd.getDate()}, ${weekEnd.getFullYear()}`
}

function CalendarSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-3">
      {/* Desktop: grid skeleton */}
      <div className="hidden md:flex md:flex-1 md:flex-col gap-2">
        <div className="flex gap-1">
          {[1, 2, 3, 4, 5, 6, 7].map((i) => (
            <div key={i} className="flex-1 h-8 rounded skeleton-shimmer" />
          ))}
        </div>
        <div className="flex-1 rounded-lg skeleton-shimmer" />
      </div>
      {/* Mobile: agenda skeleton */}
      <div className="flex flex-col gap-2 md:hidden">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex items-start gap-3 rounded-lg border border-[rgb(var(--border))]/50 p-3">
            <div className="mt-1 h-2 w-2 rounded-full skeleton-shimmer" />
            <div className="flex-1 space-y-2">
              <div className="h-4 rounded skeleton-shimmer" style={{ width: `${50 + i * 10}%` }} />
              <div className="h-3 w-24 rounded skeleton-shimmer" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

interface CreateDialogState {
  startDate: Date
  endDate: Date
  allDay: boolean
}

export default function CalendarPage() {
  const t = useTranslations('Collections')
  const canWrite = useAuthStore((s) => s.canWrite())
  const events = useCalendarStore((s) => s.events)
  const isLoading = useCalendarStore((s) => s.isLoading)
  const currentView = useCalendarStore((s) => s.currentView)
  const currentDate = useCalendarStore((s) => s.currentDate)
  const navigateForward = useCalendarStore((s) => s.navigateForward)
  const navigateBackward = useCalendarStore((s) => s.navigateBackward)
  const navigateToday = useCalendarStore((s) => s.navigateToday)
  const setCurrentDate = useCalendarStore((s) => s.setCurrentDate)
  const selectedEventId = useCalendarStore((s) => s.selectedEventId)
  const setSelectedEvent = useCalendarStore((s) => s.setSelectedEvent)
  const calendars = useCalendarListStore((s) => s.calendars)
  const dateFormat = usePreferencesStore((s) => s.dateFormat)
  const timeFormat = usePreferencesStore((s) => s.timeFormat)
  const defaultTimezonePref = usePreferencesStore((s) => s.defaultTimezone)
  const firstDayOfWeek = usePreferencesStore((s) => s.firstDayOfWeek)
  const initialSyncState = useSyncStore((s) => s.initialSyncState)
  const syncError = useSyncStore((s) => s.error)
  const userTz = resolveUserTimezone(defaultTimezonePref)

  const [createDialog, setCreateDialog] = useState<CreateDialogState | null>(null)
  const [eventInstanceDate, setEventInstanceDate] = useState<Date | undefined>(undefined)
  const [collectionSheetOpen, setCollectionSheetOpen] = useState(false)
  const [mobileCalendarMode, setMobileCalendarMode] = useState<MobileCalendarMode>('agenda')

  const dateLabel = useMemo(
    () => formatDateRange(currentDate, currentView, dateFormat, firstDayOfWeek),
    [currentDate, currentView, dateFormat, firstDayOfWeek],
  )
  const mobileDateLabel = useMemo(
    () => formatDateRange(
      currentDate,
      mobileCalendarMode === 'agenda' ? currentView : mobileCalendarMode,
      dateFormat,
      firstDayOfWeek,
    ),
    [currentDate, currentView, dateFormat, firstDayOfWeek, mobileCalendarMode],
  )

  // Active calendar-week indicator (#292). Shown in week view; respects the
  // first-day-of-week preference (ISO-8601 for Monday-start). Updates as the
  // user navigates because it derives from currentDate.
  const weekNumber = useMemo(
    () => (currentView === 'week' ? getWeekNumber(currentDate, firstDayOfWeek) : null),
    [currentView, currentDate, firstDayOfWeek],
  )

  const visibleCalendarIds = useMemo(
    () => {
      const visibleIds = calendars.filter((calendar) => calendar.visible).map((calendar) => calendar.id)
      return new Set(calendars.length === 0 ? ['default', ...visibleIds] : visibleIds)
    },
    [calendars],
  )

  const visibleEvents = useMemo(
    () => events.filter((event) => visibleCalendarIds.has(event.calendarId ?? 'default')),
    [events, visibleCalendarIds],
  )
  const initialLoadComplete = initialSyncState === 'synced' || initialSyncState === 'empty'
  const shouldShowStartupState = !isLoading && visibleEvents.length === 0 && !initialLoadComplete

  // Search
  const searchQuery = useCalendarStore((s) => s.searchQuery)
  const setSearchQuery = useCalendarStore((s) => s.setSearchQuery)
  const filteredEvents = useCalendarStore((s) => s.getFilteredEvents())
  const calendarColors = useMemo(() => {
    const colors = new Map<string, string>()
    for (const calendar of calendars) colors.set(calendar.id, calendar.color)
    if (!colors.has('default')) colors.set('default', '#10b981')
    return colors
  }, [calendars])
  const visibleSearchResults = useMemo(
    () => filteredEvents.filter((event) => visibleCalendarIds.has(event.calendarId ?? 'default')),
    [filteredEvents, visibleCalendarIds],
  )

  const handleSlotClick = useCallback((slot: SlotClickEvent) => {
    if (!canWrite) return
    setCreateDialog({
      startDate: slot.startDate,
      endDate: slot.endDate,
      allDay: slot.allDay,
    })
  }, [canWrite])

  const handleCreateDialogClose = useCallback(() => {
    setCreateDialog(null)
  }, [])

  const handleEventClick = useCallback((info: EventClickInfo) => {
    setEventInstanceDate(info.instanceDate)
    // Close create dialog if open
    setCreateDialog(null)
  }, [])

  const handleEventDetailClose = useCallback(() => {
    setSelectedEvent(null)
    setEventInstanceDate(undefined)
  }, [setSelectedEvent])

  const selectedEvent = useMemo(
    () => (selectedEventId ? events.find((e) => e.id === selectedEventId) : undefined),
    [selectedEventId, events],
  )

  const handleMobileNavigateBackward = useCallback(() => {
    if (mobileCalendarMode !== 'agenda') {
      setCurrentDate(addDays(currentDate, mobileCalendarMode === 'threeDay' ? -3 : -7))
      return
    }
    navigateBackward()
  }, [currentDate, mobileCalendarMode, navigateBackward, setCurrentDate])

  const handleMobileNavigateForward = useCallback(() => {
    if (mobileCalendarMode !== 'agenda') {
      setCurrentDate(addDays(currentDate, mobileCalendarMode === 'threeDay' ? 3 : 7))
      return
    }
    navigateForward()
  }, [currentDate, mobileCalendarMode, navigateForward, setCurrentDate])

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Desktop toolbar */}
      <div className="hidden md:flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button
            onClick={navigateToday}
            className="no-min-size rounded-md border border-[rgb(var(--border))] px-3 py-1.5 text-sm font-medium text-[rgb(var(--foreground))] hover:bg-[rgb(var(--surface))] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
          >
            Today
          </button>
          <button
            onClick={navigateBackward}
            className="no-min-size rounded-md p-1.5 text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] hover:bg-[rgb(var(--surface))] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
            aria-label="Previous"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            onClick={navigateForward}
            className="no-min-size rounded-md p-1.5 text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] hover:bg-[rgb(var(--surface))] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
            aria-label="Next"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
          <h2 className="text-lg font-semibold text-[rgb(var(--foreground))]">{dateLabel}</h2>
          {weekNumber !== null && (
            <span
              className="rounded-md bg-[rgb(var(--surface))] px-2 py-0.5 text-xs font-medium text-[rgb(var(--muted))]"
              title="Calendar week"
            >
              Week {weekNumber}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <CalendarViewSwitcher />
          <button
            onClick={() => {
              const now = new Date()
              const start = snapTo30Min(now)
              const end = new Date(start)
              end.setHours(end.getHours() + 1)
              setCreateDialog({ startDate: start, endDate: end, allDay: false })
            }}
            disabled={!canWrite}
            className={`flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 ${!canWrite ? 'opacity-50 cursor-not-allowed' : 'hover:bg-emerald-500'}`}
            aria-label="New event"
            title={!canWrite ? 'Subscription required' : undefined}
          >
            <Plus className="h-4 w-4" />
            <span className="hidden lg:inline">New event</span>
          </button>
        </div>
      </div>

      {/* Mobile toolbar */}
      <div className="flex flex-col gap-2 md:hidden">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <button
              onClick={handleMobileNavigateBackward}
              className="max-md:min-h-[44px] max-md:min-w-[44px] max-md:flex max-md:items-center max-md:justify-center rounded-md text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] active:bg-[rgb(var(--surface))] transition-colors"
              aria-label="Previous"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              onClick={navigateToday}
              className="max-md:min-h-[44px] max-md:min-w-[44px] max-md:flex max-md:items-center max-md:justify-center rounded-md px-3 text-sm font-medium text-[rgb(var(--foreground))] hover:bg-[rgb(var(--surface))] active:bg-[rgb(var(--border))] transition-colors"
            >
              Today
            </button>
            <button
              onClick={handleMobileNavigateForward}
              className="max-md:min-h-[44px] max-md:min-w-[44px] max-md:flex max-md:items-center max-md:justify-center rounded-md text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] active:bg-[rgb(var(--surface))] transition-colors"
              aria-label="Next"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
          <button
            onClick={() => setCollectionSheetOpen(true)}
            className="touch-target md:hidden rounded-md text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] active:bg-[rgb(var(--surface))] transition-colors"
            aria-label={t('manageCalendars')}
          >
            <Folder className="h-5 w-5" />
          </button>
        </div>
        <div className="flex items-center gap-2 px-1">
          <h2 className="text-base font-semibold text-[rgb(var(--foreground))]">{mobileDateLabel}</h2>
          {mobileCalendarMode === 'agenda' && weekNumber !== null && (
            <span
              className="rounded-md bg-[rgb(var(--surface))] px-2 py-0.5 text-xs font-medium text-[rgb(var(--muted))]"
              title="Calendar week"
            >
              Week {weekNumber}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 px-1" role="group" aria-label="Mobile calendar view">
          <button
            type="button"
            onClick={() => setMobileCalendarMode('agenda')}
            aria-pressed={mobileCalendarMode === 'agenda'}
            className={`max-md:min-h-[44px] rounded-md px-3 text-sm font-medium transition-colors ${
              mobileCalendarMode === 'agenda'
                ? 'bg-[rgb(var(--primary))] text-white'
                : 'text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] active:bg-[rgb(var(--surface))]'
            }`}
          >
            Agenda
          </button>
          <button
            type="button"
            onClick={() => setMobileCalendarMode('threeDay')}
            aria-pressed={mobileCalendarMode === 'threeDay'}
            className={`max-md:min-h-[44px] rounded-md px-3 text-sm font-medium transition-colors ${
              mobileCalendarMode === 'threeDay'
                ? 'bg-[rgb(var(--primary))] text-white'
                : 'text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] active:bg-[rgb(var(--surface))]'
            }`}
          >
            3 days
          </button>
          <button
            type="button"
            onClick={() => setMobileCalendarMode('sevenDay')}
            aria-pressed={mobileCalendarMode === 'sevenDay'}
            className={`max-md:min-h-[44px] rounded-md px-3 text-sm font-medium transition-colors ${
              mobileCalendarMode === 'sevenDay'
                ? 'bg-[rgb(var(--primary))] text-white'
                : 'text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] active:bg-[rgb(var(--surface))]'
            }`}
          >
            7 days
          </button>
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <CalendarSkeleton />
      ) : shouldShowStartupState ? (
        <SyncStartupState state={initialSyncState} error={syncError} />
      ) : (
        <>
          {/* Search bar */}
          <div className="px-1">
            <div className="hidden md:block">
              <div className="relative max-w-md">
                <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[rgb(var(--muted))]" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search events..."
                  aria-label="Search events"
                  className="w-full rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] pl-9 pr-3 py-2 text-sm text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                />
              </div>
              {searchQuery.trim() !== '' && (
                <div className="mt-2 max-w-md space-y-1">
                  {visibleSearchResults.map((e) => {
                    const calendarId = e.calendarId ?? 'default'
                    const calendarName = calendars.find((calendar) => calendar.id === calendarId)?.name
                    return (
                      <button
                        key={e.id}
                        type="button"
                        onClick={() => {
                          // Navigate calendar to event date and open event
                          useCalendarStore.getState().setCurrentDate(new Date(e.startDate))
                          useCalendarStore.getState().setSelectedEvent(e.id)
                        }}
                        className="w-full text-left rounded-md px-3 py-2 hover:bg-[rgb(var(--surface))]"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            aria-hidden="true"
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: calendarColors.get(calendarId) ?? '#10b981' }}
                          />
                          <span className="text-sm font-medium text-[rgb(var(--foreground))] truncate">{e.title || 'Untitled'}</span>
                        </div>
                        <div className="ml-4 text-xs text-[rgb(var(--muted))] truncate">
                          {calendarName ? `${calendarName} · ` : ''}{formatSearchResultDate(e.startDate, dateFormat, timeFormat, userTz, e.allDay)}
                        </div>
                      </button>
                    )
                  })}
                  {visibleSearchResults.length === 0 && (
                    <div className="text-xs text-[rgb(var(--muted))]">No results</div>
                  )}
                </div>
              )}
            </div>

            {/* Mobile search: inline above agenda */}
            <div className="md:hidden mb-2">
              <div className="relative">
                <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[rgb(var(--muted))]" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search events..."
                  aria-label="Search events"
                  className="w-full rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))] pl-9 pr-3 py-2 text-sm text-[rgb(var(--foreground))] placeholder:text-[rgb(var(--muted))] focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                />
              </div>
            </div>
          </div>

          {/* Desktop: schedule-x grid */}
          <div className="hidden md:flex md:flex-1 md:min-h-0">
            <CalendarGrid events={visibleEvents} onSlotClick={handleSlotClick} onEventClick={handleEventClick} />
          </div>

          {/* Mobile: upcoming agenda list or multi-day grid */}
          <div className="flex flex-col flex-1 min-h-0 md:hidden">
            {mobileCalendarMode === 'agenda' ? (
              <PullToRefresh>
                <AgendaView
                  events={visibleEvents}
                  currentDate={currentDate}
                  calendars={calendars}
                  mode="upcoming"
                  onEventClick={(id, instanceDate) => {
                    setSelectedEvent(id)
                    setEventInstanceDate(instanceDate)
                  }}
                />
              </PullToRefresh>
            ) : (
              <div className="mobile-calendar-grid-scroll flex flex-1 min-h-[520px] overflow-x-auto overflow-y-hidden pb-1">
                <CalendarGrid
                  key={mobileCalendarMode}
                  displayView={mobileCalendarMode}
                  events={visibleEvents}
                  onSlotClick={handleSlotClick}
                  onEventClick={handleEventClick}
                />
              </div>
            )}
          </div>
        </>
      )}

      {/* Create event dialog (GNOME-style centered modal) */}
      {createDialog && (
        <EventDialog
          mode="create"
          startDate={createDialog.startDate}
          endDate={createDialog.endDate}
          allDay={createDialog.allDay}
          onClose={handleCreateDialogClose}
        />
      )}

      {/* Edit event dialog (GNOME-style centered modal) */}
      {selectedEvent && (
        <EventDialog
          mode="edit"
          event={selectedEvent}
          instanceDate={eventInstanceDate}
          onClose={handleEventDetailClose}
        />
      )}

      {/* Mobile floating add button */}
      <FloatingAddButton />

      {/* Mobile collection management sheet */}
      <MobileCollectionSheet
        type="calendar"
        open={collectionSheetOpen}
        onClose={() => setCollectionSheetOpen(false)}
      />
    </div>
  )
}
