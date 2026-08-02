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
import { AccountBoundaryChangedError, assertCurrentAccountEpoch, getAccountEpoch } from '@/app/lib/account-epoch'

const COLLECTION_TYPE_PREFERENCES = 'silentsuite.preferences'
const PREFERENCES_COLLECTION_NAME = 'Preferences'
const PREFERENCES_TEMP_ID = 'silentsuite-preferences'

let operationCounter = 0
let readCounter = 0
let currentOperation: { epoch: number; generation: number; promise: Promise<void> } | null = null
const trackedCollections = new WeakMap<object, Set<string>>()

class StalePreferenceReadError extends Error {
  constructor() {
    super('Stale preference read')
    this.name = 'StalePreferenceReadError'
  }
}

interface RemotePreferenceItem {
  uid: string
  preferences: SyncedPreferencesV1
}

interface PreferencesSyncState {
  status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'failed'
  integrity: 'unknown' | 'valid' | 'unavailable' | 'failed'
  operationEpoch: number | null
  operationGeneration: number
  readGeneration: number
  remoteItemUid: string | null
  isInitialized: boolean
  isApplyingRemote: boolean
  lastSyncedAt: Date | null
}

interface PreferencesSyncActions {
  initialize: (force?: boolean) => Promise<void>
  beginRemoteRead: (accountEpoch?: number, operationGeneration?: number) => number | null
  loadFromRemote: (items?: { uid: string; content: string }[], accountEpoch?: number, generation?: number, readGeneration?: number) => Promise<void>
  recordRemoteReadFailure: (accountEpoch?: number, generation?: number, readGeneration?: number) => void
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

function assertCurrentOperation(accountEpoch: number, generation: number) {
  assertCurrentAccountEpoch(accountEpoch)
  const state = usePreferencesSyncStore.getState()
  if (state.operationEpoch !== accountEpoch || state.operationGeneration !== generation) {
    throw new AccountBoundaryChangedError()
  }
}

function assertCurrentRead(accountEpoch: number, generation: number, readGeneration: number) {
  assertCurrentOperation(accountEpoch, generation)
  if (usePreferencesSyncStore.getState().readGeneration !== readGeneration) {
    throw new StalePreferenceReadError()
  }
}

async function trackPreferencesCollection(engine: object | null, uid: string, accountEpoch: number, generation: number) {
  if (!engine) return
  assertCurrentOperation(accountEpoch, generation)
  let tracked = trackedCollections.get(engine)
  if (tracked?.has(uid)) return
  await (engine as any).trackCollection(COLLECTION_TYPE_PREFERENCES, uid)
  assertCurrentOperation(accountEpoch, generation)
  if (!tracked) {
    tracked = new Set()
    trackedCollections.set(engine, tracked)
  }
  tracked.add(uid)
}

async function listPreferencesCollections(accountEpoch: number, generation: number): Promise<any[]> {
  assertCurrentOperation(accountEpoch, generation)
  const etebase = useEtebaseStore.getState()
  if (!etebase.account) return []
  if (etebase.collections.preferences.length > 0) {
    for (const collection of etebase.collections.preferences) {
      await trackPreferencesCollection(etebase.syncEngine, collection.uid, accountEpoch, generation)
    }
    return etebase.collections.preferences
  }

  const core = await import('@silentsuite/core')
  assertCurrentOperation(accountEpoch, generation)
  const collections = await core.listCollections(etebase.account, COLLECTION_TYPE_PREFERENCES)
  assertCurrentOperation(accountEpoch, generation)
  if (collections.length > 0) {
    const currentEtebase = useEtebaseStore.getState()
    if (currentEtebase.account !== etebase.account || currentEtebase.syncEngine !== etebase.syncEngine) return []
    useEtebaseStore.setState((state) => ({
      collections: { ...state.collections, preferences: collections },
    }))
    assertCurrentOperation(accountEpoch, generation)
    for (const collection of collections) {
      assertCurrentOperation(accountEpoch, generation)
      if (useEtebaseStore.getState().syncEngine !== etebase.syncEngine) return []
      await trackPreferencesCollection(etebase.syncEngine, collection.uid, accountEpoch, generation)
    }
  }
  return collections
}

async function readRemotePreferenceItems(accountEpoch: number, generation: number): Promise<{ uid: string; content: string }[]> {
  const collections = await listPreferencesCollections(accountEpoch, generation)
  assertCurrentOperation(accountEpoch, generation)
  if (collections.length === 0) return []
  return useEtebaseStore.getState().refreshCollection('preferences')
}

export const usePreferencesSyncStore = create<PreferencesSyncState & PreferencesSyncActions>((set, get) => ({
  status: 'idle',
  integrity: 'unknown',
  operationEpoch: null,
  operationGeneration: 0,
  readGeneration: 0,
  remoteItemUid: null,
  isInitialized: false,
  isApplyingRemote: false,
  lastSyncedAt: null,

  initialize: (force = false) => {
    const epoch = getAccountEpoch()
    if (currentOperation?.epoch === epoch) return currentOperation.promise
    if (!force && get().status !== 'idle' && get().operationEpoch === epoch) return Promise.resolve()
    const generation = ++operationCounter
    if (!useEtebaseStore.getState().account) {
      set({ status: 'unavailable', integrity: 'unavailable', operationEpoch: epoch, operationGeneration: generation })
      return Promise.resolve()
    }

    set({ status: 'loading', integrity: 'unknown', operationEpoch: epoch, operationGeneration: generation })
    const promise = (async () => {
      try {
        await get().loadFromRemote(undefined, epoch, generation)
        assertCurrentOperation(epoch, generation)
        if (get().integrity === 'failed') return
        set({ isInitialized: true, status: 'ready', integrity: 'valid' })
      } catch (err) {
        if (err instanceof StalePreferenceReadError) return
        if (getAccountEpoch() === epoch && get().operationGeneration === generation) {
          set({ status: 'failed', integrity: 'failed' })
        }
        if (err instanceof AccountBoundaryChangedError) throw err
      } finally {
        if (currentOperation?.epoch === epoch && currentOperation.generation === generation) currentOperation = null
      }
    })()
    currentOperation = { epoch, generation, promise }
    return promise
  },

  beginRemoteRead: (accountEpoch, operationGeneration) => {
    const epoch = accountEpoch ?? getAccountEpoch()
    const generation = operationGeneration ?? get().operationGeneration
    if (getAccountEpoch() !== epoch || get().operationEpoch !== epoch || get().operationGeneration !== generation) return null
    const readGeneration = ++readCounter
    set({ readGeneration })
    return readGeneration
  },

  loadFromRemote: async (itemsFromRefresh, initiatingEpoch, generation, initiatingReadGeneration) => {
    const epoch = initiatingEpoch ?? getAccountEpoch()
    let operationGeneration = generation ?? get().operationGeneration
    if (get().operationEpoch === null && generation === undefined) {
      operationGeneration = ++operationCounter
      set({ operationEpoch: epoch, operationGeneration })
    }
    const remoteReadGeneration = initiatingReadGeneration ?? get().beginRemoteRead(epoch, operationGeneration)
    if (remoteReadGeneration === null) throw new AccountBoundaryChangedError()
    assertCurrentRead(epoch, operationGeneration, remoteReadGeneration)
    const etebase = useEtebaseStore.getState()
    if (!etebase.account) return

    let items: { uid: string; content: string }[]
    try {
      items = itemsFromRefresh ?? await readRemotePreferenceItems(epoch, operationGeneration)
      assertCurrentRead(epoch, operationGeneration, remoteReadGeneration)
    } catch (err) {
      if (!(err instanceof AccountBoundaryChangedError || err instanceof StalePreferenceReadError)) {
        get().recordRemoteReadFailure(epoch, operationGeneration, remoteReadGeneration)
      }
      throw err
    }
    const remoteItems = parseRemoteItems(items)
    if (items.length > 0 && remoteItems.length === 0) {
      assertCurrentRead(epoch, operationGeneration, remoteReadGeneration)
      set({ status: 'failed', integrity: 'failed' })
      return
    }
    const canonical = chooseCanonical(remoteItems)
    const mergedRemote = mergeRemoteItems(remoteItems)

    if (!canonical || !mergedRemote) {
      assertCurrentRead(epoch, operationGeneration, remoteReadGeneration)
      set({ remoteItemUid: null, lastSyncedAt: new Date(), isInitialized: true, status: 'ready', integrity: 'valid' })
      return
    }

    assertCurrentRead(epoch, operationGeneration, remoteReadGeneration)
    set({ isApplyingRemote: true, remoteItemUid: canonical.uid })
    try {
      assertCurrentRead(epoch, operationGeneration, remoteReadGeneration)
      usePreferencesStore.getState().applySyncedPreferences(mergedRemote)
    } finally {
      assertCurrentRead(epoch, operationGeneration, remoteReadGeneration)
      set({ isApplyingRemote: false, lastSyncedAt: new Date(), isInitialized: true, status: 'ready', integrity: 'valid' })
    }
  },

  recordRemoteReadFailure: (accountEpoch, generation, initiatingReadGeneration) => {
    const epoch = accountEpoch ?? getAccountEpoch()
    const operationGeneration = generation ?? get().operationGeneration
    const remoteReadGeneration = initiatingReadGeneration ?? get().readGeneration
    if (
      getAccountEpoch() !== epoch ||
      get().operationEpoch !== epoch ||
      get().operationGeneration !== operationGeneration ||
      get().readGeneration !== remoteReadGeneration
    ) return
    set({ status: 'failed', integrity: 'failed' })
  },

  pushNow: async () => {
    const epoch = getAccountEpoch()
    if (get().isApplyingRemote) return false

    const etebase = useEtebaseStore.getState()
    if (!etebase.account) return false
    if (get().status === 'unavailable') return false
    if (get().status === 'failed') await get().initialize(true)
    const generation = get().operationGeneration
    if (get().status !== 'ready' || get().integrity !== 'valid' || get().operationEpoch !== epoch) return false

    const remoteReadGeneration = get().beginRemoteRead(epoch, generation)
    if (remoteReadGeneration === null) return false

    let rawRemoteItems: { uid: string; content: string }[]
    try {
      rawRemoteItems = await readRemotePreferenceItems(epoch, generation)
      assertCurrentRead(epoch, generation, remoteReadGeneration)
    } catch (err) {
      if (!(err instanceof AccountBoundaryChangedError || err instanceof StalePreferenceReadError)) {
        get().recordRemoteReadFailure(epoch, generation, remoteReadGeneration)
      }
      return false
    }
    const remoteItems = parseRemoteItems(rawRemoteItems)
    if (rawRemoteItems.length > 0 && remoteItems.length === 0) {
      get().recordRemoteReadFailure(epoch, generation, remoteReadGeneration)
      return false
    }
    const mergedRemote = mergeRemoteItems(remoteItems)
    const merged = mergedRemote
      ? mergeSyncedPreferences([mergedRemote, usePreferencesStore.getState().toSyncedPreferences()])
      : usePreferencesStore.getState().toSyncedPreferences()
    const content = serializePreferences(merged)
    const canonical = chooseCanonical(remoteItems)

    if (canonical) {
      const canonicalContent = serializePreferences(canonical.preferences)
      if (content === canonicalContent) {
        assertCurrentRead(epoch, generation, remoteReadGeneration)
        usePreferencesStore.getState().applySyncedPreferences(merged)
        set({ remoteItemUid: canonical.uid, lastSyncedAt: new Date() })
        return true
      }
      const beforeUpdateItem = useEtebaseStore.getState().itemCache.get(canonical.uid)
      await etebase.updateItem('preferences', canonical.uid, content)
      assertCurrentRead(epoch, generation, remoteReadGeneration)
      const afterUpdateItem = useEtebaseStore.getState().itemCache.get(canonical.uid)
      if (!afterUpdateItem || afterUpdateItem === beforeUpdateItem) {
        return false
      }
      set({ remoteItemUid: canonical.uid, lastSyncedAt: new Date() })
      return true
    }

    let collectionUid = useEtebaseStore.getState().collections.preferences[0]?.uid ?? null
    if (!collectionUid) {
      try {
        collectionUid = await useEtebaseStore.getState().createCollection('preferences', PREFERENCES_COLLECTION_NAME)
        assertCurrentRead(epoch, generation, remoteReadGeneration)
      } catch {
        return false
      }
    }
    if (!collectionUid) return false

    const itemUid = await etebase.createItem('preferences', content, PREFERENCES_TEMP_ID, collectionUid)
    assertCurrentRead(epoch, generation, remoteReadGeneration)
    if (itemUid) {
      set({ remoteItemUid: itemUid, lastSyncedAt: new Date() })
      return true
    }
    return false
  },

  setRemoteItemUid: (uid) => set({ remoteItemUid: uid }),

  destroy: () => {
    currentOperation = null
    operationCounter += 1
    set({
      status: 'idle',
      integrity: 'unknown',
      operationEpoch: null,
      operationGeneration: operationCounter,
      readGeneration: ++readCounter,
      remoteItemUid: null,
      isInitialized: false,
      isApplyingRemote: false,
      lastSyncedAt: null,
    })
  },
}))
