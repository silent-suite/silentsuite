import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { _setEncryptedQueuePersistenceAvailableForTests, enqueue, getAll, getPendingCount, replay } from '@/app/lib/offline-queue'
import {
  _resetForTests as resetDataCache,
  _setEncryptedCacheAvailableForTests,
  _setEnvelopeKeyForTests,
  getMeta,
  getItemsByType,
} from '@/app/lib/data-cache'
import { bumpAccountEpoch } from '@/app/lib/account-epoch'
import { TEST_FINGERPRINT, bumpEpochWhenQueuePutRuns, changeAccountWhenQueuePutRuns, queueGuard, resetRealOfflineQueue } from './offline-queue-store-test-utils'

const coreMock = vi.hoisted(() => ({ createItem: vi.fn(), updateItem: vi.fn(), deleteItem: vi.fn(), listItems: vi.fn() }))
const toastMock = vi.hoisted(() => ({ showErrorToast: vi.fn() }))

vi.mock('@silentsuite/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@silentsuite/core')>(),
  ...coreMock,
}))
vi.mock('@/app/stores/use-toast-store', () => toastMock)
vi.mock('@/app/stores/use-label-suggestions-store', () => ({ useLabelSuggestionsStore: { getState: () => ({ recordUsage: vi.fn() }) } }))

import { useEtebaseStore } from '../use-etebase-store'
import { useSyncStore } from '../use-sync-store'
import { useContactStore } from '../use-contact-store'
import { useContactListStore } from '../use-contact-list-store'

// These tests exercise real fake-IndexedDB transactions and remote-replay
// reconciliation. Leave headroom for heavily loaded CI/review workers so a
// single timeout cannot cascade into later singleton-state assertions.
vi.setConfig({ testTimeout: 15_000 })

const offlineError = () => new TypeError('Failed to fetch')
const collection = (uid: string) => ({ uid, getMeta: vi.fn(() => ({})) })
const cachedItem = (uid: string) => ({ uid, isDeleted: false, delete: vi.fn(), getContent: vi.fn(async () => 'OLD') })
const remoteItem = (uid: string, content: string) => ({ uid, isDeleted: false, delete: vi.fn(), getContent: vi.fn(async () => content) })

function setAccount(options: {
  collections?: { uid: string }[]
  items?: { uid: string; collectionUid: string; item: any }[]
  manager?: { create: ReturnType<typeof vi.fn>; batch: ReturnType<typeof vi.fn> }
} = {}) {
  const collections = options.collections ?? [collection('col-1')]
  const manager = options.manager ?? { create: vi.fn(), batch: vi.fn() }
  const items = options.items ?? []
  useEtebaseStore.setState({
    account: { getCollectionManager: () => ({ getItemManager: () => manager }) } as any,
    accountFingerprint: TEST_FINGERPRINT,
    collections: { calendar: collections as any[], tasks: [], contacts: [], notes: [], preferences: [] },
    itemCache: new Map(items.map(({ uid, item }) => [uid, item])),
    itemTypeMap: new Map(items.map(({ uid }) => [uid, 'calendar' as const])),
    itemCollectionMap: new Map(items.map(({ uid, collectionUid }) => [uid, collectionUid])),
    domainLoadState: { calendar: 'loaded', tasks: 'loaded', contacts: 'loaded', notes: 'loaded', preferences: 'unknown' },
    isInitialized: true,
    syncEngine: null,
  } as any)
  return manager
}

function setNoteAccount(items: { uid: string; collectionUid: string; item: any }[] = []) {
  const notesCollection = collection('notes-1')
  useEtebaseStore.setState({
    account: { getCollectionManager: () => ({}) } as any,
    accountFingerprint: TEST_FINGERPRINT,
    collections: { calendar: [], tasks: [], contacts: [], notes: [notesCollection], preferences: [] },
    itemCache: new Map(items.map(({ uid, item }) => [uid, item])),
    itemTypeMap: new Map(items.map(({ uid }) => [uid, 'notes' as const])),
    itemCollectionMap: new Map(items.map(({ uid, collectionUid }) => [uid, collectionUid])),
    domainLoadState: { calendar: 'loaded', tasks: 'loaded', contacts: 'loaded', notes: 'loaded', preferences: 'unknown' },
    isInitialized: true,
    syncEngine: null,
  } as any)
  return notesCollection
}

