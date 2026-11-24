/**
 * Lightweight vCard 3.0 (RFC 2426) parser/generator.
 * Supports common contact properties with line folding and escaping.
 */

export interface VCardName {
  family: string;
  given: string;
  /** Opaque N component text, including its vCard escaping and comma separators. */
  additional?: string;
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
  /** Opaque ADR component text, including its vCard escaping. */
  poBox?: string;
  extended?: string;
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
  /** A birthday without a year is held as `--MM-DD`; other values as read. */
  bday?: string;
  /** `bday` was declared `VALUE=text`, so it is never read as a date. Only
   *  `true` is meaningful; absence means a date. */
  bdayIsText?: boolean;
  photo?: string;
  rev?: string;
  /** SilentSuite-owned favorite flag, wire form `X-SILENTSUITE-FAVORITE:1`.
   *  `true` means favorite; absence means not favorite. Only `true` is ever
   *  emitted, so a false/absent value is represented as `undefined`. */
  favorite?: boolean;
  /** Unsupported properties kept opaque (#865): raw unfolded logical lines in
   *  their original order and spelling, never decoded. Absent when none. */
  unknownProperties?: string[];
}

/** Canonical SilentSuite favorite extension property name (uppercased). */
export const FAVORITE_PROPERTY = 'X-SILENTSUITE-FAVORITE';

/** Properties the model owns or deliberately drops; never kept opaque.
 *  PRODID names the producer, which is no longer true after a rewrite. */
const OWNED_PROPERTIES = new Set([
  'BEGIN', 'END', 'VERSION', 'UID', 'FN', 'N', 'TEL', 'EMAIL', 'ADR', 'ORG', 'TITLE',
  'CATEGORIES', 'NOTE', 'BDAY', 'PHOTO', 'REV', 'PRODID', FAVORITE_PROPERTY,
]);
/** Properties whose grouped X-ABLabel the model consumes. */
const LABELED_PROPERTIES = new Set(['TEL', 'EMAIL', 'ADR']);
/** Same bound as PHOTO. */
const MAX_RETAINED_LINE = 1_000_000;

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
  const parts: string[] = [];
  let current = '';
  let octets = 0;
  for (const character of line) {
    const size = Buffer.byteLength(character, 'utf8');
    if (octets + size > 75) {
      parts.push(current);
      current = ' '; // The continuation marker counts towards the next line's limit.
      octets = 1;
    }
    current += character;
    octets += size;
  }
  parts.push(current);
  return parts.join('\r\n');
}

/**
 * Whether a physical line is a card boundary: never an indented continuation,
 * compared case-insensitively (Unicode upper-casing) after trailing whitespace.
 * At the very start of a file one leftover U+FEFF is ignored. The importer's card
 * splitter and the QP branch of unfoldLines share this one rule.
 */
export function isVCardBoundary(line: string, atFileStart = false): 'BEGIN' | 'END' | null {
  const text = atFileStart && line.startsWith('\uFEFF') ? line.slice(1) : line;
  if (/^[ \t]/.test(text)) return null;
  const normalized = text.trimEnd().toUpperCase();
  if (normalized === 'BEGIN:VCARD') return 'BEGIN';
  if (normalized === 'END:VCARD') return 'END';
  return null;
}

/**
 * Split a multi-vCard file into complete cards. A BEGIN inside an open card, or
 * the end of the file inside one, leaves that card incomplete; an END outside a
 * card is ignored. Only cards with both boundaries are returned.
 */
export function splitVCardFile(text: string): { cards: string[]; incomplete: number } {
  const cards: string[] = [];
  let incomplete = 0;
  let current: string[] | null = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = i === 0 && raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
    const boundary = isVCardBoundary(line);
    if (boundary === 'BEGIN') {
      if (current) incomplete++;
      current = [line];
    } else if (boundary === 'END') {
      if (!current) continue;
      current.push(line);
      cards.push(current.join('\r\n'));
      current = null;
    } else if (current) {
      current.push(line);
    }
  }
  if (current) incomplete++;
  return { cards, incomplete };
}

