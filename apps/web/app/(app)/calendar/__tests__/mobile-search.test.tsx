import { fireEvent, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarEvent } from '@silentsuite/core'
import CalendarPage from '../calendar-workspace'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'

// Mobile search must mount the real EventDialog. Store actions are spies, the
// same boundary EventDialog.test.tsx uses. Selection and search are reactive
// so a result click can actually open the dialog. This is not a live-sync fixture.

const calendarMock = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const listener of listeners) listener()
  }
  const occurrence = new Date(2026, 5, 8, 9, 0, 0)
  const seriesStart = new Date(2026, 4, 25, 9, 0, 0)
  let filteredSnapshot: CalendarEvent[] = []
  let filteredKey = ''
  const state = {
    events: [] as CalendarEvent[],
    currentView: 'week' as const,
    currentDate: new Date(2026, 5, 1, 12, 0, 0),
    selectedEventId: null as string | null,
    searchQuery: '',
    navigateForward: vi.fn(),
    navigateBackward: vi.fn(),
    navigateToday: vi.fn(),
    setCurrentView: vi.fn(),
    createEvent: vi.fn(),
    updateEvent: vi.fn(),
    deleteEvent: vi.fn(),
    updateRecurringEvent: vi.fn(),
    deleteRecurringEvent: vi.fn(),
    setCurrentDate: (date: Date) => {
      state.currentDate = date
      emit()
    },
    setSelectedEvent: (id: string | null) => {
      state.selectedEventId = id
      emit()
    },
    setSearchQuery: (query: string) => {
      state.searchQuery = query
      emit()
    },
    getFilteredEvents: () => {
      const query = state.searchQuery.trim().toLowerCase()
      const key = `${query}\0${state.events.map((event) => event.id).join(',')}`
      if (key === filteredKey) return filteredSnapshot
      filteredKey = key
      filteredSnapshot = !query
        ? state.events
        : state.events.filter((event) => {
            const title = (event.title ?? '').toLowerCase()
            const description = (event.description ?? '').toLowerCase()
            const location = (event.location ?? '').toLowerCase()
            const categories = (event.categories ?? []).join(' ').toLowerCase()
            return title.includes(query) || description.includes(query) || location.includes(query) || categories.includes(query)
          })
      return filteredSnapshot
    },
  }
  return { state, listeners, occurrence, seriesStart }
})

vi.mock('@/app/stores/use-calendar-store', () => {
  const { useSyncExternalStore } = require('react') as typeof import('react')
  function useCalendarStore<T>(selector: (state: typeof calendarMock.state) => T): T {
    const getSnapshot = () => selector(calendarMock.state)
    return useSyncExternalStore(
      (onStoreChange) => {
        calendarMock.listeners.add(onStoreChange)
        return () => { calendarMock.listeners.delete(onStoreChange) }
      },
      getSnapshot,
      getSnapshot,
    )
  }
  useCalendarStore.getState = () => calendarMock.state
  return { useCalendarStore }
})

vi.mock('@/app/stores/use-calendar-list-store', () => {
  const listState = {
    calendars: [
      { id: 'cal-a', name: 'Work', color: '#10b981', visible: true },
      { id: 'cal-hidden', name: 'Archive', color: '#64748b', visible: false },
    ],
    defaultCalendarId: 'cal-a',
  }
  return {
    useCalendarListStore: function useCalendarListStore<T>(selector: (state: typeof listState) => T): T {
      return selector(listState)
    },
  }
})

vi.mock('@/app/stores/use-auth-store', () => ({
  useAuthStore: function useAuthStore<T>(selector: (state: { canWrite: () => boolean; user: { email: string } }) => T): T {
    return selector({ canWrite: () => true, user: { email: 'fixture@example.invalid' } })
  },
}))

vi.mock('@/app/stores/use-preferences-store', () => {
  const preferences = {
    defaultReminder: 'none',
    timeFormat: '24h',
    defaultTimezone: 'UTC',
    dateFormat: 'system' as const,
    firstDayOfWeek: 'monday' as const,
  }
  const usePreferencesStore = function usePreferencesStore<T>(selector: (state: typeof preferences) => T): T {
    return selector(preferences)
  }
  usePreferencesStore.getState = () => preferences
  return { usePreferencesStore }
})

vi.mock('@/app/stores/use-preferences-sync-store', () => ({
  usePreferencesSyncStore: (selector: (state: { status: 'ready' }) => unknown) => selector({ status: 'ready' }),
}))

vi.mock('@/app/providers/notification-provider', () => ({
  useNotifications: () => ({ permission: 'granted', requestPermission: vi.fn() }),
}))

vi.mock('@/app/lib/sync-timing', () => ({ logCalendarPaintTiming: vi.fn() }))

