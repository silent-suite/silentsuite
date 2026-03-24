/**
 * Lightweight vCard 3.0 (RFC 2426) parser/generator.
 * Supports common contact properties with line folding and escaping.
 */

export interface VCardName {
  family: string;
  given: string;
  prefix?: string;
  suffix?: string;
}

export interface VCardPhone {
  type: string;
  value: string;
}

export interface VCardEmail {
  type: string;
  value: string;
}

export interface VCardAddress {
  type: string;
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface VCard {
  uid: string;
  fn: string;
  n?: VCardName;
  tel?: VCardPhone[];
  email?: VCardEmail[];
  adr?: VCardAddress[];
  org?: string;
  title?: string;
  note?: string;
  bday?: string;
  photo?: string;
  rev?: string;
}

// ── Escaping ──

function escapeText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

function unescapeText(text: string): string {
  return text
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

// ── Line folding ──

function foldLine(line: string): string {
  const MAX_OCTETS = 75;
  if (Buffer.byteLength(line, 'utf8') <= MAX_OCTETS) {
    return line;
  }
  const parts: string[] = [];
  let remaining = line;
  let isFirst = true;
  while (Buffer.byteLength(remaining, 'utf8') > MAX_OCTETS) {
    const limit = isFirst ? MAX_OCTETS : MAX_OCTETS - 1;
    let cutPoint = 0;
    let byteCount = 0;
    for (let i = 0; i < remaining.length; i++) {
      const charBytes = Buffer.byteLength(remaining[i]!, 'utf8');
      if (byteCount + charBytes > limit) break;
      byteCount += charBytes;
      cutPoint = i + 1;
    }
    if (cutPoint === 0) cutPoint = 1;
    parts.push(remaining.slice(0, cutPoint));
    remaining = remaining.slice(cutPoint);
    isFirst = false;
  }
  if (remaining.length > 0) {
    parts.push(remaining);
  }
  return parts.join('\r\n ');
}

function unfoldLines(text: string): string {
  return text.replace(/\r?\n[ \t]/g, '');
}

// ── Parsing helpers ──

interface ParsedProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

function findPropertyColon(line: string): number {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ':' && !inQuotes) {
      return i;
    }
  }
  return line.length;
}

function splitParams(paramStr: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of paramStr) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === ';' && !inQuotes) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function parseProperty(line: string): ParsedProperty {
  const colonIdx = findPropertyColon(line);
  const left = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);

  const semiIdx = left.indexOf(';');
  const name = (semiIdx === -1 ? left : left.slice(0, semiIdx)).toUpperCase();
  const params: Record<string, string> = {};

  if (semiIdx !== -1) {
    const paramStr = left.slice(semiIdx + 1);
    for (const part of splitParams(paramStr)) {
      const eqIdx = part.indexOf('=');
      if (eqIdx !== -1) {
        params[part.slice(0, eqIdx).toUpperCase()] = part.slice(eqIdx + 1);
      }
    }
  }

  return { name, params, value };
}

function getTypeParam(params: Record<string, string>): string {
  return (params['TYPE'] ?? 'other').toLowerCase();
}

// ── Parser ──

/**
 * Parse a vCard 3.0 string into a VCard object.
 */