/** One logical line under construction. Segments are joined once, so the work
 * stays linear in the input however many folds a property has. */
class LogicalLine {
  private readonly segments: string[] = [];
  private header = '';
  private inQuotes = false;
  private colonFound = false;
  private headerQp: boolean | null = null;

  append(text: string): void {
    if (text === '') return;
    this.segments.push(text);
    if (this.colonFound) return;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') {
        this.inQuotes = !this.inQuotes;
      } else if (ch === ':' && !this.inQuotes) {
        this.header += text.slice(0, i);
        this.colonFound = true;
        this.headerQp = null;
        return;
      }
    }
    this.header += text;
    this.headerQp = null;
  }

  get isEmpty(): boolean {
    return this.segments.length === 0;
  }

  endsWith(ch: string): boolean {
    const last = this.segments[this.segments.length - 1];
    return last !== undefined && last.endsWith(ch);
  }

  /** Drop the final character (a QP soft-break '='). */
  dropLast(): void {
    const index = this.segments.length - 1;
    const last = this.segments[index]!;
    if (last.length === 1) this.segments.pop();
    else this.segments[index] = last.slice(0, -1);
    if (!this.colonFound) {
      this.header = this.header.slice(0, -1);
      this.headerQp = null;
    }
  }

  /** Same answer as parseProperty(joined line) for the ENCODING parameter. */
  isQuotedPrintable(): boolean {
    if (this.headerQp === null) {
      const params = parseProperty(this.colonFound ? `${this.header}:` : this.header).params;
      this.headerQp = params['ENCODING']?.toUpperCase() === 'QUOTED-PRINTABLE';
    }
    return this.headerQp;
  }

  toString(): string {
    return this.segments.join('');
  }
}

