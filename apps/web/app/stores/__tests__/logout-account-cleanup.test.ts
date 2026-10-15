// Logout / invalid-session cleanup with the real auth store, the real Etebase
// store destroy(), real account epochs and real secure-storage, offline-queue
// and data-cache on fake-indexeddb. Only billing /auth/ fetches and the toast
// module are stubbed; persistence clear functions are wrapped to observe or
// inject account switches after the real clear completes. All data is synthetic.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Each hook runs while the real clear it is attached to is still pending.
const hooks = vi.hoisted(() => ({
  duringCacheClear: null as null | (() => Promise<void>),
  duringQueueClear: null as null | (() => Promise<void>),
  duringSecureClear: null as null | (() => Promise<void>),
}))

vi.mock('@/app/stores/use-toast-store', () => ({ showErrorToast: vi.fn() }))
vi.mock('@/app/lib/data-cache', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/app/lib/data-cache')>()
  return { ...real, clearAll: async () => { const pending = real.clearAll(); await hooks.duringCacheClear?.(); await pending } }
})
vi.mock('@/app/lib/offline-queue', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/app/lib/offline-queue')>()
  return { ...real, clearAll: async () => { const pending = real.clearAll(); await hooks.duringQueueClear?.(); await pending } }
})
vi.mock('@/app/lib/secure-storage', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/app/lib/secure-storage')>()
  return { ...real, secureClear: async () => { const pending = real.secureClear(); await hooks.duringSecureClear?.(); await pending } }
})

import { useAuthStore } from '../use-auth-store'
import { EtebaseTeardownError, useEtebaseStore } from '../use-etebase-store'
import { useNoteStore } from '../use-note-store'
import { useCalendarStore } from '../use-calendar-store'
import { usePreferencesStore } from '../use-preferences-store'
import { bumpAccountEpoch, getAccountEpoch } from '@/app/lib/account-epoch'
import { secureClear, secureGet, secureSet } from '@/app/lib/secure-storage'
import { clearAll as clearQueue, enqueue, getAll, _resetForTests as resetQueue } from '@/app/lib/offline-queue'
import { clearAll as clearCache, getMeta, putMeta } from '@/app/lib/data-cache'

const SESSION_A = 'SYNTHETIC-ETEBASE-SESSION-A'
const SESSION_B = 'SYNTHETIC-ETEBASE-SESSION-B'
const FP_A = 'synthetic-fingerprint-A'
const FP_B = 'synthetic-fingerprint-B'
const CUSTOM = 'https://synthetic-selfhost.invalid'
const INVALIDATED = 'silentsuite-hosted-auth-invalidated'
const userA = { id: 'synthetic-user-A', email: 'a@synthetic.invalid', planId: 'pro', isAdmin: false, onboardedAt: null }
const userB = { ...userA, id: 'synthetic-user-B', email: 'b@synthetic.invalid' }

const fetchMock = vi.fn()
const realFetch = globalThis.fetch
// Only billing /auth/ calls are stubbed; module/WASM loading keeps the real loader.
vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
  String(input instanceof Request ? input.url : input).includes('/auth/') ? fetchMock(input, init) : realFetch(input, init))
vi.stubGlobal('BroadcastChannel', undefined)

async function seed(session: string, fingerprint: string, itemUid: string) {
  await secureSet('etebase_session', session)
  // A delete mutation carries no plaintext content, so the real queue accepts it.
  await enqueue({ type: 'delete', collectionType: 'notes', collectionUid: 'nb-1', itemUid }, { accountEpoch: getAccountEpoch(), accountFingerprint: fingerprint })
  await putMeta({ accountFingerprint: fingerprint, cacheSchemaVersion: 1, lastInvalidatedAt: null })
}

async function persisted() {
  return {
    session: await secureGet('etebase_session'),
    queue: (await getAll()).map(entry => entry.itemUid),
    meta: (await getMeta())?.accountFingerprint ?? null,
  }
}

const RETAINED_A = { session: SESSION_A, queue: ['note-a'], meta: FP_A }
const CLEARED = { session: null, queue: [], meta: null }

