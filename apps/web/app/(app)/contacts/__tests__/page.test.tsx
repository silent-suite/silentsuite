import { act, fireEvent, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ContactsPage from '../page'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import messages from '@/messages/en.json'
import type { Contact } from '@silentsuite/core'
import type { ContactList } from '@/app/stores/use-contact-list-store'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'

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
    searchQuery: '',
    setSearchQuery: vi.fn(),
    createContact: vi.fn(),
    updateContact: vi.fn(),
    deleteContact: vi.fn(),
    setContactFavorite: vi.fn(),
    canWriteContact: vi.fn(() => true),
    // No unsettled drafts here; the #744 save states have their own rendered test.
    contactSaveStates: {} as Record<string, string>,
  },
  contactListState: {
    lists: [] as ContactList[],
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
  // Detail ownership is exercised by the #744 rendered contact test.
  registerContactOwner: () => ({}),
  releaseContactOwnerWhenSettled: () => {},
  beginContactPhoto: () => false,
  endContactPhoto: () => {},
  setContactFieldDraft: () => {},
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
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    storeMock.contactState.searchQuery = ''
    storeMock.contactState.contacts = []
    storeMock.contactListState.lists = []
    storeMock.authState.canWrite.mockReturnValue(true)
  })

  it('derives its skeleton from the contacts domain and skips it for cached contacts (#747)', () => {
    const hasSkeleton = () => document.querySelector('.skeleton-shimmer') !== null
    const view = renderWithIntl(<ContactsPage />)
    expect(hasSkeleton()).toBe(true)

    storeMock.contactListState.lists = [{ id: 'book', name: 'Book', color: '#fff', visible: true, accessLevel: 2 }]
    storeMock.contactState.contacts = [{ id: 'c', uid: 'c', displayName: 'Cached', name: { prefix: '', given: 'Cached', family: '', suffix: '' }, phones: [], emails: [], addresses: [], organization: '', title: '', notes: '', birthday: null, photoUrl: null, listId: 'book', created_at: new Date(), updated_at: new Date() }]
    view.rerender(<ContactsPage />)
    expect(hasSkeleton()).toBe(false)
    expect(screen.getByText('Cached')).toBeInTheDocument()

    storeMock.contactState.contacts = []
    act(() => useEtebaseStore.setState({ restoreBlocked: true }))
    view.rerender(<ContactsPage />)
    expect(hasSkeleton()).toBe(false)
  })

  it('uses separate valid row and star controls and filters favorites', () => {
    storeMock.contactState.contacts = [
      { id: '1', uid: '1', displayName: 'Ada', name: { prefix: '', given: 'Ada', family: '', suffix: '' }, phones: [], emails: [], addresses: [], organization: '', title: '', notes: '', birthday: null, photoUrl: null, favorite: true, listId: 'book', created_at: new Date(), updated_at: new Date() },
      { id: '2', uid: '2', displayName: 'Bob', name: { prefix: '', given: 'Bob', family: '', suffix: '' }, phones: [], emails: [], addresses: [], organization: '', title: '', notes: '', birthday: null, photoUrl: null, favorite: false, listId: 'book', created_at: new Date(), updated_at: new Date() },
    ]
    storeMock.contactListState.lists = [{ id: 'book', name: 'Book', color: '#fff', visible: true, accessLevel: 2 }]
    renderWithIntl(<ContactsPage />)

    expect(screen.getByRole('button', { name: 'Remove Ada from favorites' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add Bob to favorites' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Favorites' }))
    expect(screen.getByText('Ada')).toBeInTheDocument()
    expect(screen.queryByText('Bob')).not.toBeInTheDocument()
  })

  it('preserves imported custom and multiple types when editing a value', () => {
    storeMock.contactListState.lists = [{ id: 'book', name: 'Book', color: '#fff', visible: true, accessLevel: 2 }]
    storeMock.contactState.contacts = [{ id: 'custom', uid: 'custom', displayName: 'Synthetic', name: { given: 'Synthetic', family: '', prefix: '', suffix: '' }, phones: [{ type: 'Desk: west', value: '111' }, { type: 'home,voice', value: '222' }], emails: [{ type: 'x-emergency', value: 'a@example.invalid' }], addresses: [], organization: '', title: '', notes: '', birthday: null, photoUrl: null, created_at: new Date(), updated_at: new Date() }]
    storeMock.contactState.contacts[0]!.listId = 'book'
    storeMock.contactState.contacts[0]!.addresses = [{ type: 'Postal desk', street: 'Street', city: '', state: '', postalCode: '', country: '' }]
    renderWithIntl(<ContactsPage />)
    fireEvent.click(screen.getByText('Synthetic'))
    fireEvent.click(screen.getByRole('button', { name: 'Edit contact' }))
    expect(screen.getByDisplayValue('Desk: west')).toHaveValue('Desk: west')
    expect(screen.getByDisplayValue('Home,voice')).toHaveValue('home,voice')
    expect(screen.getByDisplayValue('X-emergency')).toHaveValue('x-emergency')
    expect(screen.getByDisplayValue('Postal desk')).toHaveValue('Postal desk')
    fireEvent.change(screen.getByDisplayValue('111'), { target: { value: '333' } })
    fireEvent.blur(screen.getByDisplayValue('333'))
    expect(storeMock.contactState.updateContact).toHaveBeenCalledWith('custom', expect.objectContaining({ phones: [{ type: 'Desk: west', value: '333' }, { type: 'home,voice', value: '222' }] }))
    fireEvent.change(screen.getByDisplayValue('Desk: west'), { target: { value: 'work' } })
    expect(storeMock.contactState.updateContact).toHaveBeenLastCalledWith('custom', expect.objectContaining({ phones: [{ type: 'work', value: '111' }, { type: 'home,voice', value: '222' }] }))
  })

  it('shows retained custom properties as read-only Other fields rows (#865)', () => {
    const raw = ['X-TESTA:testA', 'X-TestB:testB', 'X-testC:testC', 'X-testd:testD']
    storeMock.contactListState.lists = [{ id: 'book', name: 'Book', color: '#fff', visible: true, accessLevel: 2 }]
    storeMock.contactState.contacts = [{ id: 'jd', uid: 'jd', displayName: 'John Doe', name: { prefix: '', given: 'John', family: 'Doe', suffix: '' }, phones: [{ type: 'cell', value: '+1 234 567890' }], emails: [], addresses: [], organization: '', title: '', notes: '', birthday: null, photoUrl: null, unknownProperties: [...raw], listId: 'book', created_at: new Date(), updated_at: new Date() }]
    renderWithIntl(<ContactsPage />)
    fireEvent.click(screen.getByText('John Doe'))

    const section = screen.getByText('Other fields').parentElement!
    for (const line of raw) {
      const [label, value] = line.split(':') as [string, string]
      expect(within(section).getByText(label)).toBeInTheDocument()
      expect(within(section).getByText(value)).toBeInTheDocument()
    }
    // Display only: the stored raw lines are never rewritten.
    expect(storeMock.contactState.contacts[0]!.unknownProperties).toEqual(raw)
  })

  it('shows Other fields as plain text conservatively and hides an empty section (#865)', () => {
    const raw = [
      'item1.X-Custom;TYPE="a:b";LANG=en:Line one\\nline two\\, ok\\; yes\\\\',
      'X-HTML:<b>bold</b> <script>x</script> https://example.invalid',
      'X-QP;ENCODING=QUOTED-PRINTABLE:Caf=C3=A9\\, x',
      'X-URI;VALUE=uri:https://example.invalid/a\\,b',
    ]
    const base = { name: { prefix: '', given: '', family: '', suffix: '' }, phones: [], emails: [], addresses: [], organization: '', title: '', notes: '', birthday: null, photoUrl: null, listId: 'book', created_at: new Date(), updated_at: new Date() }
    storeMock.authState.canWrite.mockReturnValue(false)
    storeMock.contactListState.lists = [{ id: 'book', name: 'Book', color: '#fff', visible: true, accessLevel: 0 }]
    storeMock.contactState.contacts = [
      { ...base, id: 'plain', uid: 'plain', displayName: 'Plain', unknownProperties: [] },
      { ...base, id: 'edge', uid: 'edge', displayName: 'Edge', unknownProperties: [...raw] },
    ]
    renderWithIntl(<ContactsPage />)
    fireEvent.click(screen.getByText('Plain'))
    expect(screen.queryByText('Other fields')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Edge'))
    const section = screen.getByText('Other fields').parentElement!
    const exact = (text: string) => within(section).getByText((_, el) => el?.tagName === 'SPAN' && el.textContent === text)
    expect(exact('X-Custom')).toBeInTheDocument()
    expect(exact('Line one\nline two, ok; yes\\')).toBeInTheDocument()
    expect(exact('<b>bold</b> <script>x</script> https://example.invalid')).toBeInTheDocument()
    // Encoded or non-text values stay visibly raw rather than being decoded as text.
    expect(exact('Caf=C3=A9\\, x')).toBeInTheDocument()
    expect(exact('https://example.invalid/a\\,b')).toBeInTheDocument()
    expect(section.querySelector('a, b, script, button, input, textarea')).toBeNull()
    expect(storeMock.contactState.contacts[1]!.unknownProperties).toEqual(raw)
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

  it('exposes a mobile collection switcher with a 44px touch target', () => {
    renderWithIntl(<ContactsPage />)
    const folderButton = screen.getByRole('button', { name: manageAddressBooks })
    expect(folderButton).toBeInTheDocument()
    // Mobile-only control that meets the minimum touch target.
    expect(folderButton.className).toContain('md:hidden')
    expect(folderButton.className).toContain('touch-target')
  })
})