async function readRawCacheItems(): Promise<unknown[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('silentsuite-data-cache')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await new Promise<unknown[]>((resolve, reject) => {
      const request = db.transaction('items', 'readonly').objectStore('items').getAll()
      request.onsuccess = () => resolve(request.result ?? [])
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

function switchAccountAtBoundary() {
  useEtebaseStore.setState({
    account: {} as any,
    accountFingerprint: 'new-account',
    itemCache: new Map([['new-item', cachedItem('new-item')]]),
    itemTypeMap: new Map([['new-item', 'calendar']]),
    itemCollectionMap: new Map([['new-item', 'new-col']]),
  })
}

function expectNewAccountStateUntouched() {
  expect([...useEtebaseStore.getState().itemCache.keys()]).toEqual(['new-item'])
  expect([...useEtebaseStore.getState().itemTypeMap.keys()]).toEqual(['new-item'])
  expect([...useEtebaseStore.getState().itemCollectionMap.entries()]).toEqual([['new-item', 'new-col']])
}

async function expectOwned(types: string[]) {
  const entries = await getAll(queueGuard())
  expect(entries.map((entry) => entry.type)).toEqual(types)
  expect(entries.every((entry) => entry.accountFingerprint === TEST_FINGERPRINT)).toBe(true)
  expect(await getPendingCount(queueGuard())).toBe(entries.length)
  const execute = vi.fn(async () => ({ remoteMutationConfirmed: true }))
  await replay(execute, queueGuard())
  expect(execute).toHaveBeenCalledTimes(entries.length)
  expect(await getAll(queueGuard())).toEqual([])
}

describe('useEtebaseStore real guarded offline queue integration', () => {
  beforeEach(async () => {
    await resetRealOfflineQueue()
    await resetDataCache()
    _setEnvelopeKeyForTests(await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']))
    _setEncryptedCacheAvailableForTests(true)
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    coreMock.createItem.mockReset()
    coreMock.updateItem.mockReset()
    coreMock.deleteItem.mockReset()
    coreMock.listItems.mockReset().mockResolvedValue({ items: [], stoken: null, done: true })
    toastMock.showErrorToast.mockReset()
  })

  it('persists and replays an offline favorite update from a cold cache without plaintext queue content', async () => {
    // Production leaves the general local-cache feature disabled. This
    // favorite-specific path must nevertheless create its encrypted envelope
    // and fingerprint from an empty IndexedDB database before it queues.
    await resetDataCache()
    _setEncryptedCacheAvailableForTests(true)
    vi.stubEnv('NEXT_PUBLIC_LOCAL_CACHE_ENABLED', '')
    expect(await getMeta()).toBeNull()
    setAccount({ items: [{ uid: 'item-1', collectionUid: 'col-1', item: cachedItem('item-1') }] })
    useEtebaseStore.setState({
      collections: { calendar: [], tasks: [], contacts: [collection('col-1')], notes: [], preferences: [] },
    } as any)
    useContactListStore.setState({
      lists: [{ id: 'col-1', name: 'Contacts', color: '#fff', visible: true, accessLevel: 2 }],
      activeListId: 'col-1',
    })
    useContactStore.setState({
      contacts: [{
        id: 'item-1', uid: 'contact-uid', displayName: 'PRIVATE FAVORITE',
        name: { prefix: '', given: 'PRIVATE', family: 'FAVORITE', suffix: '' },
        phones: [], emails: [], addresses: [], organization: '', title: '', notes: '',
        birthday: null, photoUrl: null, categories: [], favorite: false, listId: 'col-1',
        created_at: new Date(), updated_at: new Date(),
      }],
    })
    coreMock.updateItem.mockRejectedValueOnce(offlineError())
    try {
      await useContactStore.getState().setContactFavorite('item-1', true)
      expect(useContactStore.getState().contacts[0]!.favorite).toBe(true)

      const entries = await getAll(queueGuard())
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ type: 'update', itemUid: 'item-1', collectionUid: 'col-1' })
      expect(entries[0]!.content).toBeUndefined()
      expect(JSON.stringify(entries)).not.toContain('PRIVATE FAVORITE')
      const persistedContent = (await getItemsByType('contacts')).find((item) => item.itemUid === 'item-1')?.content
      expect(persistedContent).toContain('X-SILENTSUITE-FAVORITE:1')

      coreMock.updateItem.mockResolvedValueOnce(undefined)
      await useSyncStore.getState().replayOfflineQueue()
      expect(coreMock.updateItem).toHaveBeenLastCalledWith(
        useEtebaseStore.getState().account,
        expect.objectContaining({ uid: 'col-1' }),
        expect.objectContaining({ uid: 'item-1' }),
        persistedContent,
        undefined,
      )
      expect(await getAll(queueGuard())).toEqual([])
      expect((await getItemsByType('contacts')).find((item) => item.itemUid === 'item-1')?.content).toBe(persistedContent)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('replays an offline note update from the encrypted cache with a content-free queue entry', async () => {
    _setEncryptedQueuePersistenceAvailableForTests(false)
    const item = { ...cachedItem('note-1'), getMeta: vi.fn(() => ({ name: 'Old title', mtime: 1 })) }
    setNoteAccount([{ uid: 'note-1', collectionUid: 'notes-1', item }])
    coreMock.updateItem.mockRejectedValueOnce(offlineError()).mockResolvedValueOnce(item)

    await expect(useEtebaseStore.getState().updateItem(
      'notes',
      'note-1',
      'PRIVATE UPDATED BODY',
      { persistEncryptedOfflineContent: true, meta: { name: 'PRIVATE UPDATED TITLE', mtime: 222 } },
    )).resolves.toBe('queued')

    // Neither the queue nor the raw IndexedDB cache record holds plaintext.
    const [entry] = await getAll(queueGuard())
    expect(entry).toMatchObject({ type: 'update', itemUid: 'note-1', collectionUid: 'notes-1' })
    expect(entry!.content).toBeUndefined()
    expect(JSON.stringify(entry)).not.toContain('PRIVATE UPDATED')
    expect(JSON.stringify(await readRawCacheItems())).not.toContain('PRIVATE UPDATED')
    expect(JSON.parse((await getItemsByType('notes')).find((record) => record.itemUid === 'note-1')!.content))
      .toEqual({ title: 'PRIVATE UPDATED TITLE', content: 'PRIVATE UPDATED BODY', mtime: 222 })

    await replay(
      (queued, checkpoint) => useEtebaseStore.getState().replayQueuedMutation(queued, queueGuard(), checkpoint),
      queueGuard(),
    )
    expect(coreMock.updateItem).toHaveBeenLastCalledWith(
      useEtebaseStore.getState().account,
      expect.objectContaining({ uid: 'notes-1' }),
      item,
      'PRIVATE UPDATED BODY',
      { name: 'PRIVATE UPDATED TITLE', mtime: 222 },
    )
    expect(await getAll(queueGuard())).toEqual([])
  })

  it('queues an edit made after a reload while offline for a note known only from the cache, then replays it by fetching the item', async () => {
    _setEncryptedQueuePersistenceAvailableForTests(false)
    // Reload while offline: the session is restored, but no collections or item objects are in memory.
    setNoteAccount([])
    useEtebaseStore.setState({ collections: { calendar: [], tasks: [], contacts: [], notes: [], preferences: [] } })

    await expect(useEtebaseStore.getState().updateItem(
      'notes',
      'note-1',
      'EDITED AFTER RELOAD',
      { persistEncryptedOfflineContent: true, meta: { name: 'Cached title', mtime: 444 }, collectionUid: 'notes-1' },
    )).resolves.toBe('queued')
    expect(coreMock.updateItem).not.toHaveBeenCalled()

    const [entry] = await getAll(queueGuard())
    expect(entry).toMatchObject({ type: 'update', itemUid: 'note-1', collectionUid: 'notes-1' })
    expect(entry!.content).toBeUndefined()
    expect(JSON.stringify(entry)).not.toContain('EDITED AFTER RELOAD')
    expect(JSON.stringify(await readRawCacheItems())).not.toContain('EDITED AFTER RELOAD')

    // Back online: collections are listed again, but the item map stays empty until the replay fetches the item.
    const remote = { ...cachedItem('note-1'), getMeta: vi.fn(() => ({ name: 'Cached title', mtime: 1 })) }
    useEtebaseStore.setState({ collections: { calendar: [], tasks: [], contacts: [], notes: [collection('notes-1')], preferences: [] } })
    coreMock.listItems.mockResolvedValue({ items: [remote], stoken: null, done: true })
    coreMock.updateItem.mockResolvedValueOnce(remote)

    await replay(
      (queued, checkpoint) => useEtebaseStore.getState().replayQueuedMutation(queued, queueGuard(), checkpoint),
      queueGuard(),
    )
    expect(coreMock.updateItem).toHaveBeenCalledWith(
      useEtebaseStore.getState().account,
      expect.objectContaining({ uid: 'notes-1' }),
      remote,
      'EDITED AFTER RELOAD',
      { name: 'Cached title', mtime: 444 },
    )
    expect(await getAll(queueGuard())).toEqual([])
    expect(useEtebaseStore.getState().itemCache.get('note-1')).toBe(remote)
    expect(useEtebaseStore.getState().itemCollectionMap.get('note-1')).toBe('notes-1')
  })

  it('queues a delete for a cached note with no item in memory and replays it by fetching the item', async () => {
    setNoteAccount([])

    await expect(useEtebaseStore.getState().deleteItem('notes', 'note-1', { collectionUid: 'notes-1' })).resolves.toBe('queued')
    expect(coreMock.deleteItem).not.toHaveBeenCalled()
    expect((await getAll(queueGuard()))[0]).toMatchObject({ type: 'delete', itemUid: 'note-1', collectionUid: 'notes-1' })

    const remote = cachedItem('note-1')
    coreMock.listItems.mockResolvedValue({ items: [remote], stoken: null, done: true })
    coreMock.deleteItem.mockResolvedValueOnce(undefined)
    await replay(
      (queued, checkpoint) => useEtebaseStore.getState().replayQueuedMutation(queued, queueGuard(), checkpoint),
      queueGuard(),
    )
    expect(coreMock.deleteItem).toHaveBeenCalledWith(useEtebaseStore.getState().account, expect.objectContaining({ uid: 'notes-1' }), remote)
    expect(await getAll(queueGuard())).toEqual([])
  })

  it('drops queued note edits once a newer online update or a delete succeeds', async () => {
    const item = cachedItem('note-1')
    setNoteAccount([{ uid: 'note-1', collectionUid: 'notes-1', item }])
    await enqueue({ type: 'update', collectionType: 'notes', collectionUid: 'notes-1', itemUid: 'note-1' }, queueGuard())

    coreMock.updateItem.mockResolvedValueOnce(item)
    await expect(useEtebaseStore.getState().updateItem(
      'notes', 'note-1', 'NEWER BODY', { meta: { name: 'Newer title', mtime: 333 } },
    )).resolves.toBe('remote')
    expect(await getAll(queueGuard())).toEqual([])

    await enqueue({ type: 'update', collectionType: 'notes', collectionUid: 'notes-1', itemUid: 'note-1' }, queueGuard())
    coreMock.deleteItem.mockResolvedValueOnce(undefined)
    await expect(useEtebaseStore.getState().deleteItem('notes', 'note-1')).resolves.toBe('remote')
    expect(await getAll(queueGuard())).toEqual([])
    expect(useEtebaseStore.getState().itemCache.has('note-1')).toBe(false)
  })

  it('keeps the pending offline note edit when the collection is refreshed from the server', async () => {
    vi.stubEnv('NEXT_PUBLIC_LOCAL_CACHE_ENABLED', 'true')
    try {
      const item = { ...cachedItem('note-1'), getMeta: vi.fn(() => ({ name: 'Server title', mtime: 1 })) }
      const notesCollection = setNoteAccount([{ uid: 'note-1', collectionUid: 'notes-1', item }])
      const serverItem = { ...remoteItem('note-1', 'SERVER BODY'), getMeta: vi.fn(() => ({ name: 'Server title', mtime: 1 })) }
      useEtebaseStore.setState({
        account: {
          getCollectionManager: () => ({
            fetch: async () => notesCollection,
            getItemManager: () => ({ list: async () => ({ data: [serverItem], stoken: null, done: true }) }),
          }),
        } as any,
      })
      coreMock.updateItem.mockRejectedValueOnce(offlineError()).mockResolvedValueOnce(item)
      await expect(useEtebaseStore.getState().updateItem(
        'notes', 'note-1', 'OFFLINE BODY', { persistEncryptedOfflineContent: true, meta: { name: 'Offline title', mtime: 2 } },
      )).resolves.toBe('queued')

      await useEtebaseStore.getState().refreshCollection('notes')

      // The cache replace must not overwrite the queued edit with the stale server copy.
      expect(JSON.parse((await getItemsByType('notes')).find((record) => record.itemUid === 'note-1')!.content))
        .toMatchObject({ title: 'Offline title', content: 'OFFLINE BODY' })
      await replay(
        (queued, checkpoint) => useEtebaseStore.getState().replayQueuedMutation(queued, queueGuard(), checkpoint),
        queueGuard(),
      )
      expect(coreMock.updateItem).toHaveBeenLastCalledWith(
        useEtebaseStore.getState().account,
        expect.objectContaining({ uid: 'notes-1' }),
        expect.objectContaining({ uid: 'note-1' }),
        'OFFLINE BODY',
        { name: 'Offline title', mtime: 2 },
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('skips items with a non-empty type when refreshing a notebook', async () => {
    const notesCollection = setNoteAccount()
    const note = { ...remoteItem('note-1', 'BODY'), getMeta: vi.fn(() => ({ name: 'Note', mtime: 1 })) }
    const attachment = { ...remoteItem('att-1', 'BLOB'), getMeta: vi.fn(() => ({ name: 'file', type: 'attachment' })) }
    useEtebaseStore.setState({
      account: {
        getCollectionManager: () => ({
          fetch: async () => notesCollection,
          getItemManager: () => ({ list: async () => ({ data: [note, attachment], stoken: null, done: true }) }),
        }),
      } as any,
    })

    const items = await useEtebaseStore.getState().refreshCollection('notes')

    expect(items).toEqual([{ uid: 'note-1', content: 'BODY', collectionUid: 'notes-1', meta: { name: 'Note', mtime: 1 } }])
    expect(useEtebaseStore.getState().itemCache.has('att-1')).toBe(false)
  })

  it('real createItem fallback persists the active fingerprint and is visible to guarded count and replay', async () => {
    setAccount()
    coreMock.createItem.mockRejectedValueOnce(offlineError())
    await expect(useEtebaseStore.getState().createItem('calendar', 'VEVENT', 'temp-1', 'col-1')).resolves.toBeNull()
    await expectOwned(['create'])
  })

  it('real createItem fallback quietly cancels at the IndexedDB commit boundary', async () => {
    setAccount()
    coreMock.createItem.mockRejectedValueOnce(offlineError())
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const putSpy = bumpEpochWhenQueuePutRuns(switchAccountAtBoundary)
    try {
      await expect(useEtebaseStore.getState().createItem('calendar', 'OLD', 'temp-old', 'col-1')).resolves.toBeNull()
      expect(await getAll()).toEqual([])
      expectNewAccountStateUntouched()
      expect(errorSpy).not.toHaveBeenCalled()
      expect(toastMock.showErrorToast).not.toHaveBeenCalled()
    } finally {
      putSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })

  it('batch create fallback enqueues each create with the captured owner', async () => {
    const manager = setAccount()
    manager.create.mockRejectedValueOnce(offlineError())
    await useEtebaseStore.getState().createItemsBatch('calendar', [{ content: 'A', tempId: 'a' }, { content: 'B', tempId: 'b' }], 'col-1')
    await expectOwned(['create', 'create'])
  })

  it('batch create stops after a second put boundary and preserves the first committed create', async () => {
    const manager = setAccount()
    manager.create.mockRejectedValueOnce(offlineError())
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const putSpy = changeAccountWhenQueuePutRuns(switchAccountAtBoundary, { putNumber: 2 })
    try {
      await expect(useEtebaseStore.getState().createItemsBatch('calendar', [
        { content: 'A', tempId: 'a' }, { content: 'B', tempId: 'b' }, { content: 'C', tempId: 'c' },
      ], 'col-1')).resolves.toEqual([null, null, null])
      expect((await getAll()).map((entry) => entry.tempId)).toEqual(['a'])
      expectNewAccountStateUntouched()
      expect(errorSpy).not.toHaveBeenCalled()
      expect(toastMock.showErrorToast).not.toHaveBeenCalled()
    } finally { putSpy.mockRestore(); errorSpy.mockRestore() }
  })

  it.each([
    ['updateItem', async () => useEtebaseStore.getState().updateItem('calendar', 'item-1', 'NEW'), 'update'],
    ['deleteItem', async () => useEtebaseStore.getState().deleteItem('calendar', 'item-1'), 'delete'],
  ] as const)('%s cached offline fallback enqueues with the captured owner', async (_name, mutate, expectedType) => {
    setAccount({ items: [{ uid: 'item-1', collectionUid: 'col-1', item: cachedItem('item-1') }] })
    coreMock.updateItem.mockRejectedValueOnce(offlineError())
    coreMock.deleteItem.mockRejectedValueOnce(offlineError())
    await mutate()
    await expectOwned([expectedType])
  })

  it.each([
    ['updateItem', async () => useEtebaseStore.getState().updateItem('calendar', 'item-1', 'NEW'), false],
    ['deleteItem', async () => useEtebaseStore.getState().deleteItem('calendar', 'item-1'), false],
  ] as const)('%s quietly cancels at its real queue put boundary', async (_name, mutate, expectedResult) => {
    setAccount({ items: [{ uid: 'item-1', collectionUid: 'col-1', item: cachedItem('item-1') }] })
    coreMock.updateItem.mockRejectedValueOnce(offlineError())
    coreMock.deleteItem.mockRejectedValueOnce(offlineError())
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const putSpy = changeAccountWhenQueuePutRuns(switchAccountAtBoundary)
    try {
      await expect(mutate()).resolves.toBe(expectedResult)
      expect(await getAll()).toEqual([])
      expectNewAccountStateUntouched()
      expect(errorSpy).not.toHaveBeenCalled()
      expect(toastMock.showErrorToast).not.toHaveBeenCalled()
    } finally { putSpy.mockRestore(); errorSpy.mockRestore() }
  })

  it('collection clear fallback enqueues remaining source deletes with the captured owner', async () => {
    const manager = setAccount({ items: [
      { uid: 'item-1', collectionUid: 'col-1', item: cachedItem('item-1') },
      { uid: 'item-2', collectionUid: 'col-1', item: cachedItem('item-2') },
    ] })
    manager.batch.mockRejectedValueOnce(offlineError())
    await useEtebaseStore.getState().deleteItemsInCollection('calendar', 'col-1')
    await expectOwned(['delete', 'delete'])
  })

  it('collection clear stops after a later put abort, preserves prior committed deletes, and skips stale cleanup', async () => {
    const manager = setAccount({ items: [
      { uid: 'item-1', collectionUid: 'col-1', item: cachedItem('item-1') },
      { uid: 'item-2', collectionUid: 'col-1', item: cachedItem('item-2') },
      { uid: 'item-3', collectionUid: 'col-1', item: cachedItem('item-3') },
    ] })
    manager.batch.mockRejectedValueOnce(offlineError())
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const putSpy = changeAccountWhenQueuePutRuns(switchAccountAtBoundary, { putNumber: 2 })
    try {
      await expect(useEtebaseStore.getState().deleteItemsInCollection('calendar', 'col-1')).resolves.toBe(0)
      expect((await getAll()).map((entry) => entry.itemUid)).toEqual(['item-1'])
      expectNewAccountStateUntouched()
      expect(errorSpy).not.toHaveBeenCalled()
      expect(toastMock.showErrorToast).not.toHaveBeenCalled()
    } finally { putSpy.mockRestore(); errorSpy.mockRestore() }
  })

  it('move source-delete fallback enqueues against the source collection with the captured owner', async () => {
    setAccount({ collections: [collection('source'), collection('target')], items: [{ uid: 'item-1', collectionUid: 'source', item: cachedItem('item-1') }] })
    coreMock.createItem.mockResolvedValueOnce(cachedItem('created-target'))
    coreMock.deleteItem.mockRejectedValueOnce(offlineError())
    await useEtebaseStore.getState().moveItem('calendar', 'item-1', 'NEW', 'target', 'source')
    const [entry] = await getAll(queueGuard())
    expect(entry).toMatchObject({ type: 'delete', collectionUid: 'source', itemUid: 'item-1', accountFingerprint: TEST_FINGERPRINT })
    await expectOwned(['delete'])
  })

  it('move source-delete quietly cancels at the real queue put boundary without publishing the target', async () => {
    setAccount({ collections: [collection('source'), collection('target')], items: [{ uid: 'item-1', collectionUid: 'source', item: cachedItem('item-1') }] })
    coreMock.createItem.mockResolvedValueOnce(cachedItem('created-target'))
    coreMock.deleteItem.mockRejectedValueOnce(offlineError())
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const putSpy = changeAccountWhenQueuePutRuns(switchAccountAtBoundary)
    try {
      await expect(useEtebaseStore.getState().moveItem('calendar', 'item-1', 'NEW', 'target', 'source')).resolves.toBeNull()
      expect(await getAll()).toEqual([])
      expectNewAccountStateUntouched()
      expect(errorSpy).not.toHaveBeenCalled()
      expect(toastMock.showErrorToast).not.toHaveBeenCalled()
    } finally { putSpy.mockRestore(); errorSpy.mockRestore() }
  })

  it('missing fingerprint quietly cancels before queue persistence', async () => {
    setAccount()
    useEtebaseStore.setState({ accountFingerprint: null })
    coreMock.createItem.mockRejectedValueOnce(offlineError())
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put')
    try {
      await expect(useEtebaseStore.getState().createItem('calendar', 'OLD', 'temp-old', 'col-1')).resolves.toBeNull()
      expect(await getAll()).toEqual([])
      expect(putSpy).not.toHaveBeenCalled()
      expect(errorSpy).not.toHaveBeenCalled()
      expect(toastMock.showErrorToast).not.toHaveBeenCalled()
    } finally { putSpy.mockRestore(); errorSpy.mockRestore() }
  })

  it.each([
    ['create', { type: 'create', collectionType: 'calendar', collectionUid: 'col-1', content: 'NEW', tempId: 'temp-1' }],
    ['update', { type: 'update', collectionType: 'calendar', collectionUid: 'col-1', content: 'NEW', itemUid: 'item-1' }],
    ['delete', { type: 'delete', collectionType: 'calendar', collectionUid: 'col-1', itemUid: 'item-1' }],
    ['move', { type: 'move', collectionType: 'calendar', collectionUid: 'col-1', targetCollectionUid: 'col-2', content: 'NEW', itemUid: 'item-1' }],
  ] as const)('real sync replay retains exactly one owned %s entry when the remote path is offline', async (_name, queued) => {
    setAccount({
      collections: [collection('col-1'), collection('col-2')],
      items: [{ uid: 'item-1', collectionUid: 'col-1', item: cachedItem('item-1') }],
    })
    await enqueue(queued, queueGuard())
    coreMock.createItem.mockRejectedValue(offlineError())
    coreMock.updateItem.mockRejectedValue(offlineError())
    coreMock.deleteItem.mockRejectedValue(offlineError())

    await useSyncStore.getState().replayOfflineQueue()

    const entries = await getAll(queueGuard())
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: expect.any(String), type: queued.type, accountFingerprint: TEST_FINGERPRINT, status: 'pending', retryCount: 0 })
  })

  it.each([
    ['create collection', { type: 'create', collectionType: 'calendar', collectionUid: 'missing', content: 'NEW', tempId: 'temp-1' }],
    ['update item', { type: 'update', collectionType: 'calendar', collectionUid: 'col-1', content: 'NEW', itemUid: 'missing' }],
    ['delete item', { type: 'delete', collectionType: 'calendar', collectionUid: 'col-1', itemUid: 'missing' }],
    ['move target collection', { type: 'move', collectionType: 'calendar', collectionUid: 'col-1', targetCollectionUid: 'missing', content: 'NEW', itemUid: 'item-1' }],
  ] as const)('real sync replay retains the original entry when the %s prerequisite is unavailable', async (_name, queued) => {
    setAccount({ items: [{ uid: 'item-1', collectionUid: 'col-1', item: cachedItem('item-1') }] })
    await enqueue(queued, queueGuard())
    const [original] = await getAll(queueGuard())

    await useSyncStore.getState().replayOfflineQueue()

    expect(await getAll(queueGuard())).toEqual([original!])
    expect(coreMock.createItem).not.toHaveBeenCalled()
    expect(coreMock.updateItem).not.toHaveBeenCalled()
    expect(coreMock.deleteItem).not.toHaveBeenCalled()
  })

  it.each([
    ['create', { type: 'create', collectionType: 'calendar', collectionUid: 'col-1', content: 'NEW', tempId: 'temp-1' }],
    ['update', { type: 'update', collectionType: 'calendar', collectionUid: 'col-1', content: 'NEW', itemUid: 'item-1' }],
    ['delete', { type: 'delete', collectionType: 'calendar', collectionUid: 'col-1', itemUid: 'item-1' }],
    ['move', { type: 'move', collectionType: 'calendar', collectionUid: 'col-1', targetCollectionUid: 'col-2', content: 'NEW', itemUid: 'item-1' }],
  ] as const)('real sync replay removes %s only after confirmed remote success', async (name, queued) => {
    setAccount({
      collections: [collection('col-1'), collection('col-2')],
      items: [{ uid: 'item-1', collectionUid: 'col-1', item: cachedItem('item-1') }],
    })
    await enqueue(queued, queueGuard())
    coreMock.createItem.mockResolvedValue({ uid: name === 'create' ? 'server-created' : 'server-moved' })
    coreMock.updateItem.mockResolvedValue({ uid: 'item-1' })
    coreMock.deleteItem.mockResolvedValue(undefined)

    await useSyncStore.getState().replayOfflineQueue()

    expect(await getAll(queueGuard())).toEqual([])
    if (name === 'create') expect(coreMock.createItem).toHaveReturnedWith(Promise.resolve({ uid: 'server-created' }))
  })

  it('fresh create publishes the returned item atomically, removes temp maps, and supports immediate update', async () => {
    const content = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:fresh-create\r\nEND:VEVENT\r\nEND:VCALENDAR'
    const temp = cachedItem('temp-1')
    const created = remoteItem('server-fresh', content)
    setAccount({ items: [{ uid: 'temp-1', collectionUid: 'col-1', item: temp }] })
    await enqueue({ type: 'create', collectionType: 'calendar', collectionUid: 'col-1', content, tempId: 'temp-1' }, queueGuard())
    coreMock.createItem.mockResolvedValueOnce(created)

    await useSyncStore.getState().replayOfflineQueue()

    const state = useEtebaseStore.getState()
    expect(state.itemCache.get('server-fresh')).toBe(created)
    expect(state.itemTypeMap.get('server-fresh')).toBe('calendar')
    expect(state.itemCollectionMap.get('server-fresh')).toBe('col-1')
    expect(state.itemCache.has('temp-1')).toBe(false)
    expect(state.itemTypeMap.has('temp-1')).toBe(false)
    expect(state.itemCollectionMap.has('temp-1')).toBe(false)
    expect(await getAll(queueGuard())).toEqual([])

    coreMock.updateItem.mockResolvedValueOnce(created)
    await useEtebaseStore.getState().updateItem('calendar', 'server-fresh', 'UPDATED')
    expect(coreMock.updateItem).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ uid: 'col-1' }), created, 'UPDATED', undefined)
  })

  it('account boundary inside create cache publication publishes nothing and leaves a reconciliable checkpoint', async () => {
    const content = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:publish-boundary\r\nEND:VEVENT\r\nEND:VCALENDAR'
    const created = remoteItem('server-boundary', content)
    const remote = [created]
    setAccount()
    await enqueue({ type: 'create', collectionType: 'calendar', collectionUid: 'col-1', content, tempId: 'temp-boundary' }, queueGuard())
    coreMock.listItems.mockResolvedValue({ items: [], stoken: null, done: true })
    coreMock.createItem.mockResolvedValueOnce(created)
    const originalMapSet = Map.prototype.set
    let switched = false
    const mapSetSpy = vi.spyOn(Map.prototype, 'set').mockImplementation(function (key, value) {
      const result = originalMapSet.call(this, key, value)
      if (!switched && key === 'server-boundary') {
        switched = true
        bumpAccountEpoch()
        switchAccountAtBoundary()
      }
      return result
    })

    try {
      await useSyncStore.getState().replayOfflineQueue()
    } finally {
      mapSetSpy.mockRestore()
    }

    expectNewAccountStateUntouched()
    expect((await getAll())[0]).toMatchObject({ replayPhase: 'target-confirmed', confirmedTargetUid: 'server-boundary' })

    bumpAccountEpoch()
    setAccount()
    coreMock.listItems.mockResolvedValue({ items: remote, stoken: null, done: true })
    await useSyncStore.getState().replayOfflineQueue()
    expect(coreMock.createItem).toHaveBeenCalledTimes(1)
    expect(useEtebaseStore.getState().itemCache.get('server-boundary')).toBe(created)
    expect(await getAll(queueGuard())).toEqual([])
  })

  it('startup replay publishes a fresh target before queue success is exposed', async () => {
    // SyncProvider calls replayOfflineQueue once the restored session and item
    // maps are live; this is the same entry point.
    const content = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:cold-start\r\nEND:VEVENT\r\nEND:VCALENDAR'
    const created = remoteItem('server-cold', content)
    setAccount()
    await enqueue({ type: 'create', collectionType: 'calendar', collectionUid: 'col-1', content, tempId: 'temp-cold' }, queueGuard())
    coreMock.createItem.mockResolvedValueOnce(created)

    await expect(useSyncStore.getState().replayOfflineQueue()).resolves.toBe(1)

    expect(useEtebaseStore.getState().itemCache.get('server-cold')).toBe(created)
    expect(useEtebaseStore.getState().itemTypeMap.get('server-cold')).toBe('calendar')
    expect(useEtebaseStore.getState().itemCollectionMap.get('server-cold')).toBe('col-1')
    expect(await getAll(queueGuard())).toEqual([])
  })

  it('account boundary after create commit retains recoverable old work and retry reconciles exactly one remote object', async () => {
    const content = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:logical-1\r\nEND:VEVENT\r\nEND:VCALENDAR'
    const remote: any[] = []
    setAccount()
    await enqueue({ type: 'create', collectionType: 'calendar', collectionUid: 'col-1', content, tempId: 'temp-1' }, queueGuard())
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    coreMock.listItems.mockImplementation(async () => ({ items: remote, stoken: null, done: true }))
    coreMock.createItem.mockImplementationOnce(async () => {
      const created = remoteItem('server-1', content)
      remote.push(created)
      bumpAccountEpoch()
      switchAccountAtBoundary()
      return created
    })
    try {
      await useSyncStore.getState().replayOfflineQueue()
      expect(remote).toHaveLength(1)
      expect(await getAll()).toHaveLength(1)
      expectNewAccountStateUntouched()

      bumpAccountEpoch()
      setAccount()
      await useSyncStore.getState().replayOfflineQueue()
      expect(remote).toHaveLength(1)
      expect(coreMock.createItem).toHaveBeenCalledTimes(1)
      expect(await getAll(queueGuard())).toEqual([])
      expect(errorSpy).not.toHaveBeenCalled()
      expect(toastMock.showErrorToast).not.toHaveBeenCalled()
    } finally { errorSpy.mockRestore() }
  })

  it('response loss after server commit is reconciled by PIM UID without a second create', async () => {
    const content = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:response-loss-logical\r\nEND:VEVENT\r\nEND:VCALENDAR'
    const created = remoteItem('server-contact', content)
    const remote: any[] = []
    setAccount({ collections: [collection('col-1')] })
    await enqueue({ type: 'create', collectionType: 'calendar', collectionUid: 'col-1', content, tempId: 'temp-1' }, queueGuard())
    coreMock.listItems.mockImplementation(async () => ({ items: remote, stoken: null, done: true }))
    coreMock.createItem.mockImplementationOnce(async () => { remote.push(created); throw offlineError() })

    await useSyncStore.getState().replayOfflineQueue()
    expect(remote).toHaveLength(1)
    await useSyncStore.getState().replayOfflineQueue()

    expect(coreMock.createItem).toHaveBeenCalledTimes(1)
    expect(await getAll(queueGuard())).toEqual([])
    expect(useEtebaseStore.getState().itemCache.get('server-contact')).toBe(created)
    expect(useEtebaseStore.getState().itemTypeMap.get('server-contact')).toBe('calendar')
    expect(useEtebaseStore.getState().itemCollectionMap.get('server-contact')).toBe('col-1')

    const updated = remoteItem('server-contact', 'UPDATED')
    coreMock.updateItem.mockResolvedValueOnce(updated)
    await useEtebaseStore.getState().updateItem('calendar', 'server-contact', 'UPDATED')
    expect(coreMock.updateItem).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ uid: 'col-1' }), created, 'UPDATED', undefined)

    coreMock.deleteItem.mockResolvedValueOnce(undefined)
    await useEtebaseStore.getState().deleteItem('calendar', 'server-contact')
    expect(coreMock.deleteItem).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ uid: 'col-1' }), updated)
  })

  it('local queue removal abort after create checkpoint retains progress and retry does not duplicate', async () => {
    const content = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:idb-failure-logical\r\nEND:VEVENT\r\nEND:VCALENDAR'
    const created = remoteItem('server-idb', content)
    const remote = [created]
    setAccount()
    await enqueue({ type: 'create', collectionType: 'calendar', collectionUid: 'col-1', content, tempId: 'temp-idb' }, queueGuard())
    coreMock.listItems.mockResolvedValue({ items: remote, stoken: null, done: true })
    const originalDelete = IDBObjectStore.prototype.delete
    const deleteSpy = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementationOnce(function (...args) {
      const request = originalDelete.apply(this, args)
      this.transaction.abort()
      return request
    })
    try {
      await useSyncStore.getState().replayOfflineQueue()
    } finally {
      deleteSpy.mockRestore()
    }
    expect((await getAll(queueGuard()))[0]).toMatchObject({
      replayPhase: 'target-confirmed', confirmedTargetUid: 'server-idb',
      retryCount: 0, status: 'pending',
    })
    expect(useEtebaseStore.getState().itemCache.get('server-idb')).toBe(created)
    expect(useEtebaseStore.getState().itemTypeMap.get('server-idb')).toBe('calendar')
    expect(useEtebaseStore.getState().itemCollectionMap.get('server-idb')).toBe('col-1')

    const secondDeleteSpy = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementationOnce(function (...args) {
      const request = originalDelete.apply(this, args)
      this.transaction.abort()
      return request
    })
    try {
      await useSyncStore.getState().replayOfflineQueue()
    } finally {
      secondDeleteSpy.mockRestore()
    }
    expect((await getAll(queueGuard()))[0]).toMatchObject({ retryCount: 0, status: 'pending' })

    await useSyncStore.getState().replayOfflineQueue()
    expect(coreMock.createItem).not.toHaveBeenCalled()
    expect(await getAll(queueGuard())).toEqual([])
  })

  it('move checkpoints one target and retries only source deletion after an ambiguous failure', async () => {
    const content = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:move-logical\r\nEND:VEVENT\r\nEND:VCALENDAR'
    const source = remoteItem('source-item', content)
    const target: any[] = []
    const sourceItems: any[] = [source]
    setAccount({ collections: [collection('source'), collection('target')], items: [{ uid: 'source-item', collectionUid: 'source', item: source }] })
    await enqueue({ type: 'move', collectionType: 'calendar', collectionUid: 'source', targetCollectionUid: 'target', content, itemUid: 'source-item' }, queueGuard())
    coreMock.listItems.mockImplementation(async (_account, col) => ({ items: col.uid === 'target' ? target : sourceItems, stoken: null, done: true }))
    coreMock.createItem.mockImplementationOnce(async () => { const item = remoteItem('target-item', content); target.push(item); return item })
    coreMock.deleteItem.mockRejectedValueOnce(offlineError()).mockImplementationOnce(async () => { sourceItems.splice(0) })

    await useSyncStore.getState().replayOfflineQueue()
    expect(target).toHaveLength(1)
    expect((await getAll(queueGuard()))[0]).toMatchObject({ replayPhase: 'target-confirmed', confirmedTargetUid: 'target-item' })
    expect(useEtebaseStore.getState().itemCache.get('source-item')).toBe(source)
    expect(useEtebaseStore.getState().itemTypeMap.get('source-item')).toBe('calendar')
    expect(useEtebaseStore.getState().itemCollectionMap.get('source-item')).toBe('source')
    await useSyncStore.getState().replayOfflineQueue()

    expect(coreMock.createItem).toHaveBeenCalledTimes(1)
    expect(target).toHaveLength(1)
    expect(sourceItems).toEqual([])
    expect(await getAll(queueGuard())).toEqual([])
    expect(useEtebaseStore.getState().itemCache.get('target-item')).toBe(target[0])
    expect(useEtebaseStore.getState().itemTypeMap.get('target-item')).toBe('calendar')
    expect(useEtebaseStore.getState().itemCollectionMap.get('target-item')).toBe('target')
    expect(useEtebaseStore.getState().itemCache.has('source-item')).toBe(false)
    expect(useEtebaseStore.getState().itemTypeMap.has('source-item')).toBe(false)
    expect(useEtebaseStore.getState().itemCollectionMap.has('source-item')).toBe(false)

    coreMock.deleteItem.mockResolvedValueOnce(undefined)
    await useEtebaseStore.getState().deleteItem('calendar', 'target-item')
    expect(coreMock.deleteItem).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ uid: 'target' }), target[0])
  })
})
