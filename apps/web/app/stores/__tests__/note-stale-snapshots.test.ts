// @vitest-environment node
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetForTests as resetOfflineQueue, getAll } from '@/app/lib/offline-queue'
import { _resetForTests as resetDataCache } from '@/app/lib/data-cache'
import { bumpAccountEpoch } from '@/app/lib/account-epoch'

const toastMock = vi.hoisted(() => ({ showErrorToast: vi.fn() }))
vi.mock('@/app/stores/use-toast-store', () => toastMock)
vi.mock('@/app/stores/use-label-suggestions-store', () => ({
  useLabelSuggestionsStore: { getState: () => ({ recordUsage: vi.fn() }) },
}))

import { useEtebaseStore } from '../use-etebase-store'
import { readNewerNoteVersion, registerNoteEditor, resetNoteLifecycle, useNoteStore, type StoredNote } from '../use-note-store'
import { useNotebookStore } from '../use-notebook-store'
import { useAuthStore } from '../use-auth-store'
import {
  EtebaseRequest,
  ReferenceServer,
  deleteDatabase,
  installNoteAccount,
  makeSavedNote,
  queueGuard,
} from './web744-sdk-fixture'

vi.setConfig({ testTimeout: 20_000 })

const BASE_TITLE = 'Base title 1147'
const BASE_BODY = 'BASE BODY R0 1147'
const SAVED_TITLE = 'Saved title 1147'
const OTHER_TITLE = 'Other device title 1147'
const LATEST_TITLE = 'Latest title 1147'

/**
 * A sync hands the note store every note it read. A row it read before one of this
 * page's own accepted writes of the note landed must not undo that write.
 */
