import { describe, it, expect } from 'vitest';
import {
  toVCard,
  fromVCard,
  serializeContact,
  deserializeContact,
  getContactInitials,
} from './contact.js';
import type { Contact } from './contact.js';

// ── Helpers ──

function makeFullContact(overrides?: Partial<Contact>): Contact {
  return {
    id: 'contact-001',
    uid: 'contact-001',
    displayName: 'Jane Doe',
    name: { prefix: 'Dr.', given: 'Jane', family: 'Doe', suffix: 'PhD' },
    phones: [
      { type: 'cell', value: '+1234567890' },
      { type: 'work', value: '+0987654321' },
    ],
    emails: [
      { type: 'home', value: 'jane@example.com' },
      { type: 'work', value: 'jane.doe@corp.com' },
    ],
    addresses: [
      {
        type: 'home',
        street: '123 Oak Street',
        city: 'Springfield',
        state: 'IL',
        postalCode: '62704',
        country: 'USA',
      },
    ],
    organization: 'Acme Corp',
    title: 'Senior Engineer',
    notes: 'Met at conference',
    birthday: '1990-01-15',
    photoUrl: 'https://example.com/photo.jpg',
    created_at: new Date(2026, 0, 1, 0, 0, 0),
    updated_at: new Date(2026, 2, 14, 12, 0, 0),
    ...overrides,
  };
}

function makeMinimalContact(): Contact {
  return {
    id: 'min-001',
    uid: 'min-001',
    displayName: 'Bob',
    name: { prefix: '', given: 'Bob', family: '', suffix: '' },
    phones: [],
    emails: [],
    addresses: [],
    organization: '',
    title: '',
    notes: '',
    birthday: null,
    photoUrl: null,
    created_at: new Date(2026, 2, 15, 0, 0, 0),
    updated_at: new Date(2026, 2, 15, 0, 0, 0),
  };
}

// ── toVCard / fromVCard roundtrip ──

describe('toVCard / fromVCard roundtrip', () => {
  it('roundtrips a fully populated contact', () => {
    const original = makeFullContact();
    const vcardStr = toVCard(original);
    const restored = fromVCard(vcardStr);

    expect(restored.uid).toBe(original.uid);
    expect(restored.displayName).toBe(original.displayName);
    expect(restored.name.given).toBe('Jane');
    expect(restored.name.family).toBe('Doe');
    expect(restored.name.prefix).toBe('Dr.');
    expect(restored.name.suffix).toBe('PhD');
    expect(restored.organization).toBe('Acme Corp');
    expect(restored.title).toBe('Senior Engineer');
    expect(restored.notes).toBe('Met at conference');
    expect(restored.birthday).toBe('1990-01-15');
  });

  it('roundtrips a minimal contact (just name)', () => {
    const original = makeMinimalContact();
    const vcardStr = toVCard(original);
    const restored = fromVCard(vcardStr);

    expect(restored.uid).toBe(original.uid);
    expect(restored.displayName).toBe('Bob');
    expect(restored.phones).toEqual([]);
    expect(restored.emails).toEqual([]);
    expect(restored.addresses).toEqual([]);
    expect(restored.organization).toBe('');
  });

  it('preserves id and uid (both set from vCard UID)', () => {
    const original = makeFullContact({ id: 'my-id', uid: 'my-id' });
    const vcardStr = toVCard(original);
    const restored = fromVCard(vcardStr);

    expect(restored.id).toBe('my-id');
    expect(restored.uid).toBe('my-id');
  });
});

// ── Multiple phones/emails ──

describe('multiple phones and emails', () => {
  it('preserves multiple phone numbers with types', () => {
    const original = makeFullContact({
      phones: [
        { type: 'cell', value: '+111' },
        { type: 'home', value: '+222' },
        { type: 'work', value: '+333' },
      ],
    });
    const vcardStr = toVCard(original);
    const restored = fromVCard(vcardStr);

    expect(restored.phones).toHaveLength(3);
    expect(restored.phones[0]!.type).toBe('cell');
    expect(restored.phones[1]!.type).toBe('home');
    expect(restored.phones[2]!.type).toBe('work');
  });

  it('preserves multiple email addresses', () => {
    const original = makeFullContact({
      emails: [
        { type: 'home', value: 'home@test.com' },
        { type: 'work', value: 'work@test.com' },
      ],
    });
    const vcardStr = toVCard(original);
    const restored = fromVCard(vcardStr);

    expect(restored.emails).toHaveLength(2);
    expect(restored.emails[0]!.value).toBe('home@test.com');
    expect(restored.emails[1]!.value).toBe('work@test.com');
  });
});

