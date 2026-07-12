import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useContactStore, getFilteredContacts } from '../use-contact-store'
import { useEtebaseStore } from '../use-etebase-store'
import { useContactListStore } from '../use-contact-list-store'
import type { Contact } from '@silentsuite/core'
import { getAll } from '@/app/lib/offline-queue'
import { TEST_FINGERPRINT, bumpEpochWhenQueuePutRuns, enqueueCreateFromStore, expectOwnedQueueEntry, expectQuietQueueCommitCancellation, queueGuard, replayOwnedEntry, resetRealOfflineQueue } from './offline-queue-store-test-utils'

const toastMock = vi.hoisted(() => ({ showErrorToast: vi.fn() }))
vi.mock('@/app/stores/use-toast-store', () => toastMock)

// Mock the sync store to prevent side effects
vi.mock('@/app/stores/use-sync-store', () => ({
  useSyncStore: {
    getState: () => ({
      isOnline: false,
      simulateSyncCycle: vi.fn(),
    }),
  },
}))

function resetStore() {
  useContactStore.setState({
    contacts: [],
    isLoading: false,
    syncStatus: 'synced',
    searchQuery: '',
    pendingChanges: [],
  })
  useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
  useContactListStore.setState({ lists: [{ id: 'contacts-1', name: 'Contacts', color: '#fff', visible: true, accessLevel: 2 }], activeListId: 'contacts-1' })
}

function offlineAccount() {
  useEtebaseStore.setState({ account: {}, accountFingerprint: TEST_FINGERPRINT, itemCache: new Map(), createItem: vi.fn((type, content, tempId, collectionUid) => enqueueCreateFromStore(type, collectionUid, content, tempId!)) } as any)
}

function queuedContact(id = 'temp-contact'): Contact {
  return { id, uid: id, displayName: 'Contact', name: { prefix: '', given: '', family: '', suffix: '' }, phones: [], emails: [], addresses: [], organization: '', title: '', notes: '', birthday: null, photoUrl: null, categories: [], listId: 'contacts-1', created_at: new Date(), updated_at: new Date() }
}

