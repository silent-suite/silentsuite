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
  /** CATEGORIES (RFC 2426/6350) — comma-separated user labels */
  categories?: string[];
  note?: string;
  bday?: string;
  photo?: string;
  rev?: string;
  /** SilentSuite-owned favorite flag, wire form `X-SILENTSUITE-FAVORITE:1`.
   *  `true` means favorite; absence means not favorite. Only `true` is ever
   *  emitted, so a false/absent value is represented as `undefined`. */
  favorite?: boolean;
}

/** Canonical SilentSuite favorite extension property name (uppercased). */
export const FAVORITE_PROPERTY = 'X-SILENTSUITE-FAVORITE';

// ── Escaping ──

function escapeText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    // TEXT has one newline escape; canonicalize CRLF and lone CR to LF.
    .replace(/\r\n|\r|\n/g, '\\n');
}

function unescapeText(text: string): string {
  return text.replace(/\\([nN,;\\])/g, (_, ch: string) => /n/i.test(ch) ? '\n' : ch);
}

/** Split raw list values before decoding so encoded commas remain text. */
function splitCommaValues(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let escaped = false;
  for (const ch of value) {
    if (ch === ',' && !escaped) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
    escaped = ch === '\\' && !escaped;
  }
  parts.push(current);
  return parts;
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
  const lines: string[] = [];
  for (const physical of text.split(/\r?\n/)) {
    const previous = lines[lines.length - 1];
    const folded = /^[ \t]/.test(physical);
    const next = folded ? physical.slice(1) : physical;
    if (previous && previous.endsWith('=') && parseProperty(previous).params['ENCODING']?.toUpperCase() === 'QUOTED-PRINTABLE') {
      // QP continuation precedes vCard unfolding: whitespace and colons are
      // payload. Only file framing is reserved; leave a dangling '=' intact
      // for strict decoding to reject (or tolerant hydration to preserve).
      if (/^(?:BEGIN|END):VCARD$/i.test(physical.trim())) {
        lines.push(physical);
      } else {
        lines[lines.length - 1] = previous.slice(0, -1) + physical;
      }
    } else if (folded && previous) {
      lines[lines.length - 1] = previous + next;
    } else {
      lines.push(physical);
    }
  }
  return lines.join('\n');
}

/** Decode only declared text encodings. Fail closed rather than replacing bytes
 * or importing a partially decoded contact. Errors never include contact data. */
function decodeText(value: string, params: Record<string, string>): string {
  const encoding = params['ENCODING']?.toUpperCase();
  if (!encoding || encoding === '8BIT' || encoding === '7BIT') return unescapeText(value);
  if (encoding !== 'QUOTED-PRINTABLE') throw new Error('Unsupported vCard text encoding');
  try {
    const bytes: number[] = [];
    for (let i = 0; i < value.length; i++) {
      if (value[i] === '=') {
        const hex = value.slice(i + 1, i + 3);
        if (!/^[0-9a-f]{2}$/i.test(hex)) throw new Error();
        bytes.push(parseInt(hex, 16));
        i += 2;
      } else {
        const byte = value.charCodeAt(i);
        if (byte > 127) throw new Error();
        bytes.push(byte);
      }
    }
    return unescapeText(new TextDecoder(params['CHARSET'] || 'utf-8', { fatal: true }).decode(new Uint8Array(bytes)));
  } catch {
    throw new Error('Invalid or unsupported vCard text encoding');
  }
}

// ── Parsing helpers ──

interface ParsedProperty {
  name: string;
  group: string;
  params: Record<string, string>;
  value: string;
}

/** Stored/cache contacts must remain available even with legacy malformed
 * encodings. Preserve the raw logical property without partial decoding or
 * unescaping on failure. Uploads explicitly opt into strict rejection. */
function propertyText(prop: ParsedProperty, value: string, strict: boolean): string {
  try {
    // Validate the whole property before decoding a structured component.
    const decoded = decodeText(prop.value, prop.params);
    return value === prop.value ? decoded : decodeText(value, prop.params);
  } catch (error) {
    if (strict) throw error;
    return value;
  }
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
  const rawName = semiIdx === -1 ? left : left.slice(0, semiIdx);
  const name = rawName.slice(rawName.lastIndexOf('.') + 1).toUpperCase();
  const group = rawName.includes('.') ? rawName.slice(0, rawName.lastIndexOf('.')).toUpperCase() : '';
  const params: Record<string, string> = {};

  if (semiIdx !== -1) {
    const paramStr = left.slice(semiIdx + 1);
    for (const part of splitParams(paramStr)) {
      const eqIdx = part.indexOf('=');
      if (eqIdx !== -1) {
        const key = part.slice(0, eqIdx).toUpperCase();
        const paramValue = part.slice(eqIdx + 1).replace(/^"(.*)"$/, '$1');
        params[key] = params[key] ? `${params[key]},${paramValue}` : paramValue;
      } else {
        params['TYPE'] = params['TYPE'] ? `${params['TYPE']},${part}` : part;
      }
    }
  }

  return { name, group, params, value };
}

function getTypeParam(params: Record<string, string>): string {
  return (params['TYPE'] ?? 'other').toLowerCase();
}

function normalizeTelephoneValue(value: string): string {
  if (!value.toLowerCase().startsWith('tel:')) return value;
  const rawValue = value.slice(4);
  try {
    return decodeURIComponent(rawValue);
  } catch {
    return rawValue;
  }
}

