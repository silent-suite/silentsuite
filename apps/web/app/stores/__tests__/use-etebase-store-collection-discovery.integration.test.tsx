import 'fake-indexeddb/auto'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { enqueue, getAll } from '@/app/lib/offline-queue'
import {
  _resetForTests as resetDataCache,
  _setEncryptedCacheAvailableForTests,
  _setEnvelopeKeyForTests,
} from '@/app/lib/data-cache'
import { TEST_FINGERPRINT, queueGuard, resetRealOfflineQueue } from './offline-queue-store-test-utils'

// Only the session restore, fingerprint and live SyncEngine are replaced. Collection
// discovery, default creation and item listing run through the real @silentsuite/core
// functions against a fake Etebase collection manager (the external SDK boundary).
const engineControl = vi.hoisted(() => ({
  instances: [] as any[],
  startGate: null as Promise<void> | null,
}))
const coreMock = vi.hoisted(() => {
  class FakeSyncEngine {
    trackCollection = vi.fn()
    untrackCollection = vi.fn()
    setStoken = vi.fn()
    onStokenAdvance = vi.fn()
    onChange = vi.fn(() => () => {})
    onStatusChange = vi.fn(() => () => {})
    start = vi.fn(async () => { if (engineControl.startGate) await engineControl.startGate })
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

import { useEtebaseStore, type InitialDomainLoadEvent } from '../use-etebase-store'
import { useSyncStore } from '../use-sync-store'
import { useAuthStore } from '../use-auth-store'
import { useTaskStore } from '../use-task-store'
import { SyncProvider } from '@/app/providers/sync-provider'
import { PartialLoadBanner } from '@/app/components/partial-load-banner'

vi.setConfig({ testTimeout: 15_000 })

const CALENDAR = 'etebase.vevent'
const TASKS = 'etebase.vtodo'
const CONTACTS = 'etebase.vcard'
const NOTES = 'etebase.md.note'
const VISIBLE = ['calendar', 'tasks', 'contacts', 'notes'] as const
const RESTORE_TOAST = 'Failed to restore session. Please try signing in again.'

type ListPage = { data: any[]; stoken: string | null; done: boolean }
type ListPlan = Record<string, (options?: { stoken?: string }) => Promise<ListPage>>

const collection = (uid: string, name = uid) => ({ uid, isDeleted: false, getMeta: () => ({ name }) })
const page = (data: any[]): ListPage => ({ data, stoken: 'end', done: true })
const serverError = () => new Error('collection list 500')

/** Fake Etebase SDK account: only the collection manager surface core touches. */
function fakeAccount(plan: ListPlan) {
  const known = new Map<string, any>()
  const list = vi.fn(async (type: string, options?: { stoken?: string }) => {
    const response = await plan[type](options)
    for (const entry of response.data) known.set(entry.uid, entry)
    return response
  })
  const create = vi.fn(async (type: string, meta: { name: string }) => collection(`created-${type}`, meta.name))
  const upload = vi.fn(async () => {})
  const manager = {
    list,
    create,
    upload,
    fetch: vi.fn(async (uid: string) => known.get(uid)),
    getItemManager: () => ({ list: vi.fn(async () => ({ data: [], stoken: null, done: true })) }),
  }
  const account = { getCollectionManager: () => manager }
  coreMock.restoreSession.mockResolvedValue(account)
  return { account, list, create, upload }
}

function existingPlan(): ListPlan {
  return {
    [CALENDAR]: async () => page([collection('calendar-1')]),
    [TASKS]: async () => page([collection('tasks-1')]),
    [CONTACTS]: async () => page([collection('contacts-1')]),
    [NOTES]: async () => page([]),
  }
}

function visibleDomainState() {
  const state = useEtebaseStore.getState().domainLoadState
  return Object.fromEntries(VISIBLE.map((key) => [key, state[key]]))
}

describe('useEtebaseStore collection discovery error state', () => {
  beforeEach(async () => {
    await resetRealOfflineQueue()
    await resetDataCache()
    _setEnvelopeKeyForTests(await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']))
    _setEncryptedCacheAvailableForTests(true)
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    useSyncStore.setState(useSyncStore.getInitialState(), true)
    useSyncStore.setState({ isOnline: true })
    coreMock.restoreSession.mockReset()
    coreMock.getAccountFingerprint.mockReset().mockReturnValue(TEST_FINGERPRINT)
    toastMock.showErrorToast.mockReset()
    sentryMock.captureException.mockReset()
    engineControl.instances.length = 0
    engineControl.startGate = null
  })

  it('marks every visible domain failed and reports each terminal domain when a restored discovery page fails', async () => {
    const { create, upload } = fakeAccount({ ...existingPlan(), [TASKS]: async () => { throw serverError() } })
    await enqueue({ type: 'update', collectionType: 'tasks', collectionUid: 'tasks-1', itemUid: 'task-1' }, queueGuard())
    const events: InitialDomainLoadEvent[] = []

    await useEtebaseStore.getState().initialize({ onDomainLoaded: (event) => { events.push(event) } })

    const state = useEtebaseStore.getState()
    expect(state.restoreBlocked).toBe(false)
    expect(state.isInitialized).toBe(true)
    // All-or-nothing: a calendar listing that succeeded before the tasks page failed is not published.
    expect(state.collections.calendar).toEqual([])
    expect(create).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
    // Pending local work is untouched by the failed discovery.
    expect((await getAll(queueGuard())).map((entry) => entry.itemUid)).toEqual(['task-1'])
    // Honest, recoverable error through the existing per-domain contract.
    expect(visibleDomainState()).toEqual({ calendar: 'failed', tasks: 'failed', contacts: 'failed', notes: 'failed' })
    expect(events.map((event) => [event.type, event.status])).toEqual(VISIBLE.map((key) => [key, 'failed']))
  })

  it('does not tell a restored user to sign in again when only collection discovery fails', async () => {
    fakeAccount({ ...existingPlan(), [CONTACTS]: async () => { throw serverError() } })

    await useEtebaseStore.getState().initialize()

    expect(useEtebaseStore.getState().restoreBlocked).toBe(false)
    expect(toastMock.showErrorToast).not.toHaveBeenCalledWith(RESTORE_TOAST)
  })

  it('creates no default collection when a later type fails mid-pagination after an empty listing', async () => {
    const { create, upload } = fakeAccount({
      ...existingPlan(),
      [CALENDAR]: async () => page([]),
      // Not done, but no continuation cursor: core rejects the partial listing.
      [TASKS]: async () => ({ data: [collection('tasks-1')], stoken: null, done: false }),
    })

    await useEtebaseStore.getState().initialize()

    expect(create).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
    expect(useEtebaseStore.getState().collections.calendar).toEqual([])
  })

  it('still creates core defaults, but never Notes, after a complete empty discovery', async () => {
    const { create } = fakeAccount({
      [CALENDAR]: async () => page([]),
      [TASKS]: async () => page([]),
      [CONTACTS]: async () => page([]),
      [NOTES]: async () => page([]),
    })

    await useEtebaseStore.getState().initialize()

    expect(create.mock.calls.map((call) => call[0])).toEqual([CALENDAR, TASKS, CONTACTS])
    expect(visibleDomainState()).toEqual({ calendar: 'loaded', tasks: 'loaded', contacts: 'loaded', notes: 'loaded' })
  })

  it('keeps existing collections and item maps when manual reconcile discovery fails', async () => {
    const { create } = fakeAccount({ ...existingPlan(), [NOTES]: async () => { throw serverError() } })
    const calendar = collection('calendar-1')
    const item = { uid: 'event-1', isDeleted: false }
    useEtebaseStore.setState({
      account: (await coreMock.restoreSession()) as any,
      accountFingerprint: TEST_FINGERPRINT,
      collections: { calendar: [calendar], tasks: [], contacts: [], notes: [], preferences: [] },
      itemCache: new Map([['event-1', item]]),
      itemTypeMap: new Map([['event-1', 'calendar']]),
      itemCollectionMap: new Map([['event-1', 'calendar-1']]),
    } as any)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(useEtebaseStore.getState().reconcileCollections()).rejects.toThrow('collection list 500')
    } finally {
      errorSpy.mockRestore()
    }

    const state = useEtebaseStore.getState()
    expect(state.collections.calendar).toEqual([calendar])
    expect(state.itemCollectionMap.get('event-1')).toBe('calendar-1')
    expect(create).not.toHaveBeenCalled()
  })

  it('clears the failed domains, including Notes without a notebook, after a successful retry', async () => {
    let failTasks = true
    fakeAccount({
      ...existingPlan(),
      [TASKS]: async () => {
        if (failTasks) throw serverError()
        return page([collection('tasks-1')])
      },
    })
    await useEtebaseStore.getState().initialize()
    failTasks = false

    useSyncStore.getState().simulateSyncCycle()
    await waitFor(() => expect(useSyncStore.getState().syncStatus).not.toBe('syncing'))

    expect(useSyncStore.getState().syncStatus).toBe('synced')
    expect(useEtebaseStore.getState().collections.tasks.map((entry: any) => entry.uid)).toEqual(['tasks-1'])
    expect(visibleDomainState()).toEqual({ calendar: 'loaded', tasks: 'loaded', contacts: 'loaded', notes: 'loaded' })
    expect(useSyncStore.getState().partialLoad).toBe(false)
  })

  it('does not publish a stale discovery failure after the account boundary changes', async () => {
    let rejectTasks: (err: Error) => void = () => {}
    const { create } = fakeAccount({
      ...existingPlan(),
      [TASKS]: () => new Promise<ListPage>((_resolve, reject) => { rejectTasks = reject }),
    })
    const events: InitialDomainLoadEvent[] = []

    const pending = useEtebaseStore.getState().initialize({ onDomainLoaded: (event) => { events.push(event) } })
    await vi.waitFor(() => expect(coreMock.restoreSession).toHaveBeenCalled())
    await vi.waitFor(() => expect(useEtebaseStore.getState().account).toBeTruthy())
    useEtebaseStore.getState().destroy()
    rejectTasks(serverError())
    await pending

    expect(visibleDomainState()).toEqual({ calendar: 'unknown', tasks: 'unknown', contacts: 'unknown', notes: 'unknown' })
    expect(events).toEqual([])
    expect(create).not.toHaveBeenCalled()
    expect(toastMock.showErrorToast).not.toHaveBeenCalled()
  })

  it('renders the existing retry banner and keeps cached domain data after restored discovery fails', async () => {
    fakeAccount({ ...existingPlan(), [CALENDAR]: async () => { throw serverError() } })
    useAuthStore.setState({ isAuthenticated: true })
    useTaskStore.setState({ tasks: [{ id: 'cached-task', title: 'Cached task', listId: 'tasks-1' } as any] })

    render(
      <SyncProvider>
        <PartialLoadBanner />
      </SyncProvider>,
    )
    await waitFor(() => expect(useEtebaseStore.getState().isInitialized).toBe(true))
    await waitFor(() => expect(useSyncStore.getState().syncStatus).not.toBe('syncing'))

    expect(useTaskStore.getState().tasks.map((task) => task.id)).toContain('cached-task')
    expect(screen.queryByText(/Some of your data could not be loaded/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry sync/i })).toBeEnabled()
  })

  it('treats an offline discovery failure as failed domains without a toast and keeps local work', async () => {
    fakeAccount({ ...existingPlan(), [CALENDAR]: async () => { throw new TypeError('Failed to fetch') } })
    await enqueue({ type: 'update', collectionType: 'tasks', collectionUid: 'tasks-1', itemUid: 'task-1' }, queueGuard())
    useTaskStore.setState({ tasks: [{ id: 'cached-task', title: 'Cached task', listId: 'tasks-1' } as any] })
    const events: InitialDomainLoadEvent[] = []

    await useEtebaseStore.getState().initialize({ onDomainLoaded: (event) => { events.push(event) } })

    expect(useEtebaseStore.getState().restoreBlocked).toBe(false)
    expect(toastMock.showErrorToast).not.toHaveBeenCalled()
    expect((await getAll(queueGuard())).map((entry) => entry.itemUid)).toEqual(['task-1'])
    expect(useTaskStore.getState().tasks.map((task) => task.id)).toEqual(['cached-task'])
    expect(visibleDomainState()).toEqual({ calendar: 'failed', tasks: 'failed', contacts: 'failed', notes: 'failed' })
    expect(events.map((event) => [event.type, event.status])).toEqual(VISIBLE.map((key) => [key, 'failed']))
  })

  it('starts the existing sync engine once when a retry discovers collections after a failed startup', async () => {
    let failTasks = true
    fakeAccount({
      ...existingPlan(),
      [TASKS]: async () => {
        if (failTasks) throw serverError()
        return page([collection('tasks-1')])
      },
    })
    await useEtebaseStore.getState().initialize()
    expect(engineControl.instances).toHaveLength(0)
    failTasks = false

    await Promise.all([
      useEtebaseStore.getState().reconcileCollections(),
      useEtebaseStore.getState().reconcileCollections(),
    ])

    expect(engineControl.instances).toHaveLength(1)
    const engine = engineControl.instances[0]
    expect(useEtebaseStore.getState().syncEngine).toBe(engine)
    expect(engine.start).toHaveBeenCalledTimes(1)
    expect(engine.trackCollection.mock.calls.map((call: unknown[]) => call[1])).toEqual(['calendar-1', 'tasks-1', 'contacts-1'])

    await useEtebaseStore.getState().reconcileCollections()
    expect(engineControl.instances).toHaveLength(1)
    expect(engine.start).toHaveBeenCalledTimes(1)
    expect(engine.trackCollection).toHaveBeenCalledTimes(3)
  })

  it('stops a retry-started engine whose start finishes after the account boundary changed', async () => {
    let failTasks = true
    fakeAccount({
      ...existingPlan(),
      [TASKS]: async () => {
        if (failTasks) throw serverError()
        return page([collection('tasks-1')])
      },
    })
    await useEtebaseStore.getState().initialize()
    failTasks = false
    let releaseStart = () => {}
    engineControl.startGate = new Promise<void>((resolve) => { releaseStart = resolve })

    const pending = useEtebaseStore.getState().reconcileCollections()
    await vi.waitFor(() => expect(engineControl.instances[0]?.start).toHaveBeenCalled())
    useEtebaseStore.getState().destroy()
    releaseStart()
    await pending

    expect(engineControl.instances).toHaveLength(1)
    expect(engineControl.instances[0].stop).toHaveBeenCalled()
    expect(useEtebaseStore.getState().syncEngine).toBeNull()
  })

  it('wires the provider change and status handlers to the engine started by a successful retry', async () => {
    let failCalendar = true
    fakeAccount({
      ...existingPlan(),
      [CALENDAR]: async () => {
        if (failCalendar) throw serverError()
        return page([collection('calendar-1')])
      },
    })
    useAuthStore.setState({ isAuthenticated: true })

    render(
      <SyncProvider>
        <PartialLoadBanner />
      </SyncProvider>,
    )
    await waitFor(() => expect(useEtebaseStore.getState().isInitialized).toBe(true))
    await waitFor(() => expect(useSyncStore.getState().syncStatus).not.toBe('syncing'))
    failCalendar = false

    act(() => useSyncStore.getState().simulateSyncCycle())

    await waitFor(() => expect(screen.queryByText(/Some of your data could not be loaded/i)).not.toBeInTheDocument())
    expect(engineControl.instances).toHaveLength(1)
    const engine = engineControl.instances[0]
    await waitFor(() => expect(engine.onChange).toHaveBeenCalledTimes(1))
    expect(engine.onStatusChange).toHaveBeenCalledTimes(1)
    const statusHandler = (engine.onStatusChange.mock.calls[0] as unknown[])[0] as (status: string) => void
    act(() => statusHandler('error'))
    expect(useSyncStore.getState().syncStatus).toBe('error')
  })
})
