import { describe, expect, it } from 'vitest';
import { isVCardBoundary, parseVCard, splitVCardFile, unfoldLines } from './vcard-parser';

/** The quadratic implementation this replaces, kept to prove identical output. */
function legacyUnfold(text: string): string {
  const parseEncoding = (line: string): string | undefined => {
    let inQuotes = false;
    let colon = line.length;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') inQuotes = !inQuotes;
      else if (line[i] === ':' && !inQuotes) { colon = i; break; }
    }
    const left = line.slice(0, colon);
    const semi = left.indexOf(';');
    if (semi === -1) return undefined;
    let encoding: string | undefined;
    let current = '';
    let quoted = false;
    const parts: string[] = [];
    for (const ch of left.slice(semi + 1)) {
      if (ch === '"') { quoted = !quoted; current += ch; } else if (ch === ';' && !quoted) { parts.push(current); current = ''; } else current += ch;
    }
    if (current) parts.push(current);
    for (const part of parts) {
      const eq = part.indexOf('=');
      if (eq !== -1 && part.slice(0, eq).toUpperCase() === 'ENCODING') {
        const value = part.slice(eq + 1).replace(/^"(.*)"$/, '$1');
        encoding = encoding ? `${encoding},${value}` : value;
      }
    }
    return encoding;
  };
  const lines: string[] = [];
  for (const physical of text.split(/\r?\n/)) {
    const previous = lines[lines.length - 1];
    const folded = /^[ \t]/.test(physical);
    const next = folded ? physical.slice(1) : physical;
    if (previous && previous.endsWith('=') && parseEncoding(previous)?.toUpperCase() === 'QUOTED-PRINTABLE') {
      if (/^(?:BEGIN|END):VCARD$/i.test(physical.trim())) lines.push(physical);
      else lines[lines.length - 1] = previous.slice(0, -1) + physical;
    } else if (folded && previous) {
      lines[lines.length - 1] = previous + next;
    } else {
      lines.push(physical);
    }
  }
  return lines.join('\n');
}

const CASES: Record<string, string> = {
  plainFold: 'BEGIN:VCARD\r\nNOTE:abc\r\n def\r\n\tghi\r\nEND:VCARD',
  qpSoftBreak: 'BEGIN:VCARD\r\nNOTE;ENCODING=QUOTED-PRINTABLE:caf=C3=\r\n=A9 =\r\nmore\r\nEND:VCARD',
  qpWhitespaceColon: 'BEGIN:VCARD\r\nNOTE;ENCODING=QUOTED-PRINTABLE:a=\r\n  :b\r\nEND:VCARD',
  qpFramingEnds: 'BEGIN:VCARD\r\nNOTE;ENCODING=QUOTED-PRINTABLE:a=\r\nEND:VCARD\r\nBEGIN:VCARD\r\nFN:x\r\nEND:VCARD',
  foldedQpHeader: 'BEGIN:VCARD\r\nNOTE;ENC\r\n ODING=QUOTED-PRINTABLE:a=\r\nb\r\nEND:VCARD',
  quotedColonHeader: 'BEGIN:VCARD\r\nX-A;LABEL="a:b";ENCODING=QUOTED-PRINTABLE:v=\r\nw\r\nEND:VCARD',
  emptyContinuation: 'BEGIN:VCARD\r\nNOTE:a\r\n \r\n b\r\n\r\n c\r\nEND:VCARD',
  equalsWithoutQp: 'BEGIN:VCARD\r\nNOTE:a=\r\n b=\r\nc\r\nEND:VCARD',
  lfOnly: 'BEGIN:VCARD\nFN:a\n b\nEND:VCARD\n',
  danglingQp: 'BEGIN:VCARD\r\nFN;ENCODING=QUOTED-PRINTABLE:unfinished=\r\nEND:VCARD',
};

