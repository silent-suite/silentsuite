// @vitest-environment node
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetForTests as resetOfflineQueue, getAll, getPendingCount, isQueueFull, replay } from '@/app/lib/offline-queue'
import { _resetForTests as resetDataCache, getItemsByType } from '@/app/lib/data-cache'

const toastMock = vi.hoisted(() => ({ showErrorToast: vi.fn() }))
vi.mock('@/app/stores/use-toast-store', () => toastMock)
vi.mock('@/app/stores/use-label-suggestions-store', () => ({
  useLabelSuggestionsStore: { getState: () => ({ recordUsage: vi.fn() }) },
}))

import { useEtebaseStore } from '../use-etebase-store'
import {
  EtebaseRequest,
  FINGERPRINT,
  ReferenceServer,
  deleteDatabase,
  installNoteAccount,
  makeSavedNote,
  queueGuard,
  serverText,
} from './web744-sdk-fixture'

vi.setConfig({ testTimeout: 20_000 })

const BASE_TITLE = 'Base title 744'
const BASE_BODY = 'BASE BODY R0 744'
const PEER_BODY = 'ACKNOWLEDGED PEER BODY A 744'
const EDIT_TITLE = 'PRIVATE EDIT TITLE 744'
const EDIT_BODY = 'PRIVATE RETAINED DRAFT B 744'
const DESCENDANT_BODY = 'PRIVATE DESCENDANT B2 744'
const STALE_PEER_BODY = 'STALE PEER DRAFT ON R0 744'
const UNRELATED_BODY = 'UNRELATED LATER EDIT C 744'

describe('#744 sealed-intent note saves dispatch only at the captured editing base', () => {
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
  })

  afterEach(() => {
    EtebaseRequest.default = originalRequest
    if (onLineDescriptor) Object.defineProperty(globalThis.navigator, 'onLine', onLineDescriptor)
    else delete (globalThis.navigator as any).onLine
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
  })

  /** R0 on the server, then another context writes and acknowledges A at R0. */
  async function noteWithAcknowledgedPeerEdit() {
    const { account, collection, item } = await makeSavedNote(BASE_TITLE, BASE_BODY)
    server.seed(collection, [item])
    const baseRevision: string = item.etag
    const peerItem = item._clone()
    await peerItem.setContent(PEER_BODY)
    await account.getCollectionManager().getItemManager(collection).transaction([peerItem])
    const peerRevision: string = peerItem.etag
    expect(peerItem.encryptedItem.lastEtag).toBe(peerRevision)
    return { account, collection, item, peerItem, baseRevision, peerRevision }
  }

  function saveRetainedDraft(itemUid: string, collectionUid: string, base: { title: string; content: string; revision: string | null }, callbacks: { onSaved?: (etag: string) => void; onRefused?: () => void } = {}) {
    return useEtebaseStore.getState().updateItem('notes', itemUid, EDIT_BODY, {
      meta: { name: EDIT_TITLE, mtime: 333 },
      persistEncryptedOfflineContent: true,
      collectionUid,
      sealIntent: 'note',
      base,
      ...callbacks,
    } as any)
  }

  it('#744 refuses a retained R0 draft when the cache already holds acknowledged A, and A stays', async () => {
    const { account, collection, item, peerItem, baseRevision } = await noteWithAcknowledgedPeerEdit()
    installNoteAccount(account, collection, peerItem)
    const onRefused = vi.fn()
    const onSaved = vi.fn()

    const outcome = await saveRetainedDraft(item.uid, collection.uid, { title: BASE_TITLE, content: BASE_BODY, revision: baseRevision }, { onRefused, onSaved })

    // 744 wired boundary
    expect(outcome).toBe(false)

    expect(await serverText(account, collection, item.uid)).toBe(PEER_BODY)
    expect(onRefused).toHaveBeenCalledTimes(1)
    expect(onSaved).not.toHaveBeenCalled()
    expect(await getAll(queueGuard())).toEqual([])
    expect(server.unregistered).toEqual([])
  })

  it('#744 saves a new edit typed on A through a clone and reports the saved etag', async () => {
    const { account, collection, item, peerItem, peerRevision } = await noteWithAcknowledgedPeerEdit()
    installNoteAccount(account, collection, peerItem)
    const onSaved = vi.fn()
    const onRefused = vi.fn()

    const outcome = await saveRetainedDraft(item.uid, collection.uid, { title: BASE_TITLE, content: PEER_BODY, revision: peerRevision }, { onSaved, onRefused })

    expect(outcome).toBe('remote')
    expect(await serverText(account, collection, item.uid)).toBe(EDIT_BODY)
    // 744 wired boundary
    expect([peerItem.etag, peerItem.encryptedItem.lastEtag]).toEqual([peerRevision, peerRevision])

    const published = useEtebaseStore.getState().itemCache.get(item.uid)
    expect(published).not.toBe(peerItem)
    expect(onSaved).toHaveBeenCalledWith(published.encryptedItem.lastEtag)
    expect(onRefused).not.toHaveBeenCalled()
    expect(await getAll(queueGuard())).toEqual([])
  })

  it('#744 refuses offline admission when the current cache already holds a newer revision than the base', async () => {
    const { account, collection, item, peerItem, baseRevision } = await noteWithAcknowledgedPeerEdit()
    installNoteAccount(account, collection, peerItem)
    server.offline = true
    const onRefused = vi.fn()

    const outcome = await saveRetainedDraft(item.uid, collection.uid, { title: BASE_TITLE, content: BASE_BODY, revision: baseRevision }, { onRefused })

    // 744 wired boundary
    expect(outcome).toBe(false)

    expect(await getAll(queueGuard())).toEqual([])
    expect(await getItemsByType('notes')).toEqual([])
    expect(onRefused).toHaveBeenCalledTimes(1)
  })

  it('#744 refuses offline admission when A is published while the dispatch is in flight', async () => {
    const { account, collection, item, peerItem, baseRevision } = await noteWithAcknowledgedPeerEdit()
    installNoteAccount(account, collection, item)
    const hold = server.holdNext()
    const pending = saveRetainedDraft(item.uid, collection.uid, { title: BASE_TITLE, content: BASE_BODY, revision: baseRevision })
    await hold.arrived
    // A refresh in this context publishes A while the save is still waiting.
    useEtebaseStore.setState({ itemCache: new Map([[item.uid, peerItem]]) })
    server.offline = true
    hold.release(true)

    const outcome = await pending

    // 744 wired boundary
    expect(outcome).toBe(false)

    expect(await getAll(queueGuard())).toEqual([])
    expect(await getItemsByType('notes')).toEqual([])
  })

  it('#744 never admits offline after a known conflict whose live proof then fails on the network', async () => {
    const { account, collection, item, baseRevision } = await noteWithAcknowledgedPeerEdit()
    installNoteAccount(account, collection, item)
    server.offlineAfterConflict = true

    const outcome = await saveRetainedDraft(item.uid, collection.uid, { title: BASE_TITLE, content: BASE_BODY, revision: baseRevision })

    // 744 wired boundary
    expect(outcome).toBe(false)

    expect(await getAll(queueGuard())).toEqual([])
    server.offline = false
    expect(await serverText(account, collection, item.uid)).toBe(PEER_BODY)
  })

  it('#744 still accepts an ordinary offline edit while the cache holds the unchanged base', async () => {
    const { account, collection, item } = await makeSavedNote(BASE_TITLE, BASE_BODY)
    server.seed(collection, [item])
    installNoteAccount(account, collection, item)
    server.offline = true

    const outcome = await saveRetainedDraft(item.uid, collection.uid, { title: BASE_TITLE, content: BASE_BODY, revision: item.etag })

    // 744 wired boundary
    expect(outcome).toBe('queued')

    const entries = await getAll(queueGuard())
    expect(entries.map((entry) => [entry.type, entry.itemUid, entry.rev])).toEqual([['sealed-update', item.uid, 1]])
  })
})

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

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Decrypt a raw queue record with the persisted envelope key and its identity as associated data. */
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

