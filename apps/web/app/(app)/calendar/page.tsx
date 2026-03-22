'use client'

import { useCallback, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { useCalendarStore } from '@/app/stores/use-calendar-store'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { PullToRefresh } from '@/app/components/PullToRefresh'
import { CalendarViewSwitcher } from './components/CalendarViewSwitcher'
import { CalendarGrid, type SlotClickEvent, type EventClickInfo } from './components/CalendarGrid'
import { AgendaView } from './components/AgendaView'
import { EventDialog } from './components/EventDialog'
import { FloatingAddButton } from './components/FloatingAddButton'

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

function formatDateRange(date: Date, view: 'week' | 'month'): string {
  const opts: Intl.DateTimeFormatOptions = { month: 'long', year: 'numeric' }

  if (view === 'month') {
    return date.toLocaleDateString('en-US', opts)
  }

  // Week view: find Monday of the week
  const day = date.getDay()
  const mondayOffset = day === 0 ? -6 : 1 - day
  const monday = new Date(date)
  monday.setDate(date.getDate() + mondayOffset)
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)

  const startMonth = monday.toLocaleDateString('en-US', { month: 'long' })
  const endMonth = sunday.toLocaleDateString('en-US', { month: 'long' })

  if (monday.getMonth() === sunday.getMonth()) {
    return `${startMonth} ${monday.getDate()}–${sunday.getDate()}, ${monday.getFullYear()}`
  }
  if (monday.getFullYear() === sunday.getFullYear()) {
    return `${startMonth} ${monday.getDate()} – ${endMonth} ${sunday.getDate()}, ${monday.getFullYear()}`
  }
  return `${startMonth} ${monday.getDate()}, ${monday.getFullYear()} – ${endMonth} ${sunday.getDate()}, ${sunday.getFullYear()}`
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
  const canWrite = useAuthStore((s) => s.canWrite())
  const events = useCalendarStore((s) => s.events)
  const isLoading = useCalendarStore((s) => s.isLoading)
  const currentView = useCalendarStore((s) => s.currentView)
  const currentDate = useCalendarStore((s) => s.currentDate)
  const navigateForward = useCalendarStore((s) => s.navigateForward)
  const navigateBackward = useCalendarStore((s) => s.navigateBackward)
  const navigateToday = useCalendarStore((s) => s.navigateToday)
  const selectedEventId = useCalendarStore((s) => s.selectedEventId)
  const setSelectedEvent = useCalendarStore((s) => s.setSelectedEvent)

  const [createDialog, setCreateDialog] = useState<CreateDialogState | null>(null)
  const [eventInstanceDate, setEventInstanceDate] = useState<Date | undefined>(undefined)

  const dateLabel = useMemo(
    () => formatDateRange(currentDate, currentView),
    [currentDate, currentView],
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
              onClick={navigateBackward}
              className="rounded-md p-2 text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] active:bg-[rgb(var(--surface))] transition-colors"
              aria-label="Previous"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              onClick={navigateToday}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-[rgb(var(--foreground))] hover:bg-[rgb(var(--surface))] active:bg-[rgb(var(--border))] transition-colors"
            >
              Today
            </button>
            <button
              onClick={navigateForward}
              className="rounded-md p-2 text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] active:bg-[rgb(var(--surface))] transition-colors"
              aria-label="Next"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
          <CalendarViewSwitcher />
        </div>
        <h2 className="text-base font-semibold text-[rgb(var(--foreground))] px-1">{dateLabel}</h2>
      </div>

      {/* Content */}
      {isLoading ? (
        <CalendarSkeleton />
      ) : (
        <>
          {/* Desktop: schedule-x grid */}
          <div className="hidden md:flex md:flex-1 md:min-h-0">
            <CalendarGrid events={events} onSlotClick={handleSlotClick} onEventClick={handleEventClick} />
          </div>

          {/* Mobile: agenda list view */}
          <div className="flex flex-col flex-1 md:hidden">
            <PullToRefresh>
              <AgendaView
                events={events}
                currentDate={currentDate}
                onEventClick={(id) => {
                  setSelectedEvent(id)
                  setEventInstanceDate(undefined)
                }}
              />
            </PullToRefresh>
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
    </div>
  )
}
