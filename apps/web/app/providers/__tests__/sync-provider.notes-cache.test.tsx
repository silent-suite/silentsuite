import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deserializeNote, noteFromEtebaseItem, serializeNote } from '@silentsuite/core'
import { SyncProvider } from '../sync-provider'
import { resetNoteLifecycle, useNoteStore } from '@/app/stores/use-note-store'
import { useNotebookStore } from '@/app/stores/use-notebook-store'
import { useAuthStore } from '@/app/stores/use-auth-store'

// The display cache gets the note rows the note store keeps, not the rows a sync read:
// a sync that read a note before this page saved or deleted it must not write that
// older state back. The SyncProvider and the note store are real; the Etebase store
// is a stand-in that accepts each write, and the display cache is a model of its
// replace-style writes, which the stand-in's refreshCollection also writes, as the
// real one does, with the rows it read.

const NOTEBOOK = 'notebook-1147'
const OTHER_NOTEBOOK = 'notebook-b-1147'
const NOTE = 'note-1147'
const OTHER_NOTE = 'note-b-1147'
const BASE_TITLE = 'Base title 1147'
const SAVED_TITLE = 'Saved title 1147'
const BODY = 'BODY 1147'

type SyncChange = { collectionType: string; collectionUid: string; itemUids: string[]; changeType: string }
type ReadItem = { uid: string; content: string; collectionUid: string; meta: { name: string; mtime: number }; revision: string }
type CacheRecord = { itemUid: string; collectionUid: string; content: string }

const syncStoreMock = vi.hoisted(() => ({
  initializeSync: vi.fn(() => vi.fn()),
  setSyncStatus: vi.fn(),
  setLastSynced: vi.fn(),
  setError: vi.fn(),
  setPartialLoad: vi.fn(),
  replayOfflineQueue: vi.fn(async () => 0),
  simulateSyncCycle: vi.fn(),
}))

const etebaseMock = vi.hoisted(() => {
  const control = { changeHandler: null as null | ((event: SyncChange) => Promise<void>) }
  const state = {
    initialize: vi.fn(),
    fetchAllItems: vi.fn(async (): Promise<unknown[]> => []),
    onSyncChange: vi.fn((handler: (event: SyncChange) => Promise<void>) => {
      control.changeHandler = handler
      return vi.fn()
    }),
    onStatusChange: vi.fn(() => vi.fn()),
    isInitialized: false,
    accountFingerprint: null as string | null,
    account: {},
    itemCache: new Map(),
    refreshCollection: vi.fn(async (_type: string, _collectionUid?: string): Promise<unknown[]> => []),
    // Each write is accepted: a save at the next revision, a delete on the server.
    updateItem: vi.fn(async (_type: string, _id: string, _content: string, options: { onSaved?: (etag: string, replaced?: string | null) => void }) => {
      options.onSaved?.('rev-1', 'rev-0')
      return 'remote'
    }),
    deleteItem: vi.fn(async () => 'remote'),
    domainLoadState: { tasks: 'loaded', contacts: 'loaded', calendar: 'loaded', notes: 'loaded', preferences: 'unknown' },
  }
  return { control, state }
})

