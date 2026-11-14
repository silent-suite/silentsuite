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

  it('(c1) "this and future" update ends a UTC-anchored master just before the selected occurrence', async () => {
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
    expect(updatedMaster.recurrenceRule).toBe('FREQ=DAILY;UNTIL=20261102T002959Z')
  })

  it('(c2) "this and future" delete ends an Asia/Tokyo master just before the selected occurrence', async () => {
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
    expect(updatedMaster.recurrenceRule).toBe('FREQ=DAILY;UNTIL=20260309T225959Z')
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

// ── #886 F1: gap-start DTSTART identity through real store journeys ──
// Uploads are captured at the mocked Etebase boundary (updateItem arg 2, createItem arg 1,
// createItemsBatch arg 1 [i].content) and decoded with the real codec.

function gapIcs(lines: string[]): string {
  return ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n')
}
const F1_G2 = gapIcs([
  'UID:f1-g2', 'SUMMARY:Long gap series',
  'DTSTART;TZID=America/Los_Angeles:20260308T023000', 'DTEND;TZID=America/Los_Angeles:20260308T043000',
  'RRULE:FREQ=WEEKLY;COUNT=60',
])
const F1_N = gapIcs([
  'UID:f1-n', 'SUMMARY:Nuuk gap series',
  'DTSTART;TZID=America/Nuuk:20260328T233000', 'DTEND;TZID=America/Nuuk:20260329T003000',
  'RRULE:FREQ=WEEKLY;COUNT=60',
])
const F1_D = gapIcs([
  'UID:f1-d', 'SUMMARY:Nuuk daily',
  'DTSTART;TZID=America/Nuuk:20270325T233000', 'DTEND;TZID=America/Nuuk:20270326T003000',
  'RRULE:FREQ=DAILY;COUNT=5',
])
const F1_S = gapIcs([
  'UID:f1-s', 'SUMMARY:Gap standalone',
  'DTSTART;TZID=America/Los_Angeles:20260308T023000', 'DTEND;TZID=America/Los_Angeles:20260308T043000',
])

const lineOf = (ics: string, name: string) => ics.split('\r\n').find((l) => l.startsWith(name))
const isoList = (events: Array<{ startDate: Date }>) => events.map((e) => e.startDate.toISOString())

/** Seed one reloaded event as a cached remote item so updates reach updateItem. */
function seedRemote(ics: string): CalendarEvent {
  const event = deserializeCalendarEvent(ics)
  etebaseMock.state.account = {}
  etebaseMock.state.itemCache = new Map([[event.id, {}]])
  etebaseMock.state.itemCollectionMap = new Map()
  etebaseMock.state.updateItem.mockResolvedValue(undefined)
  etebaseMock.state.createItem.mockResolvedValue('remote-copy')
  useCalendarStore.setState({ events: [event] })
  return event
}
const lastUpdated = () => etebaseMock.state.updateItem.mock.calls.at(-1)![2] as string
const lastCreated = () => etebaseMock.state.createItem.mock.calls.at(-1)![1] as string

describe('useCalendarStore gap-start DTSTART identity (#886 F1)', () => {
  beforeEach(() => {
    resetStore()
  })

  it('row 9: an imported gap series uploads its original DTSTART and reloads with the EXDATE matching', async () => {
    acknowledgeImports()
    const payload = vEventToImportEvent({
      uid: 'f1-import', summary: 'Gap import',
      dtstart: '20260308T023000', dtend: '20260308T043000',
      dtstartParams: { TZID: 'America/Los_Angeles' }, dtendParams: { TZID: 'America/Los_Angeles' },
      rrule: 'FREQ=WEEKLY;COUNT=3', exdate: ['20260315T023000'], exdateParams: { TZID: 'America/Los_Angeles' },
    }, 'cal-1')

    await useCalendarStore.getState().importEvents([payload])

    const uploaded = (etebaseMock.state.createItemsBatch.mock.calls[0]![1] as Array<{ content: string }>)[0]!.content
    expect(lineOf(uploaded, 'DTSTART')).toBe('DTSTART;TZID=America/Los_Angeles:20260308T023000')
    const range = { start: new Date('2026-03-01T00:00:00Z'), end: new Date('2026-04-01T00:00:00Z') }
    expect(isoList(expandEventsForRange([deserializeCalendarEvent(uploaded)], range))).toEqual([
      '2026-03-08T10:30:00.000Z',
      '2026-03-22T09:30:00.000Z',
    ])
  })

  it('row 10: createEvent carries a supplied gap wall clock to the uploaded item', async () => {
    etebaseMock.state.account = {}
    etebaseMock.state.createItem.mockResolvedValue('remote-created')
    const input = {
      title: 'Gap created',
      startDate: new Date('2026-03-08T10:30:00Z'),
      endDate: new Date('2026-03-08T11:30:00Z'),
      timezone: 'America/Los_Angeles',
      startWallClock: '20260308T023000',
    }

    await useCalendarStore.getState().createEvent(input)

    expect(lineOf(lastCreated(), 'DTSTART')).toBe('DTSTART;TZID=America/Los_Angeles:20260308T023000')
  })

  it('row 11: "this" at a later LA gap occurrence writes that occurrence\'s original wall clock', async () => {
    const master = seedRemote(F1_G2)
    await useCalendarStore.getState().updateRecurringEvent(master.id, { title: 'Copy' }, 'this', new Date('2027-03-14T10:30:00Z'))

    const copy = lastCreated()
    expect(lineOf(copy, 'DTSTART')).toBe('DTSTART;TZID=America/Los_Angeles:20270314T023000')
    expect(deserializeCalendarEvent(copy).startDate.toISOString()).toBe('2027-03-14T10:30:00.000Z')
  })

  it('row 12: "this and future" at a later LA gap occurrence keeps 02:30 in the new series; master cut just before it', async () => {
    const master = seedRemote(F1_G2)
    await useCalendarStore.getState().updateRecurringEvent(master.id, { title: 'Split' }, 'this_and_future', new Date('2027-03-14T10:30:00Z'))

    const masterIcs = lastUpdated()
    expect(lineOf(masterIcs, 'RRULE')).toBe('RRULE:FREQ=WEEKLY;UNTIL=20270314T102959Z') // control: cutover just before the occurrence
    expect(lineOf(masterIcs, 'DTSTART')).toBe('DTSTART;TZID=America/Los_Angeles:20260308T023000')
    const series = lastCreated()
    expect(lineOf(series, 'DTSTART')).toBe('DTSTART;TZID=America/Los_Angeles:20270314T023000')
    const range = { start: new Date('2027-03-10T00:00:00Z'), end: new Date('2027-03-25T00:00:00Z') }
    expect(isoList(expandEventsForRange([deserializeCalendarEvent(series)], range))).toEqual([
      '2027-03-14T10:30:00.000Z',
      '2027-03-21T09:30:00.000Z',
    ])
  })

  it('row N3: "this" at the Nuuk midnight-crossing gap writes the intended date and time', async () => {
    const master = seedRemote(F1_N)
    await useCalendarStore.getState().updateRecurringEvent(master.id, { title: 'Copy' }, 'this', new Date('2027-03-28T01:30:00Z'))

    const copy = lastCreated()
    expect(lineOf(copy, 'DTSTART')).toBe('DTSTART;TZID=America/Nuuk:20270327T233000')
    expect(deserializeCalendarEvent(copy).startDate.toISOString()).toBe('2027-03-28T01:30:00.000Z')
  })

  it('row N4: "this and future" at the Nuuk gap keeps 23:30; selected appears once across master and new series', async () => {
    const master = seedRemote(F1_N)
    const selected = new Date('2027-03-28T01:30:00Z')
    await useCalendarStore.getState().updateRecurringEvent(master.id, { title: 'Split' }, 'this_and_future', selected)

    const masterIcs = lastUpdated()
    expect(lineOf(masterIcs, 'RRULE')).toBe('RRULE:FREQ=WEEKLY;UNTIL=20270328T012959Z') // control: cutover just before the occurrence
    const series = lastCreated()
    expect(lineOf(series, 'DTSTART')).toBe('DTSTART;TZID=America/Nuuk:20270327T233000')
    const range = { start: new Date('2027-03-01T00:00:00Z'), end: new Date('2027-04-30T00:00:00Z') }
    const masterStarts = isoList(expandEventsForRange([deserializeCalendarEvent(masterIcs)], range))
    const seriesStarts = isoList(expandEventsForRange([deserializeCalendarEvent(series)], range))
    expect(seriesStarts.slice(0, 2)).toEqual(['2027-03-28T01:30:00.000Z', '2027-04-04T00:30:00.000Z'])
    expect(masterStarts).not.toContain(selected.toISOString())
    expect([...masterStarts, ...seriesStarts].filter((s) => s === selected.toISOString())).toHaveLength(1)
  })

  it('row D1 (preservation control): the Nuuk daily split keeps the preceding occurrence in the master', async () => {
    const master = seedRemote(F1_D)
    await useCalendarStore.getState().updateRecurringEvent(master.id, { title: 'Split' }, 'this_and_future', new Date('2027-03-28T01:30:00Z'))

    const masterIcs = lastUpdated()
    expect(lineOf(masterIcs, 'RRULE')).toBe('RRULE:FREQ=DAILY;UNTIL=20270328T012959Z')
    const range = { start: new Date('2027-03-20T00:00:00Z'), end: new Date('2027-04-05T00:00:00Z') }
    const masterStarts = isoList(expandEventsForRange([deserializeCalendarEvent(masterIcs)], range))
    expect(masterStarts).toEqual(['2027-03-26T01:30:00.000Z', '2027-03-27T01:30:00.000Z'])
    const seriesStarts = isoList(expandEventsForRange([deserializeCalendarEvent(lastCreated())], range))
    const union = [...masterStarts, ...seriesStarts]
    expect(union.filter((s) => s === '2027-03-27T01:30:00.000Z')).toHaveLength(1)
    expect(union.filter((s) => s === '2027-03-28T01:30:00.000Z')).toHaveLength(1)
    expect(seriesStarts).toContain('2027-03-28T01:30:00.000Z')
    expect(masterStarts).not.toContain('2027-03-28T01:30:00.000Z')
  })

  it('row D1n: the Nuuk daily new series starts at the intended 23:30 and repeats it', async () => {
    const master = seedRemote(F1_D)
    await useCalendarStore.getState().updateRecurringEvent(master.id, { title: 'Split' }, 'this_and_future', new Date('2027-03-28T01:30:00Z'))

    const series = lastCreated()
    expect(lineOf(series, 'DTSTART')).toBe('DTSTART;TZID=America/Nuuk:20270327T233000')
    const range = { start: new Date('2027-03-27T00:00:00Z'), end: new Date('2027-03-30T00:00:00Z') }
    expect(isoList(expandEventsForRange([deserializeCalendarEvent(series)], range))).toEqual([
      '2027-03-28T01:30:00.000Z',
      '2027-03-29T00:30:00.000Z',
    ])
  })

  it('row N5: a copy at a non-occurrence instant carries no stale anchor; the master keeps its original DTSTART', async () => {
    const master = seedRemote(F1_N)
    await useCalendarStore.getState().updateRecurringEvent(master.id, { title: 'Off schedule' }, 'this_and_future', new Date('2027-03-28T02:00:00Z'))

    const copyEvent = useCalendarStore.getState().events.find((e) => e.id !== master.id)!
    expect(copyEvent).not.toHaveProperty('startWallClock') // control
    expect(lineOf(lastCreated(), 'DTSTART')).toBe('DTSTART;TZID=America/Nuuk:20270328T010000') // control: derived
    expect(lineOf(lastUpdated(), 'DTSTART')).toBe('DTSTART;TZID=America/Nuuk:20260328T233000')
  })

  it('row 13 (control): "this" at a later ordinary occurrence writes its ordinary wall clock', async () => {
    const master = seedRemote(F1_G2)
    await useCalendarStore.getState().updateRecurringEvent(master.id, { title: 'Copy' }, 'this', new Date('2026-03-22T09:30:00Z'))

    expect(lineOf(lastCreated(), 'DTSTART')).toBe('DTSTART;TZID=America/Los_Angeles:20260322T023000')
  })

  it('row 14: "this" at the first occurrence writes the original gap DTSTART', async () => {
    const master = seedRemote(F1_G2)
    await useCalendarStore.getState().updateRecurringEvent(master.id, { title: 'First' }, 'this', new Date('2026-03-08T10:30:00Z'))

    expect(lineOf(lastCreated(), 'DTSTART')).toBe('DTSTART;TZID=America/Los_Angeles:20260308T023000')
  })

  it('row 15: "all" title-only and an end-only edit keep the original DTSTART', async () => {
    const master = seedRemote(F1_G2)
    await useCalendarStore.getState().updateRecurringEvent(master.id, { title: 'All' }, 'all', new Date('2026-03-08T10:30:00Z'))
    expect(lineOf(lastUpdated(), 'DTSTART')).toBe('DTSTART;TZID=America/Los_Angeles:20260308T023000')

    const standalone = seedRemote(F1_S)
    await useCalendarStore.getState().updateEvent(standalone.id, { endDate: new Date('2026-03-08T12:30:00Z') })
    expect(lineOf(lastUpdated(), 'DTSTART')).toBe('DTSTART;TZID=America/Los_Angeles:20260308T023000')
  })

  it('row 16 (control): move away and back, with or without reload, and move-Undo all write the same DTSTART', async () => {
    const original = { startDate: new Date('2026-03-08T10:30:00Z'), endDate: new Date('2026-03-08T12:30:00Z') }
    const away = { startDate: new Date('2026-03-09T17:00:00Z'), endDate: new Date('2026-03-09T19:00:00Z') }

    const a = seedRemote(F1_S)
    await useCalendarStore.getState().updateEvent(a.id, away)
    await useCalendarStore.getState().updateEvent(a.id, original)
    const withoutReload = lineOf(lastUpdated(), 'DTSTART')

    const b = seedRemote(F1_S)
    await useCalendarStore.getState().updateEvent(b.id, away)
    useCalendarStore.setState({ events: [deserializeCalendarEvent(lastUpdated())] })
    await useCalendarStore.getState().updateEvent(b.id, original)
    const withReload = lineOf(lastUpdated(), 'DTSTART')

    const c = seedRemote(F1_S)
    await useCalendarStore.getState().updateEvent(c.id, away)
    await useCalendarStore.getState().updateEvent(c.id, { startDate: original.startDate, endDate: original.endDate }) // Undo payload
    const afterUndo = lineOf(lastUpdated(), 'DTSTART')

    expect(withoutReload).toBe('DTSTART;TZID=America/Los_Angeles:20260308T033000')
    expect(withReload).toBe(withoutReload)
    expect(afterUndo).toBe(withoutReload)
  })

  it('row 17: a resize-Undo payload with an unchanged start keeps the original DTSTART', async () => {
    const s = seedRemote(F1_S)
    await useCalendarStore.getState().updateEvent(s.id, {
      startDate: new Date('2026-03-08T10:30:00Z'),
      endDate: new Date('2026-03-08T11:30:00Z'),
    })
    expect(lineOf(lastUpdated(), 'DTSTART')).toBe('DTSTART;TZID=America/Los_Angeles:20260308T023000')
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

// ── "this and future" must keep every occurrence before the selected one ──

describe('useCalendarStore "this and future" keeps the previous occurrence', () => {
  beforeEach(() => {
    resetStore()
  })

  /** Split (edit) or cut (delete) the series at `instance`; return the master as stored and reloaded. */
  async function cutAt(master: CalendarEvent, action: 'edit' | 'delete', instance: Date) {
    useCalendarStore.setState({ events: [master] })
    if (action === 'edit') {
      await useCalendarStore.getState().updateRecurringEvent(master.id, { title: 'Changed' }, 'this_and_future', instance)
    } else {
      await useCalendarStore.getState().deleteRecurringEvent(master.id, 'this_and_future', instance)
    }
    const events = useCalendarStore.getState().events
    const stored = events.find((e) => e.id === master.id)!
    const ics = serializeCalendarEvent(stored)
    return { ics, reloaded: deserializeCalendarEvent(ics), series: events.find((e) => e.id !== master.id) }
  }

  const ACTIONS = ['edit', 'delete'] as const

  it.each(ACTIONS)('timed UTC series (%s): the day before stays, the selected day goes', async (action) => {
    // The reported case: daily at 08:00Z from 5 Jan, cut at 7 Jan.
    const master = makeRecurringEvent({
      startDate: new Date('2026-01-05T08:00:00Z'),
      endDate: new Date('2026-01-05T09:00:00Z'),
    })
    const instance = new Date('2026-01-07T08:00:00Z')

    const { ics, reloaded, series } = await cutAt(master, action, instance)

    const range = { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-01-12T00:00:00Z') }
    expect(isoList(expandEventsForRange([reloaded], range))).toEqual([
      '2026-01-05T08:00:00.000Z',
      '2026-01-06T08:00:00.000Z',
    ])
    expect(lineOf(ics, 'RRULE')).toBe('RRULE:FREQ=DAILY;UNTIL=20260107T075959Z')
    if (action === 'edit') {
      expect(isoList(expandEventsForRange([series!], range))[0]).toBe(instance.toISOString())
    }
  })

  it.each(ACTIONS)('timed America/New_York series (%s): the evening before stays', async (action) => {
    // 20:00 New York is 01:00Z the next day, so the zone and UTC dates differ.
    const master = makeRecurringEvent({
      startDate: new Date('2026-01-06T01:00:00Z'), // 5 Jan 20:00 EST
      endDate: new Date('2026-01-06T02:00:00Z'),
      timezone: 'America/New_York',
    })
    const instance = new Date('2026-01-08T01:00:00Z') // 7 Jan 20:00 EST

    const { ics, reloaded, series } = await cutAt(master, action, instance)

    const range = { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2026-01-12T00:00:00Z') }
    expect(isoList(expandEventsForRange([reloaded], range))).toEqual([
      '2026-01-06T01:00:00.000Z',
      '2026-01-07T01:00:00.000Z',
    ])
    expect(lineOf(ics, 'RRULE')).toBe('RRULE:FREQ=DAILY;UNTIL=20260108T005959Z')
    if (action === 'edit') {
      expect(isoList(expandEventsForRange([series!], range))[0]).toBe(instance.toISOString())
    }
  })

  it.each(ACTIONS)('floating timed series (%s): the day before stays and UNTIL is its floating 23:59:59', async (action) => {
    const master = makeRecurringEvent({
      startDate: new Date(2026, 0, 5, 8, 0, 0),
      endDate: new Date(2026, 0, 5, 9, 0, 0),
      floating: true,
    })
    const instance = new Date(2026, 0, 7, 8, 0, 0)

    const { ics, reloaded } = await cutAt(master, action, instance)

    const range = { start: new Date(2026, 0, 1), end: new Date(2026, 0, 12) }
    expect(expandEventsForRange([reloaded], range).map((e) => e.startDate.getTime())).toEqual([
      new Date(2026, 0, 5, 8).getTime(),
      new Date(2026, 0, 6, 8).getTime(),
    ])
    expect(lineOf(ics, 'RRULE')).toBe('RRULE:FREQ=DAILY;UNTIL=20260106T235959')
  })

  it.each(ACTIONS)('all-day series (%s): the day before stays and UNTIL stays a date', async (action) => {
    const master = makeRecurringEvent({
      startDate: new Date(2026, 0, 5),
      endDate: new Date(2026, 0, 6),
      allDay: true,
    })
    const instance = new Date(2026, 0, 7)

    const { ics, reloaded } = await cutAt(master, action, instance)

    const range = { start: new Date(2026, 0, 1), end: new Date(2026, 0, 12) }
    expect(expandEventsForRange([reloaded], range).map((e) => e.startDate.getTime())).toEqual([
      new Date(2026, 0, 5).getTime(),
      new Date(2026, 0, 6).getTime(),
    ])
    expect(lineOf(ics, 'RRULE')).toBe('RRULE:FREQ=DAILY;UNTIL=20260106')
  })

  // Floating series cut in New York at a DST transition, then reloaded in other host zones.
  // 2026-03-08 02:00-03:00 does not exist in New York; 2026-11-01 01:00-02:00 happens twice.
  const FLOATING_DST_CASES = [
    { name: 'spring-forward 02:30 (inside the gap)', dtstart: '20260306T023000', month: 2, until: '20260307T235959', kept: ['6 2:30', '7 2:30'] },
    { name: 'spring-forward 03:00', dtstart: '20260306T030000', month: 2, until: '20260307T235959', kept: ['6 3:0', '7 3:0'] },
    { name: 'fall-back 01:30 (repeated hour)', dtstart: '20261030T013000', month: 9, until: '20261031T235959', kept: ['30 1:30', '31 1:30'] },
  ] as const
  const FLOATING_DST_MATRIX = FLOATING_DST_CASES.flatMap((c) => ACTIONS.map((action) => ({ ...c, action })))

  it.each(FLOATING_DST_MATRIX)('floating series, $name ($action): earlier days stay and the selected day goes, in every zone', async ({ dtstart, month, until, kept, action }) => {
    const previousTZ = process.env.TZ
    // Covers the last days of `month` and the start of the next one in the current host zone.
    const range = () => ({ start: new Date(2026, month, 1), end: new Date(2026, month + 1, 12) })
    try {
      process.env.TZ = 'America/New_York'
      const master = deserializeCalendarEvent([
        'BEGIN:VEVENT',
        'UID:floating-dst',
        'SUMMARY:Floating DST series',
        `DTSTART:${dtstart}`,
        'RRULE:FREQ=DAILY',
        'END:VEVENT',
      ].join('\r\n'))
      const instance = expandEventsForRange([master], range())[2]!.instanceDate

      const { ics } = await cutAt(master, action, instance)

      for (const zone of ['America/New_York', 'UTC', 'Asia/Tokyo']) {
        process.env.TZ = zone
        const starts = expandEventsForRange([deserializeCalendarEvent(ics)], range())
          .map((e) => `${e.startDate.getDate()} ${e.startDate.getHours()}:${e.startDate.getMinutes()}`)
        expect({ zone, starts }).toEqual({ zone, starts: [...kept] })
      }
      expect(lineOf(ics, 'RRULE')).toBe(`RRULE:FREQ=DAILY;UNTIL=${until}`)
    } finally {
      if (previousTZ === undefined) delete process.env.TZ
      else process.env.TZ = previousTZ
    }
  })

  // Expansion of an inclusive UNTIL on a first occurrence inside a host DST gap is unchanged by
  // the split fix; these pin the existing behaviour.
  it.each([
    { name: 'all-day DTSTART and UNTIL on the Santiago gap date', zone: 'America/Santiago', lines: ['DTSTART;VALUE=DATE:20260906', 'DTEND;VALUE=DATE:20260907', 'RRULE:FREQ=DAILY;UNTIL=20260906'], month: 8, expected: ['2026-09-06T04:00:00.000Z'] },
    { name: 'floating DTSTART and UNTIL at New York 02:30 on the gap date', zone: 'America/New_York', lines: ['DTSTART:20260308T023000', 'DTEND:20260308T033000', 'RRULE:FREQ=DAILY;UNTIL=20260308T023000'], month: 2, expected: ['2026-03-08T07:30:00.000Z'] },
  ])('unchanged: $name', ({ zone, lines, month, expected }) => {
    const previousTZ = process.env.TZ
    try {
      process.env.TZ = zone
      const event = deserializeCalendarEvent(['BEGIN:VEVENT', 'UID:f3', 'SUMMARY:F3', ...lines, 'END:VEVENT'].join('\r\n'))
      const starts = isoList(expandEventsForRange([event], { start: new Date(2026, month, 1), end: new Date(2026, month + 1, 1) }))
      expect(starts).toEqual(expected)
    } finally {
      if (previousTZ === undefined) delete process.env.TZ
      else process.env.TZ = previousTZ
    }
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

// ── WEB-05: a refused queue write is reported, not hidden as "offline" ──
// Real fake-IndexedDB queue in production mode (plaintext refused), a stubbed
// account, and an uncached temporary event. updateEvent reaches the real
// enqueue and the real isOfflineError; only navigator.onLine is fixed per case.

describe('WEB-05 calendar update refused by the production queue', () => {
  // Local equivalent of the guarded-queue block's queuedEvent helper.
  const uncachedTempEvent = () => makeRecurringEvent({ id: 'web05-temp-event', uid: 'web05-temp-event', recurrenceRule: null, calendarId: 'cal-1' })

  beforeEach(async () => {
    await resetRealOfflineQueue()
    resetStore()
    offlineAccount()
    toastMock.showErrorToast.mockReset()
  })

  it.each([
    ['online', true],
    ['offline', false],
  ] as const)('shows the existing failure toast and queues nothing when an uncached update is refused while %s', async (_state, online) => {
    const originalOnLine = Object.getOwnPropertyDescriptor(globalThis.navigator, 'onLine')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    _setEncryptedQueuePersistenceAvailableForTests(false)
    Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, get: () => online })
    try {
      useCalendarStore.setState({ events: [uncachedTempEvent()] })
      expect(etebaseMock.state.itemCache.has('web05-temp-event')).toBe(false)

      await expect(useCalendarStore.getState().updateEvent('web05-temp-event', { title: 'WEB05 edited' })).resolves.toBeUndefined()

      expect(etebaseMock.state.updateItem).not.toHaveBeenCalled()
      expect(await getAll()).toEqual([])
      expect(await getAll(queueGuard(TEST_FINGERPRINT))).toEqual([])

      expect(toastMock.showErrorToast).toHaveBeenCalledWith('Failed to save event. Please try again.')
    } finally {
      if (originalOnLine) Object.defineProperty(globalThis.navigator, 'onLine', originalOnLine)
      else delete (globalThis.navigator as { onLine?: boolean }).onLine
      _setEncryptedQueuePersistenceAvailableForTests(true)
      errorSpy.mockRestore()
    }
  })
})

describe('useCalendarStore keeps unsupported event content (WEB-03)', () => {
  const SERIES = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Other Client//EN',
    'BEGIN:VEVENT',
    'UID:web03-series',
    'DTSTART:20270301T100000Z',
    'DTEND:20270301T110000Z',
    'RRULE:FREQ=WEEKLY;COUNT=6',
    'RDATE:20270420T100000Z',
    'SUMMARY:Weekly',
    'TRANSP:TRANSPARENT',
    'ATTENDEE;CN=Guest:mailto:guest@example.invalid',
    'X-EXAMPLE-PROP:keep-me',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')

  beforeEach(() => {
    resetStore()
  })

  it('a title edit uploads the attendee, transparency and extra properties unchanged', async () => {
    const event = seedRemote(SERIES)
    await useCalendarStore.getState().updateEvent(event.id, { title: 'Weekly v2' })

    const uploaded = lastUpdated()
    expect(uploaded).toMatch(/^SUMMARY:Weekly v2$/m)
    expect(uploaded).toMatch(/^ATTENDEE;CN=Guest:mailto:guest@example\.invalid$/m)
    expect(uploaded).toMatch(/^TRANSP:TRANSPARENT$/m)
    expect(uploaded).toMatch(/^X-EXAMPLE-PROP:keep-me$/m)
    expect(uploaded).toMatch(/^RDATE:20270420T100000Z$/m)
  })

  it('a "this" copy gets a new item without the series\' retained lines; the master keeps them', async () => {
    const master = seedRemote(SERIES)
    await useCalendarStore.getState().updateRecurringEvent(master.id, { title: 'Copy' }, 'this', new Date('2027-03-08T10:00:00Z'))

    const copy = lastCreated()
    expect(copy).toMatch(/^SUMMARY:Copy$/m)
    expect(copy).not.toMatch(/^(RDATE|ATTENDEE|X-EXAMPLE-PROP)[;:]/m)
    const masterIcs = lastUpdated()
    expect(masterIcs).toMatch(/^RDATE:20270420T100000Z$/m)
    expect(masterIcs).toMatch(/^X-EXAMPLE-PROP:keep-me$/m)
  })

  it('a "this and future" edit moves later RDATEs to the new series and keeps the rest on the original', async () => {
    const master = seedRemote(SERIES)
    await useCalendarStore.getState().updateRecurringEvent(master.id, { title: 'Split' }, 'this_and_future', new Date('2027-03-15T10:00:00Z'))

    const series = lastCreated()
    expect(series).toMatch(/^RDATE:20270420T100000Z$/m)
    expect(series).not.toMatch(/^(ATTENDEE|X-EXAMPLE-PROP)[;:]/m)
    const masterIcs = lastUpdated()
    expect(masterIcs).toMatch(/^RRULE:FREQ=WEEKLY;UNTIL=20270315T095959Z$/m)
    expect(masterIcs).not.toMatch(/^RDATE/m)
    expect(masterIcs).toMatch(/^X-EXAMPLE-PROP:keep-me$/m)
  })

  it('a "this and future" edit keeps earlier RDATEs on the original only', async () => {
    const master = seedRemote(SERIES.replace('RDATE:20270420T100000Z', 'RDATE:20270310T100000Z,20270420T100000Z'))
    await useCalendarStore.getState().updateRecurringEvent(master.id, { title: 'Split' }, 'this_and_future', new Date('2027-03-15T10:00:00Z'))

    expect(lastUpdated()).toMatch(/^RDATE:20270310T100000Z$/m)
    expect(lastCreated()).toMatch(/^RDATE:20270420T100000Z$/m)
  })

  const WEEK_SERIES = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:web03-week',
    'DTSTART;TZID=America/New_York:20260226T100000',
    'DURATION:P1W',
    'RRULE:FREQ=WEEKLY;COUNT=6',
    'SUMMARY:Week',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')

  it('a "this" copy of a P1W occurrence across DST keeps the nominal week', async () => {
    const master = seedRemote(WEEK_SERIES)
    await useCalendarStore.getState().updateRecurringEvent(master.id, { title: 'Copy' }, 'this', new Date('2026-03-05T15:00:00Z'))

    const copy = lastCreated()
    expect(copy).toMatch(/^DTSTART;TZID=America\/New_York:20260305T100000$/m)
    expect(copy).toMatch(/^DURATION:P1W$/m)
    expect(copy).not.toMatch(/^DTEND/m)
    expect(deserializeCalendarEvent(copy).endDate.toISOString()).toBe('2026-03-12T14:00:00.000Z')
  })

  it('a "this and future" series from a P1W occurrence across DST keeps the nominal week', async () => {
    const master = seedRemote(WEEK_SERIES)
    await useCalendarStore.getState().updateRecurringEvent(master.id, { title: 'Split' }, 'this_and_future', new Date('2026-03-05T15:00:00Z'))

    const series = lastCreated()
    expect(series).toMatch(/^DTSTART;TZID=America\/New_York:20260305T100000$/m)
    expect(series).toMatch(/^DURATION:P1W$/m)
    expect(series).not.toMatch(/^DTEND/m)
    expect(lastUpdated()).toMatch(/^DURATION:P1W$/m)
  })

  it('after the series length is edited, a later "this" copy uses the edited length, not the old DURATION', async () => {
    const master = seedRemote(WEEK_SERIES)
    await useCalendarStore.getState().updateEvent(master.id, { endDate: new Date('2026-02-26T17:00:00Z') })
    expect(lastUpdated()).toMatch(/^DTEND;TZID=America\/New_York:20260226T120000$/m)

    await useCalendarStore.getState().updateRecurringEvent(master.id, { title: 'Copy' }, 'this', new Date('2026-03-05T15:00:00Z'))

    const copy = lastCreated()
    expect(copy).toMatch(/^DTEND;TZID=America\/New_York:20260305T120000$/m)
    expect(copy).not.toMatch(/^DURATION/m)
  })

  it('control: a copy whose length is edited writes DTEND', async () => {
    const master = seedRemote(WEEK_SERIES)
    await useCalendarStore.getState().updateRecurringEvent(
      master.id,
      { endDate: new Date('2026-03-05T17:00:00Z') },
      'this',
      new Date('2026-03-05T15:00:00Z'),
    )

    const copy = lastCreated()
    expect(copy).toMatch(/^DTEND;TZID=America\/New_York:20260305T120000$/m)
    expect(copy).not.toMatch(/^DURATION/m)
  })

  it('a "this and future" delete drops later RDATEs from the original', async () => {
    const master = seedRemote(SERIES.replace('RDATE:20270420T100000Z', 'RDATE:20270310T100000Z,20270420T100000Z'))
    await useCalendarStore.getState().deleteRecurringEvent(master.id, 'this_and_future', new Date('2027-03-15T10:00:00Z'))

    const masterIcs = lastUpdated()
    expect(masterIcs).toMatch(/^RRULE:FREQ=WEEKLY;UNTIL=20270315T095959Z$/m)
    expect(masterIcs).toMatch(/^RDATE:20270310T100000Z$/m)
    expect(masterIcs).not.toMatch(/20270420/)
    expect(etebaseMock.state.createItem).not.toHaveBeenCalled()
  })
})

describe('useCalendarStore "this and future" split of a COUNT series (WEB-02)', () => {
  beforeEach(() => {
    resetStore()
  })

  const weekly = () => makeRecurringEvent({
    startDate: new Date('2026-06-01T09:00:00Z'),
    endDate: new Date('2026-06-01T09:30:00Z'),
    recurrenceRule: 'FREQ=WEEKLY;COUNT=5',
    timezone: 'Europe/Berlin',
  })
  const june = { start: new Date('2026-05-01T00:00:00Z'), end: new Date('2026-09-01T00:00:00Z') }
  const startsOf = (events: CalendarEvent[]) => expandEventsForRange(events, june)
    .map((e) => e.startDate.toISOString())
    .sort()

  async function splitAt(master: CalendarEvent, instance: Date, patch: Partial<CalendarEvent> = { title: 'Later' }) {
    useCalendarStore.setState({ events: [master] })
    await useCalendarStore.getState().updateRecurringEvent(master.id, patch, 'this_and_future', instance)
    const events = useCalendarStore.getState().events
    return {
      original: events.find((e) => e.id === master.id)!,
      series: events.find((e) => e.id !== master.id)!,
    }
  }

  it('gives the new series only the occurrences that were still to come', async () => {
    const master = weekly()
    const { original, series } = await splitAt(master, new Date('2026-06-15T09:00:00Z'))

    expect(original.recurrenceRule).toBe('FREQ=WEEKLY;UNTIL=20260615T085959Z')
    expect(series.recurrenceRule).toBe('FREQ=WEEKLY;COUNT=3')
    expect(startsOf([original, series])).toEqual(startsOf([master]))
    expect(startsOf([original, series])).toHaveLength(5)
  })

  it('counts an excluded occurrence before the split, as COUNT does', async () => {
    const master = weekly()
    master.exceptions = [new Date('2026-06-08T09:00:00Z')]
    const { original, series } = await splitAt(master, new Date('2026-06-22T09:00:00Z'))

    expect(series.recurrenceRule).toBe('FREQ=WEEKLY;COUNT=2')
    expect(startsOf([original, series])).toEqual(startsOf([master]))
  })

  it('control: a split at the first occurrence keeps the full COUNT', async () => {
    const master = weekly()
    const { original, series } = await splitAt(master, master.startDate)

    expect(series.recurrenceRule).toBe('FREQ=WEEKLY;COUNT=5')
    expect(startsOf([original, series])).toEqual(startsOf([master]))
  })

  it('control: an explicitly chosen new rule is kept as chosen', async () => {
    const { series } = await splitAt(weekly(), new Date('2026-06-15T09:00:00Z'), { recurrenceRule: 'FREQ=DAILY;COUNT=4' })

    expect(series.recurrenceRule).toBe('FREQ=DAILY;COUNT=4')
  })

  it('control: an open-ended or UNTIL series keeps its rule on the new series', async () => {
    const open = await splitAt(makeRecurringEvent({ recurrenceRule: 'FREQ=WEEKLY', timezone: 'Europe/Berlin' }), new Date('2026-06-15T09:00:00Z'))
    expect(open.series.recurrenceRule).toBe('FREQ=WEEKLY')

    resetStore()
    const until = await splitAt(
      makeRecurringEvent({ recurrenceRule: 'FREQ=WEEKLY;UNTIL=20260630T090000Z', timezone: 'Europe/Berlin' }),
      new Date('2026-06-15T09:00:00Z'),
    )
    expect(until.series.recurrenceRule).toBe('FREQ=WEEKLY;UNTIL=20260630T090000Z')
  })
})

describe('useCalendarStore occurrence-scoped time edits (WEB-01)', () => {
  beforeEach(() => {
    resetStore()
  })

  const weekly = () => makeRecurringEvent({
    startDate: new Date('2026-06-01T09:00:00Z'),
    endDate: new Date('2026-06-01T09:30:00Z'),
    recurrenceRule: 'FREQ=WEEKLY;COUNT=5',
    timezone: 'UTC',
  })
  const june = { start: new Date('2026-05-01T00:00:00Z'), end: new Date('2026-09-01T00:00:00Z') }
  const startsOf = (events: CalendarEvent[]) => expandEventsForRange(events, june)
    .map((e) => e.startDate.toISOString())
    .sort()

  it.each(['this', 'this_and_future'] as const)('%s: an occurrence-dated time patch moves only that occurrence onward', async (scope) => {
    const master = weekly()
    useCalendarStore.setState({ events: [master] })
    // The patch the edit dialog builds for the 15 June occurrence moved from 09:00 to 10:00.
    await useCalendarStore.getState().updateRecurringEvent(master.id, {
      startDate: new Date('2026-06-15T10:00:00Z'),
      endDate: new Date('2026-06-15T10:30:00Z'),
    }, scope, new Date('2026-06-15T09:00:00Z'))

    const starts = startsOf(useCalendarStore.getState().events)
    expect(starts).toEqual(scope === 'this'
      ? ['2026-06-01T09:00:00.000Z', '2026-06-08T09:00:00.000Z', '2026-06-15T10:00:00.000Z', '2026-06-22T09:00:00.000Z', '2026-06-29T09:00:00.000Z']
      : ['2026-06-01T09:00:00.000Z', '2026-06-08T09:00:00.000Z', '2026-06-15T10:00:00.000Z', '2026-06-22T10:00:00.000Z', '2026-06-29T10:00:00.000Z'])
  })
})

describe('useCalendarStore.createEvent outcome (WEB-04)', () => {
  beforeEach(() => {
    resetStore()
    toastMock.showErrorToast.mockReset()
  })

  const input = { title: 'New', startDate: new Date('2026-06-01T09:00:00Z'), endDate: new Date('2026-06-01T10:00:00Z'), calendarId: 'cal-1' }

  it('without an account, rejects as never sent and lists nothing', async () => {
    await expect(useCalendarStore.getState().createEvent(input)).rejects.toMatchObject({ name: 'CalendarSaveError', unconfirmed: false })
    expect(useCalendarStore.getState().events).toEqual([])
    expect(etebaseMock.state.createItem).not.toHaveBeenCalled()
  })

  it('when the create is refused or fails, rejects as unconfirmed and removes the temporary event', async () => {
    etebaseMock.state.account = {}
    etebaseMock.state.createItem.mockResolvedValue(null)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(useCalendarStore.getState().createEvent(input)).rejects.toMatchObject({ name: 'CalendarSaveError', unconfirmed: true })
    expect(useCalendarStore.getState().events).toEqual([])
    errorSpy.mockRestore()
  })

  it('when the create throws, rejects as unconfirmed and removes the temporary event', async () => {
    etebaseMock.state.account = {}
    etebaseMock.state.createItem.mockRejectedValue(new Error('boom'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(useCalendarStore.getState().createEvent(input)).rejects.toMatchObject({ name: 'CalendarSaveError', unconfirmed: true })
    expect(useCalendarStore.getState().events).toEqual([])
    errorSpy.mockRestore()
  })

  it('control: a confirmed create resolves and lists the event under its item id', async () => {
    etebaseMock.state.account = {}
    etebaseMock.state.createItem.mockResolvedValue('remote-1')

    await expect(useCalendarStore.getState().createEvent(input)).resolves.toMatchObject({ id: 'remote-1', title: 'New' })
    expect(useCalendarStore.getState().events.map((e) => e.id)).toEqual(['remote-1'])
  })

  it('control: a create held in the offline queue resolves and keeps the event listed', async () => {
    await resetRealOfflineQueue()
    offlineAccount()

    const created = await useCalendarStore.getState().createEvent(input)

    expect(useCalendarStore.getState().events.map((e) => e.id)).toEqual([created.id])
    await expectOwnedQueueEntry('create', 'calendar')
  })
})
