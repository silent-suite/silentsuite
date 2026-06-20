import { screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CalendarPage from '../page'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import messages from '@/messages/en.json'
import type { CalendarEvent } from '@silentsuite/core'
import type { CalendarList } from '@/app/stores/use-calendar-list-store'

// Calendar page tests. The visibility suite guards against hidden calendars
// leaking into the agenda/grid; the mobile reachability suite (epic #295)
// asserts the nav buttons and collection switcher render with accessible
// labels and the expected responsive / touch-target classes. jsdom does not
// evaluate CSS media queries, so both suites complement manual width QA.
// Accessible names backed by next-intl messages are resolved from the message
// catalog so the tests do not couple to English copy.

const manageCalendars = messages.Collections.manageCalendars

const storeMock = vi.hoisted(() => ({
  calendarState: {
    events: [] as CalendarEvent[],
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
    calendars: [] as CalendarList[],
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

vi.mock('@/app/components/MobileCollectionSheet', () => ({
  MobileCollectionSheet: ({ open }: { open: boolean }) => (open ? <div data-testid="collection-sheet" /> : null),
}))

describe('CalendarPage calendar visibility', () => {
  beforeEach(() => {
    storeMock.calendarState.isLoading = false
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
    renderWithIntl(<CalendarPage />)

    const desktopGrid = within(screen.getByTestId('desktop-grid'))
    expect(desktopGrid.getByText('Visible event')).toBeInTheDocument()
    expect(desktopGrid.queryByText('Hidden event')).not.toBeInTheDocument()

    const mobileAgenda = within(screen.getByTestId('mobile-agenda'))
    expect(mobileAgenda.getByText('Visible event')).toBeInTheDocument()
    expect(mobileAgenda.queryByText('Hidden event')).not.toBeInTheDocument()
  })
})

describe('CalendarPage mobile reachability', () => {
  beforeEach(() => {
    storeMock.calendarState.isLoading = true
    storeMock.calendarState.events = []
    storeMock.calendarState.searchQuery = ''
    storeMock.calendarListState.calendars = []
    storeMock.authState.canWrite.mockReturnValue(true)
  })

  it('exposes mobile nav buttons with a mobile-scoped 44px hit area', () => {
    renderWithIntl(<CalendarPage />)

    // The prev/next nav buttons are rendered twice (desktop + mobile toolbars);
    // jsdom does not apply the hidden/md:hidden classes, so both are in the
    // DOM. The mobile pair carries the mobile-scoped sizing variants instead
    // of the global touch-target utility, keeping desktop density unchanged.
    const prevButtons = screen.getAllByRole('button', { name: 'Previous' })
    expect(prevButtons).toHaveLength(2)
    const mobilePrev = prevButtons.find((btn) => btn.className.includes('max-md:min-h-[44px]'))
    expect(mobilePrev).toBeDefined()
    expect(mobilePrev!.className).toContain('max-md:min-w-[44px]')
    expect(mobilePrev!.className).not.toContain('touch-target')

    const nextButtons = screen.getAllByRole('button', { name: 'Next' })
    expect(nextButtons).toHaveLength(2)
    const mobileNext = nextButtons.find((btn) => btn.className.includes('max-md:min-h-[44px]'))
    expect(mobileNext).toBeDefined()
    expect(mobileNext!.className).toContain('max-md:min-w-[44px]')
    expect(mobileNext!.className).not.toContain('touch-target')
  })

  it('exposes a Today button with a mobile-scoped touch target', () => {
    renderWithIntl(<CalendarPage />)

    const todayButtons = screen.getAllByRole('button', { name: 'Today' })
    expect(todayButtons).toHaveLength(2)
    const mobileToday = todayButtons.find((btn) => btn.className.includes('max-md:min-h-[44px]'))
    expect(mobileToday).toBeDefined()
    expect(mobileToday!.className).toContain('max-md:min-w-[44px]')
    expect(mobileToday!.className).not.toContain('touch-target')
  })

  it('exposes a mobile collection switcher with a 44px touch target', () => {
    renderWithIntl(<CalendarPage />)

    const folderButton = screen.getByRole('button', { name: manageCalendars })
    expect(folderButton).toBeInTheDocument()
    // Mobile-only control that meets the minimum touch target.
    expect(folderButton.className).toContain('md:hidden')
    expect(folderButton.className).toContain('touch-target')
  })
})
