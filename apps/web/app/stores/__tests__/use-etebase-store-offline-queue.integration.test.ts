import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAll, getPendingCount, replay } from '@/app/lib/offline-queue'
import { TEST_FINGERPRINT, bumpEpochWhenQueuePutRuns, changeAccountWhenQueuePutRuns, queueGuard, resetRealOfflineQueue } from './offline-queue-store-test-utils'

const coreMock = vi.hoisted(() => ({ createItem: vi.fn(), updateItem: vi.fn(), deleteItem: vi.fn() }))
const toastMock = vi.hoisted(() => ({ showErrorToast: vi.fn() }))

vi.mock('@silentsuite/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@silentsuite/core')>(),
  ...coreMock,
}))
vi.mock('@/app/stores/use-toast-store', () => toastMock)
vi.mock('@/app/stores/use-label-suggestions-store', () => ({ useLabelSuggestionsStore: { getState: () => ({ recordUsage: vi.fn() }) } }))

import { useEtebaseStore } from '../use-etebase-store'

const offlineError = () => new TypeError('Failed to fetch')
const collection = (uid: string) => ({ uid, getMeta: vi.fn(() => ({})) })
const cachedItem = (uid: string) => ({ uid, delete: vi.fn(), getContent: vi.fn(async () => 'OLD') })

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
    collections: { calendar: collections as any[], tasks: [], contacts: [], preferences: [] },
    itemCache: new Map(items.map(({ uid, item }) => [uid, item])),
    itemTypeMap: new Map(items.map(({ uid }) => [uid, 'calendar' as const])),
    itemCollectionMap: new Map(items.map(({ uid, collectionUid }) => [uid, collectionUid])),
    domainLoadState: { calendar: 'loaded', tasks: 'loaded', contacts: 'loaded', preferences: 'unknown' },
    isInitialized: true,
    syncEngine: null,
  } as any)
  return manager
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
  const execute = vi.fn(async () => ({}))
  await replay(execute, queueGuard())
  expect(execute).toHaveBeenCalledTimes(entries.length)
  expect(await getAll(queueGuard())).toEqual([])
}

describe('useEtebaseStore real guarded offline queue integration', () => {
  beforeEach(async () => {
    await resetRealOfflineQueue()
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    coreMock.createItem.mockReset()
    coreMock.updateItem.mockReset()
    coreMock.deleteItem.mockReset()
    toastMock.showErrorToast.mockReset()
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
    ['updateItem', async () => useEtebaseStore.getState().updateItem('calendar', 'item-1', 'NEW')],
    ['deleteItem', async () => useEtebaseStore.getState().deleteItem('calendar', 'item-1')],
  ] as const)('%s quietly cancels at its real queue put boundary', async (_name, mutate) => {
    setAccount({ items: [{ uid: 'item-1', collectionUid: 'col-1', item: cachedItem('item-1') }] })
    coreMock.updateItem.mockRejectedValueOnce(offlineError())
    coreMock.deleteItem.mockRejectedValueOnce(offlineError())
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const putSpy = changeAccountWhenQueuePutRuns(switchAccountAtBoundary)
    try {
      await expect(mutate()).resolves.toBeUndefined()
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
})
