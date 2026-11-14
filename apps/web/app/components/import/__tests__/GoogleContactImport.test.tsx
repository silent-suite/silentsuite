import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import ContactImport from '../ContactImport'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import { ImportIncompleteError } from '@/app/lib/import-outcome'
import { mapGooglePeople, type ProviderImportVCard } from '@/app/lib/google-import/contact-mapper'
import { importSourceKeyOf } from '@/app/lib/google-import/source-key'

const store = vi.hoisted(() => ({
  contacts: [] as { unknownProperties?: string[]; displayName: string }[],
  importContacts: vi.fn(),
}))
/** What the server holds, which can differ from the visible list after a lost acknowledgement. */
const server = vi.hoisted(() => ({ keys: new Set<string>() as Set<string> | null }))
vi.mock('@/app/lib/google-import/reconcile', () => ({
  RECONCILE_FAILED_MESSAGE: "Couldn't check what is already saved, so nothing was imported. Check your connection and try again.",
  serverImportSourceKeys: async () => (server.keys ? new Set(server.keys) : null),
}))

vi.mock('@/app/stores/use-contact-store', () => {
  const useContactStore = <T,>(selector: (state: typeof store) => T): T => selector(store)
  useContactStore.getState = () => store
  return { useContactStore }
})
vi.mock('@/app/stores/use-contact-list-store', () => ({
  useContactListStore: <T,>(selector: (state: { lists: { id: string; name: string; color: string; visible: boolean }[]; activeListId: string }) => T): T =>
    selector({ lists: [{ id: 'default', name: 'Default', color: '#10b981', visible: true }], activeListId: 'default' }),
}))
vi.mock('@/app/stores/use-etebase-store', () => ({
  useEtebaseStore: <T,>(selector: (state: { createCollection: () => Promise<null> }) => T): T => selector({ createCollection: async () => null }),
}))

function readGoogle(): ProviderImportVCard[] {
  return mapGooglePeople('people/1', [
    { resourceName: 'people/a', names: [{ displayName: 'Ann' }], memberships: [{ contactGroupMembership: { contactGroupResourceName: 'contactGroups/fam' } }] },
    { resourceName: 'people/b', names: [{ displayName: 'Ann' }], emailAddresses: [{ value: 'ann@example.com' }] },
  ], [{ resourceName: 'contactGroups/fam', name: 'Family', groupType: 'USER_CONTACT_GROUP' }])
}

vi.mock('../GoogleImportButton', () => ({
  default: (props: { onLoaded: (result: ProviderImportVCard[]) => void }) => (
    <button type="button" onClick={() => props.onLoaded(readGoogle())}>Import from Google</button>
  ),
}))

type Payload = { displayName: string; categories: string[]; unknownProperties?: string[] }

describe('Google contact import: interrupt, retry, re-import', () => {
  beforeEach(() => {
    store.contacts = []
    store.importContacts.mockReset()
    server.keys = new Set()
  })

  it('keeps the source key in each contact, retries only the unsaved one, and a re-import adds nothing', async () => {
    const save = (payloads: Payload[]) => { store.contacts.push(...payloads) }
    store.importContacts
      .mockImplementationOnce(async (payloads: Payload[]) => { save([payloads[0]!]); throw new ImportIncompleteError(1, [1], false) })
      .mockImplementationOnce(async (payloads: Payload[]) => { save(payloads); return payloads.length })
    const onImportComplete = vi.fn()
    renderWithIntl(<ContactImport onImportComplete={onImportComplete} />)

    fireEvent.click(screen.getByRole('button', { name: 'Import from Google' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Import 2 contacts' }))
    expect(await screen.findByText(/Imported 1 of 2 contacts/)).toBeInTheDocument()
    const first = store.importContacts.mock.calls[0]![0] as Payload[]
    expect(first.map((p) => p.displayName)).toEqual(['Ann', 'Ann'])
    expect(first[0]!.categories).toEqual(['Family'])
    expect(first.map((p) => importSourceKeyOf(p.unknownProperties))).toEqual(readGoogle().map((c) => c.sourceKey))

    fireEvent.click(screen.getByRole('button', { name: 'Import 1 contacts' }))
    await waitFor(() => expect(onImportComplete).toHaveBeenCalledWith(1))
    expect((store.importContacts.mock.calls[1]![0] as Payload[]).map((p) => importSourceKeyOf(p.unknownProperties))).toEqual([readGoogle()[1]!.sourceKey])
    expect(store.contacts).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Import from Google' }))
    expect(await screen.findByText(/Nothing new to import from Google\. 2 already imported contacts were skipped\./)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Import \d+ contacts$/ })).toBeNull()
    expect(store.importContacts).toHaveBeenCalledTimes(2)
  })

  it('a contact the server saved without acknowledging is not sent again on retry', async () => {
    const [ann, bob] = readGoogle()
    store.importContacts.mockImplementationOnce(async () => {
      // Both applied remotely; only Ann's acknowledgement arrived.
      server.keys!.add(ann!.sourceKey).add(bob!.sourceKey)
      store.contacts.push({ displayName: 'Ann', unknownProperties: ann!.unknownProperties })
      throw new ImportIncompleteError(1, [1], true)
    })
    renderWithIntl(<ContactImport onImportComplete={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Import from Google' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Import 2 contacts' }))
    expect(await screen.findByText(/weren't confirmed as saved/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Import 1 contacts' }))
    expect(await screen.findByText('Everything listed was already imported.')).toBeInTheDocument()
    expect(store.importContacts).toHaveBeenCalledTimes(1)
  })

  it('writes nothing when the server cannot be read first', async () => {
    server.keys = null
    renderWithIntl(<ContactImport onImportComplete={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Import from Google' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Import 2 contacts' }))
    expect(await screen.findByText(/Couldn't check what is already saved/)).toBeInTheDocument()
    expect(store.importContacts).not.toHaveBeenCalled()
  })
})
