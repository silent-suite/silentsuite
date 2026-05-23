'use client'

import { create } from 'zustand'
import { ETEBASE_SERVER_URL } from '@/app/lib/config'
import type {
  CollectionType,
  SyncChangeEvent,
} from '@silentsuite/core'
import {
  enqueue,
  getAll as getQueuedMutations,
  isOfflineError,
  remove as removeQueuedMutation,
} from '@/app/lib/offline-queue'
import { secureGet } from '@/app/lib/secure-storage'
import { showErrorToast } from '@/app/stores/use-toast-store'
import { logger } from '@/app/lib/logger'
import {
  ensureFingerprint as cacheEnsureFingerprint,
  getStoken as cacheGetStoken,
  setStoken as cacheSetStoken,
  putItems as cachePutItems,
  putItem as cachePutItem,
  deleteItem as cacheDeleteItem,
  replaceItemsForCollection as cacheReplaceItemsForCollection,
  isCacheEnabled as isLocalCacheEnabled,
  type CachedItem,
} from '@/app/lib/data-cache'

/**
 * Holds live Etebase SDK objects (Account, Collections, Items, SyncEngine).
 * These are non-serializable and must NOT go through Zustand persist.
 * This store is the bridge between the Etebase SDK and the UI data stores.
 */

// We dynamically import Etebase types to avoid SSR issues with the etebase WASM module.
// The actual Etebase SDK objects are stored as `any` in the store and typed at usage sites.

const DEFAULT_ETEBASE_SERVER_URL = ETEBASE_SERVER_URL

function isValidServerUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** Normalize a server URL: trim, add https:// if no protocol present. */
export function normalizeServerUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return trimmed
  if (!/^https?:\/\//i.test(trimmed)) return `https://${trimmed}`
  return trimmed
}

/** Read the user's custom server URL from localStorage, falling back to the env default. */
function getServerUrl(): string {
  if (typeof window !== 'undefined') {
    const custom = localStorage.getItem('silentsuite-server-url')
    if (custom && custom.trim()) {
      const normalized = normalizeServerUrl(custom)
      if (isValidServerUrl(normalized)) return normalized
    }
  }
  return DEFAULT_ETEBASE_SERVER_URL
}

const COLLECTION_TYPE_CALENDAR = 'etebase.vevent'
const COLLECTION_TYPE_TASKS = 'etebase.vtodo'
const COLLECTION_TYPE_CONTACTS = 'etebase.vcard'

type CollectionTypeKey = 'calendar' | 'tasks' | 'contacts'
type CollectionMetaUpdates = { name?: string; description?: string; color?: string }
type EtebaseCore = typeof import('@silentsuite/core')

type CachedContentItem = { uid: string; content: string; collectionUid: string }

const COLLECTION_DEFINITIONS: [CollectionTypeKey, string, string][] = [
  ['calendar', COLLECTION_TYPE_CALENDAR, 'Personal Calendar'],
  ['tasks', COLLECTION_TYPE_TASKS, 'Personal Tasks'],
  ['contacts', COLLECTION_TYPE_CONTACTS, 'Personal Contacts'],
]

function collectionTypeToKey(ct: string): CollectionTypeKey | null {
  if (ct === COLLECTION_TYPE_CALENDAR) return 'calendar'
  if (ct === COLLECTION_TYPE_TASKS) return 'tasks'
  if (ct === COLLECTION_TYPE_CONTACTS) return 'contacts'
  return null
}

function keyToCollectionType(type: CollectionTypeKey): string {
  if (type === 'calendar') return COLLECTION_TYPE_CALENDAR
  if (type === 'tasks') return COLLECTION_TYPE_TASKS
  return COLLECTION_TYPE_CONTACTS
}

async function ensureCollectionsForAccount(
  account: any,
  core: EtebaseCore,
): Promise<Record<CollectionTypeKey, any[]>> {
  const collections: Record<CollectionTypeKey, any[]> = {
    calendar: [],
    tasks: [],
    contacts: [],
  }

  for (const [key, colType, defaultName] of COLLECTION_DEFINITIONS) {
    const existing = await core.listCollections(account, colType)
    if (existing.length > 0) {
      collections[key] = existing
      logger.debug(`[etebase-store] Found ${existing.length} existing ${key} collection(s)`)
    } else {
      const created = await core.createCollection(account, colType, { name: defaultName })
      collections[key] = [created]
      logger.debug(`[etebase-store] Created ${key} collection: ${created.uid}`)
    }
  }

  return collections
}

async function trackCollectionWithSyncEngine(
  syncEngine: any | null,
  collectionType: string,
  type: CollectionTypeKey,
  collectionUid: string,
): Promise<void> {
  if (!syncEngine) return
  syncEngine.trackCollection(collectionType as CollectionType, collectionUid)
  if (!isLocalCacheEnabled()) return
  try {
    const stoken = await cacheGetStoken(collectionUid)
    if (stoken) {
      syncEngine.setStoken?.(collectionUid, stoken)
      logger.debug(`[etebase-store] Seeded ${type} stoken from cache`)
    }
  } catch (err) {
    logger.warn(`[etebase-store] Failed to seed ${type} stoken`, err)
  }
}

/**
 * Best-effort cache write. Decodes the item content (already decrypted by
 * the Etebase SDK at this point) and stores it under the item UID. Failures
 * are swallowed inside data-cache; we never block on cache writes.
 */
async function writeItemToCache(
  type: CollectionTypeKey,
  collectionUid: string,
  itemUid: string,
  content: string,
): Promise<void> {
  if (!isLocalCacheEnabled()) return
  const record: CachedItem = {
    itemUid,
    collectionType: type,
    collectionUid,
    content,
    lastModified: Date.now(),
  }
  await cachePutItem(record)
}

