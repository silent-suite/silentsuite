import 'fake-indexeddb/auto'
import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { enqueue, getAll } from '@/app/lib/offline-queue'
import {
  _resetForTests as resetDataCache,
  _setEncryptedCacheAvailableForTests,
  _setEnvelopeKeyForTests,
} from '@/app/lib/data-cache'
import { TEST_FINGERPRINT, queueGuard, resetRealOfflineQueue } from '@/app/stores/__tests__/offline-queue-store-test-utils'

// #748 residual: a reload restores the session while the server is unreachable,
// so collection discovery fails; the transport then becomes healthy without
// another page load. SyncProvider, the Etebase store, the sync store and the
// offline queue (fake-indexeddb) are real. Only the session restore, fingerprint,
// live SyncEngine and the Etebase SDK account (the transport boundary) are fakes.
const engineControl = vi.hoisted(() => ({ instances: [] as any[] }))
const coreMock = vi.hoisted(() => {
  class FakeSyncEngine {
    trackCollection = vi.fn()
    untrackCollection = vi.fn()
    setStoken = vi.fn()
    onStokenAdvance = vi.fn()
    onChange = vi.fn(() => vi.fn())
    onStatusChange = vi.fn(() => vi.fn())
    start = vi.fn(async () => {})
    stop = vi.fn()
    pause = vi.fn()
    resume = vi.fn()
    syncNow = vi.fn(async () => {})
    constructor() {
      engineControl.instances.push(this)
    }
  }
  return {
    restoreSession: vi.fn(),
    getAccountFingerprint: vi.fn(),
    SyncEngine: FakeSyncEngine,
  }
})
const toastMock = vi.hoisted(() => ({ showErrorToast: vi.fn() }))
const sentryMock = vi.hoisted(() => ({ captureException: vi.fn() }))

vi.mock('@silentsuite/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@silentsuite/core')>(),
  ...coreMock,
}))
vi.mock('@/app/lib/secure-storage', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/app/lib/secure-storage')>(),
  secureGet: vi.fn(async () => 'raw-session'),
}))
vi.mock('@/app/stores/use-toast-store', () => toastMock)
vi.mock('@sentry/nextjs', () => sentryMock)
vi.mock('@/app/stores/use-label-suggestions-store', () => ({
  useLabelSuggestionsStore: {
    getState: () => ({ initialize: vi.fn(async () => {}), seedFromVisibleItems: vi.fn(), recordUsage: vi.fn() }),
  },
}))
vi.mock('@/app/stores/use-preferences-sync-store', () => ({
  usePreferencesSyncStore: {
    getState: () => ({ initialize: vi.fn(async () => {}), loadFromRemote: vi.fn(async () => {}) }),
  },
}))

import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useSyncStore } from '@/app/stores/use-sync-store'
import { useTaskStore } from '@/app/stores/use-task-store'
import { SyncProvider } from '../sync-provider'

vi.setConfig({ testTimeout: 15_000 })

const CALENDAR = 'etebase.vevent'
const TASKS = 'etebase.vtodo'
const CONTACTS = 'etebase.vcard'
const NOTES = 'etebase.md.note'
const VISIBLE = ['calendar', 'tasks', 'contacts', 'notes'] as const

const vtodo = (summary: string) => [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//SilentSuite//EN',
  'BEGIN:VTODO',
  'UID:logical-task-1',
  `SUMMARY:${summary}`,
  'STATUS:NEEDS-ACTION',
  'END:VTODO',
  'END:VCALENDAR',
].join('\r\n')
const SERVER_CONTENT = vtodo('Server title')
const EDITED_CONTENT = vtodo('Edited while offline')

/**
 * Fake Etebase SDK account over an in-memory server. Every method that is a
 * network request in the real SDK rejects with a browser-style fetch failure
 * while `transport.reachable` is false.
 */
