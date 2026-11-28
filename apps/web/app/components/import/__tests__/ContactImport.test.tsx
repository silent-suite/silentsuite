import { describe, it, expect, beforeEach, onTestFinished, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import ContactImport, { MAX_CONTACT_IMPORT_FILE_BYTES } from '../ContactImport'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import { deserializeContact, serializeContact, type Contact } from '@silentsuite/core'
import { ImportIncompleteError } from '@/app/lib/import-outcome'
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

  it('carries hidden name and address components from a file into its import payload', async () => {
    const { container } = renderWithIntl(<ContactImport onImportComplete={mocks.onImportComplete} />)
    const source = ['BEGIN:VCARD', 'VERSION:3.0', 'UID:hidden', 'FN:John Public', 'N:Public;John;Quinlan,James;;', 'ADR;TYPE=home:PO Box 123;Apartment 4;;;;;', 'END:VCARD'].join('\r\n')
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File([source], 'hidden.vcf', { type: 'text/vcard' })] } })
    fireEvent.click(await screen.findByRole('button', { name: /Import 1 contacts/ }))
    await waitFor(() => expect(mocks.importContacts).toHaveBeenCalledTimes(1))
    const payload = mocks.importContacts.mock.calls[0]![0][0]
    const wire = serializeContact({ ...deserializeContact(source), ...payload, phones: payload.phones ?? [], emails: payload.emails ?? [] })
    expect(wire).toContain('N:Public;John;Quinlan,James;;')
    expect(wire).toContain('ADR;TYPE=home:PO Box 123;Apartment 4;;;;;')
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
      ['a dotless i that uppercases to the boundary word', `X-FOO:${'a'.repeat(69)}begın:vcard`],
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

  it.each(['bad=QZ', 'unfinished=', 'bad=C3'])('skips a card with malformed encoding or a dangling END boundary and keeps the rest: %s', async (value) => {
    const { container } = renderWithIntl(<ContactImport onImportComplete={mocks.onImportComplete} />)
    const source = `BEGIN:VCARD\nVERSION:2.1\nFN:Valid\nEND:VCARD\nBEGIN:VCARD\nVERSION:2.1\nFN;ENCODING=QUOTED-PRINTABLE:${value}\nEND:VCARD\nBEGIN:VCARD\nVERSION:2.1\nFN:Following\nEND:VCARD`
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File([source], 'synthetic-invalid.vcf', { type: 'text/vcard' })] },
    })
    expect(await screen.findByText("1 contact couldn't be read.")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import 2 contacts' })).toBeInTheDocument()
    expect(screen.getByText('Valid')).toBeInTheDocument()
    expect(screen.getByText('Following')).toBeInTheDocument()
    expect(mocks.importContacts).not.toHaveBeenCalled()
  })
})

