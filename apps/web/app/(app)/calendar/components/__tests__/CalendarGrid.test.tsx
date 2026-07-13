import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { StrictMode } from 'react'
import type { CalendarEvent } from '@silentsuite/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CalendarGrid } from '../CalendarGrid'

const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>
}

const mocks = vi.hoisted(() => {
  const calendarState = {
    currentView: 'week' as const,
    currentDate: new Date('2026-07-13T12:00:00.000Z'),
    setSelectedEvent: vi.fn(),
    setCurrentView: vi.fn(),
    setCurrentDate: vi.fn(),
    updateEvent: vi.fn(),
  }
  const preferencesState = {
    timeFormat: '24h' as const,
    defaultTimezone: 'UTC',
    firstDayOfWeek: 'monday' as const,
    dayStartHour: 7,
    dayEndHour: 23,
  }
  const calendar = {
    $app: {
      config: {
        timezone: { value: 'UTC' },
        firstDayOfWeek: { value: 1 },
        dayBoundaries: { value: { start: 700, end: 2300 } },
        weekOptions: { value: { gridHeight: 900 } },
      },
      calendarState: {
        setView: vi.fn(),
        setRange: vi.fn(),
        range: { value: { start: '2026-07-13', end: '2026-07-19' } },
      },
      datePickerState: { selectedDate: { value: null } },
    },
  }
  return {
    calendar,
    calendarState,
    preferencesState,
    latestConfig: undefined as Record<string, any> | undefined,
    setEvents: vi.fn(),
    requestAnimationFrame: vi.fn(),
    projectedSegment: true,
  }
})

vi.mock('@schedule-x/calendar', () => ({
  createViewMonthGrid: vi.fn(() => ({ name: 'month-grid' })),
  createViewWeek: vi.fn(() => ({ name: 'week' })),
  viewMonthGrid: { name: 'month-grid' },
  viewWeek: { name: 'week' },
}))

vi.mock('@schedule-x/events-service', () => ({
  createEventsServicePlugin: vi.fn(() => ({ set: mocks.setEvents })),
}))

vi.mock('@schedule-x/react', () => ({
  useNextCalendarApp: (config: Record<string, any>) => {
    mocks.latestConfig = config
    return mocks.calendar
  },
  ScheduleXCalendar: () => (
    <div className="sx-react-calendar-wrapper" data-testid="schedule-x">
      <div className="sx__week-grid" data-testid="time-grid">
        <div className="sx__time-grid-day" data-testid="day-column">
          <div
            className={`sx__time-grid-event${mocks.projectedSegment ? ' ss-timegrid-multiday-segment' : ''}`}
            data-testid="projected-event"
          >
            <span data-testid="projected-segment">segment</span>
          </div>
        </div>
      </div>
    </div>
  ),
}))

vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }))

vi.mock('@/app/stores/use-auth-store', () => ({
  useAuthStore: (selector: (state: { canWrite: () => boolean }) => unknown) => selector({ canWrite: () => true }),
}))

vi.mock('@/app/stores/use-calendar-store', () => {
  const useCalendarStore = (selector: (state: typeof mocks.calendarState) => unknown) => selector(mocks.calendarState)
  useCalendarStore.getState = () => mocks.calendarState
  return { useCalendarStore }
})

vi.mock('@/app/stores/use-preferences-store', () => {
  const usePreferencesStore = (selector: (state: typeof mocks.preferencesState) => unknown) => selector(mocks.preferencesState)
  usePreferencesStore.getState = () => mocks.preferencesState
  return { usePreferencesStore }
})

