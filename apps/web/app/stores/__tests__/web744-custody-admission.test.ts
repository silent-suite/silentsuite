// @vitest-environment node
import 'fake-indexeddb/auto'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetForTests as resetOfflineQueue } from '@/app/lib/offline-queue'
import {
  CACHE_SCHEMA_VERSION,
  _resetForTests as resetDataCache,
  ensureFingerprint,
  getItemsByType,
  putMeta,
} from '@/app/lib/data-cache'

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

vi.setConfig({ testTimeout: 20_000 })

const FINGERPRINT = 'web744-custody-account'
const QUEUE_DB = 'silentsuite-offline-queue'
const CACHE_DB = 'silentsuite-data-cache'
const BASE_TITLE = 'Base title 744'
const BASE_BODY = 'BASE BODY R0 744'
const EDIT_TITLE = 'PRIVATE EDIT TITLE 744'
const EDIT_BODY = 'PRIVATE ACCEPTED OFFLINE BODY 744'

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
}

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

describe('#744 encrypted note custody admission through the real store', () => {
  const originalRequest = EtebaseRequest.default
  const onLineDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, 'onLine')
  let transportCalls: string[] = []

  beforeEach(async () => {
    await resetOfflineQueue()
    await resetDataCache()
    await deleteDatabase(QUEUE_DB)
    await deleteDatabase(CACHE_DB)
    toastMock.showErrorToast.mockReset()
    transportCalls = []
    // External transport fault: every SDK request fails the way the browser
    // XHR transport reports an unreachable server.
    EtebaseRequest.default = async (url: string) => {
      transportCalls.push(String(url))
      throw new TypeError('Network request failed')
    }
    Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, get: () => true })
  })

  afterEach(() => {
    EtebaseRequest.default = originalRequest
    if (onLineDescriptor) Object.defineProperty(globalThis.navigator, 'onLine', onLineDescriptor)
    else delete (globalThis.navigator as any).onLine
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
  })

  it('#744 keeps an accepted offline note edit and its editing-base proof in sealed queue custody across a schema-only cache reset', async () => {
    const { account, collection, item } = await makeSavedNote(BASE_TITLE, BASE_BODY)
    const baseRevision: string = item.etag
    expect(item.encryptedItem.lastEtag).toBe(baseRevision)
    installNoteAccount(account, collection, item)

    const outcome = await useEtebaseStore.getState().updateItem('notes', item.uid, EDIT_BODY, {
      meta: { name: EDIT_TITLE, mtime: 222 },
      persistEncryptedOfflineContent: true,
      collectionUid: collection.uid,
      sealIntent: 'note',
      base: { title: BASE_TITLE, content: BASE_BODY, revision: baseRevision },
    } as any)

    expect(transportCalls.length).toBeGreaterThan(0)
    expect(outcome).toBe('queued')
    expect(toastMock.showErrorToast).not.toHaveBeenCalled()

    // The #744 trigger: a schema-only reset of the display cache for the same account.
    await putMeta({ accountFingerprint: FINGERPRINT, cacheSchemaVersion: CACHE_SCHEMA_VERSION - 1, lastInvalidatedAt: null })
    expect(await ensureFingerprint(FINGERPRINT)).toBe(false)
    expect(await getItemsByType('notes')).toEqual([])

    const records = await readAllRecords(QUEUE_DB, 'mutations')
    const record = records.find((candidate) => candidate.itemUid === item.uid)
    const [persistedKey] = await readAllRecords(CACHE_DB, 'crypto')
    let recovered: unknown = null
    if (record?.sealed && persistedKey instanceof CryptoKey) {
      try {
        const plaintext = await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: Uint8Array.from(record.sealed.iv),
            additionalData: new TextEncoder().encode(`${FINGERPRINT}|notes|${item.uid}`),
          },
          persistedKey,
          Uint8Array.from(record.sealed.ct),
        )
        recovered = JSON.parse(new TextDecoder().decode(plaintext))
      } catch {
        recovered = null
      }
    }
    const baseDigest = await sha256Hex(JSON.stringify(['note', BASE_TITLE, BASE_BODY]))

    // 744 wired boundary
    expect(recovered).toEqual({
      v: 1,
      kind: 'note',
      body: { content: EDIT_BODY, meta: { name: EDIT_TITLE, mtime: 222 } },
      base: { revision: baseRevision, digest: baseDigest },
      prior: [],
    })

    expect(records).toHaveLength(1)
    expect(record).toMatchObject({
      type: 'sealed-update',
      status: 'pending',
      collectionType: 'notes',
      collectionUid: collection.uid,
      itemUid: item.uid,
      accountFingerprint: FINGERPRINT,
      rev: 1,
    })
    expect(record.content).toBeUndefined()
    const raw = JSON.stringify(records)
    for (const secret of [EDIT_BODY, EDIT_TITLE, BASE_BODY, BASE_TITLE, baseRevision, baseDigest]) {
      expect(raw).not.toContain(secret)
    }
  })
})