// ── serializeContact / deserializeContact ──

describe('serializeContact / deserializeContact', () => {
  it('serialize produces a vCard string', () => {
    const contact = makeFullContact();
    const serialized = serializeContact(contact);

    expect(typeof serialized).toBe('string');
    expect(serialized).toContain('BEGIN:VCARD');
    expect(serialized).toContain('END:VCARD');
  });

  it('deserialize restores a Contact from vCard string', () => {
    const contact = makeFullContact();
    const serialized = serializeContact(contact);
    const restored = deserializeContact(serialized);

    expect(restored.uid).toBe(contact.uid);
    expect(restored.displayName).toBe(contact.displayName);
    expect(restored.organization).toBe(contact.organization);
  });

  it('roundtrips through serialize/deserialize', () => {
    const original = makeFullContact({
      displayName: 'O\'Connor, Mary',
      notes: 'Multi\nline\nnotes',
    });

    const serialized = serializeContact(original);
    const restored = deserializeContact(serialized);

    expect(restored.uid).toBe(original.uid);
    expect(restored.displayName).toBe(original.displayName);
    expect(restored.notes).toBe(original.notes);
    expect(restored.phones).toHaveLength(original.phones.length);
    expect(restored.emails).toHaveLength(original.emails.length);
  });
});

// ── getContactInitials ──

describe('getContactInitials', () => {
  it('returns two initials from given and family name', () => {
    const contact = makeFullContact();
    expect(getContactInitials(contact)).toBe('JD');
  });

  it('returns single initial for given-name-only contact', () => {
    const contact = makeMinimalContact();
    expect(getContactInitials(contact)).toBe('B');
  });

  it('returns initials from displayName when name fields are empty', () => {
    const contact = makeMinimalContact();
    contact.name = { prefix: '', given: '', family: '', suffix: '' };
    contact.displayName = 'John Smith';
    expect(getContactInitials(contact)).toBe('JS');
  });

  it('returns single initial from single-word displayName', () => {
    const contact = makeMinimalContact();
    contact.name = { prefix: '', given: '', family: '', suffix: '' };
    contact.displayName = 'Madonna';
    expect(getContactInitials(contact)).toBe('M');
  });

  it('returns ? for empty contact', () => {
    const contact = makeMinimalContact();
    contact.name = { prefix: '', given: '', family: '', suffix: '' };
    contact.displayName = '';
    expect(getContactInitials(contact)).toBe('?');
  });
});

// ── Edge cases ──

describe('edge cases', () => {
  it('handles contact with no phones or emails', () => {
    const contact = makeFullContact({ phones: [], emails: [] });
    const vcardStr = toVCard(contact);
    const restored = fromVCard(vcardStr);

    expect(restored.phones).toEqual([]);
    expect(restored.emails).toEqual([]);
  });

  it('handles special characters in names and notes', () => {
    const contact = makeFullContact({
      displayName: 'O\'Brien; Jr.',
      notes: 'Has commas, semicolons; and\nnewlines',
    });
    const vcardStr = toVCard(contact);
    const restored = fromVCard(vcardStr);

    expect(restored.displayName).toBe('O\'Brien; Jr.');
    expect(restored.notes).toBe('Has commas, semicolons; and\nnewlines');
  });

  it('sets id equal to uid from vCard', () => {
    const raw = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'UID:unique-id-123',
      'FN:Test User',
      'END:VCARD',
    ].join('\r\n');

    const contact = fromVCard(raw);
    expect(contact.id).toBe('unique-id-123');
    expect(contact.uid).toBe('unique-id-123');
  });

  it('defaults fields when missing from vCard', () => {
    const raw = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'UID:sparse',
      'FN:Sparse Contact',
      'END:VCARD',
    ].join('\r\n');

    const contact = fromVCard(raw);
    expect(contact.organization).toBe('');
    expect(contact.title).toBe('');
    expect(contact.notes).toBe('');
    expect(contact.birthday).toBeNull();
    expect(contact.photoUrl).toBeNull();
  });
});
