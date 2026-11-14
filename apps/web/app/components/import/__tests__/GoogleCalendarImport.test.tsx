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
import { mapGoogleCalendarEvents, type GoogleCalendar, type GoogleEvent } from '@/app/lib/google-import/calendar-mapper'
import type { GoogleCalendarImport } from '@/app/lib/google-import/importer'
import { importSourceKeyOf } from '@/app/lib/google-import/source-key'

// Interrupt / retry / re-import fixture (#48). The real CalendarImport, calendar store and
// Etebase bridge run; the account is controlled at its item-manager boundary as in
// CalendarImport.test.tsx. The Google button is replaced by one that delivers a mapped fixture.

const toastMock = vi.hoisted(() => ({ showErrorToast: vi.fn() }))
vi.mock('@/app/stores/use-toast-store', () => toastMock)

const personal: GoogleCalendar = { id: 'me@example.com', summaryOverride: 'Personal', primary: true, timeZone: 'Europe/Berlin' }
const team: GoogleCalendar = { id: 'team@group.calendar.google.com', summary: 'Team', backgroundColor: '#336699' }

const personalEvents: GoogleEvent[] = [
  { id: 'dentist', iCalUID: 'dentist@google.com', summary: 'Dentist', start: { dateTime: '2026-06-03T08:00:00Z' }, end: { dateTime: '2026-06-03T09:00:00Z' } },
]
const teamEvents: GoogleEvent[] = [
  {
    id: 'standup', iCalUID: 'standup@google.com', summary: 'Standup',
    start: { dateTime: '2026-06-01T09:00:00+02:00', timeZone: 'Europe/Berlin' },
    end: { dateTime: '2026-06-01T09:15:00+02:00', timeZone: 'Europe/Berlin' },
    recurrence: ['RRULE:FREQ=WEEKLY;COUNT=10'],
  },
  {
    id: 'standup_1', iCalUID: 'standup@google.com', recurringEventId: 'standup', summary: 'Standup (moved)',
    originalStartTime: { dateTime: '2026-06-08T09:00:00+02:00', timeZone: 'Europe/Berlin' },
    start: { dateTime: '2026-06-08T10:00:00+02:00', timeZone: 'Europe/Berlin' },
    end: { dateTime: '2026-06-08T10:15:00+02:00', timeZone: 'Europe/Berlin' },
  },
  {
    id: 'standup_2', iCalUID: 'standup@google.com', recurringEventId: 'standup', status: 'cancelled',
    originalStartTime: { dateTime: '2026-06-22T09:00:00+02:00', timeZone: 'Europe/Berlin' },
  },
  { id: 'offsite', iCalUID: 'offsite@google.com', summary: 'Offsite', start: { date: '2026-07-01' }, end: { date: '2026-07-03' } },
]

let onlyPersonal = false

/** What a fresh read of the Google account returns: mapped anew each time, with new UIDs. */
function readGoogle(): GoogleCalendarImport {
  return {
    calendars: [
      { id: personal.id, name: 'Personal', units: mapGoogleCalendarEvents(personal.id, personal, personalEvents).units },
      ...(onlyPersonal ? [] : [{ id: team.id, name: 'Team', color: '#336699', units: mapGoogleCalendarEvents(personal.id, team, teamEvents).units }]),
    ],
    unreadable: 0,
  }
}

vi.mock('../GoogleImportButton', () => ({
  default: (props: { onLoaded: (result: GoogleCalendarImport) => void }) => (
    <button type="button" onClick={() => props.onLoaded(readGoogle())}>Import from Google</button>
  ),
}))

/**
 * The real bridge with a controlled account. `server` holds what each collection really has;
 * 'applied-then-lost' stores the batch and then loses the response, as a dropped connection does.
 */
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
    accountFingerprint: 'google-import-fixture',
    collections: { calendar: [collection('cal-work', { name: 'Work' })], tasks: [], contacts: [], notes: [], preferences: [] },
    itemCache: new Map(),
    itemTypeMap: new Map(),
    itemCollectionMap: new Map(),
    syncEngine: null,
  } as any)
  const copiesOnServer = () => [...server.values()].flat().map(({ content }) => importSourceKeyOf(deserializeCalendarEvent(content).unknownProperties))
  return Object.assign(written, { copiesOnServer })
}

