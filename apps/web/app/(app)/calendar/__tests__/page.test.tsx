import { render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CalendarPage from '../page'

const storeMock = vi.hoisted(() => ({
  calendarState: {
    events: [] as any[],
    isLoading: false,
    currentView: 'week' as const,
    currentDate: new Date('2026-06-01T12:00:00Z'),
    navigateForward: vi.fn(),
    navigateBackward: vi.fn(),
    navigateToday: vi.fn(),
    selectedEventId: null as string | null,
    setSelectedEvent: vi.fn(),
    searchQuery: '',
    setSearchQuery: vi.fn(),
    getFilteredEvents: () => storeMock.calendarState.events,
  },
  calendarListState: {
    calendars: [] as any[],
  },
  authState: {
    canWrite: vi.fn(() => true),
  },
}))

vi.mock('@/app/stores/use-calendar-store', () => ({
  useCalendarStore: (selector: (state: typeof storeMock.calendarState) => unknown) => selector(storeMock.calendarState),
}))

vi.mock('@/app/stores/use-calendar-list-store', () => ({
  useCalendarListStore: (selector: (state: typeof storeMock.calendarListState) => unknown) => selector(storeMock.calendarListState),
}))

vi.mock('@/app/stores/use-auth-store', () => ({
  useAuthStore: (selector: (state: typeof storeMock.authState) => unknown) => selector(storeMock.authState),
}))

vi.mock('@/app/stores/use-preferences-store', () => ({
  usePreferencesStore: (selector: (state: { dateFormat: 'system' }) => unknown) => selector({ dateFormat: 'system' }),
}))

vi.mock('@/app/components/PullToRefresh', () => ({
  PullToRefresh: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock('../components/CalendarViewSwitcher', () => ({
  CalendarViewSwitcher: () => null,
}))

vi.mock('../components/CalendarGrid', () => ({
  CalendarGrid: ({ events }: { events: { title: string }[] }) => (
    <div data-testid="desktop-grid">
      {events.map((event) => <span key={event.title}>{event.title}</span>)}
    </div>
  ),
}))

vi.mock('../components/AgendaView', () => ({
  AgendaView: ({ events }: { events: { title: string }[] }) => (
    <div data-testid="mobile-agenda">
      {events.map((event) => <span key={event.title}>{event.title}</span>)}
    </div>
  ),
}))

vi.mock('../components/EventDialog', () => ({
  EventDialog: () => null,
}))

vi.mock('../components/FloatingAddButton', () => ({
  FloatingAddButton: () => null,
}))

describe('CalendarPage calendar visibility', () => {
  beforeEach(() => {
    storeMock.calendarState.events = [
      { id: 'visible-event', calendarId: 'visible-cal', title: 'Visible event' },
      { id: 'hidden-event', calendarId: 'hidden-cal', title: 'Hidden event' },
    ]
    storeMock.calendarState.selectedEventId = null
    storeMock.calendarState.searchQuery = ''
    storeMock.calendarState.setSearchQuery.mockReset()
    storeMock.calendarListState.calendars = [
      { id: 'visible-cal', name: 'Visible', color: '#10b981', visible: true },
      { id: 'hidden-cal', name: 'Hidden', color: '#ef4444', visible: false },
    ]
  })

  it('keeps hidden calendar events out of desktop grid and mobile agenda', () => {
    render(<CalendarPage />)

    const desktopGrid = within(screen.getByTestId('desktop-grid'))
    expect(desktopGrid.getByText('Visible event')).toBeInTheDocument()
    expect(desktopGrid.queryByText('Hidden event')).not.toBeInTheDocument()

    const mobileAgenda = within(screen.getByTestId('mobile-agenda'))
    expect(mobileAgenda.getByText('Visible event')).toBeInTheDocument()
    expect(mobileAgenda.queryByText('Hidden event')).not.toBeInTheDocument()
  })
})
