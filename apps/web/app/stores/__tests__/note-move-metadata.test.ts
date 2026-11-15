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

  /** A shown, saved note whose server item holds `meta`, and a second writable notebook. */
  async function shownNoteWithMeta(meta: unknown) {
    const { account, collection } = await makeSavedNote('unused', 'unused')
    const item = await account.getCollectionManager().getItemManager(collection).create(meta, BODY)
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
