// @vitest-environment node
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetForTests as resetOfflineQueue,
  casStub,
  getAll,
  insertIfNoOutstanding,
  replay,
} from '@/app/lib/offline-queue'
import { getAccountEpoch } from '@/app/lib/account-epoch'
import {
  _resetForTests as resetDataCache,
  ensureEncryptedEnvelope,
  ensureFingerprint,
  sealQueuePayload,
  sealedPayloadDigest,
} from '@/app/lib/data-cache'

const toastMock = vi.hoisted(() => ({ showErrorToast: vi.fn() }))
vi.mock('@/app/stores/use-toast-store', () => toastMock)
vi.mock('@/app/stores/use-label-suggestions-store', () => ({
  useLabelSuggestionsStore: { getState: () => ({ recordUsage: vi.fn() }) },
}))

import { useEtebaseStore } from '../use-etebase-store'
import {
  getHeldNoteDraft,
  holdNoteDraft,
  releaseHeldNoteDraft,
  reopenHeldNoteText,
  resetNoteLifecycle,
  settleNoteTextForCount,
  useNoteStore,
  type HeldNoteDraft,
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
  queueGuard,
  serverText,
} from './web744-sdk-fixture'

vi.setConfig({ testTimeout: 20_000 })

const BASE_TITLE = 'Base title 1113'
const BASE_BODY = 'BASE BODY R0 1113'
const PEER_BODY = 'PEER BODY A 1113'
const DRAFT_TITLE = 'PRIVATE REFUSED TITLE 1113'
const DRAFT_BODY = 'PRIVATE REFUSED BODY 1113'
const COPY_TITLE = `${DRAFT_TITLE} (conflicted copy)`

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

async function openRecord(record: any, fingerprint = FINGERPRINT): Promise<any | null> {
  const [key] = await readAllRecords('silentsuite-data-cache', 'crypto')
  if (!record?.sealed || !(key instanceof CryptoKey)) return null
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: Uint8Array.from(record.sealed.iv), additionalData: new TextEncoder().encode(`${fingerprint}|notes|${record.itemUid}`) },
      key,
      Uint8Array.from(record.sealed.ct),
    )
    return JSON.parse(new TextDecoder().decode(plaintext))
  } catch {
    return null
  }
}

