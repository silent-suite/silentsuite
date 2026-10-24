import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeContact, type Contact } from '@silentsuite/core'
import { SyncProvider } from '../sync-provider'
import { bumpAccountEpoch } from '@/app/lib/account-epoch'

// #865: the encrypted display cache hydrates contacts through the real
// @silentsuite/core deserializer (not mocked here), so preservation cannot be
// fabricated by a test double. Only external side effects are replaced,
// following the harness of sync-provider.timing.test.tsx.

const syncStoreMock = vi.hoisted(() => ({
  initializeSync: vi.fn(() => vi.fn()),
  setSyncStatus: vi.fn(),
  setLastSynced: vi.fn(),
  setError: vi.fn(),
  setPartialLoad: vi.fn(),
  replayOfflineQueue: vi.fn(async () => 0),
  simulateSyncCycle: vi.fn(),
}))

const etebaseMock = vi.hoisted(() => ({
  state: {
    initialize: vi.fn(async (options?: { onCacheHydrate?: () => void | Promise<void> }) => {
      await options?.onCacheHydrate?.()
    }),
    fetchAllItems: vi.fn(async () => []),
    onSyncChange: vi.fn(() => vi.fn()),
    onStatusChange: vi.fn(() => vi.fn()),
    isInitialized: false,
    accountFingerprint: null as string | null,
    refreshCollection: vi.fn(async () => []),
    domainLoadState: { tasks: 'loaded', contacts: 'loaded', calendar: 'loaded', notes: 'loaded', preferences: 'unknown' },
  },
}))

const contactStoreMock = vi.hoisted(() => ({ syncFromRemote: vi.fn() }))
const otherStoreMock = vi.hoisted(() => ({ syncFromRemote: vi.fn(), setState: vi.fn() }))

const cacheMock = vi.hoisted(() => ({
  getItemsByType: vi.fn(async (_type: string): Promise<unknown[]> => []),
  replaceItemsForType: vi.fn(async () => {}),
  isCacheEnabled: vi.fn(() => true),
  getCacheCapabilityStatus: vi.fn(() => ({ featureFlagEnabled: true, encryptedEnvelopeAvailable: true, enabled: true })),
}))

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }))
vi.mock('@/app/lib/logger', () => ({ logger: { debug: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/app/lib/privacy-safe-errors', () => ({
  createSafeOperationalError: vi.fn((_component: string, operation: string) => new Error(operation)),
  getSafeErrorDetails: vi.fn(() => ({ name: 'Error' })),
}))
vi.mock('@/app/lib/data-cache', () => cacheMock)
vi.mock('@/app/lib/sync-timing', () => ({
  logSyncTiming: vi.fn(),
  markSyncTimingStart: vi.fn(() => 100),
  nowMs: vi.fn(() => 100),
  safeTimingErrorCategory: vi.fn(() => 'unknown'),
}))
vi.mock('@/app/stores/use-sync-store', () => ({
  useSyncStore: Object.assign(
    (selector: (state: typeof syncStoreMock) => unknown) => selector(syncStoreMock),
    { getState: () => syncStoreMock },
  ),
}))
vi.mock('@/app/stores/use-etebase-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/app/stores/use-etebase-store')>(),
  useEtebaseStore: Object.assign(
    (selector: (state: typeof etebaseMock.state) => unknown) => selector(etebaseMock.state),
    { getState: () => etebaseMock.state },
  ),
  keepPendingCacheRecords: vi.fn(async (_type: string, records: unknown[]) => records),
}))
vi.mock('@/app/stores/use-contact-store', () => ({ useContactStore: { getState: () => contactStoreMock } }))
vi.mock('@/app/stores/use-task-store', () => ({ useTaskStore: { getState: () => otherStoreMock } }))
vi.mock('@/app/stores/use-calendar-store', () => ({ useCalendarStore: { getState: () => otherStoreMock } }))
vi.mock('@/app/stores/use-note-store', () => ({ useNoteStore: { getState: () => otherStoreMock, setState: otherStoreMock.setState } }))
vi.mock('@/app/stores/use-label-suggestions-store', () => ({
  useLabelSuggestionsStore: {
    getState: () => ({ initialize: vi.fn(async () => {}), seedFromVisibleItems: vi.fn(), refreshFromRemote: vi.fn(async () => {}) }),
  },
}))
vi.mock('@/app/stores/use-preferences-sync-store', () => ({
  usePreferencesSyncStore: {
    getState: () => ({
      operationGeneration: 7,
      beginRemoteRead: vi.fn(() => 11),
      initialize: vi.fn(async () => {}),
      loadFromRemote: vi.fn(async () => {}),
      recordRemoteReadFailure: vi.fn(),
      destroy: vi.fn(),
    }),
  },
}))

const extras = ['X-TESTA:testA', 'X-TestB:testB', 'item4.URL:https://example.invalid', 'item4.X-ABLabel:Site']
const cachedContent = ['BEGIN:VCARD', 'VERSION:3.0', 'UID:cached-865', 'FN:John Doe', 'TEL;TYPE=cell:+1 234 567890', ...extras, 'REV:20261024T000000Z', 'END:VCARD'].join('\r\n')
const cachedItem = { itemUid: 'cached-item', collectionUid: 'contacts-1', collectionType: 'contacts', content: cachedContent }

describe('SyncProvider cache hydrate keeps unsupported contact properties (#865)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    etebaseMock.state.initialize.mockImplementation(async (options?: { onCacheHydrate?: () => void | Promise<void> }) => {
      await options?.onCacheHydrate?.()
    })
    cacheMock.isCacheEnabled.mockReturnValue(true)
  })

  it('publishes the cached contact with its properties and a known-field edit keeps them', async () => {
    cacheMock.getItemsByType.mockImplementation(async (type: string) => (type === 'contacts' ? [cachedItem] : []))

    render(<SyncProvider><div>child</div></SyncProvider>)
    await waitFor(() => expect(contactStoreMock.syncFromRemote).toHaveBeenCalled())

    const published = contactStoreMock.syncFromRemote.mock.calls[0]![0] as (Contact & { revision: string | null })[]
    expect(published).toHaveLength(1)
    // The display cache holds no SDK item, so the revision stays unknown (#744).
    expect(published[0]).toMatchObject({ id: 'cached-item', listId: 'contacts-1', revision: null, displayName: 'John Doe', unknownProperties: extras })
    const edited = serializeContact({ ...published[0]!, phones: [{ type: 'cell', value: '+1 234 000000' }] })
    expect(edited).toContain('TEL;TYPE=cell:+1 234 000000')
    expect(edited.split('\r\n').filter((line) => extras.includes(line))).toEqual(extras)
  })

  it('publishes nothing from the cache once the account epoch changed during the read', async () => {
    cacheMock.getItemsByType.mockImplementation(async (type: string) => {
      if (type !== 'contacts') return []
      bumpAccountEpoch()
      return [cachedItem]
    })

    render(<SyncProvider><div>child</div></SyncProvider>)
    await waitFor(() => expect(cacheMock.getItemsByType).toHaveBeenCalledWith('contacts'))
    await new Promise((resolve) => setTimeout(resolve, 20))

    const publishedIds = contactStoreMock.syncFromRemote.mock.calls.flatMap((call) => (call[0] as { id: string }[]).map((contact) => contact.id))
    expect(publishedIds).not.toContain('cached-item')
  })
})