// C3a-R6 (PLAN U1, U2, U4). The store outcome is controlled here to isolate the recovery UI;
// the store contract itself is proven against the pinned SDK in use-contact-store.test.ts.
describe('C3a-R6 ContactImport reports only acknowledged contacts and keeps the rest for retry', () => {
  const vcf = (names: string[]) => new File(
    [names.map((name) => ['BEGIN:VCARD', 'VERSION:4.0', `FN:${name}`, 'END:VCARD'].join('\r\n')).join('\r\n')],
    'contacts.vcf',
    { type: 'text/vcard' },
  )
  const caveat = /may already be saved/i
  const payloadNames = (call: number) => (mocks.importContacts.mock.calls[call]![0] as { displayName: string }[]).map(({ displayName }) => displayName)

  beforeEach(() => {
    mocks.importContacts.mockReset()
    mocks.onImportComplete.mockReset()
  })

  async function previewContacts(names: string[]) {
    const { container } = renderWithIntl(<ContactImport onImportComplete={mocks.onImportComplete} />)
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [vcf(names)] } })
    return screen.findByRole('button', { name: `Import ${names.length} contacts` })
  }

  it('C3a-R6 contacts: a partial unconfirmed import reports the acknowledged count, warns before retry, and retries only the rest', async () => {
    mocks.importContacts
      .mockRejectedValueOnce(new ImportIncompleteError(1, [1], true, ['saved', 'uncertain']))
      .mockResolvedValueOnce(1)
    fireEvent.click(await previewContacts(['Ada One', 'Bea Two']))

    const message = await screen.findByText(/Imported 1 of 2 contacts/)
    expect(message.textContent).toMatch(/(weren't|were not) confirmed as saved/i)
    expect(message.textContent).toMatch(caveat)
    expect(screen.queryByText(/contacts imported/)).toBeNull()
    expect(mocks.onImportComplete).not.toHaveBeenCalled()

    // Only the unacknowledged original record stays previewed and importable.
    const retry = screen.getByRole('button', { name: 'Import 1 contacts' })
    expect(screen.queryByText('Ada One')).toBeNull()
    expect(screen.getByText('Bea Two')).toBeInTheDocument()

    fireEvent.click(retry)
    await waitFor(() => expect(mocks.onImportComplete).toHaveBeenCalledWith(1))
    expect(payloadNames(1)).toEqual(['Bea Two'])
    expect(screen.getByText('1 contacts imported')).toBeInTheDocument()
    expect(screen.queryByText(/Imported 1 of 2 contacts/)).toBeNull()
  })

  it('C3a-R6 contacts: an unconfirmed import with nothing acknowledged keeps every contact and warns they may already be saved', async () => {
    mocks.importContacts.mockRejectedValueOnce(new ImportIncompleteError(0, [0, 1], true, ['uncertain', 'uncertain']))
    fireEvent.click(await previewContacts(['Ada One', 'Bea Two']))

    const message = await screen.findByText(/Imported 0 of 2 contacts/)
    expect(message.textContent).toMatch(caveat)
    expect(screen.getByRole('button', { name: 'Import 2 contacts' })).toBeInTheDocument()
    expect(screen.getByText('Ada One')).toBeInTheDocument()
    expect(screen.getByText('Bea Two')).toBeInTheDocument()
    expect(mocks.onImportComplete).not.toHaveBeenCalled()
  })

  it('C3a-R6 contacts: an import that sent nothing says none were saved, without the may-already-be-saved caveat', async () => {
    mocks.importContacts.mockRejectedValueOnce(new ImportIncompleteError(0, [0, 1], false, ['notSent', 'notSent']))
    fireEvent.click(await previewContacts(['Ada One', 'Bea Two']))

    const message = await screen.findByText(/None of the 2 contacts were saved/i)
    expect(message.textContent).not.toMatch(caveat)
    expect(screen.getByRole('button', { name: 'Import 2 contacts' })).toBeInTheDocument()
    expect(screen.getByText('Ada One')).toBeInTheDocument()
    expect(screen.getByText('Bea Two')).toBeInTheDocument()
    expect(mocks.onImportComplete).not.toHaveBeenCalled()
  })

  it('C3a-R6 contacts: a file chosen while an import is pending is refused, so the failed import keeps its own file, preview and retry', async () => {
    let rejectPending!: (reason: unknown) => void
    mocks.importContacts
      .mockImplementationOnce(() => new Promise<number>((_, reject) => { rejectPending = reject }))
      .mockResolvedValueOnce(1)
    // Never leave the deferred import pending, even when an assertion fails first.
    onTestFinished(() => rejectPending?.(new Error('settled at test end')))
    const { container } = renderWithIntl(<ContactImport onImportComplete={mocks.onImportComplete} />)
    const input = container.querySelector('input[type="file"]')!
    fireEvent.change(input, { target: { files: [vcf(['Ada One', 'Bea Two'])] } })
    fireEvent.click(await screen.findByRole('button', { name: 'Import 2 contacts' }))
    await waitFor(() => expect(mocks.importContacts).toHaveBeenCalledTimes(1))

    // Another file while the first import is still pending, given time to be read if it were accepted.
    const replacement = new File([['BEGIN:VCARD', 'VERSION:4.0', 'FN:Cy Replacement', 'END:VCARD'].join('\r\n')], 'replacement.vcf', { type: 'text/vcard' })
    fireEvent.change(input, { target: { files: [replacement] } })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
    expect(screen.queryByText('replacement.vcf')).toBeNull()
    expect(screen.getByText('contacts.vcf')).toBeInTheDocument()
    expect(screen.queryByText('Cy Replacement')).toBeNull()
    expect(screen.getByText('Ada One')).toBeInTheDocument()

    await act(async () => { rejectPending(new ImportIncompleteError(1, [1], true)) })
    await screen.findByText(/Imported 1 of 2 contacts/)
    expect(screen.getByText('contacts.vcf')).toBeInTheDocument()
    expect(screen.queryByText('Cy Replacement')).toBeNull()
    expect(screen.getByText('Bea Two')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Import 1 contacts' }))
    await waitFor(() => expect(mocks.onImportComplete).toHaveBeenCalledWith(1))
    expect(payloadNames(1)).toEqual(['Bea Two'])
    expect(mocks.importContacts).toHaveBeenCalledTimes(2)
  })

  it('C3a-R6 contacts control: after an import settles, choosing another file still replaces the file, preview and retry', async () => {
    mocks.importContacts
      .mockRejectedValueOnce(new ImportIncompleteError(1, [1], true))
      .mockResolvedValueOnce(1)
    const { container } = renderWithIntl(<ContactImport onImportComplete={mocks.onImportComplete} />)
    const input = container.querySelector('input[type="file"]')!
    fireEvent.change(input, { target: { files: [vcf(['Ada One', 'Bea Two'])] } })
    fireEvent.click(await screen.findByRole('button', { name: 'Import 2 contacts' }))
    await screen.findByText(/Imported 1 of 2 contacts/)

    const replacement = new File([['BEGIN:VCARD', 'VERSION:4.0', 'FN:Cy Replacement', 'END:VCARD'].join('\r\n')], 'replacement.vcf', { type: 'text/vcard' })
    fireEvent.change(input, { target: { files: [replacement] } })
    await screen.findByText('Cy Replacement')
    expect(screen.queryByText('Bea Two')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 contacts' }))

    await waitFor(() => expect(mocks.onImportComplete).toHaveBeenCalledWith(1))
    expect(payloadNames(1)).toEqual(['Cy Replacement'])
    expect(screen.getByText('replacement.vcf')).toBeInTheDocument()
    expect(screen.queryByText(/Imported 1 of 2 contacts/)).toBeNull()
  })

  it('C3a-R6 contacts: a fully acknowledged import still reports its true count', async () => {
    mocks.importContacts.mockResolvedValueOnce(2)
    fireEvent.click(await previewContacts(['Ada One', 'Bea Two']))

    await waitFor(() => expect(mocks.onImportComplete).toHaveBeenCalledWith(2))
    expect(screen.getByText('2 contacts imported')).toBeInTheDocument()
    expect(payloadNames(0)).toEqual(['Ada One', 'Bea Two'])
  })
})

// Yearless and text birthdays through the rendered importer (repair plan v2, D2-D4).
// BEHAVIOR messages are the regression; FIXTURE marks a broken harness.
describe('ContactImport birthdays', () => {
  type FlaggedContact = Contact & { birthdayIsText?: boolean }
  const bdayLines = (wire: string) => wire.split('\r\n').filter((line) => /^BDAY[;:]/i.test(line))

  beforeEach(() => {
    mocks.importContacts.mockReset().mockResolvedValue(7)
    mocks.onImportComplete.mockReset()
  })

  it('imports yearless dates without a year and keeps date-shaped text as text', async () => {
    const { container } = renderWithIntl(<ContactImport onImportComplete={mocks.onImportComplete} />)
    const cards: Array<[string, string, string]> = [
      ['4.0', 'Basic', 'BDAY:--0416'],
      ['3.0', 'Apple', 'BDAY;X-APPLE-OMIT-YEAR=1604:1604-04-16'],
      ['4.0', 'Text basic', 'BDAY;VALUE=text:--0416'],
      ['3.0', 'Text extended', 'BDAY;VALUE=TEXT:--04-16'],
      ['4.0', 'Leap', 'BDAY:--02-29'],
      ['3.0', 'Full', 'BDAY:1990-04-16'],
      ['3.0', 'None', ''],
    ]
    const source = cards
      .map(([version, name, bday]) => ['BEGIN:VCARD', `VERSION:${version}`, `FN:${name}`, ...(bday ? [bday] : []), 'END:VCARD'].join('\r\n'))
      .join('\r\n')
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File([source], 'synthetic-birthdays.vcf', { type: 'text/vcard' })] },
    })
    fireEvent.click(await screen.findByRole('button', { name: /Import 7 contacts/ }))
    await waitFor(() => expect(mocks.importContacts).toHaveBeenCalledTimes(1))

    const payload = mocks.importContacts.mock.calls[0]![0] as FlaggedContact[]
    if (payload.length !== 7) throw new Error(`FIXTURE: expected 7 imported cards, got ${payload.length}`)
    expect(payload.map((c) => [c.displayName, c.birthday, c.birthdayIsText === true]), 'BEHAVIOR: imported birthday values and types').toEqual([
      ['Basic', '--04-16', false],
      ['Apple', '--04-16', false],
      ['Text basic', '--0416', true],
      ['Text extended', '--04-16', true],
      ['Leap', '--02-29', false],
      ['Full', '1990-04-16', false],
      ['None', null, false],
    ])

    const expectedLines = [
      ['BDAY;X-APPLE-OMIT-YEAR=1604:1604-04-16'],
      ['BDAY;X-APPLE-OMIT-YEAR=1604:1604-04-16'],
      ['BDAY;VALUE=text:--0416'],
      ['BDAY;VALUE=text:--04-16'],
      ['BDAY;X-APPLE-OMIT-YEAR=1604:1604-02-29'],
      ['BDAY:1990-04-16'],
      [],
    ]
    payload.forEach((imported, index) => {
      // Add the identity/timestamps and the empty name/list defaults the store's buildContact
      // assigns (these cards have no N, TEL, EMAIL or ADR); exercise real wire persistence and reload.
      const name = {
        prefix: imported.name?.prefix ?? '',
        given: imported.name?.given ?? '',
        family: imported.name?.family ?? '',
        suffix: imported.name?.suffix ?? '',
      }
      const record = {
        ...imported,
        name,
        phones: imported.phones ?? [],
        emails: imported.emails ?? [],
        addresses: imported.addresses ?? [],
        id: `synthetic-${index}`,
        uid: `synthetic-${index}`,
        created_at: new Date(),
        updated_at: new Date(),
      }
      const wire = serializeContact(record)
      expect(bdayLines(wire), `BEHAVIOR: ${imported.displayName} persisted form`).toEqual(expectedLines[index])
      const reloaded = deserializeContact(wire) as FlaggedContact
      expect([reloaded.birthday, reloaded.birthdayIsText === true], `BEHAVIOR: ${imported.displayName} reload`).toEqual([imported.birthday, imported.birthdayIsText === true])
      expect(bdayLines(serializeContact(reloaded)), `BEHAVIOR: ${imported.displayName} repeated serialization`).toEqual(expectedLines[index])
    })
  })

  // A text birthday is written with a `BDAY;VALUE=text:` header (16 octets), so 59 more
  // octets fill the first 75-octet line and the next characters start a continuation.
  // The importer's line-trimming splitter must never read a continuation as a frame.
  describe('re-imports an exported text birthday that folds near a card-boundary word', () => {
    const FOLLOWING = 'X-FOLLOW:kept'
    const exportedContact = (uid: string, displayName: string, birthday: string | null, unknownProperties?: string[]): FlaggedContact => ({
      id: uid, uid, displayName, name: { prefix: '', given: displayName, family: '', suffix: '' },
      phones: [], emails: [], addresses: [], organization: '', title: '', notes: '',
      birthday, ...(birthday ? { birthdayIsText: true } : {}), photoUrl: null,
      categories: [], favorite: false, ...(unknownProperties ? { unknownProperties } : {}),
      created_at: new Date(Date.UTC(2026, 9, 25)), updated_at: new Date(Date.UTC(2026, 9, 25)),
    })
    /** The same bytes Settings Export downloads: BOM, then each serialized card terminated by CRLF. */
    const exportedFile = (contacts: Contact[]) =>
      new File([`﻿${contacts.map((contact) => `${serializeContact(contact)}\r\n`).join('')}`], 'silentsuite-contacts.vcf', { type: 'text/vcard' })
    const cardFrame = (line: string) => /^(BEGIN|END):VCARD$/.test(line.trim().toUpperCase())

    it.each([
      ['END:VCARD at the first fold', `${'a'.repeat(59)}END:VCARD`],
      ['BEGIN:VCARD at the first fold', `${'a'.repeat(59)}BEGIN:VCARD`],
      ['a lowercase boundary word', `${'a'.repeat(59)}end:vcard`],
      ['leading whitespace before the word', `${'a'.repeat(59)}  BEGIN:VCARD`],
      ['the word at a later fold', `${'a'.repeat(59)}${'b'.repeat(74)}END:VCARD`],
      ['a dotless i that uppercases to the boundary word', `${'a'.repeat(59)}begın:vcard`],
      ['an ordinary long folded text birthday', `circa ${'x'.repeat(90)}`],
    ])('keeps count, names, text birthday and the following property with %s', async (_label, birthday) => {
      const contacts = [
        exportedContact('text-bday-1', 'Text Birthday', birthday, [FOLLOWING]),
        exportedContact('text-bday-2', 'Second Person', null),
      ]
      const wire = serializeContact(contacts[0]!)
      // Control: the canonical parser unfolds the stored card correctly either way.
      const stored = deserializeContact(wire) as FlaggedContact
      expect([stored.birthday, stored.birthdayIsText, stored.unknownProperties], 'BEHAVIOR: stored card round trip').toEqual([birthday, true, [FOLLOWING]])

      const { container } = renderWithIntl(<ContactImport onImportComplete={mocks.onImportComplete} />)
      mocks.importContacts.mockReset().mockResolvedValue(2)
      fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [exportedFile(contacts)] } })
      // Wait for whichever outcome the importer reaches, then assert the behaviour itself.
      await waitFor(() => expect(screen.queryByRole('button', { name: /Import \d+ contacts/ }) ?? screen.queryByText(/Failed to parse the file/)).not.toBeNull())
      expect(screen.queryByText(/Failed to parse the file/), 'BEHAVIOR: exported file parses').toBeNull()
      expect(screen.getByRole('button', { name: /Import \d+ contacts/ }).textContent, 'BEHAVIOR: one exported card stays one card').toMatch(/Import 2 contacts/)
      fireEvent.click(screen.getByRole('button', { name: /Import \d+ contacts/ }))
      await waitFor(() => expect(mocks.importContacts).toHaveBeenCalledTimes(1))

      const payload = mocks.importContacts.mock.calls[0]![0] as FlaggedContact[]
      expect(payload.map((contact) => contact.displayName), 'BEHAVIOR: imported card names').toEqual(['Text Birthday', 'Second Person'])
      expect([payload[0]!.birthday, payload[0]!.birthdayIsText], 'BEHAVIOR: text birthday and type survive').toEqual([birthday, true])
      expect(payload[0]!.unknownProperties, 'BEHAVIOR: the property after BDAY survives').toEqual([FOLLOWING])
      expect(payload[1]!.unknownProperties, 'BEHAVIOR: nothing leaks into the following card').toBeUndefined()
      // Only the real frame lines may look like a card boundary to a line-trimming splitter.
      expect(wire.split('\r\n').filter(cardFrame), 'BEHAVIOR: no continuation reads as a frame').toEqual(['BEGIN:VCARD', 'END:VCARD'])
    })
  })
})

