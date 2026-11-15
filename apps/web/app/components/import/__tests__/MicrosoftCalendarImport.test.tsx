import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { deserializeCalendarEvent } from '@silentsuite/core'
import CalendarImport from '../CalendarImport'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import { useCalendarStore } from '@/app/stores/use-calendar-store'
import { useCalendarListStore } from '@/app/stores/use-calendar-list-store'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { _setEncryptedQueuePersistenceAvailableForTests } from '@/app/lib/offline-queue'
import { importSourceKeyOf } from '@/app/lib/google-import/source-key'
import type { GoogleCalendarImport } from '@/app/lib/google-import/importer'
import { loadMicrosoftCalendars } from '@/app/lib/microsoft-import/importer'
import { createGraphFake, type GraphFake } from '@/app/lib/microsoft-import/__tests__/graph-fake'

// Interrupt / retry / re-import fixture for the Microsoft import (#48). The real importer reads
// a Graph fake that returns only the fields each request selects (and continues the series'
// exceptions on a second page); the real CalendarImport, calendar store and Etebase bridge
// write it. Sign-in is replaced at the oauth module, the only part a browser popup needs.

vi.mock('@/app/lib/microsoft-import/oauth', () => ({
  MICROSOFT_CALENDAR_SCOPE: 'https://graph.microsoft.com/Calendars.Read',
  MICROSOFT_CONTACTS_SCOPE: 'https://graph.microsoft.com/Contacts.Read',
  signInWithMicrosoft: async () => ({ accountId: 'tenant.sub-1' }),
  getMicrosoftAccessToken: () => 'graph-token',
  clearMicrosoftAccessToken: () => undefined,
}))

const toastMock = vi.hoisted(() => ({ showErrorToast: vi.fn() }))
vi.mock('@/app/stores/use-toast-store', () => toastMock)

const UTC = (dateTime: string) => ({ dateTime: `${dateTime}.0000000`, timeZone: 'UTC' })
const BERLIN = 'W. Europe Standard Time'

const calendars = [
  { id: 'cal-personal', name: 'Calendar', hexColor: '', isDefaultCalendar: true },
  { id: 'cal-team', name: 'Team', hexColor: '#336699' },
]

const standupExceptions = [
  {
    id: 'standup-ex-1', type: 'exception', subject: 'Standup (moved)', originalStart: '2026-06-08T07:00:00Z',
    start: UTC('2026-06-08T08:00:00'), end: UTC('2026-06-08T08:15:00'), isAllDay: false,
    originalStartTimeZone: BERLIN, originalEndTimeZone: BERLIN, showAs: 'busy', isReminderOn: false, isCancelled: false,
  },
  {
    id: 'standup-ex-2', type: 'exception', subject: 'Standup (long)', originalStart: '2026-06-15T07:00:00Z',
    start: UTC('2026-06-15T07:00:00'), end: UTC('2026-06-15T08:00:00'), isAllDay: false,
    originalStartTimeZone: BERLIN, originalEndTimeZone: BERLIN, showAs: 'busy', isReminderOn: false, isCancelled: false,
  },
]

const events: Record<string, Record<string, unknown>[]> = {
  'cal-personal': [
    {
      id: 'dentist', iCalUId: 'uid-dentist', type: 'singleInstance', subject: 'Dentist', body: { contentType: 'text', content: 'Bring card' },
      start: UTC('2026-06-03T08:00:00'), end: UTC('2026-06-03T09:00:00'), isAllDay: false,
      originalStartTimeZone: BERLIN, originalEndTimeZone: BERLIN, showAs: 'busy', isReminderOn: true, reminderMinutesBeforeStart: 30, isCancelled: false,
    },
  ],
  'cal-team': [
    {
      id: 'standup', iCalUId: 'uid-standup', type: 'seriesMaster', subject: 'Standup',
      start: UTC('2026-06-01T07:00:00'), end: UTC('2026-06-01T07:15:00'), isAllDay: false,
      originalStartTimeZone: BERLIN, originalEndTimeZone: BERLIN, showAs: 'busy', isReminderOn: false, isCancelled: false,
      recurrence: {
        pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday'], firstDayOfWeek: 'monday' },
        range: { type: 'numbered', startDate: '2026-06-01', numberOfOccurrences: 10, recurrenceTimeZone: BERLIN },
      },
      cancelledOccurrences: ['OID.standup.2026-06-22'],
      exceptionOccurrences: standupExceptions,
    },
    {
      id: 'offsite', iCalUId: 'uid-offsite', type: 'singleInstance', subject: 'Offsite',
      start: UTC('2026-07-01T00:00:00'), end: UTC('2026-07-03T00:00:00'), isAllDay: true,
      originalStartTimeZone: BERLIN, originalEndTimeZone: BERLIN, showAs: 'free', isReminderOn: false, isCancelled: false,
    },
  ],
}

