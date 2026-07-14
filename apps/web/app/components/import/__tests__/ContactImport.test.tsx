import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import ContactImport from '../ContactImport'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
const mocks = vi.hoisted(() => ({
  importContacts: vi.fn(),
  createCollection: vi.fn(),
  onImportComplete: vi.fn(),
}))


vi.mock('@/app/stores/use-contact-store', () => ({
  useContactStore: function useContactStore<T>(selector: (state: {
    importContacts: typeof mocks.importContacts
  }) => T): T {
    return selector({ importContacts: mocks.importContacts })
  },
}))

vi.mock('@/app/stores/use-contact-list-store', () => ({
  useContactListStore: function useContactListStore<T>(selector: (state: {
    lists: { id: string; name: string; color: string; visible: boolean }[]
    activeListId: string
  }) => T): T {
    return selector({
      lists: [{ id: 'default', name: 'Default', color: '#10b981', visible: true }],
      activeListId: 'default',
    })
  },
}))

vi.mock('@/app/stores/use-etebase-store', () => ({
  useEtebaseStore: function useEtebaseStore<T>(selector: (state: {
    createCollection: typeof mocks.createCollection
  }) => T): T {
    return selector({ createCollection: mocks.createCollection })
  },
}))

describe('ContactImport categories normalization', () => {
  beforeEach(() => {
    mocks.importContacts.mockReset().mockResolvedValue(1)
    mocks.createCollection.mockReset()
    mocks.onImportComplete.mockReset()
  })

  it('normalizes categories in the built import payload', async () => {
    const { container } = renderWithIntl(<ContactImport onImportComplete={mocks.onImportComplete} />)

    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(
      ['BEGIN:VCARD\nVERSION:4.0\nUID:vc-1\nFN:Jane Doe\nCATEGORIES: Work ,work,Home\nX-SILENTSUITE-FAVORITE:1\nEND:VCARD'],
      'contacts.vcf',
      { type: 'text/vcard' },
    )
    fireEvent.change(input, { target: { files: [file] } })

    const importButton = await screen.findByRole('button', { name: /Import 1 contacts/ })
    fireEvent.click(importButton)

    await waitFor(() => {
      expect(mocks.importContacts).toHaveBeenCalledTimes(1)
    })

    const payload = mocks.importContacts.mock.calls[0]![0] as Array<{ categories: string[]; favorite: boolean }>
    expect(payload[0]!.categories).toEqual(['Work', 'Home'])
    expect(payload[0]!.favorite).toBe(true)
  })
})
