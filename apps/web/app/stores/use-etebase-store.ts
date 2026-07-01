'use client'

import { create } from 'zustand'
import { ETEBASE_SERVER_URL } from '@/app/lib/config'
import type {
  CollectionAccessLevel,
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
import { getSafeErrorDetails } from '@/app/lib/privacy-safe-errors'

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
const COLLECTION_TYPE_PREFERENCES = 'silentsuite.preferences'
const COLLECTION_TYPE_LABEL_INDEX = 'silentsuite.labelindex'

type CollectionTypeKey = 'calendar' | 'tasks' | 'contacts' | 'preferences' | 'labelIndex'
type CollectionMetaUpdates = { name?: string; description?: string; color?: string }
type EtebaseCore = typeof import('@silentsuite/core')

export type CachedContentItem = { uid: string; content: string; collectionUid: string }
export type IncrementalCollectionProgress = { loaded: number; done: boolean; collectionUid: string }
export type IncrementalCollectionResult = {
  attemptedCount: number
  decodedCount: number
  decodeFailureCount: number
  enumerationErrorCount: number
  items: CachedContentItem[]
  trustworthyForReplacement: boolean
  errorCategory?: string
}
export type IncrementalLoadResult = {
  type: CollectionTypeKey
  attemptedCount: number
  decodedCount: number
  decodeFailureCount: number
  enumerationErrorCount: number
  items: CachedContentItem[]
  collections: IncrementalCollectionResult[]
  trustworthyForFullReplacement: boolean
}

export type EtebaseInitializeOutcome =
  | { status: 'no-session' }
  | { status: 'success'; itemCount: number }
  | { status: 'offline'; error: unknown }
  | { status: 'error'; error: unknown }

const COLLECTION_DEFINITIONS: [CollectionTypeKey, string, string][] = [
  ['calendar', COLLECTION_TYPE_CALENDAR, 'Personal Calendar'],
  ['tasks', COLLECTION_TYPE_TASKS, 'Personal Tasks'],
  ['contacts', COLLECTION_TYPE_CONTACTS, 'Personal Contacts'],
  ['preferences', COLLECTION_TYPE_PREFERENCES, 'Preferences'],
  ['labelIndex', COLLECTION_TYPE_LABEL_INDEX, 'Label Suggestions'],
]

function collectionTypeToKey(ct: string): CollectionTypeKey | null {
  if (ct === COLLECTION_TYPE_CALENDAR) return 'calendar'
  if (ct === COLLECTION_TYPE_TASKS) return 'tasks'
  if (ct === COLLECTION_TYPE_CONTACTS) return 'contacts'
  if (ct === COLLECTION_TYPE_PREFERENCES) return 'preferences'
  if (ct === COLLECTION_TYPE_LABEL_INDEX) return 'labelIndex'
  return null
}

function keyToCollectionType(type: CollectionTypeKey): string {
  if (type === 'calendar') return COLLECTION_TYPE_CALENDAR
  if (type === 'tasks') return COLLECTION_TYPE_TASKS
  if (type === 'contacts') return COLLECTION_TYPE_CONTACTS
  if (type === 'labelIndex') return COLLECTION_TYPE_LABEL_INDEX
  return COLLECTION_TYPE_PREFERENCES
}

async function ensureCollectionsForAccount(
  account: any,
  core: EtebaseCore,
): Promise<Record<CollectionTypeKey, any[]>> {
  const collections: Record<CollectionTypeKey, any[]> = {
    calendar: [],
    tasks: [],
    contacts: [],
    preferences: [],
    labelIndex: [],
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
  if (type === 'preferences' || type === 'labelIndex') return 0

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
  if (type === 'preferences') return 'preferences'
  if (type === 'labelIndex') return 'label suggestions'
  return 'contacts'
}

function collectionDisplayName(type: CollectionTypeKey): string {
  if (type === 'calendar') return 'calendar'
  if (type === 'tasks') return 'task list'
  if (type === 'contacts') return 'address book'
  if (type === 'labelIndex') return 'label suggestions'
  return 'preferences'
}

function saveItemNoun(type: CollectionTypeKey): string {
  if (type === 'calendar') return 'event'
  if (type === 'tasks') return 'task'
  if (type === 'contacts') return 'contact'
  if (type === 'labelIndex') return 'label suggestions'
  return 'preferences'
}

function toastSourceForType(type: CollectionTypeKey): 'preferences' | 'labelIndex' | undefined {
  if (type === 'preferences') return 'preferences'
  if (type === 'labelIndex') return 'labelIndex'
  return undefined
}

function showSaveFailureToast(type: CollectionTypeKey): void {
  const source = toastSourceForType(type)
  const message = `Failed to save ${saveItemNoun(type)}. Please try again.`
  if (source) showErrorToast(message, { source, suppressDuringPassiveStartup: true })
  else showErrorToast(message)
}

async function recordLabelsFromContent(type: CollectionTypeKey, content: string): Promise<void> {
  if (type !== 'calendar' && type !== 'tasks' && type !== 'contacts') return
  try {
    const core = await import('@silentsuite/core')
    const labels = type === 'calendar'
      ? core.deserializeCalendarEvent(content).categories
      : type === 'tasks'
        ? core.deserializeTask(content).categories
        : core.deserializeContact(content).categories
    if (!labels || labels.length === 0) return
    const { useLabelSuggestionsStore } = await import('@/app/stores/use-label-suggestions-store')
    await useLabelSuggestionsStore.getState().recordLabelsUsed(labels)
  } catch (err) {
    logger.warn(`[etebase-store] Failed to record ${type} label suggestions`, err)
  }
}

interface EtebaseState {
  // The live Account object (null until session restored)
  account: any | null
  // Stable account public-key fingerprint for cross-device verification.
  accountFingerprint: string | null
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
  initialize: () => Promise<EtebaseInitializeOutcome>

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
   * List pending incoming sharing invitations for the current account.
   */
  listIncomingInvitations: () => Promise<any[]>

  /**
   * List pending outgoing sharing invitations for the current account.
   */
  listOutgoingInvitations: () => Promise<any[]>

  /**
   * Cancel an outgoing sharing invitation before it is accepted.
   */
  cancelOutgoingInvitation: (invitation: any) => Promise<boolean>

  /**
   * Accept an incoming sharing invitation, then reconcile collections so the shared collection appears.
   */
  acceptInvitation: (invitation: any) => Promise<boolean>

  /**
   * Reject an incoming sharing invitation.
   */
  rejectInvitation: (invitation: any) => Promise<boolean>

  /**
   * Invite another user to an existing collection.
   */
  inviteToCollection: (type: CollectionTypeKey, collectionUid: string, username: string, accessLevel: CollectionAccessLevel) => Promise<boolean>

  /**
   * List members for a collection.
   */
  listCollectionMembers: (type: CollectionTypeKey, collectionUid: string) => Promise<any[]>

  /**
   * Remove a member from a collection.
   */
  removeCollectionMember: (type: CollectionTypeKey, collectionUid: string, username: string) => Promise<boolean>

  /**
   * Leave a shared collection as the current account.
   */
  leaveCollection: (type: CollectionTypeKey, collectionUid: string) => Promise<boolean>

  /**
   * Change a member's access level.
   */
  modifyCollectionMemberAccess: (type: CollectionTypeKey, collectionUid: string, username: string, accessLevel: CollectionAccessLevel) => Promise<boolean>

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
   * Move an existing item to another concrete collection by recreating it there.
   * Returns the new item UID, or the original UID if the target is unchanged.
   */
  moveItem: (type: CollectionTypeKey, itemUid: string, content: string, targetCollectionUid: string, sourceCollectionUid?: string) => Promise<string | null>

  /**
   * Delete an item by UID.
   */
  deleteItem: (type: CollectionTypeKey, itemUid: string) => Promise<void>

  /**
   * Fetch all items from the local cache for a collection type.
   */
  fetchAllItems: (type: CollectionTypeKey) => Promise<CachedContentItem[]>

  /**
   * Page through a collection type and update the local item cache as pages arrive.
   */
  loadCollectionItemsIncrementally: (
    type: CollectionTypeKey,
    options?: { onItems?: (items: CachedContentItem[], progress: IncrementalCollectionProgress) => Promise<void> | void },
  ) => Promise<IncrementalLoadResult>

  /** Start the SyncEngine after initial page-at-a-time enumeration is complete. */
  startSyncEngine: () => Promise<void>

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
  accountFingerprint: null,
  collections: { calendar: [], tasks: [], contacts: [], preferences: [], labelIndex: [] },
  itemCache: new Map(),
  itemTypeMap: new Map(),
  itemCollectionMap: new Map(),
  isInitialized: false,
  syncEngine: null,

  initialize: async () => {
    const savedSession = await secureGet('etebase_session')
    if (!savedSession) {
      logger.debug('[etebase-store] No saved session, skipping initialization')
      set({ isInitialized: false })
      return { status: 'no-session' }
    }

    try {
      // Dynamic import to avoid SSR issues with etebase WASM
      const core = await import('@silentsuite/core')

      // 1. Restore the Account
      logger.debug('[etebase-store] Restoring Etebase session...')
      const serverUrl = getServerUrl()
      const account = await core.restoreSession(serverUrl, savedSession)
      const accountFingerprint = core.getAccountFingerprint(account)
      set({ account, accountFingerprint })
      logger.debug('[etebase-store] Session restored')

      // Local-cache fingerprint check: if a different account previously
      // hydrated this browser, wipe before reseeding. Belt-and-braces against
      // the Android-style stale-cache contamination bug.
      const cacheEnabled = isLocalCacheEnabled()
      if (cacheEnabled) {
        try {
          await cacheEnsureFingerprint(accountFingerprint)
        } catch (err) {
          logger.warn('[etebase-store] Cache fingerprint check failed', err)
        }
      }

      // 2. Ensure collections exist (create if first login, fetch if returning)
      const collections = await ensureCollectionsForAccount(account, core)

      set({ collections })
      await hydrateListStores(collections)

      // 3. Prepare SyncEngine, but do not start polling yet. Initial item
      // enumeration happens page-at-a-time in SyncProvider so visible calendar
      // data can render before tasks/contacts/non-visible collections finish.
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

      set({ syncEngine: engine, isInitialized: true })
      logger.debug('[etebase-store] SyncEngine prepared')
      return { status: 'success', itemCount: 0 }
    } catch (err) {
      console.error('[etebase-store] Initialization failed', getSafeErrorDetails(err))
      // Don't clear the session -- the user might be offline
      // They can retry on next page load
      set({ isInitialized: false })
      if (!isOfflineError(err)) {
        showErrorToast('Failed to restore session. Please try signing in again.')
      }
      return isOfflineError(err) ? { status: 'offline', error: err } : { status: 'error', error: err }
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
      console.error(`[etebase-store] Failed to create ${type} collection`, getSafeErrorDetails(err))
      showErrorToast(`Failed to create ${collectionDisplayName(type)}. Please try again.`)
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
      showErrorToast(`Create another ${collectionDisplayName(type)} before deleting this one.`)
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
      console.error(`[etebase-store] Failed to delete ${type} collection`, getSafeErrorDetails(err))
      showErrorToast(`Failed to delete ${collectionDisplayName(type)}. Please try again.`)
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
      console.error(`[etebase-store] Failed to update ${type} collection`, getSafeErrorDetails(err))
      showErrorToast(`Failed to update ${collectionDisplayName(type)}. Please try again.`)
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
      console.error('[etebase-store] Failed to reconcile collections', getSafeErrorDetails(err))
      throw err
    } finally {
      syncEngine?.resume?.()
    }
  },

  listIncomingInvitations: async () => {
    const { account } = get()
    if (!account) return []

    try {
      const core = await import('@silentsuite/core')
      return await core.listIncomingInvitations(account)
    } catch (err) {
      console.error('[etebase-store] Failed to list incoming invitations', getSafeErrorDetails(err))
      showErrorToast('Failed to load sharing invitations. Please try again.')
      return []
    }
  },

  listOutgoingInvitations: async () => {
    const { account } = get()
    if (!account) return []

    try {
      const core = await import('@silentsuite/core')
      return await core.listOutgoingInvitations(account)
    } catch (err) {
      console.error('[etebase-store] Failed to list outgoing invitations', getSafeErrorDetails(err))
      showErrorToast('Failed to load sent sharing invitations. Please try again.')
      return []
    }
  },

  cancelOutgoingInvitation: async (invitation: any) => {
    const { account } = get()
    if (!account) {
      logger.warn('[etebase-store] Cannot cancel outgoing invitation: no account')
      return false
    }

    try {
      const core = await import('@silentsuite/core')
      await core.cancelOutgoingInvitation(account, invitation)
      return true
    } catch (err) {
      console.error('[etebase-store] Failed to cancel outgoing invitation', getSafeErrorDetails(err))
      showErrorToast('Failed to cancel sharing invitation. Please try again.')
      return false
    }
  },

  acceptInvitation: async (invitation: any) => {
    const { account } = get()
    if (!account) {
      logger.warn('[etebase-store] Cannot accept invitation: no account')
      return false
    }

    try {
      const core = await import('@silentsuite/core')
      await core.acceptInvitation(account, invitation)
      await get().reconcileCollections()
      return true
    } catch (err) {
      console.error('[etebase-store] Failed to accept invitation', getSafeErrorDetails(err))
      showErrorToast('Failed to accept sharing invitation. Please try again.')
      return false
    }
  },

  rejectInvitation: async (invitation: any) => {
    const { account } = get()
    if (!account) {
      logger.warn('[etebase-store] Cannot reject invitation: no account')
      return false
    }

    try {
      const core = await import('@silentsuite/core')
      await core.rejectInvitation(account, invitation)
      return true
    } catch (err) {
      console.error('[etebase-store] Failed to reject invitation', getSafeErrorDetails(err))
      showErrorToast('Failed to reject sharing invitation. Please try again.')
      return false
    }
  },

  inviteToCollection: async (type: CollectionTypeKey, collectionUid: string, username: string, accessLevel: CollectionAccessLevel) => {
    const { account, collections } = get()
    const collection = resolveCollection(collections, type, collectionUid)
    if (!account || !collection) {
      logger.warn(`[etebase-store] Cannot invite to ${type} collection ${collectionUid}: missing account or collection`)
      return false
    }

    try {
      const core = await import('@silentsuite/core')
      await core.inviteToCollection(account, collection, username, accessLevel)
      return true
    } catch (err) {
      console.error('[etebase-store] Failed to create sharing invitation', getSafeErrorDetails(err))
      showErrorToast('Failed to create sharing invitation. Please verify the username and try again.')
      return false
    }
  },

  listCollectionMembers: async (type: CollectionTypeKey, collectionUid: string) => {
    const { account, collections } = get()
    const collection = resolveCollection(collections, type, collectionUid)
    if (!account || !collection) return []

    try {
      const core = await import('@silentsuite/core')
      return await core.listCollectionMembers(account, collection)
    } catch (err) {
      console.error('[etebase-store] Failed to list collection members', getSafeErrorDetails(err))
      showErrorToast('Failed to load collection members. Please try again.')
      return []
    }
  },

  removeCollectionMember: async (type: CollectionTypeKey, collectionUid: string, username: string) => {
    const { account, collections } = get()
    const collection = resolveCollection(collections, type, collectionUid)
    if (!account || !collection) {
      logger.warn(`[etebase-store] Cannot remove member from ${type} collection ${collectionUid}: missing account or collection`)
      return false
    }

    try {
      const core = await import('@silentsuite/core')
      await core.removeCollectionMember(account, collection, username)
      return true
    } catch (err) {
      console.error('[etebase-store] Failed to remove collection member', getSafeErrorDetails(err))
      showErrorToast('Failed to remove collection member. Please try again.')
      return false
    }
  },

  leaveCollection: async (type: CollectionTypeKey, collectionUid: string) => {
    const { account, collections } = get()
    const collection = resolveCollection(collections, type, collectionUid)
    if (!account || !collection) {
      logger.warn(`[etebase-store] Cannot leave ${type} collection ${collectionUid}: missing account or collection`)
      return false
    }

    try {
      const core = await import('@silentsuite/core')
      await core.leaveCollection(account, collection)
      await get().reconcileCollections()
      return true
    } catch (err) {
      console.error('[etebase-store] Failed to leave collection', getSafeErrorDetails(err))
      showErrorToast('Failed to leave shared collection. Please try again.')
      return false
    }
  },

  modifyCollectionMemberAccess: async (type: CollectionTypeKey, collectionUid: string, username: string, accessLevel: CollectionAccessLevel) => {
    const { account, collections } = get()
    const collection = resolveCollection(collections, type, collectionUid)
    if (!account || !collection) {
      logger.warn(`[etebase-store] Cannot modify member access for ${type} collection ${collectionUid}: missing account or collection`)
      return false
    }

    try {
      const core = await import('@silentsuite/core')
      await core.modifyCollectionMemberAccess(account, collection, username, accessLevel)
      return true
    } catch (err) {
      console.error('[etebase-store] Failed to change collection member access', getSafeErrorDetails(err))
      showErrorToast('Failed to update collection member access. Please try again.')
      return false
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
            console.error('[etebase-store] Failed to enqueue collection item delete', getSafeErrorDetails(queueErr))
          }
        }
        removeCachedItems(itemEntries.map(({ uid }) => uid))
        if (isLocalCacheEnabled()) {
          void cacheReplaceItemsForCollection(collection.uid, [])
        }
        const removedLocal = await removeItemsFromDomainStore(type, collection.uid)
        return Math.max(itemEntries.length, removedLocal)
      }

      console.error(`[etebase-store] Failed to clear ${type} collection`, getSafeErrorDetails(err))
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
      void recordLabelsFromContent(type, content)
      return item.uid
    } catch (err) {
      if (isOfflineError(err)) {
        const queueTempId = tempId ?? `pending-${Date.now()}`
        logger.warn(`[etebase-store] Offline — queuing create for ${type} (tempId: ${queueTempId})`)
        try {
          await enqueue({ type: 'create', collectionType: type, collectionUid: collection.uid, content, tempId: queueTempId })
        } catch (queueErr) {
          console.error('[etebase-store] Failed to enqueue create', getSafeErrorDetails(queueErr))
        }
      } else {
        console.error(`[etebase-store] Failed to create ${type} item`, getSafeErrorDetails(err))
        showSaveFailureToast(type)
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
        const noun = type === 'calendar' ? 'events' : type === 'tasks' ? 'tasks' : type === 'contacts' ? 'contacts' : 'preferences'
        console.error('[etebase-store] Batch import failed after retries', getSafeErrorDetails(permanentFailure))
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
            console.error('[etebase-store] Failed to enqueue create', getSafeErrorDetails(queueErr))
          }
        }
      } else {
        console.error(`[etebase-store] Failed to batch create ${type} items`, getSafeErrorDetails(err))
        showErrorToast(`Failed to import ${type === 'calendar' ? 'events' : type === 'tasks' ? 'tasks' : type === 'contacts' ? 'contacts' : 'preferences'}. Please try again.`)
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
      void recordLabelsFromContent(type, content)
    } catch (err) {
      if (isOfflineError(err)) {
        logger.warn(`[etebase-store] Offline — queuing update for ${type}/${itemUid}`)
        try {
          await enqueue({ type: 'update', collectionType: type, collectionUid: collection.uid, content, itemUid })
        } catch (queueErr) {
          console.error('[etebase-store] Failed to enqueue update', getSafeErrorDetails(queueErr))
        }
      } else {
        console.error(`[etebase-store] Failed to update ${type} item`, getSafeErrorDetails(err))
        showSaveFailureToast(type)
      }
    }
  },

  moveItem: async (type: CollectionTypeKey, itemUid: string, content: string, targetCollectionUid: string, sourceCollectionUid?: string) => {
    const { account, collections, itemCache, itemCollectionMap } = get()
    const resolvedSourceCollectionUid = itemCollectionMap.get(itemUid) ?? sourceCollectionUid
    const sourceCollection = resolveCollection(collections, type, resolvedSourceCollectionUid)
    const targetCollection = resolveCollection(collections, type, targetCollectionUid)
    const item = itemCache.get(itemUid)
    if (!account || !sourceCollection || !targetCollection || !item) {
      logger.warn(`[etebase-store] Cannot move item ${itemUid}: missing account, source collection, target collection, or item`)
      return null
    }

    if (sourceCollection.uid === targetCollection.uid) {
      await get().updateItem(type, itemUid, content)
      return itemUid
    }

    const core = await import('@silentsuite/core')
    const created = await core.createItem(account, targetCollection, content)
    let keepSourceUntilQueuedDelete = false

    try {
      await core.deleteItem(account, sourceCollection, item)
    } catch (err) {
      if (isOfflineError(err)) {
        logger.warn(`[etebase-store] Offline after moving ${type}/${itemUid} - queuing source delete`)
        await enqueue({ type: 'delete', collectionType: type, collectionUid: sourceCollection.uid, itemUid })
        keepSourceUntilQueuedDelete = true
      } else {
        try {
          await core.deleteItem(account, targetCollection, created)
        } catch (rollbackErr) {
          logger.warn(`[etebase-store] Failed to roll back moved ${type} item ${created.uid}`, rollbackErr)
        }
        throw err
      }
    }

    const newCache = new Map(get().itemCache)
    const newTypeMap = new Map(get().itemTypeMap)
    const newCollectionMap = new Map(get().itemCollectionMap)
    if (!keepSourceUntilQueuedDelete) {
      newCache.delete(itemUid)
      newTypeMap.delete(itemUid)
      newCollectionMap.delete(itemUid)
    }
    newCache.set(created.uid, created)
    newTypeMap.set(created.uid, type)
    newCollectionMap.set(created.uid, targetCollection.uid)
    set({ itemCache: newCache, itemTypeMap: newTypeMap, itemCollectionMap: newCollectionMap })
    if (isLocalCacheEnabled()) {
      if (!keepSourceUntilQueuedDelete) void cacheDeleteItem(itemUid)
      void writeItemToCache(type, targetCollection.uid, created.uid, content)
    }
    return created.uid
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
          console.error('[etebase-store] Failed to enqueue delete', getSafeErrorDetails(queueErr))
        }
      } else {
        console.error(`[etebase-store] Failed to delete ${type} item`, getSafeErrorDetails(err))
        showErrorToast(`Failed to delete ${type === 'calendar' ? 'event' : type === 'tasks' ? 'task' : type === 'contacts' ? 'contact' : 'preferences'}. Please try again.`)
      }
    }
  },

  fetchAllItems: async (type: CollectionTypeKey) => {
    const { itemCache, itemTypeMap, itemCollectionMap } = get()
    const results: CachedContentItem[] = []
    let matchingItemCount = 0
    let failedDecodeCount = 0

    for (const [uid, item] of itemCache.entries()) {
      if (itemTypeMap.get(uid) !== type) continue
      matchingItemCount++
      try {
        const content = await item.getContent()
        const contentStr = typeof content === 'string' ? content : new TextDecoder().decode(content)
        const collectionUid = itemCollectionMap.get(uid)
        if (collectionUid) results.push({ uid, content: contentStr, collectionUid })
      } catch (err) {
        failedDecodeCount++
        logger.warn(`[etebase-store] Failed to decode cached ${type} item`, getSafeErrorDetails(err))
      }
    }

    if (failedDecodeCount > 0) {
      throw new Error(`Could not decode cached ${collectionItemNoun(type)} (${failedDecodeCount}/${matchingItemCount} failed)`)
    }

    return results
  },

  loadCollectionItemsIncrementally: async (type, options: { onItems?: (items: CachedContentItem[], progress: IncrementalCollectionProgress) => Promise<void> | void } = {}) => {
    const { account, collections } = get()
    const emptyResult = (): IncrementalLoadResult => ({
      type,
      attemptedCount: 0,
      decodedCount: 0,
      decodeFailureCount: 0,
      enumerationErrorCount: 0,
      items: [],
      collections: [],
      trustworthyForFullReplacement: Boolean(account && collections[type].length > 0),
    })
    if (!account || collections[type].length === 0) {
      logger.warn(`[etebase-store] Cannot load ${type}: missing account or collection`)
      const fallbackItems = await get().fetchAllItems(type)
      return {
        ...emptyResult(),
        attemptedCount: fallbackItems.length,
        decodedCount: fallbackItems.length,
        items: fallbackItems,
        trustworthyForFullReplacement: false,
      }
    }

    const core = await import('@silentsuite/core')
    let loaded = 0
    const results: CachedContentItem[] = []
    const collectionResults: IncrementalCollectionResult[] = []

    for (const collection of collections[type]) {
      const collectionItems: CachedContentItem[] = []
      const collectionItemObjects: any[] = []
      let attemptedCount = 0
      let decodeFailureCount = 0
      let enumerationErrorCount = 0
      let stoken: string | null = null
      let done = false

      try {
        while (!done) {
          const response = await core.listItems(account, collection, stoken)
          const pageItems = response.items.filter((item: any) => !item.isDeleted)
          const pageResults: CachedContentItem[] = []

          for (const item of pageItems) {
            attemptedCount++
            collectionItemObjects.push(item)
            try {
              const content = await item.getContent()
              const contentStr = typeof content === 'string' ? content : new TextDecoder().decode(content)
              const cached = { uid: item.uid, content: contentStr, collectionUid: collection.uid }
              pageResults.push(cached)
              collectionItems.push(cached)
              results.push(cached)
            } catch (err) {
              decodeFailureCount++
              logger.warn(`[etebase-store] Failed to decode incremental ${type} item`, getSafeErrorDetails(err))
            }
          }

          loaded += pageResults.length
          stoken = response.stoken
          done = response.done
          await options.onItems?.(pageResults, { loaded, done, collectionUid: collection.uid })
        }
      } catch (err) {
        enumerationErrorCount++
        logger.warn(`[etebase-store] Failed to enumerate incremental ${type} collection`, getSafeErrorDetails(err))
      }

      const trustworthyForReplacement = enumerationErrorCount === 0 && decodeFailureCount === 0
      if (trustworthyForReplacement) {
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
        for (const item of collectionItemObjects) {
          newItemCache.set(item.uid, item)
          newItemTypeMap.set(item.uid, type)
          newItemCollectionMap.set(item.uid, collection.uid)
        }
        set({ itemCache: newItemCache, itemTypeMap: newItemTypeMap, itemCollectionMap: newItemCollectionMap })
      }

      collectionResults.push({
        attemptedCount,
        decodedCount: collectionItems.length,
        decodeFailureCount,
        enumerationErrorCount,
        items: collectionItems,
        trustworthyForReplacement,
        errorCategory: enumerationErrorCount > 0 ? 'enumeration-failed' : decodeFailureCount > 0 ? 'decode-failed' : undefined,
      })
    }

    const attemptedCount = collectionResults.reduce((sum, result) => sum + result.attemptedCount, 0)
    const decodedCount = collectionResults.reduce((sum, result) => sum + result.decodedCount, 0)
    const decodeFailureCount = collectionResults.reduce((sum, result) => sum + result.decodeFailureCount, 0)
    const enumerationErrorCount = collectionResults.reduce((sum, result) => sum + result.enumerationErrorCount, 0)
    const trustworthyForFullReplacement = collectionResults.every((result) => result.trustworthyForReplacement)

    logger.debug(`[etebase-store] Incrementally loaded ${results.length} ${type} items`)
    return {
      type,
      attemptedCount,
      decodedCount,
      decodeFailureCount,
      enumerationErrorCount,
      items: results,
      collections: collectionResults,
      trustworthyForFullReplacement,
    }
  },

  startSyncEngine: async () => {
    const { account, syncEngine } = get()
    if (!account || !syncEngine) return
    await syncEngine.start(account)
    logger.debug('[etebase-store] SyncEngine started')
  },

  refreshCollection: async (type: CollectionTypeKey, collectionUid?: string) => {
    const { account, collections } = get()
    const targetCollections = collectionUid
      ? [resolveCollection(collections, type, collectionUid)].filter(Boolean)
      : collections[type]
    if (!account || targetCollections.length === 0) {
      logger.warn(`[etebase-store] Cannot refresh ${type}: missing account or collection`)
      return get().fetchAllItems(type)
    }

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
        let skippedDecodeCount = 0

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
              } catch (err) {
                skippedDecodeCount++
                logger.warn(`[etebase-store] Failed to decode refreshed ${type} item`, getSafeErrorDetails(err))
              }
            }
          }
          stoken = response.stoken || undefined
          done = response.done
        }

        if (skippedDecodeCount > 0 && collectionItems.length === 0) {
          throw new Error(`Refreshed ${type} collection contained only undecodable items`)
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
      console.error(`[etebase-store] Failed to refresh ${type}`, getSafeErrorDetails(err))
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
      accountFingerprint: null,
      collections: { calendar: [], tasks: [], contacts: [], preferences: [], labelIndex: [] },
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
