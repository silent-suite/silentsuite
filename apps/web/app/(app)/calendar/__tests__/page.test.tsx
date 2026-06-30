import { fireEvent, screen, within } from '@testing-library/react'
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
    setCurrentDate: vi.fn(),
    setCurrentView: vi.fn(),
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
  syncState: {
    initialSyncState: 'synced' as const,
    error: null as string | null,
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

vi.mock('@/app/stores/use-sync-store', () => ({
  useSyncStore: (selector: (state: typeof storeMock.syncState) => unknown) => selector(storeMock.syncState),
}))

vi.mock('@/app/stores/use-preferences-store', () => ({
  usePreferencesStore: (selector: (state: { dateFormat: 'system'; firstDayOfWeek: 'monday' }) => unknown) => selector({ dateFormat: 'system', firstDayOfWeek: 'monday' }),
}))

vi.mock('@/app/components/PullToRefresh', () => ({
  PullToRefresh: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock('../components/CalendarViewSwitcher', () => ({
  CalendarViewSwitcher: () => null,
}))

vi.mock('../components/CalendarGrid', () => ({
  CalendarGrid: ({ events, displayView }: { events: { title: string }[]; displayView?: 'threeDay' | 'sevenDay' }) => (
    <div
      data-testid={displayView === 'threeDay' ? 'mobile-three-day-grid' : displayView === 'sevenDay' ? 'mobile-seven-day-grid' : 'desktop-grid'}
      data-display-view={displayView ?? 'store'}
    >
      {events.map((event) => <span key={event.title}>{event.title}</span>)}
    </div>
  ),
}))

vi.mock('../components/AgendaView', () => ({
  AgendaView: ({ events, mode }: { events: { title: string }[]; mode?: 'day' | 'upcoming' }) => (
    <div data-testid="mobile-agenda" data-mode={mode ?? 'day'}>
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

function resetCalendarMocks() {
  storeMock.calendarState.currentView = 'week'
  storeMock.calendarState.currentDate = new Date('2026-06-01T12:00:00Z')
  storeMock.calendarState.selectedEventId = null
  storeMock.calendarState.searchQuery = ''
  storeMock.calendarState.navigateForward.mockReset()
  storeMock.calendarState.navigateBackward.mockReset()
  storeMock.calendarState.navigateToday.mockReset()
  storeMock.calendarState.setSelectedEvent.mockReset()
  storeMock.calendarState.setCurrentDate.mockReset()
  storeMock.calendarState.setCurrentView.mockReset()
  storeMock.calendarState.setSearchQuery.mockReset()
  storeMock.authState.canWrite.mockReturnValue(true)
  storeMock.syncState.initialSyncState = 'synced'
  storeMock.syncState.error = null
}

describe('CalendarPage calendar visibility', () => {
  beforeEach(() => {
    resetCalendarMocks()
    storeMock.calendarState.isLoading = false
    storeMock.calendarState.events = [
      { id: 'visible-event', calendarId: 'visible-cal', title: 'Visible event' },
      { id: 'hidden-event', calendarId: 'hidden-cal', title: 'Hidden event' },
    ]
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

  it('keeps hidden calendar events out of the mobile multi-day grids', () => {
    renderWithIntl(<CalendarPage />)

    fireEvent.click(screen.getByRole('button', { name: '3 days' }))

    const threeDayGrid = within(screen.getByTestId('mobile-three-day-grid'))
    expect(threeDayGrid.getByText('Visible event')).toBeInTheDocument()
    expect(threeDayGrid.queryByText('Hidden event')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mobile-agenda')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '7 days' }))
    const sevenDayGrid = within(screen.getByTestId('mobile-seven-day-grid'))
    expect(sevenDayGrid.getByText('Visible event')).toBeInTheDocument()
    expect(sevenDayGrid.queryByText('Hidden event')).not.toBeInTheDocument()
  })
})

describe('CalendarPage mobile reachability', () => {
  beforeEach(() => {
    resetCalendarMocks()
    storeMock.calendarState.isLoading = true
    storeMock.calendarState.events = []
    storeMock.calendarListState.calendars = []
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

  it('exposes mobile Agenda, 3-day, and 7-day view controls with accessible state', () => {
    renderWithIntl(<CalendarPage />)

    const agenda = screen.getByRole('button', { name: 'Agenda' })
    const threeDays = screen.getByRole('button', { name: '3 days' })
    const sevenDays = screen.getByRole('button', { name: '7 days' })

    expect(agenda.className).toContain('max-md:min-h-[44px]')
    expect(threeDays.className).toContain('max-md:min-h-[44px]')
    expect(sevenDays.className).toContain('max-md:min-h-[44px]')
    expect(agenda).toHaveAttribute('aria-pressed', 'true')
    expect(threeDays).toHaveAttribute('aria-pressed', 'false')
    expect(sevenDays).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(threeDays)

    expect(threeDays).toHaveAttribute('aria-pressed', 'true')
    expect(storeMock.calendarState.setCurrentView).not.toHaveBeenCalledWith('threeDay')

    fireEvent.click(sevenDays)
    expect(sevenDays).toHaveAttribute('aria-pressed', 'true')
    expect(storeMock.calendarState.setCurrentView).not.toHaveBeenCalledWith('sevenDay')
  })

  it('moves mobile multi-day navigation by the selected range without changing the desktop view', () => {
    renderWithIntl(<CalendarPage />)

    fireEvent.click(screen.getByRole('button', { name: '3 days' }))

    const mobileNext = screen.getAllByRole('button', { name: 'Next' }).find((btn) => btn.className.includes('max-md:min-h-[44px]'))!
    fireEvent.click(mobileNext)
    expect(storeMock.calendarState.setCurrentDate).toHaveBeenLastCalledWith(new Date('2026-06-04T12:00:00Z'))
    expect(storeMock.calendarState.navigateForward).not.toHaveBeenCalled()

    const mobilePrevious = screen.getAllByRole('button', { name: 'Previous' }).find((btn) => btn.className.includes('max-md:min-h-[44px]'))!
    fireEvent.click(mobilePrevious)
    expect(storeMock.calendarState.setCurrentDate).toHaveBeenLastCalledWith(new Date('2026-05-29T12:00:00Z'))
    expect(storeMock.calendarState.navigateBackward).not.toHaveBeenCalled()
    expect(storeMock.calendarState.setCurrentView).not.toHaveBeenCalledWith('threeDay')

    fireEvent.click(screen.getByRole('button', { name: '7 days' }))
    fireEvent.click(mobileNext)
    expect(storeMock.calendarState.setCurrentDate).toHaveBeenLastCalledWith(new Date('2026-06-08T12:00:00Z'))
    fireEvent.click(mobilePrevious)
    expect(storeMock.calendarState.setCurrentDate).toHaveBeenLastCalledWith(new Date('2026-05-25T12:00:00Z'))
    expect(storeMock.calendarState.setCurrentView).not.toHaveBeenCalledWith('sevenDay')
  })

  it('shows short range labels in mobile multi-day modes', () => {
    storeMock.calendarState.currentDate = new Date('2026-12-31T12:00:00Z')

    renderWithIntl(<CalendarPage />)

    fireEvent.click(screen.getByRole('button', { name: '3 days' }))

    expect(screen.getByText('Dec 31, 2026 – Jan 2, 2027')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '7 days' }))
    expect(screen.getByText('Dec 31, 2026 – Jan 6, 2027')).toBeInTheDocument()
  })

  it('passes upcoming mode into the mobile agenda by default', () => {
    storeMock.calendarState.isLoading = false

    renderWithIntl(<CalendarPage />)

    expect(screen.getByTestId('mobile-agenda')).toHaveAttribute('data-mode', 'upcoming')
  })

  it('shows restore copy instead of an empty calendar before initial sync completes', () => {
    storeMock.calendarState.isLoading = false
    storeMock.syncState.initialSyncState = 'restoring'

    renderWithIntl(<CalendarPage />)

    expect(screen.getByText('Restoring encrypted data…')).toBeInTheDocument()
    expect(screen.queryByTestId('mobile-agenda')).not.toBeInTheDocument()
  })

  it('does not render the calendar as empty when the encrypted session is missing', () => {
    storeMock.calendarState.isLoading = false
    storeMock.syncState.initialSyncState = 'no-session'

    renderWithIntl(<CalendarPage />)

    expect(screen.getByText('Encrypted session needs to be restored')).toBeInTheDocument()
    expect(screen.queryByTestId('mobile-agenda')).not.toBeInTheDocument()
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
