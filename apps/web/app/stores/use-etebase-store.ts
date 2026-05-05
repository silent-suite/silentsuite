'use client'

import { create } from 'zustand'
import { ETEBASE_SERVER_URL } from '@/app/lib/config'
import type {
  CollectionType,
  SyncChangeEvent,
} from '@silentsuite/core'
import { enqueue, isOfflineError } from '@/app/lib/offline-queue'
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
  replaceItemsForType as cacheReplaceItemsForType,
  isCacheEnabled as isLocalCacheEnabled,
  type CachedItem,
  type CollectionTypeKey as CacheCollectionTypeKey,
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

function collectionTypeToKey(ct: string): CollectionTypeKey | null {
  if (ct === COLLECTION_TYPE_CALENDAR) return 'calendar'
  if (ct === COLLECTION_TYPE_TASKS) return 'tasks'
  if (ct === COLLECTION_TYPE_CONTACTS) return 'contacts'
  return null
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
   * Create multiple items in a single batch upload.
   * Returns an array of item UIDs (null for any that failed).
   */
  createItemsBatch: (type: CollectionTypeKey, contents: { content: string; tempId: string }[]) => Promise<(string | null)[]>

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
          logger.debug(`[etebase-store] Found existing ${key} collection: ${existing[0].uid}`)
        } else {
          collections[key] = await core.createCollection(account, colType, { name: defaultName })
          logger.debug(`[etebase-store] Created ${key} collection: ${collections[key].uid}`)
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
      logger.debug(`[etebase-store] Loaded ${itemCache.size} items into cache`)

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

      // Seed persisted stokens before starting so the first sync round
      // pulls only deltas instead of refetching the whole vault. Wire the
      // advance handler so subsequent stoken updates are persisted too.
      if (cacheEnabled) {
        for (const [key, colType] of typeMap) {
          const collection = collections[key]
          if (!collection) continue
          try {
            const stoken = await cacheGetStoken(key as CacheCollectionTypeKey)
            if (stoken) {
              engine.setStoken(collection.uid, stoken)
              logger.debug(`[etebase-store] Seeded ${key} stoken from cache`)
            }
          } catch (err) {
            logger.warn(`[etebase-store] Failed to seed ${key} stoken`, err)
          }
        }

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

  createItem: async (type: CollectionTypeKey, content: string, tempId?: string) => {
    const { account, collections } = get()
    const collection = collections[type]
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
      itemCache.set(item.uid, item)
      itemTypeMap.set(item.uid, type)
      set({ itemCache, itemTypeMap })
      // Write through to the local persistence cache so a reload paints it.
      void writeItemToCache(type, collection.uid, item.uid, content)
      return item.uid
    } catch (err) {
      if (isOfflineError(err)) {
        const queueTempId = tempId ?? `pending-${Date.now()}`
        logger.warn(`[etebase-store] Offline — queuing create for ${type} (tempId: ${queueTempId})`)
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

  createItemsBatch: async (type: CollectionTypeKey, contents: { content: string; tempId: string }[]) => {
    const { account, collections } = get()
    const collection = collections[type]
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
      const uids: (string | null)[] = []
      const cachedRecords: CachedItem[] = []
      for (let i = 0; i < items.length; i++) {
        if (i <= lastSuccessfulItemIndex) {
          const item = items[i]
          itemCache.set(item.uid, item)
          itemTypeMap.set(item.uid, type)
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
      set({ itemCache, itemTypeMap })
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
            await enqueue({ type: 'create', collectionType: type, content, tempId })
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
    const { account, collections, itemCache } = get()
    const collection = collections[type]
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
      logger.warn(`[etebase-store] Cannot delete item ${itemUid}: missing account, collection, or item`)
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
      if (isLocalCacheEnabled()) {
        void cacheDeleteItem(itemUid)
      }
    } catch (err) {
      if (isOfflineError(err)) {
        logger.warn(`[etebase-store] Offline — queuing delete for ${type}/${itemUid}`)
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

      // Mirror the refresh into the local cache. Use replace-style write so
      // items deleted upstream are also dropped from disk.
      if (isLocalCacheEnabled()) {
        const cached: CachedItem[] = results.map((r) => ({
          itemUid: r.uid,
          collectionType: type,
          collectionUid: freshCollection.uid,
          content: r.content,
          lastModified: Date.now(),
        }))
        void cacheReplaceItemsForType(type, cached)
      }

      logger.debug(`[etebase-store] Refreshed ${type}: ${results.length} items`)
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
