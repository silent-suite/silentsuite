import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { StrictMode, useSyncExternalStore } from 'react'
import type { CalendarEvent } from '@silentsuite/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CalendarGrid } from '../CalendarGrid'

const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>
}

const mocks = vi.hoisted(() => {
  const preferenceListeners = new Set<() => void>()
  const localeListeners = new Set<() => void>()
  const localeAssignments: string[] = []
  let localeValue = 'en-GB'
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
        locale: {
          get value() { return localeValue },
          set value(value: string) {
            localeAssignments.push(value)
            localeValue = value
            localeListeners.forEach((listener) => listener())
          },
        },
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
    preferenceListeners,
    localeListeners,
    localeAssignments,
    getLocale: () => localeValue,
    setLocale: (value: string) => { localeValue = value },
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
  ScheduleXCalendar: () => {
    const locale = useSyncExternalStore(
      (listener) => { mocks.localeListeners.add(listener); return () => mocks.localeListeners.delete(listener) },
      mocks.getLocale,
      mocks.getLocale,
    )
    const is24h = locale === 'en-GB'
    return (
    <div className="sx-react-calendar-wrapper" data-testid="schedule-x">
      <output aria-label={is24h ? '13/07/2026, 18:30' : '7/13/2026, 6:30 PM'}>
        {is24h ? '18:30 · 13/07/2026' : '6:30 PM · 7/13/2026'}
      </output>
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
    )
  },
}))

vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }))

// #738: which calendars are managed Birthdays calendars (identity is tested in the birthday library).
const birthdayGrid = vi.hoisted(() => ({ managed: [] as string[] }))
vi.mock('@/app/lib/birthday-calendar/session', () => ({
  isManagedBirthdayCalendar: (calendarId: string | null | undefined) => Boolean(calendarId && birthdayGrid.managed.includes(calendarId)),
  useManagedBirthdayCalendarIds: () => birthdayGrid.managed,
}))

vi.mock('@/app/stores/use-auth-store', () => ({
  useAuthStore: (selector: (state: { canWrite: () => boolean }) => unknown) => selector({ canWrite: () => true }),
}))

vi.mock('@/app/stores/use-calendar-store', () => {
  const useCalendarStore = (selector: (state: typeof mocks.calendarState) => unknown) => selector(mocks.calendarState)
  useCalendarStore.getState = () => mocks.calendarState
  return { useCalendarStore }
})

