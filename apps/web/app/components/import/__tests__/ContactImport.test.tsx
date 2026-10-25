import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import ContactImport from '../ContactImport'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import { deserializeContact, serializeContact, type Contact } from '@silentsuite/core'
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

  it('imports legacy text and labels through the real parser and serializer', async () => {
    const { container } = renderWithIntl(<ContactImport onImportComplete={mocks.onImportComplete} />)
    const source = [
      'BEGIN:VCARD', 'VERSION:2.1', 'FN;ENCODING=QUOTED-PRINTABLE:Ren=C3=A9',
      'N;ENCODING=QUOTED-PRINTABLE:Ex=3Bample;Ren=C3=A9;;;',
      'item1.X-ABLabel;ENCODING=QUOTED-PRINTABLE:B=C3=BCro', 'item1.TEL;WORK:111',
      'TEL;HOME;VOICE:222', 'EMAIL;X-Emergency:a@example.invalid',
      'item2.ADR;HOME:;;Street;City;;;', 'item2.X-ABLabel:Postal desk',
      'NOTE;ENCODING=QUOTED-PRINTABLE:First=0A=', '=E6=97=A5=E6=9C=AC',
      'CATEGORIES;ENCODING=QUOTED-PRINTABLE:Team=2C West,Caf=C3=A9',
      'X-SILENTSUITE-FAVORITE:1', 'END:VCARD',
      'BEGIN:VCARD', 'VERSION:4.0', 'FN:Second', 'TEL;TYPE="WORK,CELL":tel:333', 'END:VCARD',
    ].join('\r\n')
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File([source], 'synthetic.vcf', { type: 'text/vcard' })] },
    })
    mocks.importContacts.mockResolvedValue(2)
    fireEvent.click(await screen.findByRole('button', { name: /Import 2 contacts/ }))
    await waitFor(() => expect(mocks.onImportComplete).toHaveBeenCalledWith(2))
    const payload = mocks.importContacts.mock.calls[0]![0] as Contact[]
    expect(payload).toHaveLength(2)
    expect(payload[0]).toMatchObject({
      displayName: 'René', name: { family: 'Ex;ample', given: 'René' },
      phones: [{ type: 'Büro', value: '111' }, { type: 'home,voice', value: '222' }],
      emails: [{ type: 'Emergency', value: 'a@example.invalid' }],
      addresses: [{ type: 'Postal desk', street: 'Street' }],
      notes: 'First\n日本', categories: ['Team, West', 'Café'], favorite: true, listId: 'default',
    })
    expect(payload[1]!.phones).toEqual([{ type: 'work,cell', value: '333' }])
    // Add the identity/timestamps assigned by the store; exercise real wire persistence.
    const restored = deserializeContact(serializeContact({ ...payload[0]!, id: 'synthetic', uid: 'synthetic', created_at: new Date(), updated_at: new Date() }))
    for (const key of ['displayName', 'name', 'phones', 'emails', 'addresses', 'notes', 'categories', 'favorite'] as const) {
      expect(restored[key]).toEqual(payload[0]![key])
    }
  })

  it('carries unsupported properties of the exact #865 sample into the import payload and its stored vCard', async () => {
    const { container } = renderWithIntl(<ContactImport onImportComplete={mocks.onImportComplete} />)
    const extras = ['X-TESTA:testA', 'X-TestB:testB', 'X-testC:testC', 'X-testd:testD']
    const source = [
      'BEGIN:VCARD', 'VERSION:4.0', 'UID:20261023T213116Z1949487429', 'FN:John Doe', 'N:Doe;John;;;',
      'TEL;TYPE=cell:+1 234 567890', ...extras, 'END:VCARD',
    ].join('\n')
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File([source], 'issue-865.vcf', { type: 'text/vcard' })] },
    })
    fireEvent.click(await screen.findByRole('button', { name: /Import 1 contacts/ }))
    await waitFor(() => expect(mocks.importContacts).toHaveBeenCalledTimes(1))
    const payload = mocks.importContacts.mock.calls[0]![0] as Contact[]
    expect(payload[0]!.unknownProperties).toEqual(extras)
    // NewContact may omit empty lists; the store's buildContact supplies them.
    const wire = serializeContact({ ...payload[0]!, emails: payload[0]!.emails ?? [], addresses: payload[0]!.addresses ?? [], id: 'synthetic', uid: 'synthetic', created_at: new Date(), updated_at: new Date() })
    expect(wire.split('\r\n').filter((line) => /^X-test/i.test(line))).toEqual(extras)
  })

  describe('re-imports an exported card whose preserved property folds near a card-boundary word (#865)', () => {
    const exportedContact = (uid: string, displayName: string, unknownProperties?: string[]): Contact => ({
      id: uid, uid, displayName, name: { prefix: '', given: displayName, family: '', suffix: '' },
      phones: [], emails: [], addresses: [], organization: '', title: '', notes: '', birthday: null, photoUrl: null,
      categories: [], favorite: false, ...(unknownProperties ? { unknownProperties } : {}),
      created_at: new Date(Date.UTC(2026, 9, 25)), updated_at: new Date(Date.UTC(2026, 9, 25)),
    })
    /** The same bytes Settings Export downloads: BOM, then each serialized card terminated by CRLF. */
    const exportedFile = (contacts: Contact[]) =>
      new File([`﻿${contacts.map((contact) => `${serializeContact(contact)}\r\n`).join('')}`], 'silentsuite-contacts.vcf', { type: 'text/vcard' })
    const cardFrame = (line: string) => /^(BEGIN|END):VCARD$/.test(line.trim().toUpperCase())

    it.each([
      ['BEGIN:VCARD at the first fold', `X-FOO:${'a'.repeat(69)}BEGIN:VCARD`],
      ['END:VCARD at the first fold', `X-FOO:${'a'.repeat(69)}END:VCARD`],
      ['a lowercase boundary word', `X-FOO:${'a'.repeat(69)}begin:vcard`],
      ['leading whitespace before the word', `X-FOO:${'a'.repeat(69)}  END:VCARD`],
      ['trailing whitespace after the word', `X-FOO:${'a'.repeat(69)}BEGIN:VCARD  `],
      ['the word at a later fold', `X-FOO:${'a'.repeat(69)}${'b'.repeat(74)}END:VCARD`],
      ['an ordinary long folded Unicode value', `X-LONG:${'é中🙂 '.repeat(30)}end`],
    ])('keeps names, count and property bytes with %s', async (_label, line) => {
      const contacts = [exportedContact('boundary-1', 'Boundary Person', [line]), exportedContact('boundary-2', 'Second Person')]
      const { container } = renderWithIntl(<ContactImport onImportComplete={mocks.onImportComplete} />)
      mocks.importContacts.mockResolvedValue(2)
      fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [exportedFile(contacts)] } })
      // Wait for whichever outcome the importer reaches, then assert the behaviour itself.
      await waitFor(() => expect(screen.queryByRole('button', { name: /Import \d+ contacts/ }) ?? screen.queryByText(/Failed to parse the file/)).not.toBeNull())
      expect(screen.queryByText(/Failed to parse the file/)).toBeNull()
      expect(screen.getByRole('button', { name: /Import \d+ contacts/ }).textContent).toMatch(/Import 2 contacts/)
      fireEvent.click(screen.getByRole('button', { name: /Import \d+ contacts/ }))
      await waitFor(() => expect(mocks.importContacts).toHaveBeenCalledTimes(1))

      const payload = mocks.importContacts.mock.calls[0]![0] as Contact[]
      expect(payload.map((contact) => contact.displayName)).toEqual(['Boundary Person', 'Second Person'])
      expect(payload[0]!.unknownProperties).toEqual([line])
      expect(payload[1]!.unknownProperties).toBeUndefined()
      // Only the real frame lines may look like a card boundary to a line-trimming splitter.
      expect(serializeContact(contacts[0]!).split('\r\n').filter(cardFrame)).toEqual(['BEGIN:VCARD', 'END:VCARD'])
    })

    it('still folds an ordinary long preserved property', () => {
      const wire = serializeContact(exportedContact('fold-1', 'Fold Person', [`X-LONG:${'é中🙂 '.repeat(30)}end`]))
      expect(wire.split('\r\n').some((physical) => physical.startsWith(' '))).toBe(true)
    })
  })

  it('imports sample-shaped legacy cards without losing unlabeled numbers, photos, or the following duplicate-name card', async () => {
    const { container } = renderWithIntl(<ContactImport onImportComplete={mocks.onImportComplete} />)
    // Synthetic values reproduce both reports without committing customer contact data.
    const source = [
      'BEGIN:VCARD', 'VERSION:2.1', 'N:Example;Contact;;;', 'FN:Contact Example',
      'TEL;HOME:111', 'TEL;:222', 'TEL;:333',
      'ADR;HOME;ENCODING=QUOTED-PRINTABLE:;;=31=30=30=20=54=65=73=74=20=53=74=',
      '=0A=45=78=61=6D=70=6C=65=20=43=69=74=79;;;;', 'END:VCARD',
      'BEGIN:VCARD', 'VERSION:2.1', 'N:Example;Contact;;;', 'FN:Contact Example',
      'TEL;WORK:444', 'TEL;HOME:555', 'TEL;CELL:666', 'TEL;X-Desk:777',
      'PHOTO;ENCODING=BASE64;JPEG:/9j/', ' 2Q==', '', 'END:VCARD',
      'BEGIN:VCARD', 'VERSION:2.1', 'N:Example;Contact;;;', 'FN:Contact Example',
      'TEL;CELL:888', 'END:VCARD',
    ].join('\r\n')
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File([source], 'synthetic-legacy-samples.vcf', { type: 'text/vcard' })] },
    })
    mocks.importContacts.mockResolvedValue(3)
    fireEvent.click(await screen.findByRole('button', { name: /Import 3 contacts/ }))
    await waitFor(() => expect(mocks.onImportComplete).toHaveBeenCalledWith(3))
    expect(mocks.importContacts).toHaveBeenCalledTimes(1)
    const payload = mocks.importContacts.mock.calls[0]![0] as Contact[]
    expect(payload).toHaveLength(3)
    expect(payload.map(contact => contact.displayName)).toEqual(['Contact Example', 'Contact Example', 'Contact Example'])
    expect(payload[0]!.phones).toEqual([{ type: 'home', value: '111' }, { type: 'other', value: '222' }, { type: 'other', value: '333' }])
    expect(payload[0]!.addresses[0]).toMatchObject({ type: 'home', street: '100 Test St\nExample City' })
    expect(payload[1]!.phones).toEqual([{ type: 'work', value: '444' }, { type: 'home', value: '555' }, { type: 'cell', value: '666' }, { type: 'Desk', value: '777' }])
    expect(payload[1]!.photoUrl).toBe('data:image/jpeg;base64,/9j/2Q==')
    expect(payload[2]!.phones).toEqual([{ type: 'cell', value: '888' }])
    for (const [index, contact] of payload.entries()) {
      // The real store supplies empty arrays for fields omitted from NewContact.
      const normalized = { ...contact, emails: contact.emails ?? [], addresses: contact.addresses ?? [] }
      const restored = deserializeContact(serializeContact({ ...normalized, id: `synthetic-${index}`, uid: `synthetic-${index}`, created_at: new Date(), updated_at: new Date() }))
      for (const key of ['displayName', 'name', 'phones', 'addresses', 'photoUrl'] as const) {
        expect(restored[key]).toEqual(normalized[key])
      }
    }
  })

  it.each(['bad=QZ', 'unfinished=', 'bad=C3'])('does not offer a partial import for malformed encoding or a dangling END boundary: %s', async (value) => {
    const { container } = renderWithIntl(<ContactImport onImportComplete={mocks.onImportComplete} />)
    const source = `BEGIN:VCARD\nVERSION:2.1\nFN:Valid\nEND:VCARD\nBEGIN:VCARD\nVERSION:2.1\nFN;ENCODING=QUOTED-PRINTABLE:${value}\nEND:VCARD\nBEGIN:VCARD\nVERSION:2.1\nFN:Following\nEND:VCARD`
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File([source], 'synthetic-invalid.vcf', { type: 'text/vcard' })] },
    })
    expect(await screen.findByText('Failed to parse the file. Please make sure it is a valid .vcf file.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Import \d+ contacts/ })).not.toBeInTheDocument()
    expect(mocks.importContacts).not.toHaveBeenCalled()
  })
})
