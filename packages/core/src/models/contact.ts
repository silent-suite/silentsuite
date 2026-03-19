import { parseVCard, generateVCard } from '../utils/vcard-parser.js';
import type { VCard } from '../utils/vcard-parser.js';

export interface Contact {
  id: string;
  uid: string;
  displayName: string;
  name: {
    prefix: string;
    given: string;
    family: string;
    suffix: string;
  };
  phones: Array<{ type: string; value: string }>;
  emails: Array<{ type: string; value: string }>;
  addresses: Array<{
    type: string;
    street: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  }>;
  organization: string;
  title: string;
  notes: string;
  birthday: string | null;
  photoUrl: string | null;
  listId?: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * Convert a Contact to a vCard 3.0 string.
 */
export function toVCard(contact: Contact): string {
  const vcard: VCard = {
    uid: contact.uid,
    fn: contact.displayName || `${contact.name.given} ${contact.name.family}`.trim(),
    n: {
      family: contact.name.family,
      given: contact.name.given,
      prefix: contact.name.prefix || undefined,
      suffix: contact.name.suffix || undefined,
    },
    org: contact.organization || undefined,
    title: contact.title || undefined,
    note: contact.notes || undefined,
    bday: contact.birthday ?? undefined,
    photo: contact.photoUrl ?? undefined,
    rev: formatRevTimestamp(contact.updated_at),
  };

  if (contact.phones.length > 0) {
    vcard.tel = contact.phones;
  }
  if (contact.emails.length > 0) {
    vcard.email = contact.emails;
  }
  if (contact.addresses.length > 0) {
    vcard.adr = contact.addresses;
  }

  return generateVCard(vcard);
}

/**
 * Parse a vCard 3.0 string into a Contact.
 */
export function fromVCard(vcardStr: string): Contact {
  const vcard = parseVCard(vcardStr);
  const now = new Date();

  return {
    id: vcard.uid,
    uid: vcard.uid,
    displayName: vcard.fn,
    name: {
      prefix: vcard.n?.prefix ?? '',
      given: vcard.n?.given ?? '',
      family: vcard.n?.family ?? '',
      suffix: vcard.n?.suffix ?? '',
    },
    phones: vcard.tel ?? [],
    emails: vcard.email ?? [],
    addresses: vcard.adr ?? [],
    organization: vcard.org ?? '',
    title: vcard.title ?? '',
    notes: vcard.note ?? '',
    birthday: vcard.bday ?? null,
    photoUrl: vcard.photo ?? null,
    created_at: now,
    updated_at: vcard.rev ? parseRevTimestamp(vcard.rev) : now,
  };
}

/**
 * Serialize a Contact to a string for Etebase item content.
 */
export function serializeContact(contact: Contact): string {
  return toVCard(contact);
}

/**
 * Deserialize Etebase item content to a Contact.
 */
export function deserializeContact(content: string): Contact {
  return fromVCard(content);
}

/**
 * Get 1-2 letter initials from a contact's name.
 */
export function getContactInitials(contact: Contact): string {
  const { given, family } = contact.name;

  if (given && family) {
    return `${given[0]}${family[0]}`.toUpperCase();
  }
  if (given) {
    return given[0]!.toUpperCase();
  }
  if (family) {
    return family[0]!.toUpperCase();
  }

  // Fallback to displayName
  const parts = contact.displayName.trim().split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
  }
  if (parts.length === 1 && parts[0]) {
    return parts[0][0]!.toUpperCase();
  }

  return '?';
}

// ── Helpers ──

function formatRevTimestamp(date: Date): string {
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const h = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  const s = String(date.getUTCSeconds()).padStart(2, '0');
  return `${y}${mo}${d}T${h}${mi}${s}Z`;
}

function parseRevTimestamp(rev: string): Date {
  const clean = rev.replace(/[^0-9TZ]/g, '');
  const year = parseInt(clean.slice(0, 4), 10);
  const month = parseInt(clean.slice(4, 6), 10) - 1;
  const day = parseInt(clean.slice(6, 8), 10);

  if (clean.length <= 8) {
    return new Date(year, month, day);
  }

  const hour = parseInt(clean.slice(9, 11), 10);
  const minute = parseInt(clean.slice(11, 13), 10);
  const second = parseInt(clean.slice(13, 15), 10);

  if (clean.endsWith('Z')) {
    return new Date(Date.UTC(year, month, day, hour, minute, second));
  }
  return new Date(year, month, day, hour, minute, second);
}