function resolveCollection(
  collections: Record<CollectionTypeKey, any[]>,
  type: CollectionTypeKey,
  collectionUid?: string,
): any | null {
  const typedCollections = collections[type] ?? []
  if (collectionUid && collectionUid !== 'default' && collectionUid !== 'all') {
    const match = typedCollections.find((collection) => collection.uid === collectionUid)
    if (match) return match
    logger.warn(`[etebase-store] Unknown ${type} collection ${collectionUid}`)
    return null
  }
  return typedCollections[0] ?? null
}

function getCollectionName(collection: any, fallback: string): string {
  try {
    const meta = collection?.getMeta?.()
    return meta?.name || fallback
  } catch {
    return fallback
  }
}

function getCollectionColor(collection: any): string | undefined {
  try {
    return collection?.getMeta?.()?.color
  } catch {
    return undefined
  }
}

async function hydrateListStores(collections: Record<CollectionTypeKey, any[]>): Promise<void> {
  const [calendarListStore, taskListStore, contactListStore] = await Promise.all([
    import('@/app/stores/use-calendar-list-store'),
    import('@/app/stores/use-task-list-store'),
    import('@/app/stores/use-contact-list-store'),
  ])

  calendarListStore.useCalendarListStore.getState().replaceCalendarsFromRemote(
    collections.calendar.map((collection, index) => ({
      id: collection.uid,
      name: getCollectionName(collection, index === 0 ? 'Personal' : `Calendar ${index + 1}`),
      color: getCollectionColor(collection) || calendarListStore.DEFAULT_CALENDAR_COLORS[index % calendarListStore.DEFAULT_CALENDAR_COLORS.length],
      visible: true,
    })),
  )
  taskListStore.useTaskListStore.getState().replaceListsFromRemote(
    collections.tasks.map((collection, index) => ({
      id: collection.uid,
      name: getCollectionName(collection, index === 0 ? 'My Tasks' : `Task List ${index + 1}`),
      color: getCollectionColor(collection) || taskListStore.DEFAULT_TASK_LIST_COLORS[index % taskListStore.DEFAULT_TASK_LIST_COLORS.length],
      visible: true,
    })),
  )
  contactListStore.useContactListStore.getState().replaceListsFromRemote(
    collections.contacts.map((collection, index) => ({
      id: collection.uid,
      name: getCollectionName(collection, index === 0 ? 'My Contacts' : `Contacts ${index + 1}`),
      color: getCollectionColor(collection) || contactListStore.DEFAULT_CONTACT_LIST_COLORS[index % contactListStore.DEFAULT_CONTACT_LIST_COLORS.length],
      visible: true,
    })),
  )
}

async function removeItemsFromDomainStore(type: CollectionTypeKey, collectionUid: string, itemUids?: string[]): Promise<number> {
  const itemUidSet = itemUids ? new Set(itemUids) : null

  if (type === 'calendar') {
    const { useCalendarStore } = await import('@/app/stores/use-calendar-store')
    let removed = 0
    useCalendarStore.setState((state) => {
      const events = state.events.filter((event) => {
        const shouldRemove = itemUidSet
          ? itemUidSet.has(event.id)
          : (event.calendarId ?? 'default') === collectionUid
        if (shouldRemove) removed++
        return !shouldRemove
      })
      const selectedEventId = state.selectedEventId && (itemUidSet
        ? itemUidSet.has(state.selectedEventId)
        : state.events.some((event) => event.id === state.selectedEventId && (event.calendarId ?? 'default') === collectionUid))
        ? null
        : state.selectedEventId
      return { events, selectedEventId }
    })
    return removed
  }
  if (type === 'tasks') {
    const { useTaskStore } = await import('@/app/stores/use-task-store')
    let removed = 0
    useTaskStore.setState((state) => ({
      tasks: state.tasks.filter((task) => {
        const shouldRemove = itemUidSet
          ? itemUidSet.has(task.id)
          : (task.listId ?? 'default') === collectionUid
        if (shouldRemove) removed++
        return !shouldRemove
      }),
    }))
    return removed
  }
  const { useContactStore } = await import('@/app/stores/use-contact-store')
  let removed = 0
  useContactStore.setState((state) => ({
    contacts: state.contacts.filter((contact) => {
      const shouldRemove = itemUidSet
        ? itemUidSet.has(contact.id)
        : (contact.listId ?? 'default') === collectionUid
      if (shouldRemove) removed++
      return !shouldRemove
    }),
  }))
  return removed
}

async function removeQueuedMutationsForCollection(type: CollectionTypeKey, collectionUid: string, includeDeletes: boolean): Promise<number> {
  try {
    const entries = await getQueuedMutations()
    const matching = entries.filter((entry) => (
      entry.collectionType === type
      && entry.collectionUid === collectionUid
      && (includeDeletes || entry.type !== 'delete')
    ))
    for (const entry of matching) {
      await removeQueuedMutation(entry.id)
    }
    return matching.length
  } catch (err) {
    logger.warn(`[etebase-store] Failed to prune queued mutations for ${type}/${collectionUid}`, err)
    return 0
  }
}

function collectionItemNoun(type: CollectionTypeKey): string {
  if (type === 'calendar') return 'events'
  if (type === 'tasks') return 'tasks'
  return 'contacts'
}

