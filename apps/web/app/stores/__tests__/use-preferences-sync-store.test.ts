import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSyncedPreferences, serializePreferences } from '@silentsuite/core'
import { useEtebaseStore } from '../use-etebase-store'
import { usePreferencesStore } from '../use-preferences-store'
import { usePreferencesSyncStore } from '../use-preferences-sync-store'
import { AccountBoundaryChangedError, bumpAccountEpoch, getAccountEpoch } from '@/app/lib/account-epoch'

vi.mock('@/app/stores/use-toast-store', () => ({
  showErrorToast: vi.fn(),
}))

vi.mock('@/app/lib/secure-storage', () => ({
  secureGet: vi.fn(async () => null),
  secureSet: vi.fn(async () => {}),
  secureRemove: vi.fn(async () => {}),
  secureClear: vi.fn(async () => {}),
  migrateFromLocalStorage: vi.fn(async () => {}),
}))

vi.mock('@silentsuite/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@silentsuite/core')>()
  return {
    ...actual,
    listCollections: vi.fn(),
  }
})

const core = await import('@silentsuite/core')
const listCollectionsMock = vi.mocked(core.listCollections)

function resetStores() {
  usePreferencesSyncStore.getState().destroy()
  usePreferencesStore.getState().resetSyncedPreferences()
  usePreferencesStore.setState({ notificationSound: true })
  useEtebaseStore.setState({
    account: null,
    collections: { calendar: [], tasks: [], contacts: [], preferences: [] },
    itemCache: new Map(),
    itemTypeMap: new Map(),
    itemCollectionMap: new Map(),
    domainLoadState: { calendar: 'loaded', tasks: 'loaded', contacts: 'loaded', preferences: 'unknown' },
    isInitialized: false,
    syncEngine: null,
  })
}

function mockItem(uid: string, content: string) {
  return {
    uid,
    isDeleted: false,
    getContent: vi.fn(async () => content),
  }
}

function authorizeWrites() {
  usePreferencesSyncStore.setState({
    status: 'ready',
    integrity: 'valid',
    operationEpoch: getAccountEpoch(),
  })
}

