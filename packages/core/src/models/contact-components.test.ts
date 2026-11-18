import { describe, expect, it } from 'vitest';
import { deserializeContact, serializeContact } from './contact.js';
import { generateVCard, parseVCard } from '../utils/vcard-parser.js';

const card = (name: string, address: string) => ['BEGIN:VCARD', 'VERSION:3.0', 'UID:components', 'FN:John Public', `N:${name}`, `ADR;TYPE=home:${address}`, 'END:VCARD'].join('\r\n');

describe('uneditable contact components', () => {
  it.each([
    ['Public;John;Quinlan;Mr.;Esq.', 'PO Box 123;Apartment 4;Main Street;Town;;;'],
    ['Public;John;Quinlan,James\\, Jr.;;', 'PO\\;Box;Floor\\, 2,Apartment 4;Main Street;;;;'],
    ['Public;John;Q\\\\R;;', 'PO Box 123;;;;;;'],
  ])('retains source components through parsing and an unrelated edit: %s', (name, address) => {
    const source = card(name, address);
    expect(generateVCard(parseVCard(source))).toContain(`N:${name}`);
    expect(generateVCard(parseVCard(source))).toContain(`ADR;TYPE=home:${address}`);
    const wire = serializeContact({ ...deserializeContact(source), notes: 'Edited' });
    expect(wire).toContain(`N:${name}`);
    expect(wire).toContain(`ADR;TYPE=home:${address}`);
  });
  it('converts encoded hidden text to escaped components without introducing fields', () => {
    const source = card('Public;John;;;', ';;;;;;').replace('N:Public;John;;;', 'N;ENCODING=QUOTED-PRINTABLE:Public;John;Quinlan=2C Jr.,James;;')
      .replace('ADR;TYPE=home:;;;;;;', 'ADR;TYPE=home;ENCODING=QUOTED-PRINTABLE:Box=3B12;Floor=0A2;;;;;');
    const wire = serializeContact(deserializeContact(source));
    expect(wire).toContain('N:Public;John;Quinlan\\, Jr.,James;;');
    expect(wire).toContain('ADR;TYPE=home:Box\\;12;Floor\\n2;;;;;');
  });
  it.each([1, 2, 3])('escapes an unmatched trailing backslash in incomplete hidden components (%i backslashes)', (count) => {
    const suffix = '\\'.repeat(count)
    const retained = '\\'.repeat(count + count % 2)
    const source = card(`Public;John;Q${suffix}`, `Box;Apt${suffix}`)
    let parsed = parseVCard(source)
    for (let round = 0; round < 3; round++) {
      const wire = generateVCard(parsed)
      expect(wire).toContain(`N:Public;John;Q${retained};;`)
      expect(wire).toContain(`ADR;TYPE=home:Box;Apt${retained};;;;;`)
      parsed = parseVCard(wire)
    }
    const contact = deserializeContact(source)
    expect(serializeContact({ ...contact, notes: 'Edited', favorite: true })).toContain(`N:Public;John;Q${retained};;`)
    expect(generateVCard(parseVCard(card('Public;John;;;', `Box${suffix}`)))).toContain(`ADR;TYPE=home:Box${retained};;;;;;`)
  });
  it('keeps absent components absent from the model and unchanged on the wire', () => {
    const source = card('Public;John;;;', ';;Main Street;Town;;;');
    const parsed = parseVCard(source);
    expect(parsed.n).not.toHaveProperty('additional');
    expect(parsed.adr?.[0]).not.toHaveProperty('poBox');
    expect(parsed.adr?.[0]).not.toHaveProperty('extended');
    expect(generateVCard(parsed)).toBe(source);
  });
});
