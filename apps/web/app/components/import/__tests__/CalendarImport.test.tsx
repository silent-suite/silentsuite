import { describe, it, expect, afterEach, beforeEach, onTestFinished, vi } from 'vitest'
import { getAccountEpoch } from '@/app/lib/account-epoch'
import { useBirthdayMarkerStore } from '@/app/lib/birthday-calendar/markers'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import CalendarImport from '../CalendarImport'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import { useCalendarStore } from '@/app/stores/use-calendar-store'
import { useCalendarListStore } from '@/app/stores/use-calendar-list-store'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { _setEncryptedQueuePersistenceAvailableForTests } from '@/app/lib/offline-queue'

// C3a-R7/R8 (PLAN U1, U2, U4, U5). The real calendar, calendar-list and bridge stores run here.
// The pinned SDK cannot load in jsdom, so the account is controlled at its collection and item
// manager boundary: calendar uploads and item batches succeed or fail as each case plans. The
// SDK-level batch outcomes are proven in the store and integration tests, not here.

const toastMock = vi.hoisted(() => ({ showErrorToast: vi.fn() }))
vi.mock('@/app/stores/use-toast-store', () => toastMock)

const onImportComplete = vi.fn()
const caveat = /may already be saved/i

const ics = (name: string, summaries: string[]) => new File([[
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  `X-WR-CALNAME:${name}`,
  ...summaries.flatMap((summary, index) => [
    'BEGIN:VEVENT',
    `UID:${name.toLowerCase()}-${index}`,
    `SUMMARY:${summary}`,
    'DTSTART:20260601T090000Z',
    'DTEND:20260601T100000Z',
    'END:VEVENT',
  ]),
  'END:VCALENDAR',
].join('\r\n')], `${name.toLowerCase()}.ics`, { type: 'text/calendar' })

/**
 * The real bridge with a controlled account. `uploads` and `batches` are consumed in call
 * order (default 'ok'); an offline batch fails before anything is applied. `holdBatches`
 * keeps each batch pending, after it is recorded, until that promise settles.
 */
function installCalendarAccount(options: {
  existing: { uid: string; name: string }[]
  uploads?: ('ok' | 'fail')[]
  batches?: ('ok' | 'offline-before-apply')[]
  holdBatches?: Promise<void>
}) {
  const uploads = [...(options.uploads ?? [])]
  const batchPlan = [...(options.batches ?? [])]
  const created: { uid: string; name: string }[] = []
  const batchCalls: { collectionUid: string; summaries: string[]; outcome: string }[] = []
  let collectionSequence = 0
  let itemSequence = 0
  const collection = (uid: string, meta: { name: string; color?: string }) => ({ uid, getMeta: () => meta })
  const account = {
    getCollectionManager: () => ({
      create: async (_type: string, meta: { name: string; color?: string }) => collection(`created-${++collectionSequence}`, meta),
      upload: async (target: { uid: string; getMeta: () => { name: string } }) => {
        if ((uploads.shift() ?? 'ok') === 'fail') throw new Error('Server refused the calendar')
        created.push({ uid: target.uid, name: target.getMeta().name })
      },
      getItemManager: (target: { uid: string }) => ({
        create: async (_meta: unknown, content: string) => ({ uid: `event-item-${++itemSequence}`, content }),
        batch: async (items: { content: string }[]) => {
          const outcome = batchPlan.shift() ?? 'ok'
          batchCalls.push({
            collectionUid: target.uid,
            summaries: items.map(({ content }) => /SUMMARY:(.*)/.exec(content)?.[1]?.trim() ?? ''),
            outcome,
          })
          await options.holdBatches
          if (outcome === 'offline-before-apply') throw new TypeError('Failed to fetch')
        },
      }),
    }),
  }
  useEtebaseStore.setState({
    account,
    accountFingerprint: 'c3a-calendar-import',
    collections: { calendar: options.existing.map(({ uid, name }) => collection(uid, { name })), tasks: [], contacts: [], notes: [], preferences: [] },
    itemCache: new Map(),
    itemTypeMap: new Map(),
    itemCollectionMap: new Map(),
    syncEngine: null,
  } as any)
  return { created, batchCalls }
}

