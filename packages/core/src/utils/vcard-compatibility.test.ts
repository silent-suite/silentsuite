import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  it('preserves unlabeled vCard 2.1 phone numbers without inventing missing custom labels', () => {
    const parsed = parseVCard(card('N:Example;Contact;;;', 'TEL;HOME:111', 'TEL;:222', 'TEL;:333',
      'ADR;HOME;ENCODING=QUOTED-PRINTABLE:;;=31=30=30=20=54=65=73=74=20=53=74=',
      '=0A=45=78=61=6D=70=6C=65=20=43=69=74=79;;;;'), { strictTextEncoding: true });
    expect(parsed.tel).toEqual([{ type: 'home', value: '111' }, { type: 'other', value: '222' }, { type: 'other', value: '333' }]);
    expect(parsed.adr?.[0]).toMatchObject({ type: 'home', street: '100 Test St\nExample City' });
    expect(parseVCard(generateVCard(parsed))).toEqual(parsed);
  });

  it('recovers a bare custom phone label alongside a folded vCard 2.1 photo', () => {
    const parsed = parseVCard(card('TEL;WORK:111', 'TEL;HOME:222', 'TEL;CELL:333', 'TEL;X-Desk:444',
      'PHOTO;ENCODING=BASE64;JPEG:/9j/', ' 2Q==', ''), { strictTextEncoding: true });
    expect(parsed.tel).toEqual([{ type: 'work', value: '111' }, { type: 'home', value: '222' }, { type: 'cell', value: '333' }, { type: 'Desk', value: '444' }]);
    expect(parsed.photo).toBe('data:image/jpeg;base64,/9j/2Q==');
    expect(parseVCard(generateVCard(parsed))).toEqual(parsed);
  });

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
    expect(parsed.tel?.map(t => t.type)).toEqual(['Desk: west; "A"', 'Emergency']);
    expect(parsed.email?.[0]?.type).toBe('home');
    expect(parsed.adr?.[0]?.type).toBe('Postal desk');
    expect(parseVCard(generateVCard(parsed))).toEqual(parsed);
  });
});

