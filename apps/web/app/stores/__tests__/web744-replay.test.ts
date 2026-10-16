// @vitest-environment node
import 'fake-indexeddb/auto'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetForTests as resetOfflineQueue, getAll, replay } from '@/app/lib/offline-queue'
import { _resetForTests as resetDataCache } from '@/app/lib/data-cache'
import { getAccountEpoch } from '@/app/lib/account-epoch'

const toastMock = vi.hoisted(() => ({ showErrorToast: vi.fn() }))
vi.mock('@/app/stores/use-toast-store', () => toastMock)
vi.mock('@/app/stores/use-label-suggestions-store', () => ({
  useLabelSuggestionsStore: { getState: () => ({ recordUsage: vi.fn() }) },
}))

import { useEtebaseStore } from '../use-etebase-store'

// The pinned Etebase 0.43.1 CJS build, resolved the way @silentsuite/core resolves it.
const requireFromCore = createRequire(new URL('../../../../../packages/core/package.json', import.meta.url))
const Etebase = requireFromCore('etebase')
const EtebaseRequest = requireFromCore('etebase/dist/lib-cjs/Request')
const { msgpackEncode, msgpackDecode } = requireFromCore('etebase/dist/lib-cjs/Helpers')

vi.setConfig({ testTimeout: 20_000 })

const FINGERPRINT = 'web744-replay-account'
const BASE_TITLE = 'Base title 744'
const BASE_BODY = 'BASE BODY R0 744'
const EDIT_TITLE = 'PRIVATE EDIT TITLE 744'
const EDIT_BODY = 'PRIVATE ACCEPTED OFFLINE BODY B 744'
const PEER_BODY = 'ACKNOWLEDGED PEER BODY A 744'

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
}

function stored(item: any) {
  return { uid: item.uid, version: item.version, encryptionKey: item.encryptionKey ?? null, content: item.content }
}

function respond(status: number, body: unknown) {
  return { type: 'default', status, statusText: '', ok: status >= 200 && status < 300, body: msgpackEncode(body) }
}

/**
 * External transport that follows the reference server's item rules: a
 * transaction checks each supplied dependency and each submitted item's etag,
 * and nothing else. A child write is not rejected just because its
 * collection was deleted; only a supplied main-item dependency does that.
 */
class ReferenceServer {
  offline = false
  transactions: { items: any[]; deps: any[] | undefined }[] = []
  unregistered: string[] = []
  private stoken = 1
  private collections = new Map<string, { collectionType: unknown; collectionKey: unknown; main: any; items: Map<string, any> }>()

  seed(collection: any, items: any[]) {
    const serialized = collection.encryptedCollection.serialize()
    this.collections.set(collection.uid, {
      collectionType: serialized.collectionType,
      collectionKey: serialized.collectionKey,
      main: stored(serialized.item),
      items: new Map(items.map((item) => [item.uid, stored(item.encryptedItem.serialize())])),
    })
  }

  private lookup(col: { main: any; items: Map<string, any> }, uid: string) {
    return uid === col.main.uid ? col.main : col.items.get(uid)
  }

  async handle(url: string, options: any = {}) {
    if (this.offline) throw new TypeError('Network request failed')
    const method = String(options.method ?? 'get').toLowerCase()
    const parts = new URL(url).pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'collection' && parts[3]) {
      const col = this.collections.get(parts[3])
      if (!col) return respond(404, { detail: 'Not found.' })
      const rest = parts.slice(4).join('/')
      if (method === 'get' && rest === '') {
        return respond(200, { item: col.main, collectionType: col.collectionType, collectionKey: col.collectionKey, accessLevel: 2, stoken: String(this.stoken) })
      }
      if (method === 'get' && rest === 'item') {
        return respond(200, { data: [...col.items.values()], stoken: String(this.stoken), done: true })
      }
      if (method === 'post' && rest === 'item/transaction') {
        const body = msgpackDecode(options.body)
        this.transactions.push({ items: body.items, deps: body.deps ?? undefined })
        for (const dep of body.deps ?? []) {
          const current = this.lookup(col, dep.uid)
          if (!current || current.content.uid !== dep.etag) return respond(409, { code: 'dep_failed', detail: 'Dependencies failed to validate' })
        }
        for (const item of body.items) {
          const current = this.lookup(col, item.uid)
          if (current ? current.content.uid !== item.etag : item.etag != null) return respond(409, { code: 'wrong_etag', detail: 'Wrong etag' })
        }
        for (const item of body.items) {
          if (item.uid === col.main.uid) col.main = stored(item)
          else col.items.set(item.uid, stored(item))
        }
        this.stoken += 1
        return respond(200, {})
      }
    }
    this.unregistered.push(`${method} ${url}`)
    return respond(500, { detail: 'unregistered request' })
  }
}

