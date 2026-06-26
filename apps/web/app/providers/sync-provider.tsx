'use client'

import { useEffect, useRef } from 'react'
import * as Sentry from '@sentry/nextjs'
import { useSyncStore } from '@/app/stores/use-sync-store'
import { logger } from '@/app/lib/logger'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useTaskStore } from '@/app/stores/use-task-store'
import { useContactStore } from '@/app/stores/use-contact-store'
import { useCalendarStore } from '@/app/stores/use-calendar-store'
import { usePreferencesSyncStore } from '@/app/stores/use-preferences-sync-store'
import {
  getItemsByType as cacheGetItemsByType,
  replaceItemsForType as cacheReplaceItemsForType,
  isCacheEnabled as isLocalCacheEnabled,
  type CachedItem,
} from '@/app/lib/data-cache'
import {
  createSafeOperationalError,
  getSafeErrorDetails,
} from '@/app/lib/privacy-safe-errors'
import {
  partitionCalendarItemsForFastPaint,
  type CalendarContentItem,
} from '@/app/lib/calendar-loading'
import type { CalendarEvent } from '@silentsuite/core'

const CALENDAR_DESERIALIZE_CHUNK_SIZE = 50

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function reportSyncError(operation: string, err: unknown) {
  Sentry.captureException(createSafeOperationalError('sync-provider', operation), {
    tags: { component: 'sync-provider', operation },
    extra: getSafeErrorDetails(err),
  })
  logger.error(`[sync-provider] ${operation} failed`, getSafeErrorDetails(err))
}