let graph: GraphFake
let onlyPersonal = false
let failContinuation = false
let lastRead: GoogleCalendarImport | null = null

async function readMicrosoft(): Promise<GoogleCalendarImport> {
  graph = createGraphFake({
    calendars: onlyPersonal ? calendars.slice(0, 1) : calendars,
    events,
    exceptionPageSize: 1,
    failContinuation,
  })
  lastRead = await loadMicrosoftCalendars({ clientId: 'client-1', popup: null, fetcher: graph.fetch, sleep: async () => undefined })
  return lastRead
}

vi.mock('../MicrosoftImportButton', () => ({
  default: (props: { onLoaded: (result: GoogleCalendarImport) => void; onError: (message: string) => void }) => (
    <button type="button" onClick={() => { readMicrosoft().then(props.onLoaded, (err: Error) => props.onError(err.message)) }}>Import from Microsoft</button>
  ),
}))

/** The real bridge with a controlled account, as in GoogleCalendarImport.test.tsx. */
function installCalendarAccount(batches: ('ok' | 'offline-before-apply' | 'applied-then-lost')[]) {
  const plan = [...batches]
  const written: { collectionUid: string; contents: string[]; outcome: string }[] = []
  const server = new Map<string, { uid: string; content: string }[]>()
  let collectionSequence = 0
  let itemSequence = 0
  const collection = (uid: string, meta: { name: string; color?: string }) => ({ uid, getMeta: () => meta })
  const account = {
    getCollectionManager: () => ({
      create: async (_type: string, meta: { name: string; color?: string }) => collection(`created-${++collectionSequence}`, meta),
      upload: async () => undefined,
      fetch: async (uid: string) => collection(uid, { name: uid }),
      getItemManager: (target: { uid: string }) => ({
        create: async (_meta: unknown, content: string) => ({ uid: `event-item-${++itemSequence}`, content }),
        batch: async (items: { uid: string; content: string }[]) => {
          const outcome = plan.shift() ?? 'ok'
          written.push({ collectionUid: target.uid, contents: items.map(({ content }) => content), outcome })
          if (outcome === 'offline-before-apply') throw new TypeError('Failed to fetch')
          server.set(target.uid, [...(server.get(target.uid) ?? []), ...items])
          if (outcome === 'applied-then-lost') throw new TypeError('Failed to fetch')
        },
        list: async () => ({
          data: (server.get(target.uid) ?? []).map(({ uid, content }) => ({ uid, isDeleted: false, getContent: async () => content, getMeta: () => ({}) })),
          stoken: null,
          done: true,
        }),
      }),
    }),
  }
  useEtebaseStore.setState({
    account,
    accountFingerprint: 'microsoft-import-fixture',
    collections: { calendar: [collection('cal-work', { name: 'Work' })], tasks: [], contacts: [], notes: [], preferences: [] },
    itemCache: new Map(),
    itemTypeMap: new Map(),
    itemCollectionMap: new Map(),
    syncEngine: null,
  } as any)
  const copiesOnServer = () => [...server.values()].flat().map(({ content }) => importSourceKeyOf(deserializeCalendarEvent(content).unknownProperties))
  return Object.assign(written, { copiesOnServer })
}