describe('#1113 D1 refused note text kept in a sealed record', () => {
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

  afterEach(async () => {
    await settleNoteTextForCount()
    EtebaseRequest.default = originalRequest
    resetNoteLifecycle()
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    useNoteStore.setState({ notes: [] })
  })

  function showServerRow(collection: any, item: any, content: string) {
    useNotebookStore.setState({ lists: [{ id: collection.uid, name: 'Notebook 1113', color: '#fff', visible: true, accessLevel: 2 }] } as any)
    const at = new Date(1000)
    useNoteStore.setState({
      notes: [{ id: item.uid, uid: item.uid, title: BASE_TITLE, content, notebookId: collection.uid, created_at: at, updated_at: at, revision: item.etag }],
    } as any)
  }

  /** A note whose save of the draft typed on R0 the server refused after a peer wrote A, held as the editor holds it. */
  async function refusedText() {
    const { account, collection, item } = await makeSavedNote(BASE_TITLE, BASE_BODY)
    server.seed(collection, [item])
    const peerItem = item._clone()
    await peerItem.setContent(PEER_BODY)
    await account.getCollectionManager().getItemManager(collection).transaction([peerItem])
    installNoteAccount(account, collection, peerItem)
    showServerRow(collection, peerItem, PEER_BODY)
    const base = { title: BASE_TITLE, content: BASE_BODY, revision: item.etag as string }
    const reasons: unknown[] = []
    const saved = await useNoteStore.getState().updateNote(item.uid, { title: DRAFT_TITLE, content: DRAFT_BODY }, {
      base,
      onRefused: (reason) => reasons.push(reason),
    })
    expect([saved, reasons]).toEqual([false, ['changed']])
    holdNoteDraft(item.uid, { draft: { title: DRAFT_TITLE, content: DRAFT_BODY }, base, failed: 'changed' })
    await settleNoteTextForCount()
    return { account, collection, item, peerItem, base }
  }

  /** A reload: this page's memory is gone, the account, its queue and its key stay. */
  async function reload(collection: any, peerItem: any) {
    // The page's own record writes end with it.
    await settleNoteTextForCount()
    resetNoteLifecycle()
    showServerRow(collection, peerItem, PEER_BODY)
    await reopenHeldNoteText()
  }

  async function liveCopies(account: any, collection: any): Promise<any[]> {
    const response = await account.getCollectionManager().getItemManager(collection).list()
    return response.data.filter((candidate: any) => !candidate.isDeleted && candidate.getMeta().name === COPY_TITLE)
  }

  /** Loses the response to the next copy upload; the copy still lands. */
  function loseNextCopyResponse(itemUid: string): void {
    let lose = true
    EtebaseRequest.default = async (url: string, options: any) => {
      const response = await server.handle(url, options)
      if (lose && String(options?.method).toLowerCase() === 'post' && url.includes('item/transaction')) {
        lose = false
        throw new TypeError('Network request failed')
      }
      return response
    }
    void itemUid
  }

  it('stores refused text as one sealed v2 record held as base-changed, with no plaintext outside the seal', async () => {
    const { item } = await refusedText()

    const records = await getAll(queueGuard())
    expect(records.map((record) => [record.type, record.itemUid, record.held, record.status])).toEqual([
      ['sealed-update', item.uid, 'base-changed', 'pending'],
    ])
    const opened = await openRecord(records[0])
    expect(opened).toMatchObject({ v: 2, kind: 'note', body: { content: DRAFT_BODY, meta: { name: DRAFT_TITLE } }, base: { revision: item.etag } })
    expect(opened.base.digest).toBe(await sealedPayloadDigest(['note', BASE_TITLE, BASE_BODY]))
    const raw = JSON.stringify(await readAllRecords('silentsuite-offline-queue', 'mutations'))
    expect(raw).not.toContain(DRAFT_BODY)
    expect(raw).not.toContain(DRAFT_TITLE)
  })

  it('reopens the text after a reload, with the reason and a digest-only base, and saves it as a copy', async () => {
    const { account, collection, item, peerItem } = await refusedText()

    await reload(collection, peerItem)

    const reopened = getHeldNoteDraft(item.uid)
    expect(reopened).toMatchObject({
      draft: { title: DRAFT_TITLE, content: DRAFT_BODY },
      failed: 'unproved',
      base: { revision: item.etag, digestOnly: await sealedPayloadDigest(['note', BASE_TITLE, BASE_BODY]) },
    })
    const copied = await useNoteStore.getState().saveNoteCopy(item.uid, reopened!)
    await settleNoteTextForCount()

    expect(copied.kind).toBe('copied')
    const copies = await liveCopies(account, collection)
    expect(copies).toHaveLength(1)
    expect(new TextDecoder().decode(await copies[0].getContent())).toBe(DRAFT_BODY)
    // A confirmed copy deletes the record.
    expect(await getAll(queueGuard())).toEqual([])
    expect(getHeldNoteDraft(item.uid)).toBeUndefined()
  })

  it('makes exactly one copy when the copy response was lost, the page reloaded and the copy is made again', async () => {
    const { account, collection, item, peerItem } = await refusedText()
    loseNextCopyResponse(item.uid)
    expect(await useNoteStore.getState().saveNoteCopy(item.uid, getHeldNoteDraft(item.uid)!)).toEqual({ kind: 'failed', reason: 'unconfirmed' })
    expect(await liveCopies(account, collection)).toHaveLength(1)
    EtebaseRequest.default = (url: string, options: unknown) => server.handle(url, options)

    await reload(collection, peerItem)
    const reopened = getHeldNoteDraft(item.uid)
    expect(reopened?.copy).toBe('unconfirmed')
    const again = await useNoteStore.getState().saveNoteCopy(item.uid, reopened!)

    expect(again.kind).toBe('copied')
    const copies = await liveCopies(account, collection)
    expect(copies).toHaveLength(1)
    expect((again as { id: string }).id).toBe(copies[0].uid)
  })

  it('stores the prepared copy in the record before the copy is sent', async () => {
    const { item } = await refusedText()
    const upload = server.holdNext((method, path) => method === 'post' && path.endsWith('item/transaction'))

    const running = useNoteStore.getState().saveNoteCopy(item.uid, getHeldNoteDraft(item.uid)!)
    await upload.arrived
    const [record] = await getAll(queueGuard())
    const opened = await openRecord(record)
    upload.release(false)
    await running

    const sent = server.transactions.at(-1)!.items[0]
    expect(opened.copy).toMatchObject({ uid: sent.uid, revision: sent.content.uid })
    expect(typeof opened.copy.item).toBe('string')
  })

  it('refuses reopened text without a reason once the server moved on from its base revision, and keeps it', async () => {
    const { account, collection, item, peerItem } = await refusedText()
    await reload(collection, peerItem)
    const reopened = getHeldNoteDraft(item.uid)!

    // The server moved on from the base: refused without proof either way, and the text stays.
    const reasons: unknown[] = []
    const saved = await useNoteStore.getState().updateNote(item.uid, reopened.draft, { base: reopened.base, onRefused: (reason) => reasons.push(reason) })

    expect([saved, reasons]).toEqual([false, [undefined]])
    expect(await serverText(account, collection, item.uid)).toBe(PEER_BODY)
    expect(await getAll(queueGuard())).toHaveLength(1)
  })

  it('sends no copy when the text\'s record moved on and the copy cannot be stored with it', async () => {
    const { account, collection, item } = await refusedText()
    const [record] = await getAll(queueGuard())
    // Another writer (another tab, the banner) changed the record since this page wrote it.
    expect(await casStub(record!.id, record!.rev, { retryCount: 1 }, queueGuard())).toBe(true)
    const before = server.transactions.length

    const result = await useNoteStore.getState().saveNoteCopy(item.uid, getHeldNoteDraft(item.uid)!)

    expect(result).toEqual({ kind: 'failed', reason: 'unconfirmed' })
    expect(server.transactions.length).toBe(before)
    expect(await liveCopies(account, collection)).toEqual([])
    expect(getHeldNoteDraft(item.uid)?.draft.content).toBe(DRAFT_BODY)
  })

  it('saves reopened text at its base revision when the server still has it, and deletes the record', async () => {
    const { account, collection, item } = await makeSavedNote(BASE_TITLE, BASE_BODY)
    server.seed(collection, [item])
    installNoteAccount(account, collection, item)
    showServerRow(collection, item, BASE_BODY)
    // A refusal that proved nothing: the server still has the base.
    holdNoteDraft(item.uid, {
      draft: { title: DRAFT_TITLE, content: DRAFT_BODY },
      base: { title: BASE_TITLE, content: BASE_BODY, revision: item.etag },
      failed: 'unproved',
    })
    await settleNoteTextForCount()
    resetNoteLifecycle()
    showServerRow(collection, item, BASE_BODY)
    await reopenHeldNoteText()
    const reopened = getHeldNoteDraft(item.uid)!
    expect(reopened.base.digestOnly).toBeDefined()

    let savedEtag: string | null = null
    const saved = await useNoteStore.getState().updateNote(item.uid, reopened.draft, { base: reopened.base, onSaved: (etag) => { savedEtag = etag } })
    // As the editor does once its save is accepted.
    releaseHeldNoteDraft(item.uid)
    await settleNoteTextForCount()

    expect(saved).toBe(true)
    expect(savedEtag).not.toBeNull()
    expect(await serverText(account, collection, item.uid)).toBe(DRAFT_BODY)
    expect(await getAll(queueGuard())).toEqual([])
  })

  it('lists reopened held text when the loaded list does not show its note', async () => {
    const { collection, item } = await refusedText()
    resetNoteLifecycle()
    useNoteStore.setState({ notes: [] })
    useEtebaseStore.setState({ domainLoadState: { ...useEtebaseStore.getState().domainLoadState, notes: 'unknown' } } as any)
    await reopenHeldNoteText()
    expect(useNoteStore.getState().notes).toEqual([])

    // The server no longer lists the note (deleted elsewhere).
    useNoteStore.getState().syncFromRemote([])

    expect(useNoteStore.getState().notes.map((note) => [note.id, note.title, note.content, note.notebookId]))
      .toEqual([[item.uid, DRAFT_TITLE, DRAFT_BODY, collection.uid]])
  })

  it('never opens or reopens another account\'s held records', async () => {
    const { collection, item, peerItem } = await refusedText()
    const [ours] = await getAll(queueGuard())
    // The same record under another account: its own fingerprint owns it and its seal binds it.
    const otherGuard = { accountEpoch: getAccountEpoch(), accountFingerprint: 'another-account-1113' }
    await casStub(ours!.id, ours!.rev, 'delete', queueGuard())
    expect(await insertIfNoOutstanding(
      { type: 'sealed-update', collectionType: 'notes', collectionUid: collection.uid, itemUid: item.uid, sealed: ours!.sealed, rev: 1, held: 'base-changed' },
      otherGuard,
    )).toBe(true)
    const sealedForOther = await sealQueuePayload(
      JSON.stringify(await openRecord(ours)),
      `another-account-1113|notes|${item.uid}`,
    )
    expect(await insertIfNoOutstanding(
      { type: 'sealed-update', collectionType: 'notes', collectionUid: collection.uid, itemUid: `${item.uid}-b`, sealed: sealedForOther!, rev: 1, held: 'base-changed' },
      queueGuard(),
    )).toBe(true)

    await reload(collection, peerItem)

    expect(getHeldNoteDraft(item.uid)).toBeUndefined()
    expect(getHeldNoteDraft(`${item.uid}-b`)).toBeUndefined()
    expect(useNoteStore.getState().notes.map((note) => note.id)).toEqual([item.uid])
  })

  it('replays a v1 record as before (guard)', async () => {
    const { account, collection, item } = await makeSavedNote(BASE_TITLE, BASE_BODY)
    server.seed(collection, [item])
    installNoteAccount(account, collection, item)
    showServerRow(collection, item, BASE_BODY)
    server.offline = true
    expect(await useNoteStore.getState().updateNote(item.uid, { title: DRAFT_TITLE, content: DRAFT_BODY }, {
      base: { title: BASE_TITLE, content: BASE_BODY, revision: item.etag },
    })).toBe(true)
    const [queued] = await getAll(queueGuard())
    expect((await openRecord(queued))?.v).toBe(1)
    server.offline = false

    await replay((entry, checkpoint) => useEtebaseStore.getState().replayQueuedMutation(entry, queueGuard(), checkpoint), queueGuard())

    expect(await serverText(account, collection, item.uid)).toBe(DRAFT_BODY)
    expect(await getAll(queueGuard())).toEqual([])
  })

  it('replays a v2 record that the user retried, ignoring its copy', async () => {
    const { account, collection, item, peerItem } = await refusedText()
    loseNextCopyResponse(item.uid)
    await useNoteStore.getState().saveNoteCopy(item.uid, getHeldNoteDraft(item.uid)!)
    await settleNoteTextForCount()
    EtebaseRequest.default = (url: string, options: unknown) => server.handle(url, options)
    // The peer puts the base back, then the user retries the record from the banner.
    const back = peerItem._clone()
    await back.setContent(BASE_BODY)
    await account.getCollectionManager().getItemManager(collection).transaction([back])
    const [record] = await getAll(queueGuard())
    expect((await openRecord(record))?.copy).toBeDefined()
    expect(await casStub(record!.id, record!.rev, { held: undefined, retryCount: 0 }, queueGuard())).toBe(true)

    await replay((entry, checkpoint) => useEtebaseStore.getState().replayQueuedMutation(entry, queueGuard(), checkpoint), queueGuard())

    expect(await serverText(account, collection, item.uid)).toBe(DRAFT_BODY)
    expect(await getAll(queueGuard())).toEqual([])
  })

  it('holds a record of a payload version this build does not know as unreadable, and keeps it (guard)', async () => {
    const { account, collection, item } = await makeSavedNote(BASE_TITLE, BASE_BODY)
    server.seed(collection, [item])
    installNoteAccount(account, collection, item)
    await ensureFingerprint(FINGERPRINT, getAccountEpoch())
    expect(await ensureEncryptedEnvelope(getAccountEpoch())).toBe(true)
    const future = {
      v: 3,
      kind: 'note',
      body: { content: DRAFT_BODY, meta: { name: DRAFT_TITLE, mtime: 1 } },
      base: { revision: item.etag, digest: await sealedPayloadDigest(['note', BASE_TITLE, BASE_BODY]) },
      prior: [],
    }
    const sealed = await sealQueuePayload(JSON.stringify(future), `${FINGERPRINT}|notes|${item.uid}`)
    expect(await insertIfNoOutstanding(
      { type: 'sealed-update', collectionType: 'notes', collectionUid: collection.uid, itemUid: item.uid, sealed: sealed!, rev: 1 },
      queueGuard(),
    )).toBe(true)

    await replay((entry, checkpoint) => useEtebaseStore.getState().replayQueuedMutation(entry, queueGuard(), checkpoint), queueGuard())

    expect((await getAll(queueGuard())).map((record) => record.held)).toEqual(['unreadable'])
    expect(await serverText(account, collection, item.uid)).toBe(BASE_BODY)
  })

  it('keeps a reopened held text when the page already holds newer text for the note', async () => {
    const { collection, item, base } = await refusedText()
    const newer: HeldNoteDraft = { draft: { title: DRAFT_TITLE, content: `${DRAFT_BODY} newer` }, base, failed: 'changed' }
    holdNoteDraft(item.uid, newer)
    await settleNoteTextForCount()

    await reopenHeldNoteText()

    expect(getHeldNoteDraft(item.uid)).toBe(newer)
    const opened = await openRecord((await getAll(queueGuard()))[0])
    expect([opened.body.content, collection.uid]).toEqual([`${DRAFT_BODY} newer`, collection.uid])
  })
})