function fakeServer() {
  const transport = { reachable: true }
  const request = async <T,>(respond: () => T): Promise<T> => {
    if (!transport.reachable) throw new TypeError('Failed to fetch')
    return respond()
  }
  const uploaded = new Map<string, string>()
  const makeItem = (uid: string, initial: string) => {
    let content = initial
    let meta: Record<string, unknown> = { name: uid }
    uploaded.set(uid, initial)
    const item = {
      uid,
      isDeleted: false,
      getContent: async () => content,
      setContent: async (next: string) => { content = next },
      getMeta: () => meta,
      setMeta: (next: Record<string, unknown>) => { meta = next },
      delete: () => { item.isDeleted = true },
    }
    return item
  }
  const collection = (uid: string) => ({ uid, isDeleted: false, getMeta: () => ({ name: uid }) })
  const collectionsByType: Record<string, any[]> = {
    [CALENDAR]: [collection('calendar-1')],
    [TASKS]: [collection('tasks-1')],
    [CONTACTS]: [collection('contacts-1')],
    [NOTES]: [],
  }
  const itemsByCollection = new Map<string, any[]>([['tasks-1', [makeItem('task-1', SERVER_CONTENT)]]])

  const list = vi.fn((type: string) => request(() => ({ data: collectionsByType[type] ?? [], stoken: 'end', done: true })))
  const create = vi.fn(async (type: string) => collection(`created-${type}`))
  const upload = vi.fn((created: any) => request(() => { void created }))
  const batch = vi.fn((items: any[]) => request(async () => {
    for (const item of items) uploaded.set(item.uid, await item.getContent())
  }))
  const manager = {
    list,
    create,
    upload,
    fetch: vi.fn((uid: string) => request(() => Object.values(collectionsByType).flat().find((entry) => entry.uid === uid))),
    getItemManager: (owner: { uid: string }) => ({
      list: vi.fn(() => request(() => ({ data: itemsByCollection.get(owner.uid) ?? [], stoken: null, done: true }))),
      create: vi.fn(async (_meta: unknown, content: string) => makeItem(`created-item-${uploaded.size}`, content)),
      batch,
    }),
  }
  const account = { getCollectionManager: () => manager }
  coreMock.restoreSession.mockResolvedValue(account)
  return { transport, list, create, upload, batch, uploadedContent: (uid: string) => uploaded.get(uid) }
}

function visibleDomainState() {
  const state = useEtebaseStore.getState().domainLoadState
  return Object.fromEntries(VISIBLE.map((key) => [key, state[key]]))
}

const queuedEdit = () => enqueue(
  { type: 'update', collectionType: 'tasks', collectionUid: 'tasks-1', itemUid: 'task-1', content: EDITED_CONTENT },
  queueGuard(),
)

