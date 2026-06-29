import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useCalendarStore } from '../use-calendar-store'
import { serializeCalendarEvent, deserializeCalendarEvent } from '@silentsuite/core'
import type { CalendarEvent } from '@silentsuite/core'
import { expandEventsForRange } from '@/app/(app)/calendar/lib/calendar-grid-events'

const etebaseMock = vi.hoisted(() => ({
  state: {
    account: null as unknown,
    createItem: vi.fn(),
    createItemsBatch: vi.fn(),
    updateItem: vi.fn(),
    moveItem: vi.fn(),
    itemCache: new Map<string, unknown>(),
    itemCollectionMap: new Map<string, string>(),
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
  etebaseMock.state.createItemsBatch.mockReset()
  etebaseMock.state.updateItem.mockReset()
  etebaseMock.state.moveItem.mockReset()
  etebaseMock.state.itemCache = new Map()
  etebaseMock.state.itemCollectionMap = new Map()
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

  it('preserves recurrence exceptions during event import', async () => {
    const exception = new Date('2026-06-03T09:00:00Z')

    await useCalendarStore.getState().importEvents([
      {
        title: 'Daily standup',
        startDate: new Date('2026-06-01T09:00:00Z'),
        endDate: new Date('2026-06-01T09:30:00Z'),
        recurrenceRule: 'FREQ=DAILY;COUNT=3',
        exceptions: [exception],
      },
    ])

    const { events } = useCalendarStore.getState()
    expect(events[0]!.exceptions).toEqual([exception])
    expect(serializeCalendarEvent(events[0]!)).toContain('EXDATE:')
  })

  it('routes mixed-calendar imports to each target collection', async () => {
    etebaseMock.state.account = {}
    etebaseMock.state.createItemsBatch.mockImplementation(async (_type: unknown, contents: unknown[]) => (
      contents.map((_, index) => `remote-${index}-${String(index)}`)
    ))

    await useCalendarStore.getState().importEvents([
      {
        title: 'Work event',
        startDate: new Date('2026-06-01T09:00:00Z'),
        endDate: new Date('2026-06-01T10:00:00Z'),
        calendarId: 'work-cal',
      },
      {
        title: 'Family event',
        startDate: new Date('2026-06-02T09:00:00Z'),
        endDate: new Date('2026-06-02T10:00:00Z'),
        calendarId: 'family-cal',
      },
    ])

    expect(etebaseMock.state.createItemsBatch).toHaveBeenCalledTimes(2)
    expect(etebaseMock.state.createItemsBatch.mock.calls[0]![2]).toBe('work-cal')
    expect(etebaseMock.state.createItemsBatch.mock.calls[1]![2]).toBe('family-cal')
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

describe('useCalendarStore.deleteRecurringEvent', () => {
  beforeEach(() => {
    resetStore()
  })

  it('adds an exception for This event and preserves the rest of the series', async () => {
    const master = makeRecurringEvent({ recurrenceRule: 'FREQ=DAILY' })
    const instanceDate = new Date('2026-06-03T09:00:00Z')
    useCalendarStore.setState({ events: [master] })

    await useCalendarStore.getState().deleteRecurringEvent(master.id, 'this', instanceDate)

    const updatedMaster = useCalendarStore.getState().events[0]!
    expect(updatedMaster.id).toBe(master.id)
    expect(updatedMaster.exceptions).toEqual([instanceDate])
    expect(serializeCalendarEvent(updatedMaster)).toContain('EXDATE:')

    const displayedStarts = expandEventsForRange([updatedMaster], {
      start: new Date('2026-06-01T00:00:00Z'),
      end: new Date('2026-06-05T23:59:59Z'),
    }).map((event) => event.startDate.toISOString())

    expect(displayedStarts).toEqual([
      '2026-06-01T09:00:00.000Z',
      '2026-06-02T09:00:00.000Z',
      '2026-06-04T09:00:00.000Z',
      '2026-06-05T09:00:00.000Z',
    ])
  })
})

describe('useCalendarStore.updateEvent calendar moves', () => {
  beforeEach(() => {
    resetStore()
  })

  it('moves a cached event to the target calendar and remaps the local item id', async () => {
    const event = makeRecurringEvent({
      id: 'item-old',
      uid: 'stable-vevent-uid',
      recurrenceRule: null,
      calendarId: 'cal-a',
    })
    etebaseMock.state.account = {}
    etebaseMock.state.itemCache = new Map([[event.id, {}]])
    etebaseMock.state.itemCollectionMap = new Map([[event.id, 'cal-a']])
    etebaseMock.state.moveItem.mockResolvedValue('item-new')
    useCalendarStore.setState({ events: [event], selectedEventId: event.id })

    await useCalendarStore.getState().updateEvent(event.id, {
      title: 'Moved meeting',
      calendarId: 'cal-b',
    })

    expect(etebaseMock.state.updateItem).not.toHaveBeenCalled()
    expect(etebaseMock.state.moveItem).toHaveBeenCalledTimes(1)
    expect(etebaseMock.state.moveItem.mock.calls[0]![0]).toBe('calendar')
    expect(etebaseMock.state.moveItem.mock.calls[0]![1]).toBe('item-old')
    expect(etebaseMock.state.moveItem.mock.calls[0]![3]).toBe('cal-b')
    expect(etebaseMock.state.moveItem.mock.calls[0]![4]).toBe('cal-a')
    const uploadedContent = etebaseMock.state.moveItem.mock.calls[0]![2] as string
    expect(uploadedContent).toContain('UID:stable-vevent-uid')
    expect(uploadedContent).toContain('SUMMARY:Moved meeting')

    const moved = useCalendarStore.getState().events[0]!
    expect(moved.id).toBe('item-new')
    expect(moved.uid).toBe('stable-vevent-uid')
    expect(moved.calendarId).toBe('cal-b')
    expect(useCalendarStore.getState().selectedEventId).toBe('item-new')
  })

  it('uses the previous event calendar as the source if the Etebase collection map is missing', async () => {
    const event = makeRecurringEvent({
      id: 'item-old',
      uid: 'stable-vevent-uid',
      recurrenceRule: null,
      calendarId: 'cal-a',
    })
    etebaseMock.state.account = {}
    etebaseMock.state.itemCache = new Map([[event.id, {}]])
    etebaseMock.state.itemCollectionMap = new Map()
    etebaseMock.state.moveItem.mockResolvedValue('item-new')
    useCalendarStore.setState({ events: [event] })

    await useCalendarStore.getState().updateEvent(event.id, { calendarId: 'cal-b' })

    expect(etebaseMock.state.moveItem).toHaveBeenCalledWith(
      'calendar',
      'item-old',
      expect.any(String),
      'cal-b',
      'cal-a',
    )
    expect(useCalendarStore.getState().events[0]!.id).toBe('item-new')
    expect(useCalendarStore.getState().events[0]!.calendarId).toBe('cal-b')
  })

  it('keeps same-calendar edits on the normal update path', async () => {
    const event = makeRecurringEvent({ id: 'item-1', recurrenceRule: null, calendarId: 'cal-a' })
    etebaseMock.state.account = {}
    etebaseMock.state.itemCache = new Map([[event.id, {}]])
    etebaseMock.state.itemCollectionMap = new Map([[event.id, 'cal-a']])
    etebaseMock.state.updateItem.mockResolvedValue(undefined)
    useCalendarStore.setState({ events: [event] })

    await useCalendarStore.getState().updateEvent(event.id, { title: 'Still here' })

    expect(etebaseMock.state.updateItem).toHaveBeenCalledTimes(1)
    expect(etebaseMock.state.moveItem).not.toHaveBeenCalled()
    expect(useCalendarStore.getState().events[0]!.id).toBe('item-1')
    expect(useCalendarStore.getState().events[0]!.calendarId).toBe('cal-a')
  })

  it('moves a recurring master when all occurrences are changed to another calendar', async () => {
    const master = makeRecurringEvent({ id: 'master-old', uid: 'stable-master-uid', calendarId: 'cal-a' })
    etebaseMock.state.account = {}
    etebaseMock.state.itemCache = new Map([[master.id, {}]])
    etebaseMock.state.itemCollectionMap = new Map([[master.id, 'cal-a']])
    etebaseMock.state.moveItem.mockResolvedValue('master-new')
    useCalendarStore.setState({ events: [master], selectedEventId: master.id })

    await useCalendarStore.getState().updateRecurringEvent(
      master.id,
      { calendarId: 'cal-b', title: 'Moved series' },
      'all',
      new Date('2026-06-03T09:00:00Z'),
    )

    expect(etebaseMock.state.moveItem).toHaveBeenCalledTimes(1)
    expect(etebaseMock.state.moveItem.mock.calls[0]![1]).toBe('master-old')
    expect(etebaseMock.state.moveItem.mock.calls[0]![3]).toBe('cal-b')
    expect(etebaseMock.state.moveItem.mock.calls[0]![4]).toBe('cal-a')
    const moved = useCalendarStore.getState().events[0]!
    expect(moved.id).toBe('master-new')
    expect(moved.uid).toBe('stable-master-uid')
    expect(moved.calendarId).toBe('cal-b')
    expect(moved.recurrenceRule).toBe('FREQ=DAILY')
    expect(useCalendarStore.getState().selectedEventId).toBe('master-new')
  })
})

describe('useCalendarStore.getFilteredEvents', () => {
  beforeEach(() => {
    resetStore()
  })

  it('matches events by categories/labels', () => {
    const work = makeRecurringEvent({
      id: 'work-1',
      uid: 'work-uid',
      title: 'Strategy sync',
      recurrenceRule: null,
      categories: ['Work', 'VIP'],
    })
    const personal = makeRecurringEvent({
      id: 'personal-1',
      uid: 'personal-uid',
      title: 'Yoga class',
      recurrenceRule: null,
      categories: ['Health'],
    })
    useCalendarStore.setState({ events: [work, personal] })

    useCalendarStore.getState().setSearchQuery('work')
    expect(useCalendarStore.getState().getFilteredEvents().map((e) => e.id)).toEqual(['work-1'])

    useCalendarStore.getState().setSearchQuery('vip')
    expect(useCalendarStore.getState().getFilteredEvents().map((e) => e.id)).toEqual(['work-1'])

    useCalendarStore.getState().setSearchQuery('health')
    expect(useCalendarStore.getState().getFilteredEvents().map((e) => e.id)).toEqual(['personal-1'])

    // Empty query returns everything
    useCalendarStore.getState().setSearchQuery('')
    expect(useCalendarStore.getState().getFilteredEvents()).toHaveLength(2)
  })
})
