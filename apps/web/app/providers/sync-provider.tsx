'use client'

import { useEffect, useRef } from 'react'
import * as Sentry from '@sentry/nextjs'
import { useSyncStore } from '@/app/stores/use-sync-store'
import { logger } from '@/app/lib/logger'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useTaskStore } from '@/app/stores/use-task-store'
import { useContactStore } from '@/app/stores/use-contact-store'
import { useCalendarStore } from '@/app/stores/use-calendar-store'
import { useLabelSuggestionsStore } from '@/app/stores/use-label-suggestions-store'
import { usePreferencesSyncStore } from '@/app/stores/use-preferences-sync-store'
import {
  getItemsByType as cacheGetItemsByType,
  replaceItemsForType as cacheReplaceItemsForType,
  isCacheEnabled as isLocalCacheEnabled,
  getCacheCapabilityStatus,
  type CachedItem,
} from '@/app/lib/data-cache'
import {
  createSafeOperationalError,
  getSafeErrorDetails,
} from '@/app/lib/privacy-safe-errors'
import {
  logSyncTiming,
  markSyncTimingStart,
  nowMs,
  safeTimingErrorCategory,
  type SyncTimingPhase,
  type SyncTimingFields,
} from '@/app/lib/sync-timing'
import { AccountBoundaryChangedError, assertCurrentAccountEpoch, getAccountEpoch } from '@/app/lib/account-epoch'

function reportSyncError(operation: string, err: unknown) {
  Sentry.captureException(createSafeOperationalError('sync-provider', operation), {
    tags: { component: 'sync-provider', operation },
    extra: getSafeErrorDetails(err),
  })
  logger.error(`[sync-provider] ${operation} failed`, getSafeErrorDetails(err))
}

function safeLogSyncTiming(phase: SyncTimingPhase, startedAt: number, fields: SyncTimingFields = {}) {
  try {
    logSyncTiming(phase, startedAt, fields)
  } catch {
    // Instrumentation must never affect sync behavior.
  }
}

function countVisiblePartialDomains() {
  const state = useEtebaseStore.getState().domainLoadState
  return (['tasks', 'contacts', 'calendar'] as const).filter((type) => state[type] === 'failed').length
}

