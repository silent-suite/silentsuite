'use client'

import { create } from 'zustand'
import type { SyncStatus } from '@silentsuite/core'
import { replay, getPendingCount, getFailedCount, onCountChange, getStaleEntries, remove, type QueueEntry } from '@/app/lib/offline-queue'
import { getSafeErrorDetails } from '@/app/lib/privacy-safe-errors'
import { showErrorToast } from '@/app/stores/use-toast-store'
import { logger } from '@/app/lib/logger'

export type InitialSyncState = 'idle' | 'restoring' | 'hydrated-cache' | 'syncing' | 'synced' | 'empty' | 'offline' | 'error' | 'no-session'
export type InitialSyncBlocker = null | 'missing-encrypted-session' | 'encrypted-session-restore-failed'
export type InitialSyncDomain = 'calendar' | 'tasks' | 'contacts'
export type InitialSyncProgressPhase = 'idle' | 'restoring' | 'calendar' | 'tasks' | 'contacts' | 'preferences' | 'complete' | 'blocked' | 'error'

export interface DomainSyncProgress {
  loaded: number
  knownTotal: number | null
  done: boolean
}

export interface InitialSyncProgressState {
  active: boolean
  phase: InitialSyncProgressPhase
  calendar: DomainSyncProgress
  tasks: DomainSyncProgress
  contacts: DomainSyncProgress
  message: string | null
}

export type InitialSyncKnownTotals = Partial<Record<InitialSyncDomain, number | null>>

const emptyDomainProgress: DomainSyncProgress = { loaded: 0, knownTotal: null, done: false }

export function createInitialSyncProgressState(): InitialSyncProgressState {
  return {
    active: false,
    phase: 'idle',
    calendar: { ...emptyDomainProgress },
    tasks: { ...emptyDomainProgress },
    contacts: { ...emptyDomainProgress },
    message: null,
  }
}

interface SyncState {
  syncStatus: SyncStatus
  initialSyncState: InitialSyncState
  initialSyncBlocker: InitialSyncBlocker
  initialSyncProgress: InitialSyncProgressState
  lastSyncedAt: Date | null
  isOnline: boolean
  error: string | null
  pendingQueueCount: number
  failedQueueCount: number
}

interface SyncActions {
  setSyncStatus: (status: SyncStatus) => void
  setInitialSyncState: (state: InitialSyncState) => void
  setInitialSyncBlocker: (blocker: InitialSyncBlocker) => void
  startInitialSyncProgress: (knownTotals?: InitialSyncKnownTotals) => void
  setInitialSyncProgressPhase: (phase: InitialSyncProgressPhase, message?: string | null) => void
  updateInitialSyncProgress: (domain: InitialSyncDomain, loaded: number, knownTotal?: number | null, done?: boolean) => void
  finishInitialSyncProgress: () => void
  resetInitialSyncProgress: () => void
  setLastSynced: (date: Date) => void
  setOnline: (online: boolean) => void
  setError: (error: string | null) => void
  initializeSync: () => () => void
  /**
   * Trigger a real sync cycle via the SyncEngine.
   * Falls back to a brief visual indicator if no SyncEngine is available.
   */
  simulateSyncCycle: () => void
  /** Replay queued offline mutations before syncing */
  replayOfflineQueue: () => Promise<void>
}

