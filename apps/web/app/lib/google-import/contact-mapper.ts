import type { VCard, VCardAddress } from '@silentsuite/core/utils/vcard-parser'
import { importSourceKey, importSourceLine } from './source-key'

/*
 * Google People API connections -> the VCard shape the existing contact import writes.
 * Each person keeps its own source key (account + resourceName); people are never merged.
 * Contact groups become labels; Google's "starred" group becomes the favorite flag.
 * Photos are not imported.
 */

export interface GoogleFieldMetadata {
  primary?: boolean
}

interface WithMetadata {
  metadata?: GoogleFieldMetadata
}

export interface GooglePerson {
  resourceName: string
  names?: (WithMetadata & { displayName?: string; givenName?: string; familyName?: string; middleName?: string; honorificPrefix?: string; honorificSuffix?: string })[]
  emailAddresses?: (WithMetadata & { value?: string; type?: string })[]
  phoneNumbers?: (WithMetadata & { value?: string; type?: string })[]
  addresses?: (WithMetadata & { type?: string; streetAddress?: string; extendedAddress?: string; poBox?: string; city?: string; region?: string; postalCode?: string; country?: string; formattedValue?: string })[]
  birthdays?: (WithMetadata & { date?: { year?: number; month?: number; day?: number }; text?: string })[]
  biographies?: (WithMetadata & { value?: string })[]
  organizations?: (WithMetadata & { name?: string; title?: string })[]
  memberships?: { contactGroupMembership?: { contactGroupResourceName?: string } }[]
}

export interface GoogleContactGroup {
  resourceName: string
  name?: string
  formattedName?: string
  groupType?: string
}

/** One container per Google account: its "connections" (the user's contacts). */
export const GOOGLE_CONTACTS_CONTAINER = 'connections'
const STARRED_GROUP = 'contactGroups/starred'

export type ProviderImportVCard = VCard & { sourceKey: string }

function primaryFirst<T extends WithMetadata>(values: readonly T[] | undefined): T[] {
  return [...(values ?? [])].sort((a, b) => Number(b.metadata?.primary === true) - Number(a.metadata?.primary === true))
}

function clean(value: string | undefined): string {
  return (value ?? '').trim()
}

const PHONE_TYPES: Record<string, string> = {
  mobile: 'cell', home: 'home', work: 'work', main: 'main', pager: 'pager', workpager: 'pager',
  homefax: 'fax', workfax: 'fax', otherfax: 'fax', workmobile: 'cell', googlevoice: 'voice', other: 'other',
}

function phoneType(type: string | undefined): string {
  return PHONE_TYPES[clean(type).toLowerCase()] ?? 'other'
}

function homeWorkOther(type: string | undefined): string {
  const t = clean(type).toLowerCase()
  return t === 'home' || t === 'work' ? t : 'other'
}

function birthdayOf(person: GooglePerson): { bday: string; bdayIsText?: true } | undefined {
  for (const birthday of primaryFirst(person.birthdays)) {
    const d = birthday.date
    if (d && Number.isInteger(d.month) && Number.isInteger(d.day) && d.month! >= 1 && d.month! <= 12 && d.day! >= 1 && d.day! <= 31) {
      const md = `${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`
      return Number.isInteger(d.year) && d.year! > 0 ? { bday: `${String(d.year).padStart(4, '0')}-${md}` } : { bday: `--${md}` }
    }
    const text = clean(birthday.text)
    if (text) return { bday: text, bdayIsText: true }
  }
  return undefined
}

/** Maps every connection; `groups` names the user's own contact groups. */
export function mapGooglePeople(
  accountId: string,
  people: readonly GooglePerson[],
  groups: readonly GoogleContactGroup[],
): ProviderImportVCard[] {
  const groupNames = new Map<string, string>()
  for (const group of groups) {
    const name = clean(group.formattedName ?? group.name)
    if (group.groupType === 'USER_CONTACT_GROUP' && name) groupNames.set(group.resourceName, name)
  }
  const seen = new Set<string>()
  const cards: ProviderImportVCard[] = []
  for (const person of people) {
    if (!person.resourceName || seen.has(person.resourceName)) continue
    seen.add(person.resourceName)
    const sourceKey = importSourceKey('google', accountId, GOOGLE_CONTACTS_CONTAINER, person.resourceName)
    const name = primaryFirst(person.names)[0]
    const emails = primaryFirst(person.emailAddresses).filter((e) => clean(e.value)).map((e) => ({ type: homeWorkOther(e.type), value: clean(e.value) }))
    const phones = primaryFirst(person.phoneNumbers).filter((p) => clean(p.value)).map((p) => ({ type: phoneType(p.type), value: clean(p.value) }))
    const addresses: VCardAddress[] = primaryFirst(person.addresses)
      .map((a) => ({
        type: homeWorkOther(a.type),
        street: [a.poBox, a.streetAddress, a.extendedAddress].map(clean).filter(Boolean).join('\n'),
        city: clean(a.city),
        state: clean(a.region),
        postalCode: clean(a.postalCode),
        country: clean(a.country),
      }))
      .filter((a) => a.street || a.city || a.state || a.postalCode || a.country)
    const organization = primaryFirst(person.organizations)[0]
    const note = primaryFirst(person.biographies).map((b) => clean(b.value)).find(Boolean)
    const memberships = (person.memberships ?? [])
      .map((m) => m.contactGroupMembership?.contactGroupResourceName)
      .filter((r): r is string => typeof r === 'string')
    const categories = [...new Set(memberships.map((r) => groupNames.get(r)).filter((n): n is string => Boolean(n)))]
    const given = clean(name?.givenName)
    const middle = clean(name?.middleName)
    const family = clean(name?.familyName)
    const fn = clean(name?.displayName)
      || [given, middle, family].filter(Boolean).join(' ')
      || clean(organization?.name)
      || emails[0]?.value
      || phones[0]?.value
      || ''
    const birthday = birthdayOf(person)
    cards.push({
      uid: '',
      fn,
      ...(name ? { n: { given: [given, middle].filter(Boolean).join(' '), family, prefix: clean(name.honorificPrefix), suffix: clean(name.honorificSuffix) } } : {}),
      ...(phones.length > 0 ? { tel: phones } : {}),
      ...(emails.length > 0 ? { email: emails } : {}),
      ...(addresses.length > 0 ? { adr: addresses } : {}),
      ...(clean(organization?.name) ? { org: clean(organization?.name) } : {}),
      ...(clean(organization?.title) ? { title: clean(organization?.title) } : {}),
      ...(note ? { note } : {}),
      ...(birthday ? { bday: birthday.bday, ...(birthday.bdayIsText ? { bdayIsText: true } : {}) } : {}),
      ...(categories.length > 0 ? { categories } : {}),
      ...(memberships.includes(STARRED_GROUP) ? { favorite: true } : {}),
      unknownProperties: [importSourceLine(sourceKey)],
      sourceKey,
    })
  }
  return cards
}
