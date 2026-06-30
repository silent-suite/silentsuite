import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { CalendarEvent } from '@silentsuite/core'
import { EventDialog, formatEventDateInput, formatEventTimeInput, parseEventDateInput, parseEventTimeInput } from '../EventDialog'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'

const mocks = vi.hoisted(() => ({
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  updateRecurringEvent: vi.fn(),
  deleteRecurringEvent: vi.fn(),
  onClose: vi.fn(),
  requestPermission: vi.fn(),
  preferences: {
    defaultReminder: 'none',
    timeFormat: '24h',
    defaultTimezone: 'UTC',
    dateFormat: 'system',
  },
  calendars: [
    { id: 'cal-a', name: 'Work', color: '#10b981', visible: true },
    { id: 'cal-b', name: 'Family', color: '#ef4444', visible: true },
  ],
}))

vi.mock('@/app/stores/use-calendar-store', () => ({
  useCalendarStore: function useCalendarStore<T>(selector: (state: {
    createEvent: typeof mocks.createEvent
    updateEvent: typeof mocks.updateEvent
    deleteEvent: typeof mocks.deleteEvent
    updateRecurringEvent: typeof mocks.updateRecurringEvent
    deleteRecurringEvent: typeof mocks.deleteRecurringEvent
  }) => T): T {
    return selector({
      createEvent: mocks.createEvent,
      updateEvent: mocks.updateEvent,
      deleteEvent: mocks.deleteEvent,
      updateRecurringEvent: mocks.updateRecurringEvent,
      deleteRecurringEvent: mocks.deleteRecurringEvent,
    })
  },
}))

vi.mock('@/app/stores/use-auth-store', () => ({
  useAuthStore: function useAuthStore<T>(selector: (state: { canWrite: () => boolean }) => T): T {
    return selector({ canWrite: () => true })
  },
}))

vi.mock('@/app/stores/use-calendar-list-store', () => ({
  useCalendarListStore: function useCalendarListStore<T>(selector: (state: {
    calendars: typeof mocks.calendars
    defaultCalendarId: string
  }) => T): T {
    return selector({ calendars: mocks.calendars, defaultCalendarId: 'cal-a' })
  },
}))

vi.mock('@/app/stores/use-preferences-store', () => {
  const usePreferencesStore = function usePreferencesStore<T>(selector: (currentState: typeof mocks.preferences) => T): T {
    return selector(mocks.preferences)
  }
  usePreferencesStore.getState = () => mocks.preferences
  return { usePreferencesStore }
})

vi.mock('@/app/providers/notification-provider', () => ({
  useNotifications: () => ({ permission: 'granted', requestPermission: mocks.requestPermission }),
}))

vi.mock('@/app/lib/use-focus-trap', () => ({
  useFocusTrap: vi.fn(),
}))

function makeEvent(overrides?: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: 'event-item-1',
    uid: 'stable-event-uid',
    title: 'Existing event',
    description: '',
    location: '',
    startDate: new Date('2026-06-01T09:00:00Z'),
    endDate: new Date('2026-06-01T10:00:00Z'),
    allDay: false,
    recurrenceRule: null,
    exceptions: [],
    alarms: [],
    calendarId: 'cal-a',
    timezone: 'UTC',
    created: new Date('2026-06-01T08:00:00Z'),
    updated: new Date('2026-06-01T08:00:00Z'),
    ...overrides,
  }
}

