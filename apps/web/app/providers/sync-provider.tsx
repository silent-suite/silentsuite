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
  beginPassiveStartupToastCycle,
  endPassiveStartupToastCycle,
} from '@/app/stores/use-toast-store'
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

type InitialDomainLoadResult = {
  domain: 'calendar' | 'tasks' | 'contacts' | 'preferences' | 'labelIndex'
  visibility: 'visible' | 'internal'
  status: 'loaded' | 'empty' | 'warning' | 'degraded' | 'failed'
  itemCount: number
  decodedCount: number
  decodeFailureCount: number
  errorCategory?: string
}

type InitialLoadClassification = {
  accountRestored: true
  domains: InitialDomainLoadResult[]
  visibleFatal: boolean
  visibleWarnings: InitialDomainLoadResult[]
  internalWarnings: InitialDomainLoadResult[]
  safeToWireSyncEngine: boolean
}

function errorCategoryFrom(err: unknown): string {
  const details = getSafeErrorDetails(err) as { name?: unknown; code?: unknown; status?: unknown }
  if (typeof details.status === 'number') return `http-${details.status}`
  if (typeof details.code === 'string') return details.code
  if (typeof details.name === 'string') return details.name
  return 'unknown'
}

function shouldWireSyncEngine(_classification: Pick<InitialLoadClassification, 'visibleFatal'>): boolean {
  return true
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  if (incoming.length === 0) return current
  const byId = new Map(current.map((item) => [item.id, item]))
  for (const item of incoming) byId.set(item.id, item)
  return Array.from(byId.values())
}

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
        logSyncTiming('etebase-initialize', etebaseInitStartedAt, {
          syncEnginePrepared: Boolean(useEtebaseStore.getState().syncEngine),
          etebaseStoreInitialized: useEtebaseStore.getState().isInitialized,
        })

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
        const classification = await loadItemsIntoStores()

        if (!classification.safeToWireSyncEngine) {
          setSyncStatus('error')
          setInitialSyncState(hasVisibleDomainData() ? 'synced' : 'error')
          setInitialSyncBlocker(null)
          finishInitialSyncProgress()
          setError('Calendar data could not be loaded')
        } else {
          // Start SyncEngine after safe initial enumeration. Internal encrypted
          // metadata warnings must not block visible calendar recovery.
          await useEtebaseStore.getState().startSyncEngine()

          // Wire SyncEngine change events
          unsubChange = wireChangeHandler()

          // Wire SyncEngine status
          unsubStatus = wireStatusHandler()
          logSyncTiming('sync-engine-start', initStartedAt, {
            syncEngineStarted: true,
            changeHandlerWired: Boolean(unsubChange),
            statusHandlerWired: Boolean(unsubStatus),
            visibleWarningCount: classification.visibleWarnings.length,
            internalWarningCount: classification.internalWarnings.length,
          })

          const hasWarnings = classification.visibleWarnings.length > 0 || classification.internalWarnings.length > 0
          setSyncStatus(hasWarnings ? 'error' : 'synced')
          setInitialSyncState(hasVisibleDomainData() ? 'synced' : 'empty')
          setInitialSyncBlocker(null)
          setError(classification.visibleWarnings.length > 0
            ? 'Some synced items could not be loaded'
            : classification.internalWarnings.length > 0
              ? 'Some synced metadata could not be loaded'
              : null)
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
        logSyncTiming('initial-sync-complete', initStartedAt, {
          visibleFatal: classification.visibleFatal,
          visibleWarningCount: classification.visibleWarnings.length,
          internalWarningCount: classification.internalWarnings.length,
          safeToWireSyncEngine: classification.safeToWireSyncEngine,
        })
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

    async function loadItemsIntoStores(): Promise<InitialLoadClassification> {
      const cacheEnabled = isLocalCacheEnabled()
      const domains: InitialDomainLoadResult[] = []

      const addDomain = (result: InitialDomainLoadResult) => {
        domains.push(result)
        logSyncTiming('initial-domain-load', nowMs(), {
          domain: result.domain,
          visibility: result.visibility,
          status: result.status,
          itemCount: result.itemCount,
          decodedCount: result.decodedCount,
          decodeFailureCount: result.decodeFailureCount,
          errorCategory: result.errorCategory ?? null,
        })
      }

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
        let calendarDeserializeErrorCount = 0
        const eventLoad = await etebaseLoadIncrementally('calendar', {
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
              calendarDeserializeErrorCount += errors.length
              if (errors.length > 0) {
                reportSyncError('load calendar event chunk', errors[0])
              }
            }
            updateInitialSyncProgress('calendar', calendarEventCount, undefined, progress.done)
          },
        })
        const decodeFailureCount = eventLoad.decodeFailureCount + calendarDeserializeErrorCount
        const trustworthyCalendar = eventLoad.trustworthyForFullReplacement && calendarDeserializeErrorCount === 0
        if (trustworthyCalendar) {
          useCalendarStore.getState().syncFromRemote(allEvents)
        }
        updateInitialSyncProgress('calendar', calendarEventCount, undefined, true)
        const status = eventLoad.enumerationErrorCount > 0 && allEvents.length === 0
          ? 'degraded'
          : decodeFailureCount > 0 || eventLoad.enumerationErrorCount > 0
            ? 'warning'
            : eventLoad.attemptedCount === 0
              ? 'empty'
              : 'loaded'
        addDomain({
          domain: 'calendar',
          visibility: 'visible',
          status,
          itemCount: eventLoad.attemptedCount,
          decodedCount: allEvents.length,
          decodeFailureCount,
          errorCategory: eventLoad.enumerationErrorCount > 0 ? 'enumeration-failed' : decodeFailureCount > 0 ? 'decode-failed' : undefined,
        })
        logSyncTiming('calendar-fetch', calendarFetchStartedAt, {
          itemCount: eventLoad.attemptedCount,
          decodedItemCount: eventLoad.decodedCount,
          decodeFailureCount,
          enumerationErrorCount: eventLoad.enumerationErrorCount,
          eventCount: allEvents.length,
          trustworthyForFullReplacement: trustworthyCalendar,
        })
        logger.log(`[sync-provider] Loaded ${allEvents.length} calendar events from server`)
        if (trustworthyCalendar) await mirrorToCache('calendar', eventLoad.items)
      } catch (err) {
        reportSyncError('load calendar events', err)
        addDomain({
          domain: 'calendar',
          visibility: 'visible',
          status: 'degraded',
          itemCount: 0,
          decodedCount: 0,
          decodeFailureCount: 0,
          errorCategory: errorCategoryFrom(err),
        })
      }

      // Load tasks
      try {
        setInitialSyncProgressPhase('tasks')
        const taskLoadStartedAt = nowMs()
        const taskLoad = await etebaseLoadIncrementally('tasks')
        const { deserializeTask } = await import('@silentsuite/core')
        const tasks = taskLoad.items.map((item) => {
          const task = deserializeTask(item.content)
          // Use the Etebase item UID only as the local id so updates/deletes
          // can address the item without changing the stable iCalendar UID.
          return { ...task, id: item.uid, listId: item.collectionUid }
        })
        const taskStore = useTaskStore.getState()
        taskStore.syncFromRemote(taskLoad.trustworthyForFullReplacement
          ? tasks
          : mergeById(taskStore.tasks, tasks))
        updateInitialSyncProgress('tasks', tasks.length, undefined, true)
        logger.log(`[sync-provider] Loaded ${tasks.length} tasks from server`)
        logSyncTiming('tasks-load', taskLoadStartedAt, { itemCount: taskLoad.attemptedCount, taskCount: tasks.length, decodeFailureCount: taskLoad.decodeFailureCount, enumerationErrorCount: taskLoad.enumerationErrorCount })
        addDomain({ domain: 'tasks', visibility: 'visible', status: taskLoad.decodeFailureCount || taskLoad.enumerationErrorCount ? 'warning' : taskLoad.attemptedCount === 0 ? 'empty' : 'loaded', itemCount: taskLoad.attemptedCount, decodedCount: tasks.length, decodeFailureCount: taskLoad.decodeFailureCount, errorCategory: taskLoad.enumerationErrorCount ? 'enumeration-failed' : taskLoad.decodeFailureCount ? 'decode-failed' : undefined })
        if (taskLoad.trustworthyForFullReplacement) await mirrorToCache('tasks', taskLoad.items)
      } catch (err) {
        reportSyncError('load tasks', err)
        addDomain({ domain: 'tasks', visibility: 'visible', status: 'warning', itemCount: 0, decodedCount: 0, decodeFailureCount: 0, errorCategory: errorCategoryFrom(err) })
      }

      // Load contacts
      try {
        setInitialSyncProgressPhase('contacts')
        const contactLoadStartedAt = nowMs()
        const contactLoad = await etebaseLoadIncrementally('contacts')
        const { deserializeContact } = await import('@silentsuite/core')
        const contacts = contactLoad.items.map((item) => {
          const contact = deserializeContact(item.content)
          return { ...contact, id: item.uid, listId: item.collectionUid }
        })
        const contactStore = useContactStore.getState()
        contactStore.syncFromRemote(contactLoad.trustworthyForFullReplacement
          ? contacts
          : mergeById(contactStore.contacts, contacts))
        updateInitialSyncProgress('contacts', contacts.length, undefined, true)
        logger.log(`[sync-provider] Loaded ${contacts.length} contacts from server`)
        logSyncTiming('contacts-load', contactLoadStartedAt, { itemCount: contactLoad.attemptedCount, contactCount: contacts.length, decodeFailureCount: contactLoad.decodeFailureCount, enumerationErrorCount: contactLoad.enumerationErrorCount })
        addDomain({ domain: 'contacts', visibility: 'visible', status: contactLoad.decodeFailureCount || contactLoad.enumerationErrorCount ? 'warning' : contactLoad.attemptedCount === 0 ? 'empty' : 'loaded', itemCount: contactLoad.attemptedCount, decodedCount: contacts.length, decodeFailureCount: contactLoad.decodeFailureCount, errorCategory: contactLoad.enumerationErrorCount ? 'enumeration-failed' : contactLoad.decodeFailureCount ? 'decode-failed' : undefined })
        if (contactLoad.trustworthyForFullReplacement) await mirrorToCache('contacts', contactLoad.items)
      } catch (err) {
        reportSyncError('load contacts', err)
        addDomain({ domain: 'contacts', visibility: 'visible', status: 'warning', itemCount: 0, decodedCount: 0, decodeFailureCount: 0, errorCategory: errorCategoryFrom(err) })
      }

      // Load non-visible encrypted collections into itemCache before their
      // stores initialize through fetchAllItems().
      setInitialSyncProgressPhase('preferences')
      try {
        const preferencesLoad = await etebaseLoadIncrementally('preferences')
        addDomain({ domain: 'preferences', visibility: 'internal', status: preferencesLoad.decodeFailureCount || preferencesLoad.enumerationErrorCount ? 'warning' : preferencesLoad.attemptedCount === 0 ? 'empty' : 'loaded', itemCount: preferencesLoad.attemptedCount, decodedCount: preferencesLoad.decodedCount, decodeFailureCount: preferencesLoad.decodeFailureCount, errorCategory: preferencesLoad.enumerationErrorCount ? 'enumeration-failed' : preferencesLoad.decodeFailureCount ? 'decode-failed' : undefined })
      } catch (err) {
        reportSyncError('load preferences items', err)
        addDomain({ domain: 'preferences', visibility: 'internal', status: 'warning', itemCount: 0, decodedCount: 0, decodeFailureCount: 0, errorCategory: errorCategoryFrom(err) })
      }
      try {
        const labelIndexLoad = await etebaseLoadIncrementally('labelIndex')
        addDomain({ domain: 'labelIndex', visibility: 'internal', status: labelIndexLoad.decodeFailureCount || labelIndexLoad.enumerationErrorCount ? 'warning' : labelIndexLoad.attemptedCount === 0 ? 'empty' : 'loaded', itemCount: labelIndexLoad.attemptedCount, decodedCount: labelIndexLoad.decodedCount, decodeFailureCount: labelIndexLoad.decodeFailureCount, errorCategory: labelIndexLoad.enumerationErrorCount ? 'enumeration-failed' : labelIndexLoad.decodeFailureCount ? 'decode-failed' : undefined })
      } catch (err) {
        reportSyncError('load label suggestion items', err)
        addDomain({ domain: 'labelIndex', visibility: 'internal', status: 'warning', itemCount: 0, decodedCount: 0, decodeFailureCount: 0, errorCategory: errorCategoryFrom(err) })
      }

      beginPassiveStartupToastCycle()
      try {
        const preferencesStartedAt = nowMs()
        await usePreferencesSyncStore.getState().initialize()
        logSyncTiming('preferences-initialize', preferencesStartedAt, { createOrUpdateAttempted: true })
      } catch (err) {
        reportSyncError('initialize preferences sync', err)
        addDomain({ domain: 'preferences', visibility: 'internal', status: 'warning', itemCount: 0, decodedCount: 0, decodeFailureCount: 0, errorCategory: errorCategoryFrom(err) })
      }

      try {
        const labelIndexStartedAt = nowMs()
        await useLabelSuggestionsStore.getState().initialize()
        logSyncTiming('label-index-initialize', labelIndexStartedAt, { createOrUpdateAttempted: true })
      } catch (err) {
        reportSyncError('initialize label suggestions', err)
        addDomain({ domain: 'labelIndex', visibility: 'internal', status: 'warning', itemCount: 0, decodedCount: 0, decodeFailureCount: 0, errorCategory: errorCategoryFrom(err) })
      } finally {
        endPassiveStartupToastCycle()
      }

      const visibleFatal = domains.some((domain) => domain.visibility === 'visible' && domain.status === 'failed')
      const visibleWarnings = domains.filter((domain) => domain.visibility === 'visible' && (domain.status === 'warning' || domain.status === 'degraded'))
      const internalWarnings = domains.filter((domain) => domain.visibility === 'internal' && (domain.status === 'warning' || domain.status === 'failed'))
      const classification: InitialLoadClassification = {
        accountRestored: true,
        domains,
        visibleFatal,
        visibleWarnings,
        internalWarnings,
        safeToWireSyncEngine: shouldWireSyncEngine({ visibleFatal }),
      }
      logSyncTiming('initial-load-classification', nowMs(), {
        domainCount: domains.length,
        visibleFatal,
        visibleWarningCount: visibleWarnings.length,
        internalWarningCount: internalWarnings.length,
        safeToWireSyncEngine: classification.safeToWireSyncEngine,
      })
      return classification
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
