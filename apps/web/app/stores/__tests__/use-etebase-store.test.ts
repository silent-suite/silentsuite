import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useEtebaseStore } from '../use-etebase-store'
import { useCalendarStore } from '../use-calendar-store'
import { useCalendarListStore } from '../use-calendar-list-store'
import { useTaskListStore } from '../use-task-list-store'
import { useContactListStore } from '../use-contact-list-store'
import { useNotebookStore } from '../use-notebook-store'
import { AccountBoundaryChangedError, bumpAccountEpoch } from '@/app/lib/account-epoch'

const offlineQueueMock = vi.hoisted(() => ({
  enqueue: vi.fn(async () => {}),
  getAll: vi.fn(async () => []),
  remove: vi.fn(async () => {}),
  removeItemMutations: vi.fn(async () => 0),
  isOfflineError: vi.fn(() => false),
}))

const coreMock = vi.hoisted(() => ({
  restoreSession: vi.fn(),
  getAccountFingerprint: vi.fn(),
  listCollections: vi.fn(),
  createCollection: vi.fn(),
  listItems: vi.fn(),
  isMarkdownNoteItem: vi.fn(() => true),
  SyncEngine: vi.fn(),
  createItem: vi.fn(),
  deleteItem: vi.fn(),
  updateCollectionMeta: vi.fn(),
  updateItem: vi.fn(),
  listIncomingInvitations: vi.fn(),
  listOutgoingInvitations: vi.fn(),
  cancelOutgoingInvitation: vi.fn(),
  acceptInvitation: vi.fn(),
  rejectInvitation: vi.fn(),
  inviteToCollection: vi.fn(),
  listCollectionMembers: vi.fn(),
  removeCollectionMember: vi.fn(),
  leaveCollection: vi.fn(),
  modifyCollectionMemberAccess: vi.fn(),
}))

const toastStoreMock = vi.hoisted(() => ({
  showErrorToast: vi.fn(),
}))

const dataCacheMock = vi.hoisted(() => ({
  ensureEncryptedEnvelope: vi.fn(async () => true),
  ensureFingerprint: vi.fn(async () => true),
  getCacheCapabilityStatus: vi.fn(() => ({ featureFlagEnabled: false, encryptedEnvelopeAvailable: false, enabled: false })),
  getStoken: vi.fn(async () => null),
  setStoken: vi.fn(async () => {}),
  putItems: vi.fn(async () => {}),
  putItem: vi.fn(async () => {}),
  deleteItem: vi.fn(async () => {}),
  replaceItemsForCollection: vi.fn(async () => {}),
  isCacheEnabled: vi.fn(() => false),
}))

// Stub the offline queue so isOfflineError + enqueue don't try to open IndexedDB.
vi.mock('@/app/lib/offline-queue', () => offlineQueueMock)

vi.mock('@silentsuite/core', () => coreMock)

vi.mock('@/app/stores/use-label-suggestions-store', () => ({
  useLabelSuggestionsStore: {
    getState: () => ({ recordUsage: vi.fn(async () => {}) }),
  },
}))

vi.mock('@/app/lib/secure-storage', () => ({
  secureGet: vi.fn(async () => null),
  secureSet: vi.fn(async () => {}),
  secureRemove: vi.fn(async () => {}),
  secureClear: vi.fn(async () => {}),
  migrateFromLocalStorage: vi.fn(async () => {}),
}))

vi.mock('@/app/stores/use-toast-store', () => toastStoreMock)

vi.mock('@/app/lib/data-cache', () => dataCacheMock)

beforeEach(() => {
  offlineQueueMock.enqueue.mockClear()
  offlineQueueMock.getAll.mockReset().mockResolvedValue([])
  offlineQueueMock.remove.mockClear()
  offlineQueueMock.removeItemMutations.mockReset().mockResolvedValue(0)
  offlineQueueMock.isOfflineError.mockReset().mockReturnValue(false)
  coreMock.listCollections.mockReset()
  coreMock.createCollection.mockReset()
  coreMock.restoreSession.mockReset()
  coreMock.getAccountFingerprint.mockReset()
  coreMock.listItems.mockReset()
  coreMock.isMarkdownNoteItem.mockReset().mockReturnValue(true)
  coreMock.SyncEngine.mockReset()
  coreMock.createItem.mockReset()
  coreMock.deleteItem.mockReset()
  coreMock.updateCollectionMeta.mockReset()
  coreMock.updateItem.mockReset()
  coreMock.listIncomingInvitations.mockReset()
  coreMock.listOutgoingInvitations.mockReset()
  coreMock.cancelOutgoingInvitation.mockReset()
  coreMock.acceptInvitation.mockReset()
  coreMock.rejectInvitation.mockReset()
  coreMock.inviteToCollection.mockReset()
  coreMock.listCollectionMembers.mockReset()
  coreMock.removeCollectionMember.mockReset()
  coreMock.leaveCollection.mockReset()
  coreMock.modifyCollectionMemberAccess.mockReset()
  toastStoreMock.showErrorToast.mockReset()
  dataCacheMock.ensureEncryptedEnvelope.mockReset().mockResolvedValue(true)
  dataCacheMock.ensureFingerprint.mockReset().mockResolvedValue(true)
  dataCacheMock.getCacheCapabilityStatus.mockReset().mockReturnValue({ featureFlagEnabled: false, encryptedEnvelopeAvailable: false, enabled: false })
  dataCacheMock.getStoken.mockReset().mockResolvedValue(null)
  dataCacheMock.setStoken.mockReset().mockResolvedValue(undefined)
  dataCacheMock.putItems.mockReset().mockResolvedValue(undefined)
  dataCacheMock.putItem.mockReset().mockResolvedValue(undefined)
  dataCacheMock.deleteItem.mockReset().mockResolvedValue(undefined)
  dataCacheMock.replaceItemsForCollection.mockReset().mockResolvedValue(undefined)
  dataCacheMock.isCacheEnabled.mockReset().mockReturnValue(false)
  useEtebaseStore.setState({ accountFingerprint: 'test-account-fingerprint' })
  sessionStorage.clear()
})

interface MockItemManager {
  create: ReturnType<typeof vi.fn>
  batch: ReturnType<typeof vi.fn>
}

interface MockSyncEngine {
  pause: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
}

function mockItem(uid: string, content: string, isDeleted = false) {
  return {
    uid,
    isDeleted,
    getContent: vi.fn(async () => content),
  }
}

function loadedDomainLoadState() {
  return { calendar: 'loaded' as const, tasks: 'loaded' as const, contacts: 'loaded' as const, notes: 'loaded' as const, preferences: 'unknown' as const }
}

function unknownDomainLoadState() {
  return { calendar: 'unknown' as const, tasks: 'unknown' as const, contacts: 'unknown' as const, notes: 'unknown' as const, preferences: 'unknown' as const }
}

function mockCollection(uid: string, meta: Record<string, string> = {}) {
  return {
    uid,
    getMeta: vi.fn(() => meta),
  }
}

function setupStoreWithMocks(itemManager: MockItemManager, syncEngine: MockSyncEngine) {
  const collection = { uid: 'col-1' }
  const account = {
    getCollectionManager: () => ({
      getItemManager: () => itemManager,
    }),
  }
  useEtebaseStore.setState({
    account: account as any,
    collections: { calendar: [collection as any], tasks: [], contacts: [], notes: [], preferences: [] },
    itemCache: new Map(),
    itemTypeMap: new Map(),
    itemCollectionMap: new Map(),
    isInitialized: true,
    domainLoadState: loadedDomainLoadState(),
    syncEngine: syncEngine as any,
  })
}

function setupStoreWithCollections(itemManagerByUid: Record<string, MockItemManager>, syncEngine: MockSyncEngine) {
  const collections = [{ uid: 'col-1' }, { uid: 'col-2' }]
  const account = {
    getCollectionManager: () => ({
      getItemManager: (collection: { uid: string }) => itemManagerByUid[collection.uid],
    }),
  }
  useEtebaseStore.setState({
    account: account as any,
    collections: { calendar: collections as any[], tasks: [], contacts: [], notes: [], preferences: [] },
    itemCache: new Map(),
    itemTypeMap: new Map(),
    itemCollectionMap: new Map(),
    isInitialized: true,
    domainLoadState: loadedDomainLoadState(),
    syncEngine: syncEngine as any,
  })
}

