import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useCalendarStore } from '../use-calendar-store'
import { serializeCalendarEvent, deserializeCalendarEvent } from '@silentsuite/core'
import type { CalendarEvent } from '@silentsuite/core'

const etebaseMock = vi.hoisted(() => ({
  state: {
    account: null as unknown,
    createItem: vi.fn(),
    updateItem: vi.fn(),
    itemCache: new Map<string, unknown>(),
  },
}))

vi.mock('@/app/stores/use-auth-store', () => ({
  useAuthStore: {
    getState: () => ({ canWrite: () => true }),
  },
}))

vi.mock('@/app/stores/use-etebase-store', () => ({
  useEtebaseStore: {
    getState: () => etebaseMock.state,
  },
}))

vi.mock('@/app/stores/use-toast-store', () => ({
  showErrorToast: vi.fn(),
}))

function resetStore() {
  etebaseMock.state.account = null
  etebaseMock.state.createItem.mockReset()
  etebaseMock.state.updateItem.mockReset()
  etebaseMock.state.itemCache = new Map()
  useCalendarStore.setState({
    events: [],
    isLoading: false,
    syncStatus: 'synced',
    currentView: 'week',
    currentDate: new Date('2026-06-01T12:00:00Z'),
    selectedEventId: null,
  })
}

function makeRecurringEvent(overrides?: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: 'master-item',
    uid: 'master-vevent',
    title: 'Daily standup',
    description: '',
    location: '',
    startDate: new Date('2026-06-01T09:00:00Z'),
    endDate: new Date('2026-06-01T09:30:00Z'),
    allDay: false,
    recurrenceRule: 'FREQ=DAILY',
    exceptions: [],
    alarms: [],
    calendarId: 'cal-1',
    created: new Date('2026-06-01T08:00:00Z'),
    updated: new Date('2026-06-01T08:00:00Z'),
    ...overrides,
  }
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

describe('useCalendarStore.updateRecurringEvent', () => {
  beforeEach(() => {
    resetStore()
  })

  it.each([
    ['this', 'remote-exception-item'],
    ['this_and_future', 'remote-future-item'],
  ] as const)('keeps the new VEVENT UID stable after %s creates a new Etebase item', async (scope, remoteItemUid) => {
    const master = makeRecurringEvent()
    etebaseMock.state.account = {}
    etebaseMock.state.itemCache = new Map([[master.id, {}]])
    etebaseMock.state.updateItem.mockResolvedValue(undefined)
    etebaseMock.state.createItem.mockResolvedValue(remoteItemUid)
    useCalendarStore.setState({ events: [master] })

    await useCalendarStore.getState().updateRecurringEvent(
      master.id,
      { title: 'Adjusted occurrence' },
      scope,
      new Date('2026-06-03T09:00:00Z'),
    )

    const created = useCalendarStore.getState().events.find((event) => event.id === remoteItemUid)
    expect(created).toBeDefined()
    expect(created!.uid).not.toBe(remoteItemUid)

    const uploadedContent = etebaseMock.state.createItem.mock.calls[0]![1] as string
    expect(uploadedContent).toContain(`UID:${created!.uid}`)
    expect(uploadedContent).not.toContain(`UID:${remoteItemUid}`)
  })
})
