import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ContactsPage from '../page'

// Mobile reachability smoke test for the Contacts page (epic #295). jsdom does
// not evaluate CSS media queries, so these assert that the primary create
// action, search, and the collection switcher render with their accessible
// labels and carry the expected responsive / touch-target classes,
// complementing manual width QA.

const storeMock = vi.hoisted(() => ({
  contactState: {
    contacts: [] as any[],
    isLoading: true,
    searchQuery: '',
    setSearchQuery: vi.fn(),
    createContact: vi.fn(),
    updateContact: vi.fn(),
    deleteContact: vi.fn(),
  },
  contactListState: {
    lists: [] as any[],
    activeListId: null as string | null,
  },
  syncState: {
    isOnline: true,
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
    storeMock.authState.canWrite.mockReturnValue(true)
  })

  it('exposes the primary create action on all widths', () => {
    render(<ContactsPage />)
    const createButton = screen.getByRole('button', { name: 'New Contact' })
    expect(createButton).toBeInTheDocument()
    // Not hidden behind a desktop-only breakpoint.
    expect(createButton.className).not.toMatch(/(^|\s)hidden(\s|$)/)
    expect(createButton.className).not.toContain('md:flex')
  })

  it('exposes search on mobile', () => {
    render(<ContactsPage />)
    expect(screen.getByLabelText('Search contacts')).toBeInTheDocument()
  })

  it('exposes a mobile collection switcher with a 44px touch target', () => {
    render(<ContactsPage />)
    const folderButton = screen.getByRole('button', { name: 'Manage address books' })
    expect(folderButton).toBeInTheDocument()
    // Mobile-only control that meets the minimum touch target.
    expect(folderButton.className).toContain('md:hidden')
    expect(folderButton.className).toContain('touch-target')
  })
})