describe('useEtebaseStore.initialize restore diagnostics', () => {
  beforeEach(() => {
    useEtebaseStore.setState({
      account: null,
      collections: { calendar: [], tasks: [], contacts: [], notes: [], preferences: [] },
      itemCache: new Map(),
      itemTypeMap: new Map(),
      itemCollectionMap: new Map(),
      isInitialized: false,
      syncEngine: null,
    })
  })

  it('records a redacted failed restoreSession phase diagnostic', async () => {
    const { secureGet } = await import('@/app/lib/secure-storage')
    vi.mocked(secureGet).mockResolvedValueOnce('raw-session-secret')
    coreMock.restoreSession.mockRejectedValueOnce(new Error('raw-session-secret user@example.com'))

    await useEtebaseStore.getState().initialize()

    const raw = sessionStorage.getItem('silentsuite.restore-diagnostics.v1') ?? ''
    expect(raw).toContain('"phase":"restoreSession"')
    expect(raw).toContain('"status":"failed"')
    expect(raw).toContain('"errorName":"Error"')
    expect(raw).not.toContain('raw-session-secret')
    expect(raw).not.toContain('user@example.com')
    expect(toastStoreMock.showErrorToast).toHaveBeenCalledWith('Failed to restore session. Please try signing in again.')
  })

  it('records a failed sessionRead phase diagnostic when secure session read throws', async () => {
    const { secureGet } = await import('@/app/lib/secure-storage')
    vi.mocked(secureGet).mockRejectedValueOnce(new Error('raw-session-secret user@example.com'))

    await useEtebaseStore.getState().initialize()

    const raw = sessionStorage.getItem('silentsuite.restore-diagnostics.v1') ?? ''
    expect(raw).toContain('"phase":"sessionRead"')
    expect(raw).toContain('"status":"failed"')
    expect(raw).toContain('"failedPhase":"sessionRead"')
    expect(raw).not.toContain('raw-session-secret')
    expect(raw).not.toContain('user@example.com')
    expect(toastStoreMock.showErrorToast).toHaveBeenCalledWith('Failed to restore session. Please try signing in again.')
  })

  it('does not publish initialization failure state when an old secure read rejects after an account boundary', async () => {
    const { secureGet } = await import('@/app/lib/secure-storage')
    let rejectRead!: (error: Error) => void
    let markReadStarted!: () => void
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve
    })
    vi.mocked(secureGet).mockImplementationOnce(() => {
      markReadStarted()
      return new Promise((_resolve, reject) => {
        rejectRead = reject
      })
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const initialize = useEtebaseStore.getState().initialize()
    await readStarted
    bumpAccountEpoch()
    useEtebaseStore.setState({ isInitialized: false, restoreBlocked: false })
    rejectRead(new Error('old account read failed'))
    await initialize

    expect(useEtebaseStore.getState().isInitialized).toBe(false)
    expect(useEtebaseStore.getState().restoreBlocked).toBe(false)
    expect(sessionStorage.getItem('silentsuite.restore-diagnostics.v1')).toBeNull()
    expect(toastStoreMock.showErrorToast).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})

describe('useEtebaseStore.initialize restoreBlocked flag', () => {
  beforeEach(() => {
    useEtebaseStore.setState({
      account: null,
      collections: { calendar: [], tasks: [], contacts: [], notes: [], preferences: [] },
      itemCache: new Map(),
      itemTypeMap: new Map(),
      itemCollectionMap: new Map(),
      isInitialized: false,
      restoreBlocked: false,
      syncEngine: null,
    })
  })

  async function getSecureStorage() {
    return import('@/app/lib/secure-storage')
  }

  it('defaults restoreBlocked to false', () => {
    expect(useEtebaseStore.getState().restoreBlocked).toBe(false)
  })

  it('sets restoreBlocked when there is no saved session, without toast or removal', async () => {
    const { secureGet, secureRemove } = await getSecureStorage()
    vi.mocked(secureGet).mockResolvedValueOnce(null)

    await useEtebaseStore.getState().initialize()

    expect(useEtebaseStore.getState().restoreBlocked).toBe(true)
    expect(toastStoreMock.showErrorToast).not.toHaveBeenCalled()
    expect(vi.mocked(secureRemove)).not.toHaveBeenCalled()
  })

  it('sets restoreBlocked on a non-offline restoreSession failure and preserves the session', async () => {
    const { secureGet, secureRemove } = await getSecureStorage()
    vi.mocked(secureGet).mockResolvedValueOnce('raw-session')
    coreMock.restoreSession.mockRejectedValueOnce(new Error('bad session blob'))
    offlineQueueMock.isOfflineError.mockReturnValue(false)

    await useEtebaseStore.getState().initialize()

    const state = useEtebaseStore.getState()
    expect(state.restoreBlocked).toBe(true)
    expect(state.isInitialized).toBe(true)
    expect(vi.mocked(secureRemove)).not.toHaveBeenCalled()
    expect(toastStoreMock.showErrorToast).toHaveBeenCalledWith(
      'Failed to restore session. Please try signing in again.',
    )
  })

  it('does NOT set restoreBlocked on an offline restore error, and shows no toast', async () => {
    const { secureGet } = await getSecureStorage()
    vi.mocked(secureGet).mockResolvedValueOnce('raw-session')
    coreMock.restoreSession.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    offlineQueueMock.isOfflineError.mockReturnValue(true)

    await useEtebaseStore.getState().initialize()

    expect(useEtebaseStore.getState().restoreBlocked).toBe(false)
    expect(toastStoreMock.showErrorToast).not.toHaveBeenCalled()
  })

  it('does NOT set restoreBlocked when a post-restore listItems phase fails (Slice 3 boundary)', async () => {
    const { secureGet } = await getSecureStorage()
    vi.mocked(secureGet).mockResolvedValueOnce('raw-session')
    coreMock.restoreSession.mockResolvedValueOnce({ id: 'account' })
    coreMock.getAccountFingerprint.mockReturnValueOnce('fingerprint')
    coreMock.listCollections.mockImplementation(async () => [mockCollection('col-1')])
    coreMock.listItems
      .mockRejectedValueOnce(new Error('server 500 on listItems'))
      .mockResolvedValue({ items: [], stoken: null, done: true })
    coreMock.SyncEngine.mockImplementation(function (this: any) {
      this.trackCollection = vi.fn()
      this.onStokenAdvance = vi.fn()
      this.start = vi.fn(async () => {})
    })
    offlineQueueMock.isOfflineError.mockReturnValue(false)

    await useEtebaseStore.getState().initialize()

    const state = useEtebaseStore.getState()
    // restoreSession succeeded; the failure is in listItems:calendar, which is a
    // Slice 3 concern, NOT an unlock case.
    expect(state.restoreBlocked).toBe(false)
    expect(state.isInitialized).toBe(true)
    expect(state.domainLoadState).toMatchObject({ calendar: 'failed', tasks: 'loaded', contacts: 'loaded', notes: 'loaded' })
    expect(state.syncEngine).toBeTruthy()
  })

  it('leaves restoreBlocked false on a fully successful restore', async () => {
    const { secureGet } = await getSecureStorage()
    vi.mocked(secureGet).mockResolvedValueOnce('raw-session')
    coreMock.restoreSession.mockResolvedValueOnce({ id: 'account' })
    coreMock.getAccountFingerprint.mockReturnValueOnce('fingerprint')
    coreMock.listCollections.mockImplementation(async () => [mockCollection('col-1')])
    coreMock.listItems.mockResolvedValue({ items: [], stoken: null, done: true })
    coreMock.SyncEngine.mockImplementation(function (this: any) {
      this.trackCollection = vi.fn()
      this.onStokenAdvance = vi.fn()
      this.start = vi.fn(async () => {})
    })

    await useEtebaseStore.getState().initialize()

    const state = useEtebaseStore.getState()
    expect(state.restoreBlocked).toBe(false)
    expect(state.isInitialized).toBe(true)
    expect(state.domainLoadState).toMatchObject({ calendar: 'loaded', tasks: 'loaded', contacts: 'loaded', notes: 'loaded' })
    expect(toastStoreMock.showErrorToast).not.toHaveBeenCalled()
  })

  it('resets restoreBlocked to false on destroy()', async () => {
    const { secureGet } = await getSecureStorage()
    vi.mocked(secureGet).mockResolvedValueOnce(null)
    await useEtebaseStore.getState().initialize()
    expect(useEtebaseStore.getState().restoreBlocked).toBe(true)

    useEtebaseStore.getState().destroy()

    expect(useEtebaseStore.getState().restoreBlocked).toBe(false)
    expect(useEtebaseStore.getState().domainLoadState).toEqual(unknownDomainLoadState())
  })
})

describe('useEtebaseStore.initialize incremental domain loading', () => {
  beforeEach(() => {
    useEtebaseStore.setState({
      account: null,
      collections: { calendar: [], tasks: [], contacts: [], notes: [], preferences: [] },
      itemCache: new Map(),
      itemTypeMap: new Map(),
      itemCollectionMap: new Map(),
      isInitialized: false,
      restoreBlocked: false,
      domainLoadState: unknownDomainLoadState(),
      syncEngine: null,
    })
  })

  function mockSuccessfulSyncEngine() {
    coreMock.SyncEngine.mockImplementation(function (this: any) {
      this.trackCollection = vi.fn()
      this.onStokenAdvance = vi.fn()
      this.start = vi.fn(async () => {})
    })
  }

  async function primeSuccessfulRestore() {
    const { secureGet } = await import('@/app/lib/secure-storage')
    vi.mocked(secureGet).mockResolvedValueOnce('raw-session')
    coreMock.restoreSession.mockResolvedValueOnce({ id: 'account' })
    coreMock.getAccountFingerprint.mockReturnValueOnce('fingerprint')
    coreMock.listCollections.mockImplementation(async (_account: unknown, colType: string) => {
      if (colType === 'etebase.vevent') return [mockCollection('cal-1')]
      if (colType === 'etebase.vtodo') return [mockCollection('task-1')]
      if (colType === 'etebase.vcard') return [mockCollection('contact-1')]
      if (colType === 'etebase.md.note') return [mockCollection('note-1')]
      return []
    })
    mockSuccessfulSyncEngine()
  }

  it('quietly cancels deferred initial item enumeration after an account boundary', async () => {
    await primeSuccessfulRestore()
    let resolveList!: (value: { items: any[]; stoken: null; done: boolean }) => void
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    coreMock.listItems.mockImplementationOnce(() => {
      markStarted()
      return new Promise((resolve) => { resolveList = resolve })
    })
    const onDomainLoaded = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const initialize = useEtebaseStore.getState().initialize({ onDomainLoaded })
    await started
    bumpAccountEpoch()
    useEtebaseStore.setState({
      account: { id: 'new-account' },
      itemCache: new Map(),
      itemTypeMap: new Map(),
      itemCollectionMap: new Map(),
      domainLoadState: unknownDomainLoadState(),
      isInitialized: false,
    })
    sessionStorage.removeItem('silentsuite.restore-diagnostics.v1')
    resolveList({ items: [mockItem('old-private-item', 'PRIVATE_OLD_PLAINTEXT')], stoken: null, done: true })
    await initialize

    expect(warnSpy).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('silentsuite.restore-diagnostics.v1')).toBeNull()
    expect(onDomainLoaded).not.toHaveBeenCalled()
    expect(useEtebaseStore.getState().itemCache.size).toBe(0)
    expect(useEtebaseStore.getState().isInitialized).toBe(false)
    warnSpy.mockRestore()
  })

  it('invokes onDomainLoaded in calendar → tasks → contacts order with completed state visible', async () => {
    await primeSuccessfulRestore()
    coreMock.listItems.mockImplementation(async (_account: unknown, collection: { uid: string }) => {
      if (collection.uid === 'cal-1') return { items: [mockItem('event-1', 'VEVENT')], stoken: null, done: true }
      if (collection.uid === 'task-1') return { items: [mockItem('task-item-1', 'VTODO')], stoken: null, done: true }
      if (collection.uid === 'note-1') return { items: [mockItem('note-item-1', '# Hello')], stoken: null, done: true }
      return { items: [mockItem('contact-item-1', 'VCARD')], stoken: null, done: true }
    })

    const events: { type: string; status: string }[] = []
    let calendarItemsAtCalendarCallback = -1
    let calendarStatusAtCalendarCallback = 'unseen'
    await useEtebaseStore.getState().initialize({
      onDomainLoaded: (event) => {
        events.push({ type: event.type, status: event.status })
        if (event.type === 'calendar') {
          const state = useEtebaseStore.getState()
          calendarItemsAtCalendarCallback = state.itemCache.size
          calendarStatusAtCalendarCallback = state.domainLoadState.calendar
        }
      },
    })

    expect(events.map((e) => `${e.type}:${e.status}`)).toEqual([
      'calendar:loaded',
      'tasks:loaded',
      'contacts:loaded',
      'notes:loaded',
    ])
    // Calendar was published as loaded, with its item already in the cache,
    // before tasks/contacts were enumerated.
    expect(calendarStatusAtCalendarCallback).toBe('loaded')
    expect(calendarItemsAtCalendarCallback).toBe(1)
    expect(useEtebaseStore.getState().isInitialized).toBe(true)
  })

  it('ignores SyncEngine stoken callbacks from an old account epoch', async () => {
    await primeSuccessfulRestore()
    coreMock.listItems.mockResolvedValue({ items: [], stoken: null, done: true })
    dataCacheMock.isCacheEnabled.mockReturnValue(true)
    let stokenHandler!: (event: { collectionType: string; collectionUid: string; stoken: string | null }) => void
    coreMock.SyncEngine.mockImplementation(function (this: any) {
      this.trackCollection = vi.fn()
      this.onStokenAdvance = vi.fn((handler) => {
        stokenHandler = handler
      })
      this.start = vi.fn(async () => {})
    })

    await useEtebaseStore.getState().initialize()
    expect(stokenHandler).toBeTruthy()
    dataCacheMock.setStoken.mockClear()

    bumpAccountEpoch()
    stokenHandler({ collectionType: 'etebase.vevent', collectionUid: 'old-calendar', stoken: 'old-stoken' })
    await Promise.resolve()

    expect(dataCacheMock.setStoken).not.toHaveBeenCalled()
  })

  it('marks a failed domain without aborting later domains and still starts sync', async () => {
    await primeSuccessfulRestore()
    coreMock.listItems.mockImplementation(async (_account: unknown, collection: { uid: string }) => {
      if (collection.uid === 'task-1') throw new Error('server 500 on tasks')
      return { items: [], stoken: null, done: true }
    })

    const events: string[] = []
    await useEtebaseStore.getState().initialize({
      onDomainLoaded: (event) => {
        events.push(`${event.type}:${event.status}`)
      },
    })

    expect(events).toEqual(['calendar:loaded', 'tasks:failed', 'contacts:loaded', 'notes:loaded'])
    const state = useEtebaseStore.getState()
    expect(state.domainLoadState).toMatchObject({ calendar: 'loaded', tasks: 'failed', contacts: 'loaded', notes: 'loaded' })
    expect(state.restoreBlocked).toBe(false)
    expect(state.isInitialized).toBe(true)
    expect(state.syncEngine).toBeTruthy()
  })

  it('preserves calendar map mutations made during early paint while slower domains continue loading', async () => {
    await primeSuccessfulRestore()
    const originalCalendarItem = mockItem('event-1', 'VEVENT')
    const userCreatedCalendarItem = mockItem('event-user', 'VEVENT')
    coreMock.listItems.mockImplementation(async (_account: unknown, collection: { uid: string }) => {
      if (collection.uid === 'cal-1') return { items: [originalCalendarItem], stoken: null, done: true }
      if (collection.uid === 'task-1') return { items: [mockItem('task-1', 'VTODO')], stoken: null, done: true }
      if (collection.uid === 'contact-1') return { items: [mockItem('contact-1', 'VCARD')], stoken: null, done: true }
      return { items: [], stoken: null, done: true }
    })

    await useEtebaseStore.getState().initialize({
      onDomainLoaded: (event) => {
        if (event.type !== 'calendar') return
        const itemCache = new Map(useEtebaseStore.getState().itemCache)
        const itemTypeMap = new Map(useEtebaseStore.getState().itemTypeMap)
        const itemCollectionMap = new Map(useEtebaseStore.getState().itemCollectionMap)
        itemCache.delete('event-1')
        itemTypeMap.delete('event-1')
        itemCollectionMap.delete('event-1')
        itemCache.set('event-user', userCreatedCalendarItem)
        itemTypeMap.set('event-user', 'calendar')
        itemCollectionMap.set('event-user', 'cal-1')
        useEtebaseStore.setState({ itemCache, itemTypeMap, itemCollectionMap })
      },
    })

    const finalState = useEtebaseStore.getState()
    expect(finalState.itemCache.has('event-1')).toBe(false)
    expect(finalState.itemCache.get('event-user')).toBe(userCreatedCalendarItem)
    expect(finalState.itemTypeMap.get('event-user')).toBe('calendar')
    expect(finalState.itemCollectionMap.get('event-user')).toBe('cal-1')
    expect(finalState.itemTypeMap.get('task-1')).toBe('tasks')
    expect(finalState.itemTypeMap.get('contact-1')).toBe('contacts')
  })

  it('emits only privacy-safe aggregate fields in the domain event payload', async () => {
    await primeSuccessfulRestore()
    coreMock.listItems.mockImplementation(async (_account: unknown, collection: { uid: string }) => {
      if (collection.uid === 'cal-1') return { items: [mockItem('event-1', 'VEVENT')], stoken: null, done: true }
      return { items: [], stoken: null, done: true }
    })

    const captured: Record<string, unknown>[] = []
    await useEtebaseStore.getState().initialize({
      onDomainLoaded: (event) => {
        captured.push({ ...event })
      },
    })

    expect(captured).toHaveLength(4)
    for (const event of captured) {
      expect(Object.keys(event).sort()).toEqual([
        'collectionCount',
        'itemCount',
        'pageCount',
        'status',
        'type',
      ])
      expect(typeof event.itemCount).toBe('number')
      expect(typeof event.pageCount).toBe('number')
      expect(typeof event.collectionCount).toBe('number')
    }
    const calendarEvent = captured.find((e) => e.type === 'calendar')
    expect(calendarEvent).toMatchObject({ type: 'calendar', status: 'loaded', itemCount: 1, collectionCount: 1 })
  })

  it('hydrates local cache only after fingerprint survives and envelope is available', async () => {
    await primeSuccessfulRestore()
    dataCacheMock.getCacheCapabilityStatus.mockReturnValue({ featureFlagEnabled: true, encryptedEnvelopeAvailable: false, enabled: false })
    dataCacheMock.isCacheEnabled.mockReturnValueOnce(false).mockReturnValue(true)
    dataCacheMock.ensureFingerprint.mockResolvedValueOnce(true)
    dataCacheMock.ensureEncryptedEnvelope.mockResolvedValueOnce(true)
    coreMock.listItems.mockResolvedValue({ items: [], stoken: null, done: true })

    const calls: string[] = []
    await useEtebaseStore.getState().initialize({
      onCacheHydrate: () => calls.push('cacheHydrate'),
      onDomainLoaded: (event) => calls.push(`domain:${event.type}`),
    })

    expect(dataCacheMock.ensureFingerprint).toHaveBeenCalledWith('fingerprint', expect.any(Number))
    expect(dataCacheMock.ensureEncryptedEnvelope).toHaveBeenCalledWith(expect.any(Number))
    expect(calls).toEqual(['cacheHydrate', 'domain:calendar', 'domain:tasks', 'domain:contacts', 'domain:notes'])
  })

  it('restores the encrypted replay envelope when the general cache flag is disabled', async () => {
    await primeSuccessfulRestore()
    dataCacheMock.getCacheCapabilityStatus.mockReturnValue({
      featureFlagEnabled: false,
      encryptedEnvelopeAvailable: false,
      enabled: false,
    })
    coreMock.listItems.mockResolvedValue({ items: [], stoken: null, done: true })
    const onCacheHydrate = vi.fn()

    await useEtebaseStore.getState().initialize({ onCacheHydrate })

    expect(dataCacheMock.ensureFingerprint).toHaveBeenCalledWith('fingerprint', expect.any(Number))
    expect(dataCacheMock.ensureEncryptedEnvelope).toHaveBeenCalledWith(expect.any(Number))
    expect(onCacheHydrate).not.toHaveBeenCalled()
  })

  it('does not hydrate local cache when fingerprint mismatch wipes stale cache', async () => {
    await primeSuccessfulRestore()
    dataCacheMock.getCacheCapabilityStatus.mockReturnValue({ featureFlagEnabled: true, encryptedEnvelopeAvailable: false, enabled: false })
    dataCacheMock.isCacheEnabled.mockReturnValueOnce(false).mockReturnValue(true)
    dataCacheMock.ensureFingerprint.mockResolvedValueOnce(false)
    dataCacheMock.ensureEncryptedEnvelope.mockResolvedValueOnce(true)
    coreMock.listItems.mockResolvedValue({ items: [], stoken: null, done: true })

    const onCacheHydrate = vi.fn()
    await useEtebaseStore.getState().initialize({ onCacheHydrate })

    expect(dataCacheMock.ensureFingerprint).toHaveBeenCalledWith('fingerprint', expect.any(Number))
    expect(dataCacheMock.ensureEncryptedEnvelope).toHaveBeenCalledWith(expect.any(Number))
    expect(onCacheHydrate).not.toHaveBeenCalled()
    expect(useEtebaseStore.getState().isInitialized).toBe(true)
  })

  it('continues restore when encrypted cache envelope setup fails', async () => {
    await primeSuccessfulRestore()
    dataCacheMock.getCacheCapabilityStatus.mockReturnValue({ featureFlagEnabled: true, encryptedEnvelopeAvailable: false, enabled: false })
    dataCacheMock.ensureFingerprint.mockResolvedValueOnce(true)
    dataCacheMock.ensureEncryptedEnvelope.mockRejectedValueOnce(new Error('quota'))
    coreMock.listItems.mockResolvedValue({ items: [], stoken: null, done: true })

    const onCacheHydrate = vi.fn()
    await useEtebaseStore.getState().initialize({ onCacheHydrate })

    expect(onCacheHydrate).not.toHaveBeenCalled()
    expect(useEtebaseStore.getState().isInitialized).toBe(true)
    expect(useEtebaseStore.getState().domainLoadState).toMatchObject({ calendar: 'loaded', tasks: 'loaded', contacts: 'loaded', notes: 'loaded' })
  })

  it('quietly cancels cache setup after an account boundary without logging or hydrating', async () => {
    await primeSuccessfulRestore()
    dataCacheMock.getCacheCapabilityStatus.mockReturnValue({ featureFlagEnabled: true, encryptedEnvelopeAvailable: false, enabled: false })
    let releaseFingerprint!: () => void
    dataCacheMock.ensureFingerprint.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      releaseFingerprint = () => resolve(true)
    }))
    const onCacheHydrate = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const initialize = useEtebaseStore.getState().initialize({ onCacheHydrate })
    await vi.waitFor(() => expect(dataCacheMock.ensureFingerprint).toHaveBeenCalled())
    bumpAccountEpoch()
    releaseFingerprint()
    await initialize

    expect(dataCacheMock.ensureEncryptedEnvelope).not.toHaveBeenCalled()
    expect(onCacheHydrate).not.toHaveBeenCalled()
    expect(coreMock.listCollections).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('does not create default collections when the account changes during listing', async () => {
    await primeSuccessfulRestore()
    let releaseList!: (collections: unknown[]) => void
    coreMock.listCollections.mockImplementationOnce(() => new Promise((resolve) => { releaseList = resolve }))
    const onCacheHydrate = vi.fn()

    const initialize = useEtebaseStore.getState().initialize({ onCacheHydrate })
    await vi.waitFor(() => expect(coreMock.listCollections).toHaveBeenCalledTimes(1))
    bumpAccountEpoch()
    releaseList([])
    await initialize

    expect(coreMock.createCollection).not.toHaveBeenCalled()
    expect(coreMock.listCollections).toHaveBeenCalledTimes(1)
    expect(onCacheHydrate).not.toHaveBeenCalled()
  })

  it('remains backwards-compatible when called with no options', async () => {
    await primeSuccessfulRestore()
    coreMock.listItems.mockResolvedValue({ items: [], stoken: null, done: true })

    await useEtebaseStore.getState().initialize()

    const state = useEtebaseStore.getState()
    expect(state.isInitialized).toBe(true)
    expect(state.domainLoadState).toMatchObject({ calendar: 'loaded', tasks: 'loaded', contacts: 'loaded', notes: 'loaded' })
  })
})

