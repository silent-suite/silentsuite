// @vitest-environment node
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetForTests as resetOfflineQueue, casStub, clearFailed, getAll, getFailedCount, replay, retryFailed } from '@/app/lib/offline-queue'
import { bumpAccountEpoch } from '@/app/lib/account-epoch'
import {
  _resetForTests as resetDataCache,
  _setEncryptedCacheAvailableForTests,
  _setEnvelopeKeyForTests,
  ensureFingerprint,
  isCacheEnabled,
} from '@/app/lib/data-cache'
import { deserializeContact, serializeContact } from '@silentsuite/core'

const toastMock = vi.hoisted(() => ({ showErrorToast: vi.fn() }))
vi.mock('@/app/stores/use-toast-store', () => toastMock)
vi.mock('@/app/stores/use-label-suggestions-store', () => ({
  useLabelSuggestionsStore: { getState: () => ({ recordUsage: vi.fn() }) },
}))

import { useEtebaseStore } from '../use-etebase-store'
import { markNoteObligation, registerNoteEditor, resetNoteLifecycle, useNoteStore } from '../use-note-store'
import {
  beginContactPhoto,
  endContactPhoto,
  registerContactOwner,
  releaseContactOwnerWhenSettled,
  resetContactLifecycle,
  useContactStore,
} from '../use-contact-store'
import { useNotebookStore } from '../use-notebook-store'
import { useContactListStore } from '../use-contact-list-store'
import { useAuthStore } from '../use-auth-store'
import {
  Etebase,
  EtebaseRequest,
  FINGERPRINT,
  ReferenceServer,
  deleteDatabase,
  installContactAccount,
  installNoteAccount,
  makeSavedContact,
  makeSavedNote,
  queueGuard,
} from './web744-sdk-fixture'

vi.setConfig({ testTimeout: 20_000 })

const BASE_TITLE = 'Destructive base 744'
const BASE_BODY = 'BASE BODY R0 744'
const PEER_BODY = 'NEWER PEER BODY A 744'

function contactVcard(uid: string, given: string): string {
  const at = new Date(1000)
  return serializeContact({
    id: uid, uid, displayName: given, name: { prefix: '', given, family: '', suffix: '' },
    phones: [], emails: [], addresses: [], organization: '', title: '', notes: '', birthday: null,
    photoUrl: null, categories: [], favorite: false, created_at: at, updated_at: at,
  } as any)
}

/** What the server holds for one item: its text, or 'deleted' for a tombstone, or 'absent'. */
async function serverState(account: any, collection: any, uid: string): Promise<string> {
  const response = await account.getCollectionManager().getItemManager(collection).list()
  const found = response.data.find((candidate: any) => candidate.uid === uid)
  if (!found) return 'absent'
  if (found.isDeleted) return 'deleted'
  return new TextDecoder().decode(await found.getContent())
}

