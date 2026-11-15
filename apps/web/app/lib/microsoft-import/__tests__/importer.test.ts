import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createGraphFake } from './graph-fake'

const oauth = vi.hoisted(() => ({
  release: vi.fn(),
  signIn: vi.fn(async (_options: { scope: string }): Promise<{ accountId: string; release: () => void }> => ({ accountId: 'tenant.sub-1', release: oauth.release })),
  clear: vi.fn(),
}))
vi.mock('../oauth', () => ({
  MICROSOFT_CALENDAR_SCOPE: 'https://graph.microsoft.com/Calendars.Read',
  MICROSOFT_CONTACTS_SCOPE: 'https://graph.microsoft.com/Contacts.Read',
  signInWithMicrosoft: oauth.signIn,
  getMicrosoftAccessToken: () => 'graph-token',
  clearMicrosoftAccessToken: oauth.clear,
}))

import { loadMicrosoftCalendars, loadMicrosoftContacts, MAX_FOLDER_DEPTH, MicrosoftImportError } from '../importer'
import { mapMicrosoftContacts } from '../contact-mapper'

const sleep = async () => undefined

const contact = (id: string, extra: Record<string, unknown> = {}) => ({ id, displayName: `Person ${id}`, emailAddresses: [{ address: `${id}@example.com` }], ...extra })

describe('Microsoft importer (#48)', () => {
  beforeEach(() => {
    oauth.signIn.mockClear()
    oauth.clear.mockClear()
    oauth.release.mockClear()
  })

  it('reads the default folder, every folder and child folder, labels non-default folders, and keeps a contact once', async () => {
    const graph = createGraphFake({
      contacts: [contact('a', { categories: ['VIP'] })],
      contactFolders: [
        { id: 'f-family', displayName: 'Family', contacts: [contact('b'), contact('a')], childFolders: [{ id: 'f-kids', displayName: 'Kids', contacts: [contact('c')] }] },
      ],
    })
    const cards = await loadMicrosoftContacts({ clientId: 'client-1', fetcher: graph.fetch, sleep })
    expect(oauth.signIn).toHaveBeenCalledWith(expect.objectContaining({ scope: 'https://graph.microsoft.com/Contacts.Read' }))
    expect(cards.map((c) => [c.fn, c.categories ?? []])).toEqual([
      ['Person a', ['VIP']],
      ['Person b', ['Family']],
      ['Person c', ['Kids']],
    ])
    expect(cards.map((c) => c.sourceKey)).toEqual(['a', 'b', 'c'].map((id) => `microsoft/tenant.sub-1/contacts/${id}`))
    // Every contact read selects the mapped fields, and every request asks for immutable ids.
    const contactReads = graph.requests.filter((u) => u.pathname.endsWith('/contacts'))
    expect(contactReads).toHaveLength(3)
    for (const url of contactReads) expect(url.searchParams.get('$select')).toContain('personalNotes')
    expect(graph.headers.every((h) => h.prefer?.includes('IdType="ImmutableId"'))).toBe(true)
    expect(oauth.release).toHaveBeenCalledTimes(1)
    expect(oauth.clear).not.toHaveBeenCalled()
  })

  it('refuses a folder tree deeper than the guard and still drops the token', async () => {
    let folder: Record<string, unknown> = { id: 'deep-0', displayName: 'Deep 0' }
    const root = folder
    for (let i = 1; i <= MAX_FOLDER_DEPTH + 1; i++) {
      const child = { id: `deep-${i}`, displayName: `Deep ${i}` }
      folder.childFolders = [child]
      folder = child
    }
    const graph = createGraphFake({ contactFolders: [root] })
    await expect(loadMicrosoftContacts({ clientId: 'client-1', fetcher: graph.fetch, sleep })).rejects.toBeInstanceOf(MicrosoftImportError)
    expect(oauth.release).toHaveBeenCalledTimes(1)
    expect(oauth.clear).not.toHaveBeenCalled()
  })

  it('a cancelled run reads nothing more and drops the token', async () => {
    const controller = new AbortController()
    const graph = createGraphFake({ calendars: [{ id: 'cal-1', name: 'Calendar' }], events: { 'cal-1': [] } })
    oauth.signIn.mockImplementationOnce(async () => { controller.abort(); return { accountId: 'tenant.sub-1', release: oauth.release } })
    await expect(loadMicrosoftCalendars({ clientId: 'client-1', fetcher: graph.fetch, sleep, signal: controller.signal }))
      .rejects.toThrow('Microsoft import was cancelled.')
    expect(graph.requests).toHaveLength(0)
    expect(oauth.release).toHaveBeenCalledTimes(1)
    expect(oauth.clear).not.toHaveBeenCalled()
  })

  it('an expired sign-in ends the whole run instead of skipping one series', async () => {
    const graph = createGraphFake({ calendars: [{ id: 'cal-1', name: 'Calendar' }], events: { 'cal-1': [] } })
    const expired: typeof fetch = async (input, init) => {
      if (String(input).includes('/events')) return new Response('{}', { status: 401 })
      return graph.fetch(input, init)
    }
    await expect(loadMicrosoftCalendars({ clientId: 'client-1', fetcher: expired, sleep })).rejects.toMatchObject({ name: 'GraphApiError', status: 401 })
    expect(oauth.release).toHaveBeenCalledTimes(1)
    expect(oauth.clear).not.toHaveBeenCalled()
  })
})