describe('the note store and sync rows read before its own accepted writes', () => {
  const originalRequest = EtebaseRequest.default
  let server: ReferenceServer

  beforeEach(async () => {
    await resetOfflineQueue()
    await resetDataCache()
    await deleteDatabase('silentsuite-offline-queue')
    await deleteDatabase('silentsuite-data-cache')
    resetNoteLifecycle()
    server = new ReferenceServer()
    EtebaseRequest.default = (url: string, options: unknown) => server.handle(url, options)
    useAuthStore.setState({ canWrite: () => true } as any)
  })

  afterEach(() => {
    EtebaseRequest.default = originalRequest
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    useNoteStore.setState({ notes: [] })
  })

  function storedNote(uid: string): any {
    return useNoteStore.getState().notes.find((note) => note.id === uid)
  }

  /** The note's row as a sync that read it at the item's revision hands it over. */
  function rowOf(collection: any, item: any, title = BASE_TITLE): StoredNote {
    const at = new Date(1000)
    return { id: item.uid, uid: item.uid, title, content: BASE_BODY, notebookId: collection.uid, created_at: at, updated_at: at, revision: item.etag }
  }

  /** A saved note at R0 on the server and in this page. */
  async function showSavedNote() {
    const { account, collection, item } = await makeSavedNote(BASE_TITLE, BASE_BODY)
    server.seed(collection, [item])
    installNoteAccount(account, collection, item)
    useNotebookStore.setState({ lists: [{ id: collection.uid, name: 'Notebook 1147', color: '#fff', visible: true, accessLevel: 2 }] } as any)
    useNoteStore.setState({ notes: [rowOf(collection, item)] })
    return { account, collection, item }
  }

  /** A saved note with a new title saved over its R0, as the editor saves. */
  async function saveOverR0() {
    const { account, collection, item } = await showSavedNote()
    const base = { title: BASE_TITLE, content: BASE_BODY, revision: item.etag }
    expect(await useNoteStore.getState().updateNote(item.uid, { title: SAVED_TITLE }, { base })).toBe(true)
    expect(storedNote(item.uid)).toMatchObject({ title: SAVED_TITLE })
    return { account, collection, item }
  }

  it('keeps its saved row over a row from the display cache, which has no revision', async () => {
    const { collection, item } = await saveOverR0()
    const saved = storedNote(item.uid)
    expect(saved.revision).not.toBe(item.etag)

    useNoteStore.getState().syncFromRemote([{ ...rowOf(collection, item), revision: null }])

    expect(storedNote(item.uid)).toBe(saved)
  })

  it('keeps a note it deleted out of a sync that read the note before the delete', async () => {
    const { account, collection, item } = await showSavedNote()
    expect(await useNoteStore.getState().deleteNote(item.uid)).toBe(true)
    const tombstone = await account.getCollectionManager().getItemManager(collection).fetch(item.uid)
    expect([storedNote(item.uid), tombstone.isDeleted]).toEqual([undefined, true])

    useNoteStore.getState().syncFromRemote([rowOf(collection, item)])

    expect(storedNote(item.uid)).toBeUndefined()
  })

  it('keeps a note it deleted out of a display-cache row read before the delete', async () => {
    const { account, collection, item } = await showSavedNote()
    expect(await useNoteStore.getState().deleteNote(item.uid)).toBe(true)
    const tombstone = await account.getCollectionManager().getItemManager(collection).fetch(item.uid)
    expect([storedNote(item.uid), tombstone.isDeleted]).toEqual([undefined, true])

    useNoteStore.getState().syncFromRemote([{ ...rowOf(collection, item), revision: null }])

    expect(storedNote(item.uid)).toBeUndefined()
  })

  it('lists a note again when its delete was only queued offline, as the server still holds it', async () => {
    const { collection, item } = await showSavedNote()
    server.offline = true
    expect(await useNoteStore.getState().deleteNote(item.uid)).toBe(true)
    expect([storedNote(item.uid), (await getAll(queueGuard())).map((entry: any) => entry.type)]).toEqual([undefined, ['delete']])

    useNoteStore.getState().syncFromRemote([rowOf(collection, item)])

    expect(storedNote(item.uid)).toMatchObject({ revision: item.etag })
  })

  it('keeps the 64 most recent revisions its saves moved past, oldest dropped first', async () => {
    const { collection, item } = await showSavedNote()
    const revisions: string[] = [item.etag]
    let title = BASE_TITLE
    for (let save = 1; save <= 65; save++) {
      let savedAt = ''
      const base = { title, content: BASE_BODY, revision: revisions[save - 1]! }
      title = `Save ${save} 1147`
      expect(await useNoteStore.getState().updateNote(item.uid, { title }, { base, onSaved: (etag) => { savedAt = etag } })).toBe(true)
      revisions.push(savedAt)
    }
    const latest = storedNote(item.uid)
    expect(latest).toMatchObject({ title: 'Save 65 1147', revision: revisions[65] })
    const rowAt = (revision: string): StoredNote => ({ ...rowOf(collection, item), revision })

    // 65 revisions were moved past: the newest 64 are kept, the first one is not.
    useNoteStore.getState().syncFromRemote([rowAt(revisions[64]!)])
    useNoteStore.getState().syncFromRemote([rowAt(revisions[1]!)])
    expect(storedNote(item.uid)).toBe(latest)
    useNoteStore.getState().syncFromRemote([rowAt(revisions[0]!)])

    expect(storedNote(item.uid)).toMatchObject({ title: BASE_TITLE, revision: revisions[0] })
  })

  it('takes a row at a revision its save moved past again once the account state is reset', async () => {
    const { collection, item } = await saveOverR0()
    useNoteStore.getState().syncFromRemote([rowOf(collection, item)])
    expect(storedNote(item.uid).title).toBe(SAVED_TITLE)

    resetNoteLifecycle()
    useNoteStore.getState().syncFromRemote([rowOf(collection, item)])

    expect(storedNote(item.uid)).toMatchObject({ title: BASE_TITLE, revision: item.etag })
  })

  it('takes a row at a revision its save moved past in the next account', async () => {
    const { collection, item } = await saveOverR0()
    useNoteStore.getState().syncFromRemote([rowOf(collection, item)])
    expect(storedNote(item.uid).title).toBe(SAVED_TITLE)

    bumpAccountEpoch()
    useNoteStore.getState().syncFromRemote([rowOf(collection, item)])

    expect(storedNote(item.uid)).toMatchObject({ title: BASE_TITLE, revision: item.etag })
  })

  /** Another device saves a new title over the note's server copy; returns that revision. */
  async function anotherDeviceSaves(account: any, collection: any, uid: string): Promise<string> {
    const manager = account.getCollectionManager().getItemManager(collection)
    const other = (await manager.fetch(uid))._clone()
    await other.setMeta({ ...other.getMeta(), name: OTHER_TITLE })
    await manager.transaction([other])
    return other.etag
  }

  /** Show newer version on an open editor that holds unsaved text, which is then typed back. */
  async function showNewerVersion(uid: string) {
    const base = { title: SAVED_TITLE, content: BASE_BODY, revision: storedNote(uid).revision }
    const unregister = registerNoteEditor(uid, { periodGen: () => 0, isClean: () => false, chainIdle: () => true, base: () => base, flushAndWait: async () => {} })
    const read = await readNewerNoteVersion(uid)
    unregister()
    return read
  }

  it('keeps its save over a row at its earlier save once it saved over another device\'s version', async () => {
    const { account, collection, item } = await saveOverR0()
    const earlier = storedNote(item.uid).revision
    const other = await anotherDeviceSaves(account, collection, item.uid)
    expect(await showNewerVersion(item.uid)).toMatchObject({ kind: 'note', revision: other })
    expect(storedNote(item.uid)).toMatchObject({ title: OTHER_TITLE, revision: other })
    const base = { title: OTHER_TITLE, content: BASE_BODY, revision: other }
    expect(await useNoteStore.getState().updateNote(item.uid, { title: LATEST_TITLE }, { base })).toBe(true)
    const latest = storedNote(item.uid)
    expect(latest).toMatchObject({ title: LATEST_TITLE })

    // A sync that read the note at this page's earlier save is delivered now.
    useNoteStore.getState().syncFromRemote([{ ...rowOf(collection, item, SAVED_TITLE), revision: earlier }])

    expect(storedNote(item.uid)).toBe(latest)
  })

  it('keeps a note it deleted out of a row at its earlier save once it deleted another device\'s version', async () => {
    const { account, collection, item } = await saveOverR0()
    const earlier = storedNote(item.uid).revision
    const other = await anotherDeviceSaves(account, collection, item.uid)
    expect(await showNewerVersion(item.uid)).toMatchObject({ kind: 'note', revision: other })
    expect(await useNoteStore.getState().deleteNote(item.uid)).toBe(true)
    const tombstone = await account.getCollectionManager().getItemManager(collection).fetch(item.uid)
    expect([storedNote(item.uid), tombstone.isDeleted]).toEqual([undefined, true])

    useNoteStore.getState().syncFromRemote([{ ...rowOf(collection, item, SAVED_TITLE), revision: earlier }])

    expect(storedNote(item.uid)).toBeUndefined()
  })

  it.each([
    ['its own save', saveOverR0, SAVED_TITLE],
    ['an earlier sync', showSavedNote, BASE_TITLE],
  ] as const)('keeps the version Show newer version read over a row at %s read before that version', async (_label, open, title) => {
    const { account, collection, item } = await open()
    const earlier = storedNote(item.uid).revision
    const other = await anotherDeviceSaves(account, collection, item.uid)
    expect(await showNewerVersion(item.uid)).toMatchObject({ kind: 'note', revision: other })
    const newer = storedNote(item.uid)
    expect(newer).toMatchObject({ title: OTHER_TITLE, revision: other })

    // A sync that read the note before the other device saved is delivered now.
    useNoteStore.getState().syncFromRemote([{ ...rowOf(collection, item, title), revision: earlier }])

    expect(storedNote(item.uid)).toBe(newer)
  })

  it.each([
    ['its first save', showSavedNote, BASE_TITLE],
    ['a save after an accepted one', saveOverR0, SAVED_TITLE],
  ] as const)('keeps the record of %s that is running over a display-cache row, then its accepted row', async (_label, open, title) => {
    const { collection, item } = await open()
    const base = { title, content: BASE_BODY, revision: storedNote(item.uid).revision }
    let savedAt = ''
    const saving = useNoteStore.getState().updateNote(item.uid, { title: LATEST_TITLE }, { base, onSaved: (etag) => { savedAt = etag } })
    const running = storedNote(item.uid)
    expect(running).toMatchObject({ title: LATEST_TITLE, revision: null })

    useNoteStore.getState().syncFromRemote([{ ...rowOf(collection, item), revision: null }])
    expect(storedNote(item.uid)).toBe(running)

    expect(await saving).toBe(true)
    expect(storedNote(item.uid)).toMatchObject({ title: LATEST_TITLE, revision: savedAt })
  })

  it('hands back, for the display cache, its saved row in place of a row read before the save', async () => {
    const { collection, item } = await saveOverR0()
    const saved = storedNote(item.uid)
    const unrelated: StoredNote = { ...rowOf(collection, item, 'Unrelated 1147'), id: 'unrelated-1147', uid: 'unrelated-1147' }

    expect(useNoteStore.getState().syncFromRemote([rowOf(collection, item), unrelated])).toEqual([saved, unrelated])
  })

  it('hands back the row a running save started from, not the text that save may still lose', async () => {
    const { collection, item } = await saveOverR0()
    const saved = storedNote(item.uid)
    const saving = useNoteStore.getState().updateNote(item.uid, { title: LATEST_TITLE }, { base: { title: SAVED_TITLE, content: BASE_BODY, revision: saved.revision } })
    const running = storedNote(item.uid)
    expect(running).toMatchObject({ title: LATEST_TITLE, revision: null })

    const forCache = useNoteStore.getState().syncFromRemote([rowOf(collection, item)])

    expect([forCache, storedNote(item.uid)]).toEqual([[saved], running])
    expect(await saving).toBe(true)
  })

  it('hands back nothing for a note it deleted', async () => {
    const { collection, item } = await showSavedNote()
    expect(await useNoteStore.getState().deleteNote(item.uid)).toBe(true)

    expect(useNoteStore.getState().syncFromRemote([rowOf(collection, item)])).toEqual([])
  })

  /** A sync that read the note at R0 is delivered after the save; its refresh cached the R0 item. */
  async function lateSyncAfterSave() {
    const { account, collection, item } = await saveOverR0()
    const saved = storedNote(item.uid)
    useEtebaseStore.setState({ itemCache: new Map([[item.uid, item]]) })
    useNoteStore.getState().syncFromRemote([rowOf(collection, item)])
    expect(storedNote(item.uid)).toBe(saved)
    // The item at the saved revision is read again and cached, as the row and the editor's base are.
    await vi.waitFor(() => expect(useEtebaseStore.getState().itemCache.get(item.uid).etag).toBe(saved.revision))
    return { account, collection, item, saved }
  }

  it('queues an offline edit made right after a sync that read the note before its save', async () => {
    const { item, saved } = await lateSyncAfterSave()
    server.offline = true

    const base = { title: SAVED_TITLE, content: BASE_BODY, revision: saved.revision }
    expect(await useNoteStore.getState().updateNote(item.uid, { title: LATEST_TITLE }, { base })).toBe(true)

    expect((await getAll(queueGuard())).map((entry: any) => [entry.type, entry.itemUid])).toEqual([['sealed-update', item.uid]])
  })

  /** As lateSyncAfterSave, with the store's read of the item at the saved revision held. */
  async function lateSyncWithHeldRead() {
    const { account, collection, item } = await saveOverR0()
    const saved = storedNote(item.uid)
    const reread = server.holdNext((method, path) => method === 'get' && path.endsWith(`item/${item.uid}`))
    useEtebaseStore.setState({ itemCache: new Map([[item.uid, item]]) })
    useNoteStore.getState().syncFromRemote([rowOf(collection, item)])
    await reread.arrived
    return { account, collection, item, saved, reread }
  }

  it('caches the item read again while an edit typed right after the sync saves, so the edit can queue offline', async () => {
    const { item, saved, reread } = await lateSyncWithHeldRead()
    // The edit's own fresh read is held too, then fails on the network once the first read is cached.
    const freshRead = server.holdNext((method, path) => method === 'get' && path.endsWith(`item/${item.uid}`))
    const base = { title: SAVED_TITLE, content: BASE_BODY, revision: saved.revision }
    const saving = useNoteStore.getState().updateNote(item.uid, { title: LATEST_TITLE }, { base })
    await freshRead.arrived
    expect(storedNote(item.uid)).toMatchObject({ title: LATEST_TITLE, revision: null })
    reread.release(false)
    await vi.waitFor(() => expect(useEtebaseStore.getState().itemCache.get(item.uid).etag).toBe(saved.revision))
    server.offline = true
    freshRead.release(true)

    expect(await saving).toBe(true)
    expect((await getAll(queueGuard())).map((entry: any) => [entry.type, entry.itemUid])).toEqual([['sealed-update', item.uid]])
  })

  it.each([
    ['fails on the network', async () => true],
    ['finds a revision another device saved since', async (account: any, collection: any, uid: string) => {
      await anotherDeviceSaves(account, collection, uid)
      return false
    }],
  ] as const)('keeps the older cached item when the read again %s', async (_label, meanwhile) => {
    const { account, collection, item, reread } = await lateSyncWithHeldRead()

    reread.release(await meanwhile(account, collection, item.uid))
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(useEtebaseStore.getState().itemCache.get(item.uid)).toBe(item)
  })

  it('moves a note right after a sync that read the note before its save', async () => {
    const { account, item } = await lateSyncAfterSave()
    const target = await account.getCollectionManager().create('etebase.md.note', { name: 'Target 1147', mtime: 1 }, '')
    target.encryptedCollection.__markSaved()
    server.seed(target, [])
    const { collections } = useEtebaseStore.getState()
    useEtebaseStore.setState({ collections: { ...collections, notes: [...collections.notes, target] } } as any)
    useNotebookStore.setState((state: any) => ({ lists: [...state.lists, { id: target.uid, name: 'Target 1147', color: '#fff', visible: true, accessLevel: 2 }] }))

    const moved = await useNoteStore.getState().moveNote(item.uid, target.uid)

    const listed = await account.getCollectionManager().getItemManager(target).list()
    expect([moved, listed.data.map((copy: any) => copy.uid), storedNote(moved!)?.title]).toEqual([listed.data[0]?.uid, [moved], SAVED_TITLE])
  })
})
