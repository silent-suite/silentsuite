import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSyncedPreferences, serializePreferences } from '@silentsuite/core'
import { useEtebaseStore } from '../use-etebase-store'
import { usePreferencesStore } from '../use-preferences-store'
import { usePreferencesSyncStore } from '../use-preferences-sync-store'

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

describe('usePreferencesSyncStore', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    resetStores()
  })

  it('initializes read-only when no remote preferences collection exists', async () => {
    const createItem = vi.fn()
    const updateItem = vi.fn()
    useEtebaseStore.setState({
      account: { id: 'account' } as any,
      createItem: createItem as any,
      updateItem: updateItem as any,
    })
    listCollectionsMock.mockResolvedValue([] as any)

    await usePreferencesSyncStore.getState().initialize()

    expect(listCollectionsMock).toHaveBeenCalledWith(expect.anything(), 'silentsuite.preferences')
    expect(createItem).not.toHaveBeenCalled()
    expect(updateItem).not.toHaveBeenCalled()
    expect(usePreferencesSyncStore.getState()).toMatchObject({ isInitialized: true, remoteItemUid: null })
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
    })

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
