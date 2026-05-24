import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const updateCollectionMeta = vi.fn()

const mockContactListState = {
  lists: [
    { id: 'contacts-1', name: 'Work Contacts', color: '#8b5cf6', visible: true },
  ],
  toggleVisibility: vi.fn(),
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
  })

  it('renders address-book color input and persists changes through collection metadata', () => {
    render(<ContactListPanel />)

    const colorInput = screen.getByLabelText('Change Work Contacts color')
    expect(colorInput).toHaveAttribute('type', 'color')

    fireEvent.change(colorInput, { target: { value: '#ff0000' } })

    expect(updateCollectionMeta).toHaveBeenCalledWith('contacts', 'contacts-1', { color: '#ff0000' })
  })
})