interface EtebaseState {
  // The live Account object (null until session restored)
  account: any | null
  // Collection references keyed by type; each type may have multiple collections.
  collections: Record<CollectionTypeKey, any[]>
  // Item cache: itemUid -> Etebase.Item (needed for update/delete which require the Item object)
  itemCache: Map<string, any>
  // Tracks which collection type each item belongs to
  itemTypeMap: Map<string, CollectionTypeKey>
  // Tracks the concrete collection UID each item belongs to for update/delete routing
  itemCollectionMap: Map<string, string>
  // Whether initial data load from server is complete
  isInitialized: boolean
  // SyncEngine reference
  syncEngine: any | null
}

interface EtebaseActions {
  /**
   * Restore Etebase session from localStorage, initialize collections,
   * load all items into data stores, and start the SyncEngine.
   */
  initialize: () => Promise<void>

  /**
   * Create an item in the given collection type.
   * Returns the item UID.
   * @param tempId - optional temp ID from the domain store, used for offline queue mapping
   */
  createItem: (type: CollectionTypeKey, content: string, tempId?: string, collectionUid?: string) => Promise<string | null>

  /**
   * Create a new Etebase collection for the given type.
   */
  createCollection: (type: CollectionTypeKey, name: string, color?: string) => Promise<string | null>

  /**
   * Delete an Etebase collection and remove its cached items locally.
   */
  deleteCollection: (type: CollectionTypeKey, collectionUid: string) => Promise<boolean>

  /**
   * Update Etebase collection metadata and refresh local list stores.
   */
  updateCollectionMeta: (type: CollectionTypeKey, collectionUid: string, updates: CollectionMetaUpdates) => Promise<boolean>

  /**
   * Re-list remote collections and reconcile local state with active collections.
   */
  reconcileCollections: () => Promise<void>

  /**
   * Delete every item inside a collection while keeping the collection itself.
   */
  deleteItemsInCollection: (type: CollectionTypeKey, collectionUid: string) => Promise<number>

  /**
   * Create multiple items in a single batch upload.
   * Returns an array of item UIDs (null for any that failed).
   */
  createItemsBatch: (type: CollectionTypeKey, contents: { content: string; tempId: string }[], collectionUid?: string) => Promise<(string | null)[]>

  /**
   * Update an existing item by UID.
   */
  updateItem: (type: CollectionTypeKey, itemUid: string, content: string) => Promise<void>

  /**
   * Delete an item by UID.
   */
  deleteItem: (type: CollectionTypeKey, itemUid: string) => Promise<void>

  /**
   * Fetch all items from the local cache for a collection type.
   */
  fetchAllItems: (type: CollectionTypeKey) => Promise<CachedContentItem[]>

  /**
   * Re-fetch all items from the Etebase server for a collection type.
   * Updates the local cache and returns fresh content.
   * This is what the sync change handler should call.
   */
  refreshCollection: (type: CollectionTypeKey, collectionUid?: string) => Promise<CachedContentItem[]>

  /**
   * Clean up on logout -- stop sync engine, clear all state.
   */
  destroy: () => void

  /**
   * Register a handler for sync change events from the SyncEngine.
   * Returns an unsubscribe function.
   */
  onSyncChange: (handler: (event: SyncChangeEvent) => void) => (() => void) | null

  /**
   * Register a handler for sync status changes.
   */
  onStatusChange: (handler: (status: string) => void) => (() => void) | null
}

