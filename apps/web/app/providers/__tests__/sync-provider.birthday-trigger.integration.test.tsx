import 'fake-indexeddb/auto'
import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetForTests as resetDataCache,
  _setEncryptedCacheAvailableForTests,
  _setEnvelopeKeyForTests,
} from '@/app/lib/data-cache'
import { TEST_FINGERPRINT, resetRealOfflineQueue } from '@/app/stores/__tests__/offline-queue-store-test-utils'

// #738: the real SyncProvider callers that request Birthdays generation. Only the
// session restore, fingerprint, live SyncEngine, SDK account and the birthday
// session module (the scheduling boundary) are fakes.

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
  }
  return { restoreSession: vi.fn(), getAccountFingerprint: vi.fn(), SyncEngine: FakeSyncEngine }
})
const birthdayMock = vi.hoisted(() => ({ scheduleBirthdayReconcile: vi.fn(), resetBirthdayProjection: vi.fn() }))
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
vi.mock('@/app/lib/birthday-calendar/session', () => birthdayMock)
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
import { useContactStore } from '@/app/stores/use-contact-store'
import { useCalendarListStore } from '@/app/stores/use-calendar-list-store'
import { getAccountEpoch } from '@/app/lib/account-epoch'
import { birthdayMarkerContent } from '@silentsuite/core'
import { selectManagedBirthdayCalendarIds, useBirthdayMarkerStore } from '@/app/lib/birthday-calendar/markers'
import { SyncProvider } from '../sync-provider'

vi.setConfig({ testTimeout: 15_000 })

const VCARD = ['BEGIN:VCARD', 'VERSION:3.0', 'UID:alex', 'FN:Alex Example', 'BDAY:1985-03-15', 'END:VCARD'].join('\r\n')

function fakeServer(extraCalendars: any[] = []) {
  const makeItem = (uid: string, content: string) => ({
    uid,
    isDeleted: false,
    getContent: async () => content,
    getMeta: () => ({ name: uid }),
  })
  const collection = (uid: string) => ({ uid, isDeleted: false, getMeta: () => ({ name: uid }) })
  const collectionsByType: Record<string, any[]> = {
    'etebase.vevent': [collection('calendar-1'), ...extraCalendars],
    'etebase.vtodo': [collection('tasks-1')],
    'etebase.vcard': [collection('contacts-1')],
    'etebase.md.note': [],
  }
  const items = new Map<string, any[]>([['contacts-1', [makeItem('contact-1', VCARD)]]])
  const manager = {
    list: vi.fn(async (type: string) => ({ data: collectionsByType[type] ?? [], stoken: 'end', done: true })),
    create: vi.fn(),
    upload: vi.fn(),
    fetch: vi.fn(async (uid: string) => Object.values(collectionsByType).flat().find((entry) => entry.uid === uid)),
    getItemManager: (owner: { uid: string }) => ({
      list: vi.fn(async () => ({ data: items.get(owner.uid) ?? [], stoken: null, done: true })),
      create: vi.fn(),
      batch: vi.fn(),
    }),
  }
  coreMock.restoreSession.mockResolvedValue({ getCollectionManager: () => manager })
}

function captureChangeHandler() {
  let handler: ((event: any) => Promise<void>) | null = null
  useEtebaseStore.setState({
    onSyncChange: (callback: (event: any) => Promise<void>) => {
      handler = callback
      return () => {}
    },
  } as never)
  return () => handler
}

const reported = (operation: string) =>
  sentryMock.captureException.mock.calls.some(([, context]) => context?.tags?.operation === operation)

