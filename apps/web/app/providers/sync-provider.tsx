'use client'

import { useEffect, useRef } from 'react'
import * as Sentry from '@sentry/nextjs'
import { useSyncStore } from '@/app/stores/use-sync-store'
import { logger } from '@/app/lib/logger'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useTaskStore } from '@/app/stores/use-task-store'
import { useContactStore } from '@/app/stores/use-contact-store'
import { useCalendarStore } from '@/app/stores/use-calendar-store'
import {
  getItemsByType as cacheGetItemsByType,
  replaceItemsForType as cacheReplaceItemsForType,
  isCacheEnabled as isLocalCacheEnabled,
  type CachedItem,
} from '@/app/lib/data-cache'

/**
 * SyncProvider orchestrates:
 * 1. Online/offline listeners (existing behavior)
 * 2. Etebase session restore + collection initialization
 * 3. Loading server data into Zustand stores
 * 4. Wiring SyncEngine change events to update stores
 * 5. Wiring SyncEngine status to the sync store indicator
 */
export function SyncProvider({ children }: { children: React.ReactNode }) {
  const initializeSync = useSyncStore((s) => s.initializeSync)
  const setSyncStatus = useSyncStore((s) => s.setSyncStatus)
  const setLastSynced = useSyncStore((s) => s.setLastSynced)
  const setError = useSyncStore((s) => s.setError)

  const etebaseInitialize = useEtebaseStore((s) => s.initialize)
  const etebaseFetchAllItems = useEtebaseStore((s) => s.fetchAllItems)
  const etebaseOnSyncChange = useEtebaseStore((s) => s.onSyncChange)
  const etebaseOnStatusChange = useEtebaseStore((s) => s.onStatusChange)
  const etebaseIsInitialized = useEtebaseStore((s) => s.isInitialized)

  const didInit = useRef(false)

  // 1. Online/offline listeners (existing)
  useEffect(() => {
    const cleanup = initializeSync()
    return cleanup
  }, [initializeSync])

  // 2. Initialize Etebase + load data + wire sync
  useEffect(() => {
    if (didInit.current) return
    didInit.current = true

    let unsubChange: (() => void) | null = null
    let unsubStatus: (() => void) | null = null

    async function init() {
      try {
        setSyncStatus('syncing')

        // Cache-first hydration: when the feature flag is on, paint the UI
        // from IndexedDB before the network sync starts. This is best-effort
        // — failures are logged and the normal init path proceeds.
        if (isLocalCacheEnabled()) {
          await hydrateFromCache()
        }

        // Restore session, create/fetch collections, load items, start SyncEngine
        await etebaseInitialize()

        // Now load items from each collection into the data stores
        await loadItemsIntoStores()

        // Wire SyncEngine change events
        unsubChange = wireChangeHandler()

        // Wire SyncEngine status
        unsubStatus = wireStatusHandler()

        setSyncStatus('synced')
        setLastSynced(new Date())
      } catch (err) {
        Sentry.captureException(err)
        console.error('[sync-provider] Init failed:', err)
        setSyncStatus('error')
        setError(err instanceof Error ? err.message : 'Sync initialization failed')
      }
    }

    /**
     * Cache-first paint. Reads decrypted item content out of IndexedDB and
     * pushes it into the domain stores so the UI renders from cache before
     * the network sync settles. The subsequent etebaseInitialize() +
     * loadItemsIntoStores() pass overwrites with server data, which is the
     * source of truth.
     *
     * Cheap (~10-50ms for a typical vault) and fully off the network path.
     * Failures here are non-fatal; we just skip the optimistic paint.
     */
    async function hydrateFromCache() {
      try {
        const [taskItems, contactItems, eventItems, core] = await Promise.all([
          cacheGetItemsByType('tasks'),
          cacheGetItemsByType('contacts'),
          cacheGetItemsByType('calendar'),
          import('@silentsuite/core'),
        ])

        if (taskItems.length > 0) {
          try {
            const tasks = taskItems.map((it) => {
              const task = core.deserializeTask(it.content)
              return { ...task, id: it.itemUid, uid: it.itemUid }
            })
            useTaskStore.getState().syncFromRemote(tasks)
            logger.log(`[sync-provider] Hydrated ${tasks.length} tasks from cache`)
          } catch (err) {
            logger.warn('[sync-provider] Failed to hydrate tasks from cache', err)
          }
        }

        if (contactItems.length > 0) {
          try {
            const contacts = contactItems.map((it) => {
              const contact = core.deserializeContact(it.content)
              return { ...contact, id: it.itemUid, uid: it.itemUid }
            })
            useContactStore.getState().syncFromRemote(contacts)
            logger.log(`[sync-provider] Hydrated ${contacts.length} contacts from cache`)
          } catch (err) {
            logger.warn('[sync-provider] Failed to hydrate contacts from cache', err)
          }
        }

        if (eventItems.length > 0) {
          try {
            const events = eventItems.map((it) => {
              const event = core.deserializeCalendarEvent(it.content)
              return { ...event, id: it.itemUid, uid: it.itemUid }
            })
            useCalendarStore.getState().syncFromRemote(events)
            logger.log(`[sync-provider] Hydrated ${events.length} events from cache`)
          } catch (err) {
            logger.warn('[sync-provider] Failed to hydrate calendar events from cache', err)
          }
        }
      } catch (err) {
        logger.warn('[sync-provider] Cache hydration failed', err)
      }
    }

    async function loadItemsIntoStores() {
      const etebase = useEtebaseStore.getState()
      const cacheEnabled = isLocalCacheEnabled()

      async function mirrorToCache(
        type: 'tasks' | 'contacts' | 'calendar',
        items: { uid: string; content: string }[],
      ) {
        if (!cacheEnabled || items.length === 0) return
        const collectionUid = useEtebaseStore.getState().collections[type]?.uid
        if (!collectionUid) return
        const records: CachedItem[] = items.map((it) => ({
          itemUid: it.uid,
          collectionType: type,
          collectionUid,
          content: it.content,
          lastModified: Date.now(),
        }))
        try {
          await cacheReplaceItemsForType(type, records)
        } catch (err) {
          logger.warn(`[sync-provider] Failed to mirror ${type} to cache`, err)
        }
      }

      // Load tasks
      try {
        const taskItems = await etebase.fetchAllItems('tasks')
        if (taskItems.length > 0) {
          const { deserializeTask } = await import('@silentsuite/core')
          const tasks = taskItems.map((item) => {
            const task = deserializeTask(item.content)
            // Override the local id/uid with the Etebase item UID
            // so we can map back to the Etebase item for updates/deletes
            return { ...task, id: item.uid, uid: item.uid }
          })
          useTaskStore.getState().syncFromRemote(tasks)
          logger.log(`[sync-provider] Loaded ${tasks.length} tasks from server`)
          await mirrorToCache('tasks', taskItems)
        }
      } catch (err) {
        Sentry.captureException(err)
        console.error('[sync-provider] Failed to load tasks:', err)
      }

      // Load contacts
      try {
        const contactItems = await etebase.fetchAllItems('contacts')
        if (contactItems.length > 0) {
          const { deserializeContact } = await import('@silentsuite/core')
          const contacts = contactItems.map((item) => {
            const contact = deserializeContact(item.content)
            return { ...contact, id: item.uid, uid: item.uid }
          })
          useContactStore.getState().syncFromRemote(contacts)
          logger.log(`[sync-provider] Loaded ${contacts.length} contacts from server`)
          await mirrorToCache('contacts', contactItems)
        }
      } catch (err) {
        Sentry.captureException(err)
        console.error('[sync-provider] Failed to load contacts:', err)
      }

      // Load calendar events
      try {
        const eventItems = await etebase.fetchAllItems('calendar')
        if (eventItems.length > 0) {
          const { deserializeCalendarEvent } = await import('@silentsuite/core')
          const events = eventItems.map((item) => {
            const event = deserializeCalendarEvent(item.content)
            return { ...event, id: item.uid, uid: item.uid }
          })
          useCalendarStore.getState().syncFromRemote(events)
          logger.log(`[sync-provider] Loaded ${events.length} calendar events from server`)
          await mirrorToCache('calendar', eventItems)
        }
      } catch (err) {
        Sentry.captureException(err)
        console.error('[sync-provider] Failed to load calendar events:', err)
      }
    }

    function wireChangeHandler(): (() => void) | null {
      const etebase = useEtebaseStore.getState()
      return etebase.onSyncChange(async (event) => {
        logger.log('[sync-provider] Sync change:', event.changeType, event.collectionType, event.itemUids.length, 'items')

        // Re-fetch ALL items from the Etebase server for the changed collection.
        // refreshCollection() bypasses the stale local cache and goes to the server.
        const collectionType = event.collectionType
        const refresher = useEtebaseStore.getState().refreshCollection
        const core = await import('@silentsuite/core')

        if (collectionType === 'etebase.vtodo') {
          try {
            const taskItems = await refresher('tasks')
            const tasks = taskItems.map((item) => {
              const task = core.deserializeTask(item.content)
              return { ...task, id: item.uid, uid: item.uid }
            })
            useTaskStore.getState().syncFromRemote(tasks)
          } catch (err) {
            Sentry.captureException(err)
            console.error('[sync-provider] Failed to sync tasks:', err)
          }
        } else if (collectionType === 'etebase.vcard') {
          try {
            const contactItems = await refresher('contacts')
            const contacts = contactItems.map((item) => {
              const contact = core.deserializeContact(item.content)
              return { ...contact, id: item.uid, uid: item.uid }
            })
            useContactStore.getState().syncFromRemote(contacts)
          } catch (err) {
            Sentry.captureException(err)
            console.error('[sync-provider] Failed to sync contacts:', err)
          }
        } else if (collectionType === 'etebase.vevent') {
          try {
            const eventItems = await refresher('calendar')
            const events = eventItems.map((item) => {
              const event = core.deserializeCalendarEvent(item.content)
              return { ...event, id: item.uid, uid: item.uid }
            })
            useCalendarStore.getState().syncFromRemote(events)
          } catch (err) {
            Sentry.captureException(err)
            console.error('[sync-provider] Failed to sync calendar events:', err)
          }
        }

        setLastSynced(new Date())
      })
    }

    function wireStatusHandler(): (() => void) | null {
      const etebase = useEtebaseStore.getState()
      return etebase.onStatusChange((status: string) => {
        setSyncStatus(status as any)
        if (status === 'synced') {
          setLastSynced(new Date())
          setError(null)
        } else if (status === 'error') {
          setError('Sync error occurred')
        }
      })
    }

    init()

    return () => {
      if (unsubChange) unsubChange()
      if (unsubStatus) unsubStatus()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return <>{children}</>
}
