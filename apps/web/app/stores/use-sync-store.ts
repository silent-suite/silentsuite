'use client'

import { create } from 'zustand'
import type { SyncStatus } from '@silentsuite/core'
import { replay, getPendingCount, onCountChange, type QueueEntry } from '@/app/lib/offline-queue'

interface SyncState {
  syncStatus: SyncStatus
  lastSyncedAt: Date | null
  isOnline: boolean
  error: string | null
  pendingQueueCount: number
}

interface SyncActions {
  setSyncStatus: (status: SyncStatus) => void
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
  syncStatus: 'synced',
  lastSyncedAt: null,
  isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  error: null,
  pendingQueueCount: 0,

  setSyncStatus: (status) => set({ syncStatus: status }),
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

    // Subscribe to queue count changes
    const unsubQueue = onCountChange((count) => {
      set({ pendingQueueCount: count })
    })

    // Load initial queue count
    getPendingCount().then((count) => set({ pendingQueueCount: count }))

    // Set initial state
    if (navigator.onLine) {
      set({ isOnline: true })
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

    console.log(`[sync-store] Replaying ${count} queued offline mutations...`)

    const executeMutation = async (entry: QueueEntry): Promise<{ itemUid?: string }> => {
      const { useEtebaseStore } = await import('@/app/stores/use-etebase-store')
      const etebase = useEtebaseStore.getState()
      if (!etebase.account) throw new Error('No Etebase account')

      switch (entry.type) {
        case 'create': {
          const uid = await etebase.createItem(entry.collectionType, entry.content!)
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
      }
    }

    const results = await replay(executeMutation)

    // Replace tempIds in domain stores for successful creates
    for (const result of results) {
      if (!result.success || result.entry.type !== 'create' || !result.itemUid) continue

      const { collectionType, tempId } = result.entry
      if (!tempId) continue

      if (collectionType === 'tasks') {
        const { useTaskStore } = await import('@/app/stores/use-task-store')
        useTaskStore.getState().syncFromRemote(
          useTaskStore.getState().tasks.map((t) =>
            t.id === tempId ? { ...t, id: result.itemUid!, uid: result.itemUid! } : t,
          ),
        )
      } else if (collectionType === 'contacts') {
        const { useContactStore } = await import('@/app/stores/use-contact-store')
        useContactStore.getState().syncFromRemote(
          useContactStore.getState().contacts.map((c) =>
            c.id === tempId ? { ...c, id: result.itemUid!, uid: result.itemUid! } : c,
          ),
        )
      } else if (collectionType === 'calendar') {
        const { useCalendarStore } = await import('@/app/stores/use-calendar-store')
        useCalendarStore.getState().syncFromRemote(
          useCalendarStore.getState().events.map((e) =>
            e.id === tempId ? { ...e, id: result.itemUid!, uid: result.itemUid! } : e,
          ),
        )
      }
    }

    const succeeded = results.filter((r) => r.success).length
    const failed = results.filter((r) => !r.success).length
    console.log(`[sync-store] Queue replay done: ${succeeded} succeeded, ${failed} failed`)
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

      // First, run the SyncEngine poll to advance stokens
      if (etebase.syncEngine) {
        try { await etebase.syncEngine.syncNow() } catch {}
      }

      // Then refresh all three collections from the server
      const [taskItems, contactItems, eventItems] = await Promise.all([
        etebase.refreshCollection('tasks'),
        etebase.refreshCollection('contacts'),
        etebase.refreshCollection('calendar'),
      ])

      // Push fresh data into stores
      const { useTaskStore } = await import('@/app/stores/use-task-store')
      const { useContactStore } = await import('@/app/stores/use-contact-store')
      const { useCalendarStore } = await import('@/app/stores/use-calendar-store')

      if (taskItems.length > 0) {
        const tasks = taskItems.map((item) => {
          const task = core.deserializeTask(item.content)
          return { ...task, id: item.uid, uid: item.uid }
        })
        useTaskStore.getState().syncFromRemote(tasks)
      }

      if (contactItems.length > 0) {
        const contacts = contactItems.map((item) => {
          const contact = core.deserializeContact(item.content)
          return { ...contact, id: item.uid, uid: item.uid }
        })
        useContactStore.getState().syncFromRemote(contacts)
      }

      if (eventItems.length > 0) {
        const events = eventItems.map((item) => {
          const event = core.deserializeCalendarEvent(item.content)
          return { ...event, id: item.uid, uid: item.uid }
        })
        useCalendarStore.getState().syncFromRemote(events)
      }

      set({ syncStatus: 'synced', lastSyncedAt: new Date(), error: null })
    }).catch((err) => {
      console.error('[sync-store] Manual sync failed:', err)
      set({ syncStatus: 'error', error: 'Sync failed' })
    })
  },
}))
