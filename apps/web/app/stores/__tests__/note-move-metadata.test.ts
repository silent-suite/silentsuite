// @vitest-environment node
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { _resetForTests as resetOfflineQueue } from '@/app/lib/offline-queue'
import { _resetForTests as resetDataCache } from '@/app/lib/data-cache'

const toastMock = vi.hoisted(() => ({ showErrorToast: vi.fn() }))
vi.mock('@/app/stores/use-toast-store', () => toastMock)
vi.mock('@/app/stores/use-label-suggestions-store', () => ({
  useLabelSuggestionsStore: { getState: () => ({ recordUsage: vi.fn() }) },
}))

import { useEtebaseStore } from '../use-etebase-store'
import { markNoteObligation, resetNoteLifecycle, useNoteStore } from '../use-note-store'
import { useNotebookStore } from '../use-notebook-store'
import { useAuthStore } from '../use-auth-store'
import { EtebaseRequest, ReferenceServer, deleteDatabase, installNoteAccount, makeSavedNote } from './web744-sdk-fixture'

vi.setConfig({ testTimeout: 20_000 })

const TITLE = 'Moved title'
const BODY = 'MOVED BODY'
const SHOWN_AT = new Date(5000)

const UNREADABLE_TOAST = 'Note not moved: some of its details could not be read. It stays in its notebook, unchanged.'
const NOT_A_NOTE_TOAST = 'Note not moved: another app changed it into an item that is not a note. It stays in its notebook, unchanged.'

/** Fields another client wrote next to the title and mtime. */
const PEER_FIELDS = {
  description: 'Peer description',
  color: '#123456',
  'x-other-client': { kept: [1, 2] },
}