describe('Microsoft calendar import: projection, interrupt, retry, re-import', () => {
  beforeEach(() => {
    _setEncryptedQueuePersistenceAvailableForTests(false)
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    useAuthStore.setState({ canWrite: () => true } as any)
    useCalendarStore.setState({ events: [] })
    useCalendarListStore.setState({ calendars: [{ id: 'cal-work', name: 'Work', color: '#123456', visible: true }], defaultCalendarId: 'cal-work' })
    toastMock.showErrorToast.mockReset()
    onlyPersonal = false
    failContinuation = false
    lastRead = null
  })

  it('reads each master with selected exceptions and their continuation, writes each series whole, retries, and a re-import adds nothing', async () => {
    const written = installCalendarAccount(['ok', 'offline-before-apply'])
    const onImportComplete = vi.fn()
    renderWithIntl(<CalendarImport onImportComplete={onImportComplete} />)

    fireEvent.click(screen.getByRole('button', { name: 'Import from Microsoft' }))
    expect(await screen.findByText('3 events found in 2 Outlook calendars')).toBeInTheDocument()
    expect(lastRead!.unreadable).toBe(0)

    // The master was read again with both relationships selected and the exceptions expanded,
    // and the second page of exceptions was followed.
    const masterRequest = graph.requests.find((url) => url.pathname === '/v1.0/me/events/standup')!
    expect(masterRequest.searchParams.get('$select')!.split(',')).toEqual(expect.arrayContaining(['cancelledOccurrences', 'exceptionOccurrences', 'recurrence']))
    expect(masterRequest.searchParams.get('$expand')).toMatch(/^exceptionOccurrences\(\$select=.*originalStart/)
    expect(graph.requests.some((url) => url.pathname === '/v1.0/me/events/standup/exceptionOccurrences')).toBe(true)
    expect(graph.headers.every((h) => h.prefer?.includes('IdType="ImmutableId"'))).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Import into 2 calendars' }))
    expect(await screen.findByText(/Imported 1 of 3 events/)).toBeInTheDocument()
    expect(written.map((w) => [w.contents.length, w.outcome])).toEqual([[1, 'ok'], [2, 'offline-before-apply']])

    fireEvent.click(screen.getByRole('button', { name: 'Import 2 events' }))
    await waitFor(() => expect(onImportComplete).toHaveBeenCalledWith(2))
    expect(written).toHaveLength(3)
    const saved = written[2]!.contents.map((content) => deserializeCalendarEvent(content))
    const series = saved.find((event) => event.title === 'Standup')!
    expect(series.recurrenceRule).toMatch(/FREQ=WEEKLY/)
    expect(series.recurrenceRule).toMatch(/COUNT=10/)
    expect(series.timezone).toBe('Europe/Berlin')
    expect(series.exceptions.map((d) => d.toISOString())).toEqual(['2026-06-22T07:00:00.000Z'])
    expect(series.overrides).toHaveLength(2)
    expect(series.overrides!.join('\n')).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20260608T090000')
    expect(series.overrides!.join('\n')).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20260615T090000')
    expect(series.overrides!.join('\n')).toContain('SUMMARY:Standup (moved)')
    const offsite = saved.find((event) => event.title === 'Offsite')!
    expect(offsite.allDay).toBe(true)

    const keys = useCalendarStore.getState().events.map((event) => importSourceKeyOf(event.unknownProperties))
    expect(new Set(keys).size).toBe(3)
    expect(keys).toContain('microsoft/tenant.sub-1/cal-team/uid-standup')

    fireEvent.click(screen.getByRole('button', { name: 'Import from Microsoft' }))
    expect(await screen.findByText(/Nothing new to import from Microsoft\. 3 already imported entries were skipped\./)).toBeInTheDocument()
    expect(written).toHaveLength(3)
    expect(written.copiesOnServer()).toHaveLength(3)
  })

  it('a series whose exception continuation fails is left out, unmarked, and imported on the next run', async () => {
    const written = installCalendarAccount([])
    const onImportComplete = vi.fn()
    renderWithIntl(<CalendarImport onImportComplete={onImportComplete} />)
    failContinuation = true
    fireEvent.click(screen.getByRole('button', { name: 'Import from Microsoft' }))
    expect(await screen.findByText(/1 entry could not be read and was not imported; importing from Microsoft again will retry it\./)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Import into 2 calendars' }))
    await waitFor(() => expect(onImportComplete).toHaveBeenCalledWith(2))
    expect(written.copiesOnServer()).not.toContain('microsoft/tenant.sub-1/cal-team/uid-standup')

    failContinuation = false
    fireEvent.click(screen.getByRole('button', { name: 'Import from Microsoft' }))
    expect(await screen.findByText(/2 already imported entries were skipped/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Import (1 events|into \d+ calendars)$/ }))
    await waitFor(() => expect(written.copiesOnServer()).toContain('microsoft/tenant.sub-1/cal-team/uid-standup'))
    expect(written.copiesOnServer()).toHaveLength(3)
  })

  it('a save the server applied but never acknowledged is not written again', async () => {
    onlyPersonal = true
    const written = installCalendarAccount(['applied-then-lost'])
    renderWithIntl(<CalendarImport onImportComplete={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Import from Microsoft' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Import 1 events' }))
    expect(await screen.findByText(/weren't confirmed as saved/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 events' }))
    expect(await screen.findByText('Everything listed was already imported.')).toBeInTheDocument()
    expect(written).toHaveLength(1)
    expect(written.copiesOnServer()).toHaveLength(1)
  })
})
