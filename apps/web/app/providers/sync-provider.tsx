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
import { useLabelSuggestionsStore } from '@/app/stores/use-label-suggestions-store'
import {
  getItemsByType as cacheGetItemsByType,
  replaceItemsForType as cacheReplaceItemsForType,
  isCacheEnabled as isLocalCacheEnabled,
  getCacheCapabilityStatus,
  type CachedItem,
} from '@/app/lib/data-cache'
import {
  logSyncTiming,
  markCalendarSyncStart,
  nowMs,
} from '@/app/lib/sync-timing'
import {
  createSafeOperationalError,
  getSafeErrorDetails,
} from '@/app/lib/privacy-safe-errors'
import {
  partitionCalendarItemsForFastPaint,
  type CalendarContentItem,
} from '@/app/lib/calendar-loading'
import { readLocalSyncSummary, writeLocalSyncSummary } from '@/app/lib/sync-summary'
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
  options: { finalReplace?: boolean } = {},
): Promise<{ events: CalendarEvent[]; errors: unknown[] }> {
  const startedAt = nowMs()
  const { priority, backlog } = partitionCalendarItemsForFastPaint(items)
  const allEvents: CalendarEvent[] = []
  const errors: unknown[] = []
  let firstStoreUpdateLogged = false

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
        if (!firstStoreUpdateLogged) {
          firstStoreUpdateLogged = true
          logSyncTiming('calendar-first-store-update', startedAt, {
            source,
            group: groupName,
            chunkEventCount: chunkEvents.length,
            totalItemCount: items.length,
            priorityItemCount: priority.length,
            backlogItemCount: backlog.length,
          })
        }
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
  if (options.finalReplace !== false) {
    useCalendarStore.getState().syncFromRemote(allEvents)
  }
  logSyncTiming('calendar-deserialize-complete', startedAt, {
    source,
    totalItemCount: items.length,
    priorityItemCount: priority.length,
    backlogItemCount: backlog.length,
    eventCount: allEvents.length,
    errorCount: errors.length,
  })
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
  const setInitialSyncState = useSyncStore((s) => s.setInitialSyncState)
  const setInitialSyncBlocker = useSyncStore((s) => s.setInitialSyncBlocker)
  const setLastSynced = useSyncStore((s) => s.setLastSynced)
  const setError = useSyncStore((s) => s.setError)
  const startInitialSyncProgress = useSyncStore((s) => s.startInitialSyncProgress)
  const setInitialSyncProgressPhase = useSyncStore((s) => s.setInitialSyncProgressPhase)
  const updateInitialSyncProgress = useSyncStore((s) => s.updateInitialSyncProgress)
  const finishInitialSyncProgress = useSyncStore((s) => s.finishInitialSyncProgress)
  const resetInitialSyncProgress = useSyncStore((s) => s.resetInitialSyncProgress)

  const etebaseInitialize = useEtebaseStore((s) => s.initialize)
  const etebaseLoadIncrementally = useEtebaseStore((s) => s.loadCollectionItemsIncrementally)
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
      const initStartedAt = markCalendarSyncStart()
      try {
        setSyncStatus('syncing')
        setInitialSyncState('restoring')
        setInitialSyncBlocker(null)
        const cacheStatus = getCacheCapabilityStatus()
        logSyncTiming('cache-capability', initStartedAt, { ...cacheStatus })

        // Cache-first hydration: when the feature flag is on, paint the UI
        // from IndexedDB before the network sync starts. This is best-effort
        // — failures are logged and the normal init path proceeds.
        if (isLocalCacheEnabled()) {
          const hydrated = await hydrateFromCache()
          if (hydrated) setInitialSyncState('hydrated-cache')
        }

        // Restore session, create/fetch collections, load items, start SyncEngine
        const etebaseInitStartedAt = nowMs()
        const initOutcome = await etebaseInitialize()
        logSyncTiming('etebase-initialize', etebaseInitStartedAt)

        if (initOutcome.status === 'no-session') {
          setInitialSyncProgressPhase('blocked')
          setInitialSyncState('no-session')
          setInitialSyncBlocker('missing-encrypted-session')
          setSyncStatus('error')
          setError('Encrypted session was not restored. Sign in again to unlock your data.')
          return
        }

        if (initOutcome.status === 'offline') {
          resetInitialSyncProgress()
          setInitialSyncState('offline')
          setInitialSyncBlocker(null)
          setSyncStatus('offline')
          setError('Offline. Showing any cached encrypted data until sync can resume.')
          return
        }

        if (initOutcome.status === 'error') {
          setInitialSyncProgressPhase('blocked')
          setInitialSyncState('error')
          setInitialSyncBlocker('encrypted-session-restore-failed')
          setSyncStatus('error')
          setError('Could not restore encrypted session')
          return
        }

        setInitialSyncState('syncing')
        const fingerprint = useEtebaseStore.getState().accountFingerprint
        const summary = readLocalSyncSummary(fingerprint)
        startInitialSyncProgress(summary ? {
          calendar: summary.calendarCount,
          tasks: summary.taskCount,
          contacts: summary.contactCount,
        } : undefined)

        // Now load items from each collection into the data stores
        const loadHadErrors = await loadItemsIntoStores()

        if (loadHadErrors) {
          setSyncStatus('error')
          // A post-restore item or optional metadata load error should not
          // put the app back into the encrypted-session recovery/blocked UI.
          // Keep the visible domain stores usable and surface the problem via
          // the sync indicator instead of hiding the calendar behind a false
          // restore error screen.
          setInitialSyncState(hasVisibleDomainData() ? 'synced' : 'empty')
          setInitialSyncBlocker(null)
          finishInitialSyncProgress()
          setError('Some synced items could not be loaded')
        } else {
          // Start SyncEngine only after initial enumeration has completed, so
          // change handlers cannot full-replace stores from a partial item cache.
          await useEtebaseStore.getState().startSyncEngine()

          // Wire SyncEngine change events
          unsubChange = wireChangeHandler()

          // Wire SyncEngine status
          unsubStatus = wireStatusHandler()

          setSyncStatus('synced')
          setInitialSyncState(hasVisibleDomainData() ? 'synced' : 'empty')
          setInitialSyncBlocker(null)
          setError(null)
          finishInitialSyncProgress()
          const currentFingerprint = useEtebaseStore.getState().accountFingerprint
          if (currentFingerprint) {
            writeLocalSyncSummary(currentFingerprint, {
              calendarCount: useCalendarStore.getState().events.length,
              taskCount: useTaskStore.getState().tasks.length,
              contactCount: useContactStore.getState().contacts.length,
            })
          }
          setLastSynced(new Date())
        }
        logSyncTiming('initial-sync-complete', initStartedAt, { hadErrors: loadHadErrors })
      } catch (err) {
        reportSyncError('init', err)
        setSyncStatus('error')
        setInitialSyncState('error')
        const hasRestoredAccount = Boolean(useEtebaseStore.getState().account)
        setInitialSyncBlocker(hasRestoredAccount ? null : 'encrypted-session-restore-failed')
        setInitialSyncProgressPhase('error')
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
    function hasVisibleDomainData(): boolean {
      return useCalendarStore.getState().events.length > 0
        || useTaskStore.getState().tasks.length > 0
        || useContactStore.getState().contacts.length > 0
    }

    async function hydrateFromCache(): Promise<boolean> {
      const cacheHydrateStartedAt = nowMs()
      let hydratedAny = false
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
            hydratedAny = tasks.length > 0 || hydratedAny
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
            hydratedAny = contacts.length > 0 || hydratedAny
            logger.log(`[sync-provider] Hydrated ${contacts.length} contacts from cache`)
          } catch (err) {
            logger.warn('[sync-provider] Failed to hydrate contacts from cache', getSafeErrorDetails(err))
          }
        }

        logSyncTiming('cache-read', cacheHydrateStartedAt, {
          taskItemCount: taskItems.length,
          contactItemCount: contactItems.length,
          calendarItemCount: eventItems.length,
        })

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
              hydratedAny = events.length > 0 || hydratedAny
              logger.log(`[sync-provider] Hydrated ${events.length} events from cache`)
            }
          } catch (err) {
            logger.warn('[sync-provider] Failed to hydrate calendar events from cache', getSafeErrorDetails(err))
          }
        }
        logSyncTiming('cache-hydrate-complete', cacheHydrateStartedAt, {
          taskItemCount: taskItems.length,
          contactItemCount: contactItems.length,
          calendarItemCount: eventItems.length,
        })
      } catch (err) {
        logger.warn('[sync-provider] Cache hydration failed', getSafeErrorDetails(err))
        logSyncTiming('cache-hydrate-failed', cacheHydrateStartedAt)
      }
      return hydratedAny
    }

    async function loadItemsIntoStores(): Promise<boolean> {
      const cacheEnabled = isLocalCacheEnabled()
      let hadErrors = false

      async function mirrorToCache(
        type: 'tasks' | 'contacts' | 'calendar',
        items: { uid: string; content: string; collectionUid: string }[],
      ) {
        if (!cacheEnabled || items.length === 0) return
        const mirrorStartedAt = nowMs()
        const records: CachedItem[] = items.map((it) => ({
          itemUid: it.uid,
          collectionType: type,
          collectionUid: it.collectionUid,
          content: it.content,
          lastModified: Date.now(),
        }))
        try {
          await cacheReplaceItemsForType(type, records)
          logSyncTiming('cache-mirror', mirrorStartedAt, { type, itemCount: items.length })
        } catch (err) {
          logger.warn(`[sync-provider] Failed to mirror ${type} to cache`, getSafeErrorDetails(err))
          logSyncTiming('cache-mirror-failed', mirrorStartedAt, { type, itemCount: items.length })
        }
      }

      // Load calendar events first so the calendar can paint before unrelated
      // task/contact deserialization work on large accounts.
      let calendarEventCount = 0
      try {
        setInitialSyncProgressPhase('calendar')
        const calendarFetchStartedAt = nowMs()
        const { deserializeCalendarEvent } = await import('@silentsuite/core')
        const allEvents: CalendarEvent[] = []
        const eventItems = await etebaseLoadIncrementally('calendar', {
          onItems: async (pageItems, progress) => {
            if (pageItems.length > 0) {
              const { events, errors } = await deserializeCalendarItemsIncrementally(
                pageItems,
                deserializeCalendarEvent,
                'server',
                { finalReplace: false },
              )
              allEvents.push(...events)
              calendarEventCount = allEvents.length
              if (errors.length > 0) {
                hadErrors = true
                reportSyncError('load calendar event chunk', errors[0])
              }
            }
            updateInitialSyncProgress('calendar', calendarEventCount, undefined, progress.done)
          },
        })
        useCalendarStore.getState().syncFromRemote(allEvents)
        updateInitialSyncProgress('calendar', calendarEventCount, undefined, true)
        logSyncTiming('calendar-fetch', calendarFetchStartedAt, { itemCount: eventItems.length, eventCount: allEvents.length })
        logger.log(`[sync-provider] Loaded ${allEvents.length} calendar events from server`)
        await mirrorToCache('calendar', eventItems)
      } catch (err) {
        hadErrors = true
        reportSyncError('load calendar events', err)
      }

      // Load tasks
      try {
        setInitialSyncProgressPhase('tasks')
        const taskLoadStartedAt = nowMs()
        const taskItems = await etebaseLoadIncrementally('tasks')
        const { deserializeTask } = await import('@silentsuite/core')
        const tasks = taskItems.map((item) => {
          const task = deserializeTask(item.content)
          // Use the Etebase item UID only as the local id so updates/deletes
          // can address the item without changing the stable iCalendar UID.
          return { ...task, id: item.uid, listId: item.collectionUid }
        })
        useTaskStore.getState().syncFromRemote(tasks)
        updateInitialSyncProgress('tasks', tasks.length, undefined, true)
        logger.log(`[sync-provider] Loaded ${tasks.length} tasks from server`)
        logSyncTiming('tasks-load', taskLoadStartedAt, { itemCount: taskItems.length, taskCount: tasks.length })
        await mirrorToCache('tasks', taskItems)
      } catch (err) {
        hadErrors = true
        reportSyncError('load tasks', err)
      }

      // Load contacts
      try {
        setInitialSyncProgressPhase('contacts')
        const contactLoadStartedAt = nowMs()
        const contactItems = await etebaseLoadIncrementally('contacts')
        const { deserializeContact } = await import('@silentsuite/core')
        const contacts = contactItems.map((item) => {
          const contact = deserializeContact(item.content)
          return { ...contact, id: item.uid, listId: item.collectionUid }
        })
        useContactStore.getState().syncFromRemote(contacts)
        updateInitialSyncProgress('contacts', contacts.length, undefined, true)
        logger.log(`[sync-provider] Loaded ${contacts.length} contacts from server`)
        logSyncTiming('contacts-load', contactLoadStartedAt, { itemCount: contactItems.length, contactCount: contacts.length })
        await mirrorToCache('contacts', contactItems)
      } catch (err) {
        hadErrors = true
        reportSyncError('load contacts', err)
      }

      // Load non-visible encrypted collections into itemCache before their
      // stores initialize through fetchAllItems().
      setInitialSyncProgressPhase('preferences')
      try {
        await etebaseLoadIncrementally('preferences')
      } catch (err) {
        hadErrors = true
        reportSyncError('load preferences items', err)
      }
      try {
        await etebaseLoadIncrementally('labelIndex')
      } catch (err) {
        hadErrors = true
        reportSyncError('load label suggestion items', err)
      }

      // Load and subscribe account-level preferences after the Etebase item
      // cache is ready. Preferences stay in their own local store because one
      // field, notificationSound, is intentionally device-local.
      try {
        const preferencesStartedAt = nowMs()
        await usePreferencesSyncStore.getState().initialize()
        logSyncTiming('preferences-initialize', preferencesStartedAt)
      } catch (err) {
        hadErrors = true
        reportSyncError('initialize preferences sync', err)
      }

      // Load the encrypted label suggestion index from its dedicated Etebase
      // collection. Plaintext labels only exist inside decrypted item content.
      try {
        const labelIndexStartedAt = nowMs()
        await useLabelSuggestionsStore.getState().initialize()
        logSyncTiming('label-index-initialize', labelIndexStartedAt)
      } catch (err) {
        hadErrors = true
        reportSyncError('initialize label suggestions', err)
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
        } else if (collectionType === 'silentsuite.labelindex') {
          try {
            const labelIndexItems = await refresher('labelIndex', event.collectionUid)
            await useLabelSuggestionsStore.getState().loadFromRemote(labelIndexItems)
          } catch (err) {
            reportSyncError('sync label suggestions', err)
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
      useLabelSuggestionsStore.getState().destroy()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return <>{children}</>
}