describe('EventDialog edit calendar selection', () => {
  beforeEach(() => {
    mocks.createEvent.mockReset()
    mocks.updateEvent.mockReset().mockResolvedValue(undefined)
    mocks.deleteEvent.mockReset()
    mocks.updateRecurringEvent.mockReset()
    mocks.deleteRecurringEvent.mockReset()
    mocks.onClose.mockReset()
    mocks.requestPermission.mockReset()
    mocks.preferences.timeFormat = '24h'
    mocks.preferences.defaultTimezone = 'UTC'
    mocks.preferences.dateFormat = 'system'
  })

  it.each([
    ['00:00', '00:00', '12:00 AM'],
    ['09:05', '09:05', '9:05 AM'],
    ['12:00', '12:00', '12:00 PM'],
    ['14:00', '14:00', '2:00 PM'],
    ['23:59', '23:59', '11:59 PM'],
  ])('formats %s according to the account time preference', (stored, expected24h, expected12h) => {
    expect(formatEventTimeInput(stored, '24h')).toBe(expected24h)
    expect(formatEventTimeInput(stored, '12h')).toBe(expected12h)
  })

  it.each([
    ['00:00', '24h', '00:00'],
    ['09:05', '24h', '09:05'],
    ['9:05', '24h', '09:05'],
    ['12:00', '24h', '12:00'],
    ['14:00', '24h', '14:00'],
    ['23:59', '24h', '23:59'],
    ['12:00 AM', '12h', '00:00'],
    ['9:05 AM', '12h', '09:05'],
    ['12:00 PM', '12h', '12:00'],
    ['2:00 PM', '12h', '14:00'],
    ['11:59 PM', '12h', '23:59'],
    ['14:00', '12h', '14:00'],
  ])('parses %s in %s mode back to HH:mm', (input, preference, expected) => {
    expect(parseEventTimeInput(input, preference)).toBe(expected)
  })

  it.each([
    ['2026-06-09', 'YYYY-MM-DD', '2026-06-09'],
    ['2026-06-09', 'DD/MM/YYYY', '09/06/2026'],
    ['2026-06-09', 'MM/DD/YYYY', '06/09/2026'],
    ['2026-06-09', 'DD.MM.YYYY', '09.06.2026'],
    ['2026-06-09', 'YYYY/MM/DD', '2026/06/09'],
    ['2026-06-09', 'system', '2026-06-09'],
  ] as const)('formats date input %s using %s', (isoDate, preference, expected) => {
    expect(formatEventDateInput(isoDate, preference)).toBe(expected)
  })

  it.each([
    ['09/06/2026', 'DD/MM/YYYY', '2026-06-09'],
    ['06/09/2026', 'MM/DD/YYYY', '2026-06-09'],
    ['09.06.2026', 'DD.MM.YYYY', '2026-06-09'],
    ['2026/06/09', 'YYYY/MM/DD', '2026-06-09'],
    ['2026-06-09', 'YYYY-MM-DD', '2026-06-09'],
    ['2026-06-09', 'system', '2026-06-09'],
  ] as const)('parses date input %s using %s', (input, preference, expected) => {
    expect(parseEventDateInput(input, preference)).toBe(expected)
  })

  it('rejects invalid typed dates', () => {
    expect(parseEventDateInput('31/02/2026', 'DD/MM/YYYY')).toBeNull()
    expect(parseEventDateInput('2026/31/02', 'YYYY/MM/DD')).toBeNull()
  })

  it('renders event dialog date controls as preference-formatted text fields', () => {
    mocks.preferences.dateFormat = 'DD.MM.YYYY'

    renderWithIntl(<EventDialog mode="edit" event={makeEvent({ startDate: new Date('2026-06-01T14:00:00Z'), endDate: new Date('2026-06-02T15:30:00Z') })} onClose={mocks.onClose} />)

    expect(screen.getByLabelText('Start date')).toHaveAttribute('type', 'text')
    expect(screen.getByLabelText('Start date')).toHaveValue('01.06.2026')
    expect(screen.getByLabelText('End date')).toHaveValue('02.06.2026')
  })

  it('normalizes typed preference-formatted dates on blur and saves ISO-backed dates', async () => {
    mocks.preferences.dateFormat = 'YYYY/MM/DD'

    renderWithIntl(
      <EventDialog
        mode="create"
        startDate={new Date('2026-06-01T14:00:00Z')}
        endDate={new Date('2026-06-01T14:30:00Z')}
        onClose={mocks.onClose}
      />,
    )

    fireEvent.change(screen.getByLabelText('Event title'), { target: { value: 'Date formatted event' } })
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026/6/9' } })
    fireEvent.blur(screen.getByLabelText('Start date'))
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026/6/10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    expect(screen.getByLabelText('Start date')).toHaveValue('2026/06/09')
    await waitFor(() => {
      expect(mocks.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: new Date('2026-06-09T14:00:00Z'),
          endDate: new Date('2026-06-10T14:30:00Z'),
        }),
      )
    })
  })

  it('marks invalid typed dates and blocks save until corrected', () => {
    mocks.preferences.dateFormat = 'DD/MM/YYYY'

    renderWithIntl(<EventDialog mode="create" startDate={new Date('2026-06-01T14:00:00Z')} onClose={mocks.onClose} />)

    fireEvent.change(screen.getByLabelText('Event title'), { target: { value: 'Invalid date event' } })
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '31/02/2026' } })

    expect(screen.getByLabelText('Start date')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('Use 09/06/2026 format')
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled()
  })

  it('renders event dialog time controls as 24-hour text fields for the 24-hour preference', () => {
    mocks.preferences.timeFormat = '24h'

    renderWithIntl(<EventDialog mode="edit" event={makeEvent({ startDate: new Date('2026-06-01T14:00:00Z'), endDate: new Date('2026-06-01T15:30:00Z') })} onClose={mocks.onClose} />)

    expect(screen.getByLabelText('Start time')).toHaveAttribute('type', 'text')
    expect(screen.getByLabelText('Start time')).toHaveValue('14:00')
    expect(screen.getByLabelText('End time')).toHaveValue('15:30')
  })

  it('renders event dialog time controls with AM/PM for the 12-hour preference', () => {
    mocks.preferences.timeFormat = '12h'

    renderWithIntl(<EventDialog mode="edit" event={makeEvent({ startDate: new Date('2026-06-01T14:00:00Z'), endDate: new Date('2026-06-01T15:30:00Z') })} onClose={mocks.onClose} />)

    expect(screen.getByLabelText('Start time')).toHaveValue('2:00 PM')
    expect(screen.getByLabelText('End time')).toHaveValue('3:30 PM')
  })

  it('accepts 24-hour typed values and saves unchanged HH:mm wall-clock times', async () => {
    mocks.preferences.timeFormat = '24h'

    renderWithIntl(
      <EventDialog
        mode="create"
        startDate={new Date('2026-06-01T14:00:00Z')}
        endDate={new Date('2026-06-01T14:30:00Z')}
        onClose={mocks.onClose}
      />,
    )

    fireEvent.change(screen.getByLabelText('Event title'), { target: { value: '24-hour event' } })
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '16:45' } })
    fireEvent.change(screen.getByLabelText('End time'), { target: { value: '17:30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    await waitFor(() => {
      expect(mocks.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: new Date('2026-06-01T16:45:00Z'),
          endDate: new Date('2026-06-01T17:30:00Z'),
          timezone: 'UTC',
        }),
      )
    })
  })

  it('includes calendarId in the edit patch when the selected calendar changes', async () => {
    renderWithIntl(<EventDialog mode="edit" event={makeEvent()} onClose={mocks.onClose} />)

    fireEvent.click(screen.getByRole('button', { name: /Family/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    await waitFor(() => {
      expect(mocks.updateEvent).toHaveBeenCalledWith(
        'event-item-1',
        expect.objectContaining({ calendarId: 'cal-b' }),
      )
    })
    expect(mocks.onClose).toHaveBeenCalledTimes(1)
  })

  it('emits a categories update when labels split from ["WorkHome"] to ["Work","Home"]', async () => {
    const event = makeEvent({ categories: ['WorkHome'] })

    renderWithIntl(<EventDialog mode="edit" event={event} onClose={mocks.onClose} />)

    // Replace the single "WorkHome" label with two labels "Work" and "Home".
    fireEvent.click(screen.getByLabelText('Remove label WorkHome'))
    const input = screen.getByLabelText('Event labels')
    fireEvent.change(input, { target: { value: 'Work' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.change(input, { target: { value: 'Home' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    await waitFor(() => {
      expect(mocks.updateEvent).toHaveBeenCalledWith(
        'event-item-1',
        expect.objectContaining({ categories: ['Work', 'Home'] }),
      )
    })
  })

  it('preserves imported custom minute reminders when saving unchanged', async () => {
    const event = makeEvent({
      alarms: [{ action: 'DISPLAY', trigger: '-PT11M', description: 'Existing event' }],
    })

    renderWithIntl(<EventDialog mode="edit" event={event} onClose={mocks.onClose} />)

    expect(screen.getByLabelText('Reminder 1')).toHaveValue('custom')
    expect(screen.getByLabelText('Custom reminder 1 minutes before')).toHaveValue(11)

    fireEvent.change(screen.getByLabelText('Event title'), { target: { value: 'Renamed custom reminder' } })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    await waitFor(() => {
      expect(mocks.updateEvent).toHaveBeenCalledWith(
        'event-item-1',
        expect.not.objectContaining({ alarms: expect.anything() }),
      )
    })
  })

  it('saves user-entered custom minute reminders as simple negative-duration VALARMs', async () => {
    renderWithIntl(<EventDialog mode="create" startDate={new Date('2026-06-01T09:00:00Z')} onClose={mocks.onClose} />)

    fireEvent.change(screen.getByLabelText('Event title'), { target: { value: 'Custom reminder event' } })
    fireEvent.click(screen.getByRole('button', { name: '+ Add' }))
    fireEvent.change(screen.getByLabelText('Reminder 1'), { target: { value: 'custom' } })
    fireEvent.change(screen.getByLabelText('Custom reminder 1 minutes before'), { target: { value: '11' } })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    await waitFor(() => {
      expect(mocks.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          alarms: [expect.objectContaining({ action: 'DISPLAY', trigger: '-PT11M' })],
        }),
      )
    })
  })

  it('deletes only the selected recurring occurrence when This event is chosen', async () => {
    const instanceDate = new Date('2026-06-03T09:00:00Z')
    const recurringEvent = makeEvent({ recurrenceRule: 'FREQ=DAILY;COUNT=5' })

    renderWithIntl(
      <EventDialog
        mode="edit"
        event={recurringEvent}
        instanceDate={instanceDate}
        onClose={mocks.onClose}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Delete event/ }))

    expect(screen.getByRole('dialog', { name: 'Delete recurring event' })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: /This event/ }))

    expect(mocks.deleteRecurringEvent).toHaveBeenCalledWith(
      recurringEvent.id,
      'this',
      instanceDate,
    )
    expect(mocks.onClose).toHaveBeenCalledTimes(1)
  })
})
