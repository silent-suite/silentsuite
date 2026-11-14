// Logout must remove the reminders that the service worker keeps in its own
// IndexedDB database (`silentsuite-alarms`). Uses the real auth-store logout()
// and the real public/notification-worker.js, loaded into a minimal service
// worker global that shares the same fake-indexeddb origin. All data is synthetic.
import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/app/stores/use-toast-store', () => ({ showErrorToast: vi.fn() }))

import { useAuthStore } from '../use-auth-store'
import { useEtebaseStore } from '../use-etebase-store'
import { secureClear, secureGet, secureSet } from '@/app/lib/secure-storage'
import { clearAll as clearCache, getMeta, putMeta } from '@/app/lib/data-cache'

const fetchMock = vi.fn()
const realFetch = globalThis.fetch
vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  return url.includes('/auth/') || url.endsWith('/subscription') ? fetchMock(input, init) : realFetch(input, init)
})
vi.stubGlobal('BroadcastChannel', undefined)

type Alarm = { id: string; title: string; time: string; triggerAt: number; triggerLabel: string }
type Listener = (event: any) => void

/** Load the real worker script into a fake ServiceWorkerGlobalScope. */
function loadWorker() {
  const listeners: Record<string, Listener> = {}
  const showNotification = vi.fn(async () => {})
  const self = {
    addEventListener: (type: string, fn: Listener) => { listeners[type] = fn },
    registration: { showNotification },
    clients: { matchAll: async () => [], openWindow: async () => null },
  }
  const src = readFileSync(path.resolve(__dirname, '../../../public/notification-worker.js'), 'utf8')
  // setInterval is stubbed so the 30 s fallback loop does not keep the test alive.
  new Function('self', 'indexedDB', 'setInterval', src)(self, indexedDB, () => 0)
  return { listeners, showNotification }
}

function withAlarmStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('silentsuite-alarms', 1)
    req.onupgradeneeded = () => { req.result.createObjectStore('alarms', { keyPath: 'id' }) }
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('alarms', mode)
      const result = run(tx.objectStore('alarms'))
      tx.oncomplete = () => { db.close(); resolve(result ? result.result : undefined) }
      tx.onerror = () => { db.close(); reject(tx.error) }
    }
    req.onerror = () => reject(req.error)
  })
}

const readAlarmDb = async () => (await withAlarmStore<Alarm[]>('readonly', store => store.getAll())) ?? []

async function waitFor(check: () => Promise<boolean>) {
  for (let i = 0; i < 50; i++) {
    if (await check()) return
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error('timed out')
}

async function scheduleOne(worker: ReturnType<typeof loadWorker>, alarm: Alarm) {
  // Same payload shape notification-provider.tsx posts.
  worker.listeners.message!({ data: { type: 'SCHEDULE_ALARMS', alarms: [alarm] } })
  await waitFor(async () => (await readAlarmDb()).length === 1)
}

async function runPeriodicCheck(worker: ReturnType<typeof loadWorker>) {
  let done: Promise<unknown> = Promise.resolve()
  worker.listeners.periodicsync!({ tag: 'check-alarms', waitUntil: (p: Promise<unknown>) => { done = p } })
  await done
}

const FP_A = 'synthetic-fingerprint-A'
const userA = { id: 'synthetic-user-A', email: 'a@synthetic.invalid', planId: 'pro', isAdmin: false, onboardedAt: null }

describe('logout clears service-worker reminders', () => {
  beforeEach(async () => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    localStorage.clear()
    sessionStorage.clear()
    await clearCache()
    await secureClear()
    // Workers loaded by earlier tests keep connections open, so empty the store
    // rather than deleting the database.
    await withAlarmStore('readwrite', store => { store.clear() })
    useAuthStore.setState({ user: userA, isAuthenticated: true, isLoading: false, error: null })
    useEtebaseStore.setState({ accountFingerprint: FP_A, syncEngine: null })
    await secureSet('etebase_session', 'SYNTHETIC-SESSION-A')
    await putMeta({ accountFingerprint: FP_A, cacheSchemaVersion: 1, lastInvalidatedAt: null })
  })

  afterEach(() => {
    vi.useRealTimers()
    Reflect.deleteProperty(navigator, 'serviceWorker')
  })

  it('removes stored reminder records on logout', async () => {
    const worker = loadWorker()
    await scheduleOne(worker, {
      id: 'evt-1_1_-PT15M', title: 'Synthetic: appointment', time: '10:00',
      triggerAt: Date.now() + 60 * 60 * 1000, triggerLabel: '-PT15M',
    })

    await useAuthStore.getState().logout()

    // The rest of the local cleanup ran too.
    expect(useAuthStore.getState().user).toBeNull()
    expect(await secureGet('etebase_session')).toBeNull()
    expect(await getMeta()).toBeFalsy()
    expect(await readAlarmDb()).toEqual([])
  })

  it('does not show the signed-out account\'s reminder when it comes due', async () => {
    const worker = loadWorker()
    const now = Date.now()
    await scheduleOne(worker, {
      id: 'evt-2_1_-PT15M', title: 'Synthetic: meeting', time: '11:00',
      triggerAt: now + 60_000, triggerLabel: '-PT15M',
    })

    await useAuthStore.getState().logout()

    vi.useFakeTimers({ toFake: ['Date'], now: now + 90_000 })
    await runPeriodicCheck(worker)
    expect(worker.showNotification).not.toHaveBeenCalled()
  })

  it('tells the controlling service worker to drop its reminders', async () => {
    const worker = loadWorker()
    const postMessage = vi.fn((data: unknown) => worker.listeners.message!({ data }))
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { controller: { postMessage } } })
    await scheduleOne(worker, {
      id: 'evt-4', title: 'Synthetic: lunch', time: '12:30',
      triggerAt: Date.now() + 60 * 60 * 1000, triggerLabel: '-PT15M',
    })

    await useAuthStore.getState().logout()

    expect(postMessage).toHaveBeenCalledWith({ type: 'CLEAR_ALARMS' })
    expect(await readAlarmDb()).toEqual([])
  })

  it('worker drops all reminders on CLEAR_ALARMS', async () => {
    const worker = loadWorker()
    await scheduleOne(worker, {
      id: 'evt-5', title: 'Synthetic: call', time: '09:00',
      triggerAt: Date.now() + 60 * 60 * 1000, triggerLabel: '-PT15M',
    })

    worker.listeners.message!({ data: { type: 'CLEAR_ALARMS' } })
    await waitFor(async () => (await readAlarmDb()).length === 0)
  })

  it('still stores and fires reminders while signed in', async () => {
    const worker = loadWorker()
    await scheduleOne(worker, {
      id: 'evt-3', title: 'Synthetic: control', time: '12:00',
      triggerAt: Date.now() - 1000, triggerLabel: '-PT0M',
    })

    await runPeriodicCheck(worker)
    expect(worker.showNotification).toHaveBeenCalledTimes(1)
    expect(worker.showNotification.mock.calls[0]?.[0]).toBe('Synthetic: control')
    expect(await readAlarmDb()).toEqual([])
  })
})
