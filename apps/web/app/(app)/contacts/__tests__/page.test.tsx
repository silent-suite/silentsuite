import { screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ContactsPage from '../page'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import messages from '@/messages/en.json'
import type { Contact } from '@silentsuite/core'
import type { ContactList } from '@/app/stores/use-contact-list-store'

// Mobile reachability smoke test for the Contacts page (epic #295). jsdom does
// not evaluate CSS media queries, so these assert that the primary create
// action, search, and the collection switcher render with their accessible
// labels and carry the expected responsive / touch-target classes,
// complementing manual width QA. Accessible names that are backed by next-intl
// messages are resolved from the message catalog so the tests do not couple to
// English copy.

const manageAddressBooks = messages.Collections.manageAddressBooks

const storeMock = vi.hoisted(() => ({
  contactState: {
    contacts: [] as Contact[],
    isLoading: true,
    searchQuery: '',
    setSearchQuery: vi.fn(),
    createContact: vi.fn(),
    updateContact: vi.fn(),
    deleteContact: vi.fn(),
  },
  contactListState: {
    lists: [] as ContactList[],
    activeListId: null as string | null,
  },
  syncState: {
    isOnline: true,
    initialSyncState: 'synced' as const,
    error: null as string | null,
  },
  authState: {
    canWrite: vi.fn(() => true),
  },
}))

vi.mock('@/app/stores/use-contact-store', () => ({
  useContactStore: (selector: (state: typeof storeMock.contactState) => unknown) => selector(storeMock.contactState),
  getFilteredContacts: (contacts: unknown[]) => contacts,
}))

vi.mock('@/app/stores/use-contact-list-store', () => ({
  useContactListStore: (selector: (state: typeof storeMock.contactListState) => unknown) => selector(storeMock.contactListState),
}))

vi.mock('@/app/stores/use-sync-store', () => ({
  useSyncStore: (selector: (state: typeof storeMock.syncState) => unknown) => selector(storeMock.syncState),
}))

vi.mock('@/app/stores/use-auth-store', () => ({
  useAuthStore: (selector: (state: typeof storeMock.authState) => unknown) => selector(storeMock.authState),
}))

vi.mock('@/app/components/MobileCollectionSheet', () => ({
  MobileCollectionSheet: ({ open }: { open: boolean }) => (open ? <div data-testid="collection-sheet" /> : null),
}))

describe('ContactsPage mobile reachability', () => {
  beforeEach(() => {
    storeMock.contactState.isLoading = true
    storeMock.contactState.searchQuery = ''
    storeMock.syncState.initialSyncState = 'synced'
    storeMock.syncState.error = null
    storeMock.authState.canWrite.mockReturnValue(true)
  })

  it('exposes the primary create action on all widths', () => {
    renderWithIntl(<ContactsPage />)
    const createButton = screen.getByRole('button', { name: 'New Contact' })
    expect(createButton).toBeInTheDocument()
    // Not hidden behind a desktop-only breakpoint.
    expect(createButton.className).not.toMatch(/(^|\s)hidden(\s|$)/)
    expect(createButton.className).not.toContain('md:flex')
  })

  it('exposes search on mobile', () => {
    renderWithIntl(<ContactsPage />)
    expect(screen.getByLabelText('Search contacts')).toBeInTheDocument()
  })

  it('shows restore copy before rendering the normal empty contact state', () => {
    storeMock.contactState.isLoading = false
    storeMock.syncState.initialSyncState = 'restoring'

    renderWithIntl(<ContactsPage />)

    expect(screen.getByText('Restoring encrypted data…')).toBeInTheDocument()
    expect(screen.queryByText('No contacts yet')).not.toBeInTheDocument()
  })

  it('does not show an empty contact state when the encrypted session is missing', () => {
    storeMock.contactState.isLoading = false
    storeMock.syncState.initialSyncState = 'no-session'

    renderWithIntl(<ContactsPage />)

    expect(screen.getByText('Encrypted session needs to be restored')).toBeInTheDocument()
    expect(screen.queryByText('No contacts yet')).not.toBeInTheDocument()
  })

  it('exposes a mobile collection switcher with a 44px touch target', () => {
    renderWithIntl(<ContactsPage />)
    const folderButton = screen.getByRole('button', { name: manageAddressBooks })
    expect(folderButton).toBeInTheDocument()
    // Mobile-only control that meets the minimum touch target.
    expect(folderButton.className).toContain('md:hidden')
    expect(folderButton.className).toContain('touch-target')
  })
})
