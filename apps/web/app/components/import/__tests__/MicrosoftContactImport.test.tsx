import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import ContactImport from '../ContactImport'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import { ImportIncompleteError } from '@/app/lib/import-outcome'
import type { ProviderImportVCard } from '@/app/lib/google-import/contact-mapper'
import { importSourceKeyOf } from '@/app/lib/google-import/source-key'
import { loadMicrosoftContacts } from '@/app/lib/microsoft-import/importer'
import { createGraphFake } from '@/app/lib/microsoft-import/__tests__/graph-fake'

// Interrupt / retry / re-import for Microsoft contacts (#48): the real importer reads a
// selection-aware Graph fake; the real ContactImport writes through a controlled store.

vi.mock('@/app/lib/microsoft-import/oauth', () => ({
  MICROSOFT_CALENDAR_SCOPE: 'https://graph.microsoft.com/Calendars.Read',
  MICROSOFT_CONTACTS_SCOPE: 'https://graph.microsoft.com/Contacts.Read',
  signInWithMicrosoft: async () => ({ accountId: 'tenant.sub-1' }),
  getMicrosoftAccessToken: () => 'graph-token',
  clearMicrosoftAccessToken: () => undefined,
}))

const store = vi.hoisted(() => ({
  contacts: [] as { unknownProperties?: string[]; displayName: string }[],
  importContacts: vi.fn(),
}))
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

const graph = createGraphFake({
  contacts: [{ id: 'imm-ann', displayName: 'Ann', emailAddresses: [{ address: 'ann@example.com' }] }],
  contactFolders: [{ id: 'f-family', displayName: 'Family', contacts: [{ id: 'imm-ann2', displayName: 'Ann', emailAddresses: [{ address: 'ann@example.com' }] }] }],
})
const readMicrosoft = () => loadMicrosoftContacts({ clientId: 'client-1', fetcher: graph.fetch, sleep: async () => undefined })

vi.mock('../MicrosoftImportButton', () => ({
  // Like ProviderImportButton, the start is reported before the load is awaited.
  default: (props: { onStart?: () => void; onLoaded: (result: ProviderImportVCard[]) => void }) => (
    <button type="button" onClick={() => { props.onStart?.(); void readMicrosoft().then(props.onLoaded) }}>Import from Microsoft</button>
  ),
}))

type Payload = { displayName: string; categories: string[]; unknownProperties?: string[] }

describe('Microsoft contact import: interrupt, retry, re-import', () => {
  beforeEach(() => {
    store.contacts = []
    store.importContacts.mockReset()
    server.keys = new Set()
  })

  it('keeps two same-named people apart, retries only the unsaved one, and a re-import adds nothing', async () => {
    store.importContacts
      .mockImplementationOnce(async (payloads: Payload[]) => { store.contacts.push(payloads[0]!); throw new ImportIncompleteError(1, [1], false) })
      .mockImplementationOnce(async (payloads: Payload[]) => { store.contacts.push(...payloads); return payloads.length })
    const onImportComplete = vi.fn()
    renderWithIntl(<ContactImport onImportComplete={onImportComplete} />)

    fireEvent.click(screen.getByRole('button', { name: 'Import from Microsoft' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Import 2 contacts' }))
    expect(await screen.findByText(/Imported 1 of 2 contacts/)).toBeInTheDocument()
    const first = store.importContacts.mock.calls[0]![0] as Payload[]
    expect(first.map((p) => importSourceKeyOf(p.unknownProperties))).toEqual([
      'microsoft/tenant.sub-1/contacts/imm-ann',
      'microsoft/tenant.sub-1/contacts/imm-ann2',
    ])
    expect(first[1]!.categories).toEqual(['Family'])

    fireEvent.click(screen.getByRole('button', { name: 'Import 1 contacts' }))
    await waitFor(() => expect(onImportComplete).toHaveBeenCalledWith(1))

    fireEvent.click(screen.getByRole('button', { name: 'Import from Microsoft' }))
    expect(await screen.findByText(/Nothing new to import from Microsoft\. 2 already imported contacts were skipped\./)).toBeInTheDocument()
    expect(store.importContacts).toHaveBeenCalledTimes(2)
  })

  it('writes nothing when the server cannot be read first', async () => {
    server.keys = null
    renderWithIntl(<ContactImport onImportComplete={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Import from Microsoft' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Import 2 contacts' }))
    expect(await screen.findByText(/Couldn't check what is already saved/)).toBeInTheDocument()
    expect(store.importContacts).not.toHaveBeenCalled()
  })
})
