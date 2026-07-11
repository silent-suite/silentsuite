'use client'

import { create } from 'zustand'
import {
  deserializePreferences,
  mergeSyncedPreferences,
  serializePreferences,
  type SyncedPreferencesV1,
} from '@silentsuite/core'
import { logger } from '@/app/lib/logger'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { usePreferencesStore } from '@/app/stores/use-preferences-store'
import { assertCurrentAccountEpoch, getAccountEpoch } from '@/app/lib/account-epoch'

const COLLECTION_TYPE_PREFERENCES = 'silentsuite.preferences'
const PREFERENCES_COLLECTION_NAME = 'Preferences'
const PREFERENCES_TEMP_ID = 'silentsuite-preferences'

interface RemotePreferenceItem {
  uid: string
  preferences: SyncedPreferencesV1
}

interface PreferencesSyncState {
  remoteItemUid: string | null
  isInitialized: boolean
  isApplyingRemote: boolean
  lastSyncedAt: Date | null
}

interface PreferencesSyncActions {
  initialize: () => Promise<void>
  loadFromRemote: (items?: { uid: string; content: string }[]) => Promise<void>
  pushNow: () => Promise<boolean>
  setRemoteItemUid: (uid: string) => void
  destroy: () => void
}

function parseRemoteItems(items: { uid: string; content: string }[]): RemotePreferenceItem[] {
  const parsed: RemotePreferenceItem[] = []
  for (const item of items) {
    try {
      parsed.push({ uid: item.uid, preferences: deserializePreferences(item.content) })
    } catch (err) {
      logger.warn('[preferences-sync] Ignoring invalid preferences item', { errorName: err instanceof Error ? err.name : 'unknown' })
    }
  }
  return parsed
}

function chooseCanonical(items: RemotePreferenceItem[]): RemotePreferenceItem | null {
  if (items.length === 0) return null
  return [...items].sort((a, b) => b.preferences.updatedAt - a.preferences.updatedAt)[0] ?? null
}

function mergeRemoteItems(items: RemotePreferenceItem[]): SyncedPreferencesV1 | null {
  if (items.length === 0) return null
  return mergeSyncedPreferences(items.map((item) => item.preferences))
}

async function listPreferencesCollections(): Promise<any[]> {
  const etebase = useEtebaseStore.getState()
  if (!etebase.account) return []
  if (etebase.collections.preferences.length > 0) return etebase.collections.preferences

  const core = await import('@silentsuite/core')
  const collections = await core.listCollections(etebase.account, COLLECTION_TYPE_PREFERENCES)
  if (collections.length > 0) {
    useEtebaseStore.setState((state) => ({
      collections: { ...state.collections, preferences: collections },
    }))
    for (const collection of collections) {
      etebase.syncEngine?.trackCollection(COLLECTION_TYPE_PREFERENCES as any, collection.uid)
    }
  }
  return collections
}

async function ensurePreferencesCollection(): Promise<string | null> {
  const existing = await listPreferencesCollections()
  if (existing[0]?.uid) return existing[0].uid
  return useEtebaseStore.getState().createCollection('preferences', PREFERENCES_COLLECTION_NAME)
}

async function readRemotePreferenceItems(): Promise<{ uid: string; content: string }[]> {
  const collections = await listPreferencesCollections()
  if (collections.length === 0) return []
  return useEtebaseStore.getState().refreshCollection('preferences')
}

export const usePreferencesSyncStore = create<PreferencesSyncState & PreferencesSyncActions>((set, get) => ({
  remoteItemUid: null,
  isInitialized: false,
  isApplyingRemote: false,
  lastSyncedAt: null,

  initialize: async () => {
    const epoch = getAccountEpoch()
    if (get().isInitialized) return
    if (!useEtebaseStore.getState().account) return

    await get().loadFromRemote()
    assertCurrentAccountEpoch(epoch)
    set({ isInitialized: true })
  },

  loadFromRemote: async (itemsFromRefresh) => {
    const epoch = getAccountEpoch()
    const etebase = useEtebaseStore.getState()
    if (!etebase.account) return

    const items = itemsFromRefresh ?? await readRemotePreferenceItems()
    assertCurrentAccountEpoch(epoch)
    const remoteItems = parseRemoteItems(items)
    const canonical = chooseCanonical(remoteItems)
    const mergedRemote = mergeRemoteItems(remoteItems)

    if (!canonical || !mergedRemote) {
      set({ remoteItemUid: null, lastSyncedAt: new Date() })
      return
    }

    set({ isApplyingRemote: true, remoteItemUid: canonical.uid })
    try {
      assertCurrentAccountEpoch(epoch)
      usePreferencesStore.getState().applySyncedPreferences(mergedRemote)
    } finally {
      assertCurrentAccountEpoch(epoch)
      set({ isApplyingRemote: false, lastSyncedAt: new Date() })
    }
  },

  pushNow: async () => {
    const epoch = getAccountEpoch()
    if (get().isApplyingRemote) return false

    const etebase = useEtebaseStore.getState()
    if (!etebase.account) return false

    const collectionUid = await ensurePreferencesCollection()
    assertCurrentAccountEpoch(epoch)
    if (!collectionUid) return false

    const remoteItems = parseRemoteItems(await readRemotePreferenceItems())
    assertCurrentAccountEpoch(epoch)
    const mergedRemote = mergeRemoteItems(remoteItems)
    const merged = mergedRemote
      ? mergeSyncedPreferences([mergedRemote, usePreferencesStore.getState().toSyncedPreferences()])
      : usePreferencesStore.getState().toSyncedPreferences()
    const content = serializePreferences(merged)
    const canonical = chooseCanonical(remoteItems)

    if (canonical) {
      const canonicalContent = serializePreferences(canonical.preferences)
      if (content === canonicalContent) {
        usePreferencesStore.getState().applySyncedPreferences(merged)
        set({ remoteItemUid: canonical.uid, lastSyncedAt: new Date() })
        return true
      }
      const beforeUpdateItem = useEtebaseStore.getState().itemCache.get(canonical.uid)
      await etebase.updateItem('preferences', canonical.uid, content)
      assertCurrentAccountEpoch(epoch)
      const afterUpdateItem = useEtebaseStore.getState().itemCache.get(canonical.uid)
      if (!afterUpdateItem || afterUpdateItem === beforeUpdateItem) {
        return false
      }
      set({ remoteItemUid: canonical.uid, lastSyncedAt: new Date() })
      return true
    }

    const itemUid = await etebase.createItem('preferences', content, PREFERENCES_TEMP_ID, collectionUid)
    assertCurrentAccountEpoch(epoch)
    if (itemUid) {
      set({ remoteItemUid: itemUid, lastSyncedAt: new Date() })
      return true
    }
    return false
  },

  setRemoteItemUid: (uid) => set({ remoteItemUid: uid }),

  destroy: () => {
    set({
      remoteItemUid: null,
      isInitialized: false,
      isApplyingRemote: false,
      lastSyncedAt: null,
    })
  },
}))