describe('SyncProvider network initialization with a queued offline change (#748)', () => {
  beforeEach(async () => {
    await resetRealOfflineQueue()
    await resetDataCache()
    _setEnvelopeKeyForTests(await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']))
    _setEncryptedCacheAvailableForTests(true)
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    useSyncStore.setState(useSyncStore.getInitialState(), true)
    useTaskStore.setState({ tasks: [] })
    coreMock.restoreSession.mockReset()
    coreMock.getAccountFingerprint.mockReset().mockReturnValue(TEST_FINGERPRINT)
    toastMock.showErrorToast.mockReset()
    sentryMock.captureException.mockReset()
    engineControl.instances.length = 0
  })

  it('control: a healthy initialization replays the queued change during startup', async () => {
    const server = fakeServer()
    await queuedEdit()

    const { unmount } = render(<SyncProvider><div /></SyncProvider>)
    try {
      await waitFor(() => expect(server.uploadedContent('task-1')).toBe(EDITED_CONTENT))
      await waitFor(async () => expect(await getAll(queueGuard())).toEqual([]))
      // The replay is followed by a sync cycle; let it settle.
      await waitFor(() => expect(engineControl.instances[0]?.syncNow).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(useSyncStore.getState().syncStatus).toBe('synced'))

      expect(visibleDomainState()).toEqual({ calendar: 'loaded', tasks: 'loaded', contacts: 'loaded', notes: 'loaded' })
      expect(server.batch).toHaveBeenCalledTimes(1)
      expect(useSyncStore.getState().pendingQueueCount).toBe(0)
      expect(useTaskStore.getState().tasks.map((task) => [task.id, task.title])).toEqual([['task-1', 'Edited while offline']])
      expect(sentryMock.captureException).not.toHaveBeenCalled()
      expect(toastMock.showErrorToast).not.toHaveBeenCalled()
    } finally {
      unmount()
    }
  })

  it('replays the queued change once the transport recovers after a failed initial collection discovery', async () => {
    const server = fakeServer()
    server.transport.reachable = false
    const onLine = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)
    await queuedEdit()

    const { unmount } = render(<SyncProvider><div /></SyncProvider>)
    try {
      // Reload while the server is unreachable: the session restores, discovery fails.
      await waitFor(() => expect(useSyncStore.getState().lastSyncedAt).not.toBeNull())
      const failed = useEtebaseStore.getState()
      expect(coreMock.restoreSession).toHaveBeenCalledTimes(1)
      expect(server.list).toHaveBeenCalledTimes(1)
      expect(failed.account).toBeTruthy()
      expect(failed.accountFingerprint).toBe(TEST_FINGERPRINT)
      expect(failed.isInitialized).toBe(true)
      expect(failed.restoreBlocked).toBe(false)
      expect(failed.collections).toEqual({ calendar: [], tasks: [], contacts: [], notes: [], preferences: [] })
      expect(failed.syncEngine).toBeNull()
      expect(engineControl.instances).toHaveLength(0)
      expect(visibleDomainState()).toEqual({ calendar: 'failed', tasks: 'failed', contacts: 'failed', notes: 'failed' })
      expect(useSyncStore.getState().isOnline).toBe(false)
      expect(toastMock.showErrorToast).not.toHaveBeenCalled()
      expect(server.create).not.toHaveBeenCalled()
      expect(server.batch).not.toHaveBeenCalled()
      expect(await getAll(queueGuard())).toEqual([
        expect.objectContaining({ type: 'update', itemUid: 'task-1', collectionUid: 'tasks-1', status: 'pending', retryCount: 0 }),
      ])
      const syncedBeforeReconnect = useSyncStore.getState().lastSyncedAt

      // The transport becomes healthy without another page load.
      server.transport.reachable = true
      onLine.mockReturnValue(true)
      act(() => { window.dispatchEvent(new Event('online')) })

      // The existing reconnect path rediscovers collections and reloads every domain.
      await waitFor(() => expect(visibleDomainState()).toEqual({ calendar: 'loaded', tasks: 'loaded', contacts: 'loaded', notes: 'loaded' }))
      await waitFor(() => expect(useSyncStore.getState().lastSyncedAt).not.toBe(syncedBeforeReconnect))
      expect(useSyncStore.getState().syncStatus).toBe('synced')
      expect(useSyncStore.getState().isOnline).toBe(true)
      expect(useEtebaseStore.getState().collections.tasks.map((entry: any) => entry.uid)).toEqual(['tasks-1'])
      expect(useEtebaseStore.getState().itemCache.has('task-1')).toBe(true)
      expect(engineControl.instances).toHaveLength(1)
      expect(engineControl.instances[0].start).toHaveBeenCalledTimes(1)
      expect(server.create).not.toHaveBeenCalled()
      expect(sentryMock.captureException).not.toHaveBeenCalled()

      // Intended assertion: the change queued before the reload reaches the server.
      await waitFor(async () => {
        expect(await getAll(queueGuard())).toEqual([])
        expect(server.uploadedContent('task-1')).toBe(EDITED_CONTENT)
      }, { timeout: 3_000 })
      expect(useSyncStore.getState().pendingQueueCount).toBe(0)
    } finally {
      unmount()
      onLine.mockRestore()
    }
  })
})
