import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, within } from '@testing-library/react'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'

const updateCollectionMeta = vi.fn()

const mockContactListState = {
  lists: [
    { id: 'contacts-1', name: 'Work Contacts', color: '#8b5cf6', visible: true },
    { id: 'contacts-2', name: 'Home Contacts', color: '#10b981', visible: false },
  ],
  activeListId: 'contacts-1',
  toggleVisibility: vi.fn(),
  setActiveList: vi.fn(),
  getNextColor: vi.fn(() => '#10b981'),
}

const mockEtebaseState = {
  createCollection: vi.fn(),
  deleteCollection: vi.fn(),
  updateCollectionMeta,
  domainLoadState: { contacts: 'ready' } as Record<string, string>,
  isInitialized: true,
  restoreBlocked: false,
}

const mockContactState = {
  contacts: [] as Array<{ id: string; listId?: string }>,
}

vi.mock('@/app/stores/use-contact-list-store', () => ({
  useContactListStore: () => mockContactListState,
}))

vi.mock('@/app/stores/use-contact-store', () => ({
  useContactStore: <T,>(selector: (s: typeof mockContactState) => T) => selector(mockContactState),
}))

vi.mock('@/app/stores/use-etebase-store', () => ({
  useEtebaseStore: <T,>(selector: (s: typeof mockEtebaseState) => T) => selector(mockEtebaseState),
}))

import { ContactListPanel } from '../ContactListPanel'

describe('ContactListPanel', () => {
  beforeEach(() => {
    updateCollectionMeta.mockClear()
    mockContactListState.toggleVisibility.mockClear()
    mockContactListState.setActiveList.mockClear()
    mockContactState.contacts = []
    mockEtebaseState.domainLoadState = { contacts: 'ready' }
    mockEtebaseState.isInitialized = true
  })

  it('shows how many contacts each address book holds, including hidden ones', () => {
    mockContactState.contacts = [
      { id: '1', listId: 'contacts-1' },
      { id: '2', listId: 'contacts-1' },
      { id: '3', listId: 'contacts-2' },
    ]
    renderWithIntl(<ContactListPanel />)

    const work = screen.getByRole('button', { name: /^Work Contacts/ })
    expect(work).toHaveAccessibleName('Work Contacts, 2 contacts')
    expect(within(work).getByText('2', { selector: '[aria-hidden="true"]' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Home Contacts/ })).toHaveAccessibleName('Home Contacts, 1 contact')
  })

  it('shows 0 for an empty address book once contacts are loaded', () => {
    renderWithIntl(<ContactListPanel />)
    expect(screen.getByRole('button', { name: /^Work Contacts/ })).toHaveAccessibleName('Work Contacts, 0 contacts')
  })

  it('shows no counts while contacts are still loading', () => {
    mockEtebaseState.domainLoadState = { contacts: 'unknown' }
    mockEtebaseState.isInitialized = false
    renderWithIntl(<ContactListPanel />)
    expect(screen.getByRole('button', { name: /^Work Contacts/ })).toHaveAccessibleName('Work Contacts')
  })

  it('persists address-book color changes through collection metadata', () => {
    renderWithIntl(<ContactListPanel />)

    fireEvent.click(screen.getByLabelText('Open Work Contacts actions'))
    const colorInput = screen.getByLabelText('Change Work Contacts color')
    expect(colorInput).toHaveAttribute('type', 'color')

    fireEvent.change(colorInput, { target: { value: '#ff0000' } })

    expect(updateCollectionMeta).toHaveBeenCalledWith('contacts', 'contacts-1', { color: '#ff0000' })
  })

  it('renames address books through collection metadata', () => {
    renderWithIntl(<ContactListPanel />)

    fireEvent.click(screen.getByLabelText('Open Work Contacts actions'))
    fireEvent.click(screen.getByText('Rename'))
    const input = screen.getByLabelText('Rename Work Contacts')

    fireEvent.change(input, { target: { value: 'Client Contacts' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(updateCollectionMeta).toHaveBeenCalledWith('contacts', 'contacts-1', { name: 'Client Contacts' })
  })

  it('sets hidden address books as default and makes them visible', () => {
    renderWithIntl(<ContactListPanel />)

    fireEvent.click(screen.getByLabelText('Open Home Contacts actions'))
    fireEvent.click(screen.getByText('Set as default'))

    expect(mockContactListState.toggleVisibility).toHaveBeenCalledWith('contacts-2')
    expect(mockContactListState.setActiveList).toHaveBeenCalledWith('contacts-2')
  })

  it('gives the add button a mobile-only 44px hit area', () => {
    renderWithIntl(<ContactListPanel />)
    const add = screen.getByRole('button', { name: 'Add address book' })
    expect(add.className).toContain('max-md:min-h-[44px]')
    expect(add.className).toContain('max-md:min-w-[44px]')
    expect(add.className).not.toMatch(/(^|\s)min-h-\[44px\](\s|$)/)
  })
})