describe('#744 a queued note edit is replaced only by its own descendant', () => {
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
  })

  afterEach(() => {
    vi.restoreAllMocks()
    EtebaseRequest.default = originalRequest
    if (onLineDescriptor) Object.defineProperty(globalThis.navigator, 'onLine', onLineDescriptor)
    else delete (globalThis.navigator as any).onLine
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
  })

  function saveNote(
    itemUid: string,
    collectionUid: string,
    body: string,
    base: { title: string; content: string; revision: string | null },
    callbacks: { onSaved?: (etag: string) => void; onRefused?: () => void } = {},
  ) {
    return useEtebaseStore.getState().updateItem('notes', itemUid, body, {
      meta: { name: EDIT_TITLE, mtime: 444 },
      persistEncryptedOfflineContent: true,
      collectionUid,
      sealIntent: 'note',
      base,
      ...callbacks,
    } as any)
  }

  /** Accept B1 offline on R0 and return its raw record. */
  async function admitB1() {
    const { account, collection, item } = await makeSavedNote(BASE_TITLE, BASE_BODY)
    server.seed(collection, [item])
    installNoteAccount(account, collection, item)
    const baseRevision: string = item.etag
    server.offline = true
    const outcome = await saveNote(item.uid, collection.uid, EDIT_BODY, { title: BASE_TITLE, content: BASE_BODY, revision: baseRevision })
    server.offline = false
    expect(outcome).toBe('queued')
    const [stub] = await readAllRecords('silentsuite-offline-queue', 'mutations')
    return { account, collection, item, baseRevision, stub }
  }

  function replayQueue() {
    const guard = queueGuard()
    return replay((queued, checkpoint) => useEtebaseStore.getState().replayQueuedMutation(queued, guard, checkpoint), guard)
  }

  it('#744 replaces the accepted B1 record with B2 typed on it, keeping the original base proof', async () => {
    const { item, collection, baseRevision, stub } = await admitB1()
    server.offline = true

    const outcome = await saveNote(item.uid, collection.uid, DESCENDANT_BODY, { title: EDIT_TITLE, content: EDIT_BODY, revision: null })

    // 744 wired boundary
    expect(outcome).toBe('queued')

    const records = await readAllRecords('silentsuite-offline-queue', 'mutations')
    expect(records).toHaveLength(1)
    const replaced = records[0]
    expect([replaced.id, replaced.rev, replaced.createdAt, replaced.held, replaced.retryCount, replaced.status])
      .toEqual([stub.id, 2, stub.createdAt, undefined, 0, 'pending'])
    expect(await openRawStub(replaced)).toEqual({
      v: 1,
      kind: 'note',
      body: { content: DESCENDANT_BODY, meta: { name: EDIT_TITLE, mtime: 444 } },
      base: { revision: baseRevision, digest: await sha256Hex(JSON.stringify(['note', BASE_TITLE, BASE_BODY])) },
      prior: [await sha256Hex(JSON.stringify(['note', EDIT_TITLE, EDIT_BODY]))],
    })
  })

  it('#744 refuses a retained stale R0 draft, online, while B1 is in custody and sends nothing', async () => {
    const { account, collection, item, baseRevision, stub } = await admitB1()
    const onRefused = vi.fn()
    const transactionsBefore = server.transactions.length

    const outcome = await saveNote(item.uid, collection.uid, STALE_PEER_BODY, { title: BASE_TITLE, content: BASE_BODY, revision: baseRevision }, { onRefused })

    // 744 wired boundary
    expect(outcome).toBe(false)

    expect(onRefused).toHaveBeenCalledTimes(1)
    expect(server.transactions.length).toBe(transactionsBefore)
    expect(await serverText(account, collection, item.uid)).toBe(BASE_BODY)
    const [after] = await readAllRecords('silentsuite-offline-queue', 'mutations')
    expect([after.id, after.rev, after.sealed]).toEqual([stub.id, stub.rev, stub.sealed])
  })

  it('#744 keeps B2 when it replaces B1 between the replay write and its acknowledgement, then writes B2', async () => {
    const { account, collection, item } = await admitB1()
    const hold = server.holdNext((method, path) => method === 'post' && path.endsWith('item/transaction'))
    const firstReplay = replayQueue()
    await hold.arrived
    // B2 is typed on B1 while replay's write of B1 is in flight.
    const outcome = await saveNote(item.uid, collection.uid, DESCENDANT_BODY, { title: EDIT_TITLE, content: EDIT_BODY, revision: null })
    hold.release(false)
    await firstReplay
    const afterFirst = await readAllRecords('silentsuite-offline-queue', 'mutations')
    const serverAfterFirst = await serverText(account, collection, item.uid)

    await replayQueue()

    // 744 wired boundary
    expect(await serverText(account, collection, item.uid)).toBe(DESCENDANT_BODY)

    expect(outcome).toBe('queued')
    expect(serverAfterFirst).toBe(EDIT_BODY)
    expect(afterFirst.map((record) => record.rev)).toEqual([2])
    expect(await readAllRecords('silentsuite-offline-queue', 'mutations')).toEqual([])
  })

  it('#744 holds B after a lost acknowledgement when an unrelated C later replaced it, and C stays', async () => {
    const { account, collection, item } = await admitB1()
    const originalDelete = IDBObjectStore.prototype.delete
    let failures = 0
    vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
      if (this.name === 'mutations' && failures === 0) {
        failures += 1
        throw new DOMException('acknowledgement storage failed', 'UnknownError')
      }
      return originalDelete.call(this, key)
    })
    await replayQueue()
    vi.restoreAllMocks()
    expect(failures).toBe(1)
    expect(await serverText(account, collection, item.uid)).toBe(EDIT_BODY)

    const itemManager = account.getCollectionManager().getItemManager(collection)
    const latest = await itemManager.fetch(item.uid)
    await latest.setContent(UNRELATED_BODY)
    await itemManager.transaction([latest])

    await replayQueue()
    const records = await readAllRecords('silentsuite-offline-queue', 'mutations')

    // 744 wired boundary
    expect(records.map((record) => record.held)).toEqual(['base-changed'])

    expect(await serverText(account, collection, item.uid)).toBe(UNRELATED_BODY)
  })

  it('#744 counts a pending sealed record as pending and a held one as neither pending nor queue capacity', async () => {
    const { account, collection, item } = await admitB1()
    expect(await getPendingCount(queueGuard())).toBe(1)

    // Another context changes the note, so replay holds B1 instead of writing it.
    const itemManager = account.getCollectionManager().getItemManager(collection)
    const latest = await itemManager.fetch(item.uid)
    await latest.setContent(UNRELATED_BODY)
    await itemManager.transaction([latest])
    await replayQueue()
    const records = await readAllRecords('silentsuite-offline-queue', 'mutations')
    expect(records.map((record) => record.held)).toEqual(['base-changed'])

    const pendingAfterHold = await getPendingCount(queueGuard())

    // 744 wired boundary
    expect(pendingAfterHold).toBe(0)

    expect(await isQueueFull(queueGuard())).toBe(false)
  })
})