/** Exported for tests. */
export function unfoldLines(text: string): string {
  const lines: LogicalLine[] = [];
  for (const physical of text.split(/\r?\n/)) {
    const previous = lines[lines.length - 1];
    const folded = /^[ \t]/.test(physical);
    if (previous && !previous.isEmpty && previous.endsWith('=') && previous.isQuotedPrintable()) {
      // QP continuation precedes vCard unfolding: whitespace and colons are
      // payload. Only file framing is reserved; leave a dangling '=' intact
      // for strict decoding to reject (or tolerant hydration to preserve).
      if (isVCardBoundary(physical)) {
        const line = new LogicalLine();
        line.append(physical);
        lines.push(line);
      } else {
        previous.dropLast();
        previous.append(physical);
      }
    } else if (folded && previous && !previous.isEmpty) {
      previous.append(physical.slice(1));
    } else {
      const line = new LogicalLine();
      line.append(physical);
      lines.push(line);
    }
  }
  return lines.map((line) => line.toString()).join('\n');
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

/** Type segments are comma-joined. Exporters mark custom (non-standard) types
 *  with a single leading `X-`; strip exactly one per segment and keep the
 *  remainder's original spelling. Standard segments stay lowercased. */
function stripCustomTypePrefix(segment: string): string {
  if (!/^x-/i.test(segment)) return segment.toLowerCase();
  const remainder = segment.slice(2);
  return remainder === '' ? segment.toLowerCase() : remainder;
}

function getTypeParam(params: Record<string, string>): string {
  return (params['TYPE'] ?? 'other').split(',').map(stripCustomTypePrefix).join(',');
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

/** Whether a raw logical line may be kept opaque. Fails closed on anything that
 *  could alter card framing, owned fields or folding on re-parse. */
function isRetainable(line: string, prop: ParsedProperty, consumedLabelGroups: Set<string>): boolean {
  if (line.length > MAX_RETAINED_LINE) return false;
  // TAB is the only control character allowed; a lone CR could split the line elsewhere.
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(line)) return false;
  if (OWNED_PROPERTIES.has(prop.name)) return false;
  if (prop.name === 'X-ABLABEL' && prop.group && consumedLabelGroups.has(prop.group)) return false;
  const colonIdx = findPropertyColon(line);
  if (colonIdx === line.length) return false;
  const left = line.slice(0, colonIdx);
  if ((left.match(/"/g) ?? []).length % 2 !== 0) return false;
  const semiIdx = left.indexOf(';');
  const rawName = semiIdx === -1 ? left : left.slice(0, semiIdx);
  if (!/^(?:[A-Za-z0-9-]+\.)?[A-Za-z0-9-]+$/.test(rawName)) return false;
  // Duplicate or list encodings are ambiguous and would defeat the QP fold rule.
  const encodings = semiIdx === -1
    ? []
    : splitParams(left.slice(semiIdx + 1)).filter((part) => part.slice(0, part.indexOf('=')).toUpperCase() === 'ENCODING');
  if (encodings.length > 1) return false;
  if (encodings.length === 1 && (prop.params['ENCODING'] ?? '').includes(',')) return false;
  return true;
}

/** Fold a kept line at code-point boundaries. The ordinary foldLine stays in use
 *  for owned fields so their wire bytes are unchanged. QP lines, folds whose
 *  continuation a line-trimming importer would read as a card boundary, and
 *  lines that cannot be cut outside a run of '=', are emitted unfolded. */
function foldRetainedLine(line: string): string {
  if (parseProperty(line).params['ENCODING']?.toUpperCase() === 'QUOTED-PRINTABLE') return line;
  const chars = Array.from(line);
  const parts: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < chars.length) {
    let end = start;
    let bytes = 0;
    while (end < chars.length) {
      const charBytes = Buffer.byteLength(chars[end]!, 'utf8');
      if (end > start && bytes + charBytes > limit) break;
      bytes += charBytes;
      end++;
    }
    if (end < chars.length) {
      // Never end a segment with '=': unfoldLines would re-parse the growing
      // prefix as a possible QP continuation at every fold (quadratic work).
      // A run of '=' too long to cut around leaves the line unfolded.
      let cut = end;
      while (cut > start && chars[cut - 1] === '=') cut--;
      if (cut === start) return line;
      end = cut;
    }
    parts.push(chars.slice(start, end).join(''));
    start = end;
    limit = 74;
  }
  // Stricter than isVCardBoundary (trim + toUpperCase), so even an importer that
  // trims continuation lines never reads one as a card boundary, and Unicode
  // case mappings such as dotless ı → I are covered exactly.
  if (parts.slice(1).some((part) => {
    const normalized = part.trim().toUpperCase();
    return normalized === 'BEGIN:VCARD' || normalized === 'END:VCARD';
  })) return line;
  // Kept lines hold no CR/LF and no segment but the last ends with '=', so
  // unfoldLines restores this fold exactly without its QP branch.
  return parts.join('\r\n ');
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

/** Opaque components may not escape into an adjacent component or content line. */
function retainedStructuredComponent(value = ''): string {
  if (/[\r\n]/.test(value) || splitStructuredValue(value).length !== 1 || (value.match(/\\+$/)?.[0].length ?? 0) % 2 !== 0) {
    throw new Error('Invalid retained vCard component');
  }
  return value;
}

// ── Birthdays ──

/** Year written with X-APPLE-OMIT-YEAR for a birthday without a year, as
 *  vcard4android does for vCard 3. A leap year, so --02-29 survives. */
const OMIT_YEAR_PARAM = 'X-APPLE-OMIT-YEAR';
const OMIT_YEAR_SENTINEL = '1604';

/** `--MM-DD` when month and day exist in a leap year; null otherwise. */
function monthDay(month: string, day: string): string | null {
  const days = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][Number(month) - 1];
  const date = Number(day);
  return days !== undefined && date >= 1 && date <= days ? `--${month}-${day}` : null;
}

/** A year-less `--MMDD` or `--MM-DD` as `--MM-DD`; null for anything else. */
function yearlessDate(value: string): string | null {
  const match = /^--(\d{2})-?(\d{2})$/.exec(value);
  return match ? monthDay(match[1]!, match[2]!) : null;
}

function isTextValue(params: Record<string, string>): boolean {
  return (params['VALUE'] ?? '').split(',').some((type) => type.trim().toLowerCase() === 'text');
}

/** A date BDAY as the model holds it: year-less, or dated in the year its
 *  omit-year marker names, becomes `--MM-DD`. Anything else is kept as read. */
function birthdayValue(value: string, params: Record<string, string>): string {
  const yearless = yearlessDate(value);
  if (yearless) return yearless;
  const omitYear = params[OMIT_YEAR_PARAM] ?? '';
  const dated = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(value);
  if (dated && /^\d{4}$/.test(omitYear) && dated[1] === omitYear) return monthDay(dated[2]!, dated[3]!) ?? value;
  return value;
}

/** vCard 3.0 has no year-less date, so one is written with the marked sentinel
 *  year; text keeps its type; every other value is written as before. */
function birthdayLine(bday: string, isText: boolean): string {
  if (isText) return `BDAY;VALUE=text:${bday}`;
  const yearless = yearlessDate(bday);
  if (yearless) return `BDAY;${OMIT_YEAR_PARAM}=${OMIT_YEAR_SENTINEL}:${OMIT_YEAR_SENTINEL}${yearless.slice(1)}`;
  return `BDAY:${bday}`;
}

// ── Parser ──

/**
 * Parse a vCard 3.0 string into a VCard object.
 */
export function parseVCard(vcardStr: string, options: { strictTextEncoding?: boolean; keepMissingUid?: boolean } = {}): VCard {
  const strict = options.strictTextEncoding === true;
  const unfolded = unfoldLines(vcardStr);
  const lines = unfolded.split(/\r?\n/).filter((l) => l.length > 0);

  const vcard: VCard = { uid: '', fn: '' };
  const tels: VCardPhone[] = [];
  const emails: VCardEmail[] = [];
  const adrs: VCardAddress[] = [];
  const labels = new Map<string, string>();
  const retained: string[] = [];
  // Only labels of modelled TEL/EMAIL/ADR groups are decoded; others stay opaque.
  const consumedLabelGroups = new Set<string>();
  for (const line of lines) {
    const prop = parseProperty(line);
    if (prop.group && LABELED_PROPERTIES.has(prop.name)) consumedLabelGroups.add(prop.group);
  }
  for (const line of lines) {
    const prop = parseProperty(line);
    if (prop.group && prop.name === 'X-ABLABEL' && consumedLabelGroups.has(prop.group)) {
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
    // Hidden components retain their source spelling. Legacy transfer encoding must first
    // become ordinary escaped TEXT; split lists before decoding encoded commas.
    const component = (value: string) => {
      const retained = prop.params['ENCODING']?.toUpperCase() === 'QUOTED-PRINTABLE'
        ? splitCommaValues(value).map(part => escapeText(text(part))).join(',') : value;
      // Incomplete legacy fields may end in a lone backslash. Keep it as literal text
      // rather than letting it escape the next component separator on write.
      return (retained.match(/\\+$/)?.[0].length ?? 0) % 2 !== 0 ? `${retained}\\` : retained;
    };
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
          ...(parts[2] ? { additional: component(parts[2]) } : {}),
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
          ...(adrParts[0] ? { poBox: component(adrParts[0]) } : {}),
          ...(adrParts[1] ? { extended: component(adrParts[1]) } : {}),
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
      case 'CATEGORIES': {
        // CATEGORIES may repeat (RFC 6350 cardinality *): merge every property,
        // de-duplicating case-insensitively and keeping first-seen order/casing
        // (same policy as the web label editor).
        const merged = vcard.categories ?? [];
        const seen = new Set(merged.map((c) => c.toLowerCase()));
        for (const raw of splitCommaValues(prop.value)) {
          const label = text(raw).trim();
          const key = label.toLowerCase();
          if (!label || seen.has(key)) continue;
          seen.add(key);
          merged.push(label);
        }
        vcard.categories = merged;
        break;
      }
      case 'NOTE':
        vcard.note = text();
        break;
      case 'BDAY':
        if (isTextValue(prop.params)) {
          vcard.bday = prop.value;
          vcard.bdayIsText = true;
        } else {
          vcard.bday = birthdayValue(prop.value, prop.params);
          delete vcard.bdayIsText;
        }
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
      default:
        if (isRetainable(line, prop, consumedLabelGroups)) retained.push(line);
    }
  }

  if (retained.length > 0) vcard.unknownProperties = retained;
  if (tels.length > 0) vcard.tel = tels;
  if (emails.length > 0) vcard.email = emails;
  if (adrs.length > 0) vcard.adr = adrs;

  // Input validation
  // keepMissingUid leaves a missing or empty UID empty so the caller can tell.
  if (!vcard.uid && options.keepMissingUid !== true) {
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
  const retained = (vcard.unknownProperties ?? []).filter((line) => isRetainable(line, parseProperty(line), new Set()));
  // Generated label groups never reuse a group held by a kept line.
  const reservedGroups = new Set(retained.map((line) => parseProperty(line).group).filter(Boolean));
  // Free-form labels are TEXT, not parameter tokens: preserve spelling safely.
  const typedProperty = (name: string, type: string, value: string) => {
    // A leading `X-` marks an exporter-added custom type, so such a value must
    // travel as a literal grouped label: emitting it as a TYPE token would let
    // the parser strip one prefix per export/import cycle.
    const typeToken = /^[a-z0-9-]+(?:,[a-z0-9-]+)*$/.test(type) && !/(?:^|,)x-/i.test(type);
    if (typeToken) {
      lines.push(foldLine(`${name};TYPE=${type}:${value}`));
    } else {
      let group = `item${++labelIndex}`;
      while (reservedGroups.has(group.toUpperCase())) group = `item${++labelIndex}`;
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
      retainedStructuredComponent(vcard.n.additional),
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
        retainedStructuredComponent(adr.poBox),
        retainedStructuredComponent(adr.extended),
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
  if (vcard.bday) {
    const bdayLine = birthdayLine(vcard.bday, vcard.bdayIsText === true);
    // A text birthday is free text behind a longer header, so it folds like a kept
    // line: never into a continuation the importer would read as a card boundary.
    lines.push(vcard.bdayIsText === true ? foldRetainedLine(bdayLine) : foldLine(bdayLine));
  }
  if (vcard.photo) {
    // vCard 3.0 has no data: URIs, and Android reads PHOTO;VALUE=URI as a link to
    // download (#1127), so embedded images are written inline. Only image types the
    // parser maps back are inlined, so the round trip stays exact.
    const inline = /^data:image\/(jpeg|jpg|png|gif|webp);base64,([A-Za-z0-9+/]+=*)$/i.exec(vcard.photo);
    if (inline) {
      const type = inline[1]!.toUpperCase() === 'JPG' ? 'JPEG' : inline[1]!.toUpperCase();
      lines.push(foldLine(`PHOTO;ENCODING=b;TYPE=${type}:${inline[2]}`));
    } else if (vcard.photo.startsWith('data:') || vcard.photo.startsWith('http://') || vcard.photo.startsWith('https://')) {
      lines.push(foldLine(`PHOTO;VALUE=URI:${vcard.photo}`));
    } else {
      lines.push(foldLine(`PHOTO;ENCODING=b;TYPE=JPEG:${vcard.photo}`));
    }
  }
  if (vcard.rev) lines.push(foldLine(`REV:${vcard.rev}`));
  for (const line of retained) lines.push(foldRetainedLine(line));

  lines.push('END:VCARD');
  return lines.join('\r\n');
}