describe('usePreferencesSyncStore', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    resetStores()
  })

  it('publishes unavailable when initialization has no restored account', async () => {
    await usePreferencesSyncStore.getState().initialize()

    expect(usePreferencesSyncStore.getState()).toMatchObject({
      status: 'unavailable',
      integrity: 'unavailable',
    })
  })

  it('initializes read-only when no remote preferences collection exists', async () => {
    const createItem = vi.fn()
    const updateItem = vi.fn()
    useEtebaseStore.setState({
      account: { id: 'account' } as any,
      createItem: createItem as any,
      updateItem: updateItem as any,
      refreshCollection: vi.fn(async () => [{ uid: 'pref-1', content: serializePreferences(remote) }]) as any,
    })
    listCollectionsMock.mockResolvedValue([] as any)

    await usePreferencesSyncStore.getState().initialize()

    expect(listCollectionsMock).toHaveBeenCalledWith(expect.anything(), 'silentsuite.preferences')
    expect(createItem).not.toHaveBeenCalled()
    expect(updateItem).not.toHaveBeenCalled()
    expect(usePreferencesSyncStore.getState()).toMatchObject({ isInitialized: true, remoteItemUid: null })
    expect(usePreferencesSyncStore.getState()).toMatchObject({ status: 'ready', integrity: 'valid' })
  })

  it('deduplicates concurrent initialization for the current account operation', async () => {
    let release!: (collections: any[]) => void
    listCollectionsMock.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    useEtebaseStore.setState({ account: { id: 'account' } as any })

    const first = usePreferencesSyncStore.getState().initialize()
    const second = usePreferencesSyncStore.getState().initialize()
    await vi.waitFor(() => expect(listCollectionsMock).toHaveBeenCalledTimes(1))
    release([])
    await Promise.all([first, second])

    expect(listCollectionsMock).toHaveBeenCalledTimes(1)
    expect(usePreferencesSyncStore.getState().status).toBe('ready')
  })

  it('does not publish or track stale preferences collections after an account switch', async () => {
    let releaseList!: (collections: any[]) => void
    const oldTrack = vi.fn()
    const newTrack = vi.fn()
    listCollectionsMock.mockImplementationOnce(() => new Promise<any[]>((resolve) => {
      releaseList = resolve
    }))
    useEtebaseStore.setState({
      account: { id: 'old' } as any,
      syncEngine: { trackCollection: oldTrack } as any,
    })

    const initialization = usePreferencesSyncStore.getState().initialize()
    await vi.waitFor(() => expect(listCollectionsMock).toHaveBeenCalled())
    bumpAccountEpoch()
    useEtebaseStore.setState({
      account: { id: 'new' } as any,
      collections: { calendar: [], tasks: [], contacts: [], preferences: [] },
      syncEngine: { trackCollection: newTrack } as any,
    })
    releaseList([{ uid: 'old-preferences' }])

    await expect(initialization).rejects.toBeInstanceOf(AccountBoundaryChangedError)
    expect(useEtebaseStore.getState().collections.preferences).toEqual([])
    expect(oldTrack).not.toHaveBeenCalled()
    expect(newTrack).not.toHaveBeenCalled()
  })

  it('loads remote preferences without changing local notification sound or writing back', async () => {
    const remote = createSyncedPreferences(
      {
        timeFormat: '24h',
        firstDayOfWeek: 'sunday',
        defaultReminder: '30',
        defaultTimezone: 'Europe/Amsterdam',
      },
      {
        timeFormat: 10,
        firstDayOfWeek: 10,
        defaultReminder: 10,
        defaultTimezone: 10,
      },
      10,
    )
    const item = mockItem('pref-1', serializePreferences(remote))
    const updateItem = vi.fn()
    usePreferencesStore.setState({ notificationSound: false })
    useEtebaseStore.setState({
      account: { id: 'account' } as any,
      collections: { calendar: [], tasks: [], contacts: [], preferences: [{ uid: 'prefs-col' }] as any[] },
      itemCache: new Map([['pref-1', item]]),
      itemTypeMap: new Map([['pref-1', 'preferences']]),
      itemCollectionMap: new Map([['pref-1', 'prefs-col']]),
      updateItem: updateItem as any,
      refreshCollection: vi.fn(async () => [{ uid: 'pref-1', content: serializePreferences(remote) }]) as any,
    })

    await usePreferencesSyncStore.getState().loadFromRemote()

    expect(usePreferencesStore.getState()).toMatchObject({
      timeFormat: '24h',
      firstDayOfWeek: 'sunday',
      defaultReminder: '30',
      defaultTimezone: 'Europe/Amsterdam',
      notificationSound: false,
    })
    expect(updateItem).not.toHaveBeenCalled()
    expect(usePreferencesSyncStore.getState().remoteItemUid).toBe('pref-1')
  })

  it('fails integrity for a non-empty all-corrupt remote read without applying values', async () => {
    usePreferencesStore.setState({ timeFormat: '24h' })
    useEtebaseStore.setState({
      account: { id: 'account' } as any,
      collections: { calendar: [], tasks: [], contacts: [], preferences: [{ uid: 'prefs-col' }] as any[] },
      syncEngine: { trackCollection: vi.fn(async () => {}) } as any,
      refreshCollection: vi.fn(async () => [{ uid: 'bad', content: 'not preferences' }]) as any,
    })

    await usePreferencesSyncStore.getState().initialize()

    expect(usePreferencesSyncStore.getState()).toMatchObject({ status: 'failed', integrity: 'failed' })
    expect(usePreferencesStore.getState().timeFormat).toBe('24h')
  })

  it('retries cached collection tracking after failure and records success once', async () => {
    const trackCollection = vi.fn()
      .mockRejectedValueOnce(new Error('track failed'))
      .mockResolvedValue(undefined)
    useEtebaseStore.setState({
      account: { id: 'account' } as any,
      collections: { calendar: [], tasks: [], contacts: [], preferences: [{ uid: 'prefs-col' }] as any[] },
      syncEngine: { trackCollection } as any,
      refreshCollection: vi.fn(async () => []) as any,
    })

    await usePreferencesSyncStore.getState().initialize()
    expect(usePreferencesSyncStore.getState().status).toBe('failed')
    await usePreferencesSyncStore.getState().initialize(true)

    expect(trackCollection).toHaveBeenCalledTimes(2)
    expect(usePreferencesSyncStore.getState()).toMatchObject({ status: 'ready', integrity: 'valid' })
  })

  it('preserves values and revokes integrity after a later corrupt read, then recovers', async () => {
    const remote = createSyncedPreferences({ timeFormat: '12h' }, { timeFormat: 20 }, 20)
    useEtebaseStore.setState({ account: { id: 'account' } as any })
    await usePreferencesSyncStore.getState().loadFromRemote([{ uid: 'valid', content: serializePreferences(remote) }])
    const epoch = usePreferencesSyncStore.getState().operationEpoch!
    const generation = usePreferencesSyncStore.getState().operationGeneration

    await usePreferencesSyncStore.getState().loadFromRemote([{ uid: 'bad', content: 'corrupt' }], epoch, generation)
    expect(usePreferencesStore.getState().timeFormat).toBe('12h')
    expect(usePreferencesSyncStore.getState().integrity).toBe('failed')

    await usePreferencesSyncStore.getState().loadFromRemote([{ uid: 'valid', content: serializePreferences(remote) }], epoch, generation)
    expect(usePreferencesSyncStore.getState()).toMatchObject({ status: 'ready', integrity: 'valid' })
  })

  it('does not let an older valid refresh overwrite a newer integrity failure', async () => {
    const older = createSyncedPreferences({ timeFormat: '24h' }, { timeFormat: 10 }, 10)
    const initialTimeFormat = usePreferencesStore.getState().timeFormat
    let releaseOlder!: (items: { uid: string; content: string }[]) => void
    const refreshCollection = vi.fn(() => new Promise<{ uid: string; content: string }[]>((resolve) => {
      releaseOlder = resolve
    }))
    useEtebaseStore.setState({
      account: { id: 'account' } as any,
      collections: { calendar: [], tasks: [], contacts: [], preferences: [{ uid: 'prefs-col' }] as any[] },
      syncEngine: { trackCollection: vi.fn() } as any,
      refreshCollection: refreshCollection as any,
    })

    const olderRefresh = usePreferencesSyncStore.getState().loadFromRemote()
    await vi.waitFor(() => expect(refreshCollection).toHaveBeenCalledTimes(1))
    await usePreferencesSyncStore.getState().loadFromRemote([{ uid: 'bad', content: 'corrupt' }])
    releaseOlder([{ uid: 'older', content: serializePreferences(older) }])

    await expect(olderRefresh).rejects.toThrow('Stale preference read')
    expect(usePreferencesSyncStore.getState()).toMatchObject({ status: 'failed', integrity: 'failed' })
    expect(usePreferencesStore.getState().timeFormat).toBe(initialTimeFormat)
  })

  it('rejects stale provider failure publication', () => {
    usePreferencesSyncStore.setState({ operationEpoch: getAccountEpoch(), operationGeneration: 10, status: 'ready', integrity: 'valid' })
    usePreferencesSyncStore.getState().recordRemoteReadFailure(getAccountEpoch(), 9)
    expect(usePreferencesSyncStore.getState()).toMatchObject({ status: 'ready', integrity: 'valid' })
  })

  it('does not retry or write from unavailable integrity', async () => {
    const createCollection = vi.fn()
    const createItem = vi.fn()
    await usePreferencesSyncStore.getState().initialize()
    useEtebaseStore.setState({ account: { id: 'restored-too-late' } as any, createCollection: createCollection as any, createItem: createItem as any })

    expect(await usePreferencesSyncStore.getState().pushNow()).toBe(false)
    expect(listCollectionsMock).not.toHaveBeenCalled()
    expect(createCollection).not.toHaveBeenCalled()
    expect(createItem).not.toHaveBeenCalled()
  })

  it('retries a failed read-only operation and writes only after that operation is ready', async () => {
    const createCollection = vi.fn(async () => 'prefs-col')
    const createItem = vi.fn(async () => 'pref-1')
    useEtebaseStore.setState({
      account: { id: 'account' } as any,
      createCollection: createCollection as any,
      createItem: createItem as any,
    })
    listCollectionsMock.mockResolvedValue([] as any)
    usePreferencesSyncStore.setState({
      status: 'failed',
      integrity: 'failed',
      operationEpoch: getAccountEpoch(),
    })

    expect(await usePreferencesSyncStore.getState().pushNow()).toBe(true)
    expect(listCollectionsMock).toHaveBeenCalledTimes(2)
    expect(createCollection).toHaveBeenCalledTimes(1)
    expect(createItem).toHaveBeenCalledTimes(1)
  })

  it('does not write when a failed-operation retry remains all-corrupt', async () => {
    const createItem = vi.fn()
    const updateItem = vi.fn()
    useEtebaseStore.setState({
      account: { id: 'account' } as any,
      collections: { calendar: [], tasks: [], contacts: [], preferences: [{ uid: 'prefs-col' }] as any[] },
      refreshCollection: vi.fn(async () => [{ uid: 'bad', content: 'corrupt' }]) as any,
      createItem: createItem as any,
      updateItem: updateItem as any,
    })
    usePreferencesSyncStore.setState({
      status: 'failed',
      integrity: 'failed',
      operationEpoch: getAccountEpoch(),
    })

    expect(await usePreferencesSyncStore.getState().pushNow()).toBe(false)
    expect(createItem).not.toHaveBeenCalled()
    expect(updateItem).not.toHaveBeenCalled()
  })

  it('revokes write authorization when the explicit-sync preflight read fails', async () => {
    const createItem = vi.fn()
    const updateItem = vi.fn()
    useEtebaseStore.setState({
      account: { id: 'account' } as any,
      collections: { calendar: [], tasks: [], contacts: [], preferences: [{ uid: 'prefs-col' }] as any[] },
      syncEngine: { trackCollection: vi.fn() } as any,
      refreshCollection: vi.fn(async () => { throw new Error('network unavailable') }) as any,
      createItem: createItem as any,
      updateItem: updateItem as any,
    })
    authorizeWrites()

    await expect(usePreferencesSyncStore.getState().pushNow()).resolves.toBe(false)

    expect(usePreferencesSyncStore.getState()).toMatchObject({ status: 'failed', integrity: 'failed' })
    expect(createItem).not.toHaveBeenCalled()
    expect(updateItem).not.toHaveBeenCalled()
  })

  it('creates after an empty preflight without performing a fallible post-create reread', async () => {
    const createCollection = vi.fn(async () => {
      useEtebaseStore.setState((state) => ({
        collections: { ...state.collections, preferences: [{ uid: 'new-prefs-col' }] as any[] },
      }))
      return 'new-prefs-col'
    })
    const createItem = vi.fn(async () => 'new-preference-item')
    const refreshCollection = vi.fn(async () => { throw new Error('must not run after empty preflight') })
    useEtebaseStore.setState({
      account: { id: 'account' } as any,
      createCollection: createCollection as any,
      createItem: createItem as any,
      refreshCollection: refreshCollection as any,
    })
    listCollectionsMock.mockResolvedValue([] as any)
    authorizeWrites()

    await expect(usePreferencesSyncStore.getState().pushNow()).resolves.toBe(true)

    expect(createCollection).toHaveBeenCalledTimes(1)
    expect(createItem).toHaveBeenCalledTimes(1)
    expect(refreshCollection).not.toHaveBeenCalled()
    expect(usePreferencesSyncStore.getState()).toMatchObject({ status: 'ready', integrity: 'valid' })
  })

  it('pushNow creates a preferences collection and item only on explicit action', async () => {
    const createCollection = vi.fn(async () => 'prefs-col')
    const createItem = vi.fn(async () => 'pref-1')
    usePreferencesStore.getState().setTimeFormat('24h')
    useEtebaseStore.setState({
      account: { id: 'account' } as any,
      createCollection: createCollection as any,
      createItem: createItem as any,
    })
    listCollectionsMock.mockResolvedValue([] as any)
    authorizeWrites()

    const pushed = await usePreferencesSyncStore.getState().pushNow()

    expect(pushed).toBe(true)
    expect(createCollection).toHaveBeenCalledWith('preferences', 'Preferences')
    expect(createItem).toHaveBeenCalledWith('preferences', expect.stringContaining('timeFormat'), 'silentsuite-preferences', 'prefs-col')
    expect(usePreferencesSyncStore.getState().remoteItemUid).toBe('pref-1')
  })

  it('pushNow merges local and remote per-field timestamps before updating the canonical item', async () => {
    const remote = createSyncedPreferences(
      {
        timeFormat: '12h',
        firstDayOfWeek: 'sunday',
        defaultReminder: '15',
        defaultTimezone: 'UTC',
      },
      {
        timeFormat: 10,
        firstDayOfWeek: 200,
        defaultReminder: 10,
        defaultTimezone: 10,
      },
      200,
    )
    const item = mockItem('pref-1', serializePreferences(remote))
    const updatedItem = mockItem('pref-1', serializePreferences(remote))
    const updateItem = vi.fn(async () => {
      useEtebaseStore.setState({ itemCache: new Map([['pref-1', updatedItem]]) })
    })
    usePreferencesStore.setState({
      timeFormat: '24h',
      firstDayOfWeek: 'monday',
      syncedPreferenceUpdatedAt: {
        timeFormat: 100,
        firstDayOfWeek: 50,
        defaultReminder: 0,
        defaultTimezone: 0,
        dateFormat: 0,
        dayStartHour: 0,
        dayEndHour: 0,
      },
    })
    useEtebaseStore.setState({
      account: { id: 'account' } as any,
      collections: { calendar: [], tasks: [], contacts: [], preferences: [{ uid: 'prefs-col' }] as any[] },
      itemCache: new Map([['pref-1', item]]),
      itemTypeMap: new Map([['pref-1', 'preferences']]),
      itemCollectionMap: new Map([['pref-1', 'prefs-col']]),
      updateItem: updateItem as any,
      refreshCollection: vi.fn(async () => [{ uid: 'pref-1', content: serializePreferences(remote) }]) as any,
    })
    authorizeWrites()

    await usePreferencesSyncStore.getState().pushNow()

    expect(updateItem).toHaveBeenCalledTimes(1)
    const content = updateItem.mock.calls[0]?.[2] as string
    expect(content).toContain('24h')
    expect(content).toContain('sunday')
  })

  it('pushNow reports failure when updateItem leaves the canonical item unchanged', async () => {
    const remote = createSyncedPreferences(
      { timeFormat: '12h' },
      { timeFormat: 10 },
      10,
    )
    const item = mockItem('pref-1', serializePreferences(remote))
    const updateItem = vi.fn(async () => {})
    usePreferencesStore.setState({
      timeFormat: '24h',
      syncedPreferenceUpdatedAt: {
        timeFormat: 100,
        firstDayOfWeek: 0,
        defaultReminder: 0,
        defaultTimezone: 0,
        dateFormat: 0,
        dayStartHour: 0,
        dayEndHour: 0,
      },
    })
    useEtebaseStore.setState({
      account: { id: 'account' } as any,
      collections: { calendar: [], tasks: [], contacts: [], preferences: [{ uid: 'prefs-col' }] as any[] },
      itemCache: new Map([['pref-1', item]]),
      itemTypeMap: new Map([['pref-1', 'preferences']]),
      itemCollectionMap: new Map([['pref-1', 'prefs-col']]),
      updateItem: updateItem as any,
    })
    authorizeWrites()

    const pushed = await usePreferencesSyncStore.getState().pushNow()

    expect(pushed).toBe(false)
    expect(updateItem).toHaveBeenCalledTimes(1)
    expect(usePreferencesSyncStore.getState().remoteItemUid).toBeNull()
  })

  it('pushNow skips remote update when merged preferences match the canonical item', async () => {
    const remote = usePreferencesStore.getState().toSyncedPreferences()
    const item = mockItem('pref-1', serializePreferences(remote))
    const updateItem = vi.fn(async () => {})
    useEtebaseStore.setState({
      account: { id: 'account' } as any,
      collections: { calendar: [], tasks: [], contacts: [], preferences: [{ uid: 'prefs-col' }] as any[] },
      itemCache: new Map([['pref-1', item]]),
      itemTypeMap: new Map([['pref-1', 'preferences']]),
      itemCollectionMap: new Map([['pref-1', 'prefs-col']]),
      updateItem: updateItem as any,
    })
    authorizeWrites()

    const pushed = await usePreferencesSyncStore.getState().pushNow()

    expect(pushed).toBe(true)
    expect(updateItem).not.toHaveBeenCalled()
    expect(usePreferencesSyncStore.getState().remoteItemUid).toBe('pref-1')
  })

  it('pushNow refuses to write while remote preferences are being applied', async () => {
    const createItem = vi.fn(async () => 'pref-1')
    useEtebaseStore.setState({
      account: { id: 'account' } as any,
      createItem: createItem as any,
    })
    usePreferencesSyncStore.setState({ isApplyingRemote: true })

    const pushed = await usePreferencesSyncStore.getState().pushNow()

    expect(pushed).toBe(false)
    expect(createItem).not.toHaveBeenCalled()
  })
})