export const useSyncStore = create<SyncState & SyncActions>((set, get) => ({
  syncStatus: 'syncing',
  initialSyncState: 'idle',
  initialSyncBlocker: null,
  initialSyncProgress: createInitialSyncProgressState(),
  lastSyncedAt: null,
  isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  error: null,
  pendingQueueCount: 0,
  failedQueueCount: 0,

  setSyncStatus: (status) => set({ syncStatus: status }),
  setInitialSyncState: (initialSyncState) => set({ initialSyncState }),
  setInitialSyncBlocker: (initialSyncBlocker) => set({ initialSyncBlocker }),
  startInitialSyncProgress: (knownTotals = {}) => set({
    initialSyncProgress: {
      active: true,
      phase: 'restoring',
      calendar: { loaded: 0, knownTotal: knownTotals.calendar ?? null, done: false },
      tasks: { loaded: 0, knownTotal: knownTotals.tasks ?? null, done: false },
      contacts: { loaded: 0, knownTotal: knownTotals.contacts ?? null, done: false },
      message: null,
    },
  }),
  setInitialSyncProgressPhase: (phase, message = null) => set((state) => ({
    initialSyncProgress: { ...state.initialSyncProgress, active: phase !== 'idle' && phase !== 'complete', phase, message },
  })),
  updateInitialSyncProgress: (domain, loaded, knownTotal, done) => set((state) => ({
    initialSyncProgress: {
      ...state.initialSyncProgress,
      [domain]: {
        ...state.initialSyncProgress[domain],
        loaded: Math.max(0, loaded),
        knownTotal: knownTotal === undefined ? state.initialSyncProgress[domain].knownTotal : knownTotal,
        done: done ?? state.initialSyncProgress[domain].done,
      },
    },
  })),
  finishInitialSyncProgress: () => set((state) => ({
    initialSyncProgress: {
      ...state.initialSyncProgress,
      active: false,
      phase: 'complete',
      calendar: { ...state.initialSyncProgress.calendar, done: true },
      tasks: { ...state.initialSyncProgress.tasks, done: true },
      contacts: { ...state.initialSyncProgress.contacts, done: true },
      message: null,
    },
  })),
  resetInitialSyncProgress: () => set({ initialSyncProgress: createInitialSyncProgressState() }),
  setLastSynced: (date) => set({ lastSyncedAt: date }),
  setOnline: (online) => set({ isOnline: online }),
  setError: (error) => set({ error }),

  initializeSync: () => {
    const handleOnline = async () => {
      set({ isOnline: true })
      // Replay offline queue before regular sync
      await get().replayOfflineQueue()
      get().simulateSyncCycle()
    }

    const handleOffline = () => {
      set({ isOnline: false, syncStatus: 'offline', error: null })
    }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    // Subscribe to queue count changes (update both pending and failed)
    const unsubQueue = onCountChange((count) => {
      set({ pendingQueueCount: count })
      // Also refresh failed count when queue changes
      getFailedCount().then((fc) => set({ failedQueueCount: fc }))
    })

    // Load initial queue counts
    getPendingCount().then((count) => set({ pendingQueueCount: count }))
    getFailedCount().then((count) => set({ failedQueueCount: count }))

    // Set initial state
    if (navigator.onLine) {
      set({ isOnline: true })
      // Cold-start replay: if we load online with pending entries, replay them
      getPendingCount().then(async (count) => {
        if (count > 0) {
          logger.log(`[sync-store] Cold-start: replaying ${count} queued mutations`)
          await get().replayOfflineQueue()
        }
      })
    } else {
      set({ syncStatus: 'offline', isOnline: false })
    }

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      unsubQueue()
    }
  },

  replayOfflineQueue: async () => {
    const count = await getPendingCount()
    if (count === 0) return

    logger.log(`[sync-store] Replaying ${count} queued offline mutations...`)

    const executeMutation = async (entry: QueueEntry): Promise<{ itemUid?: string }> => {
      const { useEtebaseStore } = await import('@/app/stores/use-etebase-store')
      const etebase = useEtebaseStore.getState()
      if (!etebase.account) throw new Error('No Etebase account')

      try {
        switch (entry.type) {
          case 'create': {
            const uid = await etebase.createItem(entry.collectionType, entry.content!, entry.tempId, entry.collectionUid)
            return { itemUid: uid ?? undefined }
          }
          case 'update': {
            await etebase.updateItem(entry.collectionType, entry.itemUid!, entry.content!)
            return {}
          }
          case 'delete': {
            await etebase.deleteItem(entry.collectionType, entry.itemUid!)
            return {}
          }
          case 'move': {
            if (!entry.targetCollectionUid) throw new Error('Missing move target collection')
            const uid = await etebase.moveItem(entry.collectionType, entry.itemUid!, entry.content!, entry.targetCollectionUid, entry.collectionUid)
            if (!uid) throw new Error('Move did not return item UID')
            return { itemUid: uid }
          }
        }
      } catch (err) {
        // Handle 409 Conflict (ETag mismatch) — server-wins strategy
        const is409 = err instanceof Error && (
          err.message.includes('409') ||
          err.message.includes('conflict') ||
          err.message.includes('Conflict')
        )
        if (is409 && entry.type !== 'create') {
          logger.warn(
            `[sync-store] Conflict on ${entry.type} ${entry.collectionType}/${entry.itemUid} — discarding local change (server wins)`,
          )
          // Refresh the collection to get server's version
          await etebase.refreshCollection(entry.collectionType, entry.collectionUid)
          if (entry.type === 'move' && entry.targetCollectionUid && entry.targetCollectionUid !== entry.collectionUid) {
            await etebase.refreshCollection(entry.collectionType, entry.targetCollectionUid)
          }
          // Return success so the entry is removed from queue
          return {}
        }
        throw err
      }
    }

    const results = await replay(executeMutation)

    // Replace tempIds in domain stores for successful creates, and old item IDs
    // for successful collection moves that recreate the Etebase item.
    for (const result of results) {
      if (!result.success || !result.itemUid) continue

      const { collectionType } = result.entry
      const oldId = result.entry.type === 'create' ? result.entry.tempId : result.entry.type === 'move' ? result.entry.itemUid : undefined
      const targetCollectionUid = result.entry.type === 'move' ? result.entry.targetCollectionUid : undefined
      if (!oldId) continue

      if (collectionType === 'tasks') {
        const { useTaskStore } = await import('@/app/stores/use-task-store')
        useTaskStore.getState().syncFromRemote(
          useTaskStore.getState().tasks.map((t) =>
            t.id === oldId ? { ...t, id: result.itemUid!, listId: targetCollectionUid ?? t.listId } : t,
          ),
        )
      } else if (collectionType === 'contacts') {
        const { useContactStore } = await import('@/app/stores/use-contact-store')
        useContactStore.getState().syncFromRemote(
          useContactStore.getState().contacts.map((c) =>
            c.id === oldId ? { ...c, id: result.itemUid!, listId: targetCollectionUid ?? c.listId } : c,
          ),
        )
      } else if (collectionType === 'calendar') {
        const { useCalendarStore } = await import('@/app/stores/use-calendar-store')
        useCalendarStore.getState().syncFromRemote(
          useCalendarStore.getState().events.map((e) =>
            e.id === oldId ? { ...e, id: result.itemUid!, calendarId: targetCollectionUid ?? e.calendarId } : e,
          ),
        )
      } else if (collectionType === 'preferences' && result.entry.type === 'create') {
        const { usePreferencesSyncStore } = await import('@/app/stores/use-preferences-sync-store')
        usePreferencesSyncStore.getState().setRemoteItemUid(result.itemUid)
      }
    }

    const succeeded = results.filter((r) => r.success).length
    const failed = results.filter((r) => !r.success).length
    logger.log(`[sync-store] Queue replay done: ${succeeded} succeeded, ${failed} failed`)
  },

  simulateSyncCycle: () => {
    const { isOnline } = get()
    if (!isOnline) return

    set({ syncStatus: 'syncing' })

    // Full refresh: re-fetch all collections from the server and update stores
    Promise.all([
      import('@/app/stores/use-etebase-store'),
      import('@silentsuite/core'),
    ]).then(async ([{ useEtebaseStore }, core]) => {
      const etebase = useEtebaseStore.getState()

      // First reconcile collection membership so manual sync notices calendars,
      // task lists, or address books deleted or created on another device.
      await etebase.reconcileCollections()
      const reconciledEtebase = useEtebaseStore.getState()

      // Then run the SyncEngine poll to advance stokens for active collections.
      if (reconciledEtebase.syncEngine) {
        try { await reconciledEtebase.syncEngine.syncNow() } catch (err) {
          logger.error('SyncStore', 'SyncEngine.syncNow() failed', err)
          set({ syncStatus: 'error' })
        }
      }

      // Then refresh every collection of each type from the server
      const [taskItems, contactItems, eventItems, preferenceItems, labelIndexItems] = await Promise.all([
        reconciledEtebase.refreshCollection('tasks'),
        reconciledEtebase.refreshCollection('contacts'),
        reconciledEtebase.refreshCollection('calendar'),
        reconciledEtebase.refreshCollection('preferences'),
        reconciledEtebase.refreshCollection('labelIndex'),
      ])

      // Push fresh data into stores
      const { useTaskStore } = await import('@/app/stores/use-task-store')
      const { useContactStore } = await import('@/app/stores/use-contact-store')
      const { useCalendarStore } = await import('@/app/stores/use-calendar-store')
      const { usePreferencesSyncStore } = await import('@/app/stores/use-preferences-sync-store')
      const { useLabelSuggestionsStore } = await import('@/app/stores/use-label-suggestions-store')

      const tasks = taskItems.map((item) => {
        const task = core.deserializeTask(item.content)
        return { ...task, id: item.uid, listId: item.collectionUid }
      })
      useTaskStore.getState().syncFromRemote(tasks)

      const contacts = contactItems.map((item) => {
        const contact = core.deserializeContact(item.content)
        return { ...contact, id: item.uid, listId: item.collectionUid }
      })
      useContactStore.getState().syncFromRemote(contacts)

      const events = eventItems.map((item) => {
        const event = core.deserializeCalendarEvent(item.content)
        return { ...event, id: item.uid, calendarId: item.collectionUid }
      })
      useCalendarStore.getState().syncFromRemote(events)
      await usePreferencesSyncStore.getState().loadFromRemote(preferenceItems)
      await useLabelSuggestionsStore.getState().loadFromRemote(labelIndexItems)

      // Purge stale queue entries (older than 24h) that may cause phantom indicators
      const stale = await getStaleEntries()
      for (const entry of stale) {
        await remove(entry.id)
      }

      // Refresh counts to ensure UI is accurate after sync
      const pc = await getPendingCount()
      const fc = await getFailedCount()
      set({ syncStatus: 'synced', initialSyncState: 'synced', initialSyncBlocker: null, lastSyncedAt: new Date(), error: null, pendingQueueCount: pc, failedQueueCount: fc })
    }).catch((err) => {
      console.error('[sync-store] Manual sync failed', getSafeErrorDetails(err))
      set({ syncStatus: 'error', error: 'Sync failed' })
      const isOnline = get().isOnline
      showErrorToast(isOnline ? 'Sync failed. Check your connection.' : 'Sync failed. Retrying...')
    })
  },
}))