describe('Google calendar import: interrupt, retry, re-import', () => {
  beforeEach(() => {
    _setEncryptedQueuePersistenceAvailableForTests(false)
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    useAuthStore.setState({ canWrite: () => true } as any)
    useCalendarStore.setState({ events: [] })
    useCalendarListStore.setState({ calendars: [{ id: 'cal-work', name: 'Work', color: '#123456', visible: true }], defaultCalendarId: 'cal-work' })
    toastMock.showErrorToast.mockReset()
    onlyPersonal = false
  })

  it('writes each series whole, retries only what failed, and a re-import adds nothing', async () => {
    const written = installCalendarAccount(['ok', 'offline-before-apply'])
    const onImportComplete = vi.fn()
    renderWithIntl(<CalendarImport onImportComplete={onImportComplete} />)

    fireEvent.click(screen.getByRole('button', { name: 'Import from Google' }))
    expect(await screen.findByText('3 events found in 2 Google calendars')).toBeInTheDocument()

    // Run 1: Personal is saved, Team (with the series) fails before anything is applied.
    fireEvent.click(screen.getByRole('button', { name: 'Import into 2 calendars' }))
    expect(await screen.findByText(/Imported 1 of 3 events/)).toBeInTheDocument()
    expect(written.map((w) => [w.contents.length, w.outcome])).toEqual([[1, 'ok'], [2, 'offline-before-apply']])
    expect(onImportComplete).not.toHaveBeenCalled()

    // Retry: only Team is sent again, the series still whole.
    fireEvent.click(screen.getByRole('button', { name: 'Import 2 events' }))
    await waitFor(() => expect(onImportComplete).toHaveBeenCalledWith(2))
    expect(written).toHaveLength(3)
    expect(written[2]!.outcome).toBe('ok')
    expect(written[2]!.collectionUid).toBe(written[1]!.collectionUid)
    const series = written[2]!.contents.map((content) => deserializeCalendarEvent(content)).find((event) => event.title === 'Standup')!
    expect(series.recurrenceRule).toBe('FREQ=WEEKLY;COUNT=10')
    expect(series.exceptions.map((d) => d.toISOString())).toEqual(['2026-06-22T07:00:00.000Z'])
    expect(series.overrides).toHaveLength(1)
    expect(series.overrides![0]).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20260608T090000')
    expect(series.overrides![0]).toContain('SUMMARY:Standup (moved)')

    // Every source exactly once in the calendar.
    const keys = useCalendarStore.getState().events.map((event) => importSourceKeyOf(event.unknownProperties))
    expect(keys).toHaveLength(3)
    expect(new Set(keys).size).toBe(3)
    expect(keys.every(Boolean)).toBe(true)

    // Re-import: nothing new, nothing written.
    fireEvent.click(screen.getByRole('button', { name: 'Import from Google' }))
    expect(await screen.findByText(/Nothing new to import from Google\. 3 already imported entries were skipped\./)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Import (into|\d)/ })).toBeNull()
    expect(written).toHaveLength(3)
    expect(useCalendarStore.getState().events).toHaveLength(3)
    expect(written.copiesOnServer()).toHaveLength(3)
  })

  it('a save the server applied but never acknowledged is not written again on retry', async () => {
    onlyPersonal = true
    const written = installCalendarAccount(['applied-then-lost'])
    renderWithIntl(<CalendarImport onImportComplete={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Import from Google' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Import 1 events' }))

    // unsaved=[0], uncertain=true: the event is not shown here, but it is on the server.
    expect(await screen.findByText(/Imported 0 of 1 events\. The other 1 weren't confirmed as saved/)).toBeInTheDocument()
    expect(useCalendarStore.getState().events).toHaveLength(0)
    expect(written.copiesOnServer()).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Import 1 events' }))
    expect(await screen.findByText('Everything listed was already imported.')).toBeInTheDocument()
    expect(written).toHaveLength(1)
    expect(written.copiesOnServer()).toHaveLength(1)

    // A fresh re-import is checked against the server too.
    fireEvent.click(screen.getByRole('button', { name: 'Import from Google' }))
    const retry = screen.queryByRole('button', { name: 'Import 1 events' })
    if (retry) fireEvent.click(retry)
    expect(await screen.findByText('Everything listed was already imported.')).toBeInTheDocument()
    expect(written.copiesOnServer()).toHaveLength(1)
  })

  it('writes nothing when the server cannot be read first', async () => {
    onlyPersonal = true
    const written = installCalendarAccount([])
    const etebase = useEtebaseStore.getState()
    useEtebaseStore.setState({ refreshCollection: async () => { useEtebaseStore.setState({ domainLoadState: { ...useEtebaseStore.getState().domainLoadState, calendar: 'failed' } }); return [] } } as any)
    renderWithIntl(<CalendarImport onImportComplete={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Import from Google' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Import 1 events' }))
    expect(await screen.findByText(/Couldn't check what is already saved, so nothing was imported/)).toBeInTheDocument()
    expect(written).toHaveLength(0)
    useEtebaseStore.setState({ refreshCollection: etebase.refreshCollection } as any)
  })

  it('a retry never re-sends a unit that has meanwhile reached the calendar', async () => {
    const written = installCalendarAccount(['offline-before-apply'])
    renderWithIntl(<CalendarImport onImportComplete={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Import from Google' }))
    await screen.findByText('3 events found in 2 Google calendars')
    fireEvent.click(screen.getByRole('button', { name: 'Import into 2 calendars' }))
    await screen.findByText(/None of the 3 events were saved|Imported 0 of 3 events/)

    // An unconfirmed save that did land, as a later sync would show it.
    const dentistKey = readGoogle().calendars[0]!.units[0]!.sourceKey
    useCalendarStore.setState({ events: [{ ...deserializeCalendarEvent('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:20260603T080000Z\r\nEND:VEVENT\r\nEND:VCALENDAR'), unknownProperties: [`X-SILENTSUITE-IMPORT-SOURCE:${dentistKey}`] }] })

    fireEvent.click(screen.getByRole('button', { name: /^Import (into \d+ calendars|\d+ events)$/ }))
    await waitFor(() => expect(written.length).toBeGreaterThan(1))
    const resent = written.slice(1).flatMap((w) => w.contents.map((content) => deserializeCalendarEvent(content).title))
    expect(resent).not.toContain('Dentist')
    expect(resent.sort()).toEqual(['Offsite', 'Standup'])
  })
})
