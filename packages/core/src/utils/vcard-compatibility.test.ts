import { describe, expect, it } from 'vitest';
import { generateVCard, parseVCard } from './vcard-parser.js';
import { deserializeContact, serializeContact } from '../models/contact.js';

describe('safe model persistence', () => {
  it.each(['TEL', 'EMAIL'])('keeps decoded %s content out of wire structure across repeated saves', (field) => {
    let contact = deserializeContact(card(`${field};ENCODING=QUOTED-PRINTABLE:value=0D=0AX-SILENTSUITE-FAVORITE:1=0Dtail=0Anext=5C=5Cn`));
    const key = field === 'TEL' ? 'phones' : 'emails';
    // vCard TEXT represents line endings as LF; CRLF and lone CR canonicalize on write.
    const expected = contact[key][0]!.value.replace(/\r\n|\r/g, '\n');
    for (let round = 0; round < 3; round++) {
      const wire = serializeContact(contact);
      expect(wire.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
      expect(wire.split('\r\n')).not.toContain('X-SILENTSUITE-FAVORITE:1');
      contact = deserializeContact(wire);
      expect(contact.favorite).toBe(false);
      expect(contact[key][0]!.value).toBe(expected);
    }
  });

  it('preserves telephone URI parameters while safely persisting decoded controls', () => {
    let contact = deserializeContact(card('TEL;VALUE=uri:tel:%2B123;ext=45', 'EMAIL:a\\\\n@example.invalid'));
    for (let round = 0; round < 3; round++) {
      expect(contact.phones[0]!.value).toBe('+123;ext=45');
      expect(contact.emails[0]!.value).toBe('a\\n@example.invalid');
      contact = deserializeContact(serializeContact(contact));
    }
  });
});

const card = (...lines: string[]) => ['BEGIN:VCARD', 'VERSION:2.1', 'UID:synthetic', 'FN:Example', ...lines, 'END:VCARD'].join('\r\n');

describe('declared quoted-printable text', () => {
  it('decodes categories after splitting raw separators and unescapes only once', () => {
    const parsed = parseVCard(card('CATEGORIES;ENCODING=QUOTED-PRINTABLE:Team=2C West,Caf=C3=A9,Path=5C=5Cn'));
    expect(parsed.categories).toEqual(['Team, West', 'Café', 'Path\\n']);
    expect(parseVCard(generateVCard(parsed))).toEqual(parsed);
  });

  it('decodes bytes after continuation and before text unescaping, not before structured splitting', () => {
    const parsed = parseVCard(card('FN;ENCODING=QUOTED-PRINTABLE;CHARSET=UTF-8:Ren=C3=A9', 'N;ENCODING=QUOTED-PRINTABLE:Ex=3Bample;Ren=C3=A9;;;', 'ADR;HOME;ENCODING=QUOTED-PRINTABLE:;;Rue=3B =C3=', '=A9;Montr=C3=A9al;;A=3BB;CA', 'NOTE;ENCODING=QUOTED-PRINTABLE:=C3=A9=0A=', ' =E6=97=A5=E6=9C=AC\\nline\\\\nLiteral', 'TITLE;CHARSET=ISO-8859-1;ENCODING=QUOTED-PRINTABLE:Caf=E9'));
    expect(parsed.fn).toBe('René');
    expect(parsed.n).toMatchObject({ family: 'Ex;ample', given: 'René' });
    expect(parsed.adr?.[0]).toMatchObject({ street: 'Rue; é', city: 'Montréal', postalCode: 'A;B' });
    expect(parsed.note).toBe('é\n 日本\nline\\nLiteral');
    expect(parsed.title).toBe('Café');
    expect(parseVCard(generateVCard(parsed))).toEqual(parsed);
  });

  it('leaves unencoded equals and literal backslash sequences alone', () => {
    const parsed = parseVCard(card('NOTE:literal =C3=A9\\\\n and newline\\nnext', 'ORG:A=3BB'));
    expect(parsed.note).toBe('literal =C3=A9\\n and newline\nnext');
    expect(parsed.org).toBe('A=3BB');
  });

  it.each(['NOTE;ENCODING=QUOTED-PRINTABLE:bad=QZ', 'NOTE;ENCODING=QUOTED-PRINTABLE:bad=C3', 'NOTE;ENCODING=QUOTED-PRINTABLE;CHARSET=made-up:=E9', 'NOTE;ENCODING=BASE64:aGVsbG8=', 'NOTE;ENCODING=QUOTED-PRINTABLE:unfinished='])('rejects unsafe imported text without consuming card framing: %s', (line) => {
    expect(() => parseVCard(card(line), { strictTextEncoding: true })).toThrow(/vCard text encoding/);
  });

  it.each(['https://example.invalid', 'Office:West', ' world', '\tworld', 'TEL;HOME:111'])('retains QP continuation payload %j', (continuation) => {
    const parsed = parseVCard(card('NOTE;ENCODING=QUOTED-PRINTABLE:Hello=', continuation), { strictTextEncoding: true });
    expect(parsed.note).toBe(`Hello${continuation}`);
    expect(parseVCard(generateVCard(parsed))).toEqual(parsed);
  });

  it('preserves significant whitespace within structured address continuations', () => {
    const parsed = parseVCard(card('ADR;ENCODING=QUOTED-PRINTABLE:;;Main=', ' Street;New=', '\tTown;;;'));
    expect(parsed.adr?.[0]).toMatchObject({ street: 'Main Street', city: 'New\tTown' });
  });

  it('hydrates mixed valid and malformed stored contacts without inventing decoded content', () => {
    const raw = ['bad=41=QZ\\n', 'bad=C3', '=E9', 'aGVsbG8=', 'unfinished='];
    const params = ['QUOTED-PRINTABLE', 'QUOTED-PRINTABLE', 'QUOTED-PRINTABLE;CHARSET=made-up', 'BASE64', 'QUOTED-PRINTABLE'];
    const stored = [card('NOTE;ENCODING=QUOTED-PRINTABLE:Caf=C3=A9'), ...raw.map((value, i) => card(`NOTE;ENCODING=${params[i]}:${value}`))];
    const hydrated = stored.map(deserializeContact);
    expect(hydrated.map(contact => contact.notes)).toEqual(['Café', ...raw]);
    expect(hydrated.map(contact => deserializeContact(serializeContact(contact)).notes)).toEqual(['Café', ...raw]);
  });

  it('does not swallow END:VCARD or the following contact in tolerant hydration', () => {
    const source = card('NOTE;ENCODING=QUOTED-PRINTABLE:unfinished=');
    expect(deserializeContact(source).notes).toBe('unfinished=');
    expect(() => parseVCard(source, { strictTextEncoding: true })).toThrow(/vCard text encoding/);
  });
});

describe('legacy contact labels', () => {
  it('preserves case in wrapped custom labels, canonicalizing only known standard labels', () => {
    const parsed = parseVCard(card('item1.TEL:111', 'item1.X-ABLabel:_$!<Desk West>!$_'));
    expect(parsed.tel?.[0]?.type).toBe('Desk West');
    expect(parseVCard(generateVCard(parsed))).toEqual(parsed);
  });
  it('preserves bare, explicit, repeated and quoted types', () => {
    const parsed = parseVCard(card('TEL;HOME;VOICE:111', 'TEL;TYPE="WORK,CELL";TYPE=PREF:222', 'EMAIL;HOME:a@example.invalid', 'ADR;WORK:;;Street;City;;;'));
    expect(parsed.tel?.map(t => t.type)).toEqual(['home,voice', 'work,cell,pref']);
    expect(parsed.email?.[0]?.type).toBe('home');
    expect(parsed.adr?.[0]?.type).toBe('work');
    expect(parseVCard(generateVCard(parsed))).toEqual(parsed);
  });

  it('preserves grouped labels regardless of order and Android X- types through export', () => {
    const parsed = parseVCard(card('item1.X-ABLabel:Desk: west; "A"', 'item1.TEL;HOME:111', 'item2.EMAIL;WORK:a@example.invalid', 'item2.X-ABLabel:_$!<Home>!$_', 'TEL;X-Emergency:222', 'item3.ADR:;;Street;City;;;', 'item3.X-ABLabel:Postal desk'));
    expect(parsed.tel?.map(t => t.type)).toEqual(['Desk: west; "A"', 'x-emergency']);
    expect(parsed.email?.[0]?.type).toBe('home');
    expect(parsed.adr?.[0]?.type).toBe('Postal desk');
    expect(parseVCard(generateVCard(parsed))).toEqual(parsed);
  });
});
