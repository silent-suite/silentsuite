'use client'

import { create } from 'zustand'
import type { SyncStatus } from '@silentsuite/core'
import { replay, getPendingCount, getFailedCount, onCountChange, type ConfirmedRemoteMutation, type QueueEntry, type OfflineQueueAccountGuard, type ReplayCheckpoint } from '@/app/lib/offline-queue'
import { getSafeErrorDetails } from '@/app/lib/privacy-safe-errors'
import { showErrorToast } from '@/app/stores/use-toast-store'
import { logger } from '@/app/lib/logger'
import { AccountBoundaryChangedError, assertCurrentAccountEpoch, getAccountEpoch } from '@/app/lib/account-epoch'

async function captureQueueGuard(): Promise<OfflineQueueAccountGuard> {
  const accountEpoch = getAccountEpoch()
  const { useEtebaseStore } = await import('@/app/stores/use-etebase-store')
  assertCurrentAccountEpoch(accountEpoch)
  const { account, accountFingerprint } = useEtebaseStore.getState()
  if (!account || !accountFingerprint) throw new AccountBoundaryChangedError()
  return { accountEpoch, accountFingerprint }
}

async function readQueueCounts(guard: OfflineQueueAccountGuard) {
  const [pendingQueueCount, failedQueueCount] = await Promise.all([
    getPendingCount(guard), getFailedCount(guard),
  ])
  assertCurrentAccountEpoch(guard.accountEpoch)
  return { pendingQueueCount, failedQueueCount }
}

interface SyncState {
  syncStatus: SyncStatus
  lastSyncedAt: Date | null
  isOnline: boolean
  error: string | null
  pendingQueueCount: number
  failedQueueCount: number
  partialLoad: boolean
  partialLoadDomainCount: number
}

interface SyncActions {
  setSyncStatus: (status: SyncStatus) => void
  setLastSynced: (date: Date) => void
  setOnline: (online: boolean) => void
  setError: (error: string | null) => void
  setPartialLoad: (partial: boolean, domainCount?: number) => void
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
  syncStatus: 'synced',
  lastSyncedAt: null,
  isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  error: null,
  pendingQueueCount: 0,
  failedQueueCount: 0,
  partialLoad: false,
  partialLoadDomainCount: 0,

  setSyncStatus: (status) => set({ syncStatus: status }),
  setLastSynced: (date) => set({ lastSyncedAt: date }),
  setOnline: (online) => set({ isOnline: online }),
  setError: (error) => set({ error }),
  setPartialLoad: (partial, domainCount = 0) => set({ partialLoad: partial, partialLoadDomainCount: partial ? domainCount : 0 }),

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

    // Subscribe to queue changes and refresh counts for the active account only.
    const refreshCounts = async () => {
      try {
        const guard = await captureQueueGuard()
        const counts = await readQueueCounts(guard)
        assertCurrentAccountEpoch(guard.accountEpoch)
        set(counts)
      } catch (err) {
        if (!(err instanceof AccountBoundaryChangedError)) logger.warn('[sync-store] Failed to refresh queue counts', getSafeErrorDetails(err))
      }
    }
    const unsubQueue = onCountChange(() => { void refreshCounts() })

    void refreshCounts()