describe('useEtebaseStore nested offline queue boundary errors', () => {
  it('quietly cancels a stale nested enqueue rejection', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    coreMock.createItem.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    offlineQueueMock.isOfflineError.mockReturnValue(true)
    offlineQueueMock.enqueue.mockRejectedValueOnce(new AccountBoundaryChangedError())
    useEtebaseStore.setState({
      account: { id: 'old' } as any,
      accountFingerprint: 'old-fingerprint',
      collections: { calendar: [{ uid: 'old-calendar' }] as any[], tasks: [], contacts: [], notes: [], preferences: [] },
    })

    await expect(useEtebaseStore.getState().createItem('calendar', 'OLD', 'old-temp')).resolves.toBeNull()

    expect(offlineQueueMock.enqueue).toHaveBeenCalledWith(expect.objectContaining({ tempId: 'old-temp' }), {
      accountEpoch: expect.any(Number),
      accountFingerprint: 'old-fingerprint',
    })
    expect(errorSpy).not.toHaveBeenCalled()
    expect(toastStoreMock.showErrorToast).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})

describe('useEtebaseStore.createItemsBatch', () => {
  beforeEach(() => {
    offlineQueueMock.enqueue.mockClear()
    offlineQueueMock.getAll.mockReset().mockResolvedValue([])
    offlineQueueMock.remove.mockClear()
    offlineQueueMock.isOfflineError.mockReset().mockReturnValue(false)
    useCalendarStore.setState({
      events: [],
      isLoading: false,
      syncStatus: 'synced',
      currentView: 'week',
      currentDate: new Date('2026-01-01T00:00:00Z'),
      selectedEventId: null,
    })
    useEtebaseStore.setState({
      account: null,
      collections: { calendar: [], tasks: [], contacts: [], notes: [], preferences: [] },
      itemCache: new Map(),
      itemTypeMap: new Map(),
      itemCollectionMap: new Map(),
      isInitialized: false,
      syncEngine: null,
    })
  })

  it('uploads items in batches of 20 (not 50)', async () => {
    let nextUid = 0
    const itemManager: MockItemManager = {
      create: vi.fn(async () => ({ uid: `item-${nextUid++}` })),
      batch: vi.fn(async () => {}),
    }
    const syncEngine: MockSyncEngine = { pause: vi.fn(), resume: vi.fn() }
    setupStoreWithMocks(itemManager, syncEngine)

    const contents = Array.from({ length: 50 }, (_, i) => ({
      content: `c${i}`,
      tempId: `t${i}`,
    }))
    const uids = await useEtebaseStore.getState().createItemsBatch('calendar', contents)

    // 50 items / 20-per-batch = 3 batches (20, 20, 10)
    expect(itemManager.batch).toHaveBeenCalledTimes(3)
    expect(itemManager.batch.mock.calls[0]![0]).toHaveLength(20)
    expect(itemManager.batch.mock.calls[1]![0]).toHaveLength(20)
    expect(itemManager.batch.mock.calls[2]![0]).toHaveLength(10)
    expect(uids.filter((u) => u !== null)).toHaveLength(50)
  })

  it('pauses the sync engine for the duration of the import', async () => {
    const itemManager: MockItemManager = {
      create: vi.fn(async () => ({ uid: 'x' })),
      batch: vi.fn(async () => {}),
    }
    const syncEngine: MockSyncEngine = { pause: vi.fn(), resume: vi.fn() }
    setupStoreWithMocks(itemManager, syncEngine)

    await useEtebaseStore.getState().createItemsBatch('calendar', [
      { content: 'a', tempId: 't1' },
    ])

    expect(syncEngine.pause).toHaveBeenCalledTimes(1)
    expect(syncEngine.resume).toHaveBeenCalledTimes(1)
  })

  it('routes batch creates to the requested collection uid', async () => {
    const firstManager: MockItemManager = {
      create: vi.fn(async () => ({ uid: 'wrong' })),
      batch: vi.fn(async () => {}),
    }
    const secondManager: MockItemManager = {
      create: vi.fn(async () => ({ uid: 'right' })),
      batch: vi.fn(async () => {}),
    }
    const syncEngine: MockSyncEngine = { pause: vi.fn(), resume: vi.fn() }
    setupStoreWithCollections({ 'col-1': firstManager, 'col-2': secondManager }, syncEngine)

    const uids = await useEtebaseStore.getState().createItemsBatch('calendar', [
      { content: 'a', tempId: 't1' },
    ], 'col-2')

    expect(firstManager.create).not.toHaveBeenCalled()
    expect(secondManager.create).toHaveBeenCalledTimes(1)
    expect(uids).toEqual(['right'])
    expect(useEtebaseStore.getState().itemCollectionMap.get('right')).toBe('col-2')
  })

  it('does not fall back to the first collection when the requested collection uid is missing', async () => {
    const itemManager: MockItemManager = {
      create: vi.fn(async () => ({ uid: 'wrong' })),
      batch: vi.fn(async () => {}),
    }
    const syncEngine: MockSyncEngine = { pause: vi.fn(), resume: vi.fn() }
    setupStoreWithCollections({ 'col-1': itemManager }, syncEngine)

    const uids = await useEtebaseStore.getState().createItemsBatch('calendar', [
      { content: 'a', tempId: 't1' },
    ], 'missing-col')

    expect(uids).toEqual([null])
    expect(itemManager.create).not.toHaveBeenCalled()
    expect(itemManager.batch).not.toHaveBeenCalled()
    expect(syncEngine.pause).not.toHaveBeenCalled()
    expect(syncEngine.resume).not.toHaveBeenCalled()
  })

  it('resumes the sync engine even when the import throws', async () => {
    const itemManager: MockItemManager = {
      create: vi.fn(async () => {
        throw new Error('crypto blew up')
      }),
      batch: vi.fn(),
    }
    const syncEngine: MockSyncEngine = { pause: vi.fn(), resume: vi.fn() }
    setupStoreWithMocks(itemManager, syncEngine)

    await useEtebaseStore.getState().createItemsBatch('calendar', [
      { content: 'a', tempId: 't1' },
    ])

    expect(syncEngine.pause).toHaveBeenCalledTimes(1)
    expect(syncEngine.resume).toHaveBeenCalledTimes(1)
  })

  it('retries a transient batch failure with backoff and recovers', async () => {
    let nextUid = 0
    let batchCallCount = 0
    const itemManager: MockItemManager = {
      create: vi.fn(async () => ({ uid: `item-${nextUid++}` })),
      batch: vi.fn(async () => {
        batchCallCount++
        if (batchCallCount === 1) throw new Error('500 server error')
      }),
    }
    const syncEngine: MockSyncEngine = { pause: vi.fn(), resume: vi.fn() }
    setupStoreWithMocks(itemManager, syncEngine)

    vi.useFakeTimers()
    const promise = useEtebaseStore
      .getState()
      .createItemsBatch(
        'calendar',
        Array.from({ length: 5 }, (_, i) => ({ content: `c${i}`, tempId: `t${i}` })),
      )
    // Drain the retry backoff timers (1s) plus the local-crypto + post awaits.
    await vi.runAllTimersAsync()
    const uids = await promise
    vi.useRealTimers()

    expect(itemManager.batch).toHaveBeenCalledTimes(2)
    expect(uids.filter((u) => u !== null)).toHaveLength(5)
  })

  it('returns partial uids and stops when retries are exhausted', async () => {
    let nextUid = 0
    let batchCallCount = 0
    const itemManager: MockItemManager = {
      create: vi.fn(async () => ({ uid: `item-${nextUid++}` })),
      batch: vi.fn(async () => {
        batchCallCount++
        // First batch (items 0-19) succeeds; second batch fails permanently.
        if (batchCallCount === 1) return
        throw new Error('500 server error')
      }),
    }
    const syncEngine: MockSyncEngine = { pause: vi.fn(), resume: vi.fn() }
    setupStoreWithMocks(itemManager, syncEngine)

    vi.useFakeTimers()
    const promise = useEtebaseStore.getState().createItemsBatch(
      'calendar',
      Array.from({ length: 30 }, (_, i) => ({ content: `c${i}`, tempId: `t${i}` })),
    )
    await vi.runAllTimersAsync()
    const uids = await promise
    vi.useRealTimers()

    // First batch (20) succeeded; second batch retried 3 times then gave up.
    expect(itemManager.batch).toHaveBeenCalledTimes(1 + 3)
    expect(uids.slice(0, 20).every((u) => typeof u === 'string')).toBe(true)
    expect(uids.slice(20).every((u) => u === null)).toBe(true)
  })
  it('cancels after an item create crosses the account boundary', async () => {
    let releaseCreate!: () => void
    const itemManager: MockItemManager = {
      create: vi.fn(() => new Promise((resolve) => { releaseCreate = () => resolve({ uid: 'old-created' }) })),
      batch: vi.fn(async () => {}),
    }
    setupStoreWithMocks(itemManager, { pause: vi.fn(), resume: vi.fn() })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const mutation = useEtebaseStore.getState().createItemsBatch('calendar', [{ content: 'OLD', tempId: 'old' }])
    await vi.waitFor(() => expect(itemManager.create).toHaveBeenCalled())
    bumpAccountEpoch()
    releaseCreate()

    await expect(mutation).resolves.toEqual([null])
    expect(itemManager.batch).not.toHaveBeenCalled()
    expect(dataCacheMock.putItems).not.toHaveBeenCalled()
    expect(useEtebaseStore.getState().itemCache.has('old-created')).toBe(false)
    expect(errorSpy).not.toHaveBeenCalled()
    expect(toastStoreMock.showErrorToast).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('cancels after the cooperative yield crosses the account boundary', async () => {
    let nextUid = 0
    const itemManager: MockItemManager = {
      create: vi.fn(async () => ({ uid: `old-${nextUid++}` })),
      batch: vi.fn(async () => {}),
    }
    setupStoreWithMocks(itemManager, { pause: vi.fn(), resume: vi.fn() })
    const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
      bumpAccountEpoch()
      callback()
      return 1
    }) as typeof setTimeout)

    const result = await useEtebaseStore.getState().createItemsBatch('calendar',
      Array.from({ length: 26 }, (_, i) => ({ content: `OLD-${i}`, tempId: `old-${i}` })))
    timerSpy.mockRestore()

    expect(result).toEqual(Array(26).fill(null))
    expect(itemManager.batch).not.toHaveBeenCalled()
    expect(dataCacheMock.putItems).not.toHaveBeenCalled()
    expect(useEtebaseStore.getState().itemCache.size).toBe(0)
    expect(toastStoreMock.showErrorToast).not.toHaveBeenCalled()
  })

  it('cancels after retry backoff crosses the account boundary without another batch attempt', async () => {
    const itemManager: MockItemManager = {
      create: vi.fn(async () => ({ uid: 'old-retry' })),
      batch: vi.fn(async () => { throw new Error('transient') }),
    }
    setupStoreWithMocks(itemManager, { pause: vi.fn(), resume: vi.fn() })
    const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
      bumpAccountEpoch()
      callback()
      return 1
    }) as typeof setTimeout)

    const result = await useEtebaseStore.getState().createItemsBatch('calendar', [{ content: 'OLD', tempId: 'old' }])
    timerSpy.mockRestore()

    expect(result).toEqual([null])
    expect(itemManager.batch).toHaveBeenCalledTimes(1)
    expect(dataCacheMock.putItems).not.toHaveBeenCalled()
    expect(useEtebaseStore.getState().itemCache.size).toBe(0)
    expect(toastStoreMock.showErrorToast).not.toHaveBeenCalled()
  })

  it('does not publish or cache batch-created items after the account epoch changes', async () => {
    let releaseBatch!: () => void
    const batchGate = new Promise<void>((resolve) => { releaseBatch = resolve })
    const itemManager: MockItemManager = {
      create: vi.fn(async () => ({ uid: 'old-batch-item' })),
      batch: vi.fn(() => batchGate),
    }
    const syncEngine: MockSyncEngine = { pause: vi.fn(), resume: vi.fn() }
    setupStoreWithMocks(itemManager, syncEngine)
    dataCacheMock.isCacheEnabled.mockReturnValue(true)

    const mutation = useEtebaseStore.getState().createItemsBatch('calendar', [{ content: 'OLD', tempId: 'old-temp' }])
    await vi.waitFor(() => expect(itemManager.batch).toHaveBeenCalled())
    bumpAccountEpoch()
    useEtebaseStore.setState({ itemCache: new Map(), itemTypeMap: new Map(), itemCollectionMap: new Map() })
    releaseBatch()

    await expect(mutation).resolves.toEqual([null])
    expect(useEtebaseStore.getState().itemCache.has('old-batch-item')).toBe(false)
    expect(dataCacheMock.putItems).not.toHaveBeenCalled()
    expect(syncEngine.resume).not.toHaveBeenCalled()
    expect(toastStoreMock.showErrorToast).not.toHaveBeenCalled()
  })
})