function splitStructuredValue(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let escaped = false;

  for (const ch of value) {
    if (ch === ';' && !escaped) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }

    escaped = ch === '\\' && !escaped;
  }

  parts.push(current);
  return parts;
}

// ── Parser ──

/**
 * Parse a vCard 3.0 string into a VCard object.
 */
export function parseVCard(vcardStr: string, options: { strictTextEncoding?: boolean } = {}): VCard {
  const strict = options.strictTextEncoding === true;
  const unfolded = unfoldLines(vcardStr);
  const lines = unfolded.split(/\r?\n/).filter((l) => l.length > 0);

  const vcard: VCard = { uid: '', fn: '' };
  const tels: VCardPhone[] = [];
  const emails: VCardEmail[] = [];
  const adrs: VCardAddress[] = [];
  const labels = new Map<string, string>();
  for (const line of lines) {
    const prop = parseProperty(line);
    if (prop.group && prop.name === 'X-ABLABEL') {
      const label = propertyText(prop, prop.value, strict);
      const wrapped = /^_\$!<(.*)>!\$_$/.exec(label);
      const unwrapped = wrapped ? wrapped[1]! : label;
      labels.set(prop.group, wrapped && /^(home|work|other|mobile|main|pager|fax)$/i.test(unwrapped) ? unwrapped.toLowerCase() : unwrapped);
    }
  }

  for (const line of lines) {
    if (line === 'BEGIN:VCARD' || line === 'END:VCARD') continue;
    if (line.startsWith('VERSION:')) continue;

    const prop = parseProperty(line);
    const text = (value = prop.value) => propertyText(prop, value, strict);
    switch (prop.name) {
      // Labels are resolved before this pass so group ordering is irrelevant.
      case 'UID':
        vcard.uid = prop.value;
        break;
      case 'FN':
        vcard.fn = text();
        break;
      case 'N': {
        const parts = splitStructuredValue(prop.value);
        vcard.n = {
          family: text(parts[0] ?? ''),
          given: text(parts[1] ?? ''),
          prefix: parts[3] ? text(parts[3]) : undefined,
          suffix: parts[4] ? text(parts[4]) : undefined,
        };
        break;
      }
      case 'TEL':
        tels.push({ type: labels.get(prop.group) || getTypeParam(prop.params), value: normalizeTelephoneValue(text()) });
        break;
      case 'EMAIL':
        emails.push({ type: labels.get(prop.group) || getTypeParam(prop.params), value: text() });
        break;
      case 'ADR': {
        const adrParts = splitStructuredValue(prop.value);
        adrs.push({
          type: labels.get(prop.group) || getTypeParam(prop.params),
          street: text(adrParts[2] ?? ''),
          city: text(adrParts[3] ?? ''),
          state: text(adrParts[4] ?? ''),
          postalCode: text(adrParts[5] ?? ''),
          country: text(adrParts[6] ?? ''),
        });
        break;
      }
      case 'ORG':
        vcard.org = text();
        break;
      case 'TITLE':
        vcard.title = text();
        break;
      case 'CATEGORIES':
        vcard.categories = splitCommaValues(prop.value).map((c) => text(c).trim()).filter((c) => c.length > 0);
        break;
      case 'NOTE':
        vcard.note = text();
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
      case FAVORITE_PROPERTY:
        // Canonical favorite is exactly `1`. Do not trim or unescape the
        // scalar; group prefix and parameters are already normalized away by
        // parseProperty(). Duplicates reduce with "any exact `1` wins", so we
        // only ever set true and never clear it here.
        if (prop.value === '1') {
          vcard.favorite = true;
        }
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
  let labelIndex = 0;
  // Free-form labels are TEXT, not parameter tokens: preserve spelling safely.
  const typedProperty = (name: string, type: string, value: string) => {
    if (/^[a-z0-9-]+(?:,[a-z0-9-]+)*$/.test(type)) {
      lines.push(foldLine(`${name};TYPE=${type}:${value}`));
    } else {
      const group = `item${++labelIndex}`;
      lines.push(foldLine(`${group}.${name}:${value}`));
      lines.push(foldLine(`${group}.X-ABLabel:${escapeText(type)}`));
    }
  };
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
      typedProperty('TEL', tel.type, escapeText(tel.value));
    }
  }

  if (vcard.email) {
    for (const email of vcard.email) {
      typedProperty('EMAIL', email.type, escapeText(email.value));
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
        escapeText(adr.postalCode),
        escapeText(adr.country),
      ];
      typedProperty('ADR', adr.type, adrParts.join(';'));
    }
  }

  if (vcard.org) lines.push(foldLine(`ORG:${escapeText(vcard.org)}`));
  if (vcard.title) lines.push(foldLine(`TITLE:${escapeText(vcard.title)}`));
  if (vcard.categories && vcard.categories.length > 0) {
    lines.push(foldLine(`CATEGORIES:${vcard.categories.map(escapeText).join(',')}`));
  }
  if (vcard.note) lines.push(foldLine(`NOTE:${escapeText(vcard.note)}`));
  // Emit exactly one ungrouped, parameterless canonical favorite property, and
  // only when true. False/absent favorite produces no line at all.
  if (vcard.favorite === true) {
    lines.push(`${FAVORITE_PROPERTY}:1`);
  }
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