describe('moving a note keeps the metadata other clients wrote', () => {
  const originalRequest = EtebaseRequest.default
  const onLineDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, 'onLine')
  let server: ReferenceServer

  beforeEach(async () => {
    await resetOfflineQueue()
    await resetDataCache()
    await deleteDatabase('silentsuite-offline-queue')
    await deleteDatabase('silentsuite-data-cache')
    resetNoteLifecycle()
    toastMock.showErrorToast.mockReset()
    server = new ReferenceServer()
    EtebaseRequest.default = (url: string, options: unknown) => server.handle(url, options)
    Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, get: () => true })
    useAuthStore.setState({ canWrite: () => true } as any)
  })

  afterEach(() => {
    EtebaseRequest.default = originalRequest
    if (onLineDescriptor) Object.defineProperty(globalThis.navigator, 'onLine', onLineDescriptor)
    else delete (globalThis.navigator as any).onLine
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    useNoteStore.setState({ notes: [] })
  })

  /**
   * A shown, saved note whose server item holds `meta`, and a second writable notebook.
   * `writtenLast` is set through the SDK's setMeta after the body, as a client that
   * saves metadata on its own does; create re-encodes metadata when it sets the body.
   */
  async function shownNoteWithMeta(meta: unknown, writtenLast?: unknown) {
    const { account, collection } = await makeSavedNote('unused', 'unused')
    const item = await account.getCollectionManager().getItemManager(collection).create(meta, BODY)
    if (writtenLast !== undefined) item.setMeta(writtenLast)
    item.encryptedItem.__markSaved()
    const target = await account.getCollectionManager().create('etebase.md.note', { name: 'Target', mtime: 1 }, '')
    target.encryptedCollection.__markSaved()
    server.seed(collection, [item])
    server.seed(target, [])
    installNoteAccount(account, collection, item)
    useEtebaseStore.setState({ collections: { calendar: [], tasks: [], contacts: [], notes: [collection, target], preferences: [] } } as any)
    useNotebookStore.setState({
      lists: [
        { id: collection.uid, name: 'Source', color: '#fff', visible: true, accessLevel: 2 },
        { id: target.uid, name: 'Target', color: '#fff', visible: true, accessLevel: 2 },
      ],
    } as any)
    useNoteStore.setState({
      notes: [{ id: item.uid, uid: item.uid, title: TITLE, content: BODY, notebookId: collection.uid, created_at: SHOWN_AT, updated_at: SHOWN_AT, revision: item.etag }],
    } as any)
    return { account, collection, item, target }
  }

  async function serverItems(account: any, collection: any): Promise<any[]> {
    return (await account.getCollectionManager().getItemManager(collection).list()).data
  }

  it('writes the source item\'s extra fields to the copy, with the shown title and mtime', async () => {
    const { account, collection, item, target } = await shownNoteWithMeta({ name: TITLE, mtime: 1, ...PEER_FIELDS })

    const movedId = await useNoteStore.getState().moveNote(item.uid, target.uid)

    expect(movedId).not.toBeNull()
    const [copy] = await serverItems(account, target)
    expect(copy.uid).toBe(movedId)
    expect(copy.getMeta()).toEqual({ name: TITLE, mtime: SHOWN_AT.getTime(), ...PEER_FIELDS })
    expect(new TextDecoder().decode(await copy.getContent())).toBe(BODY)
    expect((await serverItems(account, collection)).find((candidate) => candidate.uid === item.uid)?.isDeleted).toBe(true)
  })

  it.each(['an owed reconciliation', 'an unknown revision'])(
    'copies the newer fields another client wrote after this tab cached the item, for a note with %s',
    async (reason) => {
      const { account, collection, item, target } = await shownNoteWithMeta({ name: TITLE, mtime: 1 })
      // The peer adds fields; title and body stay, so a fresh proof still matches the shown note.
      const peer = item._clone()
      peer.setMeta({ name: TITLE, mtime: 1, ...PEER_FIELDS })
      await account.getCollectionManager().getItemManager(collection).transaction([peer])
      // Either way the move proves the note against a fresh read; this tab's cached item stays older.
      if (reason === 'an owed reconciliation') markNoteObligation(item.uid)
      else useNoteStore.setState((state) => ({ notes: state.notes.map((note) => ({ ...note, revision: null })) }))
      expect(useEtebaseStore.getState().itemCache.get(item.uid)).toBe(item)

      const movedId = await useNoteStore.getState().moveNote(item.uid, target.uid)

      expect(movedId).not.toBeNull()
      const [copy] = await serverItems(account, target)
      expect(copy.uid).toBe(movedId)
      expect(copy.getMeta()).toEqual({ name: TITLE, mtime: SHOWN_AT.getTime(), ...PEER_FIELDS })
      expect((await serverItems(account, collection)).find((candidate) => candidate.uid === item.uid)?.isDeleted).toBe(true)
      expect(toastMock.showErrorToast).not.toHaveBeenCalled()
    },
  )

  it('moves a note right after a local save, with the saved title and body and the other client\'s fields', async () => {
    const { account, collection, item, target } = await shownNoteWithMeta({ name: TITLE, mtime: 1, ...PEER_FIELDS })
    const saved = await useNoteStore.getState().updateNote(
      item.uid,
      { title: 'Saved title', content: 'SAVED BODY' },
      { base: { title: TITLE, content: BODY, revision: item.etag } },
    )
    expect(saved).toBe(true)
    const shown = useNoteStore.getState().notes[0]!
    // The save paired the shown note with the cached item it published.
    expect(shown.revision).toBe(useEtebaseStore.getState().itemCache.get(item.uid).etag)

    const movedId = await useNoteStore.getState().moveNote(item.uid, target.uid)

    expect(movedId).not.toBeNull()
    const [copy] = await serverItems(account, target)
    expect(copy.getMeta()).toEqual({ name: 'Saved title', mtime: shown.updated_at.getTime(), ...PEER_FIELDS })
    expect(new TextDecoder().decode(await copy.getContent())).toBe('SAVED BODY')
    expect((await serverItems(account, collection)).find((candidate) => candidate.uid === item.uid)?.isDeleted).toBe(true)
  })

  it('keeps a constructor key as a plain field of the copy', async () => {
    const { account, item, target } = await shownNoteWithMeta({ name: TITLE, mtime: 1, constructor: 'peer value' })

    expect(await useNoteStore.getState().moveNote(item.uid, target.uid)).not.toBeNull()

    const [copy] = await serverItems(account, target)
    expect(copy.getMeta()).toEqual({ name: TITLE, mtime: SHOWN_AT.getTime(), constructor: 'peer value' })
  })

  it('refuses to move a note whose metadata holds a __proto__ key with a map value', async () => {
    // An own __proto__ key; the decoder turns its map value into the decoded object's prototype.
    const meta = JSON.parse(`{"name":"${TITLE}","mtime":1,"__proto__":{"kept":true}}`)
    const { account, collection, item, target } = await shownNoteWithMeta({ name: TITLE, mtime: 1 }, meta)
    expect(Object.getPrototypeOf(item.getMeta())).not.toBe(Object.prototype)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => errorSpy.mockRestore())

    const movedId = await useNoteStore.getState().moveNote(item.uid, target.uid)

    expect(movedId).toBeNull()
    expect(await serverItems(account, target)).toEqual([])
    expect((await serverItems(account, collection)).find((candidate) => candidate.uid === item.uid)?.isDeleted).toBe(false)
    expect(toastMock.showErrorToast).toHaveBeenCalledWith(UNREADABLE_TOAST)
    expect(errorSpy).toHaveBeenCalledWith('[note-store] Failed to move note', { errorName: 'NoteMetaUnreadableError' })
  })

  it('refuses to move a note another client retyped after this tab cached it, and leaves it in place', async () => {
    const { account, collection, item, target } = await shownNoteWithMeta({ name: TITLE, mtime: 1 })
    // Title and body stay, so the fresh proof still matches the shown note; only the type changed.
    const peer = item._clone()
    peer.setMeta({ name: TITLE, mtime: 1, type: 'attachment' })
    await account.getCollectionManager().getItemManager(collection).transaction([peer])
    markNoteObligation(item.uid)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => errorSpy.mockRestore())

    const movedId = await useNoteStore.getState().moveNote(item.uid, target.uid)

    expect(movedId).toBeNull()
    expect(await serverItems(account, target)).toEqual([])
    const source = (await serverItems(account, collection)).find((candidate) => candidate.uid === item.uid)
    expect(source?.isDeleted).toBe(false)
    expect(source?.getMeta()).toEqual({ name: TITLE, mtime: 1, type: 'attachment' })
    expect(toastMock.showErrorToast).toHaveBeenCalledWith(NOT_A_NOTE_TOAST)
    expect(errorSpy).toHaveBeenCalledWith('[note-store] Failed to move note', { errorName: 'NoteMoveNotANoteError' })
  })

  it('refuses to move a note whose metadata is not a map, and leaves the source and target untouched', async () => {
    const { account, collection, item, target } = await shownNoteWithMeta('metadata written as text')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => errorSpy.mockRestore())

    const movedId = await useNoteStore.getState().moveNote(item.uid, target.uid)

    expect(movedId).toBeNull()
    expect(await serverItems(account, target)).toEqual([])
    const source = (await serverItems(account, collection)).find((candidate) => candidate.uid === item.uid)
    expect(source?.isDeleted).toBe(false)
    expect(source?.getMeta()).toBe('metadata written as text')
    expect(useNoteStore.getState().notes.map((note) => [note.id, note.notebookId])).toEqual([[item.uid, collection.uid]])
    expect(toastMock.showErrorToast).toHaveBeenCalledWith(UNREADABLE_TOAST)
  })
})