describe('useEtebaseStore.updateItem account boundary', () => {
  it('does not publish or cache an update that resolves after the account epoch changes', async () => {
    let releaseUpdate!: (item: unknown) => void
    coreMock.updateItem.mockImplementationOnce(() => new Promise((resolve) => { releaseUpdate = resolve }))
    const oldItem = { uid: 'item-old' }
    useEtebaseStore.setState({
      account: { id: 'old-account' } as any,
      collections: { calendar: [{ uid: 'col-1' }] as any[], tasks: [], contacts: [], notes: [], preferences: [] },
      itemCache: new Map([['item-old', oldItem]]),
      itemTypeMap: new Map([['item-old', 'calendar']]),
      itemCollectionMap: new Map([['item-old', 'col-1']]),
    })
    dataCacheMock.isCacheEnabled.mockReturnValue(true)

    const mutation = useEtebaseStore.getState().updateItem('calendar', 'item-old', 'OLD CONTENT')
    await vi.waitFor(() => expect(coreMock.updateItem).toHaveBeenCalled())
    bumpAccountEpoch()
    useEtebaseStore.setState({ itemCache: new Map(), itemTypeMap: new Map(), itemCollectionMap: new Map() })
    releaseUpdate({ uid: 'item-old', oldAccount: true })
    await mutation

    expect(useEtebaseStore.getState().itemCache.size).toBe(0)
    expect(dataCacheMock.putItem).not.toHaveBeenCalled()
    expect(toastStoreMock.showErrorToast).not.toHaveBeenCalled()
  })
})