vi.mock('@/app/stores/use-preferences-store', () => {
  const usePreferencesStore = (selector: (state: typeof mocks.preferencesState) => unknown) => useSyncExternalStore(
    (listener) => { mocks.preferenceListeners.add(listener); return () => mocks.preferenceListeners.delete(listener) },
    () => selector(mocks.preferencesState),
    () => selector(mocks.preferencesState),
  )
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
  mocks.preferencesState.timeFormat = '24h'
  mocks.setLocale('en-GB')
  mocks.localeAssignments.length = 0
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
  it('updates mounted Schedule-X visible date and time output when synced time format changes', async () => {
    render(<CalendarGrid events={[]} />)
    expect(screen.getByText('18:30 · 13/07/2026')).toBeInTheDocument()

    act(() => {
      mocks.preferencesState.timeFormat = '12h'
      mocks.preferenceListeners.forEach((listener) => listener())
    })

    expect(await screen.findByText('6:30 PM · 7/13/2026')).toBeInTheDocument()
    expect(screen.getByLabelText('7/13/2026, 6:30 PM')).toBeInTheDocument()
  })

  it('updates mounted output from 12-hour back to 24-hour without remounting', async () => {
    mocks.preferencesState.timeFormat = '12h'
    mocks.setLocale('en-US')
    const { container } = render(<CalendarGrid events={[]} />)
    const instance = container.firstElementChild

    act(() => {
      mocks.preferencesState.timeFormat = '24h'
      mocks.preferenceListeners.forEach((listener) => listener())
    })

    expect(await screen.findByText('18:30 · 13/07/2026')).toBeInTheDocument()
    expect(container.firstElementChild).toBe(instance)
  })

  it('does not assign an equal locale during unrelated rerenders', () => {
    const { rerender } = render(<CalendarGrid events={[]} />)
    rerender(<CalendarGrid events={[]} />)
    expect(mocks.localeAssignments).toEqual([])
  })

  it('fails safely when the pinned locale signal is absent at effect time', () => {
    const locale = mocks.calendar.$app.config.locale
    ;(mocks.calendar.$app.config as any).locale = undefined
    expect(() => render(<CalendarGrid events={[]} />)).not.toThrow()
    mocks.calendar.$app.config.locale = locale
  })
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

  it('registers the current-time plugin next to the events service, in the display timezone', () => {
    mocks.calendar.$app.config.timezone.value = 'UTC'
    mocks.preferencesState.defaultTimezone = 'Europe/Berlin'
    render(<CalendarGrid events={[]} />)

    const plugins = mocks.latestConfig?.plugins as Array<{ name?: string; set?: unknown }>
    expect(plugins).toHaveLength(2)
    expect(plugins[0].set).toBe(mocks.setEvents)
    expect(plugins[1].name).toBe('currentTime')
    expect(mocks.latestConfig?.timezone).toBe('Europe/Berlin')
    expect(packageJson.dependencies['@schedule-x/current-time']).toBe('4.3.1')
  })

  it('redraws the current-time line when the display timezone changes', async () => {
    mocks.calendar.$app.config.timezone.value = 'UTC'
    const { rerender } = render(<CalendarGrid events={[]} />)
    const plugin = (mocks.latestConfig?.plugins as Array<Record<string, any>>)
      .find((p) => p.name === 'currentTime')!
    plugin.$app = mocks.calendar.$app
    const redraw = vi.spyOn(plugin, 'onTimezoneChange').mockImplementation(() => {})

    mocks.preferencesState.defaultTimezone = 'Asia/Tokyo'
    rerender(<CalendarGrid events={[]} />)

    await waitFor(() => {
      expect(mocks.calendar.$app.config.timezone.value).toBe('Asia/Tokyo')
      expect(redraw).toHaveBeenCalled()
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

  it('#738: a generated birthday in a managed calendar cannot be dragged, moved or resized', () => {
    birthdayGrid.managed = ['bday-1']
    mocks.calendarState.updateEvent.mockClear()
    try {
      mocks.projectedSegment = false
      const birthday = event({ startDate: new Date(2026, 6, 13, 9, 0), endDate: new Date(2026, 6, 13, 10, 0), calendarId: 'bday-1' })
      render(<StrictMode><CalendarGrid events={[birthday]} /></StrictMode>)
      const target = screen.getByTestId('projected-segment')
      const eventElement = screen.getByTestId('projected-event')
      const grid = screen.getByTestId('time-grid')
      vi.spyOn(eventElement, 'getBoundingClientRect').mockReturnValue(rect(0, 100, 200, 200))
      vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 200, 1600))
      vi.spyOn(screen.getByTestId('day-column'), 'getBoundingClientRect').mockReturnValue(rect(0, 0, 200, 1600))
      vi.spyOn(screen.getByTestId('schedule-x').parentElement as HTMLElement, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 200, 1600))
      Object.defineProperty(grid, 'scrollHeight', { configurable: true, value: 1600 })
      Object.defineProperty(grid, 'scrollTop', { configurable: true, value: 0, writable: true })

      // Move (same gesture that drags the ordinary event in the next test).
      fireEvent.mouseDown(target, { button: 0, clientX: 20, clientY: 200 })
      fireEvent.mouseMove(target, { clientX: 25, clientY: 260 })
      expect(document.body.classList.contains('is-drag-moving')).toBe(false)
      fireEvent.mouseUp(target, { clientX: 25, clientY: 260 })
      // Bottom-edge resize.
      fireEvent.mouseDown(target, { button: 0, clientX: 20, clientY: 296 })
      fireEvent.mouseMove(target, { clientX: 20, clientY: 360 })
      expect(document.body.classList.contains('is-drag-resizing')).toBe(false)
      fireEvent.mouseUp(target, { clientX: 20, clientY: 360 })

      expect(mocks.calendarState.updateEvent).not.toHaveBeenCalled()
    } finally {
      birthdayGrid.managed = []
    }
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

  it('#1097: a zero-length event (no DTEND) can be dragged and keeps its zero length', () => {
    mocks.projectedSegment = false
    const zero = event({ startDate: new Date(2026, 6, 13, 9, 0), endDate: new Date(2026, 6, 13, 9, 0) })
    const { container } = render(<StrictMode><CalendarGrid events={[zero]} /></StrictMode>)
    const target = screen.getByTestId('projected-segment')
    const grid = screen.getByTestId('time-grid')
    vi.spyOn(screen.getByTestId('projected-event'), 'getBoundingClientRect').mockReturnValue(rect(0, 200, 200, 50))
    vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 200, 1600))
    vi.spyOn(screen.getByTestId('day-column'), 'getBoundingClientRect').mockReturnValue(rect(0, 0, 200, 1600))
    vi.spyOn(screen.getByTestId('schedule-x').parentElement as HTMLElement, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 200, 1600))
    Object.defineProperty(grid, 'scrollHeight', { configurable: true, value: 1600 })
    Object.defineProperty(grid, 'scrollTop', { configurable: true, value: 0, writable: true })

    // 100 px per hour from 07:00: y=210 is 09:06, inside the drawn 30-minute chip.
    fireEvent.mouseDown(target, { button: 0, clientX: 20, clientY: 210 })
    fireEvent.mouseMove(target, { clientX: 25, clientY: 310 })
    expect(document.body.classList.contains('is-drag-moving')).toBe(true)
    const preview = container.querySelector('[class*="bg-emerald-500"]') as HTMLElement | null
    expect(preview).not.toBeNull()
    expect(parseFloat(preview!.style.height)).toBeGreaterThan(0)
    fireEvent.mouseUp(target, { clientX: 25, clientY: 310 })

    expect(mocks.calendarState.updateEvent).toHaveBeenCalledTimes(1)
    const [, update] = mocks.calendarState.updateEvent.mock.calls[0]!
    expect(update.endDate.getTime()).toBe(update.startDate.getTime())
    expect(update.startDate.getTime()).not.toBe(zero.startDate.getTime())
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

  it('a slow scroll that starts on an event never arms the long-press drag', () => {
    vi.useFakeTimers()
    try {
      const { target } = renderGestureHarness(false)

      fireEvent.touchStart(target, { touches: [{ clientX: 20, clientY: 200, target }] })
      act(() => vi.advanceTimersByTime(200))
      // The finger travels more than 10 px before the 500 ms hold completes: this is a scroll.
      fireEvent.touchMove(target, { touches: [{ clientX: 20, clientY: 230, target }] })
      act(() => vi.advanceTimersByTime(400))
      expect(document.body.classList.contains('is-drag-moving')).toBe(false)
      expect(navigator.vibrate).not.toHaveBeenCalled()

      fireEvent.touchMove(target, { touches: [{ clientX: 20, clientY: 400, target }] })
      fireEvent.touchEnd(target, { changedTouches: [{ clientX: 20, clientY: 400, target }] })
      expect(mocks.calendarState.updateEvent).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a cancelled touch (browser took over the gesture) drops the drag without moving the event', () => {
    vi.useFakeTimers()
    try {
      const { container, target } = renderGestureHarness(false)

      // Cancelled before the hold completes: the timer must not fire later.
      fireEvent.touchStart(target, { touches: [{ clientX: 20, clientY: 200, target }] })
      fireEvent.touchCancel(target, { changedTouches: [{ clientX: 20, clientY: 200, target }] })
      act(() => vi.advanceTimersByTime(600))
      expect(document.body.classList.contains('is-drag-moving')).toBe(false)

      // Cancelled after the drag armed: preview cleared, nothing written.
      fireEvent.touchStart(target, { touches: [{ clientX: 20, clientY: 200, target }] })
      act(() => vi.advanceTimersByTime(500))
      fireEvent.touchMove(target, { touches: [{ clientX: 25, clientY: 300, target }] })
      expect(container.querySelector('[class*="bg-emerald-500"]')).not.toBeNull()
      fireEvent.touchCancel(target, { changedTouches: [{ clientX: 25, clientY: 300, target }] })
      expect(document.body.classList.contains('is-drag-moving')).toBe(false)
      expect(container.querySelector('[class*="bg-emerald-500"]')).toBeNull()
      // A later stray touchend must not complete the cancelled move.
      fireEvent.touchEnd(target, { changedTouches: [{ clientX: 25, clientY: 300, target }] })
      expect(mocks.calendarState.updateEvent).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('CalendarGrid slot clicks', () => {
  it('calls the latest onSlotClick although Schedule-X keeps its first callbacks', () => {
    const first = vi.fn()
    const latest = vi.fn()
    const { rerender } = render(<CalendarGrid events={[]} onSlotClick={first} />)
    const createdWith = mocks.latestConfig!.callbacks.onClickDateTime as (dt: { epochMilliseconds: number }) => void
    rerender(<CalendarGrid events={[]} onSlotClick={latest} />)
    act(() => createdWith({ epochMilliseconds: Date.parse('2026-07-13T10:10:00.000Z') }))
    expect(first).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ startDate: new Date('2026-07-13T10:00:00.000Z'), allDay: false }))
  })
})

describe('CalendarGrid external drop (planning view)', () => {
  function dropHarness(props: { externalDragType?: string; onExternalDrop?: (start: Date, dataTransfer: DataTransfer) => void; externalDropMinutes?: number }) {
    render(<CalendarGrid events={[]} {...props} />)
    const grid = screen.getByTestId('time-grid')
    const wrapper = screen.getByTestId('schedule-x').parentElement as HTMLElement
    vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 200, 1600))
    vi.spyOn(screen.getByTestId('day-column'), 'getBoundingClientRect').mockReturnValue(rect(0, 0, 200, 1600))
    vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 200, 1600))
    Object.defineProperty(grid, 'scrollHeight', { configurable: true, value: 1600 })
    Object.defineProperty(grid, 'scrollTop', { configurable: true, value: 0, writable: true })
    return { wrapper }
  }
  const transfer = (types: string[]) => ({ types, dropEffect: 'none', getData: vi.fn(() => 'task-1') })
  // jsdom has no DragEvent: dispatch a MouseEvent carrying the pointer position and a DataTransfer stand-in.
  function drag(type: 'dragover' | 'drop', target: HTMLElement, clientY: number, dataTransfer: ReturnType<typeof transfer>) {
    const native = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 50, clientY })
    Object.defineProperty(native, 'dataTransfer', { value: dataTransfer })
    act(() => { target.dispatchEvent(native) })
    return native
  }

  it('drops into the 30-minute slot under the pointer, in the user timezone', () => {
    const onExternalDrop = vi.fn()
    const { wrapper } = dropHarness({ externalDragType: 'application/x-test-task', onExternalDrop })
    const dataTransfer = transfer(['application/x-test-task'])
    // 16 displayed hours over 1600px: y=280 is 09:48, inside the 09:30 slot.
    drag('dragover', wrapper, 280, dataTransfer)
    expect(screen.getByTestId('external-drop-preview')).toHaveTextContent('09:30 \u2013 10:00')
    drag('drop', wrapper, 280, dataTransfer)
    expect(onExternalDrop).toHaveBeenCalledExactlyOnceWith(new Date('2026-07-13T09:30:00.000Z'), expect.anything())
    expect(screen.queryByTestId('external-drop-preview')).not.toBeInTheDocument()
  })

  it('sizes the preview to the event length', () => {
    const { wrapper } = dropHarness({ externalDragType: 'application/x-test-task', onExternalDrop: vi.fn(), externalDropMinutes: 60 })
    drag('dragover', wrapper, 280, transfer(['application/x-test-task']))
    const preview = screen.getByTestId('external-drop-preview')
    expect(preview).toHaveTextContent('09:30 \u2013 10:30')
    // 100px per hour in this harness.
    expect(preview.style.height).toBe('100px')
  })

  it('does not stretch a short event length in the preview', () => {
    const { wrapper } = dropHarness({ externalDragType: 'application/x-test-task', onExternalDrop: vi.fn(), externalDropMinutes: 6 })
    drag('dragover', wrapper, 280, transfer(['application/x-test-task']))
    expect(screen.getByTestId('external-drop-preview').style.height).toBe('10px')
  })

  it('clamps a drop at the bottom edge to the last slot of the day', () => {
    const onExternalDrop = vi.fn()
    const { wrapper } = dropHarness({ externalDragType: 'application/x-test-task', onExternalDrop })
    drag('drop', wrapper, 1599, transfer(['application/x-test-task']))
    expect(onExternalDrop).toHaveBeenCalledExactlyOnceWith(new Date('2026-07-13T22:30:00.000Z'), expect.anything())
  })

  it('ignores other drag types, and all drops when not enabled or not in week view', () => {
    const onExternalDrop = vi.fn()
    const { wrapper } = dropHarness({ externalDragType: 'application/x-test-task', onExternalDrop })
    drag('drop', wrapper, 280, transfer(['text/plain']))
    expect(onExternalDrop).not.toHaveBeenCalled()
    cleanup()
    const { wrapper: plain } = dropHarness({})
    expect(drag('drop', plain, 280, transfer(['application/x-test-task'])).defaultPrevented).toBe(false)
    cleanup()
    mocks.calendarState.currentView = 'month' as never
    const { wrapper: month } = dropHarness({ externalDragType: 'application/x-test-task', onExternalDrop })
    drag('drop', month, 280, transfer(['application/x-test-task']))
    expect(onExternalDrop).not.toHaveBeenCalled()
  })
})
