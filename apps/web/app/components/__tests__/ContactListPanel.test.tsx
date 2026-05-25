import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

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
}

vi.mock('@/app/stores/use-contact-list-store', () => ({
  useContactListStore: () => mockContactListState,
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
  })

  it('persists address-book color changes through collection metadata', () => {
    render(<ContactListPanel />)

    fireEvent.click(screen.getByLabelText('Open Work Contacts actions'))
    const colorInput = screen.getByLabelText('Change Work Contacts color')
    expect(colorInput).toHaveAttribute('type', 'color')

    fireEvent.change(colorInput, { target: { value: '#ff0000' } })

    expect(updateCollectionMeta).toHaveBeenCalledWith('contacts', 'contacts-1', { color: '#ff0000' })
  })

  it('renames address books through collection metadata', () => {
    render(<ContactListPanel />)

    fireEvent.click(screen.getByLabelText('Open Work Contacts actions'))
    fireEvent.click(screen.getByText('Rename'))
    const input = screen.getByLabelText('Rename Work Contacts')

    fireEvent.change(input, { target: { value: 'Client Contacts' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(updateCollectionMeta).toHaveBeenCalledWith('contacts', 'contacts-1', { name: 'Client Contacts' })
  })

  it('sets hidden address books as default and makes them visible', () => {
    render(<ContactListPanel />)

    fireEvent.click(screen.getByLabelText('Open Home Contacts actions'))
    fireEvent.click(screen.getByText('Set as default'))

    expect(mockContactListState.toggleVisibility).toHaveBeenCalledWith('contacts-2')
    expect(mockContactListState.setActiveList).toHaveBeenCalledWith('contacts-2')
  })
})