    // Set initial state
    if (navigator.onLine) {
      set({ isOnline: true })
      captureQueueGuard().then(async (guard) => {
        const count = await getPendingCount(guard)
        assertCurrentAccountEpoch(guard.accountEpoch)
        if (count > 0) {
          logger.log(`[sync-store] Cold-start: replaying ${count} queued mutations`)
          await get().replayOfflineQueue()
        }
      }).catch((err) => {
        if (!(err instanceof AccountBoundaryChangedError)) logger.warn('[sync-store] Cold-start replay check failed', getSafeErrorDetails(err))
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
    try {
    const guard = await captureQueueGuard()
    const count = await getPendingCount(guard)
    assertCurrentAccountEpoch(guard.accountEpoch)
    if (count === 0) return

    logger.log(`[sync-store] Replaying ${count} queued offline mutations...`)

    const executeMutation = async (entry: QueueEntry, checkpoint: ReplayCheckpoint): Promise<ConfirmedRemoteMutation> => {
      const { useEtebaseStore } = await import('@/app/stores/use-etebase-store')
      assertCurrentAccountEpoch(guard.accountEpoch)
      const etebase = useEtebaseStore.getState()
      if (!etebase.account || etebase.accountFingerprint !== guard.accountFingerprint) throw new AccountBoundaryChangedError()
      return etebase.replayQueuedMutation(entry, guard, checkpoint)
    }

    const results = await replay(executeMutation, guard)
    assertCurrentAccountEpoch(guard.accountEpoch)

    // Replace tempIds in domain stores for successful creates, and old item IDs
    // for successful collection moves that recreate the Etebase item.
    for (const result of results) {
      assertCurrentAccountEpoch(guard.accountEpoch)
      if (!result.success || !result.itemUid) continue

      const { collectionType } = result.entry
      const oldId = result.entry.type === 'create' ? result.entry.tempId : result.entry.type === 'move' ? result.entry.itemUid : undefined
      const targetCollectionUid = result.entry.type === 'move' ? result.entry.targetCollectionUid : undefined
      if (!oldId) continue

      if (collectionType === 'tasks') {
        const { useTaskStore } = await import('@/app/stores/use-task-store')
        assertCurrentAccountEpoch(guard.accountEpoch)
        useTaskStore.getState().syncFromRemote(
          useTaskStore.getState().tasks.map((t) =>
            t.id === oldId ? { ...t, id: result.itemUid!, listId: targetCollectionUid ?? t.listId } : t,
          ),
        )
      } else if (collectionType === 'contacts') {
        const { useContactStore } = await import('@/app/stores/use-contact-store')
        assertCurrentAccountEpoch(guard.accountEpoch)
        useContactStore.getState().syncFromRemote(
          useContactStore.getState().contacts.map((c) =>
            c.id === oldId ? { ...c, id: result.itemUid!, listId: targetCollectionUid ?? c.listId } : c,
          ),
        )
      } else if (collectionType === 'calendar') {
        const { useCalendarStore } = await import('@/app/stores/use-calendar-store')
        assertCurrentAccountEpoch(guard.accountEpoch)
        useCalendarStore.getState().syncFromRemote(
          useCalendarStore.getState().events.map((e) =>
            e.id === oldId ? { ...e, id: result.itemUid!, calendarId: targetCollectionUid ?? e.calendarId } : e,
          ),
        )
      }
    }

    assertCurrentAccountEpoch(guard.accountEpoch)
    const succeeded = results.filter((r) => r.success).length
    const failed = results.filter((r) => !r.success).length
    logger.log(`[sync-store] Queue replay done: ${succeeded} succeeded, ${failed} failed`)
    } catch (err) {
      if (err instanceof AccountBoundaryChangedError) return
      throw err
    }
  },

  simulateSyncCycle: () => {
    const accountEpoch = getAccountEpoch()
    const { isOnline } = get()
    if (!isOnline) return

    set({ syncStatus: 'syncing' })

    // Full refresh: re-fetch all collections from the server and update stores
    Promise.all([
      import('@/app/stores/use-etebase-store'),
      import('@silentsuite/core'),
    ]).then(async ([{ useEtebaseStore }, core]) => {
      assertCurrentAccountEpoch(accountEpoch)
      const etebase = useEtebaseStore.getState()
      const accountFingerprint = etebase.accountFingerprint
      if (!etebase.account || !accountFingerprint) throw new AccountBoundaryChangedError()
      const guard = { accountEpoch, accountFingerprint }

      // First reconcile collection membership so manual sync notices calendars,
      // task lists, or address books deleted or created on another device.
      await etebase.reconcileCollections()
      assertCurrentAccountEpoch(accountEpoch)
      const reconciledEtebase = useEtebaseStore.getState()
      if (reconciledEtebase.accountFingerprint !== accountFingerprint) throw new AccountBoundaryChangedError()

      // Then run the SyncEngine poll to advance stokens for active collections.
      if (reconciledEtebase.syncEngine) {
        try { await reconciledEtebase.syncEngine.syncNow() } catch (err) {
          assertCurrentAccountEpoch(accountEpoch)
          logger.error('SyncStore', 'SyncEngine.syncNow() failed', err)
          set({ syncStatus: 'error' })
        }
        assertCurrentAccountEpoch(accountEpoch)
      }

      // Then refresh every collection of each type from the server
      const [taskItems, contactItems, eventItems] = await Promise.all([
        reconciledEtebase.refreshCollection('tasks'),
        reconciledEtebase.refreshCollection('contacts'),
        reconciledEtebase.refreshCollection('calendar'),
      ])
      assertCurrentAccountEpoch(accountEpoch)

      // Push fresh data into stores
      const { useTaskStore } = await import('@/app/stores/use-task-store')
      const { useContactStore } = await import('@/app/stores/use-contact-store')
      const { useCalendarStore } = await import('@/app/stores/use-calendar-store')
      const { usePreferencesSyncStore } = await import('@/app/stores/use-preferences-sync-store')
      assertCurrentAccountEpoch(accountEpoch)

      const refreshedEtebase = useEtebaseStore.getState()
      const domainLoadState = refreshedEtebase.domainLoadState
      let partialDomainCount = 0

      const tasks = taskItems.map((item) => {
        const task = core.deserializeTask(item.content)
        return { ...task, id: item.uid, listId: item.collectionUid }
      })
      if (domainLoadState.tasks === 'loaded') {
        assertCurrentAccountEpoch(accountEpoch)
        useTaskStore.getState().syncFromRemote(tasks)
      } else {
        partialDomainCount += 1
      }

      const contacts = contactItems.map((item) => {
        const contact = core.deserializeContact(item.content)
        return { ...contact, id: item.uid, listId: item.collectionUid }
      })
      if (domainLoadState.contacts === 'loaded') {
        assertCurrentAccountEpoch(accountEpoch)
        useContactStore.getState().syncFromRemote(contacts)
      } else {
        partialDomainCount += 1
      }

      const events = eventItems.map((item) => {
        const event = core.deserializeCalendarEvent(item.content)
        return { ...event, id: item.uid, calendarId: item.collectionUid }
      })
      if (domainLoadState.calendar === 'loaded') {
        assertCurrentAccountEpoch(accountEpoch)
        useCalendarStore.getState().syncFromRemote(events)
      } else {
        partialDomainCount += 1
      }

      try {
        await usePreferencesSyncStore.getState().loadFromRemote()
        assertCurrentAccountEpoch(accountEpoch)
      } catch (err) {
        assertCurrentAccountEpoch(accountEpoch)
        logger.warn('[sync-store] Preferences refresh failed during sync cycle', getSafeErrorDetails(err))
      }

      // Refresh counts to ensure UI is accurate after sync
      const { pendingQueueCount: pc, failedQueueCount: fc } = await readQueueCounts(guard)
      assertCurrentAccountEpoch(guard.accountEpoch)
      set({
        syncStatus: 'synced',
        lastSyncedAt: new Date(),
        error: null,
        pendingQueueCount: pc,
        failedQueueCount: fc,
        partialLoad: partialDomainCount > 0,
        partialLoadDomainCount: partialDomainCount,
      })
    }).catch((err) => {
      if (err instanceof AccountBoundaryChangedError) return
      try { assertCurrentAccountEpoch(accountEpoch) } catch { return }
      console.error('[sync-store] Manual sync failed', getSafeErrorDetails(err))
      set({ syncStatus: 'error', error: 'Sync failed' })
      const isOnline = get().isOnline
      showErrorToast(isOnline ? 'Sync failed. Check your connection.' : 'Sync failed. Retrying...')
    })
  },
}))
