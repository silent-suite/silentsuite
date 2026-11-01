import { act, fireEvent, screen, within } from '@testing-library/react'
import { Component, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarEvent } from '@silentsuite/core'
import CalendarPage from '../calendar-workspace'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import { useCalendarStore } from '@/app/stores/use-calendar-store'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'

// #295: calendar search must keep working once a query is typed. This renders the real calendar
// workspace on the REAL calendar store (its zustand subscription, setSearchQuery and
// getFilteredEvents), seeded through setState. Only heavy view components, other stores and platform
// boundaries are replaced, as in page.test.tsx. jsdom does not evaluate CSS media queries, so this
// says nothing about mobile geometry; it checks that searching renders results instead of failing.

vi.mock('@/app/stores/use-calendar-list-store', () => {
  const listState = {
    calendars: [{ id: 'cal-a', name: 'Work', color: '#10b981', visible: true }],
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

vi.mock('@/app/lib/sync-timing', () => ({ logCalendarPaintTiming: vi.fn() }))

vi.mock('@/app/components/PullToRefresh', () => ({
  PullToRefresh: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock('../components/CalendarViewSwitcher', () => ({ CalendarViewSwitcher: () => null }))
vi.mock('../components/CalendarGrid', () => ({ CalendarGrid: () => <div data-testid="desktop-grid" /> }))
vi.mock('../components/AgendaView', () => ({
  AgendaView: ({ events }: { events: { id: string; title: string }[] }) => (
    <div data-testid="mobile-agenda">
      {events.map((item) => <span key={item.id}>{item.title}</span>)}
    </div>
  ),
}))
vi.mock('../components/EventDialog', () => ({ EventDialog: () => null }))
vi.mock('../components/FloatingAddButton', () => ({ FloatingAddButton: () => null }))
vi.mock('@/app/components/MobileCollectionSheet', () => ({ MobileCollectionSheet: () => null }))

const START = new Date(2026, 5, 8, 9, 0, 0)

function calendarEvent(id: string, title: string): CalendarEvent {
  return {
    id,
    uid: id,
    title,
    description: '',
    location: '',
    startDate: START,
    endDate: new Date(START.getTime() + 60 * 60 * 1000),
    allDay: false,
    recurrenceRule: null,
    exceptions: [],
    alarms: [],
    categories: [],
    calendarId: 'cal-a',
    timezone: 'UTC',
    created: START,
    updated: START,
  }
}

/** Records a render failure instead of letting it unmount the whole test tree. */
class RenderErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    return this.state.error
      ? <p data-testid="render-error">{this.state.error.message}</p>
      : this.props.children
  }
}

function mobileSearchRoot() {
  const input = screen.getAllByLabelText('Search events').find((field) => field.closest('[class*="md:hidden"]'))
  expect(input, 'mobile search field').toBeTruthy()
  return { input: input as HTMLInputElement, root: input!.closest<HTMLElement>('[class*="md:hidden"]')! }
}

// React's reports for this failure class: an unstable useSyncExternalStore snapshot and the
// resulting update loop (development message, or the production error code).
const RENDER_FAILURE = /Maximum update depth exceeded|getSnapshot should be cached|Minified React error #185/

describe('Calendar search on the real calendar store (#295)', () => {
  // Every render failure is captured and asserted, not silenced: errors React reports as uncaught
  // (window "error" events), errors thrown out of act, errors caught by the boundary above, and
  // React's console reports of this failure class. Other console output passes through unchanged.
  let uncaught: string[] = []
  let consoleErrors: string[] = []
  const originalConsoleError = console.error
  const onWindowError = (event: ErrorEvent) => {
    uncaught.push(String(event.error?.message ?? event.message))
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const renderFailures = () => [
    ...uncaught,
    ...consoleErrors,
    ...screen.queryAllByTestId('render-error').map((node) => node.textContent ?? ''),
  ]

  beforeEach(() => {
    uncaught = []
    consoleErrors = []
    window.addEventListener('error', onWindowError, true)
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      const text = args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ')
      if (RENDER_FAILURE.test(text)) consoleErrors.push(text)
      else originalConsoleError(...args)
    })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0))
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => window.clearTimeout(handle))

    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    useEtebaseStore.setState((state) => ({ domainLoadState: { ...state.domainLoadState, calendar: 'loaded' } }))
    useCalendarStore.setState(useCalendarStore.getInitialState(), true)
    useCalendarStore.setState({
      events: [calendarEvent('standup', 'Team standup'), calendarEvent('review', 'Design review')],
      currentDate: new Date(2026, 5, 1, 12, 0, 0),
      currentView: 'week',
      selectedEventId: null,
      searchQuery: '',
    })
  })

  afterEach(() => {
    window.removeEventListener('error', onWindowError, true)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  /** Types into the real mobile "Search events" field; a failure thrown out of act is recorded, then asserted. */
  function typeQuery(value: string) {
    try {
      act(() => { fireEvent.change(mobileSearchRoot().input, { target: { value } }) })
    } catch (error) {
      uncaught.push(error instanceof Error ? error.message : String(error))
    }
  }

  it('renders the agenda with an empty query, then shows matching results after typing a query', () => {
    renderWithIntl(<RenderErrorBoundary><CalendarPage /></RenderErrorBoundary>)

    // Empty query: the workspace renders from the real store without errors.
    expect(within(screen.getByTestId('mobile-agenda')).getByText('Team standup')).toBeInTheDocument()
    expect(renderFailures()).toEqual([])

    // A real typed query goes through the real setSearchQuery and getFilteredEvents.
    typeQuery('standup')
    expect(renderFailures(), 'typing a search query must not fail rendering').toEqual([])
    expect(useCalendarStore.getState().searchQuery).toBe('standup')
    const { root } = mobileSearchRoot()
    const results = within(root).getAllByRole('button')
    expect(results.map((button) => button.textContent)).toEqual([expect.stringContaining('Team standup')])
    expect(within(root).queryByText('Design review')).not.toBeInTheDocument()

    // A non-matching query, then clearing it, keep rendering.
    typeQuery('zzz-no-match')
    expect(within(mobileSearchRoot().root).getByText('No results')).toBeInTheDocument()
    typeQuery('')
    expect(within(mobileSearchRoot().root).queryAllByRole('button')).toHaveLength(0)
    expect(renderFailures()).toEqual([])
  })
})
