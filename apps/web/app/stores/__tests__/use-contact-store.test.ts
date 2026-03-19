import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useContactStore, getFilteredContacts } from '../use-contact-store'
import type { Contact } from '@silentsuite/core'

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
  })
})