function updatePartialLoadFlag() {
  const failedCount = countVisiblePartialDomains()
  useSyncStore.getState().setPartialLoad(failedCount > 0, failedCount)
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
    const accountEpoch = getAccountEpoch()

    let unsubChange: (() => void) | null = null
    let unsubStatus: (() => void) | null = null

    async function init() {
      const initStartedAt = markSyncTimingStart()
      try {
        setSyncStatus('syncing')
        safeLogSyncTiming('cache-capability', initStartedAt, { ...getCacheCapabilityStatus() })

        // Restore session, create/fetch collections, and enumerate items. The
        // onDomainLoaded hook fires once per visible domain as soon as that
        // domain reaches a terminal state, so calendar deserializes and paints
        // before slower tasks/contacts finish. This replaces the old
        // post-initialize all-domain load, so no domain is replaced twice.
        const etebaseStartedAt = nowMs()
        await etebaseInitialize({
          onCacheHydrate: async () => {
            const cacheStartedAt = nowMs()
            await hydrateFromCache(cacheStartedAt)
          },
          onDomainLoaded: async (event) => {
            await loadDomainIntoStore(event.type)
            updatePartialLoadFlag()
          },
        })
        assertCurrentAccountEpoch(accountEpoch)
        safeLogSyncTiming('etebase-initialize', etebaseStartedAt)

        // Wire SyncEngine change events
        const changeHandlerStartedAt = nowMs()
        unsubChange = wireChangeHandler()
        safeLogSyncTiming('wire-change-handler', changeHandlerStartedAt, { status: unsubChange ? 'ok' : 'skipped' })

        // Supporting metadata only: no passive writes and no visible restore blocking.
        void useLabelSuggestionsStore.getState().initialize()
          .then(() => {
            assertCurrentAccountEpoch(accountEpoch)
            useLabelSuggestionsStore.getState().seedFromVisibleItems()
          })
          .catch((err) => logger.warn('[sync-provider] Label suggestions initialization failed', getSafeErrorDetails(err)))
        void usePreferencesSyncStore.getState().initialize()
          .catch((err) => logger.warn('[sync-provider] Preferences sync initialization failed', getSafeErrorDetails(err)))

        // Wire SyncEngine status
        const statusHandlerStartedAt = nowMs()
        unsubStatus = wireStatusHandler()
        safeLogSyncTiming('wire-status-handler', statusHandlerStartedAt, { status: unsubStatus ? 'ok' : 'skipped' })

        setSyncStatus('synced')
        setLastSynced(new Date())
        safeLogSyncTiming('initial-sync-complete', initStartedAt)
      } catch (err) {
        if (err instanceof AccountBoundaryChangedError) return
        safeLogSyncTiming('initial-sync-failed', initStartedAt, { errorCategory: safeTimingErrorCategory('unknown') })
        reportSyncError('init', err)
        setSyncStatus('error')
        setError('Sync initialization failed')
      }
    }

    /**
     * Cache-first paint. Reads decrypted item content out of IndexedDB and
     * pushes it into the domain stores so the UI renders from cache before
     * the network sync settles. This is invoked only after the restored
     * account fingerprint and encrypted cache envelope are verified. The
     * subsequent per-domain server load overwrites with server data, which is
     * the source of truth.
     *
     * Cheap (~10-50ms for a typical vault) and fully off the network path.
     * Failures here are non-fatal; we just skip the optimistic paint.
     */
    async function hydrateFromCache(startedAt = nowMs()) {
      try {
        const [taskItems, contactItems, eventItems, core] = await Promise.all([
          cacheGetItemsByType('tasks'),
          cacheGetItemsByType('contacts'),
          cacheGetItemsByType('calendar'),
          import('@silentsuite/core'),
        ])
        assertCurrentAccountEpoch(accountEpoch)

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
            const events = eventItems.map((it) => {
              const event = core.deserializeCalendarEvent(it.content)
              return { ...event, id: it.itemUid, calendarId: it.collectionUid }
            })
            useCalendarStore.getState().syncFromRemote(events)
            logger.log(`[sync-provider] Hydrated ${events.length} events from cache`)
          } catch (err) {
            logger.warn('[sync-provider] Failed to hydrate calendar events from cache', getSafeErrorDetails(err))
          }
        }
        safeLogSyncTiming('cache-hydrate', startedAt, {
          status: 'ok',
          taskItemCount: taskItems.length,
          contactItemCount: contactItems.length,
          calendarItemCount: eventItems.length,
        })
      } catch (err) {
        if (err instanceof AccountBoundaryChangedError) throw err
        logger.warn('[sync-provider] Cache hydration failed', getSafeErrorDetails(err))
        safeLogSyncTiming('cache-hydrate-failed', startedAt, { status: 'failed', errorCategory: 'cache' })
      }
    }

    async function mirrorToCache(
      type: 'tasks' | 'contacts' | 'calendar',
      items: { uid: string; content: string; collectionUid: string }[],
    ) {
      if (!isLocalCacheEnabled()) return
      const startedAt = nowMs()
      const records: CachedItem[] = items.map((it) => ({
        itemUid: it.uid,
        collectionType: type,
        collectionUid: it.collectionUid,
        content: it.content,
        lastModified: Date.now(),
      }))
      try {
        await cacheReplaceItemsForType(type, records)
        safeLogSyncTiming('cache-mirror', startedAt, { type, itemCount: items.length })
      } catch (err) {
        logger.warn(`[sync-provider] Failed to mirror ${type} to cache`, getSafeErrorDetails(err))
        safeLogSyncTiming('cache-mirror-failed', startedAt, { type, itemCount: items.length, errorCategory: 'cache' })
      }
    }

    // Explicit per-type phase names keep sync timing off arbitrary strings.
    const TIMING_PHASE_BY_TYPE = {
      tasks: 'tasks-load',
      contacts: 'contacts-load',
      calendar: 'calendar-load',
    } as const

    /**
     * Deserialize one visible domain's server items into its Zustand store.
     * Only replaces the store when that domain is 'loaded' -- a failed/unknown
     * domain (Slice 4) keeps its existing store contents untouched.
     */
    async function loadDomainIntoStore(type: 'calendar' | 'tasks' | 'contacts') {
      const startedAt = nowMs()
      const cacheEnabled = isLocalCacheEnabled()
      try {
        const items = await useEtebaseStore.getState().fetchAllItems(type)
        assertCurrentAccountEpoch(accountEpoch)
        let domainItemCount = 0
        if (useEtebaseStore.getState().domainLoadState[type] === 'loaded') {
          const core = await import('@silentsuite/core')
          assertCurrentAccountEpoch(accountEpoch)
          if (type === 'tasks') {
            const tasks = items.map((item) => {
              // Use the Etebase item UID only as the local id so updates/deletes
              // can address the item without changing the stable iCalendar UID.
              const task = core.deserializeTask(item.content)
              return { ...task, id: item.uid, listId: item.collectionUid }
            })
            domainItemCount = tasks.length
            useTaskStore.getState().syncFromRemote(tasks)
            logger.log(`[sync-provider] Loaded ${tasks.length} tasks from server`)
          } else if (type === 'contacts') {
            const contacts = items.map((item) => {
              const contact = core.deserializeContact(item.content)
              return { ...contact, id: item.uid, listId: item.collectionUid }
            })
            domainItemCount = contacts.length
            useContactStore.getState().syncFromRemote(contacts)
            logger.log(`[sync-provider] Loaded ${contacts.length} contacts from server`)
          } else {
            const events = items.map((item) => {
              const event = core.deserializeCalendarEvent(item.content)
              return { ...event, id: item.uid, calendarId: item.collectionUid }
            })
            domainItemCount = events.length
            useCalendarStore.getState().syncFromRemote(events)
            logger.log(`[sync-provider] Loaded ${events.length} calendar events from server`)
          }
          await mirrorToCache(type, items)
        }
        const countField = type === 'tasks' ? 'taskCount' : type === 'contacts' ? 'contactCount' : 'eventCount'
        safeLogSyncTiming(TIMING_PHASE_BY_TYPE[type], startedAt, {
          source: 'server',
          cacheEnabled,
          itemCount: items.length,
          [countField]: domainItemCount,
        })
      } catch (err) {
        if (err instanceof AccountBoundaryChangedError) return
        safeLogSyncTiming(TIMING_PHASE_BY_TYPE[type], startedAt, { source: 'server', status: 'failed', errorCategory: 'deserialize' })
        reportSyncError(`load ${type}`, err)
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
            await refresher('tasks', event.collectionUid)
            updatePartialLoadFlag()
            if (useEtebaseStore.getState().domainLoadState.tasks === 'loaded') {
              const taskItems = await useEtebaseStore.getState().fetchAllItems('tasks')
              const tasks = taskItems.map((item) => {
                const task = core.deserializeTask(item.content)
                return { ...task, id: item.uid, listId: item.collectionUid }
              })
              useTaskStore.getState().syncFromRemote(tasks)
            }
          } catch (err) {
            reportSyncError('sync tasks', err)
          }
        } else if (collectionType === 'etebase.vcard') {
          try {
            await refresher('contacts', event.collectionUid)
            updatePartialLoadFlag()
            if (useEtebaseStore.getState().domainLoadState.contacts === 'loaded') {
              const contactItems = await useEtebaseStore.getState().fetchAllItems('contacts')
              const contacts = contactItems.map((item) => {
                const contact = core.deserializeContact(item.content)
                return { ...contact, id: item.uid, listId: item.collectionUid }
              })
              useContactStore.getState().syncFromRemote(contacts)
            }
          } catch (err) {
            reportSyncError('sync contacts', err)
          }
        } else if (collectionType === 'etebase.vevent') {
          try {
            await refresher('calendar', event.collectionUid)
            updatePartialLoadFlag()
            if (useEtebaseStore.getState().domainLoadState.calendar === 'loaded') {
              const eventItems = await useEtebaseStore.getState().fetchAllItems('calendar')
              const events = eventItems.map((item) => {
                const event = core.deserializeCalendarEvent(item.content)
                return { ...event, id: item.uid, calendarId: item.collectionUid }
              })
              useCalendarStore.getState().syncFromRemote(events)
            }
          } catch (err) {
            reportSyncError('sync calendar events', err)
          }
        } else if (collectionType === 'silentsuite.labelindex') {
          try {
            await useLabelSuggestionsStore.getState().refreshFromRemote()
          } catch (err) {
            logger.warn('[sync-provider] Label suggestions refresh failed', getSafeErrorDetails(err))
          }
        } else if (collectionType === 'silentsuite.preferences') {
          try {
            const preferenceItems = await refresher('preferences', event.collectionUid)
            await usePreferencesSyncStore.getState().loadFromRemote(preferenceItems)
          } catch (err) {
            logger.warn('[sync-provider] Preferences refresh failed', getSafeErrorDetails(err))
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
