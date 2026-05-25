import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { CalendarEvent } from '@silentsuite/core'
import { EventDialog } from '../EventDialog'

const mocks = vi.hoisted(() => ({
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  updateRecurringEvent: vi.fn(),
  deleteRecurringEvent: vi.fn(),
  onClose: vi.fn(),
  requestPermission: vi.fn(),
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

vi.mock('@/app/stores/use-preferences-store', () => ({
  usePreferencesStore: function usePreferencesStore<T>(selector: (state: {
    defaultReminder: string
    timeFormat: string
    defaultTimezone: string
  }) => T): T {
    return selector({ defaultReminder: 'none', timeFormat: '24h', defaultTimezone: 'UTC' })
  },
}))

vi.mock('@/app/providers/notification-provider', () => ({
  useNotifications: () => ({ permission: 'granted', requestPermission: mocks.requestPermission }),
}))

vi.mock('@/app/lib/use-focus-trap', () => ({
  useFocusTrap: vi.fn(),
}))

function makeEvent(): CalendarEvent {
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
  })

  it('includes calendarId in the edit patch when the selected calendar changes', async () => {
    render(<EventDialog mode="edit" event={makeEvent()} onClose={mocks.onClose} />)

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
})
