import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { CalendarEvent } from '@silentsuite/core'
import { EventDialog } from '../EventDialog'
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
    { id: 'cal-a', name: 'Work', color: '#10b981', visible: true, accessLevel: 2 },
    { id: 'cal-b', name: 'Family', color: '#ef4444', visible: true, accessLevel: 1 },
  ] as Array<{ id: string; name: string; color: string; visible: boolean; accessLevel?: number }>,
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

// "Ends on" in the recurrence picker writes UNTIL in the form of the zone the saved series uses.
describe('EventDialog recurrence end date', () => {
  beforeEach(() => {
    mocks.createEvent.mockReset().mockResolvedValue({})
    mocks.updateEvent.mockReset().mockResolvedValue(undefined)
    mocks.onClose.mockReset()
    mocks.preferences.timeFormat = '24h'
    mocks.preferences.defaultTimezone = 'Europe/Berlin'
    mocks.preferences.dateFormat = 'system'
  })

  function endWeeklyOn(date: string) {
    fireEvent.change(screen.getByRole('combobox', { name: 'Repeat frequency' }), { target: { value: 'WEEKLY' } })
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }))
    fireEvent.click(screen.getAllByRole('radio')[2]!)
    fireEvent.change(document.querySelector('input[type="date"]')!, { target: { value: date } })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  }

  async function savedRule(): Promise<string> {
    await waitFor(() => expect(mocks.updateEvent).toHaveBeenCalledTimes(1))
    return mocks.updateEvent.mock.calls[0]![1].recurrenceRule
  }

  it('ends a new series at the end of the day in the dialog zone', async () => {
    renderWithIntl(
      <EventDialog mode="create" startDate={new Date('2026-06-01T08:00:00Z')} endDate={new Date('2026-06-01T09:00:00Z')} onClose={mocks.onClose} />,
    )
    fireEvent.change(screen.getByLabelText('Event title'), { target: { value: 'Standup' } })
    endWeeklyOn('2026-06-29')
    await waitFor(() => expect(mocks.createEvent).toHaveBeenCalledTimes(1))
    expect(mocks.createEvent.mock.calls[0]![0].recurrenceRule).toBe('FREQ=WEEKLY;UNTIL=20260629T215959Z')
  })

  it('ends a zoned event at the end of the day in its own zone', async () => {
    renderWithIntl(<EventDialog mode="edit" event={makeEvent({ timezone: 'America/New_York' })} onClose={mocks.onClose} />)
    endWeeklyOn('2026-06-29')
    expect(await savedRule()).toBe('FREQ=WEEKLY;UNTIL=20260630T035959Z')
  })

  it('ends a UTC-anchored event in UTC, not in the default zone', async () => {
    renderWithIntl(<EventDialog mode="edit" event={makeEvent({ timezone: undefined })} onClose={mocks.onClose} />)
    endWeeklyOn('2026-06-29')
    expect(await savedRule()).toBe('FREQ=WEEKLY;UNTIL=20260629T235959Z')
  })

  it('ends a floating event with a floating date-time', async () => {
    renderWithIntl(<EventDialog mode="edit" event={makeEvent({ timezone: undefined, floating: true })} onClose={mocks.onClose} />)
    endWeeklyOn('2026-06-29')
    expect(await savedRule()).toBe('FREQ=WEEKLY;UNTIL=20260629T235959')
  })

  it('ends an all-day event with a date', async () => {
    const event = makeEvent({ allDay: true, timezone: undefined, startDate: new Date(2026, 5, 1), endDate: new Date(2026, 5, 2) })
    renderWithIntl(<EventDialog mode="edit" event={event} onClose={mocks.onClose} />)
    endWeeklyOn('2026-06-29')
    expect(await savedRule()).toBe('FREQ=WEEKLY;UNTIL=20260629')
  })
})