/** Synthetic account B establishing itself in login order: invalidate, publish, clear queue, persist. */
async function establishB() {
  bumpAccountEpoch()
  useAuthStore.setState({ user: userB, isAuthenticated: true })
  await clearQueue()
  await seed(SESSION_B, FP_B, 'note-b')
}

const B_PERSISTED = { session: SESSION_B, queue: ['note-b'], meta: FP_B }

function signInA() {
  useAuthStore.setState({ user: userA, isAuthenticated: true })
  useEtebaseStore.setState({ accountFingerprint: FP_A })
}

beforeEach(async () => {
  fetchMock.mockReset()
  hooks.duringCacheClear = null
  hooks.duringQueueClear = null
  hooks.duringSecureClear = null
  vi.restoreAllMocks()
  localStorage.clear()
  sessionStorage.clear()
  await resetQueue()
  await clearQueue()
  await clearCache()
  await secureClear()
  useEtebaseStore.setState({ syncEngine: null })
  useNoteStore.setState({ notes: [] })
  expect(await persisted()).toEqual(CLEARED)
  useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false, error: null, pendingSignup: null, subscriptionStatus: null })
  await seed(SESSION_A, FP_A, 'note-a')
  expect(await persisted()).toEqual(RETAINED_A)
})

describe('logout cleanup with real Etebase teardown', () => {
  it('custom-server logout clears session, queue and cache, and restore stays signed out', async () => {
    localStorage.setItem('silentsuite-server-url', CUSTOM)
    signInA()
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))

    await useAuthStore.getState().logout()

    expect(useEtebaseStore.getState().accountFingerprint).toBeNull()
    expect(await persisted()).toEqual(CLEARED)
    expect(localStorage.getItem('silentsuite-server-url')).toBeNull()

    await useAuthStore.getState().restoreSession()
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(useAuthStore.getState().user).toBeNull()
  })

  it('hosted logout clears local material and marks hosted auth invalidated', async () => {
    signInA()
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))

    await useAuthStore.getState().logout()

    expect(await persisted()).toEqual(CLEARED)
    expect(localStorage.getItem(INVALIDATED)).not.toBeNull()
  })

  it('hosted logout still clears when the server-session DELETE fails, and restore does not re-sign in', async () => {
    signInA()
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    await useAuthStore.getState().logout()

    expect(await persisted()).toEqual(CLEARED)
    expect(localStorage.getItem(INVALIDATED)).not.toBeNull()

    // A still-valid server cookie would answer 200; restore must not ask.
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: userA.id, email: userA.email, rememberDevice: true })))
    await useAuthStore.getState().restoreSession()
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('logout after a reset store failure past teardown still clears persistent material', async () => {
    signInA()
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    vi.spyOn(useNoteStore, 'setState').mockImplementationOnce(() => { throw new Error('synthetic reset failure') })

    await useAuthStore.getState().logout()

    expect(await persisted()).toEqual(CLEARED)
  })

  it('logout after a reset failure before teardown falls back to destroy and still clears', async () => {
    signInA()
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    const getState = useEtebaseStore.getState
    vi.spyOn(useEtebaseStore, 'getState').mockImplementationOnce(() => { throw new Error('synthetic teardown lookup failure') })

    await useAuthStore.getState().logout()

    expect(getState().accountFingerprint).toBeNull()
    expect(await persisted()).toEqual(CLEARED)
  })
})

