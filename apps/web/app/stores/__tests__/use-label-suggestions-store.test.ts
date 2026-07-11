import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLabelSuggestionsStore } from '../use-label-suggestions-store'
import { bumpAccountEpoch } from '@/app/lib/account-epoch'

vi.mock('@/app/lib/logger', () => ({
  logger: { warn: vi.fn(), log: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const etebaseState = vi.hoisted(() => ({
  account: null as any,
  syncEngine: { trackCollection: vi.fn() },
}))
const coreState = vi.hoisted(() => ({
  collections: [] as any[],
  items: [] as any[],
  listCollections: vi.fn(async () => [] as any[]),
}))

vi.mock('@silentsuite/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@silentsuite/core')>()
  return {
    ...actual,
    listCollections: (...args: any[]) => coreState.listCollections(...args),
    listItems: vi.fn(async () => ({ items: coreState.items, stoken: null, done: true })),
  }
})

vi.mock('@/app/stores/use-etebase-store', () => ({
  useEtebaseStore: {
    getState: () => etebaseState,
  },
}))

vi.mock('@/app/stores/use-calendar-store', () => ({
  useCalendarStore: { getState: () => ({ events: [{ categories: ['Work'] }] }) },
}))
vi.mock('@/app/stores/use-task-store', () => ({
  useTaskStore: { getState: () => ({ tasks: [{ categories: ['Urgent'] }] }) },
}))
vi.mock('@/app/stores/use-contact-store', () => ({
  useContactStore: { getState: () => ({ contacts: [{ categories: ['VIP'] }] }) },
}))

describe('useLabelSuggestionsStore', () => {
  beforeEach(() => {
    etebaseState.account = null
    coreState.collections = []
    coreState.items = []
    coreState.listCollections.mockReset()
    coreState.listCollections.mockImplementation(async () => coreState.collections)
    etebaseState.syncEngine.trackCollection.mockClear()
    useLabelSuggestionsStore.getState().reset()
  })

  it('seeds in-memory suggestions from decrypted visible items without an account write', () => {
    useLabelSuggestionsStore.getState().seedFromVisibleItems()

    expect(useLabelSuggestionsStore.getState().suggestions('', [], 5)).toEqual(['Urgent', 'VIP', 'Work'])
    expect(etebaseState.syncEngine.trackCollection).not.toHaveBeenCalled()
  })

  it('initializes as loaded without creating a remote label-index collection when no account exists', async () => {
    await useLabelSuggestionsStore.getState().initialize()

    expect(useLabelSuggestionsStore.getState().isLoaded).toBe(true)
    expect(useLabelSuggestionsStore.getState().remoteCollection).toBeNull()
  })

  it('clears prior-account suggestions and remote handles when the current account has no index', async () => {
    await useLabelSuggestionsStore.getState().recordUsage('calendar', ['Private Project'])
    useLabelSuggestionsStore.setState({ remoteCollection: { uid: 'old-collection' }, remoteItem: { uid: 'old-item' } })
    etebaseState.account = { uid: 'new-account' }

    await useLabelSuggestionsStore.getState().initialize()

    expect(useLabelSuggestionsStore.getState().suggestions('', [], 5)).toEqual([])
    expect(useLabelSuggestionsStore.getState().remoteCollection).toBeNull()
    expect(useLabelSuggestionsStore.getState().remoteItem).toBeNull()
  })

  it('does not publish a stale index after the account boundary changes', async () => {
    let resolveCollections!: (collections: any[]) => void
    coreState.listCollections.mockImplementationOnce(() => new Promise((resolve) => { resolveCollections = resolve }))
    etebaseState.account = { uid: 'old-account' }

    const initialization = useLabelSuggestionsStore.getState().initialize()
    await vi.waitFor(() => expect(coreState.listCollections).toHaveBeenCalled())
    bumpAccountEpoch()
    useLabelSuggestionsStore.getState().reset()
    resolveCollections([{ uid: 'old-collection' }])
    await initialization

    expect(useLabelSuggestionsStore.getState().suggestions('', [], 5)).toEqual([])
    expect(useLabelSuggestionsStore.getState().remoteCollection).toBeNull()
    expect(useLabelSuggestionsStore.getState().isLoaded).toBe(false)
  })

  it('records usage locally even when remote persistence is unavailable', async () => {
    await useLabelSuggestionsStore.getState().recordUsage('calendar', ['Project'])

    expect(useLabelSuggestionsStore.getState().suggestions('', [], 5)).toEqual(['Project'])
    expect(useLabelSuggestionsStore.getState().lastError).toBeNull()
  })
})