describe('useContactStore', () => {
  beforeEach(() => {
    resetStore()
  })

  it('createContact adds a contact', async () => {
    const { createContact } = useContactStore.getState()
    const contact = await createContact({
      displayName: 'Jane Doe',
      emails: [{ type: 'home', value: 'jane@example.com' }],
    })

    const { contacts } = useContactStore.getState()
    expect(contacts).toHaveLength(1)
    expect(contacts[0]!.displayName).toBe('Jane Doe')
    expect(contacts[0]!.emails[0]!.value).toBe('jane@example.com')
    expect(contact.id).toBeDefined()
  })

  it('updateContact modifies a contact', async () => {
    const { createContact } = useContactStore.getState()
    const contact = await createContact({ displayName: 'Original Name' })

    const { updateContact } = useContactStore.getState()
    await updateContact(contact.id, { displayName: 'Updated Name' })

    const { contacts } = useContactStore.getState()
    expect(contacts[0]!.displayName).toBe('Updated Name')
  })

  it('deleteContact removes a contact', async () => {
    const { createContact } = useContactStore.getState()
    const contact = await createContact({ displayName: 'To Delete' })

    const { deleteContact } = useContactStore.getState()
    await deleteContact(contact.id)

    const { contacts } = useContactStore.getState()
    expect(contacts).toHaveLength(0)
  })

  it('keeps the vCard UID stable after replacing the local id with the Etebase item id', async () => {
    const createItem = vi.fn(async () => 'remote-contact-item')
    const updateItem = vi.fn(async () => {})
    useEtebaseStore.setState({
      account: {},
      createItem,
      updateItem,
    } as any)

    const contact = await useContactStore.getState().createContact({ displayName: 'Sync Contact' })

    expect(contact.id).toBe('remote-contact-item')
    expect(contact.uid).not.toBe('remote-contact-item')
    expect(createItem.mock.calls[0]![1]).toContain(`UID:${contact.uid}`)

    useEtebaseStore.setState({
      itemCache: new Map([['remote-contact-item', {}]]),
    } as any)

    await useContactStore.getState().updateContact('remote-contact-item', { notes: 'Updated' })

    const updatedContent = updateItem.mock.calls[0]![2] as string
    expect(updatedContent).toContain(`UID:${contact.uid}`)
    expect(updatedContent).not.toContain('UID:remote-contact-item')
  })

  describe('getFilteredContacts', () => {
    const mockContacts: Contact[] = [
      {
        id: '1',
        uid: '1',
        displayName: 'Alice Johnson',
        name: { prefix: '', given: 'Alice', family: 'Johnson', suffix: '' },
        phones: [{ type: 'cell', value: '+1 555-1234' }],
        emails: [{ type: 'home', value: 'alice@example.com' }],
        addresses: [],
        organization: 'Acme',
        title: '',
        notes: '',
        birthday: null,
        photoUrl: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        id: '2',
        uid: '2',
        displayName: 'Bob Smith',
        name: { prefix: '', given: 'Bob', family: 'Smith', suffix: '' },
        phones: [{ type: 'work', value: '+1 555-5678' }],
        emails: [{ type: 'work', value: 'bob@company.com' }],
        addresses: [],
        organization: 'BigCo',
        title: '',
        notes: '',
        birthday: null,
        photoUrl: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]

    it('returns all contacts when query is empty', () => {
      expect(getFilteredContacts(mockContacts, '')).toHaveLength(2)
      expect(getFilteredContacts(mockContacts, '  ')).toHaveLength(2)
    })

    it('filters by name', () => {
      const result = getFilteredContacts(mockContacts, 'alice')
      expect(result).toHaveLength(1)
      expect(result[0]!.displayName).toBe('Alice Johnson')
    })

    it('filters by email', () => {
      const result = getFilteredContacts(mockContacts, 'bob@company')
      expect(result).toHaveLength(1)
      expect(result[0]!.displayName).toBe('Bob Smith')
    })

    it('filters by phone', () => {
      const result = getFilteredContacts(mockContacts, '555-1234')
      expect(result).toHaveLength(1)
      expect(result[0]!.displayName).toBe('Alice Johnson')
    })

    it('matches by categories/labels', () => {
      const tagged: Contact[] = [
        {
          id: 't1',
          uid: 't1',
          displayName: 'Carol King',
          name: { prefix: '', given: 'Carol', family: 'King', suffix: '' },
          phones: [],
          emails: [],
          addresses: [],
          organization: '',
          title: '',
          notes: '',
          birthday: null,
          photoUrl: null,
          categories: ['Work', 'VIP'],
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: 't2',
          uid: 't2',
          displayName: 'Dan Lee',
          name: { prefix: '', given: 'Dan', family: 'Lee', suffix: '' },
          phones: [],
          emails: [],
          addresses: [],
          organization: '',
          title: '',
          notes: '',
          birthday: null,
          photoUrl: null,
          categories: ['Family'],
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]

      const work = getFilteredContacts(tagged, 'work')
      expect(work).toHaveLength(1)
      expect(work[0]!.displayName).toBe('Carol King')

      const vip = getFilteredContacts(tagged, 'vip')
      expect(vip).toHaveLength(1)
      expect(vip[0]!.displayName).toBe('Carol King')
    })
  })

  describe('guarded offline queue integration', () => {
    // Enqueue surface map: create -> Etebase createItem; uncached update/delete ->
    // the direct guarded branches below; cached update/delete enqueue in Etebase store.
    beforeEach(async () => { await resetRealOfflineQueue(); resetStore(); offlineAccount(); toastMock.showErrorToast.mockReset() })

    it.each([
      ['create', async () => { await useContactStore.getState().createContact({ displayName: 'Create', listId: 'contacts-1' }) }],
      ['update', async () => { useContactStore.setState({ contacts: [queuedContact()] }); await useContactStore.getState().updateContact('temp-contact', { displayName: 'Update' }) }],
      ['delete', async () => { useContactStore.setState({ contacts: [queuedContact()] }); await useContactStore.getState().deleteContact('temp-contact') }],
    ] as const)('persists, exposes, and replays an owned offline %s', async (type, mutate) => {
      await mutate()
      await replayOwnedEntry(await expectOwnedQueueEntry(type, 'contacts'))
    })

    it('isolates equal contact IDs across account fingerprints', async () => {
      useContactStore.setState({ contacts: [queuedContact()] })
      await useContactStore.getState().updateContact('temp-contact', { displayName: 'Owned' })
      expect(await getAll(queueGuard('other-account'))).toEqual([])
      expect(await getAll(queueGuard(TEST_FINGERPRINT))).toHaveLength(1)
    })

    it('quietly cancels at the actual IndexedDB commit boundary', async () => {
      useContactStore.setState({ contacts: [queuedContact()] })
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const putSpy = bumpEpochWhenQueuePutRuns(() => {
        useEtebaseStore.setState({ account: {}, accountFingerprint: 'new-account' } as any)
        useContactStore.setState({ contacts: [] })
      })
      await expect(useContactStore.getState().updateContact('temp-contact', { displayName: 'Stale' })).resolves.toBeUndefined()
      putSpy.mockRestore()
      expect(useContactStore.getState().contacts).toEqual([])
      expect(await getAll()).toEqual([])
      expect(await getAll(queueGuard('new-account'))).toEqual([])
      expect(errorSpy).not.toHaveBeenCalled()
      expect(toastMock.showErrorToast).not.toHaveBeenCalled()
      errorSpy.mockRestore()
    })

    it('quietly cancels its distinct uncached delete branch at the actual IndexedDB commit boundary', async () => {
      useContactStore.setState({ contacts: [queuedContact()] })
      await expectQuietQueueCommitCancellation(
        () => useContactStore.getState().deleteContact('temp-contact'),
        () => { useEtebaseStore.setState({ account: {}, accountFingerprint: 'new-account' } as any); useContactStore.setState({ contacts: [] }) },
        () => expect(useContactStore.getState().contacts).toEqual([]),
        toastMock,
      )
    })
  })

  describe('favorites', () => {
    beforeEach(() => {
      toastMock.showErrorToast.mockReset()
      useContactStore.setState({ contacts: [queuedContact('remote-contact')] })
    })

    it('persists an authorized favorite as canonical encrypted item content', async () => {
      const updateItem = vi.fn().mockResolvedValue('remote')
      useEtebaseStore.setState({ account: {}, accountFingerprint: TEST_FINGERPRINT, itemCache: new Map([['remote-contact', {}]]), updateItem } as any)
      await useContactStore.getState().setContactFavorite('remote-contact', true)
      expect(useContactStore.getState().contacts[0]!.favorite).toBe(true)
      expect(updateItem.mock.calls[0]![2]).toContain('X-SILENTSUITE-FAVORITE:1')
      expect(updateItem.mock.calls[0]![3]).toEqual({ suppressErrorToast: true, persistEncryptedOfflineContent: true })
    })

    it('rolls back an online failure with static feedback', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      useEtebaseStore.setState({ account: {}, accountFingerprint: TEST_FINGERPRINT, itemCache: new Map([['remote-contact', {}]]), updateItem: vi.fn().mockRejectedValue(new Error('private')) } as any)
      await useContactStore.getState().setContactFavorite('remote-contact', true)
      expect(useContactStore.getState().contacts[0]!.favorite).toBe(false)
      expect(toastMock.showErrorToast).toHaveBeenCalledWith('Failed to update favorite. Please try again.')
      errorSpy.mockRestore()
    })

    it('fails closed before mutation when access is read-only or missing', async () => {
      for (const accessLevel of [0, undefined]) {
        useContactListStore.setState({ lists: [{ id: 'contacts-1', name: 'Contacts', color: '#fff', visible: true, accessLevel }] })
        const updateItem = vi.fn()
        useEtebaseStore.setState({ account: {}, accountFingerprint: TEST_FINGERPRINT, itemCache: new Map([['remote-contact', {}]]), updateItem } as any)
        await useContactStore.getState().setContactFavorite('remote-contact', true)
        expect(useContactStore.getState().contacts[0]!.favorite).not.toBe(true)
        expect(updateItem).not.toHaveBeenCalled()
      }
    })

    it('allows both owner/admin and read-write collection access', () => {
      const contact = useContactStore.getState().contacts[0]!
      for (const accessLevel of [1, 2]) {
        useContactListStore.setState({ lists: [{ id: 'contacts-1', name: 'Contacts', color: '#fff', visible: true, accessLevel }] })
        expect(useContactStore.getState().canWriteContact(contact)).toBe(true)
      }
    })

    it('does not optimistically mutate without an account fingerprint', async () => {
      const updateItem = vi.fn()
      useEtebaseStore.setState({ account: {}, accountFingerprint: null, itemCache: new Map([['remote-contact', {}]]), updateItem } as any)
      await useContactStore.getState().setContactFavorite('remote-contact', true)
      expect(useContactStore.getState().contacts[0]!.favorite).not.toBe(true)
      expect(updateItem).not.toHaveBeenCalled()
    })

    it('rolls back when the authoritative collection is unavailable', async () => {
      useEtebaseStore.setState({
        account: {},
        accountFingerprint: TEST_FINGERPRINT,
        collections: { calendar: [], tasks: [], contacts: [], preferences: [], labelIndex: [] },
        itemCache: new Map([['remote-contact', {}]]),
      } as any)
      await useContactStore.getState().setContactFavorite('remote-contact', true)
      expect(useContactStore.getState().contacts[0]!.favorite).toBe(false)
      expect(toastMock.showErrorToast).toHaveBeenCalledWith('Failed to update favorite. Please try again.')
    })

    it('does not let an older failed request roll back a newer favorite value', async () => {
      let rejectFirst!: (reason: Error) => void
      const first = new Promise<never>((_resolve, reject) => { rejectFirst = reject })
      const updateItem = vi.fn()
        .mockReturnValueOnce(first)
        .mockResolvedValueOnce('remote')
      useEtebaseStore.setState({ account: {}, accountFingerprint: TEST_FINGERPRINT, itemCache: new Map([['remote-contact', {}]]), updateItem } as any)

      const older = useContactStore.getState().setContactFavorite('remote-contact', true)
      const newer = useContactStore.getState().setContactFavorite('remote-contact', false)
      rejectFirst(new Error('older request failed'))
      await Promise.all([older, newer])

      expect(useContactStore.getState().contacts[0]!.favorite).toBe(false)
    })

    it('serializes two successful writes so the latest value reaches the server last', async () => {
      let resolveFirst!: (value: 'remote') => void
      let resolveSecond!: (value: 'remote') => void
      const first = new Promise<'remote'>((resolve) => { resolveFirst = resolve })
      const second = new Promise<'remote'>((resolve) => { resolveSecond = resolve })
      const updateItem = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
      useEtebaseStore.setState({ account: {}, accountFingerprint: TEST_FINGERPRINT, itemCache: new Map([['remote-contact', {}]]), updateItem } as any)

      const favorite = useContactStore.getState().setContactFavorite('remote-contact', true)
      const unfavorite = useContactStore.getState().setContactFavorite('remote-contact', false)
      await vi.waitFor(() => expect(updateItem).toHaveBeenCalledTimes(1))
      expect(updateItem.mock.calls[0]![2]).toContain('X-SILENTSUITE-FAVORITE:1')
      resolveFirst('remote')
      await vi.waitFor(() => expect(updateItem).toHaveBeenCalledTimes(2))
      expect(updateItem.mock.calls[1]![2]).not.toContain('X-SILENTSUITE-FAVORITE:1')
      resolveSecond('remote')
      await Promise.all([favorite, unfavorite])
      expect(useContactStore.getState().contacts[0]!.favorite).toBe(false)
    })
  })
})