describe('refreshSession cleanup and publication with real Etebase teardown', () => {
  it('401 clears persistent material', async () => {
    signInA()
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }))
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))

    expect(await useAuthStore.getState().refreshSession()).toBe(false)
    expect(useAuthStore.getState().user).toBeNull()
    expect(await persisted()).toEqual(CLEARED)
  })

  it('unremembered device without a live tab clears persistent material', async () => {
    signInA()
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: userA.id, email: userA.email, rememberDevice: false })))
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))

    expect(await useAuthStore.getState().refreshSession()).toBe(false)
    expect(useAuthStore.getState().user).toBeNull()
    expect(await persisted()).toEqual(CLEARED)
  })

  it('a different hosted user resets departing state and publishes the new user', async () => {
    signInA()
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: userB.id, email: userB.email, rememberDevice: true })))

    expect(await useAuthStore.getState().refreshSession()).toBe(true)
    expect(useEtebaseStore.getState().accountFingerprint).toBeNull()
    expect(useAuthStore.getState().user?.id).toBe(userB.id)
    expect(useAuthStore.getState().isAuthenticated).toBe(true)
  })

  it('the same hosted user publishes without a reset', async () => {
    signInA()
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: userA.id, email: userA.email, rememberDevice: true })))
    const before = getAccountEpoch()

    expect(await useAuthStore.getState().refreshSession()).toBe(true)
    expect(getAccountEpoch()).toBe(before)
    expect(useEtebaseStore.getState().accountFingerprint).toBe(FP_A)
  })

  it('a different-user refresh does not publish over account C established in a microtask queued by the last reset', async () => {
    signInA()
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: userB.id, email: userB.email, rememberDevice: true })))
    const userC = { ...userA, id: 'synthetic-user-C', email: 'c@synthetic.invalid' }
    const realReset = usePreferencesStore.getState().resetSyncedPreferences
    let cPublished = false
    usePreferencesStore.setState({ resetSyncedPreferences: () => {
      realReset()
      queueMicrotask(() => {
        bumpAccountEpoch()
        useAuthStore.setState({ user: userC, isAuthenticated: true })
        cPublished = true
      })
    } })
    try {
      expect(await useAuthStore.getState().refreshSession()).toBe(false)
      expect(cPublished).toBe(true)
      expect(useAuthStore.getState().user?.id).toBe(userC.id)
    } finally {
      usePreferencesStore.setState({ resetSyncedPreferences: realReset })
    }
  })

  it('a different-user refresh does not publish after a login reentrantly invalidates the boundary during teardown', async () => {
    signInA()
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: userB.id, email: userB.email, rememberDevice: true })))
    // A login that has bumped the epoch but not yet published its user.
    const unsubscribe = useEtebaseStore.subscribe(() => { unsubscribe(); bumpAccountEpoch() })

    expect(await useAuthStore.getState().refreshSession()).toBe(false)
    expect(useAuthStore.getState().user?.id).toBe(userA.id)
  })
})

describe('departing cleanup never removes a newly established account', () => {
  it('account B established during the server-session DELETE keeps everything', async () => {
    signInA()
    let finishDelete!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishDelete = resolve }))

    const logout = useAuthStore.getState().logout()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await secureClear()
    await clearQueue()
    await establishB()
    finishDelete(new Response(null, { status: 204 }))
    await logout

    expect(useAuthStore.getState().user?.id).toBe(userB.id)
    expect(await persisted()).toEqual({ session: SESSION_B, queue: ['note-b'], meta: FP_B })
  })

  it('a login reentrantly invalidating the boundary inside the departing teardown is not adopted as the owner', async () => {
    signInA()
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    // A login that has bumped the epoch but not yet published its user.
    const unsubscribe = useEtebaseStore.subscribe(() => { unsubscribe(); bumpAccountEpoch() })

    await useAuthStore.getState().logout()

    // Nothing persistent may be cleared once another operation owns the boundary.
    expect(await persisted()).toEqual(RETAINED_A)
    expect(localStorage.getItem(INVALIDATED)).toBeNull()
  })

  it.each(['duringCacheClear', 'duringQueueClear', 'duringSecureClear'] as const)(
    'account B established while the departing %s is pending keeps its user and new persistent material',
    async (hook) => {
      signInA()
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
      hooks[hook] = async () => {
        hooks[hook] = null
        await establishB()
      }

      await useAuthStore.getState().logout()

      expect(hooks[hook]).toBeNull() // the injection really ran
      expect(useAuthStore.getState().user?.id).toBe(userB.id)
      expect(await persisted()).toEqual(B_PERSISTED)
      expect(localStorage.getItem(INVALIDATED)).toBeNull()
    },
  )

  it('account C established in a microtask queued by the last reset stops the departing persistent cleanup', async () => {
    signInA()
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    const userC = { ...userA, id: 'synthetic-user-C', email: 'c@synthetic.invalid' }
    const realReset = usePreferencesStore.getState().resetSyncedPreferences
    let cPublished = false
    usePreferencesStore.setState({ resetSyncedPreferences: () => {
      realReset()
      if (cPublished) return
      queueMicrotask(() => {
        bumpAccountEpoch()
        useAuthStore.setState({ user: userC, isAuthenticated: true })
        cPublished = true
      })
    } })
    try {
      await useAuthStore.getState().logout()
      expect(cPublished).toBe(true)
      expect(useAuthStore.getState().user?.id).toBe(userC.id)
      expect(await persisted()).toEqual(RETAINED_A)
      expect(localStorage.getItem(INVALIDATED)).toBeNull()
    } finally {
      usePreferencesStore.setState({ resetSyncedPreferences: realReset })
    }
  })

  it('a syncEngine.stop() that re-enters account setup stops every later old-account reset and removal', async () => {
    signInA()
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    const noteB = [{ id: 'synthetic-note-b' }] as never
    useEtebaseStore.setState({ syncEngine: { stop: () => {
      bumpAccountEpoch()
      useAuthStore.setState({ user: userB, isAuthenticated: true })
      useNoteStore.setState({ notes: noteB })
    } } as never })

    await useAuthStore.getState().logout()

    expect(useAuthStore.getState().user?.id).toBe(userB.id)
    expect(useEtebaseStore.getState().accountFingerprint).toBe(FP_A) // teardown did not clear the new owner's store
    expect(useNoteStore.getState().notes).toBe(noteB)
    expect(await persisted()).toEqual(RETAINED_A)
  })

  it('a store subscriber that re-enters account setup stops every later old-account reset and removal', async () => {
    signInA()
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    const noteB = [{ id: 'synthetic-note-b' }] as never
    const unsubscribe = useCalendarStore.subscribe(() => {
      unsubscribe()
      bumpAccountEpoch()
      useAuthStore.setState({ user: userB, isAuthenticated: true })
      useNoteStore.setState({ notes: noteB })
    })

    await useAuthStore.getState().logout()

    expect(useAuthStore.getState().user?.id).toBe(userB.id)
    expect(useNoteStore.getState().notes).toBe(noteB)
    expect(await persisted()).toEqual(RETAINED_A)
  })
})

