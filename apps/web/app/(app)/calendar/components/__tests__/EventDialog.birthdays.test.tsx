import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CalendarEvent } from '@silentsuite/core'
import { EventDialog } from '../EventDialog'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'

const mocks = vi.hoisted(() => ({
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  preferences: { defaultReminder: 'none', timeFormat: '24h', defaultTimezone: 'UTC', dateFormat: 'system' },
  calendars: [
    { id: 'bday-1', name: 'Birthdays', color: '#f59e0b', visible: true },
    { id: 'cal-a', name: 'Work', color: '#10b981', visible: true },
  ],
}))

vi.mock('@/app/stores/use-calendar-store', () => ({
  useCalendarStore: function useCalendarStore<T>(selector: (state: Record<string, unknown>) => T): T {
    return selector({ createEvent: mocks.createEvent, updateEvent: mocks.updateEvent, deleteEvent: mocks.deleteEvent, updateRecurringEvent: vi.fn(), deleteRecurringEvent: vi.fn() })
  },
}))
vi.mock('@/app/stores/use-auth-store', () => ({
  useAuthStore: function useAuthStore<T>(selector: (state: { canWrite: () => boolean }) => T): T {
    return selector({ canWrite: () => true })
  },
}))
vi.mock('@/app/stores/use-calendar-list-store', () => ({
  useCalendarListStore: function useCalendarListStore<T>(selector: (state: { calendars: typeof mocks.calendars; defaultCalendarId: string }) => T): T {
    // The stored default is the managed Birthdays calendar.
    return selector({ calendars: mocks.calendars, defaultCalendarId: 'bday-1' })
  },
}))
vi.mock('@/app/stores/use-preferences-store', () => {
  const usePreferencesStore = function usePreferencesStore<T>(selector: (state: typeof mocks.preferences) => T): T {
    return selector(mocks.preferences)
  }
  usePreferencesStore.getState = () => mocks.preferences
  return { usePreferencesStore }
})
vi.mock('@/app/providers/notification-provider', () => ({ useNotifications: () => ({ permission: 'granted', requestPermission: vi.fn() }) }))
vi.mock('@/app/lib/use-focus-trap', () => ({ useFocusTrap: vi.fn() }))
vi.mock('@/app/lib/birthday-calendar/session', () => ({ useManagedBirthdayCalendarIds: () => ['bday-1'] }))

const birthday: CalendarEvent = {
  id: 'gen-1', uid: 'ss-bday1-c8970a5b3457981540f4ee428f84a1f4', title: '🎂 Alex', description: '', location: '',
  startDate: new Date(1972, 2, 15), endDate: new Date(1972, 2, 16), allDay: true, recurrenceRule: 'FREQ=YEARLY',
  exceptions: [], calendarId: 'bday-1', created_at: new Date(), updated_at: new Date(),
} as unknown as CalendarEvent

describe('EventDialog with a managed Birthdays calendar (#738)', () => {
  it('never offers or defaults to the managed calendar for a new event', () => {
    renderWithIntl(<EventDialog mode="create" startDate={new Date(2026, 9, 31, 9)} endDate={new Date(2026, 9, 31, 10)} allDay={false} onClose={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /^Birthdays$/ })).toBeNull()
    const work = screen.getByRole('button', { name: /^Work$/ })
    expect(work.className).toContain('text-white')
  })

  it('shows a generated birthday read-only, with no save or delete', () => {
    renderWithIntl(<EventDialog mode="edit" event={birthday} onClose={vi.fn()} />)
    expect((screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/edit the contact/i)).toBeTruthy()
    expect((screen.getByLabelText('Event title') as HTMLInputElement).readOnly).toBe(true)
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
  })
})