async function dropFiles(files: File[]) {
  const view = renderWithIntl(<CalendarImport onImportComplete={onImportComplete} />)
  fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files } })
  return view
}

const importButton = () => screen.getByRole('button', { name: /^Import (into \d+ calendars|\d+ events)$/ })

describe('C3a CalendarImport reports only acknowledged events and retries only the rest', () => {
  beforeEach(() => {
    // Production queue configuration: plaintext create content is refused.
    _setEncryptedQueuePersistenceAvailableForTests(false)
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    useAuthStore.setState({ canWrite: () => true } as any)
    useCalendarStore.setState({ events: [] })
    useCalendarListStore.setState({ calendars: [{ id: 'cal-work', name: 'Work', color: '#123456', visible: true }], defaultCalendarId: 'cal-work' })
    toastMock.showErrorToast.mockReset()
    onImportComplete.mockReset()
  })

  describe('#738 never imports into a managed Birthdays calendar', () => {
    const markManaged = (uids: string[]) => useBirthdayMarkerStore.setState({
      snapshot: { epoch: getAccountEpoch(), fingerprint: 'c3a-calendar-import', activeIds: uids },
    })
    afterEach(() => useBirthdayMarkerStore.setState({ snapshot: null }))

    it('does not offer or default to the managed calendar; the ordinary calendar receives the import', async () => {
      useCalendarListStore.setState({
        calendars: [
          { id: 'bday-1', name: 'Birthdays', color: '#f59e0b', visible: true },
          { id: 'cal-work', name: 'Work', color: '#123456', visible: true },
        ],
        defaultCalendarId: 'bday-1',
      })
      const account = installCalendarAccount({ existing: [{ uid: 'bday-1', name: 'Birthdays' }, { uid: 'cal-work', name: 'Work' }] })
      markManaged(['bday-1'])
      await dropFiles([ics('Work', ['Event one', 'Event two'])])

      expect(screen.queryByText('Birthdays')).toBeNull()
      fireEvent.click(await screen.findByRole('button', { name: 'Import 2 events' }))
      await waitFor(() => expect(onImportComplete).toHaveBeenCalledWith(2))
      expect(account.batchCalls).toEqual([{ collectionUid: 'cal-work', summaries: ['Event one', 'Event two'], outcome: 'ok' }])
    })

    it('with only a managed calendar, offers none, keeps “Create new”, and writes nothing into it', async () => {
      useCalendarListStore.setState({ calendars: [{ id: 'bday-1', name: 'Birthdays', color: '#f59e0b', visible: true }], defaultCalendarId: 'bday-1' })
      const account = installCalendarAccount({ existing: [{ uid: 'bday-1', name: 'Birthdays' }] })
      markManaged(['bday-1'])
      await dropFiles([ics('Work', ['Event one'])])

      expect(screen.queryByText('Birthdays')).toBeNull()
      expect(screen.getByText('Create new')).toBeInTheDocument()
      const importNow = screen.queryByRole('button', { name: 'Import 1 events' }) ?? screen.queryByRole('button', { name: 'Import 1 event' })
      if (importNow && !(importNow as HTMLButtonElement).disabled) fireEvent.click(importNow)
      await act(async () => {})
      expect(account.batchCalls).toEqual([])
      expect(useCalendarStore.getState().events.filter((event) => event.calendarId === 'bday-1')).toEqual([])
    })
  })

  it('C3a-R7 control: a single-calendar import into an existing calendar reports its true count', async () => {
    const account = installCalendarAccount({ existing: [{ uid: 'cal-work', name: 'Work' }] })
    await dropFiles([ics('Work', ['Event one', 'Event two'])])
    fireEvent.click(await screen.findByRole('button', { name: 'Import 2 events' }))

    await waitFor(() => expect(onImportComplete).toHaveBeenCalledWith(2))
    expect(screen.getByText('2 events imported')).toBeInTheDocument()
    expect(account.batchCalls).toEqual([{ collectionUid: 'cal-work', summaries: ['Event one', 'Event two'], outcome: 'ok' }])
    expect(useCalendarStore.getState().events.map((event) => event.title)).toEqual(['Event one', 'Event two'])
  })

  it('C3a-R7 events: a missing destination calendar reports no confirmed events and keeps every event for retry', async () => {
    // The chosen calendar is listed, but the account holds no such collection.
    const account = installCalendarAccount({ existing: [] })
    await dropFiles([ics('Work', ['Event one', 'Event two'])])
    fireEvent.click(await screen.findByRole('button', { name: 'Import 2 events' }))

    const message = await screen.findByText(/Imported 0 of 2 events/)
    expect(message.textContent).toMatch(caveat)
    expect(screen.queryByText(/events imported/)).toBeNull()
    expect(onImportComplete).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Import 2 events' })).toBeInTheDocument()
    expect(screen.getByText('Event one')).toBeInTheDocument()
    expect(screen.getByText('Event two')).toBeInTheDocument()
    expect(account.batchCalls).toEqual([])
    expect(useCalendarStore.getState().events).toEqual([])
  })

  it('C3a-R7 events: a file chosen while an import is pending is refused, so the failed import keeps its own file, preview and retry', async () => {
    let releaseBatch!: () => void
    const account = installCalendarAccount({
      existing: [{ uid: 'cal-work', name: 'Work' }],
      batches: ['offline-before-apply'],
      holdBatches: new Promise<void>((resolve) => { releaseBatch = resolve }),
    })
    // Never leave the held batch pending, even when an assertion fails first.
    onTestFinished(() => releaseBatch())
    const view = await dropFiles([ics('Work', ['Event one', 'Event two'])])
    const input = view.container.querySelector('input[type="file"]')!
    fireEvent.click(await screen.findByRole('button', { name: 'Import 2 events' }))
    await waitFor(() => expect(account.batchCalls).toHaveLength(1))

    // Another file while the first import is still pending, given time to be read if it were accepted.
    fireEvent.change(input, { target: { files: [ics('Other', ['Other event'])] } })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
    expect(screen.queryByText('other.ics')).toBeNull()
    expect(screen.getByText('work.ics')).toBeInTheDocument()
    expect(screen.queryByText('Other event')).toBeNull()
    expect(screen.getByText('Event one')).toBeInTheDocument()

    await act(async () => { releaseBatch() })
    await screen.findByText(/Imported 0 of 2 events/)
    expect(screen.getByText('work.ics')).toBeInTheDocument()
    expect(screen.queryByText('Other event')).toBeNull()
    expect(screen.getByText('Event one')).toBeInTheDocument()
    expect(screen.getByText('Event two')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Import 2 events' }))
    await waitFor(() => expect(onImportComplete).toHaveBeenCalledWith(2))
    expect(account.batchCalls.map(({ summaries, outcome }) => [summaries, outcome])).toEqual([
      [['Event one', 'Event two'], 'offline-before-apply'],
      [['Event one', 'Event two'], 'ok'],
    ])
  })

  it('C3a-R7 events control: after an import settles, choosing another file still replaces the file, preview and retry', async () => {
    const account = installCalendarAccount({ existing: [{ uid: 'cal-work', name: 'Work' }], batches: ['offline-before-apply'] })
    const view = await dropFiles([ics('Work', ['Event one', 'Event two'])])
    const input = view.container.querySelector('input[type="file"]')!
    fireEvent.click(await screen.findByRole('button', { name: 'Import 2 events' }))
    await screen.findByText(/Imported 0 of 2 events/)

    fireEvent.change(input, { target: { files: [ics('Other', ['Other event'])] } })
    await screen.findByText('Other event')
    expect(screen.queryByText('Event one')).toBeNull()
    expect(screen.queryByText(/Imported 0 of 2 events/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 events' }))

    await waitFor(() => expect(onImportComplete).toHaveBeenCalledWith(1))
    expect(screen.getByText('other.ics')).toBeInTheDocument()
    expect(account.batchCalls.map(({ summaries, outcome }) => [summaries, outcome])).toEqual([
      [['Event one', 'Event two'], 'offline-before-apply'],
      [['Other event'], 'ok'],
    ])
  })

  it('C3a-R8 events: when the second calendar cannot be created, only that file is kept and a lone retry creates only its calendar', async () => {
    const account = installCalendarAccount({ existing: [{ uid: 'cal-work', name: 'Work' }], uploads: ['ok', 'fail'] })
    await dropFiles([ics('Alpha', ['Alpha one', 'Alpha two']), ics('Beta', ['Beta one'])])
    fireEvent.click(await screen.findByRole('button', { name: 'Import into 2 calendars' }))

    // Alpha's calendar and events were acknowledged; Beta's events were never sent.
    const message = await screen.findByText(/Imported 2 of 3 events/)
    expect(message.textContent).not.toMatch(caveat)
    expect(onImportComplete).not.toHaveBeenCalled()
    expect(screen.queryByText(/events imported/)).toBeNull()
    expect(account.created.map(({ name }) => name)).toEqual(['Alpha'])
    expect(account.batchCalls.map(({ summaries }) => summaries)).toEqual([['Alpha one', 'Alpha two']])
    expect(useCalendarStore.getState().events.map((event) => event.title)).toEqual(['Alpha one', 'Alpha two'])

    // Only Beta stays for retry.
    expect(screen.queryByText('Alpha one')).toBeNull()
    expect(screen.getByText('Beta one')).toBeInTheDocument()

    fireEvent.click(importButton())
    await waitFor(() => expect(onImportComplete).toHaveBeenCalledWith(1))
    expect(screen.getByText('1 events imported')).toBeInTheDocument()

    // The retry creates Beta's own calendar once; Alpha's calendar and events are not created or sent again.
    expect(account.created.map(({ name }) => name)).toEqual(['Alpha', 'Beta'])
    const beta = account.created.find(({ name }) => name === 'Beta')!
    expect(account.batchCalls.slice(1)).toEqual([{ collectionUid: beta.uid, summaries: ['Beta one'], outcome: 'ok' }])
    expect(useCalendarStore.getState().events.map((event) => event.title)).toEqual(['Alpha one', 'Alpha two', 'Beta one'])
  })

  it('C3a-R8 events: when the first file\'s events are unconfirmed, retry reuses its created calendar and then imports the second file', async () => {
    const account = installCalendarAccount({ existing: [{ uid: 'cal-work', name: 'Work' }], batches: ['offline-before-apply'] })
    await dropFiles([ics('Alpha', ['Alpha one', 'Alpha two']), ics('Beta', ['Beta one'])])
    fireEvent.click(await screen.findByRole('button', { name: 'Import into 2 calendars' }))

    const message = await screen.findByText(/Imported 0 of 3 events/)
    expect(message.textContent).toMatch(caveat)
    expect(onImportComplete).not.toHaveBeenCalled()
    expect(account.created.map(({ name }) => name)).toEqual(['Alpha'])
    expect(useCalendarStore.getState().events).toEqual([])

    // Both files stay, still one calendar per file.
    expect(screen.getByRole('button', { name: 'Import into 2 calendars' })).toBeInTheDocument()
    expect(screen.getByText('alpha.ics -> 2 events')).toBeInTheDocument()
    expect(screen.getByText('beta.ics -> 1 event')).toBeInTheDocument()

    fireEvent.click(importButton())
    await waitFor(() => expect(onImportComplete).toHaveBeenCalledWith(3))
    expect(screen.getByText('3 events imported')).toBeInTheDocument()

    // Alpha's calendar is reused rather than created again; Beta gets its own.
    expect(account.created.map(({ name }) => name)).toEqual(['Alpha', 'Beta'])
    const [alpha, beta] = account.created
    expect(account.batchCalls).toEqual([
      { collectionUid: alpha!.uid, summaries: ['Alpha one', 'Alpha two'], outcome: 'offline-before-apply' },
      { collectionUid: alpha!.uid, summaries: ['Alpha one', 'Alpha two'], outcome: 'ok' },
      { collectionUid: beta!.uid, summaries: ['Beta one'], outcome: 'ok' },
    ])
  })
})