describe('ContactImport file size limit', () => {
  const card = 'BEGIN:VCARD\nVERSION:4.0\nUID:big-1\nFN:Long Notes\nEND:VCARD'
  const sized = (bytes: number) => {
    const file = new File([card], 'contacts.vcf', { type: 'text/vcard' })
    Object.defineProperty(file, 'size', { value: bytes })
    return file
  }

  it('accepts a 40 MB file, like a large address book with long notes', async () => {
    const { container } = renderWithIntl(<ContactImport onImportComplete={vi.fn()} />)
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [sized(40 * 1024 * 1024)] } })
    expect(await screen.findByRole('button', { name: /Import 1 contacts/ })).toBeTruthy()
    expect(screen.queryByText(/File is too large/)).toBeNull()
  })

  it('refuses a file over 50 MB', async () => {
    expect(MAX_CONTACT_IMPORT_FILE_BYTES).toBe(50 * 1024 * 1024)
    const { container } = renderWithIntl(<ContactImport onImportComplete={vi.fn()} />)
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [sized(MAX_CONTACT_IMPORT_FILE_BYTES + 1)] } })
    expect(await screen.findByText('File is too large. Maximum size is 50 MB.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Import 1 contacts/ })).toBeNull()
  })
})

describe('ContactImport large-file robustness', () => {
  const file = (text: string, name = 'contacts.vcf') => new File([text], name, { type: 'text/vcard' })
  const select = async (...files: File[]) => {
    const view = renderWithIntl(<ContactImport onImportComplete={mocks.onImportComplete} />)
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files } })
    return view
  }
  const sentUids = async (count: number) => {
    fireEvent.click(await screen.findByRole('button', { name: `Import ${count} contacts` }))
    await waitFor(() => expect(mocks.importContacts).toHaveBeenCalledTimes(1))
    return (mocks.importContacts.mock.calls[0]![0] as { uid?: string }[]).map(({ uid }) => uid)
  }

  beforeEach(() => {
    mocks.importContacts.mockReset().mockResolvedValue(1)
    mocks.onImportComplete.mockReset()
  })

  it('keeps a card whole when a folded continuation reads BEGIN:VCARD or END:VCARD', async () => {
    await select(file('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ada\r\nEMAIL:a@example.com\r\nNOTE:x\r\n BEGIN:VCARD\r\nNOTE:y\r\n END:VCARD\r\nTITLE:Kept\r\nEND:VCARD\r\n'))
    fireEvent.click(await screen.findByRole('button', { name: 'Import 1 contacts' }))
    await waitFor(() => expect(mocks.importContacts).toHaveBeenCalledTimes(1))
    const [imported] = mocks.importContacts.mock.calls[0]![0] as { displayName: string; title: string; emails: { value: string }[] }[]
    expect(imported).toMatchObject({ displayName: 'Ada', title: 'Kept', emails: [{ value: 'a@example.com' }] })
  })

  it("re-imports the app's own serialization when a fold lands on BEGIN:VCARD", async () => {
    const note = `${'n'.repeat(70)}BEGIN:VCARD`
    const content = serializeContact({ id: 'x', uid: 'x', displayName: 'Folded', name: { given: 'Folded', family: '', prefix: '', suffix: '' }, phones: [], emails: [], addresses: [], organization: '', title: '', notes: note, birthday: null, photoUrl: null, categories: [], favorite: false, created_at: new Date(), updated_at: new Date() } as Contact)
    expect(content).toContain('\r\n BEGIN:VCARD')
    await select(file(content))
    fireEvent.click(await screen.findByRole('button', { name: 'Import 1 contacts' }))
    await waitFor(() => expect(mocks.importContacts).toHaveBeenCalledTimes(1))
    const [imported] = mocks.importContacts.mock.calls[0]![0] as { displayName: string; notes: string }[]
    expect(imported).toMatchObject({ displayName: 'Folded', notes: note })
  })

  it('warns about notes over 200,000 characters but still imports them', async () => {
    await select(file(`BEGIN:VCARD\r\nFN:Long\r\nNOTE:${'n'.repeat(200_001)}\r\nEND:VCARD\r\nBEGIN:VCARD\r\nFN:Edge\r\nNOTE:${'n'.repeat(200_000)}\r\nEND:VCARD\r\n`))
    expect(await screen.findByText('1 contact has a note over 200,000 characters and may not sync to Android.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import 2 contacts' })).toBeInTheDocument()
  })

  it('counts a final card without END and a BEGIN before an END as unreadable', async () => {
    await select(file('BEGIN:VCARD\nFN:Open\nBEGIN:VCARD\nFN:Whole\nEND:VCARD\nBEGIN:VCARD\nFN:Tail'))
    expect(await screen.findByText("2 contacts couldn't be read.")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import 1 contacts' })).toBeInTheDocument()
  })

  it('skips bad QP and ENCODING=B cards and shows how many could not be read', async () => {
    await select(file('BEGIN:VCARD\nFN:One\nEND:VCARD\nBEGIN:VCARD\nNOTE;ENCODING=QUOTED-PRINTABLE:=G0\nFN:Bad\nEND:VCARD\nBEGIN:VCARD\nFN:Two\nNOTE;ENCODING=B:YWJj\nEND:VCARD\nBEGIN:VCARD\nFN:Three\nEND:VCARD'))
    expect(await screen.findByText("2 contacts couldn't be read.")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import 2 contacts' })).toBeInTheDocument()
  })

  it('keeps the existing error when no card is readable', async () => {
    await select(file('BEGIN:VCARD\nNOTE;ENCODING=B:YWJj\nFN:Bad\nEND:VCARD'))
    expect(await screen.findByText('Failed to parse the file. Please make sure it is a valid .vcf file.')).toBeInTheDocument()
  })

  it('passes the file UID and the file-import options', async () => {
    await select(file('BEGIN:VCARD\nUID:source-1\nFN:Ada\nEND:VCARD'))
    expect(await sentUids(1)).toEqual(['source-1'])
    expect(mocks.importContacts.mock.calls[0]![1]).toMatchObject({ fileImport: expect.any(Object) })
  })

  it('keeps a folded nonempty UID; generates UIDs for empty, unsafe and QP-payload ones', async () => {
    const folded = 'BEGIN:VCARD\nUID:abc-\n def\nFN:Folded\nEND:VCARD'
    const empty = 'BEGIN:VCARD\nUID:\nFN:Empty\nEND:VCARD'
    const unsafe = 'BEGIN:VCARD\nUID:bad\u0001uid\nFN:Unsafe\nEND:VCARD'
    const qpPayload = 'BEGIN:VCARD\nFN:Qp\nNOTE;ENCODING=QUOTED-PRINTABLE:a=\nUID:not-a-uid\nEND:VCARD'
    await select(file([folded, empty, unsafe, qpPayload].join('\n')))
    const uids = await sentUids(4)
    expect(uids[0]).toBe('abc-def')
    for (const uid of uids.slice(1)) expect(uid).toMatch(/^import-[0-9a-f]{64}-1$/)
    expect(uids).not.toContain('not-a-uid')
  })

  it('makes UIDs unique across files and never reuses an explicit UID for a generated one', async () => {
    const plain = 'BEGIN:VCARD\r\nFN:NoUid\r\nEND:VCARD'
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plain))), (b) => b.toString(16).padStart(2, '0')).join('')
    await select(
      file(`BEGIN:VCARD\r\nUID:shared\r\nFN:First\r\nEND:VCARD\r\nBEGIN:VCARD\r\nUID:import-${hash}-1\r\nFN:Explicit\r\nEND:VCARD`, 'a.vcf'),
      file(`BEGIN:VCARD\r\nUID:shared\r\nFN:Second\r\nEND:VCARD\r\n${plain}`, 'b.vcf'),
    )
    const uids = await sentUids(4)
    expect(uids[0]).toBe('shared')
    expect(uids[1]).toBe(`import-${hash}-1`)
    expect(uids[2]).toMatch(/^import-[0-9a-f]{64}-1$/)
    expect(uids[3]).toBe(`import-${hash}-2`)
    expect(new Set(uids).size).toBe(4)
  })

  it('gives a card without UID the same UID on every read of the file', async () => {
    const text = 'BEGIN:VCARD\nFN:Stable\nEND:VCARD'
    const first = await select(file(text))
    const [uid] = await sentUids(1)
    first.unmount()
    mocks.importContacts.mockClear()
    await select(file(text))
    expect(await sentUids(1)).toEqual([uid])
  })

  it('keeps assigned UIDs, and only unsaved original positions, for a partial retry', async () => {
    mocks.importContacts
      .mockRejectedValueOnce(new ImportIncompleteError(0, [1], false, ['skipped', 'refused']))
      .mockResolvedValueOnce(1)
    await select(file('BEGIN:VCARD\nUID:a\nFN:Already\nEND:VCARD\nBEGIN:VCARD\nFN:Refused\nEND:VCARD'))
    const [, refusedUid] = await sentUids(2)
    expect(await screen.findByText(/None of the 1 contacts were saved/)).toBeInTheDocument()
    expect(screen.queryByText('Already')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 contacts' }))
    await waitFor(() => expect(mocks.importContacts).toHaveBeenCalledTimes(2))
    expect((mocks.importContacts.mock.calls[1]![0] as { uid?: string; displayName: string }[]).map(({ uid, displayName }) => [uid, displayName])).toEqual([[refusedUid, 'Refused']])
  })

  it('builds the message from never-sent, refused and unconfirmed counts', async () => {
    mocks.importContacts.mockRejectedValueOnce(new ImportIncompleteError(1, [1, 2, 3], true, ['saved', 'notSent', 'refused', 'uncertain']))
    await select(file(['A', 'B', 'C', 'D'].map((n) => `BEGIN:VCARD\nUID:${n}\nFN:${n}\nEND:VCARD`).join('\n')))
    fireEvent.click(await screen.findByRole('button', { name: 'Import 4 contacts' }))
    expect(await screen.findByText(
      "Imported 1 of 4 contacts. 2 weren't saved and are listed below so you can import them again. 1 weren't confirmed as saved and are listed below. If the connection dropped, some may already be saved, so check your list before importing them again.",
    )).toBeInTheDocument()
  })

  it('reports skipped contacts and a failed check of what is saved', async () => {
    mocks.importContacts.mockImplementationOnce(async (_contacts: unknown, options: { fileImport: { onSkipped: (n: number) => void } }) => {
      options.fileImport.onSkipped(2)
      return 0
    })
    await select(file('BEGIN:VCARD\nUID:a\nFN:A\nEND:VCARD\nBEGIN:VCARD\nUID:b\nFN:B\nEND:VCARD'))
    fireEvent.click(await screen.findByRole('button', { name: 'Import 2 contacts' }))
    expect(await screen.findByText('2 already imported contacts were skipped.')).toBeInTheDocument()

    mocks.importContacts.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'ImportReconcileFailedError' }))
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file('BEGIN:VCARD\nUID:c\nFN:C\nEND:VCARD')] } })
    fireEvent.click(await screen.findByRole('button', { name: 'Import 1 contacts' }))
    expect(await screen.findByText(/Couldn't check what is already saved/)).toBeInTheDocument()
  })
})

describe('ContactImport selection order', () => {
  it('a slower, older file never replaces a newer file', async () => {
    let release!: () => void
    const real = crypto.subtle.digest.bind(crypto.subtle)
    const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce((...args: Parameters<typeof real>) => new Promise((resolve) => {
      release = () => resolve(real(...args))
    }))
    const { container } = renderWithIntl(<ContactImport onImportComplete={vi.fn()} />)
    const input = container.querySelector('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File(['BEGIN:VCARD\nFN:Older file\nEND:VCARD\nBEGIN:VCARD\nFN:Broken'], 'a.vcf')] } })
    await waitFor(() => expect(digest).toHaveBeenCalled())
    fireEvent.change(input, { target: { files: [new File(['BEGIN:VCARD\nUID:b\nFN:Newer file\nEND:VCARD'], 'b.vcf')] } })
    expect(await screen.findByText('Newer file')).toBeInTheDocument()
    release()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByText('Older file')).toBeNull()
    expect(screen.queryByText("1 contact couldn't be read.")).toBeNull()
    expect(screen.getByText('Newer file')).toBeInTheDocument()
    digest.mockRestore()
  })
})