describe('useEtebaseStore.moveItem', () => {
  beforeEach(() => {
    offlineQueueMock.enqueue.mockClear()
    offlineQueueMock.isOfflineError.mockReset().mockReturnValue(false)
    useEtebaseStore.setState({
      account: null,
      collections: { calendar: [], tasks: [], contacts: [], notes: [], preferences: [] },
      itemCache: new Map(),
      itemTypeMap: new Map(),
      itemCollectionMap: new Map(),
      isInitialized: false,
      syncEngine: null,
    })
  })

  it('recreates the item in the target collection, deletes the source item, and remaps local caches', async () => {
    const account = { id: 'account' }
    const sourceCollection = { uid: 'col-1' }
    const targetCollection = { uid: 'col-2' }
    const sourceItem = { uid: 'item-old' }
    const targetItem = { uid: 'item-new' }
    coreMock.createItem.mockResolvedValue(targetItem)
    coreMock.deleteItem.mockResolvedValue(undefined)
    useEtebaseStore.setState({
      account: account as any,
      collections: { calendar: [sourceCollection, targetCollection] as any[], tasks: [], contacts: [], notes: [], preferences: [] },
      itemCache: new Map([['item-old', sourceItem]]),
      itemTypeMap: new Map([['item-old', 'calendar']]),
      itemCollectionMap: new Map([['item-old', 'col-1']]),
      isInitialized: true,
      domainLoadState: loadedDomainLoadState(),
      syncEngine: null,
    })

    const result = await useEtebaseStore.getState().moveItem('calendar', 'item-old', 'VEVENT content', 'col-2')
    const state = useEtebaseStore.getState()

    expect(result).toBe('item-new')
    expect(coreMock.createItem).toHaveBeenCalledWith(account, targetCollection, 'VEVENT content', undefined)
    expect(coreMock.deleteItem).toHaveBeenCalledWith(account, sourceCollection, sourceItem)
    expect(state.itemCache.has('item-old')).toBe(false)
    expect(state.itemTypeMap.has('item-old')).toBe(false)
    expect(state.itemCollectionMap.has('item-old')).toBe(false)
    expect(state.itemCache.get('item-new')).toBe(targetItem)
    expect(state.itemTypeMap.get('item-new')).toBe('calendar')
    expect(state.itemCollectionMap.get('item-new')).toBe('col-2')
  })

  it('recreates the item with the given metadata, so a moved note keeps its title', async () => {
    const account = { id: 'account' }
    const sourceCollection = { uid: 'nb-1' }
    const targetCollection = { uid: 'nb-2' }
    const sourceItem = { uid: 'note-old' }
    const targetItem = { uid: 'note-new' }
    coreMock.createItem.mockResolvedValue(targetItem)
    coreMock.deleteItem.mockResolvedValue(undefined)
    useEtebaseStore.setState({
      account: account as any,
      collections: { calendar: [], tasks: [], contacts: [], notes: [sourceCollection, targetCollection] as any[], preferences: [] },
      itemCache: new Map([['note-old', sourceItem]]),
      itemTypeMap: new Map([['note-old', 'notes']]),
      itemCollectionMap: new Map([['note-old', 'nb-1']]),
      isInitialized: true,
      domainLoadState: loadedDomainLoadState(),
      syncEngine: null,
    })

    const meta = { name: 'Shopping', mtime: 1700000000000 }
    const result = await useEtebaseStore.getState().moveItem('notes', 'note-old', '- milk', 'nb-2', undefined, meta)

    expect(result).toBe('note-new')
    expect(coreMock.createItem).toHaveBeenCalledWith(account, targetCollection, '- milk', meta)
    expect(useEtebaseStore.getState().itemCollectionMap.get('note-new')).toBe('nb-2')
  })

  it('keeps the created target item and queues source delete if the source delete fails offline', async () => {
    const account = { id: 'account' }
    const sourceCollection = { uid: 'col-1' }
    const targetCollection = { uid: 'col-2' }
    const sourceItem = { uid: 'item-old' }
    const targetItem = { uid: 'item-new' }
    const offlineError = new TypeError('Failed to fetch')
    coreMock.createItem.mockResolvedValue(targetItem)
    coreMock.deleteItem.mockRejectedValueOnce(offlineError)
    offlineQueueMock.isOfflineError.mockReturnValue(true)
    useEtebaseStore.setState({
      account: account as any,
      collections: { calendar: [sourceCollection, targetCollection] as any[], tasks: [], contacts: [], notes: [], preferences: [] },
      itemCache: new Map([['item-old', sourceItem]]),
      itemTypeMap: new Map([['item-old', 'calendar']]),
      itemCollectionMap: new Map([['item-old', 'col-1']]),
      isInitialized: true,
      domainLoadState: loadedDomainLoadState(),
      syncEngine: null,
    })

    const result = await useEtebaseStore.getState().moveItem('calendar', 'item-old', 'VEVENT content', 'col-2')
    const state = useEtebaseStore.getState()

    expect(result).toBe('item-new')
    expect(coreMock.createItem).toHaveBeenCalledWith(account, targetCollection, 'VEVENT content', undefined)
    expect(coreMock.deleteItem).toHaveBeenCalledTimes(1)
    expect(offlineQueueMock.enqueue).toHaveBeenCalledWith({
      type: 'delete',
      collectionType: 'calendar',
      collectionUid: 'col-1',
      itemUid: 'item-old',
    }, {
      accountEpoch: expect.any(Number),
      accountFingerprint: 'test-account-fingerprint',
    })
    expect(state.itemCache.get('item-old')).toBe(sourceItem)
    expect(state.itemCache.get('item-new')).toBe(targetItem)
    expect(state.itemCollectionMap.get('item-old')).toBe('col-1')
    expect(state.itemCollectionMap.get('item-new')).toBe('col-2')
  })

  it('quietly cancels when the source delete completes after an account switch', async () => {
    let releaseDelete!: () => void
    coreMock.createItem.mockResolvedValue({ uid: 'old-target' })
    coreMock.deleteItem.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseDelete = resolve }))
    useEtebaseStore.setState({
      account: { id: 'old' } as any,
      collections: { calendar: [{ uid: 'source' }, { uid: 'target' }] as any[], tasks: [], contacts: [], notes: [], preferences: [] },
      itemCache: new Map([['old-source', { uid: 'old-source' }]]),
      itemTypeMap: new Map([['old-source', 'calendar']]),
      itemCollectionMap: new Map([['old-source', 'source']]),
    })

    const move = useEtebaseStore.getState().moveItem('calendar', 'old-source', 'OLD', 'target')
    await vi.waitFor(() => expect(coreMock.deleteItem).toHaveBeenCalledTimes(1))
    bumpAccountEpoch()
    useEtebaseStore.setState({ itemCache: new Map(), itemTypeMap: new Map(), itemCollectionMap: new Map() })
    releaseDelete()

    await expect(move).resolves.toBeNull()
    expect(useEtebaseStore.getState().itemCache.size).toBe(0)
    expect(offlineQueueMock.enqueue).not.toHaveBeenCalled()
    expect(dataCacheMock.putItem).not.toHaveBeenCalled()
    expect(toastStoreMock.showErrorToast).not.toHaveBeenCalled()
  })
})

