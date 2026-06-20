import { describe, it, expect } from 'vitest';
import { parseVCard, generateVCard } from './vcard-parser.js';
import type { VCard } from './vcard-parser.js';

// ── Helpers ──

function makeFullVCard(overrides?: Partial<VCard>): VCard {
  return {
    uid: 'contact-001',
    fn: 'Jane Doe',
    n: { family: 'Doe', given: 'Jane', prefix: 'Dr.', suffix: 'PhD' },
    tel: [
      { type: 'cell', value: '+1234567890' },
      { type: 'work', value: '+0987654321' },
    ],
    email: [
      { type: 'home', value: 'jane@example.com' },
      { type: 'work', value: 'jane.doe@corp.com' },
    ],
    adr: [
      {
        type: 'home',
        street: '123 Oak Street',
        city: 'Springfield',
        state: 'IL',
        postalCode: '62704',
        country: 'USA',
      },
    ],
    org: 'Acme Corp',
    title: 'Senior Engineer',
    note: 'Met at conference',
    bday: '1990-01-15',
    photo: 'https://example.com/photo.jpg',
    rev: '20260314T120000Z',
    ...overrides,
  };
}

function makeMinimalVCard(): VCard {
  return {
    uid: 'min-001',
    fn: 'Bob',
  };
}

// ── Roundtrip tests ──

describe('parseVCard / generateVCard roundtrip', () => {
  it('roundtrips a fully populated vCard', () => {
    const original = makeFullVCard();
    const vcardStr = generateVCard(original);
    const restored = parseVCard(vcardStr);

    expect(restored.uid).toBe(original.uid);
    expect(restored.fn).toBe(original.fn);
    expect(restored.n?.family).toBe('Doe');
    expect(restored.n?.given).toBe('Jane');
    expect(restored.n?.prefix).toBe('Dr.');
    expect(restored.n?.suffix).toBe('PhD');
    expect(restored.org).toBe('Acme Corp');
    expect(restored.title).toBe('Senior Engineer');
    expect(restored.note).toBe('Met at conference');
    expect(restored.bday).toBe('1990-01-15');
    expect(restored.rev).toBe('20260314T120000Z');
  });

  it('roundtrips a minimal vCard (just UID + FN)', () => {
    const original = makeMinimalVCard();
    const vcardStr = generateVCard(original);
    const restored = parseVCard(vcardStr);

    expect(restored.uid).toBe(original.uid);
    expect(restored.fn).toBe(original.fn);
    expect(restored.tel).toBeUndefined();
    expect(restored.email).toBeUndefined();
    expect(restored.adr).toBeUndefined();
    expect(restored.org).toBeUndefined();
  });
});

// ── Multiple phones/emails/addresses ──

describe('multiple phones, emails, addresses', () => {
  it('preserves multiple phone numbers with types', () => {
    const original = makeFullVCard({
      tel: [
        { type: 'cell', value: '+1111111111' },
        { type: 'home', value: '+2222222222' },
        { type: 'work', value: '+3333333333' },
      ],
    });
    const vcardStr = generateVCard(original);
    const restored = parseVCard(vcardStr);

    expect(restored.tel).toHaveLength(3);
    expect(restored.tel![0]!.type).toBe('cell');
    expect(restored.tel![0]!.value).toBe('+1111111111');
    expect(restored.tel![1]!.type).toBe('home');
    expect(restored.tel![2]!.type).toBe('work');
  });

  it('preserves multiple email addresses with types', () => {
    const original = makeFullVCard({
      email: [
        { type: 'home', value: 'home@example.com' },
        { type: 'work', value: 'work@example.com' },
      ],
    });
    const vcardStr = generateVCard(original);
    const restored = parseVCard(vcardStr);

    expect(restored.email).toHaveLength(2);
    expect(restored.email![0]!.value).toBe('home@example.com');
    expect(restored.email![1]!.value).toBe('work@example.com');
  });

  it('preserves multiple addresses', () => {
    const original = makeFullVCard({
      adr: [
        { type: 'home', street: '123 Home St', city: 'Homeville', state: 'HO', postalCode: '11111', country: 'US' },
        { type: 'work', street: '456 Work Ave', city: 'Worktown', state: 'WO', postalCode: '22222', country: 'US' },
      ],
    });
    const vcardStr = generateVCard(original);
    const restored = parseVCard(vcardStr);

    expect(restored.adr).toHaveLength(2);
    expect(restored.adr![0]!.street).toBe('123 Home St');
    expect(restored.adr![0]!.type).toBe('home');
    expect(restored.adr![1]!.street).toBe('456 Work Ave');
    expect(restored.adr![1]!.type).toBe('work');
  });
});

