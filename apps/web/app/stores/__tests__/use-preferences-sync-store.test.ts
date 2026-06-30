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

function resetStores() {
  usePreferencesSyncStore.getState().destroy()
  usePreferencesStore.getState().resetSyncedPreferences()
  usePreferencesStore.setState({ notificationSound: true })
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

function mockRemoteItem(uid: string, content: string) {
  return {
    uid,
    isDeleted: false,
    getContent: vi.fn(async () => content),
  }
}

describe('usePreferencesSyncStore', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
  })

  it('creates a remote preferences item from local synced fields only', async () => {
    usePreferencesStore.getState().setTimeFormat('24h')
    usePreferencesStore.setState({ notificationSound: false })

    const createdItem = {
      uid: 'pref-1',
      getMeta: vi.fn(() => ({})),
      setMeta: vi.fn(),
      getContent: vi.fn(),
      isDeleted: false,
    }
    const itemManager = {
      create: vi.fn(async (_meta: Record<string, string>, _content: string) => createdItem),
      batch: vi.fn(async () => {}),
    }
    const account = {
      getCollectionManager: () => ({
        getItemManager: () => itemManager,
      }),
    }
    useEtebaseStore.setState({
      account: account as any,
      collections: { calendar: [], tasks: [], contacts: [], preferences: [{ uid: 'prefs-col' }] as any[] },
      isInitialized: true,
    })

    await usePreferencesSyncStore.getState().syncLocalToRemote()

    expect(itemManager.create).toHaveBeenCalledTimes(1)
    const content = itemManager.create.mock.calls[0]?.[1] as string
    expect(content).toContain('timeFormat')
    expect(content).toContain('24h')
    expect(content).not.toContain('notificationSound')
    expect(usePreferencesSyncStore.getState().remoteItemUid).toBe('pref-1')
  })

  it('hydrates remote preferences without changing local notification sound', async () => {
    usePreferencesStore.setState({ notificationSound: false })
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
    const item = mockRemoteItem('pref-1', serializePreferences(remote))
    useEtebaseStore.setState({
      account: { id: 'account' } as any,
      collections: { calendar: [], tasks: [], contacts: [], preferences: [{ uid: 'prefs-col' }] as any[] },
      itemCache: new Map([['pref-1', item]]),
      itemTypeMap: new Map([['pref-1', 'preferences']]),
      itemCollectionMap: new Map([['pref-1', 'prefs-col']]),
      isInitialized: true,
    })

    await usePreferencesSyncStore.getState().loadFromRemote()

    expect(usePreferencesStore.getState()).toMatchObject({
      timeFormat: '24h',
      firstDayOfWeek: 'sunday',
      defaultReminder: '30',
      defaultTimezone: 'Europe/Amsterdam',
      notificationSound: false,
    })
    expect(usePreferencesSyncStore.getState().remoteItemUid).toBe('pref-1')
  })
})