vi.mock('@/app/components/PullToRefresh', () => ({
  PullToRefresh: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock('../components/CalendarViewSwitcher', () => ({ CalendarViewSwitcher: () => null }))
vi.mock('../components/CalendarGrid', () => ({ CalendarGrid: () => <div data-testid="desktop-grid" /> }))
vi.mock('../components/FloatingAddButton', () => ({ FloatingAddButton: () => null }))
vi.mock('@/app/components/MobileCollectionSheet', () => ({
  MobileCollectionSheet: () => null,
}))

vi.mock('../components/AgendaView', () => ({
  AgendaView: ({ onEventClick }: { onEventClick?: (id: string, instanceDate?: Date) => void }) => (
    <button type="button" onClick={() => onEventClick?.('standup', calendarMock.occurrence)}>
      Open standup occurrence
    </button>
  ),
}))

function event(overrides: Partial<CalendarEvent> & { id: string; title: string; calendarId: string }): CalendarEvent {
  return {
    uid: overrides.id,
    description: '',
    location: '',
    startDate: calendarMock.seriesStart,
    endDate: new Date(calendarMock.seriesStart.getTime() + 60 * 60 * 1000),
    allDay: false,
    recurrenceRule: null,
    exceptions: [],
    alarms: [],
    categories: [],
    timezone: 'UTC',
    created: calendarMock.seriesStart,
    updated: calendarMock.seriesStart,
    ...overrides,
  }
}

function mobileSearchRoot() {
  const input = screen.getAllByLabelText('Search events').find((field) => field.closest('[class*="md:hidden"]'))
  expect(input, 'mobile search field').toBeTruthy()
  return input!.closest('[class*="md:hidden"]')!
}

function desktopResultsRoot() {
  const root = document.querySelector('.hidden.md\\:block')
  expect(root, 'desktop search results container').toBeTruthy()
  return root as HTMLElement
}

describe('Calendar mobile search', () => {
  beforeEach(() => {
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    calendarMock.state.events = []
    calendarMock.state.selectedEventId = null
    calendarMock.state.searchQuery = ''
    calendarMock.state.currentDate = new Date(2026, 5, 1, 12, 0, 0)
    calendarMock.state.deleteRecurringEvent.mockReset()
  })

  it('opens the real edit dialog from an existing occurrence before search changes', () => {
    calendarMock.state.events = [
      event({ id: 'standup', title: 'Standup', calendarId: 'cal-a', recurrenceRule: 'FREQ=WEEKLY' }),
    ]
    renderWithIntl(<CalendarPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Open standup occurrence' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit event' })
    expect(within(dialog).getByDisplayValue('Standup')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Edit recurring event' })).not.toBeInTheDocument()
  })

  it('shows a matching result in the mobile search container and opens the real edit dialog', () => {
    calendarMock.state.events = [
      event({ id: 'standup', title: 'Standup', calendarId: 'cal-a' }),
      event({ id: 'hidden-standup', title: 'Hidden standup', calendarId: 'cal-hidden' }),
    ]
    renderWithIntl(<CalendarPage />)

    fireEvent.change(screen.getAllByLabelText('Search events').find((field) => field.closest('[class*="md:hidden"]'))!, {
      target: { value: 'standup' },
    })

    const mobile = mobileSearchRoot()
    const result = within(mobile).getByRole('button', { name: /^Standup\b/ })
    expect(within(mobile).queryByRole('button', { name: /Hidden standup/ })).not.toBeInTheDocument()
    expect(within(desktopResultsRoot()).getByRole('button', { name: /^Standup\b/ })).toBeInTheDocument()
    expect(within(desktopResultsRoot()).queryByRole('button', { name: /Hidden standup/ })).not.toBeInTheDocument()

    fireEvent.click(result)
    const dialog = screen.getByRole('dialog', { name: 'Edit event' })
    expect(within(dialog).getByDisplayValue('Standup')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Edit recurring event' })).not.toBeInTheDocument()
  })

  it('opens a search result as the series after an occurrence was selected, not as that occurrence', () => {
    calendarMock.state.events = [
      event({ id: 'standup', title: 'Standup', calendarId: 'cal-a', recurrenceRule: 'FREQ=WEEKLY' }),
    ]
    renderWithIntl(<CalendarPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Open standup occurrence' }))
    expect(screen.getByRole('dialog', { name: 'Edit event' })).toBeInTheDocument()

    // Leave the occurrence context in place. Closing would already clear it, so this
    // uses the result click that exists today and must clear the occurrence itself.
    const desktopInput = screen.getAllByLabelText('Search events').find((field) => field.closest('.hidden.md\\:block'))
    expect(desktopInput).toBeTruthy()
    fireEvent.change(desktopInput!, { target: { value: 'standup' } })
    fireEvent.click(within(desktopResultsRoot()).getByRole('button', { name: /^Standup\b/ }))

    expect(screen.queryByRole('dialog', { name: 'Edit recurring event' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete event' }))
    fireEvent.click(screen.getByRole('button', { name: /^This event/ }))

    expect(calendarMock.state.deleteRecurringEvent).toHaveBeenCalledTimes(1)
    const instance = calendarMock.state.deleteRecurringEvent.mock.calls[0]?.[2] as Date
    expect(instance.getTime()).toBe(calendarMock.seriesStart.getTime())
    expect(instance.getTime()).not.toBe(calendarMock.occurrence.getTime())
  })
})
