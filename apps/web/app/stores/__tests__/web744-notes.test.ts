// @vitest-environment node
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetForTests as resetOfflineQueue, getAll, replaceStub, replay } from '@/app/lib/offline-queue'
import { bumpAccountEpoch, getAccountEpoch } from '@/app/lib/account-epoch'
import {
  CACHE_SCHEMA_VERSION,
  _resetForTests as resetDataCache,
  ensureFingerprint,
  putMeta,
} from '@/app/lib/data-cache'

const toastMock = vi.hoisted(() => ({ showErrorToast: vi.fn() }))
vi.mock('@/app/stores/use-toast-store', () => toastMock)
vi.mock('@/app/stores/use-label-suggestions-store', () => ({
  useLabelSuggestionsStore: { getState: () => ({ recordUsage: vi.fn() }) },
}))

import { useEtebaseStore } from '../use-etebase-store'
import {
  conflictCopyTitle,
  getHeldNoteDraft,
  getNoteObligation,
  markNoteObligation,
  registerNoteEditor,
  resetNoteLifecycle,
  useNoteStore,
} from '../use-note-store'
import { useNotebookStore } from '../use-notebook-store'
import { useAuthStore } from '../use-auth-store'
import {
  EtebaseRequest,
  FINGERPRINT,
  ReferenceServer,
  deleteDatabase,
  installNoteAccount,
  makeSavedNote,
  respond,
  serverText,
} from './web744-sdk-fixture'

vi.setConfig({ testTimeout: 20_000 })

const BASE_TITLE = 'Base title 744'
const BASE_BODY = 'BASE BODY R0 744'
const PEER_BODY = 'ACKNOWLEDGED PEER BODY A 744'
const EDIT_TITLE = 'PRIVATE EDIT TITLE 744'
const FIRST_BODY = 'PRIVATE AUTOSAVE ONE 744'
const SECOND_BODY = 'PRIVATE AUTOSAVE TWO 744'
const RETAINED_BODY = 'PRIVATE RETAINED DRAFT B 744'

async function readAllRecords(dbName: string, storeName: string): Promise<any[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    if (!db.objectStoreNames.contains(storeName)) return []
    return await new Promise<any[]>((resolve, reject) => {
      const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll()
      request.onsuccess = () => resolve(request.result ?? [])
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

async function openRawStub(record: any): Promise<any | null> {
  const [key] = await readAllRecords('silentsuite-data-cache', 'crypto')
  if (!record?.sealed || !(key instanceof CryptoKey)) return null
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: Uint8Array.from(record.sealed.iv), additionalData: new TextEncoder().encode(`${FINGERPRINT}|notes|${record.itemUid}`) },
      key,
      Uint8Array.from(record.sealed.ct),
    )
    return JSON.parse(new TextDecoder().decode(plaintext))
  } catch {
    return null
  }
}