describe('exporter-added X- type prefixes', () => {
  type TypedField = 'tel' | 'email' | 'adr';
  const firstType = (vcard: ReturnType<typeof parseVCard>, field: TypedField) =>
    (field === 'tel' ? vcard.tel?.[0] : field === 'email' ? vcard.email?.[0] : vcard.adr?.[0])?.type;
  const typeOf = (line: string, field: TypedField = 'tel') => firstType(parseVCard(card(line)), field);

  it.each([
    ['TEL;TYPE=X-Mary:111', 'tel', 'Mary'],
    ['EMAIL;TYPE=X-Emergency:a@example.invalid', 'email', 'Emergency'],
    ['ADR;TYPE=X-Vacation home:;;Street;City;;;', 'adr', 'Vacation home'],
    ['TEL;TYPE=x-mary:111', 'tel', 'mary'],
    ['TEL;TYPE=X-X-Mary:111', 'tel', 'X-Mary'],
    ['TEL;TYPE=HOME,X-Mary:111', 'tel', 'home,Mary'],
    ['TEL;X-Mary:111', 'tel', 'Mary'],
  ] as [string, TypedField, string][])('strips exactly one case-insensitive X- prefix from %s', (line, field, expected) => {
    expect(typeOf(line, field)).toBe(expected);
  });

  it('keeps a bare X- prefix as a literal token instead of an empty type', () => {
    expect(typeOf('TEL;TYPE=X-:111')).toBe('x-');
    expect(typeOf('TEL;TYPE=X-:111')).not.toBe('');
  });

  it('still yields other when TYPE is absent', () => {
    expect(typeOf('TEL:111')).toBe('other');
    expect(typeOf('EMAIL:a@example.invalid', 'email')).toBe('other');
    expect(typeOf('ADR:;;Street;City;;;', 'adr')).toBe('other');
  });

  it('keeps standard type tokens lowercased and roundtrip-stable', () => {
    const parsed = parseVCard(card('TEL;HOME;VOICE:111', 'TEL;TYPE="WORK,CELL";TYPE=PREF:222', 'EMAIL;HOME:a@example.invalid', 'ADR;WORK:;;Street;City;;;'));
    expect(parsed.tel?.map(t => t.type)).toEqual(['home,voice', 'work,cell,pref']);
    expect(parsed.email?.[0]?.type).toBe('home');
    expect(parsed.adr?.[0]?.type).toBe('work');
    expect(generateVCard(parsed)).toContain('TYPE=work,cell,pref');
    expect(parseVCard(generateVCard(parsed))).toEqual(parsed);
  });

  it('keeps a recovered custom type verbatim and stable across at least three serialize/parse cycles', () => {
    let parsed = parseVCard(card('TEL;TYPE=X-Mary:111'));
    expect(parsed.tel?.[0]?.type).toBe('Mary');
    for (let cycle = 0; cycle < 3; cycle++) {
      const wire = generateVCard(parsed);
      expect(wire).not.toMatch(/TYPE=/i);
      parsed = parseVCard(wire);
      expect(parsed.tel?.[0]?.type).toBe('Mary');
    }
  });

  it('preserves a literal grouped label starting with X- and never re-emits it as a TYPE token', () => {
    const first = parseVCard(card('item1.TEL:111', 'item1.X-ABLabel:X-Mary'));
    expect(first.tel?.[0]?.type).toBe('X-Mary');
    let current = first;
    for (let cycle = 0; cycle < 3; cycle++) {
      const wire = generateVCard(current);
      expect(wire).not.toContain('TYPE=X-Mary');
      current = parseVCard(wire);
      expect(current.tel?.[0]?.type).toBe('X-Mary');
      expect(current).toEqual(first);
    }
  });

  it('does not erode a literal lowercase label with a stacked prefix over repeated cycles', () => {
    const first = parseVCard(card('item1.EMAIL:user@example.invalid', 'item1.X-ABLabel:x-x-mary'));
    expect(first.email?.[0]?.type).toBe('x-x-mary');
    let current = first;
    for (let cycle = 0; cycle < 3; cycle++) {
      const wire = generateVCard(current);
      expect(wire).not.toMatch(/TYPE=x-/i);
      current = parseVCard(wire);
      expect(current.email?.[0]?.type).toBe('x-x-mary');
      expect(current).toEqual(first);
    }
  });

  it('leaves a mixed standard/custom list stable across cycles', () => {
    const first = parseVCard(card('TEL;TYPE=HOME,X-Mary:111'));
    expect(first.tel?.[0]?.type).toBe('home,Mary');
    let current = first;
    for (let cycle = 0; cycle < 3; cycle++) {
      current = parseVCard(generateVCard(current));
      expect(current.tel?.[0]?.type).toBe('home,Mary');
      expect(current).toEqual(first);
    }
  });
});

// ── #865: legacy no-extras wire goldens (captured from the unmodified base parser) ──

describe('legacy no-extras wire goldens (#865)', () => {
  const goldens: { cases: { name: string; input: string; wire: string; utf8_wire_base64: string; sha256: string }[] } =
    JSON.parse(readFileSync(new URL('../../fixtures/contact-preservation-legacy-wire.json', import.meta.url), 'utf8'));

  it.each(goldens.cases.map((c) => [c.name, c] as const))('%s: wire bytes and witness round-trip are unchanged', (_name, golden) => {
    const bytes = Buffer.from(golden.wire, 'utf8');
    expect(bytes.toString('base64')).toBe(golden.utf8_wire_base64);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(golden.sha256);
    expect(serializeContact(deserializeContact(golden.wire))).toBe(golden.wire);
    const fromInput = serializeContact(deserializeContact(golden.input)).replace(/\r\nREV:\d{8}T\d{6}Z\r\n/, '\r\nREV:20261024T072232Z\r\n');
    expect(fromInput).toBe(golden.wire);
    const decoded = bytes.toString('utf8');
    expect(serializeContact(deserializeContact(decoded))).toBe(decoded);
  });
});

