// Logout / invalid-session cleanup with the real auth store, the real Etebase
// store destroy(), real account epochs and real secure-storage, offline-queue
// and data-cache on fake-indexeddb. Only billing /auth/ and /subscription
// fetches and the toast module are stubbed; persistence functions are wrapped
// to observe or inject account switches after the real call completes. All
// data is synthetic.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Each hook runs while the real call it is attached to is still pending.
const hooks = vi.hoisted(() => ({
  duringCacheClear: null as null | (() => Promise<void>),
  duringQueueClear: null as null | (() => Promise<void>),
  duringSecureClear: null as null | (() => Promise<void>),
  duringMigration: null as null | (() => Promise<void>),
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
  return {
    ...real,
    secureClear: async () => { const pending = real.secureClear(); await hooks.duringSecureClear?.(); await pending },
    migrateFromLocalStorage: async (...args: Parameters<typeof real.migrateFromLocalStorage>) => {
      const pending = real.migrateFromLocalStorage(...args)
      await hooks.duringMigration?.()
      await pending
    },
  }
})

import { useAuthStore } from '../use-auth-store'
import { EtebaseTeardownError, useEtebaseStore } from '../use-etebase-store'
import { getMountedNoteEditor, getNoteObligation, markNoteObligation, registerNoteEditor, resetNoteLifecycle, useNoteStore } from '../use-note-store'
import { getContactOwner, hasContactFieldDraft, registerContactOwner, resetContactLifecycle, setContactFieldDraft } from '../use-contact-store'
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
// Only billing /auth/ and /subscription calls are stubbed; module/WASM loading keeps the real loader.
vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  return url.includes('/auth/') || url.endsWith('/subscription') ? fetchMock(input, init) : realFetch(input, init)
})
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
  hooks.duringMigration = null
  vi.restoreAllMocks()
  resetNoteLifecycle()
  resetContactLifecycle()
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

  it('a teardown subscriber that throws without a new account boundary does not stop logout cleanup', async () => {
    signInA()
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    let throws = 0
    const unsubscribe = useEtebaseStore.subscribe(() => {
      throws += 1
      throw new Error('synthetic subscriber failure')
    })
    try {
      await useAuthStore.getState().logout()
      expect(throws).toBeGreaterThan(0)
      expect(await persisted()).toEqual(CLEARED)
      expect(localStorage.getItem(INVALIDATED)).not.toBeNull()

      const before = getAccountEpoch()
      let thrown: unknown
      try { useEtebaseStore.getState().destroy() } catch (err) { thrown = err }
      expect(thrown).toBeInstanceOf(EtebaseTeardownError)
      expect((thrown as EtebaseTeardownError).epoch).toBe(before + 1)
    } finally {
      unsubscribe()
    }
  })

  it('a teardown subscriber that establishes another account and then throws stops the departing cleanup', async () => {
    signInA()
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    const userC = { ...userA, id: 'synthetic-user-C', email: 'c@synthetic.invalid' }
    const unsubscribe = useEtebaseStore.subscribe(() => {
      unsubscribe()
      bumpAccountEpoch()
      useAuthStore.setState({ user: userC, isAuthenticated: true })
      throw new Error('synthetic subscriber failure after account switch')
    })

    await useAuthStore.getState().logout()

    expect(useAuthStore.getState().user?.id).toBe(userC.id)
    expect(await persisted()).toEqual(RETAINED_A)
    expect(localStorage.getItem(INVALIDATED)).toBeNull()
  })

  it('a nested typed teardown failure inside a subscriber is stamped with the outer token, not adopted', async () => {
    signInA()
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    // Logout gives up its user before teardown, so the epoch token is the only ownership signal here.
    const unsubscribe = useEtebaseStore.subscribe(() => {
      unsubscribe()
      useEtebaseStore.setState({ syncEngine: { stop: () => { throw new Error('synthetic nested stop failure') } } as never })
      useEtebaseStore.getState().destroy()
    })
    const before = getAccountEpoch()
    let thrown: unknown
    try { useEtebaseStore.getState().destroy() } catch (err) { thrown = err }
    expect(thrown).toBeInstanceOf(EtebaseTeardownError)
    expect((thrown as EtebaseTeardownError).epoch).toBe(before + 1)
    expect(getAccountEpoch()).toBe(before + 2)
    useEtebaseStore.setState({ syncEngine: null })
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

const USER_C = { ...userA, id: 'synthetic-user-C', email: 'c@synthetic.invalid' }
const CALLERS = ['restoreSession', 'retryBillingConnection'] as const
type Caller = typeof CALLERS[number]

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

/** restoreSession starts signed out at page load; retry starts as degraded account A. */
function startCaller(caller: Caller) {
  if (caller === 'retryBillingConnection') {
    signInA()
    useAuthStore.setState({ subscriptionStatus: 'billing_unavailable' })
  }
  return useAuthStore.getState()[caller]()
}

/** Routes this caller's billing requests; anything else is an unexpected request. */
function routeBilling(refresh: () => Response | Promise<Response>, remove: () => Response | Promise<Response> = () => new Response(null, { status: 204 })) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.endsWith('/auth/refresh')) return refresh()
    if (url.endsWith('/subscription')) return new Response(JSON.stringify({ status: 'active' }))
    if (url.endsWith('/auth/session') && init?.method === 'DELETE') return remove()
    throw new Error(`synthetic unexpected billing request ${url}`)
  })
}