describe('#744 the note store saves through the captured editing base', () => {
  const originalRequest = EtebaseRequest.default
  const onLineDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, 'onLine')
  let server: ReferenceServer

  beforeEach(async () => {
    await resetOfflineQueue()
    await resetDataCache()
    await deleteDatabase('silentsuite-offline-queue')
    await deleteDatabase('silentsuite-data-cache')
    toastMock.showErrorToast.mockReset()
    server = new ReferenceServer()
    EtebaseRequest.default = (url: string, options: unknown) => server.handle(url, options)
    Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, get: () => true })
    // Permission fixtures only: an active subscription and a read/write notebook.
    useAuthStore.setState({ canWrite: () => true } as any)
  })

  afterEach(() => {
    EtebaseRequest.default = originalRequest
    if (onLineDescriptor) Object.defineProperty(globalThis.navigator, 'onLine', onLineDescriptor)
    else delete (globalThis.navigator as any).onLine
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    useNoteStore.setState({ notes: [] })
  })

  function showNote(collection: any, uid: string, title: string, content: string, revision: string | null) {
    useNotebookStore.setState({ lists: [{ id: collection.uid, name: 'Notebook 744', color: '#fff', visible: true, accessLevel: 2 }] } as any)
    const at = new Date(1000)
    useNoteStore.setState({
      notes: [{ id: uid, uid, title, content, notebookId: collection.uid, created_at: at, updated_at: at, revision }],
    } as any)
  }

  function storedNote(uid: string): any {
    return useNoteStore.getState().notes.find((note) => note.id === uid)
  }

  it('#744 refuses a draft captured on R0 after A was acknowledged and keeps A in the store', async () => {
    const { account, collection, item } = await makeSavedNote(BASE_TITLE, BASE_BODY)
    server.seed(collection, [item])
    const baseRevision: string = item.etag
    const peerItem = item._clone()
    await peerItem.setContent(PEER_BODY)
    await account.getCollectionManager().getItemManager(collection).transaction([peerItem])
    installNoteAccount(account, collection, peerItem)
    showNote(collection, item.uid, BASE_TITLE, PEER_BODY, peerItem.etag)
    const shownA = storedNote(item.uid)

    const saved = await useNoteStore.getState().updateNote(
      item.uid,
      { title: BASE_TITLE, content: RETAINED_BODY },
      { base: { title: BASE_TITLE, content: BASE_BODY, revision: baseRevision } },
    )

    // 744 wired boundary
    expect(saved).toBe(false)

    expect(await serverText(account, collection, item.uid)).toBe(PEER_BODY)
    expect(storedNote(item.uid)).toBe(shownA)
  })

  it('#744 advances two successive own autosaves by their exact saved etags', async () => {
    const { account, collection, item } = await makeSavedNote(BASE_TITLE, BASE_BODY)
    server.seed(collection, [item])
    installNoteAccount(account, collection, item)
    showNote(collection, item.uid, BASE_TITLE, BASE_BODY, item.etag)
    const savedEtags: string[] = []

    const first = await useNoteStore.getState().updateNote(
      item.uid,
      { title: EDIT_TITLE, content: FIRST_BODY },
      { base: { title: BASE_TITLE, content: BASE_BODY, revision: item.etag }, onSaved: (etag: string) => savedEtags.push(etag) },
    )
    const second = await useNoteStore.getState().updateNote(
      item.uid,
      { title: EDIT_TITLE, content: SECOND_BODY },
      { base: { title: EDIT_TITLE, content: FIRST_BODY, revision: savedEtags[0] ?? null }, onSaved: (etag: string) => savedEtags.push(etag) },
    )
    const serverRevision = (await account.getCollectionManager().getItemManager(collection).fetch(item.uid)).etag

    // 744 wired boundary
    expect(storedNote(item.uid).revision).toBe(serverRevision)

    expect([first, second]).toEqual([true, true])
    expect(savedEtags).toHaveLength(2)
    expect(savedEtags[1]).toBe(serverRevision)
    expect(await serverText(account, collection, item.uid)).toBe(SECOND_BODY)
  })

  it('#744 keeps an offline note store edit and its base proof in sealed custody across a schema reset', async () => {
    const { account, collection, item } = await makeSavedNote(BASE_TITLE, BASE_BODY)
    server.seed(collection, [item])
    installNoteAccount(account, collection, item)
    showNote(collection, item.uid, BASE_TITLE, BASE_BODY, item.etag)
    server.offline = true

    const saved = await useNoteStore.getState().updateNote(
      item.uid,
      { title: EDIT_TITLE, content: RETAINED_BODY },
      { base: { title: BASE_TITLE, content: BASE_BODY, revision: item.etag } },
    )
    await putMeta({ accountFingerprint: FINGERPRINT, cacheSchemaVersion: CACHE_SCHEMA_VERSION - 1, lastInvalidatedAt: null })
    expect(await ensureFingerprint(FINGERPRINT)).toBe(false)
    const records = await readAllRecords('silentsuite-offline-queue', 'mutations')
    const opened = await openRawStub(records.find((record) => record.itemUid === item.uid))

    // 744 wired boundary
    expect([opened?.body?.content, opened?.base?.revision]).toEqual([RETAINED_BODY, item.etag])

    expect(saved).toBe(true)
    expect(JSON.stringify(records)).not.toContain(RETAINED_BODY)
  })

  it('#744 publishes a created note with the saved revision of the same committed item', async () => {
    const { account, collection, item } = await makeSavedNote(BASE_TITLE, BASE_BODY)
    server.seed(collection, [item])
    installNoteAccount(account, collection, item)
    useNotebookStore.setState({
      lists: [{ id: collection.uid, name: 'Notebook 744', color: '#fff', visible: true, accessLevel: 2 }],
      activeListId: collection.uid,
    } as any)

    const created = await useNoteStore.getState().createNote({ title: EDIT_TITLE, content: FIRST_BODY, notebookId: collection.uid })
    const serverItem = await account.getCollectionManager().getItemManager(collection).fetch(created.id)

    // 744 wired boundary
    expect(storedNote(created.id).revision).toBe(serverItem.etag)

    expect([storedNote(created.id).title, storedNote(created.id).content]).toEqual([EDIT_TITLE, FIRST_BODY])
    expect(await serverText(account, collection, created.id)).toBe(FIRST_BODY)
  })

  it('#744 publishes a moved note with an unknown revision, never the source revision', async () => {
    const { account, collection, item } = await makeSavedNote(BASE_TITLE, BASE_BODY)
    const target = await account.getCollectionManager().create('etebase.md.note', { name: 'Target 744', mtime: 1 }, '')
    target.encryptedCollection.__markSaved()
    server.seed(collection, [item])
    server.seed(target, [])
    installNoteAccount(account, collection, item)
    useEtebaseStore.setState({ collections: { calendar: [], tasks: [], contacts: [], notes: [collection, target], preferences: [] } } as any)
    useNotebookStore.setState({
      lists: [
        { id: collection.uid, name: 'Notebook 744', color: '#fff', visible: true, accessLevel: 2 },
        { id: target.uid, name: 'Target 744', color: '#fff', visible: true, accessLevel: 2 },
      ],
    } as any)
    const at = new Date(1000)
    useNoteStore.setState({
      notes: [{ id: item.uid, uid: item.uid, title: BASE_TITLE, content: BASE_BODY, notebookId: collection.uid, created_at: at, updated_at: at, revision: item.etag }],
    } as any)

    const movedId = await useNoteStore.getState().moveNote(item.uid, target.uid)

    // 744 wired boundary
    expect(movedId ? storedNote(movedId).revision : 'not moved').toBeNull()

    expect(movedId).not.toBe(item.uid)
    expect(storedNote(movedId!).notebookId).toBe(target.uid)
    expect(await serverText(account, target, movedId!)).toBe(BASE_BODY)
  })

  async function shownSavedNote() {
    const { account, collection, item } = await makeSavedNote(BASE_TITLE, BASE_BODY)
    server.seed(collection, [item])
    installNoteAccount(account, collection, item)
    showNote(collection, item.uid, BASE_TITLE, BASE_BODY, item.etag)
    return { account, collection, item, base: { title: BASE_TITLE, content: BASE_BODY, revision: item.etag as string } }
  }

  it('#744 never seals an obligated save offline when its captured obligation is no longer in the map', async () => {
    const { item, base } = await shownSavedNote()
    server.offline = true

    const saved = await useNoteStore.getState().updateNote(item.uid, { title: EDIT_TITLE, content: RETAINED_BODY }, { base, obligation: {} } as any)

    // 744 wired boundary
    expect(saved).toBe(false)

    expect(await readAllRecords('silentsuite-offline-queue', 'mutations')).toEqual([])
  })

  it('#744 refuses an obligated save whose fresh live proof fails, without sealing it', async () => {
    const { account, collection, item, base } = await shownSavedNote()
    const peerItem = item._clone()
    await peerItem.setContent(PEER_BODY)
    await account.getCollectionManager().getItemManager(collection).transaction([peerItem])
    server.offlineAfterConflict = true

    const saved = await useNoteStore.getState().updateNote(item.uid, { title: EDIT_TITLE, content: RETAINED_BODY }, { base, obligation: {} } as any)

    // 744 wired boundary
    expect(saved).toBe(false)

    server.offline = false
    expect(await serverText(account, collection, item.uid)).toBe(PEER_BODY)
    expect(await readAllRecords('silentsuite-offline-queue', 'mutations')).toEqual([])
  })

  it('#744 saves an obligated note only through a proved fresh live copy', async () => {
    const { account, collection, item, base } = await shownSavedNote()

    const saved = await useNoteStore.getState().updateNote(item.uid, { title: EDIT_TITLE, content: FIRST_BODY }, { base, obligation: {} } as any)

    // 744 wired boundary
    expect(saved).toBe(true)

    expect(await serverText(account, collection, item.uid)).toBe(FIRST_BODY)
  })

  it('#744 enforces an obligation installed after the save was captured', async () => {
    const { item, base } = await shownSavedNote()
    const capture = { base }
    markNoteObligation(item.uid)
    server.offline = true

    const saved = await useNoteStore.getState().updateNote(item.uid, { title: EDIT_TITLE, content: RETAINED_BODY }, capture)

    // 744 wired boundary
    expect(saved).toBe(false)

    expect(await readAllRecords('silentsuite-offline-queue', 'mutations')).toEqual([])
    expect(getNoteObligation(item.uid)).toBeDefined()
  })

  it('#744 releases only the same obligation object after a proved save', async () => {
    const { account, collection, item, base } = await shownSavedNote()
    const captured = markNoteObligation(item.uid)

    const saved = await useNoteStore.getState().updateNote(item.uid, { title: EDIT_TITLE, content: FIRST_BODY }, { base, obligation: captured } as any)

    // 744 wired boundary
    expect([saved, getNoteObligation(item.uid)]).toEqual([true, undefined])

    expect(await serverText(account, collection, item.uid)).toBe(FIRST_BODY)
    const olderCapture = {}
    const installed = markNoteObligation(item.uid)
    const next = await useNoteStore.getState().updateNote(
      item.uid,
      { title: EDIT_TITLE, content: SECOND_BODY },
      { base: { title: EDIT_TITLE, content: FIRST_BODY, revision: null }, obligation: olderCapture } as any,
    )
    expect(next).toBe(true)
    expect(getNoteObligation(item.uid)).toBe(installed)
  })

  it('#744 obliges a mounted note after this context writes its sealed edit, even once the queue is empty', async () => {
    const { item, base } = await shownSavedNote()
    const editor = { periodGen: () => 0, isClean: () => true, chainIdle: () => true, base: () => base, flushAndWait: async () => {} }
    const unregister = registerNoteEditor(item.uid, editor)
    server.offline = true
    expect(await useNoteStore.getState().updateNote(item.uid, { title: EDIT_TITLE, content: RETAINED_BODY }, { base })).toBe(true)
    server.offline = false
    expect(getNoteObligation(item.uid)).toBeUndefined()
    const guard = { accountEpoch: getAccountEpoch(), accountFingerprint: FINGERPRINT }

    await replay((queued, checkpoint) => useEtebaseStore.getState().replayQueuedMutation(queued, guard, checkpoint), guard)

    // 744 wired boundary
    expect(getNoteObligation(item.uid)).toBeDefined()

    expect(await readAllRecords('silentsuite-offline-queue', 'mutations')).toEqual([])
    unregister()
  })

  it('#744 does not oblige a mounted note when its replayed write is not the acknowledged record', async () => {
    const { item, base } = await shownSavedNote()
    const editor = { periodGen: () => 0, isClean: () => true, chainIdle: () => true, base: () => base, flushAndWait: async () => {} }
    const unregister = registerNoteEditor(item.uid, editor)
    server.offline = true
    expect(await useNoteStore.getState().updateNote(item.uid, { title: EDIT_TITLE, content: RETAINED_BODY }, { base })).toBe(true)
    server.offline = false
    const guard = { accountEpoch: getAccountEpoch(), accountFingerprint: FINGERPRINT }
    const [stub] = await getAll(guard)
    const hold = server.holdNext((method, path) => method === 'post' && path.endsWith('item/transaction'))
    const replaying = replay((queued, checkpoint) => useEtebaseStore.getState().replayQueuedMutation(queued, guard, checkpoint), guard)
    await hold.arrived
    // The record moves on before the replay's acknowledgement can land.
    expect(await replaceStub({ collectionType: 'notes', itemUid: item.uid }, { id: stub!.id, rev: stub!.rev }, { iv: [9], ct: [9] }, guard)).toBe(true)
    hold.release(false)
    await replaying

    // 744 wired boundary
    expect(getNoteObligation(item.uid)).toBeUndefined()

    expect((await getAll(guard)).map((entry) => entry.rev)).toEqual([2])
    unregister()
  })

  it('#744 never carries an obligation or an editor registration into another account epoch', async () => {
    const { item, base } = await shownSavedNote()
    const editor = { periodGen: () => 0, isClean: () => true, chainIdle: () => true, base: () => base, flushAndWait: async () => {} }
    markNoteObligation(item.uid)
    const unregisterOld = registerNoteEditor(item.uid, editor)
    bumpAccountEpoch()

    // 744 wired boundary
    expect(getNoteObligation(item.uid)).toBeUndefined()

    const unregisterNew = registerNoteEditor(item.uid, editor)
    unregisterOld()
    const { noteSealedWriteAccepted } = await import('../use-note-store')
    noteSealedWriteAccepted(item.uid)
    expect(getNoteObligation(item.uid)).toBeDefined()
    unregisterNew()
  })
})