describe('teardown token contract', () => {
  it('a syncEngine.stop() failure after invalidation exposes the token and cleanup continues', async () => {
    signInA()
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    useEtebaseStore.setState({ syncEngine: { stop: () => { throw new Error('synthetic stop failure') } } as never })
    const before = getAccountEpoch()

    let thrown: unknown
    try { useEtebaseStore.getState().destroy() } catch (err) { thrown = err }
    expect(thrown).toBeInstanceOf(EtebaseTeardownError)
    expect((thrown as EtebaseTeardownError).epoch).toBe(before + 1)

    await useAuthStore.getState().logout()
    expect(await persisted()).toEqual(CLEARED)
  })

  it.each([0, 1, 2])('cleanup and different-user publication hold when teardown bumps %i time(s)', async (bumps) => {
    const realDestroy = useEtebaseStore.getState().destroy
    useEtebaseStore.setState({ destroy: () => {
      let token = getAccountEpoch()
      for (let i = 0; i < bumps; i += 1) token = bumpAccountEpoch()
      useEtebaseStore.setState({ accountFingerprint: null })
      return token
    } })
    try {
      signInA()
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: userB.id, email: userB.email, rememberDevice: true })))
      expect(await useAuthStore.getState().refreshSession()).toBe(true)
      expect(useAuthStore.getState().user?.id).toBe(userB.id)

      fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
      await useAuthStore.getState().logout()
      expect(await persisted()).toEqual(CLEARED)
    } finally {
      useEtebaseStore.setState({ destroy: realDestroy })
    }
  })
})

describe('unguarded callers keep their behaviour', () => {
  it('restoreSession hosted 401 still clears through the unguarded path', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }))
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    await useAuthStore.getState().restoreSession()
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(await persisted()).toEqual(CLEARED)
  })

  it('restoreSession publishes a hosted user after an unguarded reset', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: userA.id, email: userA.email, rememberDevice: true })))
    await useAuthStore.getState().restoreSession()
    expect(useAuthStore.getState().user?.id).toBe(userA.id)
    expect(await persisted()).toEqual(RETAINED_A)
  })
})