const REFRESH = {
  rejected: () => new Response(null, { status: 401 }),
  unremembered: () => new Response(JSON.stringify({ id: userA.id, email: userA.email, rememberDevice: false })),
  'different-user': () => new Response(JSON.stringify({ id: USER_C.id, email: USER_C.email, rememberDevice: true })),
}

/** Account B's private #744 state, made synchronously in B's epoch. */
function registerBPrivateState() {
  const notes = [{ id: 'synthetic-note-b' }] as never
  useNoteStore.setState({ notes })
  useEtebaseStore.setState({ accountFingerprint: FP_B })
  const editor = { periodGen: () => 1, isClean: () => false, chainIdle: () => true, base: () => ({}) as never, flushAndWait: async () => {} }
  registerNoteEditor('note-b', editor)
  const obligation = markNoteObligation('note-b')
  const contactOwner = registerContactOwner('contact-b')
  setContactFieldDraft('contact-b', contactOwner, true)
  return { epoch: getAccountEpoch(), notes, editor, obligation, contactOwner }
}

async function establishBWithPrivateState() {
  await establishB()
  return registerBPrivateState()
}

function expectBPrivateStateIntact(b: ReturnType<typeof registerBPrivateState>) {
  expect(useAuthStore.getState().user?.id).toBe(userB.id)
  expect(useAuthStore.getState().isAuthenticated).toBe(true)
  expect(getAccountEpoch()).toBe(b.epoch)
  expect(useEtebaseStore.getState().accountFingerprint).toBe(FP_B)
  expect(useNoteStore.getState().notes).toBe(b.notes)
  expect(getMountedNoteEditor('note-b')).toBe(b.editor)
  expect(getNoteObligation('note-b')).toBe(b.obligation)
  expect(getContactOwner('contact-b')).toBe(b.contactOwner)
  expect(hasContactFieldDraft('contact-b')).toBe(true)
}

