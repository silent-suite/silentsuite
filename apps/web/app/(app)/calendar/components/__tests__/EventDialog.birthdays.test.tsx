import { fireEvent, screen } from '@testing-library/react'
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
    { id: 'bday-1', name: 'Birthdays', color: '#f59e0b', visible: true, accessLevel: 1 },
    { id: 'cal-a', name: 'Work', color: '#10b981', visible: true, accessLevel: 2 },
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
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'Birthday' })).toBeTruthy()
    expect(screen.queryByText('Edit event')).toBeNull()
    expect(screen.getByText(/edit the contact/i)).toBeTruthy()
    expect((screen.getByLabelText('Event title') as HTMLInputElement).readOnly).toBe(true)
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull()
  })

  it('shows the clicked occurrence, the Birthdays calendar and no empty labels', () => {
    renderWithIntl(<EventDialog mode="edit" event={birthday} instanceDate={new Date(2027, 2, 15)} onClose={vi.fn()} />)
    expect(screen.getByText(/2027/)).toBeTruthy()
    expect(screen.queryByText(/1972/)).toBeNull()
    expect(screen.getByText('Birthdays')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Work$/ })).toBeNull()
    expect(screen.queryByLabelText('Event labels')).toBeNull()
  })

  it('does not save or ask for an edit scope when Enter is pressed in a birthday title', () => {
    renderWithIntl(<EventDialog mode="edit" event={birthday} instanceDate={new Date(2027, 2, 15)} onClose={vi.fn()} />)
    fireEvent.keyDown(screen.getByLabelText('Event title'), { key: 'Enter' })
    expect(screen.queryByText(/edit recurring event/i)).toBeNull()
    expect(mocks.updateEvent).not.toHaveBeenCalled()
    expect(mocks.createEvent).not.toHaveBeenCalled()
  })

  it('keeps the normal header for an ordinary recurring event, opened at the clicked occurrence', () => {
    const ordinary = { ...birthday, id: 'ev-1', uid: 'ev-1', title: 'Standup', calendarId: 'cal-a' } as CalendarEvent
    renderWithIntl(<EventDialog mode="edit" event={ordinary} instanceDate={new Date(2027, 2, 15)} onClose={vi.fn()} />)
    expect(screen.getByText('Edit event')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy()
    // An occurrence opens at its own date (WEB-01), so the form shows the clicked 2027 date.
    expect(screen.getAllByText(/2027/).length).toBeGreaterThan(0)
  })
})