// ── Birthday parsing ──

describe('birthday parsing', () => {
  it('handles YYYY-MM-DD birthday format', () => {
    const original = makeFullVCard({ bday: '1990-01-15' });
    const vcardStr = generateVCard(original);
    const restored = parseVCard(vcardStr);
    expect(restored.bday).toBe('1990-01-15');
  });

  it('handles YYYYMMDD birthday format', () => {
    const original = makeFullVCard({ bday: '19900115' });
    const vcardStr = generateVCard(original);
    const restored = parseVCard(vcardStr);
    expect(restored.bday).toBe('19900115');
  });
});

// ── Special characters ──

describe('special characters', () => {
  it('escapes and unescapes commas in names', () => {
    const original = makeFullVCard({ fn: 'Doe, Jane' });
    const vcardStr = generateVCard(original);
    expect(vcardStr).toContain('FN:Doe\\, Jane');
    const restored = parseVCard(vcardStr);
    expect(restored.fn).toBe('Doe, Jane');
  });

  it('escapes and unescapes semicolons in notes', () => {
    const original = makeFullVCard({ note: 'Note; with semicolons; here' });
    const vcardStr = generateVCard(original);
    const restored = parseVCard(vcardStr);
    expect(restored.note).toBe('Note; with semicolons; here');
  });

  it('escapes and unescapes newlines in notes', () => {
    const original = makeFullVCard({ note: 'Line 1\nLine 2\nLine 3' });
    const vcardStr = generateVCard(original);
    const restored = parseVCard(vcardStr);
    expect(restored.note).toBe('Line 1\nLine 2\nLine 3');
  });

  it('escapes and unescapes backslashes', () => {
    const original = makeFullVCard({ note: 'Path: C:\\Users\\jane' });
    const vcardStr = generateVCard(original);
    const restored = parseVCard(vcardStr);
    expect(restored.note).toBe('Path: C:\\Users\\jane');
  });
});

// ── Photo URI ──

describe('photo', () => {
  it('roundtrips PHOTO with VALUE=URI', () => {
    const original = makeFullVCard({ photo: 'https://example.com/avatar.png' });
    const vcardStr = generateVCard(original);
    expect(vcardStr).toContain('PHOTO;VALUE=URI:https://example.com/avatar.png');
    const restored = parseVCard(vcardStr);
    expect(restored.photo).toBe('https://example.com/avatar.png');
  });
});

// ── Line folding ──

describe('line folding', () => {
  it('handles long lines via folding/unfolding', () => {
    const longNote = 'A'.repeat(200);
    const original = makeFullVCard({ note: longNote });
    const vcardStr = generateVCard(original);
    const restored = parseVCard(vcardStr);
    expect(restored.note).toBe(longNote);
  });
});

// ── Parsing raw vCard strings ──