describe('restoreSession and retryBillingConnection never clear a newly established account', () => {
  it.each(CALLERS.flatMap((caller) => (['rejected', 'unremembered'] as const).map((kind) => [caller, kind] as const)))(
    '%s: account B established while the %s session DELETE is pending keeps its user, private state and persistence',
    async (caller, kind) => {
      const deleting = deferred<void>()
      const remove = deferred<Response>()
      routeBilling(REFRESH[kind], () => { deleting.resolve(); return remove.promise })

      const run = startCaller(caller)
      await deleting.promise
      const b = await establishBWithPrivateState()
      remove.resolve(new Response(null, { status: 204 }))
      await run

      expectBPrivateStateIntact(b)
      expect(await persisted()).toEqual(B_PERSISTED)
      expect(localStorage.getItem(INVALIDATED)).toBeNull()
    },
  )

  it.each(CALLERS.flatMap((caller) => (['rejected', 'different-user'] as const).map((kind) => [caller, kind] as const)))(
    '%s: a late %s refresh response after account B was established changes nothing of B',
    async (caller, kind) => {
      const refreshing = deferred<void>()
      const response = deferred<Response>()
      routeBilling(() => { refreshing.resolve(); return response.promise })

      const run = startCaller(caller)
      await refreshing.promise
      const b = await establishBWithPrivateState()
      response.resolve(REFRESH[kind]())
      await run

      expectBPrivateStateIntact(b)
      expect(await persisted()).toEqual(B_PERSISTED)
      expect(localStorage.getItem(INVALIDATED)).toBeNull()
    },
  )

  it.each(CALLERS)('%s: late refresh JSON for another user after account B was established changes nothing of B', async (caller) => {
    const reading = deferred<void>()
    const body = deferred<unknown>()
    routeBilling(() => ({ ok: true, status: 200, json: () => { reading.resolve(); return body.promise } }) as unknown as Response)

    const run = startCaller(caller)
    await reading.promise
    const b = await establishBWithPrivateState()
    body.resolve({ id: USER_C.id, email: USER_C.email, rememberDevice: true })
    await run

    expectBPrivateStateIntact(b)
    expect(await persisted()).toEqual(B_PERSISTED)
  })

  it.each(CALLERS)('%s: a store subscriber that establishes account B inside the caller\'s own reset stops every later reset and publication', async (caller) => {
    routeBilling(REFRESH['different-user'])
    let b: ReturnType<typeof registerBPrivateState> | undefined
    const unsubscribe = useCalendarStore.subscribe(() => {
      unsubscribe()
      bumpAccountEpoch()
      useAuthStore.setState({ user: userB, isAuthenticated: true })
      b = registerBPrivateState()
    })

    await startCaller(caller)

    expect(b).toBeDefined() // the re-entry really ran
    expectBPrivateStateIntact(b!)
  })

  it('restoreSession: account B established during the local-storage migration keeps everything when the refresh is rejected', async () => {
    routeBilling(REFRESH.rejected)
    let b: ReturnType<typeof registerBPrivateState> | undefined
    hooks.duringMigration = async () => {
      hooks.duringMigration = null
      b = await establishBWithPrivateState()
    }

    await useAuthStore.getState().restoreSession()

    expect(b).toBeDefined() // the injection really ran
    expectBPrivateStateIntact(b!)
    expect(await persisted()).toEqual(B_PERSISTED)
    expect(localStorage.getItem(INVALIDATED)).toBeNull()
  })
})

describe('restoreSession and retryBillingConnection keep their own cleanup and publication', () => {
  it('restoreSession hosted 401 still clears its own material', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }))
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    await useAuthStore.getState().restoreSession()
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(await persisted()).toEqual(CLEARED)
  })

  it('restoreSession publishes a hosted user after its own reset', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: userA.id, email: userA.email, rememberDevice: true })))
    await useAuthStore.getState().restoreSession()
    expect(useAuthStore.getState().user?.id).toBe(userA.id)
    expect(await persisted()).toEqual(RETAINED_A)
  })

  it.each(CALLERS.flatMap((caller) => (['rejected', 'unremembered'] as const).map((kind) => [caller, kind] as const)))(
    '%s: a %s session without a takeover clears its own material and invalidates hosted auth',
    async (caller, kind) => {
      routeBilling(REFRESH[kind])

      await startCaller(caller)

      expect(useAuthStore.getState().user).toBeNull()
      expect(useAuthStore.getState().isAuthenticated).toBe(false)
      expect(useEtebaseStore.getState().accountFingerprint).toBeNull()
      expect(await persisted()).toEqual(CLEARED)
      expect(localStorage.getItem(INVALIDATED)).not.toBeNull()
    },
  )

  it('retryBillingConnection resets departing account A and publishes a different hosted user', async () => {
    routeBilling(REFRESH['different-user'])

    expect(await startCaller('retryBillingConnection')).toBe(true)

    expect(useAuthStore.getState().user?.id).toBe(USER_C.id)
    expect(useAuthStore.getState().subscriptionStatus).toBe('active')
    expect(useEtebaseStore.getState().accountFingerprint).toBeNull()
    expect(await persisted()).toEqual(RETAINED_A)
  })
})
