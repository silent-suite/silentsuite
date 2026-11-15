import type { VCardAddress } from '@silentsuite/core/utils/vcard-parser'
import type { ProviderImportVCard } from '@/app/lib/google-import/contact-mapper'
import { importSourceKey, importSourceLine } from '@/app/lib/google-import/source-key'

/*
 * Microsoft Graph contacts -> the VCard shape the existing contact import writes (#48).
 * Each contact keeps its own source key (account + immutable id); people are never merged.
 * Outlook categories become labels, and so does the name of any folder other than the
 * default Contacts folder (Graph v1.0 has no contact groups). Photos are not imported.
 */

export interface GraphEmailAddress {
  name?: string
  address?: string
}

export interface GraphPhysicalAddress {
  street?: string
  city?: string
  state?: string
  postalCode?: string
  countryOrRegion?: string
}

export interface GraphContact {
  id?: string
  displayName?: string
  givenName?: string
  middleName?: string
  surname?: string
  title?: string
  generation?: string
  nickName?: string
  emailAddresses?: GraphEmailAddress[]
  businessPhones?: string[]
  homePhones?: string[]
  mobilePhone?: string | null
  homeAddress?: GraphPhysicalAddress
  businessAddress?: GraphPhysicalAddress
  otherAddress?: GraphPhysicalAddress
  birthday?: string | null
  personalNotes?: string
  companyName?: string
  jobTitle?: string
  categories?: string[]
}

export interface GraphContactFolder {
  id?: string
  displayName?: string
  childFolders?: GraphContactFolder[]
}

export const CONTACT_FIELDS = [
  'id', 'displayName', 'givenName', 'middleName', 'surname', 'title', 'generation', 'emailAddresses',
  'businessPhones', 'homePhones', 'mobilePhone', 'homeAddress', 'businessAddress', 'otherAddress',
  'birthday', 'personalNotes', 'companyName', 'jobTitle', 'categories',
].join(',')

/**
 * One container per Microsoft account, not one per folder: immutable ids survive moves between
 * folders, so moving a contact never makes a re-import add it again.
 */
export const MICROSOFT_CONTACTS_CONTAINER = 'contacts'

/** A contact as read from one folder. `folderName` is undefined for the default Contacts folder. */
export interface FolderContact {
  contact: GraphContact
  folderName?: string
}

function clean(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

function address(type: string, a: GraphPhysicalAddress | undefined): VCardAddress | null {
  if (!a) return null
  const result = {
    type,
    street: clean(a.street),
    city: clean(a.city),
    state: clean(a.state),
    postalCode: clean(a.postalCode),
    country: clean(a.countryOrRegion),
  }
  return result.street || result.city || result.state || result.postalCode || result.country ? result : null
}

/** Outlook keeps a birthday as midnight UTC of that date; only the date is meaningful. */
function birthdayOf(value: string | null | undefined): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T/.exec(clean(value))
  if (!match) return undefined
  const [, year, month, day] = match
  const m = Number(month)
  const d = Number(day)
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined
  // Outlook stores a birthday without a year as year 1604.
  return year === '1604' || year === '0001' ? `--${month}-${day}` : `${year}-${month}-${day}`
}

/** Maps every contact once, in the order read; a contact seen in two folders is kept once. */
export function mapMicrosoftContacts(accountId: string, contacts: readonly FolderContact[]): ProviderImportVCard[] {
  const seen = new Set<string>()
  const cards: ProviderImportVCard[] = []
  for (const { contact, folderName } of contacts) {
    if (!contact.id || seen.has(contact.id)) continue
    seen.add(contact.id)
    const sourceKey = importSourceKey('microsoft', accountId, MICROSOFT_CONTACTS_CONTAINER, contact.id)
    const emails = (contact.emailAddresses ?? [])
      .map((e) => clean(e.address))
      .filter(Boolean)
      .map((value) => ({ type: 'other', value }))
    const phones = [
      ...(clean(contact.mobilePhone) ? [{ type: 'cell', value: clean(contact.mobilePhone) }] : []),
      ...(contact.homePhones ?? []).map(clean).filter(Boolean).map((value) => ({ type: 'home', value })),
      ...(contact.businessPhones ?? []).map(clean).filter(Boolean).map((value) => ({ type: 'work', value })),
    ]
    const addresses = [
      address('home', contact.homeAddress),
      address('work', contact.businessAddress),
      address('other', contact.otherAddress),
    ].filter((a): a is VCardAddress => a !== null)
    const categories = [...new Set([
      ...(contact.categories ?? []).map(clean),
      clean(folderName),
    ].filter(Boolean))]
    const given = clean(contact.givenName)
    const middle = clean(contact.middleName)
    const family = clean(contact.surname)
    const org = clean(contact.companyName)
    const hasName = Boolean(given || middle || family || clean(contact.title) || clean(contact.generation))
    const fn = clean(contact.displayName)
      || [given, middle, family].filter(Boolean).join(' ')
      || org
      || emails[0]?.value
      || phones[0]?.value
      || ''
    const bday = birthdayOf(contact.birthday)
    const note = clean(contact.personalNotes)
    cards.push({
      uid: '',
      fn,
      ...(hasName ? { n: { given: [given, middle].filter(Boolean).join(' '), family, prefix: clean(contact.title), suffix: clean(contact.generation) } } : {}),
      ...(phones.length > 0 ? { tel: phones } : {}),
      ...(emails.length > 0 ? { email: emails } : {}),
      ...(addresses.length > 0 ? { adr: addresses } : {}),
      ...(org ? { org } : {}),
      ...(clean(contact.jobTitle) ? { title: clean(contact.jobTitle) } : {}),
      ...(note ? { note } : {}),
      ...(bday ? { bday } : {}),
      ...(categories.length > 0 ? { categories } : {}),
      unknownProperties: [importSourceLine(sourceKey)],
      sourceKey,
    })
  }
  return cards
}