export const useEtebaseStore = create<EtebaseState & EtebaseActions>((set, get) => ({
  account: null,
  collections: { calendar: [], tasks: [], contacts: [] },
  itemCache: new Map(),
  itemTypeMap: new Map(),
  itemCollectionMap: new Map(),
  isInitialized: false,
  syncEngine: null,

  initialize: async () => {
    const savedSession = await secureGet('etebase_session')
    if (!savedSession) {
      logger.debug('[etebase-store] No saved session, skipping initialization')
      return
    }

    try {
      // Dynamic import to avoid SSR issues with etebase WASM
      const core = await import('@silentsuite/core')

      // 1. Restore the Account
      logger.debug('[etebase-store] Restoring Etebase session...')
      const serverUrl = getServerUrl()
      const account = await core.restoreSession(serverUrl, savedSession)
      set({ account })
      logger.debug('[etebase-store] Session restored')

      // Local-cache fingerprint check: if a different account previously
      // hydrated this browser, wipe before reseeding. Belt-and-braces against
      // the Android-style stale-cache contamination bug.
      const cacheEnabled = isLocalCacheEnabled()
      if (cacheEnabled) {
        try {
          const username = (account as any)?.user?.username ?? 'unknown'
          await cacheEnsureFingerprint(String(username))
        } catch (err) {
          logger.warn('[etebase-store] Cache fingerprint check failed', err)
        }
      }

      // 2. Ensure collections exist (create if first login, fetch if returning)
      const collections = await ensureCollectionsForAccount(account, core)

      set({ collections })
      await hydrateListStores(collections)

      // 3. Load all items from each collection into the cache
      const itemCache = new Map<string, any>()
      const itemTypeMap = new Map<string, CollectionTypeKey>()
      const itemCollectionMap = new Map<string, string>()

      for (const [key] of COLLECTION_DEFINITIONS) {
        const typedCollections = collections[key]

        for (const collection of typedCollections) {
          let stoken: string | null = null
          let done = false

          while (!done) {
            const response = await core.listItems(account, collection, stoken)
            for (const item of response.items) {
              if (!item.isDeleted) {
                itemCache.set(item.uid, item)
                itemTypeMap.set(item.uid, key)
                itemCollectionMap.set(item.uid, collection.uid)
              }
            }
            stoken = response.stoken
            done = response.done
          }
        }
      }

      set({ itemCache, itemTypeMap, itemCollectionMap })
      logger.debug(`[etebase-store] Loaded ${itemCache.size} items into cache`)

      // 4. Start SyncEngine
      const engine = new core.SyncEngine({
        serverUrl: serverUrl,
        pollIntervalMs: 30_000,
      })

      // Track all collections
      for (const [key, colType] of COLLECTION_DEFINITIONS) {
        for (const collection of collections[key]) {
          await trackCollectionWithSyncEngine(engine, colType, key, collection.uid)
        }
      }

      // Seed persisted stokens before starting so the first sync round
      // pulls only deltas instead of refetching the whole vault. Wire the
      // advance handler so subsequent stoken updates are persisted too.
      if (cacheEnabled) {
        engine.onStokenAdvance((event: { collectionType: string; collectionUid: string; stoken: string | null }) => {
          const key = collectionTypeToKey(event.collectionType)
          if (!key) return
          // Fire-and-forget — persistence failures are logged inside the cache module.
          void cacheSetStoken(key, event.collectionUid, event.stoken)
        })
      }

      await engine.start(account)
      set({ syncEngine: engine, isInitialized: true })
      logger.debug('[etebase-store] SyncEngine started')
    } catch (err) {
      console.error('[etebase-store] Initialization failed:', err)
      // Don't clear the session -- the user might be offline
      // They can retry on next page load
      set({ isInitialized: true })
      if (!isOfflineError(err)) {
        showErrorToast('Failed to restore session. Please try signing in again.')
      }
    }
  },

  createCollection: async (type: CollectionTypeKey, name: string, color?: string) => {
    const { account, collections, syncEngine } = get()
    if (!account) {
      logger.warn('[etebase-store] Cannot create collection: no account')
      return null
    }

    try {
      const core = await import('@silentsuite/core')
      const colType = keyToCollectionType(type)
      const collection = await core.createCollection(account, colType, { name, color })
      const newCollections = {
        ...collections,
        [type]: [...collections[type], collection],
      }
      syncEngine?.trackCollection(colType as CollectionType, collection.uid)
      set({ collections: newCollections })
      await hydrateListStores(newCollections)
      return collection.uid
    } catch (err) {
      console.error(`[etebase-store] Failed to create ${type} collection:`, err)
      showErrorToast(`Failed to create ${type === 'calendar' ? 'calendar' : type === 'tasks' ? 'task list' : 'address book'}. Please try again.`)
      return null
    }
  },

  deleteCollection: async (type: CollectionTypeKey, collectionUid: string) => {
    const { account, collections, syncEngine } = get()
    const collection = resolveCollection(collections, type, collectionUid)
    if (!account || !collection) {
      logger.warn(`[etebase-store] Cannot delete ${type} collection ${collectionUid}: missing account or collection`)
      return false
    }
    if (collections[type].length <= 1) {
      showErrorToast(`Create another ${type === 'calendar' ? 'calendar' : type === 'tasks' ? 'task list' : 'address book'} before deleting this one.`)
      return false
    }

    try {
      const core = await import('@silentsuite/core')
      await core.deleteCollection(account, collection)

      const newItemCache = new Map(get().itemCache)
      const newItemTypeMap = new Map(get().itemTypeMap)
      const newItemCollectionMap = new Map(get().itemCollectionMap)
      for (const [uid, mappedCollectionUid] of newItemCollectionMap.entries()) {
        if (mappedCollectionUid === collection.uid) {
          newItemCache.delete(uid)
          newItemTypeMap.delete(uid)
          newItemCollectionMap.delete(uid)
        }
      }

      const newCollections = {
        ...get().collections,
        [type]: get().collections[type].filter((existing) => existing.uid !== collection.uid),
      }
      syncEngine?.untrackCollection(collection.uid)
      set({
        collections: newCollections,
        itemCache: newItemCache,
        itemTypeMap: newItemTypeMap,
        itemCollectionMap: newItemCollectionMap,
      })
      if (isLocalCacheEnabled()) {
        void cacheReplaceItemsForCollection(collection.uid, [])
      }
      await removeQueuedMutationsForCollection(type, collection.uid, true)
      await removeItemsFromDomainStore(type, collection.uid)
      await hydrateListStores(newCollections)
      return true
    } catch (err) {
      console.error(`[etebase-store] Failed to delete ${type} collection ${collectionUid}:`, err)
      showErrorToast(`Failed to delete ${type === 'calendar' ? 'calendar' : type === 'tasks' ? 'task list' : 'address book'}. Please try again.`)
      return false
    }
  },

  updateCollectionMeta: async (type: CollectionTypeKey, collectionUid: string, updates: CollectionMetaUpdates) => {
    const { account, collections } = get()
    const collection = resolveCollection(collections, type, collectionUid)
    if (!account || !collection) {
      logger.warn(`[etebase-store] Cannot update ${type} collection ${collectionUid}: missing account or collection`)
      return false
    }

    try {
      const core = await import('@silentsuite/core')
      const currentMeta = collection?.getMeta?.() ?? {}
      const updatedMeta: CollectionMetaUpdates = {}
      if (updates.name !== undefined) updatedMeta.name = updates.name
      else if (currentMeta.name !== undefined) updatedMeta.name = currentMeta.name
      if (updates.description !== undefined) updatedMeta.description = updates.description
      else if (currentMeta.description !== undefined) updatedMeta.description = currentMeta.description
      if (updates.color !== undefined) updatedMeta.color = updates.color
      else if (currentMeta.color !== undefined) updatedMeta.color = currentMeta.color
      const updatedCollection = await core.updateCollectionMeta(account, collection, updatedMeta)
      const newCollections = {
        ...get().collections,
        [type]: get().collections[type].map((existing) =>
          existing.uid === collection.uid ? updatedCollection : existing,
        ),
      }
      set({ collections: newCollections })
      await hydrateListStores(newCollections)
      return true
    } catch (err) {
      console.error(`[etebase-store] Failed to update ${type} collection ${collectionUid}:`, err)
      showErrorToast(`Failed to update ${type === 'calendar' ? 'calendar' : type === 'tasks' ? 'task list' : 'address book'}. Please try again.`)
      return false
    }
  },

  reconcileCollections: async () => {
    const { account, syncEngine } = get()
    if (!account) {
      logger.warn('[etebase-store] Cannot reconcile collections: no account')
      return
    }

    syncEngine?.pause?.()
    try {
      const core = await import('@silentsuite/core')
      const previousCollections = get().collections
      const activeCollections = await ensureCollectionsForAccount(account, core)
      const newItemCache = new Map(get().itemCache)
      const newItemTypeMap = new Map(get().itemTypeMap)
      const newItemCollectionMap = new Map(get().itemCollectionMap)
      const cleanupPromises: Promise<unknown>[] = []
      let removedCollectionCount = 0

      for (const [type, colType] of COLLECTION_DEFINITIONS) {
        const activeUids = new Set(activeCollections[type].map((collection) => collection.uid))
        const previousUids = new Set(previousCollections[type].map((collection) => collection.uid))
        const removedUids = new Set<string>()

        for (const collection of previousCollections[type]) {
          if (!activeUids.has(collection.uid)) removedUids.add(collection.uid)
        }

        for (const [itemUid, mappedCollectionUid] of newItemCollectionMap.entries()) {
          if (newItemTypeMap.get(itemUid) === type && !activeUids.has(mappedCollectionUid)) {
            removedUids.add(mappedCollectionUid)
          }
        }

        for (const collectionUid of removedUids) {
          removedCollectionCount++
          syncEngine?.untrackCollection(collectionUid)
          for (const [itemUid, mappedCollectionUid] of Array.from(newItemCollectionMap.entries())) {
            if (mappedCollectionUid !== collectionUid) continue
            newItemCache.delete(itemUid)
            newItemTypeMap.delete(itemUid)
            newItemCollectionMap.delete(itemUid)
          }
          cleanupPromises.push(removeQueuedMutationsForCollection(type, collectionUid, true))
          cleanupPromises.push(removeItemsFromDomainStore(type, collectionUid))
          if (isLocalCacheEnabled()) {
            cleanupPromises.push(cacheReplaceItemsForCollection(collectionUid, []))
          }
        }

        for (const collection of activeCollections[type]) {
          if (!previousUids.has(collection.uid)) {
            await trackCollectionWithSyncEngine(syncEngine, colType, type, collection.uid)
          }
        }
      }

      set({
        collections: activeCollections,
        itemCache: newItemCache,
        itemTypeMap: newItemTypeMap,
        itemCollectionMap: newItemCollectionMap,
      })
      await Promise.all(cleanupPromises)
      await hydrateListStores(activeCollections)
      logger.debug(`[etebase-store] Reconciled collections (${removedCollectionCount} removed)`)
    } catch (err) {
      console.error('[etebase-store] Failed to reconcile collections:', err)
      throw err
    } finally {
      syncEngine?.resume?.()
    }
  },

  deleteItemsInCollection: async (type: CollectionTypeKey, collectionUid: string) => {
    const { account, collections, itemCache, itemCollectionMap } = get()
    const collection = resolveCollection(collections, type, collectionUid)
    if (!account || !collection) {
      logger.warn(`[etebase-store] Cannot clear ${type} collection ${collectionUid}: missing account or collection`)
      return 0
    }

    const removeCachedItems = (uids: string[]) => {
      if (uids.length === 0) return
      const uidSet = new Set(uids)
      const newItemCache = new Map(get().itemCache)
      const newItemTypeMap = new Map(get().itemTypeMap)
      const newItemCollectionMap = new Map(get().itemCollectionMap)
      for (const uid of uidSet) {
        newItemCache.delete(uid)
        newItemTypeMap.delete(uid)
        newItemCollectionMap.delete(uid)
        if (isLocalCacheEnabled()) {
          void cacheDeleteItem(uid)
        }
      }
      set({ itemCache: newItemCache, itemTypeMap: newItemTypeMap, itemCollectionMap: newItemCollectionMap })
    }

    const itemEntries = Array.from(itemCollectionMap.entries())
      .filter(([, mappedCollectionUid]) => mappedCollectionUid === collection.uid)
      .map(([uid]) => ({ uid, item: itemCache.get(uid) }))
      .filter((entry): entry is { uid: string; item: any } => Boolean(entry.item))

    if (itemEntries.length === 0) {
      await removeQueuedMutationsForCollection(type, collection.uid, true)
      return await removeItemsFromDomainStore(type, collection.uid)
    }

    const successfulUids: string[] = []

    try {
      const collectionManager = account.getCollectionManager()
      const itemManager = collectionManager.getItemManager(collection)
      const BATCH_SIZE = 20

      for (let i = 0; i < itemEntries.length; i += BATCH_SIZE) {
        const batchEntries = itemEntries.slice(i, i + BATCH_SIZE)
        const batchItems = batchEntries.map(({ item }) => item)
        for (const item of batchItems) item.delete()
        await itemManager.batch(batchItems)
        successfulUids.push(...batchEntries.map(({ uid }) => uid))
      }

      removeCachedItems(successfulUids)
      if (isLocalCacheEnabled()) {
        void cacheReplaceItemsForCollection(collection.uid, [])
      }
      await removeQueuedMutationsForCollection(type, collection.uid, true)
      const removedLocal = await removeItemsFromDomainStore(type, collection.uid)
      return Math.max(successfulUids.length, removedLocal)
    } catch (err) {
      if (isOfflineError(err)) {
        logger.warn(`[etebase-store] Offline — queuing clear for ${type}/${collection.uid}`)
        await removeQueuedMutationsForCollection(type, collection.uid, false)
        const alreadyDeleted = new Set(successfulUids)
        for (const { uid } of itemEntries) {
          if (alreadyDeleted.has(uid)) continue
          try {
            await enqueue({ type: 'delete', collectionType: type, collectionUid: collection.uid, itemUid: uid })
          } catch (queueErr) {
            console.error(`[etebase-store] Failed to enqueue collection item delete:`, queueErr)
          }
        }
        removeCachedItems(itemEntries.map(({ uid }) => uid))
        if (isLocalCacheEnabled()) {
          void cacheReplaceItemsForCollection(collection.uid, [])
        }
        const removedLocal = await removeItemsFromDomainStore(type, collection.uid)
        return Math.max(itemEntries.length, removedLocal)
      }

      console.error(`[etebase-store] Failed to clear ${type} collection ${collectionUid}:`, err)
      if (successfulUids.length > 0) {
        removeCachedItems(successfulUids)
        await removeItemsFromDomainStore(type, collection.uid, successfulUids)
        showErrorToast(`Deleted ${successfulUids.length} of ${itemEntries.length} ${collectionItemNoun(type)}. Please try again to delete the rest.`)
      } else {
        showErrorToast(`Failed to delete ${collectionItemNoun(type)}. Please try again.`)
      }
      return 0
    }
  },

  createItem: async (type: CollectionTypeKey, content: string, tempId?: string, collectionUid?: string) => {
    const { account, collections } = get()
    const collection = resolveCollection(collections, type, collectionUid)
    if (!account || !collection) {
      logger.warn(`[etebase-store] Cannot create item: no account or ${type} collection`)
      return null
    }

    try {
      const core = await import('@silentsuite/core')
      const item = await core.createItem(account, collection, content)
      // Cache the item for future update/delete
      const itemCache = new Map(get().itemCache)
      const itemTypeMap = new Map(get().itemTypeMap)
      const itemCollectionMap = new Map(get().itemCollectionMap)
      itemCache.set(item.uid, item)
      itemTypeMap.set(item.uid, type)
      itemCollectionMap.set(item.uid, collection.uid)
      set({ itemCache, itemTypeMap, itemCollectionMap })
      // Write through to the local persistence cache so a reload paints it.
      void writeItemToCache(type, collection.uid, item.uid, content)
      return item.uid
    } catch (err) {
      if (isOfflineError(err)) {
        const queueTempId = tempId ?? `pending-${Date.now()}`
        logger.warn(`[etebase-store] Offline — queuing create for ${type} (tempId: ${queueTempId})`)
        try {
          await enqueue({ type: 'create', collectionType: type, collectionUid: collection.uid, content, tempId: queueTempId })
        } catch (queueErr) {
          console.error(`[etebase-store] Failed to enqueue create:`, queueErr)
        }
      } else {
        console.error(`[etebase-store] Failed to create ${type} item:`, err)
        showErrorToast(`Failed to save ${type === 'calendar' ? 'event' : type === 'tasks' ? 'task' : 'contact'}. Please try again.`)
      }
      return null
    }
  },

  createItemsBatch: async (type: CollectionTypeKey, contents: { content: string; tempId: string }[], collectionUid?: string) => {
    const { account, collections } = get()
    const collection = resolveCollection(collections, type, collectionUid)
    if (!account || !collection) {
      logger.warn(`[etebase-store] Cannot create items: no account or ${type} collection`)
      return contents.map(() => null)
    }

    // Pause the sync engine for the duration of the import. The local-crypto
    // phase below blocks the main thread; without this, a 30s poll firing
    // mid-import would also decrypt freshly-imported items on the same thread,
    // freezing the UI long enough for the user to refresh and abort the import.
    const { syncEngine } = get()
    syncEngine?.pause()

    try {
      const core = await import('@silentsuite/core')
      const collectionManager = account.getCollectionManager()
      const itemManager = collectionManager.getItemManager(collection)

      // Create all item objects locally. Yield to the event loop every
      // YIELD_EVERY items so the UI stays responsive during 1000+ item imports.
      const YIELD_EVERY = 25
      const items: any[] = []
      for (let i = 0; i < contents.length; i++) {
        const item = await itemManager.create({}, contents[i]!.content)
        items.push(item)
        if (i > 0 && i % YIELD_EVERY === 0) {
          await new Promise((r) => setTimeout(r, 0))
        }
      }

      // Smaller batches finish each request faster, so a single slow batch is
      // less likely to cross a Cloudflare/proxy gateway timeout. Combined with
      // retry-with-backoff, this turns a transient batch failure from
      // "import aborted, ~100 items stuck" into "1-3s pause, then resume".
      const BATCH_SIZE = 20
      const MAX_BATCH_RETRIES = 3
      let lastSuccessfulItemIndex = -1
      let permanentFailure: unknown = null

      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE)
        let attempt = 0
        let succeeded = false

        while (attempt < MAX_BATCH_RETRIES) {
          try {
            await itemManager.batch(batch)
            succeeded = true
            lastSuccessfulItemIndex = i + batch.length - 1
            break
          } catch (err) {
            // Offline errors are handled by the outer catch + offline queue —
            // bubble out instead of retrying on a known-down network.
            if (isOfflineError(err)) throw err
            attempt++
            if (attempt >= MAX_BATCH_RETRIES) {
              permanentFailure = err
              break
            }
            const backoffMs = 1000 * 2 ** (attempt - 1) // 1s, 2s, 4s
            logger.warn(
              `[etebase-store] Batch ${i / BATCH_SIZE + 1} failed (attempt ${attempt}/${MAX_BATCH_RETRIES}), retrying in ${backoffMs}ms:`,
              err,
            )
            await new Promise((r) => setTimeout(r, backoffMs))
          }
        }

        if (!succeeded) break
      }

      // Update cache with whatever made it to the server. Items past
      // lastSuccessfulItemIndex never got an ack, so we can't claim them.
      const itemCache = new Map(get().itemCache)
      const itemTypeMap = new Map(get().itemTypeMap)
      const itemCollectionMap = new Map(get().itemCollectionMap)
      const uids: (string | null)[] = []
      const cachedRecords: CachedItem[] = []
      for (let i = 0; i < items.length; i++) {
        if (i <= lastSuccessfulItemIndex) {
          const item = items[i]
          itemCache.set(item.uid, item)
          itemTypeMap.set(item.uid, type)
          itemCollectionMap.set(item.uid, collection.uid)
          uids.push(item.uid)
          const original = contents[i]
          if (original) {
            cachedRecords.push({
              itemUid: item.uid,
              collectionType: type,
              collectionUid: collection.uid,
              content: original.content,
              lastModified: Date.now(),
            })
          }
        } else {
          uids.push(null)
        }
      }
      set({ itemCache, itemTypeMap, itemCollectionMap })
      if (isLocalCacheEnabled() && cachedRecords.length > 0) {
        void cachePutItems(cachedRecords)
      }

      if (permanentFailure) {
        const succeeded = lastSuccessfulItemIndex + 1
        const total = items.length
        const noun = type === 'calendar' ? 'events' : type === 'tasks' ? 'tasks' : 'contacts'
        console.error(`[etebase-store] Batch import failed after retries (${succeeded}/${total} ${noun} imported):`, permanentFailure)
        if (succeeded > 0) {
          showErrorToast(`Imported ${succeeded} of ${total} ${noun}. Please try again to import the rest.`)
        } else {
          showErrorToast(`Failed to import ${noun}. Please try again.`)
        }
      }

      return uids
    } catch (err) {
      if (isOfflineError(err)) {
        logger.warn(`[etebase-store] Offline — queuing ${contents.length} creates for ${type}`)
        for (const { content, tempId } of contents) {
          try {
            await enqueue({ type: 'create', collectionType: type, collectionUid: collection.uid, content, tempId })
          } catch (queueErr) {
            console.error(`[etebase-store] Failed to enqueue create:`, queueErr)
          }
        }
      } else {
        console.error(`[etebase-store] Failed to batch create ${type} items:`, err)
        showErrorToast(`Failed to import ${type === 'calendar' ? 'events' : type === 'tasks' ? 'tasks' : 'contacts'}. Please try again.`)
      }
      return contents.map(() => null)
    } finally {
      syncEngine?.resume()
    }
  },

  updateItem: async (type: CollectionTypeKey, itemUid: string, content: string) => {
    const { account, collections, itemCache, itemCollectionMap } = get()
    const collection = resolveCollection(collections, type, itemCollectionMap.get(itemUid))
    const item = itemCache.get(itemUid)
    if (!account || !collection || !item) {
      logger.warn(`[etebase-store] Cannot update item ${itemUid}: missing account, collection, or item`)
      return
    }

    try {
      const core = await import('@silentsuite/core')
      const updated = await core.updateItem(account, collection, item, content)
      const newCache = new Map(get().itemCache)
      newCache.set(itemUid, updated)
      set({ itemCache: newCache })
      void writeItemToCache(type, collection.uid, itemUid, content)
    } catch (err) {
      if (isOfflineError(err)) {
        logger.warn(`[etebase-store] Offline — queuing update for ${type}/${itemUid}`)
        try {
          await enqueue({ type: 'update', collectionType: type, collectionUid: collection.uid, content, itemUid })
        } catch (queueErr) {
          console.error(`[etebase-store] Failed to enqueue update:`, queueErr)
        }
      } else {
        console.error(`[etebase-store] Failed to update ${type} item ${itemUid}:`, err)
        showErrorToast(`Failed to save ${type === 'calendar' ? 'event' : type === 'tasks' ? 'task' : 'contact'}. Please try again.`)
      }
    }
  },

  deleteItem: async (type: CollectionTypeKey, itemUid: string) => {
    const { account, collections, itemCache, itemCollectionMap } = get()
    const collection = resolveCollection(collections, type, itemCollectionMap.get(itemUid))
    const item = itemCache.get(itemUid)
    if (!account || !collection || !item) {
      logger.warn(`[etebase-store] Cannot delete item ${itemUid}: missing account, collection, or item`)
      return
    }

    try {
      const core = await import('@silentsuite/core')
      await core.deleteItem(account, collection, item)
      const newCache = new Map(get().itemCache)
      const newTypeMap = new Map(get().itemTypeMap)
      const newCollectionMap = new Map(get().itemCollectionMap)
      newCache.delete(itemUid)
      newTypeMap.delete(itemUid)
      newCollectionMap.delete(itemUid)
      set({ itemCache: newCache, itemTypeMap: newTypeMap, itemCollectionMap: newCollectionMap })
      if (isLocalCacheEnabled()) {
        void cacheDeleteItem(itemUid)
      }
    } catch (err) {
      if (isOfflineError(err)) {
        logger.warn(`[etebase-store] Offline — queuing delete for ${type}/${itemUid}`)
        try {
          await enqueue({ type: 'delete', collectionType: type, collectionUid: collection.uid, itemUid })
        } catch (queueErr) {
          console.error(`[etebase-store] Failed to enqueue delete:`, queueErr)
        }
      } else {
        console.error(`[etebase-store] Failed to delete ${type} item ${itemUid}:`, err)
        showErrorToast(`Failed to delete ${type === 'calendar' ? 'event' : type === 'tasks' ? 'task' : 'contact'}. Please try again.`)
      }
    }
  },

  fetchAllItems: async (type: CollectionTypeKey) => {
    const { itemCache, itemTypeMap, itemCollectionMap } = get()
    const results: CachedContentItem[] = []

    for (const [uid, item] of itemCache.entries()) {
      if (itemTypeMap.get(uid) !== type) continue
      try {
        const content = await item.getContent()
        const contentStr = typeof content === 'string' ? content : new TextDecoder().decode(content)
        const collectionUid = itemCollectionMap.get(uid)
        if (collectionUid) results.push({ uid, content: contentStr, collectionUid })
      } catch {
        // Skip items that fail to decode
      }
    }

    return results
  },

  refreshCollection: async (type: CollectionTypeKey, collectionUid?: string) => {
    const { account, collections } = get()
    const targetCollections = collectionUid
      ? [resolveCollection(collections, type, collectionUid)].filter(Boolean)
      : collections[type]
    if (!account || targetCollections.length === 0) return []

    try {
      const colManager = account.getCollectionManager()
      const refreshed: { collection: any; items: { item: any; content: string }[] }[] = []
      const allResults: CachedContentItem[] = []

      for (const collection of targetCollections) {
        // Fetch fresh collection reference from server
        const freshCollection = await colManager.fetch(collection.uid)

        // Fetch ALL items (no stoken = full fetch)
        const itemManager = colManager.getItemManager(freshCollection)
        const collectionItems: { item: any; content: string }[] = []

        // Paginate through all items
        let stoken: string | undefined = undefined
        let done = false
        while (!done) {
          const response: { data: any[]; stoken: string | null; done: boolean } = await itemManager.list({ stoken })
          for (const item of response.data) {
            if (!item.isDeleted) {
              try {
                const content = await item.getContent()
                const contentStr = typeof content === 'string' ? content : new TextDecoder().decode(content)
                collectionItems.push({ item, content: contentStr })
                allResults.push({ uid: item.uid, content: contentStr, collectionUid: freshCollection.uid })
              } catch {
                // Skip items that fail to decode
              }
            }
          }
          stoken = response.stoken || undefined
          done = response.done
        }

        refreshed.push({ collection: freshCollection, items: collectionItems })
      }

      const refreshedUids = new Set(refreshed.map((entry) => entry.collection.uid))
      const newItemCache = new Map(get().itemCache)
      const newItemTypeMap = new Map(get().itemTypeMap)
      const newItemCollectionMap = new Map(get().itemCollectionMap)

      // Remove old items for the refreshed concrete collections only.
      for (const [uid, mappedCollectionUid] of newItemCollectionMap.entries()) {
        if (refreshedUids.has(mappedCollectionUid)) {
          newItemCache.delete(uid)
          newItemTypeMap.delete(uid)
          newItemCollectionMap.delete(uid)
        }
      }

      for (const { collection, items } of refreshed) {
        for (const { item } of items) {
          newItemCache.set(item.uid, item)
          newItemTypeMap.set(item.uid, type)
          newItemCollectionMap.set(item.uid, collection.uid)
        }
      }

      // Update collection references too (in case metadata changed).
      const refreshedByUid = new Map(refreshed.map((entry) => [entry.collection.uid, entry.collection]))
      const newCollections = { ...get().collections }
      newCollections[type] = newCollections[type].map((collection) =>
        refreshedByUid.get(collection.uid) ?? collection,
      )
      set({ itemCache: newItemCache, itemTypeMap: newItemTypeMap, itemCollectionMap: newItemCollectionMap, collections: newCollections })

      // Mirror the refresh into the local cache. Use replace-style writes so
      // items deleted upstream are also dropped from disk.
      for (const { collection, items } of refreshed) {
        if (isLocalCacheEnabled()) {
          const cached: CachedItem[] = items.map(({ item, content }) => ({
            itemUid: item.uid,
            collectionType: type,
            collectionUid: collection.uid,
            content,
            lastModified: Date.now(),
          }))
          void cacheReplaceItemsForCollection(collection.uid, cached)
        }
      }

      logger.debug(`[etebase-store] Refreshed ${type}: ${allResults.length} items`)
      return allResults
    } catch (err) {
      console.error(`[etebase-store] Failed to refresh ${type}:`, err)
      return get().fetchAllItems(type)
    }
  },

  destroy: () => {
    const { syncEngine } = get()
    if (syncEngine) {
      syncEngine.stop()
    }
    set({
      account: null,
      collections: { calendar: [], tasks: [], contacts: [] },
      itemCache: new Map(),
      itemTypeMap: new Map(),
      itemCollectionMap: new Map(),
      isInitialized: false,
      syncEngine: null,
    })
    logger.debug('[etebase-store] Destroyed')
  },

  onSyncChange: (handler) => {
    const { syncEngine } = get()
    if (!syncEngine) return null
    return syncEngine.onChange(handler)
  },

  onStatusChange: (handler) => {
    const { syncEngine } = get()
    if (!syncEngine) return null
    return syncEngine.onStatusChange(handler)
  },
}))
