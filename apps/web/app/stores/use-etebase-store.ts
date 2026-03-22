'use client'

import { create } from 'zustand'
import type {
  CollectionType,
  SyncChangeEvent,
} from '@silentsuite/core'
import { enqueue, isOfflineError } from '@/app/lib/offline-queue'
import { showErrorToast } from '@/app/stores/use-toast-store'

/**
 * Holds live Etebase SDK objects (Account, Collections, Items, SyncEngine).
 * These are non-serializable and must NOT go through Zustand persist.
 * This store is the bridge between the Etebase SDK and the UI data stores.
 */

// We dynamically import Etebase types to avoid SSR issues with the etebase WASM module.
// The actual Etebase SDK objects are stored as `any` in the store and typed at usage sites.

const DEFAULT_ETEBASE_SERVER_URL =
  process.env.NEXT_PUBLIC_ETEBASE_SERVER_URL ?? 'http://localhost:3735'

function isValidServerUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** Read the user's custom server URL from localStorage, falling back to the env default. */
function getServerUrl(): string {
  if (typeof window !== 'undefined') {
    const custom = localStorage.getItem('silentsuite-server-url')
    if (custom && custom.trim() && isValidServerUrl(custom.trim())) return custom.trim()
  }
  return DEFAULT_ETEBASE_SERVER_URL
}

const COLLECTION_TYPE_CALENDAR = 'etebase.vevent'
const COLLECTION_TYPE_TASKS = 'etebase.vtodo'
const COLLECTION_TYPE_CONTACTS = 'etebase.vcard'

type CollectionTypeKey = 'calendar' | 'tasks' | 'contacts'

function collectionTypeToKey(ct: string): CollectionTypeKey | null {
  if (ct === COLLECTION_TYPE_CALENDAR) return 'calendar'
  if (ct === COLLECTION_TYPE_TASKS) return 'tasks'
  if (ct === COLLECTION_TYPE_CONTACTS) return 'contacts'
  return null
}

interface EtebaseState {
  // The live Account object (null until session restored)
  account: any | null
  // Collection references keyed by type
  collections: Record<CollectionTypeKey, any | null>
  // Item cache: itemUid -> Etebase.Item (needed for update/delete which require the Item object)
  itemCache: Map<string, any>
  // Tracks which collection type each item belongs to
  itemTypeMap: Map<string, CollectionTypeKey>
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
  createItem: (type: CollectionTypeKey, content: string, tempId?: string) => Promise<string | null>

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
  fetchAllItems: (type: CollectionTypeKey) => Promise<{ uid: string; content: string }[]>

  /**
   * Re-fetch all items from the Etebase server for a collection type.
   * Updates the local cache and returns fresh content.
   * This is what the sync change handler should call.
   */
  refreshCollection: (type: CollectionTypeKey) => Promise<{ uid: string; content: string }[]>

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
  collections: { calendar: null, tasks: null, contacts: null },
  itemCache: new Map(),
  itemTypeMap: new Map(),
  isInitialized: false,
  syncEngine: null,

