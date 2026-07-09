'use client'

import { create } from 'zustand'
import { logger } from '@/app/lib/logger'
import { getSafeErrorDetails } from '@/app/lib/privacy-safe-errors'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useCalendarStore } from '@/app/stores/use-calendar-store'
import { useTaskStore } from '@/app/stores/use-task-store'
import { useContactStore } from '@/app/stores/use-contact-store'
import type { LabelIndexSource, SyncedLabelIndexV1 } from '@silentsuite/core'
import {
  COLLECTION_TYPE_LABEL_INDEX,
  createEmptyLabelIndex,
  deserializeLabelIndex,
  mergeLabelIndexes,
  recordLabelsUsed,
  serializeLabelIndex,
  suggestLabels,
} from '@silentsuite/core'

const LABEL_INDEX_COLLECTION_NAME = 'Label Suggestions'

type SourceItems = {
  calendar?: Array<{ categories?: string[] }>
  tasks?: Array<{ categories?: string[] }>
  contacts?: Array<{ categories?: string[] }>
}

interface LabelSuggestionsState {
  index: SyncedLabelIndexV1
  isLoaded: boolean
  lastError: string | null
  remoteCollection: any | null
  remoteItem: any | null
}

interface LabelSuggestionsActions {
  initialize: () => Promise<void>
  refreshFromRemote: () => Promise<void>
  seedFromVisibleItems: (items?: SourceItems) => void
  suggestions: (query?: string, existingLabels?: string[], limit?: number) => string[]
  recordUsage: (source: LabelIndexSource, labels: string[]) => Promise<void>
  reset: () => void
}

function applyVisibleItems(index: SyncedLabelIndexV1, items: SourceItems, now = new Date()): SyncedLabelIndexV1 {
  let next = index
  for (const labelSource of ['calendar', 'tasks', 'contacts'] as const) {
    for (const item of items[labelSource] ?? []) {
      if (item.categories && item.categories.length > 0) {
        next = recordLabelsUsed(next, labelSource, item.categories, now)
      }
    }
  }
  return next
}

function itemContentToString(content: string | Uint8Array): string {
  return typeof content === 'string' ? content : new TextDecoder().decode(content)
}

async function readRemoteIndex(account: any, collection: any): Promise<{ index: SyncedLabelIndexV1; item: any | null }> {
  const core = await import('@silentsuite/core')
  let merged = createEmptyLabelIndex()
  let newestItem: any | null = null
  let stoken: string | null = null
  let done = false
  while (!done) {
    const response = await core.listItems(account, collection, stoken)
    for (const item of response.items) {
      if ((item as any).isDeleted) continue
      const parsed = deserializeLabelIndex(itemContentToString(await item.getContent()))
      if (!parsed) continue
      merged = mergeLabelIndexes(merged, parsed)
      if (!newestItem) newestItem = item
      else {
        const current = deserializeLabelIndex(itemContentToString(await newestItem.getContent()))
        if (current && new Date(parsed.updatedAt).getTime() > new Date(current.updatedAt).getTime()) {
          newestItem = item
        }
      }
    }
    stoken = response.stoken
    done = response.done
  }
  return { index: merged, item: newestItem }
}

async function findExistingCollection(account: any): Promise<any | null> {
  const core = await import('@silentsuite/core')
  const collections = await core.listCollections(account, COLLECTION_TYPE_LABEL_INDEX)
  return collections[0] ?? null
}

async function ensureCollection(account: any): Promise<any> {
  const existing = await findExistingCollection(account)
  if (existing) return existing
  const core = await import('@silentsuite/core')
  return core.createCollection(account, COLLECTION_TYPE_LABEL_INDEX, { name: LABEL_INDEX_COLLECTION_NAME })
}

function trackCollection(collection: any) {
  const syncEngine = useEtebaseStore.getState().syncEngine
  if (collection?.uid) syncEngine?.trackCollection(COLLECTION_TYPE_LABEL_INDEX, collection.uid)
}

export const useLabelSuggestionsStore = create<LabelSuggestionsState & LabelSuggestionsActions>((set, get) => ({
  index: createEmptyLabelIndex(),
  isLoaded: false,
  lastError: null,
  remoteCollection: null,
  remoteItem: null,

  initialize: async () => {
    const { account } = useEtebaseStore.getState()
    if (!account) {
      set({ isLoaded: true })
      return
    }

    try {
      const collection = await findExistingCollection(account)
      if (collection) {
        trackCollection(collection)
        const remote = await readRemoteIndex(account, collection)
        set({
          index: mergeLabelIndexes(get().index, remote.index),
          remoteCollection: collection,
          remoteItem: remote.item,
          isLoaded: true,
          lastError: null,
        })
      } else {
        set({ isLoaded: true, lastError: null })
      }
    } catch (err) {
      logger.warn('[label-suggestions] Label index initialization failed', getSafeErrorDetails(err))
      set({ isLoaded: true, lastError: 'Label suggestions are temporarily unavailable.' })
    }
  },

  refreshFromRemote: async () => {
    const { account } = useEtebaseStore.getState()
    if (!account) return
    try {
      const collection = get().remoteCollection ?? await findExistingCollection(account)
      if (!collection) return
      trackCollection(collection)
      const remote = await readRemoteIndex(account, collection)
      set({
        index: mergeLabelIndexes(get().index, remote.index),
        remoteCollection: collection,
        remoteItem: remote.item,
        isLoaded: true,
        lastError: null,
      })
    } catch (err) {
      logger.warn('[label-suggestions] Label index refresh failed', getSafeErrorDetails(err))
      set({ lastError: 'Label suggestions are temporarily unavailable.' })
    }
  },

  seedFromVisibleItems: (items?: SourceItems) => {
    const visibleItems = items ?? {
      calendar: useCalendarStore.getState().events,
      tasks: useTaskStore.getState().tasks,
      contacts: useContactStore.getState().contacts,
    }
    set({ index: applyVisibleItems(get().index, visibleItems) })
  },

  suggestions: (query = '', existingLabels = [], limit = 8) => suggestLabels(get().index, query, existingLabels, limit),

  recordUsage: async (source: LabelIndexSource, labels: string[]) => {
    if (labels.length === 0) return
    const next = recordLabelsUsed(get().index, source, labels)
    set({ index: next })

    const { account } = useEtebaseStore.getState()
    if (!account) return

    try {
      const core = await import('@silentsuite/core')
      const collection = get().remoteCollection ?? await ensureCollection(account)
      trackCollection(collection)
      const content = serializeLabelIndex(next)
      const existingItem = get().remoteItem
      if (existingItem) {
        const updated = await core.updateItem(account, collection, existingItem, content)
        set({ remoteCollection: collection, remoteItem: updated, lastError: null })
      } else {
        const created = await core.createItem(account, collection, content)
        set({ remoteCollection: collection, remoteItem: created, lastError: null })
      }
    } catch (err) {
      logger.warn('[label-suggestions] Label usage record failed', getSafeErrorDetails(err))
      set({ lastError: 'Label suggestions are temporarily unavailable.' })
    }
  },

  reset: () => set({
    index: createEmptyLabelIndex(),
    isLoaded: false,
    lastError: null,
    remoteCollection: null,
    remoteItem: null,
  }),
}))

export type { LabelIndexSource }
