import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AgendaView } from '../AgendaView'
import type { CalendarEvent } from '@silentsuite/core'
import type { CalendarList } from '@/app/stores/use-calendar-list-store'

vi.mock('@/app/stores/use-preferences-store', () => ({
  usePreferencesStore: (selector: (state: { defaultTimezone: string }) => unknown) => selector({ defaultTimezone: 'UTC' }),
}))

function makeEvent(
  id: string,
  title: string,
  startDate: Date,
  endDate: Date,
  overrides: Partial<CalendarEvent> = {},
): CalendarEvent {
  return {
    id,
    uid: id,
    title,
    description: '',
    location: '',
    startDate,
    endDate,
    allDay: false,
    recurrenceRule: null,
    exceptions: [],
    alarms: [],
    calendarId: 'default',
    categories: [],
    created: new Date('2026-06-01T00:00:00Z'),
    updated: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  }
}

const calendars: CalendarList[] = [
  { id: 'work', name: 'Work', color: '#2563eb', visible: true },
  { id: 'personal', name: 'Personal', color: '#10b981', visible: true },
]

describe('AgendaView upcoming mode', () => {
  it('shows upcoming events across future days instead of only the selected day', () => {
    render(
      <AgendaView
        mode="upcoming"
        currentDate={new Date('2026-06-01T12:00:00Z')}
        calendars={calendars}
        events={[
          makeEvent('today', 'Today event', new Date('2026-06-01T13:00:00Z'), new Date('2026-06-01T14:00:00Z')),
          makeEvent('tomorrow', 'Tomorrow event', new Date('2026-06-02T09:00:00Z'), new Date('2026-06-02T10:00:00Z')),
          makeEvent('later', 'Later event', new Date('2026-06-04T09:00:00Z'), new Date('2026-06-04T10:00:00Z')),
        ]}
      />,
    )

    expect(screen.getByText('Next events')).toBeInTheDocument()
    expect(screen.getByText('Today event')).toBeInTheDocument()
    expect(screen.getByText('Tomorrow event')).toBeInTheDocument()
    expect(screen.getByText('Later event')).toBeInTheDocument()
    expect(screen.getByText('Tomorrow')).toBeInTheDocument()
    expect(screen.getByText('Thu, Jun 4')).toBeInTheDocument()
  })

  it('caps the upcoming list at six rendered events', () => {
    const events = Array.from({ length: 8 }, (_, index) => makeEvent(
      `event-${index}`,
      `Event ${index}`,
      new Date(Date.UTC(2026, 5, 1 + index, 9)),
      new Date(Date.UTC(2026, 5, 1 + index, 10)),
    ))

    render(<AgendaView mode="upcoming" currentDate={new Date('2026-06-01T12:00:00Z')} events={events} />)

    expect(screen.getByText('Event 0')).toBeInTheDocument()
    expect(screen.getByText('Event 5')).toBeInTheDocument()
    expect(screen.queryByText('Event 6')).not.toBeInTheDocument()
  })

  it('shows the event collection name in agenda rows', () => {
    render(
      <AgendaView
        mode="upcoming"
        currentDate={new Date('2026-06-01T12:00:00Z')}
        calendars={calendars}
        events={[
          makeEvent('work-event', 'Work planning', new Date('2026-06-01T13:00:00Z'), new Date('2026-06-01T14:00:00Z'), {
            calendarId: 'work',
          }),
        ]}
      />,
    )

    expect(screen.getByText('Work planning')).toBeInTheDocument()
    expect(screen.getByText('Work')).toBeInTheDocument()
  })

  it('expands recurring events into upcoming agenda occurrences', () => {
    const onEventClick = vi.fn()
    render(
      <AgendaView
        mode="upcoming"
        currentDate={new Date('2026-06-02T12:00:00Z')}
        onEventClick={onEventClick}
        events={[
          makeEvent('daily-standup', 'Daily standup', new Date('2026-06-01T09:00:00Z'), new Date('2026-06-01T09:30:00Z'), {
            recurrenceRule: 'FREQ=DAILY;COUNT=3',
            calendarId: 'work',
          }),
        ]}
      />,
    )

    expect(screen.getAllByText('Daily standup')).toHaveLength(2)
    expect(screen.getAllByText('Repeats')).toHaveLength(2)

    fireEvent.click(screen.getAllByRole('button', { name: /Daily standup/ })[0])
    expect(onEventClick).toHaveBeenCalledWith('daily-standup', new Date('2026-06-02T09:00:00Z'))
  })
})