vi.mock('@/app/stores/use-calendar-list-store', () => ({
  useCalendarListStore: (selector: (state: { calendars: Array<{ id: string; color: string }> }) => unknown) => selector({
    calendars: [{ id: 'cal-1', color: '#10b981' }],
  }),
}))

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'event-1',
    uid: 'event-1@example.test',
    title: 'Overnight',
    description: '',
    location: '',
    startDate: new Date('2026-07-13T09:00:00.000Z'),
    endDate: new Date('2026-07-13T10:00:00.000Z'),
    allDay: false,
    recurrenceRule: null,
    exceptions: [],
    status: 'confirmed',
    transparency: 'opaque',
    calendarId: 'cal-1',
    categories: [],
    ...overrides,
  }
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.latestConfig = undefined
  mocks.projectedSegment = true
  mocks.calendarState.currentView = 'week'
  mocks.calendarState.currentDate = new Date('2026-07-13T12:00:00.000Z')
  mocks.preferencesState.defaultTimezone = 'UTC'
  mocks.calendar.$app.config.dayBoundaries.value = { start: 700, end: 2300 }
  mocks.calendar.$app.config.weekOptions.value = { gridHeight: 900 }
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  mocks.requestAnimationFrame.mockImplementation((callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  vi.stubGlobal('requestAnimationFrame', mocks.requestAnimationFrame)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('navigator', { ...navigator, vibrate: vi.fn() })
})

function renderGestureHarness(projected: boolean) {
  mocks.projectedSegment = projected
  const gestureEvent = event({
    startDate: new Date(2026, 6, 13, 9, 0),
    endDate: new Date(2026, 6, 13, 10, 0),
  })
  const rendered = render(<StrictMode><CalendarGrid events={[gestureEvent]} /></StrictMode>)
  const target = screen.getByTestId('projected-segment')
  const eventElement = screen.getByTestId('projected-event')
  const grid = screen.getByTestId('time-grid')
  const dayColumn = screen.getByTestId('day-column')
  const calendarWrapper = screen.getByTestId('schedule-x').parentElement as HTMLElement
  vi.spyOn(eventElement, 'getBoundingClientRect').mockReturnValue(rect(0, 100, 200, 200))
  vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 200, 1600))
  vi.spyOn(dayColumn, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 200, 1600))
  vi.spyOn(calendarWrapper, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 200, 1600))
  Object.defineProperty(grid, 'scrollHeight', { configurable: true, value: 1600 })
  Object.defineProperty(grid, 'scrollTop', { configurable: true, value: 0, writable: true })
  return { ...rendered, target, eventElement, grid }
}

