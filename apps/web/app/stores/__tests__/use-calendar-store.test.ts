import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useCalendarStore } from '../use-calendar-store'
import { serializeCalendarEvent, deserializeCalendarEvent } from '@silentsuite/core'

vi.mock('@/app/stores/use-auth-store', () => ({
  useAuthStore: {
    getState: () => ({ canWrite: () => true }),
  },
}))

vi.mock('@/app/stores/use-etebase-store', () => ({
  useEtebaseStore: {
    getState: () => ({ account: null }),
  },
}))

vi.mock('@/app/stores/use-toast-store', () => ({
  showErrorToast: vi.fn(),
}))

function resetStore() {
  useCalendarStore.setState({
    events: [],
    isLoading: false,
    syncStatus: 'synced',
    currentView: 'week',
    currentDate: new Date('2026-06-01T12:00:00Z'),
    selectedEventId: null,
  })
}

describe('useCalendarStore.importEvents', () => {
  beforeEach(() => {
    resetStore()
  })

  it('preserves source TZID on imported events', async () => {
    const { importEvents } = useCalendarStore.getState()
    await importEvents([
      {
        title: 'NY meeting',
        startDate: new Date('2026-06-01T13:00:00Z'),
        endDate: new Date('2026-06-01T14:00:00Z'),
        timezone: 'America/New_York',
      },
    ])

    const { events } = useCalendarStore.getState()
    expect(events).toHaveLength(1)
    expect(events[0]!.timezone).toBe('America/New_York')
  })

  it('leaves timezone undefined when none was supplied', async () => {
    const { importEvents } = useCalendarStore.getState()
    await importEvents([
      {
        title: 'Floating',
        startDate: new Date('2026-06-01T09:00:00Z'),
        endDate: new Date('2026-06-01T10:00:00Z'),
      },
    ])

    const { events } = useCalendarStore.getState()
    expect(events[0]!.timezone).toBeUndefined()
  })

  it('serializes a TZID-bearing imported event back out with TZID intact (round-trip)', async () => {
    const { importEvents } = useCalendarStore.getState()
    await importEvents([
      {
        title: 'Tokyo standup',
        startDate: new Date('2026-06-01T00:00:00Z'),
        endDate: new Date('2026-06-01T01:00:00Z'),
        timezone: 'Asia/Tokyo',
      },
    ])

    const { events } = useCalendarStore.getState()
    const ical = serializeCalendarEvent(events[0]!)
    expect(ical).toContain('DTSTART;TZID=Asia/Tokyo:')
    expect(ical).toContain('DTEND;TZID=Asia/Tokyo:')

    // And deserializing produces the same TZID
    const roundTripped = deserializeCalendarEvent(ical)
    expect(roundTripped.timezone).toBe('Asia/Tokyo')
  })

  it('drops timezone for all-day events (DATE-only, no TZID per RFC 5545)', async () => {
    const { importEvents } = useCalendarStore.getState()
    await importEvents([
      {
        title: 'All-day',
        startDate: new Date(2026, 5, 1),
        endDate: new Date(2026, 5, 2),
        allDay: true,
        // CalendarImport passes undefined for all-day to honour RFC 5545
        timezone: undefined,
      },
    ])

    const { events } = useCalendarStore.getState()
    const ical = serializeCalendarEvent(events[0]!)
    expect(ical).not.toMatch(/DTSTART;TZID=/)
    expect(ical).toContain('DTSTART;VALUE=DATE:')
  })
})