describe('parsing raw vCard strings', () => {
  it('parses a standard vCard 3.0 string', () => {
    const raw = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'UID:abc-123',
      'FN:John Smith',
      'N:Smith;John;;;',
      'TEL;TYPE=cell:+15551234567',
      'EMAIL;TYPE=home:john@example.com',
      'ORG:Smith & Co',
      'END:VCARD',
    ].join('\r\n');

    const vcard = parseVCard(raw);
    expect(vcard.uid).toBe('abc-123');
    expect(vcard.fn).toBe('John Smith');
    expect(vcard.n?.family).toBe('Smith');
    expect(vcard.n?.given).toBe('John');
    expect(vcard.tel).toHaveLength(1);
    expect(vcard.tel![0]!.type).toBe('cell');
    expect(vcard.email).toHaveLength(1);
    expect(vcard.org).toBe('Smith & Co');
  });

  it('parses iPhone grouped contact properties', () => {
    const raw = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'PRODID:-//Apple Inc.//iOS 18.1//EN',
      'N:Halber Meister;Bene;;;',
      'FN:Bene Halber Meister',
      'item1.TEL;type=pref:+4917671231328',
      'item1.X-ABLabel:',
      'item2.EMAIL;type=INTERNET;type=pref:bene@example.com',
      'item3.ADR;type=HOME:;;Main Street 1;Berlin;;10115;Germany',
      'END:VCARD',
    ].join('\r\n');

    const vcard = parseVCard(raw);
    expect(vcard.tel).toEqual([{ type: 'pref', value: '+4917671231328' }]);
    expect(vcard.email).toEqual([{ type: 'internet,pref', value: 'bene@example.com' }]);
    expect(vcard.adr).toHaveLength(1);
    expect(vcard.adr![0]!.type).toBe('home');
    expect(vcard.adr![0]!.street).toBe('Main Street 1');
  });

  it('preserves repeated iPhone TYPE parameters', () => {
    const raw = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Bene',
      'TEL;type=CELL;type=VOICE;type=pref:+4915128724408',
      'END:VCARD',
    ].join('\r\n');

    const vcard = parseVCard(raw);
    expect(vcard.tel).toEqual([{ type: 'cell,voice,pref', value: '+4915128724408' }]);
  });

  it('preserves repeated TYPE parameters on grouped iPhone phone properties', () => {
    const raw = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Bene',
      'item5.TEL;type=CELL;type=VOICE;type=pref:+4915128724408',
      'END:VCARD',
    ].join('\r\n');

    const vcard = parseVCard(raw);
    expect(vcard.tel).toEqual([{ type: 'cell,voice,pref', value: '+4915128724408' }]);
  });

  it('normalizes vCard 4 tel URI values', () => {
    const raw = [
      'BEGIN:VCARD',
      'VERSION:4.0',
      'FN:Bene',
      'TEL;VALUE=uri:tel:%2B4912345678',
      'END:VCARD',
    ].join('\r\n');

    const vcard = parseVCard(raw);
    expect(vcard.tel).toEqual([{ type: 'other', value: '+4912345678' }]);
  });

  it('does not split escaped semicolons in structured name and address values', () => {
    const raw = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Jane Doe',
      'N:Doe\\;Smith;Jane;;;',
      'ADR;TYPE=home:;;Main\\; Side Street 1;Berlin;;10115;Germany',
      'END:VCARD',
    ].join('\r\n');

    const vcard = parseVCard(raw);
    expect(vcard.n?.family).toBe('Doe;Smith');
    expect(vcard.n?.given).toBe('Jane');
    expect(vcard.adr).toHaveLength(1);
    expect(vcard.adr![0]!.street).toBe('Main; Side Street 1');
    expect(vcard.adr![0]!.city).toBe('Berlin');
  });
});

// ── CATEGORIES (#291) ──

describe('CATEGORIES', () => {
  it('parses a single CATEGORIES value', () => {
    const raw = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'UID:vcf-cat-1',
      'FN:Jane Doe',
      'CATEGORIES:Work',
      'END:VCARD',
    ].join('\r\n');

    const vcard = parseVCard(raw);
    expect(vcard.categories).toEqual(['Work']);
  });

  it('parses multiple comma-separated CATEGORIES', () => {
    const raw = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'UID:vcf-cat-2',
      'FN:Jane Doe',
      'CATEGORIES:Friends,Work,Family',
      'END:VCARD',
    ].join('\r\n');

    const vcard = parseVCard(raw);
    expect(vcard.categories).toEqual(['Friends', 'Work', 'Family']);
  });

  it('unescapes commas within a single category value', () => {
    const raw = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'UID:vcf-cat-3',
      'FN:Jane Doe',
      'CATEGORIES:Team\\, Alpha,VIP',
      'END:VCARD',
    ].join('\r\n');

    const vcard = parseVCard(raw);
    expect(vcard.categories).toEqual(['Team, Alpha', 'VIP']);
  });

  it('emits CATEGORIES joined by commas with each value escaped', () => {
    const vcard: VCard = {
      uid: 'vcf-cat-gen',
      fn: 'Jane Doe',
      categories: ['Work', 'Team, Alpha'],
    };

    const generated = generateVCard(vcard);
    expect(generated).toContain('CATEGORIES:Work,Team\\, Alpha');
  });

  it('roundtrips CATEGORIES through generate/parse', () => {
    const original: VCard = {
      uid: 'vcf-cat-rt',
      fn: 'Jane Doe',
      categories: ['Friends', 'VIP', 'Team, Alpha'],
    };

    const generated = generateVCard(original);
    const parsed = parseVCard(generated);
    expect(parsed.categories).toEqual(original.categories);
  });

  it('defaults categories to undefined when CATEGORIES is absent', () => {
    const raw = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'UID:vcf-cat-none',
      'FN:Jane Doe',
      'END:VCARD',
    ].join('\r\n');

    const vcard = parseVCard(raw);
    expect(vcard.categories).toBeUndefined();
  });

  it('omits CATEGORIES line when categories is empty or undefined', () => {
    const without: VCard = { uid: 'vcf-cat-omit', fn: 'Jane Doe' };
    expect(generateVCard(without)).not.toContain('CATEGORIES');

    const empty: VCard = { uid: 'vcf-cat-omit2', fn: 'Jane Doe', categories: [] };
    expect(generateVCard(empty)).not.toContain('CATEGORIES');
  });
});