describe('CalendarGrid timed-event integration', () => {
  it('pins the Schedule-X versions whose private classifier behavior is relied on', () => {
    expect(packageJson.dependencies['@schedule-x/calendar']).toBe('4.3.1')
    expect(packageJson.dependencies['@schedule-x/events-service']).toBe('4.3.1')
    expect(packageJson.dependencies['@schedule-x/theme-default']).toBe('4.3.1')
    expect(packageJson.dependencies['@schedule-x/react']).toBe('4.1.0')
  })

  it('updates numeric boundaries for projected events and shrinks them after removal', async () => {
    const { rerender } = render(
      <StrictMode><CalendarGrid events={[event()]} /></StrictMode>,
    )

    expect(mocks.latestConfig?.dayBoundaries).toEqual({ start: '07:00', end: '23:00' })

    rerender(
      <StrictMode>
        <CalendarGrid events={[event({
          startDate: new Date('2026-07-13T22:00:00.000Z'),
          endDate: new Date('2026-07-15T01:00:00.000Z'),
        })]} />
      </StrictMode>,
    )

    await waitFor(() => {
      expect(mocks.calendar.$app.config.dayBoundaries.value).toEqual({ start: 0, end: 2400 })
    })

    rerender(<StrictMode><CalendarGrid events={[]} /></StrictMode>)
    await waitFor(() => {
      expect(mocks.calendar.$app.config.dayBoundaries.value).toEqual({ start: 700, end: 2300 })
    })
  })

  it('maps projected IDs back to the source occurrence and rejects unknown IDs', async () => {
    const onEventClick = vi.fn()
    render(
      <StrictMode>
        <CalendarGrid
          events={[event({
            startDate: new Date('2026-07-13T22:00:00.000Z'),
            endDate: new Date('2026-07-15T01:00:00.000Z'),
          })]}
          onEventClick={onEventClick}
        />
      </StrictMode>,
    )

    await waitFor(() => expect(mocks.setEvents).toHaveBeenCalled())
    const projected = mocks.setEvents.mock.calls.at(-1)?.[0][0]
    expect(String(projected.id)).toMatch(/^r[0-9a-f]{32}$/)

    act(() => mocks.latestConfig?.callbacks.onEventClick(projected))
    expect(mocks.calendarState.setSelectedEvent).toHaveBeenCalledWith('event-1')
    expect(onEventClick).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'event-1',
      masterEventId: 'event-1',
    }))

    mocks.calendarState.setSelectedEvent.mockClear()
    act(() => mocks.latestConfig?.callbacks.onEventClick({ id: 'unknown-render-id' }))
    expect(mocks.calendarState.setSelectedEvent).not.toHaveBeenCalled()
  })

  it('pushes live timezone and view changes through the Schedule-X signals', async () => {
    const { rerender } = render(<StrictMode><CalendarGrid events={[event()]} /></StrictMode>)
    mocks.preferencesState.defaultTimezone = 'America/New_York'

    rerender(
      <StrictMode>
        <CalendarGrid events={[event()]} displayView="threeDay" />
      </StrictMode>,
    )

    await waitFor(() => {
      expect(mocks.calendar.$app.config.timezone.value).toBe('America/New_York')
      expect(mocks.calendar.$app.calendarState.setView).toHaveBeenCalledWith(
        'week',
        expect.anything(),
      )
      expect(mocks.setEvents).toHaveBeenCalled()
    })
  })

  it('suppresses mouse and touch gesture side effects for projected segments', () => {
    const { container, target, eventElement: projectedEvent } = renderGestureHarness(true)
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const initialTimeoutCalls = timeoutSpy.mock.calls.length
    const initialRafCalls = mocks.requestAnimationFrame.mock.calls.length

    fireEvent.mouseMove(target, { clientX: 20, clientY: 200 })
    expect(projectedEvent.style.cursor).toBe('default')
    fireEvent.mouseDown(target, { button: 0, clientX: 20, clientY: 200 })
    fireEvent.mouseMove(target, { clientX: 25, clientY: 260 })
    fireEvent.mouseUp(target, { clientX: 25, clientY: 260 })
    fireEvent.mouseDown(target, { button: 0, clientX: 20, clientY: 296 })
    fireEvent.mouseMove(target, { clientX: 20, clientY: 360 })
    fireEvent.mouseUp(target, { clientX: 20, clientY: 360 })
    fireEvent.keyDown(document, { key: 'Escape' })

    fireEvent.touchStart(target, {
      touches: [{ clientX: 20, clientY: 200, target }],
    })
    fireEvent.touchMove(target, {
      touches: [{ clientX: 25, clientY: 260, target }],
    })
    fireEvent.touchEnd(target, {
      changedTouches: [{ clientX: 25, clientY: 260, target }],
    })

    expect(document.body.classList.contains('is-drag-moving')).toBe(false)
    expect(document.body.classList.contains('is-drag-resizing')).toBe(false)
    expect(container.querySelector('[class*="bg-emerald-500"]')).toBeNull()
    expect(container.querySelector('[class*="bg-blue-500"]')).toBeNull()
    expect(mocks.calendarState.updateEvent).not.toHaveBeenCalled()
    expect(navigator.vibrate).not.toHaveBeenCalled()
    expect(timeoutSpy.mock.calls.length).toBe(initialTimeoutCalls)
    expect(mocks.requestAnimationFrame.mock.calls.length).toBe(initialRafCalls)
  })

  it('proves the unguarded mouse-move path activates, cancels, and completes', () => {
    const { container, target, eventElement } = renderGestureHarness(false)
    fireEvent.mouseMove(target, { clientX: 20, clientY: 200 })
    expect(eventElement.style.cursor).toBe('grab')

    fireEvent.mouseDown(target, { button: 0, clientX: 20, clientY: 200 })
    fireEvent.mouseMove(target, { clientX: 25, clientY: 260 })
    expect(document.body.classList.contains('is-drag-moving')).toBe(true)
    expect(container.querySelector('[class*="bg-emerald-500"]')).not.toBeNull()
    mocks.requestAnimationFrame.mockImplementation(() => 42)
    const initialRafCalls = mocks.requestAnimationFrame.mock.calls.length
    fireEvent.mouseMove(target, { clientX: 25, clientY: 1590 })
    expect(mocks.requestAnimationFrame.mock.calls.length).toBeGreaterThan(initialRafCalls)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.body.classList.contains('is-drag-moving')).toBe(false)
    expect(container.querySelector('[class*="bg-emerald-500"]')).toBeNull()
    expect(mocks.calendarState.updateEvent).not.toHaveBeenCalled()

    fireEvent.mouseDown(target, { button: 0, clientX: 20, clientY: 200 })
    fireEvent.mouseMove(target, { clientX: 25, clientY: 260 })
    fireEvent.mouseUp(target, { clientX: 25, clientY: 260 })
    expect(document.body.classList.contains('is-drag-moving')).toBe(false)
    expect(mocks.calendarState.updateEvent).toHaveBeenCalledWith(
      'event-1',
      expect.objectContaining({ startDate: expect.any(Date), endDate: expect.any(Date) }),
    )
  })

  it('proves the unguarded bottom-edge resize path activates, cancels, and completes', () => {
    const { container, target } = renderGestureHarness(false)
    fireEvent.mouseDown(target, { button: 0, clientX: 20, clientY: 296 })
    fireEvent.mouseMove(target, { clientX: 20, clientY: 360 })
    expect(document.body.classList.contains('is-drag-resizing')).toBe(true)
    expect(container.querySelector('[class*="bg-blue-500"]')).not.toBeNull()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.body.classList.contains('is-drag-resizing')).toBe(false)
    expect(container.querySelector('[class*="bg-blue-500"]')).toBeNull()
    expect(mocks.calendarState.updateEvent).not.toHaveBeenCalled()

    fireEvent.mouseDown(target, { button: 0, clientX: 20, clientY: 296 })
    fireEvent.mouseMove(target, { clientX: 20, clientY: 360 })
    fireEvent.mouseUp(target, { clientX: 20, clientY: 360 })
    expect(document.body.classList.contains('is-drag-resizing')).toBe(false)
    expect(mocks.calendarState.updateEvent).toHaveBeenCalledWith(
      'event-1',
      expect.objectContaining({ endDate: expect.any(Date) }),
    )
  })

  it('proves the unguarded touch path activates timers, vibration, RAF, cancellation, and completion', () => {
    vi.useFakeTimers()
    try {
      const { container, target } = renderGestureHarness(false)

      fireEvent.touchStart(target, {
        touches: [{ clientX: 20, clientY: 200, target }],
      })
      act(() => vi.advanceTimersByTime(500))
      expect(document.body.classList.contains('is-drag-moving')).toBe(true)
      expect(navigator.vibrate).toHaveBeenCalledWith(50)

      fireEvent.touchMove(target, {
        touches: [{ clientX: 25, clientY: 1590, target }],
      })
      expect(container.querySelector('[class*="bg-emerald-500"]')).not.toBeNull()

      fireEvent.keyDown(document, { key: 'Escape' })
      expect(document.body.classList.contains('is-drag-moving')).toBe(false)
      expect(container.querySelector('[class*="bg-emerald-500"]')).toBeNull()
      expect(mocks.calendarState.updateEvent).not.toHaveBeenCalled()

      fireEvent.touchStart(target, {
        touches: [{ clientX: 20, clientY: 200, target }],
      })
      act(() => vi.advanceTimersByTime(500))
      fireEvent.touchMove(target, {
        touches: [{ clientX: 25, clientY: 260, target }],
      })
      fireEvent.touchEnd(target, {
        changedTouches: [{ clientX: 25, clientY: 260, target }],
      })
      expect(document.body.classList.contains('is-drag-moving')).toBe(false)
      expect(mocks.calendarState.updateEvent).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})