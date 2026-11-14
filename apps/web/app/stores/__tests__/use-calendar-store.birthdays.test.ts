import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAccountEpoch } from '@/app/lib/account-epoch'
import { useBirthdayMarkerStore } from '@/app/lib/birthday-calendar/markers'
import { useCalendarStore } from '../use-calendar-store'
import { useCalendarListStore } from '../use-calendar-list-store'
import { useEtebaseStore } from '../use-etebase-store'
import { useAuthStore } from '../use-auth-store'

vi.mock('@/app/stores/use-toast-store', async (importOriginal) => ({ ...await importOriginal<object>(), showErrorToast: vi.fn() }))

const ordinary = { id: 'ev-1', uid: 'ev-1', title: 'Lunch', description: '', location: '', startDate: new Date(2026, 9, 31, 12), endDate: new Date(2026, 9, 31, 13), allDay: false, recurrenceRule: null, exceptions: [], calendarId: 'cal-1', created_at: new Date(), updated_at: new Date() }
const generated = { ...ordinary, id: 'gen-1', uid: 'ss-bday1-c8970a5b3457981540f4ee428f84a1f4', title: '🎂 Alex', calendarId: 'bday-1' }

describe('calendar store refuses user writes to a managed Birthdays calendar (#738)', () => {
  let createItem: ReturnType<typeof vi.fn>
  beforeEach(() => {
    createItem = vi.fn(async () => 'remote-1')
    useEtebaseStore.setState({ account: {}, accountFingerprint: 'fp-a', createItem, updateItem: vi.fn(async () => 'remote'), deleteItem: vi.fn(async () => 'remote') } as never)
    useAuthStore.setState({ canWrite: () => true } as never)
    useCalendarListStore.setState({
      calendars: [{ id: 'bday-1', name: 'Birthdays', color: '#f59e0b', visible: true }, { id: 'cal-1', name: 'Personal', color: '#10b981', visible: true }],
      defaultCalendarId: 'bday-1',
    })
    useBirthdayMarkerStore.setState({ snapshot: { epoch: getAccountEpoch(), fingerprint: 'fp-a', activeIds: ['bday-1'], qualifyingIds: ['bday-1'] } as never })
    useCalendarStore.setState({ events: [ordinary, generated] as never })
  })

  it('does not create an event in it', async () => {
    const { id: _id, uid: _uid, created_at: _c, updated_at: _u, ...input } = ordinary
    await expect(useCalendarStore.getState().createEvent({ ...input, calendarId: 'bday-1' } as never)).rejects.toThrow(/birthdays/i)
    expect(createItem).not.toHaveBeenCalled()
  })

  it('does not fall back to it as the default calendar', async () => {
    const { id: _id, uid: _uid, created_at: _c, updated_at: _u, calendarId: _cal, ...input } = ordinary
    const created = await useCalendarStore.getState().createEvent(input as never)
    expect(created.calendarId).toBe('cal-1')
  })

  it('does not edit, move into, or delete its events', async () => {
    await expect(useCalendarStore.getState().updateEvent('gen-1', { title: 'Edited' })).rejects.toThrow(/birthdays/i)
    await expect(useCalendarStore.getState().updateEvent('ev-1', { calendarId: 'bday-1' })).rejects.toThrow(/birthdays/i)
    await expect(useCalendarStore.getState().deleteEvent('gen-1')).rejects.toThrow(/birthdays/i)
    expect(useCalendarStore.getState().events.map((event) => [event.id, event.title, event.calendarId])).toEqual([
      ['ev-1', 'Lunch', 'cal-1'],
      ['gen-1', '🎂 Alex', 'bday-1'],
    ])
  })

  it('with only a managed calendar, a new event has no ordinary target and is refused (no phantom default)', async () => {
    useCalendarListStore.setState({ calendars: [{ id: 'bday-1', name: 'Birthdays', color: '#f59e0b', visible: true }], defaultCalendarId: 'bday-1' })
    const { id: _id, uid: _uid, created_at: _c, updated_at: _u, calendarId: _cal, ...input } = ordinary
    await expect(useCalendarStore.getState().createEvent(input as never)).rejects.toThrow(/birthdays|calendar/i)
    await expect(useCalendarStore.getState().importEvents([input] as never)).rejects.toThrow(/birthdays|calendar/i)
    expect(createItem).not.toHaveBeenCalled()
    expect(useCalendarStore.getState().events.map((event) => event.id)).toEqual(['ev-1', 'gen-1'])
  })

  it('refuses an import whose target is managed', async () => {
    const { id: _id, uid: _uid, created_at: _c, updated_at: _u, ...input } = ordinary
    await expect(useCalendarStore.getState().importEvents([{ ...input, calendarId: 'bday-1' }] as never)).rejects.toThrow(/birthdays/i)
    expect(createItem).not.toHaveBeenCalled()
  })

  it('still edits ordinary events', async () => {
    await useCalendarStore.getState().updateEvent('ev-1', { title: 'Dinner' })
    expect(useCalendarStore.getState().events.find((event) => event.id === 'ev-1')?.title).toBe('Dinner')
  })
})