describe('#1113 D1 conflicted copy title', () => {
  it('matches Android: the displayed title, Untitled when blank, and no second suffix', () => {
    expect(conflictCopyTitle('Groceries')).toBe('Groceries (conflicted copy)')
    expect(conflictCopyTitle('  Groceries  ')).toBe('Groceries (conflicted copy)')
    expect(conflictCopyTitle('')).toBe('Untitled (conflicted copy)')
    expect(conflictCopyTitle('   ')).toBe('Untitled (conflicted copy)')
    expect(conflictCopyTitle('Groceries (conflicted copy)')).toBe('Groceries (conflicted copy)')
    expect(conflictCopyTitle('Groceries(conflicted copy)')).toBe('Groceries(conflicted copy) (conflicted copy)')
  })
})

describe('#1113 D1 the note store refuses with a reason and saves copies once', () => {
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
    resetNoteLifecycle()
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    useNoteStore.setState({ notes: [] })
  })

  async function staleDraft() {
    const { account, collection, item } = await makeSavedNote(BASE_TITLE, BASE_BODY)
    server.seed(collection, [item])
    const peerItem = item._clone()
    await peerItem.setContent(PEER_BODY)
    await account.getCollectionManager().getItemManager(collection).transaction([peerItem])
    installNoteAccount(account, collection, item)
    useNotebookStore.setState({ lists: [{ id: collection.uid, name: 'Notebook 744', color: '#fff', visible: true, accessLevel: 2 }] } as any)
    const at = new Date(1000)
    useNoteStore.setState({
      notes: [{ id: item.uid, uid: item.uid, title: BASE_TITLE, content: BASE_BODY, notebookId: collection.uid, created_at: at, updated_at: at, revision: item.etag }],
    } as any)
    const held = {
      draft: { title: EDIT_TITLE, content: RETAINED_BODY },
      base: { title: BASE_TITLE, content: BASE_BODY, revision: item.etag as string },
      failed: 'changed' as const,
    }
    return { account, collection, item, peerItem, held }
  }

  async function liveTitles(account: any, collection: any): Promise<string[]> {
    const response = await account.getCollectionManager().getItemManager(collection).list()
    return response.data.filter((candidate: any) => !candidate.isDeleted).map((candidate: any) => candidate.getMeta().name)
  }

  it("refuses a save with 'changed' when the server copy moved on, and without a reason when it is missing", async () => {
    const { item, held } = await staleDraft()
    const reasons: unknown[] = []

    const saved = await useNoteStore.getState().updateNote(item.uid, held.draft, { base: held.base, onRefused: (reason) => reasons.push(reason) })
    const notFound = (url: string, options: any) => (
      String(options?.method ?? 'get').toLowerCase() === 'get' && new URL(url).pathname.split('/').filter(Boolean).at(-1) === item.uid
        ? respond(404, { detail: 'Not found.' })
        : server.handle(url, options)
    )
    EtebaseRequest.default = notFound
    const savedAgain = await useNoteStore.getState().updateNote(item.uid, held.draft, { base: held.base, onRefused: (reason) => reasons.push(reason) })

    expect([saved, savedAgain]).toEqual([false, false])
    expect(reasons).toEqual(['changed', undefined])
  })

  it('makes one copy for two calls while the first runs, and holds the text until it is confirmed', async () => {
    const { account, collection, item, held } = await staleDraft()
    const upload = server.holdNext((method, path) => method === 'post' && path.endsWith('item/transaction'))

    const first = useNoteStore.getState().saveNoteCopy(item.uid, held)
    const second = useNoteStore.getState().saveNoteCopy(item.uid, { ...held, draft: { title: 'OTHER', content: 'OTHER' } })
    await upload.arrived
    expect(getHeldNoteDraft(item.uid)?.copy).toBe('running')
    upload.release(false)
    const [a, b] = await Promise.all([first, second])

    expect(a).toEqual(b)
    expect(a.kind).toBe('copied')
    expect(await liveTitles(account, collection)).toEqual(expect.arrayContaining([BASE_TITLE, `${EDIT_TITLE} (conflicted copy)`]))
    expect((await liveTitles(account, collection)).filter((name) => name.endsWith('(conflicted copy)'))).toHaveLength(1)
    expect(getHeldNoteDraft(item.uid)).toBeUndefined()
    const copyId = (a as { id: string }).id
    // Published like a new note: the store, the item cache and the notebook maps.
    expect(useNoteStore.getState().notes.find((note) => note.id === copyId)).toMatchObject({
      title: `${EDIT_TITLE} (conflicted copy)`, content: RETAINED_BODY, notebookId: collection.uid,
    })
    const { itemCache, itemTypeMap, itemCollectionMap } = useEtebaseStore.getState()
    expect([itemCache.has(copyId), itemTypeMap.get(copyId), itemCollectionMap.get(copyId)]).toEqual([true, 'notes', collection.uid])
    expect(useNoteStore.getState().notes.find((note) => note.id === copyId)?.revision)
      .toBe((await account.getCollectionManager().getItemManager(collection).fetch(copyId)).etag)
  })

  it('keeps the attempt after a failure, so the retry re-sends the same item and confirms it', async () => {
    const { account, collection, item, held } = await staleDraft()
    let lose = true
    EtebaseRequest.default = async (url: string, options: any) => {
      const response = await server.handle(url, options)
      if (lose && String(options?.method).toLowerCase() === 'post' && url.includes('item/transaction')) {
        lose = false
        throw new TypeError('Network request failed')
      }
      return response
    }

    const failed = await useNoteStore.getState().saveNoteCopy(item.uid, held)
    const retried = await useNoteStore.getState().saveNoteCopy(item.uid, held)

    expect(failed).toEqual({ kind: 'failed', reason: 'unconfirmed' })
    expect(retried.kind).toBe('copied')
    const copies = server.transactions.filter((transaction) => transaction.items.some((sent) => sent.uid !== item.uid))
    expect(copies).toHaveLength(2)
    // The same item both times: one UID, one revision.
    expect(new Set(copies.map((transaction) => `${transaction.items[0].uid}|${transaction.items[0].content.uid}`)).size).toBe(1)
    expect((await liveTitles(account, collection)).filter((name) => name.endsWith('(conflicted copy)'))).toHaveLength(1)
  })

  it('drops the attempt and held text on the account reset, and a late result is not published', async () => {
    const { item, held } = await staleDraft()
    const upload = server.holdNext((method, path) => method === 'post' && path.endsWith('item/transaction'))
    const running = useNoteStore.getState().saveNoteCopy(item.uid, held)
    await upload.arrived

    bumpAccountEpoch()
    resetNoteLifecycle()
    upload.release(false)
    const result = await running

    expect(result).toEqual({ kind: 'stale' })
    expect(getHeldNoteDraft(item.uid)).toBeUndefined()
    expect(useNoteStore.getState().notes.filter((note) => note.title.endsWith('(conflicted copy)'))).toHaveLength(0)
  })
})