describe('Microsoft contact mapping (#48)', () => {
  it('maps names, emails, phones, addresses, birthday, notes, company, job title and categories', () => {
    const [card] = mapMicrosoftContacts('acct', [{
      contact: {
        id: 'imm-1', displayName: 'Dr. Ann Lee', givenName: 'Ann', middleName: 'B', surname: 'Lee', title: 'Dr.', generation: 'Jr.',
        emailAddresses: [{ name: 'Ann', address: ' ann@example.com ' }, { address: '' }],
        mobilePhone: '+49 151 1', homePhones: ['+49 30 2'], businessPhones: ['+49 30 3', ' '],
        homeAddress: { street: 'Hauptstr. 1', city: 'Berlin', postalCode: '10115', countryOrRegion: 'Germany' },
        businessAddress: {}, otherAddress: { city: 'Hamburg' },
        birthday: '1980-04-02T00:00:00Z', personalNotes: 'Met at FOSDEM', companyName: 'Acme', jobTitle: 'CTO', categories: ['Work', 'Work'],
      },
      folderName: 'Clients',
    }])
    expect(card).toMatchObject({
      fn: 'Dr. Ann Lee',
      n: { given: 'Ann B', family: 'Lee', prefix: 'Dr.', suffix: 'Jr.' },
      email: [{ type: 'other', value: 'ann@example.com' }],
      tel: [{ type: 'cell', value: '+49 151 1' }, { type: 'home', value: '+49 30 2' }, { type: 'work', value: '+49 30 3' }],
      adr: [
        { type: 'home', street: 'Hauptstr. 1', city: 'Berlin', state: '', postalCode: '10115', country: 'Germany' },
        { type: 'other', street: '', city: 'Hamburg', state: '', postalCode: '', country: '' },
      ],
      bday: '1980-04-02', note: 'Met at FOSDEM', org: 'Acme', title: 'CTO', categories: ['Work', 'Clients'],
      sourceKey: 'microsoft/acct/contacts/imm-1',
      unknownProperties: ['X-SILENTSUITE-IMPORT-SOURCE:microsoft/acct/contacts/imm-1'],
    })
  })

  it('a birthday without a year keeps only month and day; a person is never merged by name or email', () => {
    const cards = mapMicrosoftContacts('acct', [
      { contact: { id: 'x', displayName: 'Ann', emailAddresses: [{ address: 'ann@example.com' }], birthday: '1604-12-24T00:00:00Z' } },
      { contact: { id: 'y', displayName: 'Ann', emailAddresses: [{ address: 'ann@example.com' }] } },
      { contact: { displayName: 'No id' } },
    ])
    expect(cards).toHaveLength(2)
    expect(cards[0]!.bday).toBe('--12-24')
    expect(cards[1]!.bday).toBeUndefined()
  })

  it('falls back to company, email or phone for the display name', () => {
    const cards = mapMicrosoftContacts('acct', [
      { contact: { id: '1', companyName: 'Acme' } },
      { contact: { id: '2', emailAddresses: [{ address: 'x@example.com' }] } },
      { contact: { id: '3', businessPhones: ['+1 555'] } },
    ])
    expect(cards.map((c) => c.fn)).toEqual(['Acme', 'x@example.com', '+1 555'])
    expect(cards.every((c) => c.n === undefined)).toBe(true)
  })
})
