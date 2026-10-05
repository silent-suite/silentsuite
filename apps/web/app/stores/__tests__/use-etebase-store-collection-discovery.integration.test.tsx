import 'fake-indexeddb/auto'
import { act, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
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
  startError: null as Error | null,
  onStarted: null as (() => void) | null,
}))
const coreMock = vi.hoisted(() => {
  class FakeSyncEngine {
    trackCollection = vi.fn()
    untrackCollection = vi.fn()
    setStoken = vi.fn()
    onStokenAdvance = vi.fn()
    onChange = vi.fn(() => vi.fn())
    onStatusChange = vi.fn(() => vi.fn())
    start = vi.fn(async () => {
      if (engineControl.startGate) await engineControl.startGate
      if (engineControl.startError) throw engineControl.startError
      engineControl.onStarted?.()
    })
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
    engineControl.startError = null
    engineControl.onStarted = null
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

  describe('sync engine and provider lifecycle', () => {
    function gatedPlan(gated: string) {
      let release: (fail: boolean) => void = () => {}
      let failNext = false
      const gate = new Promise<void>((resolve) => {
        release = (fail) => {
          failNext = fail
          resolve()
        }
      })
      let gateOpen = false
      const plan: ListPlan = {
        ...existingPlan(),
        [gated]: async () => {
          if (!gateOpen) {
            await gate
            gateOpen = true
            if (failNext) throw serverError()
          }
          return page([collection(`${gated}-1`)])
        },
      }
      return { plan, release: (fail: boolean) => release(fail) }
    }

    async function settleProvider() {
      await waitFor(() => expect(useEtebaseStore.getState().isInitialized).toBe(true))
      await waitFor(() => expect(useSyncStore.getState().syncStatus).toBe('synced'))
    }

    it('a provider disposed during a failing initial discovery registers no watcher and wires no retry engine', async () => {
      const { plan, release } = gatedPlan(CALENDAR)
      fakeAccount(plan)
      const realSubscribe = useEtebaseStore.subscribe
      const unsubscribes: Array<() => void> = []
      const subscribeSpy = vi.spyOn(useEtebaseStore, 'subscribe').mockImplementation((listener) => {
        const unsubscribe = vi.fn(realSubscribe(listener))
        unsubscribes.push(unsubscribe)
        return unsubscribe
      })
      try {
        const { unmount } = render(<SyncProvider><div /></SyncProvider>)
        await vi.waitFor(() => expect(coreMock.restoreSession).toHaveBeenCalled())
        // Only the sync store's queue-count account watcher may exist while the
        // provider is alive; the recovery watcher belongs to a failed discovery.
        const watchersWhileAlive = subscribeSpy.mock.calls.length
        expect(watchersWhileAlive).toBeLessThanOrEqual(1)
        unmount()
        expect(unsubscribes).toHaveLength(watchersWhileAlive)
        for (const unsubscribe of unsubscribes) expect(unsubscribe).toHaveBeenCalledTimes(1)
        release(true)
        await settleProvider()

        await useEtebaseStore.getState().reconcileCollections()

        expect(engineControl.instances).toHaveLength(1)
        expect(subscribeSpy).toHaveBeenCalledTimes(watchersWhileAlive)
        expect(engineControl.instances[0].onChange).not.toHaveBeenCalled()
        expect(engineControl.instances[0].onStatusChange).not.toHaveBeenCalled()
      } finally {
        subscribeSpy.mockRestore()
      }
    })

    it('a provider disposed during a successful initial discovery attaches no engine handlers', async () => {
      const { plan, release } = gatedPlan(CALENDAR)
      fakeAccount(plan)
      const { unmount } = render(<SyncProvider><div /></SyncProvider>)
      await vi.waitFor(() => expect(coreMock.restoreSession).toHaveBeenCalled())
      unmount()
      release(false)
      await settleProvider()

      expect(engineControl.instances).toHaveLength(1)
      expect(useEtebaseStore.getState().syncEngine).toBe(engineControl.instances[0])
      expect(engineControl.instances[0].onChange).not.toHaveBeenCalled()
      expect(engineControl.instances[0].onStatusChange).not.toHaveBeenCalled()
    })

    it('a provider disposed while the retry engine start is pending attaches no handlers', async () => {
      let failTasks = true
      fakeAccount({
        ...existingPlan(),
        [TASKS]: async () => {
          if (failTasks) throw serverError()
          return page([collection('tasks-1')])
        },
      })
      const { unmount } = render(<SyncProvider><div /></SyncProvider>)
      await settleProvider()
      failTasks = false
      let releaseStart = () => {}
      engineControl.startGate = new Promise<void>((resolve) => { releaseStart = resolve })

      const pending = useEtebaseStore.getState().reconcileCollections()
      await vi.waitFor(() => expect(engineControl.instances[0]?.start).toHaveBeenCalled())
      unmount()
      releaseStart()
      await pending

      expect(useEtebaseStore.getState().syncEngine).toBe(engineControl.instances[0])
      expect(engineControl.instances[0].onChange).not.toHaveBeenCalled()
      expect(engineControl.instances[0].onStatusChange).not.toHaveBeenCalled()
    })

    it('StrictMode replay wires a retry engine once and unmount releases both handlers', async () => {
      let failTasks = true
      fakeAccount({
        ...existingPlan(),
        [TASKS]: async () => {
          if (failTasks) throw serverError()
          return page([collection('tasks-1')])
        },
      })
      const { unmount } = render(<StrictMode><SyncProvider><div /></SyncProvider></StrictMode>)
      await settleProvider()
      failTasks = false

      await useEtebaseStore.getState().reconcileCollections()
      const engine = engineControl.instances[0]
      await waitFor(() => expect(engine.onChange).toHaveBeenCalledTimes(1))
      expect(engine.onStatusChange).toHaveBeenCalledTimes(1)
      unmount()
      unmount()

      expect(engine.onChange.mock.results[0].value).toHaveBeenCalledTimes(1)
      expect(engine.onStatusChange.mock.results[0].value).toHaveBeenCalledTimes(1)
    })

    it('StrictMode replay wires the startup engine once and unmount releases both handlers', async () => {
      fakeAccount(existingPlan())
      const { unmount } = render(<StrictMode><SyncProvider><div /></SyncProvider></StrictMode>)
      await settleProvider()
      const engine = engineControl.instances[0]
      await waitFor(() => expect(engine.onChange).toHaveBeenCalledTimes(1))
      expect(engine.onStatusChange).toHaveBeenCalledTimes(1)

      unmount()

      expect(engine.onChange.mock.results[0].value).toHaveBeenCalledTimes(1)
      expect(engine.onStatusChange.mock.results[0].value).toHaveBeenCalledTimes(1)
    })

    it('stops an engine whose initial start throws', async () => {
      fakeAccount(existingPlan())
      engineControl.startError = new Error('engine start failed')
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      try {
        await useEtebaseStore.getState().initialize()
      } finally {
        errorSpy.mockRestore()
      }

      expect(engineControl.instances).toHaveLength(1)
      expect(engineControl.instances[0].stop).toHaveBeenCalledTimes(1)
      expect(useEtebaseStore.getState().syncEngine).toBeNull()
    })

    it('stops a retry engine whose start throws and starts exactly one owned engine on the next retry', async () => {
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
      engineControl.startError = new Error('engine start failed')
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      try {
        await expect(useEtebaseStore.getState().reconcileCollections()).rejects.toThrow('engine start failed')
      } finally {
        errorSpy.mockRestore()
      }
      expect(engineControl.instances).toHaveLength(1)
      expect(engineControl.instances[0].stop).toHaveBeenCalledTimes(1)
      expect(useEtebaseStore.getState().syncEngine).toBeNull()

      engineControl.startError = null
      await useEtebaseStore.getState().reconcileCollections()

      expect(engineControl.instances).toHaveLength(2)
      expect(useEtebaseStore.getState().syncEngine).toBe(engineControl.instances[1])
      expect(engineControl.instances[1].start).toHaveBeenCalledTimes(1)
      expect(engineControl.instances[1].stop).not.toHaveBeenCalled()
    })
  })

  describe('sync engine publication after the account boundary changes', () => {
    // Microtask positions after engine.start resolves at which the boundary
    // changes; together they span the helper's last check and the caller's
    // publication.
    const POSITIONS = [0, 1, 2, 3, 4, 5, 6, 7]
    const replacementAccount = { getCollectionManager: () => ({}) }
    const boundaries: [string, () => void][] = [
      ['destroy', () => useEtebaseStore.getState().destroy()],
      ['same-name account replacement', () => {
        useEtebaseStore.getState().destroy()
        useEtebaseStore.setState({ account: replacementAccount as any, accountFingerprint: TEST_FINGERPRINT })
      }],
    ]

    function afterMicrotasks(count: number, fn: () => void) {
      let chain = Promise.resolve()
      for (let i = 0; i < count; i++) chain = chain.then(() => {})
      void chain.then(fn)
    }

    const drainMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

    function resetAccountState() {
      useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
      engineControl.instances.length = 0
      engineControl.onStarted = null
    }

    function failingTasksAccount() {
      const control = { failTasks: true }
      fakeAccount({
        ...existingPlan(),
        [TASKS]: async () => {
          if (control.failTasks) throw serverError()
          return page([collection('tasks-1')])
        },
      })
      return control
    }

    function expectNoStaleEngine(label: string, replaced: boolean) {
      const state = useEtebaseStore.getState()
      expect(engineControl.instances, label).toHaveLength(1)
      expect(state.syncEngine, label).toBeNull()
      expect(state.isInitialized, label).toBe(false)
      expect(state.account, label).toBe(replaced ? replacementAccount : null)
      expect(engineControl.instances[0].stop, label).toHaveBeenCalled()
    }

    for (const [name, changeBoundary] of boundaries) {
      it(`initial startup neither publishes nor leaks its engine after ${name}`, async () => {
        for (const position of POSITIONS) {
          resetAccountState()
          fakeAccount(existingPlan())
          engineControl.onStarted = () => afterMicrotasks(position, changeBoundary)

          await useEtebaseStore.getState().initialize()
          await drainMicrotasks()

          expectNoStaleEngine(`${name} at microtask ${position}`, name !== 'destroy')
        }
      })

      it(`retry recovery neither publishes nor leaks its engine after ${name}`, async () => {
        for (const position of POSITIONS) {
          resetAccountState()
          const control = failingTasksAccount()
          await useEtebaseStore.getState().initialize()
          control.failTasks = false
          engineControl.onStarted = () => afterMicrotasks(position, changeBoundary)

          await useEtebaseStore.getState().reconcileCollections()
          await drainMicrotasks()

          expectNoStaleEngine(`${name} at microtask ${position}`, name !== 'destroy')
        }
      })
    }

    it('publishes the engine for the unchanged account on startup and retry recovery', async () => {
      fakeAccount(existingPlan())
      engineControl.onStarted = () => afterMicrotasks(2, () => {})
      await useEtebaseStore.getState().initialize()
      await drainMicrotasks()
      expect(useEtebaseStore.getState().syncEngine).toBe(engineControl.instances[0])
      expect(useEtebaseStore.getState().isInitialized).toBe(true)
      expect(engineControl.instances[0].stop).not.toHaveBeenCalled()

      resetAccountState()
      const control = failingTasksAccount()
      await useEtebaseStore.getState().initialize()
      control.failTasks = false
      engineControl.onStarted = () => afterMicrotasks(2, () => {})
      await useEtebaseStore.getState().reconcileCollections()
      await drainMicrotasks()
      expect(useEtebaseStore.getState().syncEngine).toBe(engineControl.instances[0])
      expect(engineControl.instances[0].stop).not.toHaveBeenCalled()
    })
  })
})