  initialize: async () => {
    const savedSession = localStorage.getItem('etebase_session')
    if (!savedSession) {
      console.debug('[etebase-store] No saved session, skipping initialization')
      return
    }

    try {
      // Dynamic import to avoid SSR issues with etebase WASM
      const core = await import('@silentsuite/core')

      // 1. Restore the Account
      console.debug('[etebase-store] Restoring Etebase session...')
      const serverUrl = getServerUrl()
      const account = await core.restoreSession(serverUrl, savedSession)
      set({ account })
      console.debug('[etebase-store] Session restored')

      // 2. Ensure collections exist (create if first login, fetch if returning)
      const collections: Record<CollectionTypeKey, any> = {
        calendar: null,
        tasks: null,
        contacts: null,
      }

      const typeMap: [CollectionTypeKey, string, string][] = [
        ['calendar', COLLECTION_TYPE_CALENDAR, 'Personal Calendar'],
        ['tasks', COLLECTION_TYPE_TASKS, 'Personal Tasks'],
        ['contacts', COLLECTION_TYPE_CONTACTS, 'Personal Contacts'],
      ]

      for (const [key, colType, defaultName] of typeMap) {
        const existing = await core.listCollections(account, colType)
        if (existing.length > 0) {
          collections[key] = existing[0]
          console.debug(`[etebase-store] Found existing ${key} collection: ${existing[0].uid}`)
        } else {
          collections[key] = await core.createCollection(account, colType, { name: defaultName })
          console.debug(`[etebase-store] Created ${key} collection: ${collections[key].uid}`)
        }
      }

      set({ collections })

      // 3. Load all items from each collection into the cache
      const itemCache = new Map<string, any>()
      const itemTypeMap = new Map<string, CollectionTypeKey>()

      for (const [key] of typeMap) {
        const collection = collections[key]
        if (!collection) continue

        let stoken: string | null = null
        let done = false

        while (!done) {
          const response = await core.listItems(account, collection, stoken)
          for (const item of response.items) {
            if (!item.isDeleted) {
              itemCache.set(item.uid, item)
              itemTypeMap.set(item.uid, key)
            }
          }
          stoken = response.stoken
          done = response.done
        }
      }

      set({ itemCache, itemTypeMap })
      console.debug(`[etebase-store] Loaded ${itemCache.size} items into cache`)

      // 4. Start SyncEngine
      const engine = new core.SyncEngine({
        serverUrl: serverUrl,
        pollIntervalMs: 30_000,
      })

      // Track all collections
      for (const [key, colType] of typeMap) {
        const collection = collections[key]
        if (collection) {
          engine.trackCollection(colType as CollectionType, collection.uid)
        }
      }

      await engine.start(account)
      set({ syncEngine: engine, isInitialized: true })
      console.debug('[etebase-store] SyncEngine started')
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

  createItem: async (type: CollectionTypeKey, content: string, tempId?: string) => {
    const { account, collections } = get()
    const collection = collections[type]
    if (!account || !collection) {
      console.warn(`[etebase-store] Cannot create item: no account or ${type} collection`)
      return null
    }

    try {
      const core = await import('@silentsuite/core')
      const item = await core.createItem(account, collection, content)
      // Cache the item for future update/delete
      const itemCache = new Map(get().itemCache)
      const itemTypeMap = new Map(get().itemTypeMap)
      itemCache.set(item.uid, item)
      itemTypeMap.set(item.uid, type)
      set({ itemCache, itemTypeMap })
      return item.uid
    } catch (err) {
      if (isOfflineError(err)) {
        const queueTempId = tempId ?? `pending-${Date.now()}`
        console.warn(`[etebase-store] Offline — queuing create for ${type} (tempId: ${queueTempId})`)
        try {
          await enqueue({ type: 'create', collectionType: type, content, tempId: queueTempId })
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

  updateItem: async (type: CollectionTypeKey, itemUid: string, content: string) => {
    const { account, collections, itemCache } = get()
    const collection = collections[type]
    const item = itemCache.get(itemUid)
    if (!account || !collection || !item) {
      console.warn(`[etebase-store] Cannot update item ${itemUid}: missing account, collection, or item`)
      return
    }

    try {
      const core = await import('@silentsuite/core')
      const updated = await core.updateItem(account, collection, item, content)
      const newCache = new Map(get().itemCache)
      newCache.set(itemUid, updated)
      set({ itemCache: newCache })
    } catch (err) {
      if (isOfflineError(err)) {
        console.warn(`[etebase-store] Offline — queuing update for ${type}/${itemUid}`)
        try {
          await enqueue({ type: 'update', collectionType: type, content, itemUid })
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
    const { account, collections, itemCache } = get()
    const collection = collections[type]
    const item = itemCache.get(itemUid)
    if (!account || !collection || !item) {
      console.warn(`[etebase-store] Cannot delete item ${itemUid}: missing account, collection, or item`)
      return
    }

    try {
      const core = await import('@silentsuite/core')
      await core.deleteItem(account, collection, item)
      const newCache = new Map(get().itemCache)
      const newTypeMap = new Map(get().itemTypeMap)
      newCache.delete(itemUid)
      newTypeMap.delete(itemUid)
      set({ itemCache: newCache, itemTypeMap: newTypeMap })
    } catch (err) {
      if (isOfflineError(err)) {
        console.warn(`[etebase-store] Offline — queuing delete for ${type}/${itemUid}`)
        try {
          await enqueue({ type: 'delete', collectionType: type, itemUid })
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
    const { itemCache, itemTypeMap } = get()
    const results: { uid: string; content: string }[] = []

    for (const [uid, item] of itemCache.entries()) {
      if (itemTypeMap.get(uid) !== type) continue
      try {
        const content = await item.getContent()
        const contentStr = typeof content === 'string' ? content : new TextDecoder().decode(content)
        results.push({ uid, content: contentStr })
      } catch {
        // Skip items that fail to decode
      }
    }

    return results
  },

  refreshCollection: async (type: CollectionTypeKey) => {
    const { account, collections } = get()
    const collection = collections[type]
    if (!account || !collection) return []

    try {
      const core = await import('@silentsuite/core')

      // Fetch fresh collection reference from server
      const colManager = account.getCollectionManager()
      const freshCollection = await colManager.fetch(collection.uid)

      // Fetch ALL items (no stoken = full fetch)
      const itemManager = colManager.getItemManager(freshCollection)
      const newItemCache = new Map(get().itemCache)
      const newItemTypeMap = new Map(get().itemTypeMap)
      const results: { uid: string; content: string }[] = []

      // Remove old items of this type from cache
      const uidsToRemove: string[] = []
      for (const [uid, itemType] of newItemTypeMap.entries()) {
        if (itemType === type) uidsToRemove.push(uid)
      }
      for (const uid of uidsToRemove) {
        newItemCache.delete(uid)
        newItemTypeMap.delete(uid)
      }

      // Paginate through all items
      let stoken: string | undefined = undefined
      let done = false
      while (!done) {
        const response: { data: any[]; stoken: string | null; done: boolean } = await itemManager.list({ stoken })
        for (const item of response.data) {
          if (!item.isDeleted) {
            newItemCache.set(item.uid, item)
            newItemTypeMap.set(item.uid, type)
            try {
              const content = await item.getContent()
              const contentStr = typeof content === 'string' ? content : new TextDecoder().decode(content)
              results.push({ uid: item.uid, content: contentStr })
            } catch {
              // Skip items that fail to decode
            }
          }
        }
        stoken = response.stoken || undefined
        done = response.done
      }

      // Update collection reference too (in case it changed)
      const newCollections = { ...get().collections }
      newCollections[type] = freshCollection
      set({ itemCache: newItemCache, itemTypeMap: newItemTypeMap, collections: newCollections })

      console.debug(`[etebase-store] Refreshed ${type}: ${results.length} items`)
      return results
    } catch (err) {
      console.error(`[etebase-store] Failed to refresh ${type}:`, err)
      return []
    }
  },

  destroy: () => {
    const { syncEngine } = get()
    if (syncEngine) {
      syncEngine.stop()
    }
    set({
      account: null,
      collections: { calendar: null, tasks: null, contacts: null },
      itemCache: new Map(),
      itemTypeMap: new Map(),
      isInitialized: false,
      syncEngine: null,
    })
    console.debug('[etebase-store] Destroyed')
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