describe('useEtebaseStore sharing account boundary', () => {
  it('does not return stale invitation results', async () => {
    let release!: (value: any[]) => void
    coreMock.listIncomingInvitations.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    useEtebaseStore.setState({ account: { id: 'old' } as any })
    const listing = useEtebaseStore.getState().listIncomingInvitations()
    await vi.waitFor(() => expect(coreMock.listIncomingInvitations).toHaveBeenCalled())
    bumpAccountEpoch()
    release([{ uid: 'old-invite' }])
    await expect(listing).resolves.toEqual([])
  })

  it('does not log or toast an old-account sharing error', async () => {
    let reject!: (error: Error) => void
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    coreMock.listCollectionMembers.mockImplementationOnce(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise }))
    useEtebaseStore.setState({
      account: { id: 'old' } as any,
      collections: { calendar: [{ uid: 'old-col' }] as any[], tasks: [], contacts: [], notes: [], preferences: [] },
    })
    const listing = useEtebaseStore.getState().listCollectionMembers('calendar', 'old-col')
    await vi.waitFor(() => expect(coreMock.listCollectionMembers).toHaveBeenCalled())
    bumpAccountEpoch()
    reject(new Error('old failure'))
    await expect(listing).resolves.toEqual([])
    expect(errorSpy).not.toHaveBeenCalled()
    expect(toastStoreMock.showErrorToast).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})

