import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useCalendarStore } from '../use-calendar-store'
import { serializeCalendarEvent, deserializeCalendarEvent } from '@silentsuite/core'
import type { CalendarEvent } from '@silentsuite/core'
import { expandEventsForRange } from '@/app/(app)/calendar/lib/calendar-grid-events'
import { vEventToImportEvent } from '@/app/components/import/import-mappers'
import { _setEncryptedQueuePersistenceAvailableForTests, getAll } from '@/app/lib/offline-queue'
import { TEST_FINGERPRINT, bumpEpochWhenQueuePutRuns, enqueueCreateFromStore, expectOwnedQueueEntry, expectQuietQueueCommitCancellation, queueGuard, replayOwnedEntry, resetRealOfflineQueue } from './offline-queue-store-test-utils'

const toastMock = vi.hoisted(() => ({ showErrorToast: vi.fn() }))

const etebaseMock = vi.hoisted(() => ({
  state: {
    account: null as unknown,
    accountFingerprint: null as string | null,
    createItem: vi.fn(),
    createItemsBatch: vi.fn(),
    updateItem: vi.fn(),
    moveItem: vi.fn(),
    deleteItem: vi.fn(),
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

vi.mock('@/app/stores/use-toast-store', () => toastMock)

function resetStore() {
  etebaseMock.state.account = null
  etebaseMock.state.accountFingerprint = 'calendar-test-account'
  etebaseMock.state.createItem.mockReset()
  etebaseMock.state.createItemsBatch.mockReset()
  etebaseMock.state.updateItem.mockReset()
  etebaseMock.state.moveItem.mockReset()
  etebaseMock.state.deleteItem.mockReset()
  etebaseMock.state.itemCache = new Map()
  etebaseMock.state.itemCollectionMap = new Map()
  useCalendarStore.setState({
    events: [],
    syncStatus: 'synced',
    currentView: 'week',
    currentDate: new Date('2026-06-01T12:00:00Z'),
    selectedEventId: null,
  })
}

function offlineAccount() {
  etebaseMock.state.account = {}
  etebaseMock.state.accountFingerprint = TEST_FINGERPRINT
  etebaseMock.state.itemCache = new Map()
  etebaseMock.state.createItem.mockImplementation((type, content, tempId, collectionUid) => enqueueCreateFromStore(type, collectionUid, content, tempId))
}

/** Every imported record acknowledged, as an import that succeeds. */
function acknowledgeImports() {
  etebaseMock.state.account = {}
  etebaseMock.state.createItemsBatch.mockImplementation(async (_type: unknown, contents: unknown[]) => (
    contents.map((_, index) => `acknowledged-${index}`)
  ))
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

// ── #886: anchor preservation through the real store paths ──

const DTSTART_KIND_LINES = /^(DTSTART|DTEND|EXDATE)[:;]/
const timedLines = (ics: string) => ics.split('\r\n').filter((line) => DTSTART_KIND_LINES.test(line))

describe('useCalendarStore anchor preservation (#886)', () => {
  beforeEach(() => {
    resetStore()
  })

  it('(a) a floating import stays floating through mapper -> importEvents -> serializer -> reload', async () => {
    acknowledgeImports()
    const payload = vEventToImportEvent({
      uid: 'floating-import@example',
      summary: 'Floating weekly',
      dtstart: '20260302T100000',
      dtend: '20260302T110000',
      rrule: 'FREQ=WEEKLY;COUNT=3',
      exdate: ['20260309T100000'],
    }, 'cal-1')

    await useCalendarStore.getState().importEvents([payload])

    const stored = useCalendarStore.getState().events[0]!
    expect(stored).toMatchObject({ floating: true })
    const contents = etebaseMock.state.createItemsBatch.mock.calls[0]![1] as Array<{ content: string; tempId: string }>
    const uploaded = contents[0]!.content
    expect(timedLines(uploaded)).toEqual([
      'DTSTART:20260302T100000',
      'DTEND:20260302T110000',
      'EXDATE:20260309T100000',
    ])

    const reloaded = deserializeCalendarEvent(uploaded)
    expect(reloaded).toMatchObject({ floating: true })
    const range = { start: new Date(2026, 1, 1), end: new Date(2026, 3, 1) }
    const before = expandEventsForRange([stored], range).map((e) => e.startDate.getTime())
    const after = expandEventsForRange([reloaded], range).map((e) => e.startDate.getTime())
    expect(before).toEqual([new Date(2026, 2, 2, 10).getTime(), new Date(2026, 2, 16, 10).getTime()])
    expect(after).toEqual(before)
  })

  it('(b) createEvent carries a floating anchor to the uploaded item', async () => {
    etebaseMock.state.account = {}
    etebaseMock.state.createItem.mockResolvedValue('remote-floating')
    const input = {
      title: 'Floating created',
      startDate: new Date(2026, 2, 2, 10, 0, 0),
      endDate: new Date(2026, 2, 2, 11, 0, 0),
      floating: true as const,
    }

    await useCalendarStore.getState().createEvent(input)

    const uploaded = etebaseMock.state.createItem.mock.calls[0]![1] as string
    expect(timedLines(uploaded)).toEqual(['DTSTART:20260302T100000', 'DTEND:20260302T110000'])
    expect(deserializeCalendarEvent(uploaded)).toMatchObject({ floating: true })
  })

  it('(c1) "this and future" update ends a UTC-anchored master on the previous UTC day', async () => {
    const master = makeRecurringEvent({
      startDate: new Date('2026-10-20T00:30:00Z'),
      endDate: new Date('2026-10-20T01:00:00Z'),
      recurrenceRule: 'FREQ=DAILY',
      timezone: undefined,
    })
    useCalendarStore.setState({ events: [master] })

    await useCalendarStore.getState().updateRecurringEvent(
      master.id,
      { title: 'Later occurrences' },
      'this_and_future',
      new Date('2026-11-02T00:30:00Z'),
    )

    const updatedMaster = useCalendarStore.getState().events.find((e) => e.id === master.id)!
    expect(updatedMaster.recurrenceRule).toBe('FREQ=DAILY;UNTIL=20261101')
  })

  it('(c2) "this and future" delete ends an Asia/Tokyo master on the previous Tokyo day', async () => {
    const master = makeRecurringEvent({
      startDate: new Date('2026-03-01T23:00:00Z'), // 2026-03-02 08:00 JST
      endDate: new Date('2026-03-01T23:30:00Z'),
      recurrenceRule: 'FREQ=DAILY',
      timezone: 'Asia/Tokyo',
    })
    useCalendarStore.setState({ events: [master] })

    await useCalendarStore.getState().deleteRecurringEvent(
      master.id,
      'this_and_future',
      new Date('2026-03-09T23:00:00Z'), // 2026-03-10 08:00 JST
    )

    const updatedMaster = useCalendarStore.getState().events.find((e) => e.id === master.id)!
    expect(updatedMaster.recurrenceRule).toBe('FREQ=DAILY;UNTIL=20260309')
  })

  it('(d) control: an explicit-zone "this" edit of a floating master serializes consistently', async () => {
    const master = deserializeCalendarEvent([
      'BEGIN:VEVENT',
      'UID:floating-master',
      'SUMMARY:Floating series',
      'DTSTART:20260302T100000',
      'DTEND:20260302T110000',
      'RRULE:FREQ=WEEKLY;COUNT=4',
      'END:VEVENT',
    ].join('\r\n'))
    useCalendarStore.setState({ events: [master] })
    const instanceDate = new Date(2026, 2, 9, 10, 0, 0)

    await useCalendarStore.getState().updateRecurringEvent(
      master.id,
      {
        timezone: 'Europe/Berlin',
        startDate: new Date('2026-03-09T09:00:00Z'),
        endDate: new Date('2026-03-09T10:00:00Z'),
      },
      'this',
      instanceDate,
    )

    const events = useCalendarStore.getState().events
    const updatedMaster = events.find((e) => e.id === master.id)!
    const standalone = events.find((e) => e.id !== master.id)!

    expect(timedLines(serializeCalendarEvent(updatedMaster))).toContain('EXDATE:20260309T100000')
    expect(deserializeCalendarEvent(serializeCalendarEvent(updatedMaster))).toMatchObject({ floating: true })

    const standaloneIcs = serializeCalendarEvent(standalone)
    expect(timedLines(standaloneIcs)).toEqual([
      'DTSTART;TZID=Europe/Berlin:20260309T100000',
      'DTEND;TZID=Europe/Berlin:20260309T110000',
    ])
    const reloadedStandalone = deserializeCalendarEvent(standaloneIcs)
    expect(reloadedStandalone.timezone).toBe('Europe/Berlin')
    expect(reloadedStandalone).not.toHaveProperty('floating')
  })

  it('(e) deleting a displayed UTC-anchored occurrence after DST removes exactly that occurrence', async () => {
    const master = makeRecurringEvent({
      startDate: new Date('2026-02-23T18:00:00Z'),
      endDate: new Date('2026-02-23T19:00:00Z'),
      recurrenceRule: 'FREQ=WEEKLY;COUNT=6',
      timezone: undefined,
    })
    useCalendarStore.setState({ events: [master] })
    const range = { start: new Date('2026-02-20T00:00:00Z'), end: new Date('2026-04-05T00:00:00Z') }

    const displayed = expandEventsForRange([master], range)
    expect(displayed.map((e) => e.startDate.toISOString())).toEqual([
      '2026-02-23T18:00:00.000Z',
      '2026-03-02T18:00:00.000Z',
      '2026-03-09T18:00:00.000Z',
      '2026-03-16T18:00:00.000Z',
      '2026-03-23T18:00:00.000Z',
      '2026-03-30T18:00:00.000Z',
    ])

    await useCalendarStore.getState().deleteRecurringEvent(master.id, 'this', displayed[3]!.instanceDate)

    const reloaded = deserializeCalendarEvent(serializeCalendarEvent(useCalendarStore.getState().events[0]!))
    expect(expandEventsForRange([reloaded], range).map((e) => e.startDate.toISOString())).toEqual([
      '2026-02-23T18:00:00.000Z',
      '2026-03-02T18:00:00.000Z',
      '2026-03-09T18:00:00.000Z',
      '2026-03-23T18:00:00.000Z',
      '2026-03-30T18:00:00.000Z',
    ])
  })
})

describe('useCalendarStore.importEvents', () => {
  beforeEach(() => {
    resetStore()
  })

  it('preserves source TZID on imported events', async () => {
    acknowledgeImports()
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
    acknowledgeImports()
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
    acknowledgeImports()
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
    acknowledgeImports()
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
    acknowledgeImports()

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

describe('useCalendarStore guarded offline queue integration', () => {
  // Enqueue surface map: create -> Etebase createItem; update + recurring updates ->
  // syncEventToEtebase update; offline calendar moves -> that helper's move fallback;
  // deleteEvent + recurring/all each have cached-item and temp-item delete branches.
  const queuedEvent = (id = 'temp-event') => makeRecurringEvent({ id, uid: id, recurrenceRule: null, calendarId: 'cal-1' })
  beforeEach(async () => { await resetRealOfflineQueue(); resetStore(); offlineAccount(); toastMock.showErrorToast.mockReset() })

  it.each([
    ['create', async () => { await useCalendarStore.getState().createEvent({ title: 'Create', startDate: new Date('2026-06-01T09:00:00Z'), endDate: new Date('2026-06-01T10:00:00Z'), calendarId: 'cal-1' }) }],
    ['update', async () => { useCalendarStore.setState({ events: [queuedEvent()] }); await useCalendarStore.getState().updateEvent('temp-event', { title: 'Update' }) }],
    ['delete', async () => { useCalendarStore.setState({ events: [queuedEvent()] }); await useCalendarStore.getState().deleteEvent('temp-event') }],
  ] as const)('persists, exposes, and replays an owned offline %s', async (type, mutate) => {
    await mutate()
    await replayOwnedEntry(await expectOwnedQueueEntry(type, 'calendar'))
  })

  it('isolates equal calendar IDs across account fingerprints', async () => {
    useCalendarStore.setState({ events: [queuedEvent()] })
    await useCalendarStore.getState().updateEvent('temp-event', { title: 'Owned' })
    expect(await getAll(queueGuard('other-account'))).toEqual([])
    expect(await getAll(queueGuard(TEST_FINGERPRINT))).toHaveLength(1)
  })

  it('quietly cancels at the actual IndexedDB commit boundary', async () => {
    useCalendarStore.setState({ events: [queuedEvent()] })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const putSpy = bumpEpochWhenQueuePutRuns(() => {
      etebaseMock.state.account = {}; etebaseMock.state.accountFingerprint = 'new-account'
      useCalendarStore.setState({ events: [], selectedEventId: null })
    })
    await expect(useCalendarStore.getState().updateEvent('temp-event', { title: 'Stale' })).resolves.toBeUndefined()
    putSpy.mockRestore()
    expect(useCalendarStore.getState().events).toEqual([])
    expect(await getAll()).toEqual([])
    expect(await getAll(queueGuard('new-account'))).toEqual([])
    expect(errorSpy).not.toHaveBeenCalled()
    expect(toastMock.showErrorToast).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it.each([
    ['cached move fallback', () => {
      const event = queuedEvent('cached-move')
      useCalendarStore.setState({ events: [event] })
      etebaseMock.state.itemCache = new Map([[event.id, {}]])
      etebaseMock.state.itemCollectionMap = new Map([[event.id, 'cal-1']])
      etebaseMock.state.moveItem.mockRejectedValue(new TypeError('offline'))
      return useCalendarStore.getState().updateEvent(event.id, { calendarId: 'cal-2' })
    }],
    ['cached delete fallback', () => {
      const event = queuedEvent('cached-delete')
      useCalendarStore.setState({ events: [event] })
      etebaseMock.state.itemCache = new Map([[event.id, {}]])
      etebaseMock.state.itemCollectionMap = new Map([[event.id, 'cal-1']])
      etebaseMock.state.deleteItem.mockRejectedValue(new TypeError('offline'))
      return useCalendarStore.getState().deleteEvent(event.id)
    }],
    ['uncached delete', () => {
      const event = queuedEvent('uncached-delete')
      useCalendarStore.setState({ events: [event] })
      return useCalendarStore.getState().deleteEvent(event.id)
    }],
    ['cached recurring delete fallback', () => {
      const event = makeRecurringEvent({ id: 'cached-recurring-delete' })
      useCalendarStore.setState({ events: [event] })
      etebaseMock.state.itemCache = new Map([[event.id, {}]])
      etebaseMock.state.itemCollectionMap = new Map([[event.id, 'cal-1']])
      etebaseMock.state.deleteItem.mockRejectedValue(new TypeError('offline'))
      return useCalendarStore.getState().deleteRecurringEvent(event.id, 'all', new Date('2026-06-03T09:00:00Z'))
    }],
    ['uncached recurring delete', () => {
      const event = makeRecurringEvent({ id: 'uncached-recurring-delete' })
      useCalendarStore.setState({ events: [event] })
      return useCalendarStore.getState().deleteRecurringEvent(event.id, 'all', new Date('2026-06-03T09:00:00Z'))
    }],
  ] as const)('quietly cancels the %s direct branch at the actual IndexedDB commit boundary', async (_branch, mutate) => {
    await expectQuietQueueCommitCancellation(
      mutate,
      () => { etebaseMock.state.account = {}; etebaseMock.state.accountFingerprint = 'new-account'; useCalendarStore.setState({ events: [], selectedEventId: null }) },
      () => { expect(useCalendarStore.getState().events).toEqual([]); expect(useCalendarStore.getState().selectedEventId).toBeNull() },
      toastMock,
    )
  })
})

// C3a import-store contract (PLAN §4, §7 R1–R4, R3b, R3c) for importEvents. This file mocks the
// bridge module and runs in jsdom, where the pinned SDK cannot load, so the store reaches the
// actual bridge (vi.importActual) and the transport is controlled at its item-manager boundary.
// The same contract runs against the pinned SDK in the task and contact store tests.
type ChunkFault = { chunk: number; kind: 'offline-before-apply' | 'refused' | 'response-lost' }

const positions = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => from + index)
const settle = <T>(promise: Promise<T>) => promise.then((value) => ({ resolved: value }), (error: unknown) => ({ rejected: error }))

const importContractCases: {
  id: string
  label: string
  setup: 'transport' | 'missing-collection' | 'no-account'
  count: number
  fault?: ChunkFault
  batches: string[]
  serverCount: number
  saved: number
  unsaved: number[]
  uncertain: boolean
}[] = [
  { id: 'C3a-R1', label: 'missing collection', setup: 'missing-collection', count: 2, batches: [], serverCount: 0, saved: 0, unsaved: [0, 1], uncertain: true },
  { id: 'C3a-R2', label: 'offline before the first chunk is applied', setup: 'transport', count: 2, fault: { chunk: 1, kind: 'offline-before-apply' }, batches: ['network-failure'], serverCount: 0, saved: 0, unsaved: [0, 1], uncertain: true },
  { id: 'C3a-R3', label: 'server refuses the second chunk', setup: 'transport', count: 21, fault: { chunk: 2, kind: 'refused' }, batches: ['acknowledged', 'refused', 'refused', 'refused'], serverCount: 20, saved: 20, unsaved: [20], uncertain: true },
  { id: 'C3a-R3b', label: 'offline before the second chunk is applied', setup: 'transport', count: 25, fault: { chunk: 2, kind: 'offline-before-apply' }, batches: ['acknowledged', 'network-failure'], serverCount: 20, saved: 20, unsaved: positions(20, 25), uncertain: true },
  { id: 'C3a-R3c', label: 'second chunk applied but its response lost', setup: 'transport', count: 25, fault: { chunk: 2, kind: 'response-lost' }, batches: ['acknowledged', 'applied-response-lost'], serverCount: 25, saved: 20, unsaved: positions(20, 25), uncertain: true },
  { id: 'C3a-R4', label: 'no account', setup: 'no-account', count: 2, batches: [], serverCount: 0, saved: 0, unsaved: [0, 1], uncertain: false },
]

describe('C3a import-store contract: importEvents', () => {
  let bridge: typeof import('@/app/stores/use-etebase-store')

  beforeEach(async () => {
    bridge = await vi.importActual<typeof import('@/app/stores/use-etebase-store')>('@/app/stores/use-etebase-store')
    await resetRealOfflineQueue()
    // Production queue configuration: plaintext create content is refused.
    _setEncryptedQueuePersistenceAvailableForTests(false)
    resetStore()
    bridge.useEtebaseStore.setState(bridge.useEtebaseStore.getInitialState(), true)
    toastMock.showErrorToast.mockReset()
  })

  /** The actual bridge with an item manager whose batches can fail before, or after, the "server" applies them. */
  function installBridgeTransport(collections: { uid: string }[], fault?: ChunkFault) {
    const serverUids: string[] = []
    const batches: string[] = []
    let created = 0
    const manager = {
      create: vi.fn(async () => ({ uid: `c3a-event-item-${++created}` })),
      batch: vi.fn(async (items: { uid: string }[]) => {
        const request = batches.length + 1
        if (fault?.kind === 'offline-before-apply' && request === fault.chunk) {
          batches.push('network-failure')
          throw new TypeError('Failed to fetch')
        }
        if (fault?.kind === 'refused' && request >= fault.chunk) {
          batches.push('refused')
          throw new Error('Server refused the batch')
        }
        serverUids.push(...items.map((item) => item.uid))
        if (fault?.kind === 'response-lost' && request === fault.chunk) {
          batches.push('applied-response-lost')
          throw new TypeError('Failed to fetch')
        }
        batches.push('acknowledged')
      }),
    }
    const account = { getCollectionManager: () => ({ getItemManager: () => manager }) }
    bridge.useEtebaseStore.setState({
      account,
      accountFingerprint: TEST_FINGERPRINT,
      collections: { calendar: collections, tasks: [], contacts: [], notes: [], preferences: [] },
      itemCache: new Map(),
      itemTypeMap: new Map(),
      itemCollectionMap: new Map(),
      syncEngine: null,
    } as any)
    etebaseMock.state.account = account
    etebaseMock.state.accountFingerprint = TEST_FINGERPRINT
    etebaseMock.state.createItemsBatch.mockImplementation((...args: any[]) => (
      (bridge.useEtebaseStore.getState().createItemsBatch as (...forwarded: any[]) => unknown)(...args)
    ))
    return { batches, serverUids }
  }

  it.each(importContractCases)('$id events: $label reports only acknowledged events and keeps no unacknowledged temp', async (c) => {
    let transport: ReturnType<typeof installBridgeTransport> | null = null
    if (c.setup === 'transport') transport = installBridgeTransport([{ uid: 'c3a-calendar' }], c.fault)
    if (c.setup === 'missing-collection') transport = installBridgeTransport([])
    const inputs = Array.from({ length: c.count }, (_, index) => ({
      title: `C3a event ${index}`,
      startDate: new Date('2026-06-01T09:00:00Z'),
      endDate: new Date('2026-06-01T10:00:00Z'),
      calendarId: 'c3a-calendar',
    }))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const outcome = await settle(useCalendarStore.getState().importEvents(inputs))

      // Fixture proof: which chunks reached and were applied, and an empty production queue.
      expect(transport?.batches ?? []).toEqual(c.batches)
      expect(transport?.serverUids ?? []).toHaveLength(c.serverCount)
      expect(await getAll(queueGuard())).toEqual([])

      // Contract: never the requested count; only acknowledged positions are saved.
      expect(outcome).toMatchObject({ rejected: { name: 'ImportIncompleteError', saved: c.saved, unsaved: c.unsaved, uncertain: c.uncertain } })

      // Settlement: acknowledged events carry the item ids the "server" applied and keep their own VEVENT UID.
      const events = useCalendarStore.getState().events
      expect(events.map((event) => event.title)).toEqual(inputs.slice(0, c.saved).map((input) => input.title))
      const applied = new Set(transport?.serverUids ?? [])
      for (const event of events) {
        expect(applied.has(event.id), `applied item for ${event.title}`).toBe(true)
        expect(event.uid).not.toBe(event.id)
      }
    } finally {
      errorSpy.mockRestore()
    }
  }, 20_000)
})