describe('unfoldLines', () => {
  it.each(Object.entries(CASES))('matches the previous implementation: %s', (_, text) => {
    expect(unfoldLines(text)).toBe(legacyUnfold(text));
  });

  it('keeps an indented boundary after a QP soft break as payload (strict and tolerant)', () => {
    for (const boundary of [' BEGIN:VCARD', ' END:VCARD', '\tEND:VCARD']) {
      const card = `BEGIN:VCARD\r\nVERSION:2.1\r\nFN:Kept\r\nNOTE;ENCODING=QUOTED-PRINTABLE:a=\r\n${boundary}\r\nEMAIL:k@example.com\r\nEND:VCARD`;
      for (const strict of [true, false]) {
        const parsed = parseVCard(card, { strictTextEncoding: strict });
        expect(parsed.fn).toBe('Kept');
        expect(parsed.note).toBe(`a${boundary}`);
        expect(parsed.email?.[0]?.value).toBe('k@example.com');
      }
    }
  });

  it('unfolds a 4 MB folded NOTE and a 4 MB QP soft-break NOTE in bounded time', () => {
    const plain = 'n'.repeat(4_000_000).match(/.{1,74}/g)!.join('\r\n ');
    const qp = ('=41'.repeat(24) + '=\r\n').repeat(Math.ceil(4_000_000 / 75));
    const started = performance.now();
    expect(parseVCard(`BEGIN:VCARD\r\nFN:a\r\nNOTE:${plain}\r\nEND:VCARD`).note).toHaveLength(4_000_000);
    expect(parseVCard(`BEGIN:VCARD\r\nFN:b\r\nNOTE;ENCODING=QUOTED-PRINTABLE:${qp}41\r\nEND:VCARD`, { strictTextEncoding: true }).note!.length).toBeGreaterThan(1_000_000);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('isVCardBoundary', () => {
  it('reads only unindented boundaries, case-insensitively, with one leading BOM at file start', () => {
    expect(isVCardBoundary('BEGIN:VCARD')).toBe('BEGIN');
    expect(isVCardBoundary('end:vcard  ')).toBe('END');
    expect(isVCardBoundary(' BEGIN:VCARD')).toBeNull();
    expect(isVCardBoundary('\tEND:VCARD')).toBeNull();
    expect(isVCardBoundary('﻿BEGIN:VCARD', true)).toBe('BEGIN');
    expect(isVCardBoundary('﻿BEGIN:VCARD')).toBeNull();
  });
});

describe('splitVCardFile', () => {
  it('keeps a card whole when a continuation looks like a boundary', () => {
    const text = 'BEGIN:VCARD\r\nFN:Ada\r\nNOTE:x\r\n BEGIN:VCARD\r\nNOTE2:y\r\n END:VCARD\r\nEMAIL:a@example.com\r\nEND:VCARD\r\n';
    const { cards, incomplete } = splitVCardFile(text);
    expect(incomplete).toBe(0);
    expect(cards).toHaveLength(1);
    const parsed = parseVCard(cards[0]!);
    expect(parsed.fn).toBe('Ada');
    expect(parsed.note).toBe('xBEGIN:VCARD');
    expect(parsed.email?.[0]?.value).toBe('a@example.com');
  });

  it('still splits on unindented framing', () => {
    expect(splitVCardFile('BEGIN:VCARD\nFN:a\nEND:VCARD\nbegin:vcard\nFN:b\nend:vcard').cards).toHaveLength(2);
  });

  it('emits nothing for a stray END and counts unterminated cards', () => {
    expect(splitVCardFile('END:VCARD\nFN:stray\nEND:VCARD')).toEqual({ cards: [], incomplete: 0 });
    const nested = splitVCardFile('BEGIN:VCARD\nFN:open\nBEGIN:VCARD\nFN:b\nEND:VCARD\nBEGIN:VCARD\nFN:tail');
    expect(nested.cards).toHaveLength(1);
    expect(parseVCard(nested.cards[0]!).fn).toBe('b');
    expect(nested.incomplete).toBe(2);
  });

  it('ignores one leading BOM at file start', () => {
    const { cards } = splitVCardFile('﻿BEGIN:VCARD\r\nFN:Bom\r\nEND:VCARD');
    expect(cards).toHaveLength(1);
    expect(parseVCard(cards[0]!).fn).toBe('Bom');
  });
});