describe('useEtebaseStore.deleteItemsInCollection', () => {
  beforeEach(() => {
    useEtebaseStore.setState({
      account: null,
      collections: { calendar: [], tasks: [], contacts: [], notes: [], preferences: [] },
      itemCache: new Map(),
      itemTypeMap: new Map(),
      itemCollectionMap: new Map(),
      isInitialized: false,
      syncEngine: null,
    })
  })

  it('refuses to clear a collection before that domain is fully loaded', async () => {
    const itemManager = { batch: vi.fn(async () => {}) }
    const account = {
      getCollectionManager: () => ({
        getItemManager: () => itemManager,
      }),
    }

    useEtebaseStore.setState({
      account: account as any,
      collections: { calendar: [{ uid: 'col-1' }] as any[], tasks: [], contacts: [], notes: [], preferences: [] },
      itemCache: new Map([['item-1', { uid: 'item-1', delete: vi.fn() }]]),
      itemTypeMap: new Map([['item-1', 'calendar']]),
      itemCollectionMap: new Map([['item-1', 'col-1']]),
      isInitialized: true,
      domainLoadState: { ...loadedDomainLoadState(), calendar: 'failed' },
      syncEngine: null,
    })

    const deleted = await useEtebaseStore.getState().deleteItemsInCollection('calendar', 'col-1')

    expect(deleted).toBe(0)
    expect(itemManager.batch).not.toHaveBeenCalled()
    expect(toastStoreMock.showErrorToast).toHaveBeenCalledWith(
      "This data hasn't finished loading yet. Retry sync, then try again.",
    )
  })

  it('deletes only items in the requested collection and clears local maps', async () => {
    const deleteItemOne = { uid: 'item-1', delete: vi.fn() }
    const deleteItemTwo = { uid: 'item-2', delete: vi.fn() }
    const keepItem = { uid: 'item-3', delete: vi.fn() }
    const itemManager = { batch: vi.fn(async () => {}) }
    const account = {
      getCollectionManager: () => ({
        getItemManager: () => itemManager,
      }),
    }

    useEtebaseStore.setState({
      account: account as any,
      collections: { calendar: [{ uid: 'col-1' }, { uid: 'col-2' }] as any[], tasks: [], contacts: [], notes: [], preferences: [] },
      itemCache: new Map([
        ['item-1', deleteItemOne],
        ['item-2', deleteItemTwo],
        ['item-3', keepItem],
      ]),
      itemTypeMap: new Map([
        ['item-1', 'calendar'],
        ['item-2', 'calendar'],
        ['item-3', 'calendar'],
      ]),
      itemCollectionMap: new Map([
        ['item-1', 'col-1'],
        ['item-2', 'col-1'],
        ['item-3', 'col-2'],
      ]),
      isInitialized: true,
      domainLoadState: loadedDomainLoadState(),
      syncEngine: null,
    })

    const deleted = await useEtebaseStore.getState().deleteItemsInCollection('calendar', 'col-1')
    const state = useEtebaseStore.getState()

    expect(deleted).toBe(2)
    expect(deleteItemOne.delete).toHaveBeenCalledTimes(1)
    expect(deleteItemTwo.delete).toHaveBeenCalledTimes(1)
    expect(keepItem.delete).not.toHaveBeenCalled()
    expect(itemManager.batch).toHaveBeenCalledWith([deleteItemOne, deleteItemTwo])
    expect(state.itemCache.has('item-1')).toBe(false)
    expect(state.itemCache.has('item-2')).toBe(false)
    expect(state.itemCache.get('item-3')).toBe(keepItem)
    expect(state.itemCollectionMap.get('item-3')).toBe('col-2')
  })

  it('clears local-only queued items for the requested collection', async () => {
    const account = {
      getCollectionManager: () => ({
        getItemManager: () => ({ batch: vi.fn() }),
      }),
    }

    offlineQueueMock.getAll.mockResolvedValueOnce([
      {
        id: 'queue-1',
        type: 'create',
        collectionType: 'calendar',
        collectionUid: 'col-1',
        tempId: 'temp-1',
        createdAt: 1,
        retryCount: 0,
        status: 'pending',
      },
    ])

    useEtebaseStore.setState({
      account: account as any,
      collections: { calendar: [{ uid: 'col-1' }] as any[], tasks: [], contacts: [], notes: [], preferences: [] },
      itemCache: new Map(),
      itemTypeMap: new Map(),
      itemCollectionMap: new Map(),
      isInitialized: true,
      domainLoadState: loadedDomainLoadState(),
      syncEngine: null,
    })
    useCalendarStore.setState({
      events: [{ id: 'temp-1', calendarId: 'col-1', title: 'Queued event' } as any],
      selectedEventId: 'temp-1',
    })

    const deleted = await useEtebaseStore.getState().deleteItemsInCollection('calendar', 'col-1')

    expect(deleted).toBe(1)
    expect(offlineQueueMock.remove).toHaveBeenCalledWith('queue-1', {
      accountEpoch: expect.any(Number),
      accountFingerprint: 'test-account-fingerprint',
    })
    expect(useCalendarStore.getState().events).toHaveLength(0)
    expect(useCalendarStore.getState().selectedEventId).toBeNull()
  })

  it('removes locally confirmed deletes when a later clear batch fails', async () => {
    const items = Array.from({ length: 21 }, (_, index) => ({ uid: `item-${index}`, delete: vi.fn() }))
    let batchCalls = 0
    const itemManager = {
      batch: vi.fn(async () => {
        batchCalls++
        if (batchCalls === 2) throw new Error('server error')
      }),
    }
    const account = {
      getCollectionManager: () => ({
        getItemManager: () => itemManager,
      }),
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    useEtebaseStore.setState({
      account: account as any,
      collections: { calendar: [{ uid: 'col-1' }] as any[], tasks: [], contacts: [], notes: [], preferences: [] },
      itemCache: new Map(items.map((item) => [item.uid, item])),
      itemTypeMap: new Map(items.map((item) => [item.uid, 'calendar' as const])),
      itemCollectionMap: new Map(items.map((item) => [item.uid, 'col-1'])),
      isInitialized: true,
      domainLoadState: loadedDomainLoadState(),
      syncEngine: null,
    })
    useCalendarStore.setState({
      events: [
        { id: 'item-0', calendarId: 'col-1', title: 'Deleted remotely' } as any,
        { id: 'item-20', calendarId: 'col-1', title: 'Still pending' } as any,
      ],
    })

    const deleted = await useEtebaseStore.getState().deleteItemsInCollection('calendar', 'col-1')
    const state = useEtebaseStore.getState()

    expect(deleted).toBe(0)
    expect(itemManager.batch).toHaveBeenCalledTimes(2)
    expect(state.itemCache.has('item-0')).toBe(false)
    expect(state.itemCache.has('item-19')).toBe(false)
    expect(state.itemCache.has('item-20')).toBe(true)
    expect(useCalendarStore.getState().events.map((event) => event.id)).toEqual(['item-20'])
    errorSpy.mockRestore()
  })
})

describe('useEtebaseStore.refreshCollection', () => {
  beforeEach(() => {
    useEtebaseStore.setState({
      account: null,
      collections: { calendar: [], tasks: [], contacts: [], notes: [], preferences: [] },
      itemCache: new Map(),
      itemTypeMap: new Map(),
      itemCollectionMap: new Map(),
      isInitialized: false,
      syncEngine: null,
    })
  })

  it('refreshes one concrete collection without removing same-type items from others', async () => {
    const staleItem = mockItem('old-col-1', 'old calendar')
    const survivorItem = mockItem('keep-col-2', 'other calendar')
    const freshItem = mockItem('new-col-1', 'fresh calendar')
    const collections = [{ uid: 'col-1' }, { uid: 'col-2' }]
    const itemManagers = {
      'col-1': {
        list: vi.fn(async () => ({ data: [freshItem], stoken: null, done: true })),
      },
      'col-2': {
        list: vi.fn(async () => ({ data: [], stoken: null, done: true })),
      },
    }
    const account = {
      getCollectionManager: () => ({
        fetch: vi.fn(async (uid: string) => ({ uid })),
        getItemManager: (collection: { uid: keyof typeof itemManagers }) => itemManagers[collection.uid],
      }),
    }

    useEtebaseStore.setState({
      account: account as any,
      collections: { calendar: collections as any[], tasks: [], contacts: [], notes: [], preferences: [] },
      itemCache: new Map([
        ['old-col-1', staleItem],
        ['keep-col-2', survivorItem],
      ]),
      itemTypeMap: new Map([
        ['old-col-1', 'calendar'],
        ['keep-col-2', 'calendar'],
      ]),
      itemCollectionMap: new Map([
        ['old-col-1', 'col-1'],
        ['keep-col-2', 'col-2'],
      ]),
      isInitialized: true,
      domainLoadState: loadedDomainLoadState(),
      syncEngine: null,
    })

    const result = await useEtebaseStore.getState().refreshCollection('calendar', 'col-1')
    const state = useEtebaseStore.getState()

    expect(result).toEqual([{ uid: 'new-col-1', content: 'fresh calendar', collectionUid: 'col-1' }])
    expect(state.itemCache.has('old-col-1')).toBe(false)
    expect(state.itemCache.get('new-col-1')).toBe(freshItem)
    expect(state.itemCollectionMap.get('new-col-1')).toBe('col-1')
    expect(state.itemCache.get('keep-col-2')).toBe(survivorItem)
    expect(state.itemCollectionMap.get('keep-col-2')).toBe('col-2')
    expect(state.domainLoadState.calendar).toBe('loaded')
    expect(itemManagers['col-2'].list).not.toHaveBeenCalled()
  })

  it('preserves and returns existing items when a network refresh fails', async () => {
    const existingItem = mockItem('existing', 'existing calendar')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const account = {
      getCollectionManager: () => ({
        fetch: vi.fn(async () => {
          throw new Error('network down')
        }),
      }),
    }

    useEtebaseStore.setState({
      account: account as any,
      collections: { calendar: [{ uid: 'col-1' }] as any[], tasks: [], contacts: [], notes: [], preferences: [] },
      itemCache: new Map([['existing', existingItem]]),
      itemTypeMap: new Map([['existing', 'calendar']]),
      itemCollectionMap: new Map([['existing', 'col-1']]),
      isInitialized: true,
      domainLoadState: loadedDomainLoadState(),
      syncEngine: null,
    })

    const result = await useEtebaseStore.getState().refreshCollection('calendar')
    const state = useEtebaseStore.getState()

    expect(result).toEqual([{ uid: 'existing', content: 'existing calendar', collectionUid: 'col-1' }])
    expect(state.itemCache.get('existing')).toBe(existingItem)
    expect(state.itemCollectionMap.get('existing')).toBe('col-1')
    expect(state.domainLoadState.calendar).toBe('failed')
    errorSpy.mockRestore()
  })

  it('does not mark a failed domain loaded after only one collection refresh succeeds', async () => {
    const existingItem = mockItem('existing-col-2', 'existing calendar')
    const freshItem = mockItem('fresh-col-1', 'fresh calendar')
    const collections = [{ uid: 'col-1' }, { uid: 'col-2' }]
    const itemManagers = {
      'col-1': { list: vi.fn(async () => ({ data: [freshItem], stoken: null, done: true })) },
      'col-2': { list: vi.fn(async () => ({ data: [existingItem], stoken: null, done: true })) },
    }
    const account = {
      getCollectionManager: () => ({
        fetch: vi.fn(async (uid: string) => ({ uid })),
        getItemManager: (collection: { uid: keyof typeof itemManagers }) => itemManagers[collection.uid],
      }),
    }

    useEtebaseStore.setState({
      account: account as any,
      collections: { calendar: collections as any[], tasks: [], contacts: [], notes: [], preferences: [] },
      itemCache: new Map([['existing-col-2', existingItem]]),
      itemTypeMap: new Map([['existing-col-2', 'calendar']]),
      itemCollectionMap: new Map([['existing-col-2', 'col-2']]),
      isInitialized: true,
      domainLoadState: { ...loadedDomainLoadState(), calendar: 'failed' },
      syncEngine: null,
    })

    const scoped = await useEtebaseStore.getState().refreshCollection('calendar', 'col-1')
    expect(scoped).toEqual([{ uid: 'fresh-col-1', content: 'fresh calendar', collectionUid: 'col-1' }])
    expect(useEtebaseStore.getState().domainLoadState.calendar).toBe('failed')
    expect(useEtebaseStore.getState().itemCache.get('existing-col-2')).toBe(existingItem)
    expect(itemManagers['col-2'].list).not.toHaveBeenCalled()

    await useEtebaseStore.getState().refreshCollection('calendar')
    expect(useEtebaseStore.getState().domainLoadState.calendar).toBe('loaded')
    expect(itemManagers['col-2'].list).toHaveBeenCalledTimes(1)
  })

  it('does not publish an old-account refresh after the account epoch changes', async () => {
    let releaseList!: (value: { data: any[]; stoken: null; done: true }) => void
    let markListStarted!: () => void
    const listStarted = new Promise<void>((resolve) => {
      markListStarted = resolve
    })
    const staleItem = mockItem('stale-account-item', 'old account calendar')
    const oldAccount = {
      getCollectionManager: () => ({
        fetch: vi.fn(async (uid: string) => ({ uid })),
        getItemManager: () => ({
          list: vi.fn(() => {
            markListStarted()
            return new Promise<{ data: any[]; stoken: null; done: true }>((resolve) => {
              releaseList = resolve
            })
          }),
        }),
      }),
    }

    dataCacheMock.isCacheEnabled.mockReturnValue(true)
    useEtebaseStore.setState({
      account: oldAccount as any,
      collections: { calendar: [{ uid: 'old-calendar' }] as any[], tasks: [], contacts: [], notes: [], preferences: [] },
      itemCache: new Map(),
      itemTypeMap: new Map(),
      itemCollectionMap: new Map(),
      isInitialized: true,
      domainLoadState: loadedDomainLoadState(),
      syncEngine: null,
    })

    const refresh = useEtebaseStore.getState().refreshCollection('calendar', 'old-calendar')
    await listStarted

    bumpAccountEpoch()
    useEtebaseStore.setState({
      account: { id: 'new-account' } as any,
      collections: { calendar: [], tasks: [], contacts: [], notes: [], preferences: [] },
      itemCache: new Map(),
      itemTypeMap: new Map(),
      itemCollectionMap: new Map(),
      domainLoadState: loadedDomainLoadState(),
    })
    releaseList({ data: [staleItem], stoken: null, done: true })

    await expect(refresh).rejects.toBeInstanceOf(AccountBoundaryChangedError)
    expect(useEtebaseStore.getState().itemCache.size).toBe(0)
    expect(useEtebaseStore.getState().collections.calendar).toEqual([])
    expect(dataCacheMock.replaceItemsForCollection).not.toHaveBeenCalled()
  })

  it('does not mark the new account failed when an old-account refresh rejects', async () => {
    let rejectList!: (error: Error) => void
    let markListStarted!: () => void
    const listStarted = new Promise<void>((resolve) => {
      markListStarted = resolve
    })
    const oldAccount = {
      getCollectionManager: () => ({
        fetch: vi.fn(async (uid: string) => ({ uid })),
        getItemManager: () => ({
          list: vi.fn(() => {
            markListStarted()
            return new Promise((_resolve, reject) => {
              rejectList = reject
            })
          }),
        }),
      }),
    }

    useEtebaseStore.setState({
      account: oldAccount as any,
      collections: { calendar: [{ uid: 'old-calendar' }] as any[], tasks: [], contacts: [], notes: [], preferences: [] },
      itemCache: new Map(),
      itemTypeMap: new Map(),
      itemCollectionMap: new Map(),
      isInitialized: true,
      domainLoadState: loadedDomainLoadState(),
      syncEngine: null,
    })

    const refresh = useEtebaseStore.getState().refreshCollection('calendar', 'old-calendar')
    await listStarted

    bumpAccountEpoch()
    useEtebaseStore.setState({
      account: { id: 'new-account' } as any,
      collections: { calendar: [], tasks: [], contacts: [], notes: [], preferences: [] },
      domainLoadState: loadedDomainLoadState(),
    })
    rejectList(new Error('old account request failed'))

    await expect(refresh).rejects.toBeInstanceOf(AccountBoundaryChangedError)
    expect(useEtebaseStore.getState().domainLoadState.calendar).toBe('loaded')
    expect(useEtebaseStore.getState().itemCache.size).toBe(0)
  })

  it('does not return old-account plaintext when cached content resolves after a boundary', async () => {
    let resolveContent!: (content: string) => void
    const getContent = vi.fn(() => new Promise<string>((resolve) => { resolveContent = resolve }))
    useEtebaseStore.setState({
      itemCache: new Map([['old-item', { getContent }]]),
      itemTypeMap: new Map([['old-item', 'calendar']]),
      itemCollectionMap: new Map([['old-item', 'old-calendar']]),
    })

    const fetch = useEtebaseStore.getState().fetchAllItems('calendar')
    await vi.waitFor(() => expect(getContent).toHaveBeenCalled())
    bumpAccountEpoch()
    useEtebaseStore.setState({ itemCache: new Map(), itemTypeMap: new Map(), itemCollectionMap: new Map() })
    resolveContent('PRIVATE_OLD_ACCOUNT_PLAINTEXT')

    await expect(fetch).rejects.toBeInstanceOf(AccountBoundaryChangedError)
    expect(useEtebaseStore.getState().itemCache.size).toBe(0)
  })
})

describe('useEtebaseStore.reconcileCollections', () => {
  beforeEach(() => {
    offlineQueueMock.getAll.mockReset().mockResolvedValue([])
    offlineQueueMock.remove.mockClear()
    useCalendarStore.setState({
      events: [],
      selectedEventId: null,
      isLoading: false,
      syncStatus: 'synced',
      currentView: 'week',
      currentDate: new Date('2026-01-01T00:00:00Z'),
    })
    useCalendarListStore.setState({
      calendars: [{ id: 'deleted-cal', name: 'Deleted', color: '#ef4444', visible: true }],
      defaultCalendarId: 'deleted-cal',
    })
    useTaskListStore.setState({
      lists: [{ id: 'tasks-1', name: 'Tasks', color: '#3b82f6', visible: true }],
      activeListId: 'tasks-1',
    })
    useContactListStore.setState({
      lists: [{ id: 'contacts-1', name: 'Contacts', color: '#8b5cf6', visible: true }],
      activeListId: 'contacts-1',
    })
    useNotebookStore.setState({
      lists: [{ id: 'notes-1', name: 'Personal Notes', color: '#f59e0b', visible: true }],
      activeListId: 'notes-1',
    })
    useEtebaseStore.setState({
      account: null,
      collections: { calendar: [], tasks: [], contacts: [], notes: [], preferences: [] },
      itemCache: new Map(),
      itemTypeMap: new Map(),
      itemCollectionMap: new Map(),
      isInitialized: false,
      syncEngine: null,
    })
  })

  it('removes a remotely deleted calendar and does not rehydrate its events', async () => {
    const account = { id: 'account' }
    const deletedCalendar = mockCollection('deleted-cal', { name: 'Deleted', color: '#ef4444' })
    const replacementCalendar = mockCollection('new-default-cal', { name: 'Personal Calendar', color: '#10b981' })
    const taskCollection = mockCollection('tasks-1', { name: 'Tasks', color: '#3b82f6' })
    const contactCollection = mockCollection('contacts-1', { name: 'Contacts', color: '#8b5cf6' })
    const noteCollection = mockCollection('notes-1', { name: 'Personal Notes', color: '#f59e0b' })
    const syncEngine = {
      pause: vi.fn(),
      resume: vi.fn(),
      trackCollection: vi.fn(),
      untrackCollection: vi.fn(),
      setStoken: vi.fn(),
    }
    coreMock.listCollections.mockImplementation(async (_account: unknown, collectionType: string) => {
      if (collectionType === 'etebase.vevent') return []
      if (collectionType === 'etebase.vtodo') return [taskCollection]
      if (collectionType === 'etebase.vcard') return [contactCollection]
      if (collectionType === 'etebase.md.note') return [noteCollection]
      return []
    })
    coreMock.createCollection.mockResolvedValue(replacementCalendar)

    useEtebaseStore.setState({
      account: account as any,
      collections: { calendar: [deletedCalendar] as any[], tasks: [taskCollection] as any[], contacts: [contactCollection] as any[], notes: [noteCollection] as any[], preferences: [] },
      itemCache: new Map([['event-1', mockItem('event-1', 'deleted event')]]),
      itemTypeMap: new Map([['event-1', 'calendar']]),
      itemCollectionMap: new Map([['event-1', 'deleted-cal']]),
      isInitialized: true,
      syncEngine: syncEngine as any,
    })
    useCalendarStore.setState({
      events: [{ id: 'event-1', calendarId: 'deleted-cal', title: 'Deleted event' } as any],
      selectedEventId: 'event-1',
    })

    await useEtebaseStore.getState().reconcileCollections()
    const state = useEtebaseStore.getState()

    expect(coreMock.createCollection).toHaveBeenCalledWith(account, 'etebase.vevent', expect.objectContaining({ name: 'Personal Calendar' }))
    expect(state.collections.calendar.map((collection) => collection.uid)).toEqual(['new-default-cal'])
    expect(state.itemCache.has('event-1')).toBe(false)
    expect(state.itemTypeMap.has('event-1')).toBe(false)
    expect(state.itemCollectionMap.has('event-1')).toBe(false)
    expect(useCalendarStore.getState().events).toEqual([])
    expect(useCalendarStore.getState().selectedEventId).toBeNull()
    expect(useCalendarListStore.getState().calendars.map((calendar) => calendar.id)).toEqual(['new-default-cal'])
    expect(syncEngine.pause).toHaveBeenCalledTimes(1)
    expect(syncEngine.resume).toHaveBeenCalledTimes(1)
    expect(syncEngine.untrackCollection).toHaveBeenCalledWith('deleted-cal')
    expect(syncEngine.trackCollection).toHaveBeenCalledWith('etebase.vevent', 'new-default-cal')
  })

  it('does not continue queued cleanup after the account changes', async () => {
    let releaseQueue!: (entries: any[]) => void
    offlineQueueMock.getAll.mockImplementationOnce(() => new Promise((resolve) => { releaseQueue = resolve }))
    const oldCalendar = mockCollection('old-cal')
    const newCalendar = mockCollection('replacement-cal')
    const tasks = mockCollection('tasks-1')
    const contacts = mockCollection('contacts-1')
    const notes = mockCollection('notes-1')
    coreMock.listCollections.mockImplementation(async (_account: unknown, collectionType: string) => {
      if (collectionType === 'etebase.vevent') return [newCalendar]
      if (collectionType === 'etebase.vtodo') return [tasks]
      if (collectionType === 'etebase.vcard') return [contacts]
      if (collectionType === 'etebase.md.note') return [notes]
      return []
    })
    const oldSyncEngine = { pause: vi.fn(), resume: vi.fn(), untrackCollection: vi.fn(), trackCollection: vi.fn() }
    useEtebaseStore.setState({
      account: { id: 'old' } as any,
      collections: { calendar: [oldCalendar] as any[], tasks: [tasks] as any[], contacts: [contacts] as any[], notes: [notes] as any[], preferences: [] },
      itemCache: new Map(),
      itemTypeMap: new Map(),
      itemCollectionMap: new Map(),
      syncEngine: oldSyncEngine as any,
    })

    const reconcile = useEtebaseStore.getState().reconcileCollections()
    await vi.waitFor(() => expect(offlineQueueMock.getAll).toHaveBeenCalled())
    bumpAccountEpoch()
    useEtebaseStore.setState({
      account: { id: 'new' } as any,
      collections: { calendar: [], tasks: [], contacts: [], notes: [], preferences: [] },
    })
    releaseQueue([{ id: 'old-queued', type: 'create', collectionType: 'calendar', collectionUid: 'old-cal' }])

    await expect(reconcile).resolves.toBeUndefined()
    expect(offlineQueueMock.remove).not.toHaveBeenCalled()
    expect(oldSyncEngine.resume).not.toHaveBeenCalled()
    expect(useEtebaseStore.getState().collections.calendar).toEqual([])
  })
})

describe('useEtebaseStore.updateCollectionMeta', () => {
  beforeEach(() => {
    useCalendarListStore.setState({
      calendars: [{ id: 'cal-1', name: 'Work', color: '#111111', visible: false }],
      defaultCalendarId: 'cal-1',
    })
    useTaskListStore.setState({
      lists: [{ id: 'tasks-1', name: 'Work Tasks', color: '#222222', visible: false }],
      activeListId: 'tasks-1',
    })
    useContactListStore.setState({
      lists: [{ id: 'contacts-1', name: 'Work Contacts', color: '#333333', visible: false }],
      activeListId: 'contacts-1',
    })
    useNotebookStore.setState({
      lists: [{ id: 'notes-1', name: 'Work Notes', color: '#444444', visible: false }],
      activeListId: 'notes-1',
    })
    useEtebaseStore.setState({
      account: null,
      collections: { calendar: [], tasks: [], contacts: [], notes: [], preferences: [] },
      itemCache: new Map(),
      itemTypeMap: new Map(),
      itemCollectionMap: new Map(),
      isInitialized: false,
      syncEngine: null,
    })
  })

  it('persists calendar color through collection metadata while preserving existing metadata', async () => {
    const account = { id: 'account' }
    const collection = mockCollection('cal-1', {
      name: 'Work',
      description: 'Keep this',
      color: '#111111',
    })
    const updatedCollection = mockCollection('cal-1', {
      name: 'Work',
      description: 'Keep this',
      color: '#ff0000',
    })
    coreMock.updateCollectionMeta.mockResolvedValue(updatedCollection)
    useEtebaseStore.setState({
      account: account as any,
      collections: { calendar: [collection] as any[], tasks: [], contacts: [], notes: [], preferences: [] },
      isInitialized: true,
    })

    const result = await useEtebaseStore.getState().updateCollectionMeta('calendar', 'cal-1', { color: '#ff0000' })

    expect(result).toBe(true)
    expect(coreMock.updateCollectionMeta).toHaveBeenCalledWith(account, collection, {
      name: 'Work',
      description: 'Keep this',
      color: '#ff0000',
      mtime: expect.any(Number),
    })
    expect(useEtebaseStore.getState().collections.calendar[0]).toBe(updatedCollection)
    expect(useCalendarListStore.getState().calendars[0]).toMatchObject({
      id: 'cal-1',
      name: 'Work',
      color: '#ff0000',
      visible: false,
    })
  })

  it('persists task-list color through collection metadata while preserving existing metadata', async () => {
    const account = { id: 'account' }
    const collection = mockCollection('tasks-1', {
      name: 'Work Tasks',
      description: 'Keep this',
      color: '#222222',
    })
    const updatedCollection = mockCollection('tasks-1', {
      name: 'Work Tasks',
      description: 'Keep this',
      color: '#ff0000',
    })
    coreMock.updateCollectionMeta.mockResolvedValue(updatedCollection)
    useEtebaseStore.setState({
      account: account as any,
      collections: { calendar: [], tasks: [collection] as any[], contacts: [], notes: [], preferences: [] },
      isInitialized: true,
    })

    const result = await useEtebaseStore.getState().updateCollectionMeta('tasks', 'tasks-1', { color: '#ff0000' })

    expect(result).toBe(true)
    expect(coreMock.updateCollectionMeta).toHaveBeenCalledWith(account, collection, {
      name: 'Work Tasks',
      description: 'Keep this',
      color: '#ff0000',
      mtime: expect.any(Number),
    })
    expect(useEtebaseStore.getState().collections.tasks[0]).toBe(updatedCollection)
    expect(useTaskListStore.getState().lists[0]).toMatchObject({
      id: 'tasks-1',
      name: 'Work Tasks',
      color: '#ff0000',
      visible: false,
    })
  })

  it('persists contact-list color through collection metadata while preserving existing metadata', async () => {
    const account = { id: 'account' }
    const collection = mockCollection('contacts-1', {
      name: 'Work Contacts',
      description: 'Keep this',
      color: '#333333',
    })
    const updatedCollection = mockCollection('contacts-1', {
      name: 'Work Contacts',
      description: 'Keep this',
      color: '#ff0000',
    })
    coreMock.updateCollectionMeta.mockResolvedValue(updatedCollection)
    useEtebaseStore.setState({
      account: account as any,
      collections: { calendar: [], tasks: [], contacts: [collection] as any[], notes: [], preferences: [] },
      isInitialized: true,
    })

    const result = await useEtebaseStore.getState().updateCollectionMeta('contacts', 'contacts-1', { color: '#ff0000' })

    expect(result).toBe(true)
    expect(coreMock.updateCollectionMeta).toHaveBeenCalledWith(account, collection, {
      name: 'Work Contacts',
      description: 'Keep this',
      color: '#ff0000',
      mtime: expect.any(Number),
    })
    expect(useEtebaseStore.getState().collections.contacts[0]).toBe(updatedCollection)
    expect(useContactListStore.getState().lists[0]).toMatchObject({
      id: 'contacts-1',
      name: 'Work Contacts',
      color: '#ff0000',
      visible: false,
    })
  })

  it.each([
    ['calendar', 'cal-1', 'calendar', 'calendar'] as const,
    ['tasks', 'tasks-1', 'task list', 'tasks'] as const,
    ['contacts', 'contacts-1', 'address book', 'contacts'] as const,
  ])('returns false and preserves local state when %s collection metadata update fails', async (type, collectionUid, label, collectionKey) => {
    const account = { id: 'account' }
    const collection = mockCollection(collectionUid, {
      name: 'Original',
      description: 'Keep this',
      color: '#111111',
    })
    coreMock.updateCollectionMeta.mockRejectedValue(new Error('upload failed'))
    useEtebaseStore.setState({
      account: account as any,
      collections: {
        calendar: type === 'calendar' ? [collection] as any[] : [],
        tasks: type === 'tasks' ? [collection] as any[] : [],
        contacts: type === 'contacts' ? [collection] as any[] : [],
        preferences: [],
      },
      isInitialized: true,
    })

    const result = await useEtebaseStore.getState().updateCollectionMeta(type, collectionUid, { color: '#ff0000' })

    expect(result).toBe(false)
    expect(useEtebaseStore.getState().collections[collectionKey][0]).toBe(collection)
    expect(toastStoreMock.showErrorToast).toHaveBeenCalledWith(`Failed to update ${label}. Please try again.`)
  })

  it('persists notebook renames through collection metadata and refreshes the notebook store', async () => {
    const account = { id: 'account' }
    const collection = mockCollection('notes-1', { name: 'Work Notes', color: '#444444' })
    const updatedCollection = mockCollection('notes-1', { name: 'Journal', color: '#444444' })
    coreMock.updateCollectionMeta.mockResolvedValue(updatedCollection)
    useEtebaseStore.setState({
      account: account as any,
      collections: { calendar: [], tasks: [], contacts: [], notes: [collection] as any[], preferences: [] },
      isInitialized: true,
    })

    const result = await useEtebaseStore.getState().updateCollectionMeta('notes', 'notes-1', { name: 'Journal' })

    expect(result).toBe(true)
    expect(coreMock.updateCollectionMeta).toHaveBeenCalledWith(account, collection, {
      name: 'Journal',
      color: '#444444',
      mtime: expect.any(Number),
    })
    expect(useEtebaseStore.getState().collections.notes[0]).toBe(updatedCollection)
    expect(useNotebookStore.getState().lists[0]).toMatchObject({
      id: 'notes-1',
      name: 'Journal',
      color: '#444444',
      visible: false,
    })
  })
})
