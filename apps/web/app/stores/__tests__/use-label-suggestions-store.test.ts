import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createLabelIndex, serializeLabelIndex } from '@silentsuite/core'
import { useEtebaseStore } from '../use-etebase-store'
import { useLabelSuggestionsStore } from '../use-label-suggestions-store'

vi.mock('@/app/lib/secure-storage', () => ({
  secureGet: vi.fn(async () => null),
  secureSet: vi.fn(async () => {}),
  secureRemove: vi.fn(async () => {}),
  secureClear: vi.fn(async () => {}),
  migrateFromLocalStorage: vi.fn(async () => {}),
}))

vi.mock('@/app/stores/use-toast-store', () => ({
  showErrorToast: vi.fn(),
}))

vi.mock('@/app/lib/offline-queue', () => ({
  enqueue: vi.fn(async () => {}),
  getAll: vi.fn(async () => []),
  remove: vi.fn(async () => {}),
  isOfflineError: vi.fn(() => false),
}))

function resetStores() {
  useLabelSuggestionsStore.getState().destroy()
  useEtebaseStore.setState({
    account: null,
    collections: { calendar: [], tasks: [], contacts: [], preferences: [], labelIndex: [] },
    itemCache: new Map(),
    itemTypeMap: new Map(),
    itemCollectionMap: new Map(),
    isInitialized: false,
    syncEngine: null,
  })
}

describe('useLabelSuggestionsStore', () => {
  beforeEach(() => {
    vi.useRealTimers()
    resetStores()
  })

  it('creates label index in a dedicated encrypted labelIndex collection', async () => {
    const createItem = vi.fn(async () => 'label-index-1')
    useEtebaseStore.setState({
      account: { id: 'account' } as any,
      collections: { calendar: [], tasks: [], contacts: [], preferences: [], labelIndex: [{ uid: 'label-col' }] as any[] },
      isInitialized: true,
      createItem: createItem as any,
    })

    await useLabelSuggestionsStore.getState().recordLabelsUsed(['Work'])
    await useLabelSuggestionsStore.getState().syncLocalToRemote()

    expect(createItem).toHaveBeenCalledTimes(1)
    expect(createItem.mock.calls[0]?.[0]).toBe('labelIndex')
    expect(createItem.mock.calls[0]?.[3]).toBe('label-col')
    const content = createItem.mock.calls[0]?.[1] as string
    expect(content).toContain('silentsuite.labelindex.v1')
    expect(content).toContain('Work')
    expect(useLabelSuggestionsStore.getState().remoteItemUid).toBe('label-index-1')
  })

  it('merges remote indexes idempotently and suggests by rank', async () => {
    const updateItem = vi.fn(async () => {})
    const remote = serializeLabelIndex(createLabelIndex([
      { label: 'Work', count: 4, lastUsedAt: 10 },
      { label: 'Home', count: 1, lastUsedAt: 9 },
    ], 10))
    useEtebaseStore.setState({
      account: { id: 'account' } as any,
      collections: { calendar: [], tasks: [], contacts: [], preferences: [], labelIndex: [{ uid: 'label-col' }] as any[] },
      isInitialized: true,
      fetchAllItems: vi.fn(async () => [{ uid: 'remote-1', content: remote, collectionUid: 'label-col' }]) as any,
      updateItem: updateItem as any,
    })

    await useLabelSuggestionsStore.getState().recordLabelsUsed(['work', 'Urgent'])
    await useLabelSuggestionsStore.getState().loadFromRemote()
    await useLabelSuggestionsStore.getState().loadFromRemote()

    expect(useLabelSuggestionsStore.getState().suggestionsFor('', [], 3)).toEqual(['Work', 'Urgent', 'Home'])
    expect(useLabelSuggestionsStore.getState().index.labels.work.count).toBe(4)
  })
})
