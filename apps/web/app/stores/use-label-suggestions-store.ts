'use client'

import { create } from 'zustand'
import {
  createLabelIndex,
  deserializeLabelIndex,
  getLabelSuggestions,
  mergeLabelIndexes,
  recordLabelsUsed as recordLabelsUsedInIndex,
  serializeLabelIndex,
  type LabelIndexV1,
} from '@silentsuite/core'
import { enqueue } from '@/app/lib/offline-queue'
import { logger } from '@/app/lib/logger'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'

const LABEL_INDEX_TEMP_ID = 'silentsuite-label-index'
const WRITE_DEBOUNCE_MS = 500

interface RemoteLabelIndexItem {
  uid: string
  index: LabelIndexV1
}

interface LabelSuggestionsState {
  index: LabelIndexV1
  remoteItemUid: string | null
  pendingCreateTempId: string | null
  isInitialized: boolean
  isApplyingRemote: boolean
  writeTimer: ReturnType<typeof setTimeout> | null
}

interface LabelSuggestionsActions {
  initialize: () => Promise<void>
  loadFromRemote: (items?: { uid: string; content: string }[]) => Promise<void>
  syncLocalToRemote: () => Promise<void>
  scheduleUpload: () => void
  recordLabelsUsed: (labels: string[]) => Promise<void>
  suggestionsFor: (query?: string, excluded?: string[], limit?: number) => string[]
  destroy: () => void
}

function parseRemoteItems(items: { uid: string; content: string }[]): RemoteLabelIndexItem[] {
  const parsed: RemoteLabelIndexItem[] = []
  for (const item of items) {
    try {
      parsed.push({ uid: item.uid, index: deserializeLabelIndex(item.content) })
    } catch (err) {
      logger.warn(`[label-suggestions] Ignoring invalid label-index item ${item.uid}`, err)
    }
  }
  return parsed
}

function chooseCanonical(items: RemoteLabelIndexItem[]): RemoteLabelIndexItem | null {
  if (items.length === 0) return null
  return [...items].sort((a, b) => b.index.updatedAt - a.index.updatedAt)[0] ?? null
}

function labelIndexCollectionUid(): string | undefined {
  return useEtebaseStore.getState().collections.labelIndex[0]?.uid
}

export const useLabelSuggestionsStore = create<LabelSuggestionsState & LabelSuggestionsActions>((set, get) => ({
  index: createLabelIndex([], 0),
  remoteItemUid: null,
  pendingCreateTempId: null,
  isInitialized: false,
  isApplyingRemote: false,
  writeTimer: null,

  initialize: async () => {
    if (get().isInitialized) return
    if (!useEtebaseStore.getState().account) return
    await get().loadFromRemote()
    set({ isInitialized: true })
  },

  loadFromRemote: async (itemsFromRefresh) => {
    const etebase = useEtebaseStore.getState()
    if (!etebase.account) return

    const items = itemsFromRefresh ?? await etebase.fetchAllItems('labelIndex')
    const remoteItems = parseRemoteItems(items)
    const canonical = chooseCanonical(remoteItems)

    if (!canonical) {
      await get().syncLocalToRemote()
      return
    }

    const merged = mergeLabelIndexes([get().index, ...remoteItems.map((item) => item.index)])
    set({ index: merged, remoteItemUid: canonical.uid, pendingCreateTempId: null })

    const mergedContent = serializeLabelIndex(merged)
    const canonicalContent = serializeLabelIndex(canonical.index)
    if (remoteItems.length > 1 || mergedContent !== canonicalContent) {
      await etebase.updateItem('labelIndex', canonical.uid, mergedContent)
    }
  },

  syncLocalToRemote: async () => {
    if (get().isApplyingRemote) return
    const etebase = useEtebaseStore.getState()
    if (!etebase.account) return

    const content = serializeLabelIndex(get().index)
    const remoteItemUid = get().remoteItemUid

    if (remoteItemUid && etebase.itemCache.has(remoteItemUid)) {
      await etebase.updateItem('labelIndex', remoteItemUid, content)
      return
    }

    const existing = parseRemoteItems(await etebase.fetchAllItems('labelIndex'))
    const canonical = chooseCanonical(existing)
    if (canonical) {
      const merged = mergeLabelIndexes([get().index, ...existing.map((item) => item.index)])
      set({ index: merged, remoteItemUid: canonical.uid, pendingCreateTempId: null })
      await etebase.updateItem('labelIndex', canonical.uid, serializeLabelIndex(merged))
      return
    }

    const collectionUid = labelIndexCollectionUid()
    const pendingCreateTempId = get().pendingCreateTempId
    if (pendingCreateTempId && collectionUid) {
      await enqueue({
        type: 'create',
        collectionType: 'labelIndex',
        collectionUid,
        content,
        tempId: pendingCreateTempId,
      })
      return
    }

    const itemUid = await etebase.createItem('labelIndex', content, LABEL_INDEX_TEMP_ID, collectionUid)
    if (itemUid) {
      set({ remoteItemUid: itemUid, pendingCreateTempId: null })
    } else if (typeof navigator !== 'undefined' && !navigator.onLine) {
      set({ pendingCreateTempId: LABEL_INDEX_TEMP_ID })
    }
  },

  scheduleUpload: () => {
    const existingTimer = get().writeTimer
    if (existingTimer) clearTimeout(existingTimer)
    const writeTimer = setTimeout(() => {
      set({ writeTimer: null })
      void get().syncLocalToRemote()
    }, WRITE_DEBOUNCE_MS)
    set({ writeTimer })
  },

  recordLabelsUsed: async (labels) => {
    if (labels.length === 0) return
    const next = recordLabelsUsedInIndex(get().index, labels)
    set({ index: next })
    get().scheduleUpload()
  },

  suggestionsFor: (query = '', excluded = [], limit = 8) => getLabelSuggestions(get().index, query, limit, excluded),

  destroy: () => {
    const { writeTimer } = get()
    if (writeTimer) clearTimeout(writeTimer)
    set({
      index: createLabelIndex([], 0),
      remoteItemUid: null,
      pendingCreateTempId: null,
      isInitialized: false,
      isApplyingRemote: false,
      writeTimer: null,
    })
  },
}))