describe('SyncProvider requests Birthdays generation after a successful contact sync (#738)', () => {
  beforeEach(async () => {
    await resetRealOfflineQueue()
    await resetDataCache()
    _setEnvelopeKeyForTests(await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']))
    _setEncryptedCacheAvailableForTests(true)
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    useSyncStore.setState(useSyncStore.getInitialState(), true)
    useContactStore.setState({ contacts: [] })
    coreMock.restoreSession.mockReset()
    coreMock.getAccountFingerprint.mockReset().mockReturnValue(TEST_FINGERPRINT)
    birthdayMock.scheduleBirthdayReconcile.mockReset()
    birthdayMock.resetBirthdayProjection.mockReset()
    toastMock.showErrorToast.mockReset()
    sentryMock.captureException.mockReset()
  })

  it('requests a run once the contacts domain has loaded from the server', async () => {
    fakeServer()
    const { unmount } = render(<SyncProvider><div /></SyncProvider>)
    try {
      await waitFor(() => expect(useEtebaseStore.getState().domainLoadState.contacts).toBe('loaded'))
      await waitFor(() => expect(useContactStore.getState().contacts.map((c) => c.id)).toEqual(['contact-1']))
      await waitFor(() => expect(birthdayMock.scheduleBirthdayReconcile).toHaveBeenCalled())
    } finally {
      unmount()
    }
  })

  it('marks an active Birthdays calendar as managed before it first appears in the calendar list', async () => {
    fakeServer([{ uid: 'bday-1', isDeleted: false, getMeta: () => ({ name: 'Birthdays' }), getContent: async () => birthdayMarkerContent('active') }])
    let managedWhenListed: readonly string[] | undefined
    const unsubscribe = useCalendarListStore.subscribe((state) => {
      if (managedWhenListed === undefined && state.calendars.some((calendar) => calendar.id === 'bday-1')) {
        managedWhenListed = selectManagedBirthdayCalendarIds(
          useBirthdayMarkerStore.getState().snapshot, getAccountEpoch(), useEtebaseStore.getState().accountFingerprint)
      }
    })
    const { unmount } = render(<SyncProvider><div /></SyncProvider>)
    try {
      await waitFor(() => expect(managedWhenListed).toBeDefined())
      expect(managedWhenListed).toEqual(['bday-1'])
    } finally {
      unsubscribe()
      unmount()
    }
  })

  it('keeps a successful initial contacts load when Birthdays scheduling throws', async () => {
    fakeServer()
    birthdayMock.scheduleBirthdayReconcile.mockImplementation(() => { throw new Error('birthday chunk failed') })
    const { unmount } = render(<SyncProvider><div /></SyncProvider>)
    try {
      await waitFor(() => expect(birthdayMock.scheduleBirthdayReconcile).toHaveBeenCalled())
      await waitFor(() => expect(useSyncStore.getState().syncStatus).toBe('synced'))
      expect(useContactStore.getState().contacts.map((c) => c.id)).toEqual(['contact-1'])
      expect(reported('load contacts')).toBe(false)
      expect(reported('init')).toBe(false)
      expect(toastMock.showErrorToast).not.toHaveBeenCalled()
    } finally {
      unmount()
    }
  })

  it('requests a run after a remote contacts change, and a scheduling failure is not a contacts sync error', async () => {
    fakeServer()
    const handler = captureChangeHandler()
    const { unmount } = render(<SyncProvider><div /></SyncProvider>)
    try {
      await waitFor(() => expect(handler()).not.toBeNull())
      await waitFor(() => expect(useEtebaseStore.getState().domainLoadState.contacts).toBe('loaded'))
      birthdayMock.scheduleBirthdayReconcile.mockReset()
      birthdayMock.scheduleBirthdayReconcile.mockImplementation(() => { throw new Error('birthday chunk failed') })

      await handler()!({ changeType: 'update', collectionType: 'etebase.vcard', collectionUid: 'contacts-1', itemUids: ['contact-1'] })

      await waitFor(() => expect(birthdayMock.scheduleBirthdayReconcile).toHaveBeenCalled())
      expect(useContactStore.getState().contacts.map((c) => c.id)).toEqual(['contact-1'])
      expect(reported('sync contacts')).toBe(false)
    } finally {
      unmount()
    }
  })
})
