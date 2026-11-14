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

// #886: the mini calendar must expand a recurring event in its own zone. Dots stay on host-local
// days (existing display policy), so the expected day is derived from the zone-correct instant.
describe('MiniCalendar recurring dots use the event zone (#886)', () => {
  beforeEach(() => {
    storeMock.calendarState.currentDate = new Date(2026, 4, 25, 12)
    storeMock.calendarListState.calendars = [
      { id: 'green-cal', name: 'Green', color: '#10b981', visible: true },
    ]
    storeMock.calendarState.events = []
  })

  function hostDayLabel(instant: Date): string {
    return instant.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  }

  it('shows the Tokyo first-of-month occurrence (Jun 1 08:00 JST = May 31 23:00Z) on its host day', () => {
    storeMock.calendarState.events = [
      {
        ...makeEvent({
          id: 'tokyo-monthly',
          calendarId: 'green-cal',
          startDate: new Date('2025-12-31T23:00:00.000Z'), // 2026-01-01 08:00 JST
          endDate: new Date('2026-01-01T00:00:00.000Z'),
          recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=1',
        }),
        timezone: 'Asia/Tokyo',
      },
    ]

    render(<MiniCalendar />)

    const occurrence = new Date('2026-05-31T23:00:00.000Z')
    // Setup guard: on LA and UTC hosts this is Sunday, May 31, 2026 (inside the May grid).
    expect(hostDayLabel(occurrence)).toMatch(/May 3[01], 2026/)
    expect(dotsFor(hostDayLabel(occurrence))[0]).toHaveStyle({ backgroundColor: '#10b981' })
  })

  it('control: a same-zone monthly series still shows its dot', () => {
    storeMock.calendarState.events = [
      makeEvent({
        id: 'host-monthly',
        calendarId: 'green-cal',
        startDate: new Date(2026, 0, 12, 9),
        endDate: new Date(2026, 0, 12, 10),
        recurrenceRule: 'FREQ=MONTHLY',
      }),
    ]

    render(<MiniCalendar />)

    expect(dotsFor('Tuesday, May 12, 2026')[0]).toHaveStyle({ backgroundColor: '#10b981' })
  })
})

describe('MiniCalendar day and week DURATION occurrences across DST (WEB-03 follow-up)', () => {
  beforeEach(() => {
    storeMock.calendarState.currentDate = new Date(2026, 2, 15, 12)
    storeMock.calendarListState.calendars = [
      { id: 'green-cal', name: 'Green', color: '#10b981', visible: true },
    ]
  })

  function hostDayLabel(instant: Date): string {
    return instant.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  }

  it('ends the 23-hour occurrence on its own day, not an hour later', async () => {
    const { fromVEvent } = await vi.importActual<typeof import('@silentsuite/core')>('@silentsuite/core')
    // Weekly from Saturday 28 Feb 2026, 19:30 New York, one nominal day long. The 7 March
    // occurrence (8 March 00:30Z) ends on 8 March 19:30 EDT (23:30Z), 23 hours later.
    storeMock.calendarState.events = [{
      ...fromVEvent([
        'BEGIN:VEVENT', 'UID:p1d-mini', 'SUMMARY:Day long',
        'DTSTART;TZID=America/New_York:20260228T193000', 'DURATION:P1D',
        'RRULE:FREQ=WEEKLY;COUNT=2',
        'END:VEVENT',
      ].join('\r\n')),
      calendarId: 'green-cal',
    }]

    render(<MiniCalendar />)

    const nominalLast = new Date('2026-03-08T23:29:59Z')
    const fixedLast = new Date('2026-03-09T00:29:59Z')
    expect(dotsFor(hostDayLabel(nominalLast))[0]).toHaveStyle({ backgroundColor: '#10b981' })
    // Only on hosts where the extra hour would reach another day (UTC, for example).
    if (hostDayLabel(fixedLast) !== hostDayLabel(nominalLast)) {
      expect(dotsFor(hostDayLabel(fixedLast))).toHaveLength(0)
    }
  })

  it('review repro: a 25-hour October occurrence of a series that starts on a spring DST day marks the first grid day', async () => {
    const { fromVEvent } = await vi.importActual<typeof import('@silentsuite/core')>('@silentsuite/core')
    const { usePreferencesStore } = await import('@/app/stores/use-preferences-store')
    const firstDayOfWeek = usePreferencesStore.getState().firstDayOfWeek
    usePreferencesStore.setState({ firstDayOfWeek: 'monday' })
    storeMock.calendarState.currentDate = new Date(2026, 10, 15, 12)
    // Weekly from Sunday 29 March 2026, 01:30 Berlin (a 23-hour first day). The 25 October
    // occurrence starts 24 Oct 23:30Z and ends 26 Oct 00:30Z (01:30 CET), 25 hours later.
    storeMock.calendarState.events = [{
      ...fromVEvent([
        'BEGIN:VEVENT', 'UID:p1d-berlin', 'SUMMARY:Day long',
        'DTSTART;TZID=Europe/Berlin:20260329T013000', 'DURATION:P1D',
        'RRULE:FREQ=WEEKLY;COUNT=31',
        'END:VEVENT',
      ].join('\r\n')),
      calendarId: 'green-cal',
    }]
    try {
      render(<MiniCalendar />)

      // The first cell of the Monday-first November 2026 grid is Monday 26 October, host-local.
      // The occurrence reaches into it only where host midnight is before 26 Oct 00:30Z (UTC and
      // zones east of it); further west it ends the day before and the cell has no dot.
      const firstCell = new Date(2026, 9, 26)
      const occurrenceEnd = new Date('2026-10-26T00:30:00Z')
      const dots = dotsFor(hostDayLabel(firstCell))
      if (occurrenceEnd > firstCell) expect(dots[0]).toHaveStyle({ backgroundColor: '#10b981' })
      else expect(dots).toHaveLength(0)
    } finally {
      usePreferencesStore.setState({ firstDayOfWeek })
    }
  })
})
