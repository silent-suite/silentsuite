'use client'

import { create } from 'zustand'
import {
  deserializePreferences,
  mergeSyncedPreferences,
  serializePreferences,
  type SyncedPreferencesV1,
} from '@silentsuite/core'
import { enqueue } from '@/app/lib/offline-queue'
import { logger } from '@/app/lib/logger'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { usePreferencesStore } from '@/app/stores/use-preferences-store'

const PREFERENCES_TEMP_ID = 'silentsuite-preferences'
const WRITE_DEBOUNCE_MS = 500

interface RemotePreferenceItem {
  uid: string
  preferences: SyncedPreferencesV1
}

interface PreferencesSyncState {
  remoteItemUid: string | null
  pendingCreateTempId: string | null
  isInitialized: boolean
  isApplyingRemote: boolean
  unsubscribePreferences: (() => void) | null
  writeTimer: ReturnType<typeof setTimeout> | null
}

interface PreferencesSyncActions {
  initialize: () => Promise<void>
  loadFromRemote: (items?: { uid: string; content: string }[]) => Promise<void>
  syncLocalToRemote: () => Promise<void>
  scheduleUpload: () => void
  setRemoteItemUid: (uid: string) => void
  destroy: () => void
}

function parseRemoteItems(items: { uid: string; content: string }[]): RemotePreferenceItem[] {
  const parsed: RemotePreferenceItem[] = []
  for (const item of items) {
    try {
      parsed.push({ uid: item.uid, preferences: deserializePreferences(item.content) })
    } catch (err) {
      logger.warn(`[preferences-sync] Ignoring invalid preferences item ${item.uid}`, err)
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

function preferencesChanged(
  current: ReturnType<typeof usePreferencesStore.getState>,
  previous: ReturnType<typeof usePreferencesStore.getState>,
): boolean {
  return current.timeFormat !== previous.timeFormat
    || current.firstDayOfWeek !== previous.firstDayOfWeek
    || current.defaultReminder !== previous.defaultReminder
    || current.defaultTimezone !== previous.defaultTimezone
    || current.dateFormat !== previous.dateFormat
    || current.syncedPreferenceUpdatedAt.timeFormat !== previous.syncedPreferenceUpdatedAt.timeFormat
    || current.syncedPreferenceUpdatedAt.firstDayOfWeek !== previous.syncedPreferenceUpdatedAt.firstDayOfWeek
    || current.syncedPreferenceUpdatedAt.defaultReminder !== previous.syncedPreferenceUpdatedAt.defaultReminder
    || current.syncedPreferenceUpdatedAt.defaultTimezone !== previous.syncedPreferenceUpdatedAt.defaultTimezone
    || current.syncedPreferenceUpdatedAt.dateFormat !== previous.syncedPreferenceUpdatedAt.dateFormat
}

function preferencesCollectionUid(): string | undefined {
  return useEtebaseStore.getState().collections.preferences[0]?.uid
}

export const usePreferencesSyncStore = create<PreferencesSyncState & PreferencesSyncActions>((set, get) => ({
  remoteItemUid: null,
  pendingCreateTempId: null,
  isInitialized: false,
  isApplyingRemote: false,
  unsubscribePreferences: null,
  writeTimer: null,

  initialize: async () => {
    if (get().isInitialized) return
    if (!useEtebaseStore.getState().account) return

    if (!get().unsubscribePreferences) {
      const unsubscribe = usePreferencesStore.subscribe((state, previousState) => {
        if (get().isApplyingRemote) return
        if (!preferencesChanged(state, previousState)) return
        get().scheduleUpload()
      })
      set({ unsubscribePreferences: unsubscribe })
    }

    await get().loadFromRemote()

    set({ isInitialized: true })
  },

  loadFromRemote: async (itemsFromRefresh) => {
    const etebase = useEtebaseStore.getState()
    if (!etebase.account) return

    const items = itemsFromRefresh ?? await etebase.fetchAllItems('preferences')
    const remoteItems = parseRemoteItems(items)
    const canonical = chooseCanonical(remoteItems)
    const mergedRemote = mergeRemoteItems(remoteItems)

    if (!canonical || !mergedRemote) {
      await get().syncLocalToRemote()
      return
    }

    set({ isApplyingRemote: true, remoteItemUid: canonical.uid, pendingCreateTempId: null })
    try {
      usePreferencesStore.getState().applySyncedPreferences(mergedRemote)
    } finally {
      set({ isApplyingRemote: false })
    }

    const mergedLocal = usePreferencesStore.getState().toSyncedPreferences()
    const localContent = serializePreferences(mergedLocal)
    const canonicalContent = serializePreferences(canonical.preferences)
    if (remoteItems.length > 1 || localContent !== canonicalContent) {
      await useEtebaseStore.getState().updateItem('preferences', canonical.uid, localContent)
    }
  },

  syncLocalToRemote: async () => {
    if (get().isApplyingRemote) return

    const etebase = useEtebaseStore.getState()
    if (!etebase.account) return

    const content = serializePreferences(usePreferencesStore.getState().toSyncedPreferences())
    const remoteItemUid = get().remoteItemUid

    if (remoteItemUid && etebase.itemCache.has(remoteItemUid)) {
      await etebase.updateItem('preferences', remoteItemUid, content)
      return
    }

    const existing = parseRemoteItems(await etebase.fetchAllItems('preferences'))
    const canonical = chooseCanonical(existing)
    if (canonical) {
      set({ remoteItemUid: canonical.uid, pendingCreateTempId: null })
      await etebase.updateItem('preferences', canonical.uid, content)
      return
    }

    const collectionUid = preferencesCollectionUid()
    const pendingCreateTempId = get().pendingCreateTempId
    if (pendingCreateTempId && collectionUid) {
      await enqueue({
        type: 'create',
        collectionType: 'preferences',
        collectionUid,
        content,
        tempId: pendingCreateTempId,
      })
      return
    }

    const itemUid = await etebase.createItem('preferences', content, PREFERENCES_TEMP_ID, collectionUid)
    if (itemUid) {
      set({ remoteItemUid: itemUid, pendingCreateTempId: null })
    } else if (typeof navigator !== 'undefined' && !navigator.onLine) {
      set({ pendingCreateTempId: PREFERENCES_TEMP_ID })
    }
  },

  scheduleUpload: () => {
    const existingTimer = get().writeTimer
    if (existingTimer) clearTimeout(existingTimer)

    const writeTimer = setTimeout(() => {
      set({ writeTimer: null })
      void get().syncLocalToRemote()
    }, WRITE_DEBOUNCE_MS)
    set({ writeTimer })
  },

  setRemoteItemUid: (uid) => set({ remoteItemUid: uid, pendingCreateTempId: null }),

  destroy: () => {
    const { unsubscribePreferences, writeTimer } = get()
    if (writeTimer) clearTimeout(writeTimer)
    if (unsubscribePreferences) unsubscribePreferences()
    set({
      remoteItemUid: null,
      pendingCreateTempId: null,
      isInitialized: false,
      isApplyingRemote: false,
      unsubscribePreferences: null,
      writeTimer: null,
    })
  },
}))
