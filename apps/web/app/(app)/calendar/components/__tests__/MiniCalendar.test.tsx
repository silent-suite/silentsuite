import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MiniCalendar } from '../MiniCalendar'

const storeMock = vi.hoisted(() => ({
  routerPush: vi.fn(),
  calendarState: {
    currentDate: new Date(2026, 4, 25, 12),
    setCurrentDate: vi.fn(),
    events: [] as any[],
  },
  calendarListState: {
    calendars: [] as any[],
  },
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: storeMock.routerPush }),
  usePathname: () => '/calendar',
}))

vi.mock('@/app/stores/use-calendar-store', () => ({
  useCalendarStore: (selector: (state: typeof storeMock.calendarState) => unknown) => selector(storeMock.calendarState),
}))

vi.mock('@/app/stores/use-calendar-list-store', () => ({
  useCalendarListStore: (selector: (state: typeof storeMock.calendarListState) => unknown) => selector(storeMock.calendarListState),
}))

function makeEvent(overrides: Partial<any>) {
  const startDate = overrides.startDate ?? new Date(2026, 4, 4, 9)
  const endDate = overrides.endDate ?? new Date(2026, 4, 4, 10)
  return {
    id: overrides.id ?? crypto.randomUUID(),
    uid: overrides.uid ?? crypto.randomUUID(),
    title: overrides.title ?? 'Event',
    description: '',
    location: '',
    startDate,
    endDate,
    allDay: overrides.allDay ?? false,
    recurrenceRule: overrides.recurrenceRule ?? null,
    exceptions: overrides.exceptions ?? [],
    alarms: [],
    calendarId: overrides.calendarId,
    created: new Date(2026, 4, 1),
    updated: new Date(2026, 4, 1),
  }
}

function dotsFor(dayLabel: string): HTMLElement[] {
  const day = screen.getByRole('button', { name: dayLabel })
  return Array.from(day.querySelectorAll<HTMLElement>('span[style]'))
}

describe('MiniCalendar event dots', () => {
  beforeEach(() => {
    storeMock.routerPush.mockClear()
    storeMock.calendarState.currentDate = new Date(2026, 4, 25, 12)
    storeMock.calendarState.setCurrentDate.mockClear()
    storeMock.calendarListState.calendars = [
      { id: 'green-cal', name: 'Green', color: '#10b981', visible: true },
      { id: 'red-cal', name: 'Red', color: '#ef4444', visible: true },
    ]
    storeMock.calendarState.events = []
  })

  it('shows one dot per calendar color on days with events', () => {
    storeMock.calendarState.events = [
      makeEvent({
        id: 'multi-day',
        calendarId: 'green-cal',
        startDate: new Date(2026, 4, 4, 10),
        endDate: new Date(2026, 4, 6, 11),
      }),
      makeEvent({
        id: 'same-day-red',
        calendarId: 'red-cal',
        startDate: new Date(2026, 4, 5, 9),
        endDate: new Date(2026, 4, 5, 10),
      }),
    ]

    render(<MiniCalendar />)

    const may5Colors = dotsFor('Tuesday, May 5, 2026').map((dot) => dot.style.backgroundColor)
    expect(may5Colors).toEqual(expect.arrayContaining(['rgb(16, 185, 129)', 'rgb(239, 68, 68)']))
    expect(dotsFor('Wednesday, May 6, 2026')[0]).toHaveStyle({ backgroundColor: '#10b981' })
  })

  it('shows recurring event dots on occurrence days', () => {
    storeMock.calendarState.events = [
      makeEvent({
        id: 'daily-recurring',
        calendarId: 'green-cal',
        startDate: new Date(2026, 4, 4, 9),
        endDate: new Date(2026, 4, 4, 10),
        recurrenceRule: 'FREQ=DAILY;COUNT=3',
      }),
    ]

    render(<MiniCalendar />)

    expect(dotsFor('Monday, May 4, 2026')[0]).toHaveStyle({ backgroundColor: '#10b981' })
    expect(dotsFor('Tuesday, May 5, 2026')[0]).toHaveStyle({ backgroundColor: '#10b981' })
    expect(dotsFor('Wednesday, May 6, 2026')[0]).toHaveStyle({ backgroundColor: '#10b981' })
  })

  it('does not show dots for hidden calendars', () => {
    storeMock.calendarListState.calendars = [
      { id: 'red-cal', name: 'Red', color: '#ef4444', visible: false },
    ]
    storeMock.calendarState.events = [
      makeEvent({
        id: 'hidden-red',
        calendarId: 'red-cal',
        startDate: new Date(2026, 4, 7, 9),
        endDate: new Date(2026, 4, 7, 10),
      }),
    ]

    render(<MiniCalendar />)

    expect(dotsFor('Thursday, May 7, 2026')).toHaveLength(0)
  })

  it('shows dots for unassigned default-calendar events when real calendars exist', () => {
    storeMock.calendarState.events = [
      makeEvent({
        id: 'default-event',
        startDate: new Date(2026, 4, 8, 9),
        endDate: new Date(2026, 4, 8, 10),
      }),
    ]

    render(<MiniCalendar />)

    expect(dotsFor('Friday, May 8, 2026')[0]).toHaveStyle({ backgroundColor: '#10b981' })
  })
})