async function deserializeCalendarItemsIncrementally(
  items: CalendarContentItem[],
  deserializeCalendarEvent: (content: string) => CalendarEvent,
  source: 'cache' | 'server',
): Promise<{ events: CalendarEvent[]; errors: unknown[] }> {
  const { priority, backlog } = partitionCalendarItemsForFastPaint(items)
  const allEvents: CalendarEvent[] = []
  const errors: unknown[] = []

  async function processGroup(group: CalendarContentItem[], groupName: 'priority' | 'backlog') {
    for (let start = 0; start < group.length; start += CALENDAR_DESERIALIZE_CHUNK_SIZE) {
      const chunk = group.slice(start, start + CALENDAR_DESERIALIZE_CHUNK_SIZE)
      const chunkEvents: CalendarEvent[] = []

      for (const item of chunk) {
        try {
          const event = deserializeCalendarEvent(item.content)
          chunkEvents.push({ ...event, id: item.uid, calendarId: item.collectionUid })
        } catch (err) {
          errors.push(err)
          logger.warn(`[sync-provider] Failed to deserialize ${source} calendar item`, getSafeErrorDetails(err))
        }
      }

      if (chunkEvents.length > 0) {
        allEvents.push(...chunkEvents)
        useCalendarStore.getState().upsertFromRemote(chunkEvents)
        logger.debug(
          `[sync-provider] Loaded ${chunkEvents.length} ${source} calendar events from ${groupName} chunk`,
        )
      }

      if (start + CALENDAR_DESERIALIZE_CHUNK_SIZE < group.length) {
        await yieldToBrowser()
      }
    }
  }

  await processGroup(priority, 'priority')
  await yieldToBrowser()
  await processGroup(backlog, 'backlog')

  // Final replace is still required: it preserves full-history search while
  // dropping items that were deleted remotely after the previous local state.
  useCalendarStore.getState().syncFromRemote(allEvents)
  return { events: allEvents, errors }
}

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
        const loadHadErrors = await loadItemsIntoStores()

        // Wire SyncEngine change events
        unsubChange = wireChangeHandler()

        // Wire SyncEngine status
        unsubStatus = wireStatusHandler()

        if (loadHadErrors) {
          setSyncStatus('error')
          setError('Some synced items could not be loaded')
        } else {
          setSyncStatus('synced')
          setError(null)
        }
        setLastSynced(new Date())
      } catch (err) {
        reportSyncError('init', err)
        setSyncStatus('error')
        setError('Sync initialization failed')
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
              return { ...task, id: it.itemUid, listId: it.collectionUid }
            })
            useTaskStore.getState().syncFromRemote(tasks)
            logger.log(`[sync-provider] Hydrated ${tasks.length} tasks from cache`)
          } catch (err) {
            logger.warn('[sync-provider] Failed to hydrate tasks from cache', getSafeErrorDetails(err))
          }
        }

        if (contactItems.length > 0) {
          try {
            const contacts = contactItems.map((it) => {
              const contact = core.deserializeContact(it.content)
              return { ...contact, id: it.itemUid, listId: it.collectionUid }
            })
            useContactStore.getState().syncFromRemote(contacts)
            logger.log(`[sync-provider] Hydrated ${contacts.length} contacts from cache`)
          } catch (err) {
            logger.warn('[sync-provider] Failed to hydrate contacts from cache', getSafeErrorDetails(err))
          }
        }

        if (eventItems.length > 0) {
          try {
            const { events, errors } = await deserializeCalendarItemsIncrementally(
              eventItems.map((it) => ({
                uid: it.itemUid,
                content: it.content,
                collectionUid: it.collectionUid,
              })),
              core.deserializeCalendarEvent,
              'cache',
            )
            if (errors.length > 0) {
              setSyncStatus('error')
              setError('Some cached calendar events could not be loaded')
              reportSyncError('hydrate cached calendar events', errors[0])
            } else {
              logger.log(`[sync-provider] Hydrated ${events.length} events from cache`)
            }
          } catch (err) {
            logger.warn('[sync-provider] Failed to hydrate calendar events from cache', getSafeErrorDetails(err))
          }
        }
      } catch (err) {
        logger.warn('[sync-provider] Cache hydration failed', getSafeErrorDetails(err))
      }
    }

    async function loadItemsIntoStores(): Promise<boolean> {
      const etebase = useEtebaseStore.getState()
      const cacheEnabled = isLocalCacheEnabled()
      let hadErrors = false

      async function mirrorToCache(
        type: 'tasks' | 'contacts' | 'calendar',
        items: { uid: string; content: string; collectionUid: string }[],
      ) {
        if (!cacheEnabled || items.length === 0) return
        const records: CachedItem[] = items.map((it) => ({
          itemUid: it.uid,
          collectionType: type,
          collectionUid: it.collectionUid,
          content: it.content,
          lastModified: Date.now(),
        }))
        try {
          await cacheReplaceItemsForType(type, records)
        } catch (err) {
          logger.warn(`[sync-provider] Failed to mirror ${type} to cache`, getSafeErrorDetails(err))
        }
      }

      // Load calendar events first so the calendar can paint before unrelated
      // task/contact deserialization work on large accounts.
      try {
        const eventItems = await etebase.fetchAllItems('calendar')
        if (eventItems.length > 0) {
          const { deserializeCalendarEvent } = await import('@silentsuite/core')
          const { events, errors } = await deserializeCalendarItemsIncrementally(
            eventItems,
            deserializeCalendarEvent,
            'server',
          )
          logger.log(`[sync-provider] Loaded ${events.length} calendar events from server`)
          if (errors.length > 0) {
            hadErrors = true
            reportSyncError('load calendar event chunk', errors[0])
          }
          await mirrorToCache('calendar', eventItems)
        }
      } catch (err) {
        hadErrors = true
        reportSyncError('load calendar events', err)
      }

      // Load tasks
      try {
        const taskItems = await etebase.fetchAllItems('tasks')
        if (taskItems.length > 0) {
          const { deserializeTask } = await import('@silentsuite/core')
          const tasks = taskItems.map((item) => {
            const task = deserializeTask(item.content)
            // Use the Etebase item UID only as the local id so updates/deletes
            // can address the item without changing the stable iCalendar UID.
            return { ...task, id: item.uid, listId: item.collectionUid }
          })
          useTaskStore.getState().syncFromRemote(tasks)
          logger.log(`[sync-provider] Loaded ${tasks.length} tasks from server`)
          await mirrorToCache('tasks', taskItems)
        }
      } catch (err) {
        hadErrors = true
        reportSyncError('load tasks', err)
      }

      // Load contacts
      try {
        const contactItems = await etebase.fetchAllItems('contacts')
        if (contactItems.length > 0) {
          const { deserializeContact } = await import('@silentsuite/core')
          const contacts = contactItems.map((item) => {
            const contact = deserializeContact(item.content)
            return { ...contact, id: item.uid, listId: item.collectionUid }
          })
          useContactStore.getState().syncFromRemote(contacts)
          logger.log(`[sync-provider] Loaded ${contacts.length} contacts from server`)
          await mirrorToCache('contacts', contactItems)
        }
      } catch (err) {
        hadErrors = true
        reportSyncError('load contacts', err)
      }

      // Load and subscribe account-level preferences after the Etebase item
      // cache is ready. Preferences stay in their own local store because one
      // field, notificationSound, is intentionally device-local.
      try {
        await usePreferencesSyncStore.getState().initialize()
      } catch (err) {
        hadErrors = true
        reportSyncError('initialize preferences sync', err)
      }

      return hadErrors
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
            await refresher('tasks', event.collectionUid)
            const taskItems = await useEtebaseStore.getState().fetchAllItems('tasks')
            const tasks = taskItems.map((item) => {
              const task = core.deserializeTask(item.content)
              return { ...task, id: item.uid, listId: item.collectionUid }
            })
            useTaskStore.getState().syncFromRemote(tasks)
          } catch (err) {
            reportSyncError('sync tasks', err)
          }
        } else if (collectionType === 'etebase.vcard') {
          try {
            await refresher('contacts', event.collectionUid)
            const contactItems = await useEtebaseStore.getState().fetchAllItems('contacts')
            const contacts = contactItems.map((item) => {
              const contact = core.deserializeContact(item.content)
              return { ...contact, id: item.uid, listId: item.collectionUid }
            })
            useContactStore.getState().syncFromRemote(contacts)
          } catch (err) {
            reportSyncError('sync contacts', err)
          }
        } else if (collectionType === 'etebase.vevent') {
          try {
            await refresher('calendar', event.collectionUid)
            const eventItems = await useEtebaseStore.getState().fetchAllItems('calendar')
            const events = eventItems.map((item) => {
              const event = core.deserializeCalendarEvent(item.content)
              return { ...event, id: item.uid, calendarId: item.collectionUid }
            })
            useCalendarStore.getState().syncFromRemote(events)
          } catch (err) {
            reportSyncError('sync calendar events', err)
          }
        } else if (collectionType === 'silentsuite.preferences') {
          try {
            const preferenceItems = await refresher('preferences', event.collectionUid)
            await usePreferencesSyncStore.getState().loadFromRemote(preferenceItems)
          } catch (err) {
            reportSyncError('sync preferences', err)
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
      usePreferencesSyncStore.getState().destroy()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return <>{children}</>
}