const cacheMock = vi.hoisted(() => {
  const records = new Map<string, CacheRecord>()
  const put = (items: CacheRecord[]) => {
    for (const item of items) records.set(item.itemUid, { itemUid: item.itemUid, collectionUid: item.collectionUid, content: item.content })
  }
  return {
    records,
    getItemsByType: vi.fn(async (): Promise<unknown[]> => []),
    replaceItemsForType: vi.fn(async (_type: string, items: CacheRecord[]) => {
      records.clear()
      put(items)
    }),
    replaceItemsForCollection: vi.fn(async (collectionUid: string, items: CacheRecord[]) => {
      for (const [uid, record] of [...records]) if (record.collectionUid === collectionUid) records.delete(uid)
      put(items)
    }),
    isCacheEnabled: vi.fn(() => true),
    getCacheCapabilityStatus: vi.fn(() => ({ featureFlagEnabled: true, encryptedEnvelopeAvailable: true, enabled: true })),
  }
})

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }))
vi.mock('@/app/lib/logger', () => ({ logger: { debug: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/app/lib/data-cache', () => cacheMock)
vi.mock('@/app/lib/sync-timing', () => ({
  logSyncTiming: vi.fn(),
  markSyncTimingStart: vi.fn(() => 100),
  nowMs: vi.fn(() => 100),
  safeTimingErrorCategory: vi.fn(() => 'unknown'),
}))
vi.mock('@/app/stores/use-sync-store', () => ({
  useSyncStore: Object.assign(
    (selector: (state: typeof syncStoreMock) => unknown) => selector(syncStoreMock),
    { getState: () => syncStoreMock },
  ),
}))
vi.mock('@/app/stores/use-etebase-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/app/stores/use-etebase-store')>(),
  useEtebaseStore: Object.assign(
    (selector: (state: typeof etebaseMock.state) => unknown) => selector(etebaseMock.state),
    { getState: () => etebaseMock.state, setState: vi.fn() },
  ),
  keepPendingCacheRecords: vi.fn(async (_type: string, records: unknown[]) => records),
}))
vi.mock('@/app/stores/use-contact-store', () => ({ useContactStore: { getState: () => ({ syncFromRemote: vi.fn() }) } }))
vi.mock('@/app/stores/use-task-store', () => ({ useTaskStore: { getState: () => ({ syncFromRemote: vi.fn() }) } }))
vi.mock('@/app/stores/use-calendar-store', () => ({ useCalendarStore: { getState: () => ({ syncFromRemote: vi.fn() }) } }))
vi.mock('@/app/stores/use-label-suggestions-store', () => ({
  useLabelSuggestionsStore: {
    getState: () => ({ initialize: vi.fn(async () => {}), seedFromVisibleItems: vi.fn(), refreshFromRemote: vi.fn(async () => {}), recordUsage: vi.fn() }),
  },
}))
vi.mock('@/app/stores/use-preferences-sync-store', () => ({
  usePreferencesSyncStore: {
    getState: () => ({
      operationGeneration: 7,
      beginRemoteRead: vi.fn(() => 11),
      initialize: vi.fn(async () => {}),
      loadFromRemote: vi.fn(async () => {}),
      recordRemoteReadFailure: vi.fn(),
      destroy: vi.fn(),
    }),
  },
}))

/** A note as a read hands it over. */
function readItem(uid: string, collectionUid: string, title: string, revision: string): ReadItem {
  return { uid, content: BODY, collectionUid, meta: { name: title, mtime: 1 }, revision }
}

/** The note as a read at revision 0 hands it over. */
const readAtR0 = readItem(NOTE, NOTEBOOK, BASE_TITLE, 'rev-0')

/** What the server lists now; refreshCollection reads it and the item cache then holds it. */
let listed: ReadItem[] = []

/** Title of each note in the display cache. */
function cachedTitles(): Record<string, string> {
  return Object.fromEntries([...cacheMock.records.values()].map((record) => [record.itemUid, deserializeNote(record.content, record.itemUid, record.collectionUid).title]))
}

async function saveNewTitle() {
  const base = { title: BASE_TITLE, content: BODY, revision: 'rev-0' }
  expect(await useNoteStore.getState().updateNote(NOTE, { title: SAVED_TITLE }, { base })).toBe(true)
  expect(useNoteStore.getState().notes.find((note) => note.id === NOTE)).toMatchObject({ title: SAVED_TITLE, revision: 'rev-1' })
}

function notesChanged(collectionUid = NOTEBOOK) {
  return etebaseMock.control.changeHandler!({ collectionType: 'etebase.md.note', collectionUid, itemUids: [], changeType: 'update' })
}

describe('SyncProvider writes the note rows the note store keeps to the display cache', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetNoteLifecycle()
    cacheMock.records.clear()
    listed = [readAtR0]
    etebaseMock.control.changeHandler = null
    etebaseMock.state.initialize.mockImplementation(async (options?: { onDomainLoaded?: (event: unknown) => Promise<void> }) => {
      await options?.onDomainLoaded?.({ type: 'notes', status: 'loaded', itemCount: 1, pageCount: 1, collectionCount: 1 })
    })
    etebaseMock.state.fetchAllItems.mockImplementation(async () => [...listed])
    // As the real one: the notebook's rows it read go to the display cache.
    etebaseMock.state.refreshCollection.mockImplementation(async (_type: string, collectionUid?: string) => {
      const rows = listed.filter((item) => item.collectionUid === collectionUid)
      await cacheMock.replaceItemsForCollection(collectionUid!, rows.map((item) => ({
        itemUid: item.uid,
        collectionUid: item.collectionUid,
        content: serializeNote(noteFromEtebaseItem(item.uid, item.content, item.meta, item.collectionUid)),
      })))
      return []
    })
    useAuthStore.setState({ canWrite: () => true } as any)
    useNotebookStore.setState({
      lists: [
        { id: NOTEBOOK, name: 'Notebook 1147', color: '#fff', visible: true, accessLevel: 2 },
        { id: OTHER_NOTEBOOK, name: 'Notebook B 1147', color: '#fff', visible: true, accessLevel: 2 },
      ],
    } as any)
    const at = new Date(1000)
    useNoteStore.setState({ notes: [{ id: NOTE, uid: NOTE, title: BASE_TITLE, content: BODY, notebookId: NOTEBOOK, created_at: at, updated_at: at, revision: 'rev-0' }] })
  })

  it('writes the saved title after a save that landed while the first load read the note', async () => {
    etebaseMock.state.fetchAllItems.mockImplementation(async () => {
      // The load has read the note at revision 0; this page's save lands before the rows are delivered.
      await saveNewTitle()
      return [readAtR0]
    })

    render(<SyncProvider><div>child</div></SyncProvider>)
    await waitFor(() => expect(syncStoreMock.setLastSynced).toHaveBeenCalled())

    expect(useNoteStore.getState().notes).toMatchObject([{ title: SAVED_TITLE, revision: 'rev-1' }])
    expect(cachedTitles()).toEqual({ [NOTE]: SAVED_TITLE })
  })

  it('writes the saved title after a collection event whose refresh read the note before the save', async () => {
    render(<SyncProvider><div>child</div></SyncProvider>)
    await waitFor(() => expect(etebaseMock.control.changeHandler).not.toBeNull())
    expect(cachedTitles()).toEqual({ [NOTE]: BASE_TITLE })
    await saveNewTitle()

    await notesChanged()

    expect(etebaseMock.state.refreshCollection).toHaveBeenCalledWith('notes', NOTEBOOK)
    expect(useNoteStore.getState().notes).toMatchObject([{ title: SAVED_TITLE, revision: 'rev-1' }])
    expect(cachedTitles()).toEqual({ [NOTE]: SAVED_TITLE })
  })

  it('leaves a note this page deleted out after a collection event whose refresh read it before the delete', async () => {
    render(<SyncProvider><div>child</div></SyncProvider>)
    await waitFor(() => expect(etebaseMock.control.changeHandler).not.toBeNull())
    expect(cachedTitles()).toEqual({ [NOTE]: BASE_TITLE })
    expect(await useNoteStore.getState().deleteNote(NOTE)).toBe(true)

    await notesChanged()

    expect(useNoteStore.getState().notes).toEqual([])
    expect(cachedTitles()).toEqual({})
  })

  it('leaves another notebook as its own refresh wrote it when an event read it before that refresh', async () => {
    listed = [readAtR0, readItem(OTHER_NOTE, OTHER_NOTEBOOK, 'Other old 1147', 'rev-b0')]
    render(<SyncProvider><div>child</div></SyncProvider>)
    await waitFor(() => expect(etebaseMock.control.changeHandler).not.toBeNull())
    expect(cachedTitles()).toEqual({ [NOTE]: BASE_TITLE, [OTHER_NOTE]: 'Other old 1147' })
    // The first event reads every cached note, then waits.
    let reached = () => {}
    const read = new Promise<void>((resolve) => { reached = resolve })
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    etebaseMock.state.fetchAllItems.mockImplementationOnce(async () => {
      const snapshot = [...listed]
      reached()
      await gate
      return snapshot
    })
    const first = notesChanged(NOTEBOOK)
    await read

    // Another device changed the other notebook; its event runs to the end meanwhile.
    listed = [readAtR0, readItem(OTHER_NOTE, OTHER_NOTEBOOK, 'Other new 1147', 'rev-b1')]
    await notesChanged(OTHER_NOTEBOOK)
    expect(cachedTitles()).toEqual({ [NOTE]: BASE_TITLE, [OTHER_NOTE]: 'Other new 1147' })
    release()
    await first

    expect(cachedTitles()).toEqual({ [NOTE]: BASE_TITLE, [OTHER_NOTE]: 'Other new 1147' })
  })
})