/** A real SDK account, notebook and saved note, built locally without any server. */
async function makeSavedNote(title: string, body: string) {
  await Etebase.ready
  const version = Etebase.CURRENT_VERSION
  const mainKey = Etebase.randomBytes(32)
  const accountContent = new Uint8Array(64)
  accountContent.set(Etebase.randomBytes(32), 0)
  accountContent.set(Etebase.randomBytes(32), 32)
  const account = new Etebase.Account(mainKey, version)
  account.user = {
    username: 'web744',
    email: 'web744@example.invalid',
    pubkey: new Uint8Array(32),
    encryptedContent: Etebase.getMainCryptoManager(mainKey, version).encrypt(accountContent),
  }
  account.serverUrl = 'https://etebase.invalid/'
  account.authToken = 'web744-token'
  const collectionManager = account.getCollectionManager()
  const collection = await collectionManager.create('etebase.md.note', { name: 'Notebook 744', mtime: 1 }, '')
  collection.encryptedCollection.__markSaved()
  const item = await collectionManager.getItemManager(collection).create({ name: title, mtime: 1 }, body)
  item.encryptedItem.__markSaved()
  return { account, collection, item }
}

function installNoteAccount(account: any, collection: any, item: any) {
  useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
  useEtebaseStore.setState({
    account,
    accountFingerprint: FINGERPRINT,
    collections: { calendar: [], tasks: [], contacts: [], notes: [collection], preferences: [] },
    itemCache: new Map([[item.uid, item]]),
    itemTypeMap: new Map([[item.uid, 'notes']]),
    itemCollectionMap: new Map([[item.uid, collection.uid]]),
    domainLoadState: { calendar: 'loaded', tasks: 'loaded', contacts: 'loaded', notes: 'loaded', preferences: 'unknown' },
    isInitialized: true,
    syncEngine: null,
  } as any)
}

function guard() {
  return { accountEpoch: getAccountEpoch(), accountFingerprint: FINGERPRINT }
}

async function serverText(account: any, collection: any, uid: string): Promise<string | null> {
  const response = await account.getCollectionManager().getItemManager(collection).list()
  const found = response.data.find((candidate: any) => candidate.uid === uid)
  if (!found) return null
  return new TextDecoder().decode(await found.getContent())
}

describe('#744 sealed note replay checks the original editing base', () => {
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

  async function admitOfflineEdit() {
    const { account, collection, item } = await makeSavedNote(BASE_TITLE, BASE_BODY)
    server.seed(collection, [item])
    const peerItem = item._clone()
    const baseRevision: string = item.etag
    installNoteAccount(account, collection, item)
    server.offline = true
    const outcome = await useEtebaseStore.getState().updateItem('notes', item.uid, EDIT_BODY, {
      meta: { name: EDIT_TITLE, mtime: 222 },
      persistEncryptedOfflineContent: true,
      collectionUid: collection.uid,
      sealIntent: 'note',
      base: { title: BASE_TITLE, content: BASE_BODY, revision: baseRevision },
    })
    server.offline = false
    expect(outcome).toBe('queued')
    const [stub] = await getAll(guard())
    expect(stub).toMatchObject({ type: 'sealed-update', itemUid: item.uid, rev: 1 })
    return { account, collection, item, peerItem, baseRevision, stub: stub! }
  }

  async function replayQueue() {
    const queueGuard = guard()
    return replay(
      (queued, checkpoint) => useEtebaseStore.getState().replayQueuedMutation(queued, queueGuard, checkpoint),
      queueGuard,
    )
  }

  it('#744 holds B as base-changed and sends nothing when an unseen acknowledged A replaced the base', async () => {
    const { account, collection, item, peerItem, stub } = await admitOfflineEdit()

    // Another context, which never saw B, writes and acknowledges A at R0.
    await peerItem.setContent(PEER_BODY)
    await account.getCollectionManager().getItemManager(collection).transaction([peerItem])
    expect(await serverText(account, collection, item.uid)).toBe(PEER_BODY)
    const transactionsBeforeReplay = server.transactions.length

    await replayQueue()
    const entries = await getAll(guard())

    // 744 wired boundary
    expect(entries.map((entry) => entry.held)).toEqual(['base-changed'])

    expect(server.transactions.length).toBe(transactionsBeforeReplay)
    expect(await serverText(account, collection, item.uid)).toBe(PEER_BODY)
    expect(entries[0]!.id).toBe(stub.id)
    expect(entries[0]!.sealed).toEqual(stub.sealed)
    expect(entries[0]!.status).toBe('pending')
    expect(server.unregistered).toEqual([])
  })

  it('#744 writes B at the unchanged original base with the collection dependency and acknowledges that record', async () => {
    const { account, collection, item, baseRevision } = await admitOfflineEdit()

    const results = await replayQueue()

    // 744 wired boundary
    expect(await serverText(account, collection, item.uid)).toBe(EDIT_BODY)

    expect(results.map((result) => result.success)).toEqual([true])
    expect(await getAll(guard())).toEqual([])
    const sent = server.transactions.at(-1)!
    expect(sent.items.map((sentItem) => [sentItem.uid, sentItem.etag])).toEqual([[item.uid, baseRevision]])
    expect(sent.deps).toEqual([{ uid: collection.uid, etag: collection.etag }])
    expect(server.unregistered).toEqual([])
  })
})