describe('#744 destructive note and contact paths delete only what this context proved', () => {
  const originalRequest = EtebaseRequest.default
  const onLineDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, 'onLine')
  let server: ReferenceServer

  beforeEach(async () => {
    await resetOfflineQueue()
    await resetDataCache()
    await deleteDatabase('silentsuite-offline-queue')
    await deleteDatabase('silentsuite-data-cache')
    resetNoteLifecycle()
    resetContactLifecycle()
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
    useContactStore.setState({ contacts: [], contactSaveStates: {} } as any)
  })

  async function shownNotes(count = 1) {
    const first = await makeSavedNote(BASE_TITLE, BASE_BODY)
    const { account, collection } = first
    const items = [first.item]
    for (let i = 1; i < count; i++) {
      const extra = await account.getCollectionManager().getItemManager(collection).create({ name: `${BASE_TITLE} ${i}`, mtime: 1 }, `${BASE_BODY} ${i}`)
      extra.encryptedItem.__markSaved()
      items.push(extra)
    }
    server.seed(collection, items)
    installNoteAccount(account, collection, items[0])
    useEtebaseStore.setState({
      itemCache: new Map(items.map((item) => [item.uid, item])),
      itemTypeMap: new Map(items.map((item) => [item.uid, 'notes'])),
      itemCollectionMap: new Map(items.map((item) => [item.uid, collection.uid])),
    } as any)
    useNotebookStore.setState({ lists: [{ id: collection.uid, name: 'Notebook 744', color: '#fff', visible: true, accessLevel: 2 }] } as any)
    const at = new Date(1000)
    useNoteStore.setState({
      notes: items.map((item, i) => ({
        id: item.uid, uid: item.uid, title: i === 0 ? BASE_TITLE : `${BASE_TITLE} ${i}`, content: i === 0 ? BASE_BODY : `${BASE_BODY} ${i}`,
        notebookId: collection.uid, created_at: at, updated_at: at, revision: item.etag,
      })),
    } as any)
    return { account, collection, items, item: items[0] }
  }

  async function shownContact(revisionKnown = true) {
    const { account, collection } = await makeSavedContact('')
    const vcard = contactVcard('vcard-destructive-744', 'Destructive Person 744')
    const item = await account.getCollectionManager().getItemManager(collection).create({ mtime: 1 }, vcard)
    item.encryptedItem.__markSaved()
    server.seed(collection, [item])
    installContactAccount(account, collection, item)
    useContactListStore.setState({ lists: [{ id: collection.uid, name: 'Address book 744', color: '#fff', visible: true, accessLevel: 2 }], activeListId: 'all' } as any)
    useContactStore.setState({
      contacts: [{ ...deserializeContact(vcard), id: item.uid, listId: collection.uid, revision: revisionKnown ? item.etag : null }],
    } as any)
    return { account, collection, item }
  }

  async function peerWrites(account: any, collection: any, item: any, body: string) {
    const peer = item._clone()
    await peer.setContent(body)
    await account.getCollectionManager().getItemManager(collection).transaction([peer])
    return peer
  }

  const dirtyEditor = (item: any) => ({
    periodGen: () => 1,
    isClean: () => false,
    chainIdle: () => true,
    base: () => ({ title: BASE_TITLE, content: BASE_BODY, revision: item.etag as string }),
    flushAndWait: async () => {},
  })

  it('#744 refuses to delete a note whose open editor holds unsaved typing', async () => {
    const { account, collection, item } = await shownNotes()
    const unregister = registerNoteEditor(item.uid, dirtyEditor(item))

    const deleted = await useNoteStore.getState().deleteNote(item.uid)

    // 744 wired boundary
    expect(await serverState(account, collection, item.uid)).toBe(BASE_BODY)

    expect(deleted).toBe(false)
    expect(useNoteStore.getState().notes.map((note) => note.id)).toEqual([item.uid])
    unregister()
  })

  it('#744 refuses to delete a note at its shown revision once a peer wrote newer text', async () => {
    const { account, collection, item } = await shownNotes()
    const peer = await peerWrites(account, collection, item, PEER_BODY)
    // This context's SDK cache already holds A; the store still shows R0.
    useEtebaseStore.setState({ itemCache: new Map([[item.uid, peer]]) } as any)

    const deleted = await useNoteStore.getState().deleteNote(item.uid)

    // 744 wired boundary
    expect(await serverState(account, collection, item.uid)).toBe(PEER_BODY)

    expect(deleted).toBe(false)
    expect(useNoteStore.getState().notes.map((note) => note.id)).toEqual([item.uid])
  })

  it('#744 deletes a clean shown note at its revision', async () => {
    const { account, collection, item } = await shownNotes()
    const clean = { ...dirtyEditor(item), isClean: () => true }
    const unregister = registerNoteEditor(item.uid, clean)

    const deleted = await useNoteStore.getState().deleteNote(item.uid)

    // 744 wired boundary
    expect(await serverState(account, collection, item.uid)).toBe('deleted')

    expect(deleted).toBe(true)
    expect(useNoteStore.getState().notes).toEqual([])
    unregister()
  })

  it('#744 never lets an offline note delete remove newer peer text when it replays', async () => {
    const { account, collection, item } = await shownNotes()
    server.offline = true
    expect(await useNoteStore.getState().deleteNote(item.uid)).toBe(true)
    server.offline = false
    await peerWrites(account, collection, item, PEER_BODY)
    const guard = queueGuard()

    await replay((queued, checkpoint) => useEtebaseStore.getState().replayQueuedMutation(queued, guard, checkpoint), guard)

    // 744 wired boundary
    expect(await serverState(account, collection, item.uid)).toBe(PEER_BODY)

    expect(toastMock.showErrorToast).toHaveBeenCalledWith(`Couldn't delete "${BASE_TITLE}" because it changed after you deleted it. It's been restored.`)
  })

  it('#744 replays an offline note delete whose shown revision is unchanged', async () => {
    const { account, collection, item } = await shownNotes()
    server.offline = true
    expect(await useNoteStore.getState().deleteNote(item.uid)).toBe(true)
    server.offline = false
    const guard = queueGuard()

    await replay((queued, checkpoint) => useEtebaseStore.getState().replayQueuedMutation(queued, guard, checkpoint), guard)

    // 744 wired boundary
    expect(await serverState(account, collection, item.uid)).toBe('deleted')
  })

  it('#744 refuses to delete a contact at a stale revision', async () => {
    const { account, collection, item } = await shownContact()
    await peerWrites(account, collection, item, contactVcard('vcard-destructive-744', 'Peer Person A 744'))

    const deleted = await useContactStore.getState().deleteContact(item.uid)

    // 744 wired boundary
    expect(await serverState(account, collection, item.uid)).not.toBe('deleted')

    expect(deleted).toBe(false)
    expect(useContactStore.getState().contacts.map((contact) => contact.id)).toEqual([item.uid])
  })

  it('#744 refuses to delete a contact whose revision is unknown', async () => {
    const { account, collection, item } = await shownContact(false)

    const deleted = await useContactStore.getState().deleteContact(item.uid)

    // 744 wired boundary
    expect(await serverState(account, collection, item.uid)).not.toBe('deleted')

    expect(deleted).toBe(false)
  })

  it('#744 deletes a contact at its shown revision', async () => {
    const { account, collection, item } = await shownContact()

    const deleted = await useContactStore.getState().deleteContact(item.uid)

    // 744 wired boundary
    expect(await serverState(account, collection, item.uid)).toBe('deleted')

    expect(deleted).toBe(true)
  })

  it('#744 clears a notebook only of unprotected snapshot members and never sweeps a later child', async () => {
    const { account, collection, items } = await shownNotes(2)
    const [clean, protectedNote] = items
    const unregister = registerNoteEditor(protectedNote.uid, dirtyEditor(protectedNote))
    // A child created elsewhere after this context's snapshot.
    const later = await account.getCollectionManager().getItemManager(collection).create({ name: 'Later 744', mtime: 1 }, 'LATER BODY 744')
    await account.getCollectionManager().getItemManager(collection).transaction([later])

    await useEtebaseStore.getState().deleteItemsInCollection('notes', collection.uid)

    // 744 wired boundary
    expect(await serverState(account, collection, protectedNote.uid)).toBe(`${BASE_BODY} 1`)

    expect(await serverState(account, collection, clean.uid)).toBe('deleted')
    expect(await serverState(account, collection, later.uid)).toBe('LATER BODY 744')
    expect(useNoteStore.getState().notes.map((note) => note.id)).toEqual([protectedNote.uid])
    expect(useEtebaseStore.getState().itemCache.has(protectedNote.uid)).toBe(true)
    unregister()
  })

  /** A second writable notebook, known to the server and to this context. */
  async function addNotebook(account: any) {
    const target = await account.getCollectionManager().create('etebase.md.note', { name: 'Target 744', mtime: 1 }, '')
    target.encryptedCollection.__markSaved()
    server.seed(target, [])
    const { collections } = useEtebaseStore.getState()
    useEtebaseStore.setState({ collections: { ...collections, notes: [...collections.notes, target] } } as any)
    useNotebookStore.setState((state: any) => ({ lists: [...state.lists, { id: target.uid, name: 'Target 744', color: '#fff', visible: true, accessLevel: 2 }] }))
    return target
  }

  async function liveTexts(account: any, collection: any): Promise<string[]> {
    const response = await account.getCollectionManager().getItemManager(collection).list()
    const live = response.data.filter((candidate: any) => !candidate.isDeleted)
    return Promise.all(live.map(async (candidate: any) => new TextDecoder().decode(await candidate.getContent())))
  }

  async function collectionDeleted(account: any, uid: string): Promise<boolean> {
    return (await account.getCollectionManager().fetch(uid)).isDeleted
  }

  /** Another device tombstones a collection. */
  async function peerDeletesCollection(account: any, uid: string) {
    const gone = await account.getCollectionManager().fetch(uid)
    gone.delete()
    server.replaceCollection(gone)
  }

  it('#744 never moves a note away from newer peer text, and takes its copy back', async () => {
    const { account, collection, item } = await shownNotes()
    const target = await addNotebook(account)
    await peerWrites(account, collection, item, PEER_BODY)

    const moved = await useNoteStore.getState().moveNote(item.uid, target.uid)

    // 744 wired boundary
    expect(await serverState(account, collection, item.uid)).toBe(PEER_BODY)

    expect(moved).toBeNull()
    expect(await liveTexts(account, target)).toEqual([])
    expect(useNoteStore.getState().notes.map((note) => note.id)).toEqual([item.uid])
  })

  it('#744 refuses to move a note whose open editor holds unsaved typing', async () => {
    const { account, collection, item } = await shownNotes()
    const target = await addNotebook(account)
    const unregister = registerNoteEditor(item.uid, dirtyEditor(item))

    const moved = await useNoteStore.getState().moveNote(item.uid, target.uid)

    // 744 wired boundary
    expect(await serverState(account, collection, item.uid)).toBe(BASE_BODY)

    expect(moved).toBeNull()
    expect(await liveTexts(account, target)).toEqual([])
    unregister()
  })

  it('#744 moves a clean shown note at its revision', async () => {
    const { account, collection, item } = await shownNotes()
    const target = await addNotebook(account)
    const unregister = registerNoteEditor(item.uid, { ...dirtyEditor(item), isClean: () => true })

    const moved = await useNoteStore.getState().moveNote(item.uid, target.uid)

    // 744 wired boundary
    expect(await serverState(account, collection, item.uid)).toBe('deleted')

    expect(moved).not.toBeNull()
    expect(await liveTexts(account, target)).toEqual([BASE_BODY])
    expect(useNoteStore.getState().notes.map((note) => note.notebookId)).toEqual([target.uid])
    unregister()
  })

  it('#744 refuses to delete a notebook holding a child this context never saw', async () => {
    const { account, collection } = await shownNotes()
    await addNotebook(account)
    const later = await account.getCollectionManager().getItemManager(collection).create({ name: 'Later 744', mtime: 1 }, 'LATER BODY 744')
    await account.getCollectionManager().getItemManager(collection).transaction([later])

    const deleted = await useEtebaseStore.getState().deleteCollection('notes', collection.uid)

    // 744 wired boundary
    expect(await collectionDeleted(account, collection.uid)).toBe(false)

    expect(deleted).toBe(false)
    expect(await serverState(account, collection, later.uid)).toBe('LATER BODY 744')
  })

  it('#744 refuses to delete a notebook whose shown note a peer changed', async () => {
    const { account, collection, item } = await shownNotes()
    await addNotebook(account)
    await peerWrites(account, collection, item, PEER_BODY)

    const deleted = await useEtebaseStore.getState().deleteCollection('notes', collection.uid)

    // 744 wired boundary
    expect(await collectionDeleted(account, collection.uid)).toBe(false)

    expect(deleted).toBe(false)
    expect(await serverState(account, collection, item.uid)).toBe(PEER_BODY)
  })

  it('#744 refuses to delete a notebook while a note in it holds unsaved typing', async () => {
    const { account, collection, item } = await shownNotes()
    await addNotebook(account)
    const unregister = registerNoteEditor(item.uid, dirtyEditor(item))

    const deleted = await useEtebaseStore.getState().deleteCollection('notes', collection.uid)

    // 744 wired boundary
    expect(await collectionDeleted(account, collection.uid)).toBe(false)

    expect(deleted).toBe(false)
    expect(useNoteStore.getState().notes.map((note) => note.id)).toEqual([item.uid])
    unregister()
  })

  it('#744 refuses a notebook tombstone once a child arrives after the proof', async () => {
    const { account, collection } = await shownNotes()
    await addNotebook(account)
    const tombstone = server.holdNext((method, path) => method === 'post' && path.includes(collection.uid))

    const deleting = useEtebaseStore.getState().deleteCollection('notes', collection.uid)
    await tombstone.arrived
    const later = await account.getCollectionManager().getItemManager(collection).create({ name: 'Race 744', mtime: 1 }, 'RACE BODY 744')
    await account.getCollectionManager().getItemManager(collection).transaction([later])
    tombstone.release(false)
    const deleted = await deleting

    // 744 wired boundary
    expect(await collectionDeleted(account, collection.uid)).toBe(false)

    expect(deleted).toBe(false)
    expect(await serverState(account, collection, later.uid)).toBe('RACE BODY 744')
  })

  it('#744 deletes an unchanged notebook whose every child is shown here', async () => {
    const { account, collection } = await shownNotes(2)
    await addNotebook(account)

    const deleted = await useEtebaseStore.getState().deleteCollection('notes', collection.uid)

    // 744 wired boundary
    expect(await collectionDeleted(account, collection.uid)).toBe(true)

    expect(deleted).toBe(true)
    expect(useNoteStore.getState().notes).toEqual([])
  })

  it('#744 keeps a note with unsaved typing shown, read-only, when its notebook disappears', async () => {
    const { account, collection, item } = await shownNotes()
    await addNotebook(account)
    const unregister = registerNoteEditor(item.uid, dirtyEditor(item))
    await peerDeletesCollection(account, collection.uid)

    await useEtebaseStore.getState().reconcileCollections()

    // 744 wired boundary
    expect(useNoteStore.getState().notes.map((note) => note.id)).toEqual([item.uid])

    expect(useNoteStore.getState().canWriteNote(useNoteStore.getState().notes[0]!)).toBe(false)
    // A refresh that no longer lists it keeps it while the typing is unsaved.
    useNoteStore.getState().syncFromRemote([])
    expect(useNoteStore.getState().notes.map((note) => note.id)).toEqual([item.uid])
    unregister()
    useNoteStore.getState().syncFromRemote([])
    expect(useNoteStore.getState().notes).toEqual([])
  })

  it('#744 drops a clean note when its notebook disappears', async () => {
    const { account, collection, item } = await shownNotes()
    await addNotebook(account)
    const unregister = registerNoteEditor(item.uid, { ...dirtyEditor(item), isClean: () => true })
    await peerDeletesCollection(account, collection.uid)

    await useEtebaseStore.getState().reconcileCollections()

    // 744 wired boundary
    expect(useNoteStore.getState().notes).toEqual([])
    unregister()
  })

  it('#744 keeps a contact with a draft shown when its address book disappears', async () => {
    const { account, collection, item } = await shownContact()
    const other = await account.getCollectionManager().create('etebase.vcard', { name: 'Other 744', mtime: 1 }, '')
    other.encryptedCollection.__markSaved()
    server.seed(other, [])
    const { collections } = useEtebaseStore.getState()
    useEtebaseStore.setState({ collections: { ...collections, contacts: [...collections.contacts, other] } } as any)
    useContactStore.setState({ contactSaveStates: { [item.uid]: 'failed' } } as any)
    await peerDeletesCollection(account, collection.uid)

    await useEtebaseStore.getState().reconcileCollections()

    // 744 wired boundary
    expect(useContactStore.getState().contacts.map((contact) => contact.id)).toEqual([item.uid])
  })

  /** The copies a move left in `target`, tombstones included. */
  async function copiesIn(account: any, target: any): Promise<any[]> {
    return (await account.getCollectionManager().getItemManager(target).list()).data
  }

  const isSourceTransaction = (collection: any) => (method: string, path: string) => (
    method === 'post' && path.includes(collection.uid) && path.endsWith('item/transaction')
  )

  async function replayAll() {
    const guard = queueGuard()
    await replay((queued, checkpoint) => useEtebaseStore.getState().replayQueuedMutation(queued, guard, checkpoint), guard)
  }

  it('#744 takes back a moved copy at its own revision when the source delete cannot be admitted', async () => {
    const { account, collection, item } = await shownNotes()
    const target = await addNotebook(account)
    // An owed reconciliation: the source delete may never be admitted offline.
    markNoteObligation(item.uid)
    const sourceDelete = server.holdNext(isSourceTransaction(collection))

    const moving = useNoteStore.getState().moveNote(item.uid, target.uid)
    await sourceDelete.arrived
    server.offline = true
    sourceDelete.release(true)
    expect(await moving).toBeNull()
    server.offline = false
    const [copy] = await copiesIn(account, target)
    await replayAll()

    // 744 wired boundary
    expect(await serverState(account, target, copy.uid)).toBe('deleted')

    expect(await serverState(account, collection, item.uid)).toBe(BASE_BODY)
    expect(useNoteStore.getState().notes.map((note) => note.id)).toEqual([item.uid])
    expect(await getAll(queueGuard())).toEqual([])
  })

  it('#744 takes back a moved copy later when the source changed and the rollback cannot reach the server', async () => {
    const { account, collection, item } = await shownNotes()
    const target = await addNotebook(account)
    await peerWrites(account, collection, item, PEER_BODY)
    server.offlineAfterConflict = true

    expect(await useNoteStore.getState().moveNote(item.uid, target.uid)).toBeNull()
    server.offlineAfterConflict = false
    server.offline = false
    const [copy] = await copiesIn(account, target)
    await replayAll()

    // 744 wired boundary
    expect(await serverState(account, target, copy.uid)).toBe('deleted')

    expect(await serverState(account, collection, item.uid)).toBe(PEER_BODY)
  })

  it('#744 never takes back a moved copy that a peer edited before the cleanup replays', async () => {
    const { account, collection, item } = await shownNotes()
    const target = await addNotebook(account)
    await peerWrites(account, collection, item, PEER_BODY)
    server.offlineAfterConflict = true
    expect(await useNoteStore.getState().moveNote(item.uid, target.uid)).toBeNull()
    server.offlineAfterConflict = false
    server.offline = false
    const [copy] = await copiesIn(account, target)
    await peerWrites(account, target, copy, 'PEER EDITED COPY 744')

    await replayAll()

    // 744 wired boundary
    expect(await serverState(account, target, copy.uid)).toBe('PEER EDITED COPY 744')

    expect(await serverState(account, collection, item.uid)).toBe(PEER_BODY)
  })

  it('#744 queues no cleanup into the next account when the account changes during a move', async () => {
    const { account, collection, item } = await shownNotes()
    const target = await addNotebook(account)
    markNoteObligation(item.uid)
    const sourceDelete = server.holdNext(isSourceTransaction(collection))

    const moving = useNoteStore.getState().moveNote(item.uid, target.uid)
    await sourceDelete.arrived
    bumpAccountEpoch()
    server.offline = true
    sourceDelete.release(true)
    expect(await moving).toBeNull()

    // 744 wired boundary
    expect(await getAll(queueGuard())).toEqual([])

    server.offline = false
    expect(await serverState(account, collection, item.uid)).toBe(BASE_BODY)
  })

  it('#744 keeps a moved copy and deletes the source on replay when its conditional delete was admitted offline', async () => {
    const { account, collection, item } = await shownNotes()
    const target = await addNotebook(account)
    const sourceDelete = server.holdNext(isSourceTransaction(collection))

    const moving = useNoteStore.getState().moveNote(item.uid, target.uid)
    await sourceDelete.arrived
    server.offline = true
    sourceDelete.release(true)
    const moved = await moving
    server.offline = false
    const queued = await getAll(queueGuard())
    await replayAll()

    // 744 wired boundary
    expect(await serverState(account, collection, item.uid)).toBe('deleted')

    expect(moved).not.toBeNull()
    expect(queued.map((entry) => [entry.type, entry.itemUid, entry.expectedEtag])).toEqual([['delete', item.uid, item.etag]])
    expect(await serverState(account, target, moved!)).toBe(BASE_BODY)
  })

  /** An open editor whose clean period and typing the test advances, through the real registry. */
  function steerableEditor(item: any) {
    const state = { period: 1, clean: true }
    const unregister = registerNoteEditor(item.uid, { ...dirtyEditor(item), periodGen: () => state.period, isClean: () => state.clean })
    const type = () => {
      state.period += 1
      state.clean = false
    }
    return { type, unregister }
  }

  /** A queue record as an earlier app version left it, written straight into the queue database. */
  async function putRawQueueRecord(record: Record<string, unknown>) {
    await getAll(queueGuard())
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('silentsuite-offline-queue')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('mutations', 'readwrite')
      tx.objectStore('mutations').put(record)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  }

  it('#744 never lets an older sealed replay overwrite a successor that was written and acknowledged first', async () => {
    const { account, collection, item } = await shownNotes()
    const B1 = 'OFFLINE BODY B1 744'
    const guard = queueGuard()
    server.offline = true
    expect(await useNoteStore.getState().updateNote(item.uid, { content: B1 }, { base: { title: BASE_TITLE, content: BASE_BODY, revision: item.etag } })).toBe(true)
    server.offline = false
    const [r1Snapshot] = await getAll(guard)
    expect(r1Snapshot?.rev).toBe(1)
    const r1List = server.holdNext((method, path) => method === 'get' && path.endsWith(`${collection.uid}/item`))
    const r1 = useEtebaseStore.getState().replayQueuedMutation(r1Snapshot!, guard).then(() => 'sent', () => 'refused')
    await r1List.arrived
    // The successor, typed on B1, returns the body to the original text; it is written and acknowledged first.
    expect(await useNoteStore.getState().updateNote(item.uid, { content: BASE_BODY }, { base: { title: BASE_TITLE, content: B1, revision: null } })).toBe(true)
    await replayAll()
    expect(await getAll(guard)).toEqual([])
    r1List.release(false)
    await r1

    // 744 wired boundary
    expect(await serverState(account, collection, item.uid)).toBe(BASE_BODY)
  })

  it('#744 never lets a favorite overwrite a peer change to fields the contact model does not keep', async () => {
    const { account, collection, item } = await shownContact()
    const original = contactVcard('vcard-destructive-744', 'Destructive Person 744')
    const peerText = original
      .replace(/^N:[^\r\n]*/m, 'N:;Destructive Person 744;Peer Middle 744;;')
      .replace('END:VCARD', 'X-WEB744-PEER:kept\r\nEND:VCARD')
    expect(peerText).not.toBe(original)
    await peerWrites(account, collection, item, peerText)

    await useContactStore.getState().setContactFavorite(item.uid, true)

    // 744 wired boundary
    expect(await serverState(account, collection, item.uid)).toBe(peerText)
  })

  it('#744 keeps a contact draft begun while its delete was in flight', async () => {
    const { item } = await shownContact()
    const isTransaction = (method: string, path: string) => method === 'post' && path.endsWith('item/transaction')
    const deleting = server.holdNext(isTransaction)
    const deleted = useContactStore.getState().deleteContact(item.uid)
    await deleting.arrived
    const saving = server.holdNext(isTransaction)
    const edit = useContactStore.getState().updateContact(item.uid, { displayName: 'Late Draft 744' })
    await saving.arrived
    deleting.release(false)
    await deleted
    saving.release(false)
    await edit

    // 744 wired boundary
    expect(useContactStore.getState().contacts.find((contact) => contact.id === item.uid)?.displayName).toBe('Late Draft 744')

    expect(useContactStore.getState().contactSaveStates[item.uid]).toBe('refused')
  })

  it('#744 keeps a note shown with typing that began while its move was in flight', async () => {
    const { account, collection, item } = await shownNotes()
    const target = await addNotebook(account)
    const editor = steerableEditor(item)
    const sourceDelete = server.holdNext(isSourceTransaction(collection))

    const moving = useNoteStore.getState().moveNote(item.uid, target.uid)
    await sourceDelete.arrived
    editor.type()
    sourceDelete.release(false)
    await moving

    // 744 wired boundary
    expect(useNoteStore.getState().notes.map((note) => note.id)).toContain(item.uid)
    editor.unregister()
  })

  it('#744 keeps a note shown with typing that began while its notebook clear was in flight', async () => {
    const { collection, item } = await shownNotes()
    const editor = steerableEditor(item)
    const memberDelete = server.holdNext(isSourceTransaction(collection))

    const clearing = useEtebaseStore.getState().deleteItemsInCollection('notes', collection.uid)
    await memberDelete.arrived
    editor.type()
    memberDelete.release(false)
    await clearing

    // 744 wired boundary
    expect(useNoteStore.getState().notes.map((note) => note.id)).toEqual([item.uid])
    editor.unregister()
  })

  it('#744 refuses to delete a notebook while an open clean editor holds text other than the shown note', async () => {
    const { account, collection, item } = await shownNotes()
    await addNotebook(account)
    const peer = await peerWrites(account, collection, item, PEER_BODY)
    // This context shows the peer revision; the open editor, clean and idle, still holds R0.
    useEtebaseStore.setState({ itemCache: new Map([[item.uid, peer]]) } as any)
    useNoteStore.setState((state: any) => ({ notes: state.notes.map((note: any) => ({ ...note, content: PEER_BODY, revision: peer.etag })) }))
    const unregister = registerNoteEditor(item.uid, { ...dirtyEditor(item), isClean: () => true })

    const deleted = await useEtebaseStore.getState().deleteCollection('notes', collection.uid)

    // 744 wired boundary
    expect(await collectionDeleted(account, collection.uid)).toBe(false)

    expect(deleted).toBe(false)
    unregister()
  })

  it('#744 retires a queued favorite overlay once its sealed record replays and is acknowledged', async () => {
    const { account, collection, item } = await shownContact()
    server.offline = true
    expect(await useContactStore.getState().setContactFavorite(item.uid, true)).toBe(true)
    server.offline = false
    expect(useContactStore.getState().contactSaveStates[item.uid]).toBe('queued')

    await replayAll()

    // 744 wired boundary
    expect(useContactStore.getState().contactSaveStates[item.uid]).toBeUndefined()

    expect(await getAll(queueGuard())).toEqual([])
    expect(deserializeContact(await serverState(account, collection, item.uid)).favorite).toBe(true)
  })

  it('#744 keeps a failed legacy content-free update out of the failed count, retry and bulk discard', async () => {
    const guard = queueGuard()
    const old = { createdAt: 1, retryCount: 3, status: 'failed', accountFingerprint: FINGERPRINT }
    await putRawQueueRecord({ ...old, id: 'legacy-failed-744', type: 'update', collectionType: 'notes', collectionUid: 'notebook-744', itemUid: 'note-744' })
    await putRawQueueRecord({ ...old, id: 'ordinary-failed-744', type: 'delete', collectionType: 'calendar', collectionUid: 'calendar-744', itemUid: 'event-744' })

    const failedCount = await getFailedCount(guard)
    await clearFailed(guard)
    const afterDiscard = (await getAll(guard)).map((entry) => entry.id)

    // 744 wired boundary
    expect([failedCount, afterDiscard]).toEqual([1, ['legacy-failed-744']])

    await retryFailed(guard)
    expect((await getAll(guard)).map((entry) => [entry.id, entry.status])).toEqual([['legacy-failed-744', 'failed']])
  })

  /**
   * Timing observation only: the pinned SDK's real decrypt runs for every item and its
   * exact result (or error) is returned unchanged; one known item's completed read is
   * held behind a test barrier. Nothing about uid, revision, content or dispatch changes.
   */
  function holdCompletedRead(uid: string) {
    const original = Etebase.Item.prototype.getContent
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let arrived = () => {}
    const reached = new Promise<void>((resolve) => { arrived = resolve })
    Etebase.Item.prototype.getContent = async function observedGetContent(this: any, ...args: unknown[]) {
      const result = await original.apply(this, args)
      if (this.uid === uid) {
        arrived()
        await gate
      }
      return result
    }
    return { reached, release, restore: () => { Etebase.Item.prototype.getContent = original } }
  }

  /** An offline contact delete, admitted at its shown revision, then a peer renames the contact. */
  async function conflictedContactDelete() {
    const { account, collection, item } = await shownContact()
    server.offline = true
    expect(await useContactStore.getState().deleteContact(item.uid)).toBe(true)
    server.offline = false
    await peerWrites(account, collection, item, contactVcard('vcard-destructive-744', 'Peer Person A 744'))
    return { item }
  }

  it('#744 never shows a contact name read across an account change when its delete conflicts (characterization)', async () => {
    const { item } = await conflictedContactDelete()
    const guard = queueGuard()
    const read = holdCompletedRead(item.uid)
    let results: unknown
    try {
      const replaying = replay((queued, checkpoint) => useEtebaseStore.getState().replayQueuedMutation(queued, guard, checkpoint), guard)
      await read.reached
      bumpAccountEpoch()
      read.release()
      results = await replaying
    } finally {
      read.restore()
    }

    // 744 wired boundary
    expect(toastMock.showErrorToast).not.toHaveBeenCalled()

    expect(results).toEqual([])
    expect((await getAll(queueGuard())).map((entry) => [entry.type, entry.itemUid])).toEqual([['delete', item.uid]])
  })

  it('#744 shows the restored contact name when its delete conflicts in the same account (characterization)', async () => {
    const { item } = await conflictedContactDelete()
    const guard = queueGuard()
    const read = holdCompletedRead(item.uid)
    try {
      const replaying = replay((queued, checkpoint) => useEtebaseStore.getState().replayQueuedMutation(queued, guard, checkpoint), guard)
      await read.reached
      read.release()
      await replaying
    } finally {
      read.restore()
    }

    // 744 wired boundary
    expect(toastMock.showErrorToast).toHaveBeenCalledWith(`Couldn't delete "Peer Person A 744" because it changed after you deleted it. It's been restored.`)
  })

  /** Lets queued store, queue and IndexedDB work finish. */
  async function flush() {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  }

  /**
   * Storage timing observation only: the real IndexedDB delete of one cached item runs
   * unchanged; its completion is handed to the caller only after the test's barrier.
   */
  function holdCacheDelete(uid: string) {
    const proto = (globalThis as any).IDBObjectStore.prototype
    const original = proto.delete
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let arrived = () => {}
    const reached = new Promise<void>((resolve) => { arrived = resolve })
    proto.delete = function heldDelete(this: IDBObjectStore, key: IDBValidKey) {
      const request = original.call(this, key)
      if (this.name === 'items' && key === uid) {
        // The cache resolves on its transaction's completion: the real commit happens, its callback waits.
        const tx = this.transaction
        const complete = tx.oncomplete
        tx.oncomplete = (event: Event) => { void gate.then(() => complete?.call(tx, event)) }
        arrived()
      }
      return request
    }
    return { reached, release, restore: () => { proto.delete = original } }
  }

  it('#744 keeps a note shown with typing that began while its notebook clear waited on local storage', async () => {
    const { collection, item } = await shownNotes()
    vi.stubEnv('NEXT_PUBLIC_LOCAL_CACHE_ENABLED', 'true')
    _setEnvelopeKeyForTests(await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']))
    _setEncryptedCacheAvailableForTests(true)
    await ensureFingerprint(FINGERPRINT, queueGuard().accountEpoch)
    const editor = steerableEditor(item)
    const cacheDelete = holdCacheDelete(item.uid)
    try {
      expect(isCacheEnabled()).toBe(true)
      const clearing = useEtebaseStore.getState().deleteItemsInCollection('notes', collection.uid)
      // The server delete was accepted and the retention check passed; typing starts during the storage wait.
      await cacheDelete.reached
      editor.type()
      cacheDelete.release()
      await clearing
    } finally {
      cacheDelete.restore()
      vi.unstubAllEnvs()
    }

    // 744 wired boundary
    expect(useNoteStore.getState().notes.map((note) => note.id)).toEqual([item.uid])
    editor.unregister()
  })

  it('#744 retires a settled queued favorite overlay when its last owner departs after another context acknowledged it', async () => {
    const { item } = await shownContact()
    const owner = registerContactOwner(item.uid)
    server.offline = true
    expect(await useContactStore.getState().setContactFavorite(item.uid, true)).toBe(true)
    server.offline = false
    const guard = queueGuard()
    const [record] = await getAll(guard)
    // Another context runs the real executor and acknowledges the shared record; this context's callback never runs.
    await useEtebaseStore.getState().replayQueuedMutation(record!, guard)
    expect(await casStub(record!.id, record!.rev, 'delete', guard)).toBe(true)
    // A reopened detail owns the contact; the older detail's departure releases nothing.
    const reopened = registerContactOwner(item.uid)
    releaseContactOwnerWhenSettled(item.uid, owner)
    await flush()
    expect(useContactStore.getState().contactSaveStates[item.uid]).toBe('queued')
    releaseContactOwnerWhenSettled(item.uid, reopened)
    await flush()

    // 744 wired boundary
    expect(useContactStore.getState().contactSaveStates[item.uid]).toBeUndefined()

    // A later refresh adopts the server record instead of the old overlay.
    const serverRecord = { ...useContactStore.getState().contacts[0]!, revision: 'server-revision-744' }
    useContactStore.getState().syncFromRemote([serverRecord])
    expect(useContactStore.getState().contacts[0]).toBe(serverRecord)
  })

  it('#744 retires a queued favorite overlay acknowledged while a photo was pending once the photo fails and its owner departs', async () => {
    const { item } = await shownContact()
    const owner = registerContactOwner(item.uid)
    server.offline = true
    expect(await useContactStore.getState().setContactFavorite(item.uid, true)).toBe(true)
    server.offline = false
    expect(beginContactPhoto(item.uid, owner)).toBe(true)
    await replayAll()
    expect(await getAll(queueGuard())).toEqual([])
    expect(useContactStore.getState().contactSaveStates[item.uid]).toBe('queued')
    releaseContactOwnerWhenSettled(item.uid, owner)
    // The photo could not be processed: nothing is saved, and the owner drains.
    endContactPhoto(item.uid, owner)
    await flush()

    // 744 wired boundary
    expect(useContactStore.getState().contactSaveStates[item.uid]).toBeUndefined()
  })
})