export function parseVCard(vcardStr: string): VCard {
  const unfolded = unfoldLines(vcardStr);
  const lines = unfolded.split(/\r?\n/).filter((l) => l.length > 0);

  const vcard: VCard = { uid: '', fn: '' };
  const tels: VCardPhone[] = [];
  const emails: VCardEmail[] = [];
  const adrs: VCardAddress[] = [];

  for (const line of lines) {
    if (line === 'BEGIN:VCARD' || line === 'END:VCARD') continue;
    if (line.startsWith('VERSION:')) continue;

    const prop = parseProperty(line);
    switch (prop.name) {
      case 'UID':
        vcard.uid = prop.value;
        break;
      case 'FN':
        vcard.fn = unescapeText(prop.value);
        break;
      case 'N': {
        const parts = prop.value.split(';');
        vcard.n = {
          family: unescapeText(parts[0] ?? ''),
          given: unescapeText(parts[1] ?? ''),
          prefix: parts[3] ? unescapeText(parts[3]) : undefined,
          suffix: parts[4] ? unescapeText(parts[4]) : undefined,
        };
        break;
      }
      case 'TEL':
        tels.push({ type: getTypeParam(prop.params), value: prop.value });
        break;
      case 'EMAIL':
        emails.push({ type: getTypeParam(prop.params), value: prop.value });
        break;
      case 'ADR': {
        const adrParts = prop.value.split(';');
        adrs.push({
          type: getTypeParam(prop.params),
          street: unescapeText(adrParts[2] ?? ''),
          city: unescapeText(adrParts[3] ?? ''),
          state: unescapeText(adrParts[4] ?? ''),
          postalCode: adrParts[5] ?? '',
          country: unescapeText(adrParts[6] ?? ''),
        });
        break;
      }
      case 'ORG':
        vcard.org = unescapeText(prop.value);
        break;
      case 'TITLE':
        vcard.title = unescapeText(prop.value);
        break;
      case 'NOTE':
        vcard.note = unescapeText(prop.value);
        break;
      case 'BDAY':
        vcard.bday = prop.value;
        break;
      case 'PHOTO': {
        const val = prop.value;
        // Skip oversized photos (base64 > 1MB ≈ 750KB image)
        if (val.length > 1_000_000) {
          vcard.photo = undefined;
          break;
        }
        if (val.startsWith('data:') || val.startsWith('http://') || val.startsWith('https://')) {
          vcard.photo = val;
        } else {
          const encoding = (prop.params['ENCODING'] ?? '').toUpperCase();
          if (encoding === 'B' || encoding === 'BASE64') {
            const typeParam = (prop.params['TYPE'] ?? 'JPEG').toUpperCase();
            const mimeMap: Record<string, string> = {
              JPEG: 'image/jpeg',
              JPG: 'image/jpeg',
              PNG: 'image/png',
              GIF: 'image/gif',
              WEBP: 'image/webp',
            };
            const mime = mimeMap[typeParam] ?? 'image/jpeg';
            vcard.photo = `data:${mime};base64,${val}`;
          } else {
            // Heuristic: if it looks like base64 (no spaces, long string), wrap it
            if (val.length > 100 && /^[A-Za-z0-9+/=\r\n]+$/.test(val.replace(/\s/g, ''))) {
              vcard.photo = `data:image/jpeg;base64,${val.replace(/\s/g, '')}`;
            } else {
              vcard.photo = val;
            }
          }
        }
        break;
      }
      case 'REV':
        vcard.rev = prop.value;
        break;
    }
  }

  if (tels.length > 0) vcard.tel = tels;
  if (emails.length > 0) vcard.email = emails;
  if (adrs.length > 0) vcard.adr = adrs;

  // Input validation
  if (!vcard.uid) {
    vcard.uid = crypto.randomUUID();
  }
  if (!vcard.fn) {
    vcard.fn = 'Untitled';
  }

  return vcard;
}

// ── Generator ──

/**
 * Generate a vCard 3.0 string from a VCard object.
 */
export function generateVCard(vcard: VCard): string {
  const lines: string[] = [];
  lines.push('BEGIN:VCARD');
  lines.push('VERSION:3.0');

  lines.push(foldLine(`UID:${vcard.uid}`));
  lines.push(foldLine(`FN:${escapeText(vcard.fn)}`));

  if (vcard.n) {
    const nParts = [
      escapeText(vcard.n.family),
      escapeText(vcard.n.given),
      '', // additional names
      vcard.n.prefix ? escapeText(vcard.n.prefix) : '',
      vcard.n.suffix ? escapeText(vcard.n.suffix) : '',
    ];
    lines.push(foldLine(`N:${nParts.join(';')}`));
  }

  if (vcard.tel) {
    for (const tel of vcard.tel) {
      lines.push(foldLine(`TEL;TYPE=${tel.type}:${tel.value}`));
    }
  }

  if (vcard.email) {
    for (const email of vcard.email) {
      lines.push(foldLine(`EMAIL;TYPE=${email.type}:${email.value}`));
    }
  }

  if (vcard.adr) {
    for (const adr of vcard.adr) {
      const adrParts = [
        '', // PO box
        '', // extended address
        escapeText(adr.street),
        escapeText(adr.city),
        escapeText(adr.state),
        adr.postalCode,
        escapeText(adr.country),
      ];
      lines.push(foldLine(`ADR;TYPE=${adr.type}:${adrParts.join(';')}`));
    }
  }

  if (vcard.org) lines.push(foldLine(`ORG:${escapeText(vcard.org)}`));
  if (vcard.title) lines.push(foldLine(`TITLE:${escapeText(vcard.title)}`));
  if (vcard.note) lines.push(foldLine(`NOTE:${escapeText(vcard.note)}`));
  if (vcard.bday) lines.push(foldLine(`BDAY:${vcard.bday}`));
  if (vcard.photo) {
    if (vcard.photo.startsWith('data:') || vcard.photo.startsWith('http://') || vcard.photo.startsWith('https://')) {
      lines.push(foldLine(`PHOTO;VALUE=URI:${vcard.photo}`));
    } else {
      lines.push(foldLine(`PHOTO;ENCODING=b;TYPE=JPEG:${vcard.photo}`));
    }
  }
  if (vcard.rev) lines.push(foldLine(`REV:${vcard.rev}`));

  lines.push('END:VCARD');
  return lines.join('\r\n');
}