// ── #865: unsupported property preservation matrix ──

describe('unsupported property preservation matrix (#865)', () => {
  /** Logical lines of a generated card; preserved QP lines are emitted unfolded. */
  const logical = (wire: string) => wire.replace(/\r\n[ \t]/g, '').split('\r\n');
  const roundTrip = (raw: string, strict = false) => generateVCard(parseVCard(raw, { strictTextEncoding: strict }));
  const kept = (wire: string, expected: string[]) => logical(wire).filter((line) => expected.includes(line));

  it('keeps mixed-case and repeated properties in order without growth over cycles', () => {
    const extras = ['X-FOO:1', 'x-foo:2', 'X-Foo:3', 'X-BAR:only'];
    let wire = roundTrip(card(...extras));
    for (let cycle = 0; cycle < 3; cycle++) wire = roundTrip(wire);
    expect(kept(wire, extras)).toEqual(extras);
  });

  it('keeps unsupported standard text properties', () => {
    const extras = [
      'URL:https://example.invalid/a',
      'NICKNAME:Jo',
      'IMPP:xmpp:jo@example.invalid',
      'RELATED;TYPE=friend:urn:uuid:synthetic',
      'ANNIVERSARY:20000101',
      'X-PHONETIC-FIRST-NAME:Jo',
      'X-SIP:sip:jo@example.invalid',
      'LOGO;VALUE=uri:https://example.invalid/logo.png',
    ];
    expect(kept(roundTrip(card(...extras), true), extras)).toEqual(extras);
  });

  it('keeps grouped parameters and opaque labels while consumed TEL labels stay modelled', () => {
    const extras = ['item7.X-FOO;TYPE=a,b;X-P="q;r:s":v', 'item7.X-ABLabel:Lbl'];
    const raw = card('item1.TEL:111', 'item1.X-ABLabel:Custom', ...extras);
    const parsed = parseVCard(raw, { strictTextEncoding: true });
    expect(parsed.tel?.[0]?.type).toBe('Custom');
    const wire = generateVCard(parsed);
    expect(kept(wire, extras)).toEqual(extras);
    expect(logical(wire).filter((line) => /X-ABLabel:Custom$/.test(line))).toHaveLength(1);
    expect(parseVCard(wire).tel?.[0]?.type).toBe('Custom');
  });

  it('does not reuse a preserved group for a generated custom label', () => {
    const extras = ['item1.X-FOO:v', 'item1.X-ABLabel:Kept'];
    const parsed = parseVCard(card('TEL;TYPE=X-Two Words:111', ...extras));
    const wire = generateVCard(parsed);
    expect(kept(wire, extras)).toEqual(extras);
    const telLine = logical(wire).find((line) => /\.TEL:111$/.test(line));
    expect(telLine).toBeDefined();
    expect(telLine!.startsWith('item1.')).toBe(false);
    const reparsed = parseVCard(wire);
    expect(reparsed.tel?.map((t) => t.type)).toEqual(['Two Words']);
  });

  it('keeps an opaque label with an unsupported charset under strict import', () => {
    const extras = ['item9.X-FOO:v', 'item9.X-ABLabel;CHARSET=x-unsupported;ENCODING=QUOTED-PRINTABLE:=FF'];
    expect(kept(roundTrip(card(...extras), true), extras)).toEqual(extras);
  });

  it('still rejects a consumed TEL label with an unsupported charset under strict import', () => {
    expect(() => parseVCard(card('item2.TEL:111', 'item2.X-ABLabel;CHARSET=x-unsupported;ENCODING=QUOTED-PRINTABLE:=FF'), { strictTextEncoding: true }))
      .toThrow();
  });

  it('keeps long escaped Unicode values logically identical with safe folding', () => {
    const value = `${'é中🙂 a\\,b\\;c\\n '.repeat(14)}end`;
    const line = `X-LONG:${value}`;
    const folded = Array.from(line).reduce((parts, ch, i) => parts + (i > 0 && i % 31 === 0 ? '\r\n ' : '') + ch, '');
    const wire = roundTrip(card(folded));
    expect(kept(wire, [line])).toEqual([line]);
    for (const physical of wire.split('\r\n')) {
      expect(Buffer.byteLength(physical, 'utf8')).toBeLessThanOrEqual(75);
      expect(Buffer.from(physical, 'utf8').toString('utf8')).toBe(physical);
    }
  });

  it('keeps folding stable across parameter padding, including QP and bare encoding tokens', () => {
    for (let pad = 0; pad <= 80; pad++) {
      const extras = [
        `X-PAD;X-P=${'a'.repeat(pad)}:${'v=é中🙂='.repeat(12)}`,
        `X-QP;ENCODING=QUOTED-PRINTABLE;X-P=${'b'.repeat(pad)}:${'=C3=A9'.repeat(20)}`,
        `X-BARE;QUOTED-PRINTABLE;X-P=${'c'.repeat(pad)}:${'x='.repeat(40)}`,
      ];
      const wire = roundTrip(card(...extras));
      expect(kept(roundTrip(wire), extras)).toEqual(extras);
    }
  });

  it('emits a single quoted mixed-case QP property unfolded', () => {
    const line = `X-Q;encoding="Quoted-Printable":${'=C3=A9'.repeat(30)}`;
    expect(roundTrip(card(line)).split('\r\n')).toContain(line);
  });

  it('drops ambiguous duplicate or list encodings', () => {
    const wire = roundTrip(card(
      'X-D1;ENCODING=QUOTED-PRINTABLE;ENCODING=8BIT:x',
      'X-D2;encoding="quoted-printable";Encoding=8bit:x',
      'X-D3;ENCODING=QUOTED-PRINTABLE,8BIT:x',
      'X-OK:y',
    ));
    expect(wire).not.toMatch(/X-D\d/);
    expect(logical(wire)).toContain('X-OK:y');
  });

  it('drops malformed and injection-shaped lines and keeps one card frame', () => {
    const wire = roundTrip(card(
      'X-CR:a\rEND:VCARD',
      'item1.BEGIN:VCARD',
      'end:vcard',
      'X FOO:bar',
      'X-NOCOLON',
      'X-Q;X-P="unbalanced:v',
      'X-CTL:a\u0001b',
      'X-OK:y',
    ));
    expect(wire.match(/BEGIN:VCARD/gi)).toHaveLength(1);
    expect(wire.match(/END:VCARD/gi)).toHaveLength(1);
    expect(wire).not.toMatch(/\r(?!\n)/);
    expect(wire).not.toMatch(/X-CR|X FOO|X-NOCOLON|unbalanced|X-CTL/);
    expect(logical(wire)).toContain('X-OK:y');
  });

  it('keeps favorite, PRODID and oversized lines out of the preserved set', () => {
    const wire = roundTrip(card(
      'x-silentsuite-favorite:1',
      'item3.X-SILENTSUITE-FAVORITE;TYPE=pref:1',
      'PRODID:-//Other//EN',
      `X-HUGE:${'a'.repeat(1_000_001)}`,
      'X-OK:y',
    ));
    expect(parseVCard(wire).favorite).toBe(true);
    expect(wire.split('\r\n').filter((line) => /SILENTSUITE-FAVORITE/i.test(line))).toEqual(['X-SILENTSUITE-FAVORITE:1']);
    expect(wire).not.toMatch(/PRODID|X-HUGE/);
    expect(logical(wire)).toContain('X-OK:y');
  });

  it('carries preserved properties through the contact model and leaves older records without any', () => {
    const contact = deserializeContact(card('X-OK:y'));
    expect(logical(serializeContact({ ...contact, notes: 'edited' }))).toContain('X-OK:y');
    expect(deserializeContact(card()).unknownProperties).toBeUndefined();
  });
});
