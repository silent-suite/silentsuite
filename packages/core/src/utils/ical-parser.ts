/**
 * Lightweight iCalendar (RFC 5545) parser/generator.
 * Supports VEVENT components with common properties.
 */

export interface VEvent {
  uid: string;
  dtstart: string;
  dtend?: string;
  duration?: string;
  summary?: string;
  description?: string;
  location?: string;
  rrule?: string;
  exdate?: string[];
  /** EXDATE parameters (e.g., TZID) — keyed by index in the exdate array */
  exdateParams?: Record<string, string>;
  created?: string;
  lastModified?: string;
  transp?: string;
  status?: string;
  valarms?: VAlarm[];
  /** CATEGORIES (RFC 5545) — comma-separated user labels */
  categories?: string[];
  /** Raw DTSTART parameters like TZID or VALUE */
  dtstartParams?: Record<string, string>;
  /** Raw DTEND parameters */
  dtendParams?: Record<string, string>;
}

export interface VTodo {
  uid: string;
  summary?: string;
  description?: string;
  dtstart?: string;
  dtstartParams?: Record<string, string>;
  due?: string;
  dueParams?: Record<string, string>;
  priority?: number;
  status?: string;
  completed?: string;
  created?: string;
  lastModified?: string;
  percentComplete?: number;
  location?: string;
  url?: string;
  /** CATEGORIES (RFC 5545) — comma-separated user labels */
  categories?: string[];
  /** Unsupported VTODO property lines (logical, unfolded), kept for round trip.
   *  Absent when there are none. Revalidated when generating. */
  unknownProperties?: string[];
  /** Unsupported VTODO subcomponents such as VALARM: one array of logical
   *  lines per complete BEGIN..END block. Absent when there are none. */
  unknownComponents?: string[][];
}

export interface VAlarm {
  action: string;
  trigger: string;
  description?: string;
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

/** Split a multi-valued iCalendar text property on unescaped commas, then
 *  unescape each value. Used for CATEGORIES and similar list properties. */
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
  return parts.map((p) => unescapeText(p));
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
    // For continuation lines, we prepend a space which takes 1 octet
    const limit = isFirst ? MAX_OCTETS : MAX_OCTETS - 1;
    let cutPoint = 0;
    let byteCount = 0;
    for (let i = 0; i < remaining.length; i++) {
      const charBytes = Buffer.byteLength(remaining[i]!, 'utf8');
      if (byteCount + charBytes > limit) break;
      byteCount += charBytes;
      cutPoint = i + 1;
    }
    if (cutPoint === 0) cutPoint = 1; // at least one char
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
  // Unfold: CRLF followed by a single space or tab
  return text.replace(/\r?\n[ \t]/g, '');
}

// ── Parsing ──

interface ParsedProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

function parseProperty(line: string): ParsedProperty {
  // property format: NAME;PARAM=VALUE;...:value
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

function findPropertyColon(line: string): number {
  // Find the colon that separates property name+params from value.
  // Must not be inside a quoted param value.
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

function parseVAlarm(lines: string[], startIdx: number): { alarm: VAlarm; endIdx: number } {
  const alarm: VAlarm = { action: '', trigger: '' };
  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === 'END:VALARM') {
      return { alarm, endIdx: i };
    }
    const prop = parseProperty(line);
    switch (prop.name) {
      case 'ACTION':
        alarm.action = prop.value;
        break;
      case 'TRIGGER':
        alarm.trigger = prop.value;
        break;
      case 'DESCRIPTION':
        alarm.description = unescapeText(prop.value);
        break;
    }
    i++;
  }
  return { alarm, endIdx: i };
}

/**
 * Parse a VEVENT block (content lines between BEGIN:VEVENT and END:VEVENT).
 * Also accepts a full VCALENDAR document — the first VEVENT inside will be extracted.
 */
export function parseVEvent(ical: string): VEvent {
  const trimmed = ical.trimStart();
  if (trimmed.startsWith('BEGIN:VCALENDAR')) {
    // Extract the first VEVENT block from the VCALENDAR wrapper
    const match = trimmed.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/);
    if (!match) {
      throw new Error('VCALENDAR contains no VEVENT component');
    }
    ical = match[0];
  }

  const unfolded = unfoldLines(ical);
  const lines = unfolded.split(/\r?\n/).filter((l) => l.length > 0);

  const event: VEvent = { uid: '', dtstart: '' };
  const valarms: VAlarm[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    if (line === 'BEGIN:VALARM') {
      i++;
      const { alarm, endIdx } = parseVAlarm(lines, i);
      valarms.push(alarm);
      i = endIdx + 1;
      continue;
    }

    if (line === 'BEGIN:VEVENT' || line === 'END:VEVENT') {
      i++;
      continue;
    }

    const prop = parseProperty(line);
    switch (prop.name) {
      case 'UID':
        event.uid = prop.value;
        break;
      case 'DTSTART':
        event.dtstart = prop.value;
        if (Object.keys(prop.params).length > 0) {
          event.dtstartParams = prop.params;
        }
        break;
      case 'DTEND':
        event.dtend = prop.value;
        if (Object.keys(prop.params).length > 0) {
          event.dtendParams = prop.params;
        }
        break;
      case 'DURATION':
        event.duration = prop.value;
        break;
      case 'SUMMARY':
        event.summary = unescapeText(prop.value);
        break;
      case 'DESCRIPTION':
        event.description = unescapeText(prop.value);
        break;
      case 'LOCATION':
        event.location = unescapeText(prop.value);
        break;
      case 'RRULE':
        event.rrule = prop.value;
        break;
      case 'EXDATE': {
        if (!event.exdate) event.exdate = [];
        // Preserve TZID parameter for EXDATE roundtripping
        if (prop.params['TZID'] && !event.exdateParams) {
          event.exdateParams = { TZID: prop.params['TZID'] };
        }
        // EXDATE can have multiple comma-separated values
        const dates = prop.value.split(',').map((d) => d.trim());
        event.exdate.push(...dates);
        break;
      }
      case 'CREATED':
        event.created = prop.value;
        break;
      case 'LAST-MODIFIED':
        event.lastModified = prop.value;
        break;
      case 'TRANSP':
        event.transp = prop.value;
        break;
      case 'STATUS':
        event.status = prop.value;
        break;
      case 'CATEGORIES':
        event.categories = splitCommaValues(prop.value).map((c) => c.trim()).filter((c) => c.length > 0);
        break;
    }
    i++;
  }

  if (valarms.length > 0) {
    event.valarms = valarms;
  }

  // Input validation
  if (!event.uid) {
    event.uid = crypto.randomUUID();
  }
  if (!event.dtstart) {
    throw new Error('VEVENT missing required DTSTART property');
  }
  if (!event.summary) {
    event.summary = 'Untitled';
  }

  return event;
}

/**
 * Generate an iCalendar VEVENT string from properties.
 */
export function generateVEvent(event: VEvent): string {
  const lines: string[] = [];
  lines.push('BEGIN:VEVENT');

  lines.push(foldLine(`UID:${event.uid}`));

  // DTSTART
  if (event.dtstartParams && Object.keys(event.dtstartParams).length > 0) {
    const paramStr = Object.entries(event.dtstartParams)
      .map(([k, v]) => `${k}=${v}`)
      .join(';');
    lines.push(foldLine(`DTSTART;${paramStr}:${event.dtstart}`));
  } else {
    lines.push(foldLine(`DTSTART:${event.dtstart}`));
  }

  // DTEND
  if (event.dtend) {
    if (event.dtendParams && Object.keys(event.dtendParams).length > 0) {
      const paramStr = Object.entries(event.dtendParams)
        .map(([k, v]) => `${k}=${v}`)
        .join(';');
      lines.push(foldLine(`DTEND;${paramStr}:${event.dtend}`));
    } else {
      lines.push(foldLine(`DTEND:${event.dtend}`));
    }
  }

  if (event.duration) lines.push(foldLine(`DURATION:${event.duration}`));
  if (event.summary) lines.push(foldLine(`SUMMARY:${escapeText(event.summary)}`));
  if (event.description) lines.push(foldLine(`DESCRIPTION:${escapeText(event.description)}`));
  if (event.location) lines.push(foldLine(`LOCATION:${escapeText(event.location)}`));
  if (event.rrule) lines.push(foldLine(`RRULE:${event.rrule}`));

  if (event.exdate && event.exdate.length > 0) {
    if (event.exdateParams?.TZID) {
      lines.push(foldLine(`EXDATE;TZID=${event.exdateParams.TZID}:${event.exdate.join(',')}`));
    } else {
      lines.push(foldLine(`EXDATE:${event.exdate.join(',')}`));
    }
  }

  if (event.created) lines.push(foldLine(`CREATED:${event.created}`));
  if (event.lastModified) lines.push(foldLine(`LAST-MODIFIED:${event.lastModified}`));
  if (event.transp) lines.push(foldLine(`TRANSP:${event.transp}`));
  if (event.status) lines.push(foldLine(`STATUS:${event.status}`));
  if (event.categories && event.categories.length > 0) {
    lines.push(foldLine(`CATEGORIES:${event.categories.map(escapeText).join(',')}`));
  }

  if (event.valarms) {
    for (const alarm of event.valarms) {
      lines.push('BEGIN:VALARM');
      lines.push(foldLine(`ACTION:${alarm.action}`));
      lines.push(foldLine(`TRIGGER:${alarm.trigger}`));
      if (alarm.description) lines.push(foldLine(`DESCRIPTION:${escapeText(alarm.description)}`));
      lines.push('END:VALARM');
    }
  }

  lines.push('END:VEVENT');
  return lines.join('\r\n');
}

/**
 * Parse a VTODO block (content lines between BEGIN:VTODO and END:VTODO).
 * Also accepts a full VCALENDAR document — the first VTODO inside will be extracted.
 */
export function parseVTodo(ical: string): VTodo {
  const trimmed = ical.trimStart();
  let lines: string[];
  if (trimmed.startsWith('BEGIN:VCALENDAR')) {
    // Extract the first VTODO by whole logical lines after unfolding, so a
    // marker-like substring inside a value cannot end the component early.
    const all = unfoldLines(trimmed).split(/\r?\n/);
    const start = all.findIndex((l) => /^BEGIN:VTODO\s*$/i.test(l));
    const end = start === -1 ? -1 : all.findIndex((l, i) => i > start && /^END:VTODO\s*$/i.test(l));
    if (end === -1) {
      throw new Error('VCALENDAR contains no VTODO component');
    }
    lines = all.slice(start, end + 1).filter((l) => l.length > 0);
  } else {
    lines = unfoldLines(ical).split(/\r?\n/).filter((l) => l.length > 0);
  }

  const todo: VTodo = { uid: '' };
  const unknownProperties: string[] = [];
  const unknownComponents: string[][] = [];

  // Lines inside a nested component (VALARM or any other) belong to that
  // component, not to the VTODO, so they are never read as task fields.
  // `depth` counts open nested blocks; an unclosed block hides the rest of
  // the VTODO. Each complete top-level block is kept whole if it is valid.
  let depth = 0;
  let block: string[] = [];
  for (const line of lines) {
    const marker = /^(BEGIN|END):/i.exec(line)?.[1]?.toUpperCase();
    if (depth > 0) {
      block.push(line);
      if (marker === 'BEGIN') depth++;
      else if (marker === 'END') depth--;
      if (depth === 0 && isRetainableTodoComponent(block)) unknownComponents.push(block);
      continue;
    }
    if (/^(BEGIN|END):VTODO\s*$/i.test(line)) continue;
    if (marker === 'BEGIN') {
      depth++;
      block = [line];
      continue;
    }

    const prop = parseProperty(line);
    switch (prop.name) {
      case 'UID':
        todo.uid = prop.value;
        break;
      case 'SUMMARY':
        todo.summary = unescapeText(prop.value);
        break;
      case 'DESCRIPTION':
        todo.description = unescapeText(prop.value);
        break;
      case 'DTSTART':
        todo.dtstart = prop.value;
        if (Object.keys(prop.params).length > 0) {
          todo.dtstartParams = prop.params;
        }
        break;
      case 'DUE':
        todo.due = prop.value;
        if (Object.keys(prop.params).length > 0) {
          todo.dueParams = prop.params;
        }
        break;
      case 'PRIORITY':
        todo.priority = parseInt(prop.value, 10);
        break;
      case 'STATUS':
        todo.status = prop.value;
        break;
      case 'COMPLETED':
        todo.completed = prop.value;
        break;
      case 'CREATED':
        todo.created = prop.value;
        break;
      case 'LAST-MODIFIED':
        todo.lastModified = prop.value;
        break;
      case 'PERCENT-COMPLETE':
        todo.percentComplete = parseInt(prop.value, 10);
        break;
      case 'LOCATION':
        todo.location = unescapeText(prop.value);
        break;
      case 'URL':
        todo.url = prop.value;
        break;
      case 'CATEGORIES':
        todo.categories = splitCommaValues(prop.value).map((c) => c.trim()).filter((c) => c.length > 0);
        break;
      default:
        if (isRetainableTodoProperty(line, false)) unknownProperties.push(line);
    }
  }

  if (unknownProperties.length > 0) todo.unknownProperties = unknownProperties;
  if (unknownComponents.length > 0) todo.unknownComponents = unknownComponents;

  // Input validation
  if (!todo.uid) {
    todo.uid = crypto.randomUUID();
  }
  if (!todo.summary) {
    todo.summary = 'Untitled';
  }

  return todo;
}

// ── Retained VTODO content (WEBX-03) ──
// Unsupported VTODO lines are kept opaque across edits. The same checks run on
// parse and on generate, so raw arrays supplied by callers cannot inject
// framing, parent identity or modelled fields.

/** VTODO properties the model writes itself; never kept as raw lines on the VTODO. */
const TODO_MODELLED_PROPERTIES = new Set([
  'UID', 'SUMMARY', 'DESCRIPTION', 'DTSTART', 'DUE', 'PRIORITY', 'STATUS', 'COMPLETED',
  'CREATED', 'LAST-MODIFIED', 'PERCENT-COMPLETE', 'LOCATION', 'URL', 'CATEGORIES',
]);

/** Component types that may never appear inside a VTODO, at any depth. */
const TODO_FORBIDDEN_COMPONENTS = new Set(['VCALENDAR', 'VEVENT', 'VTODO', 'VJOURNAL', 'VFREEBUSY', 'VTIMEZONE']);

/** TAB is the only control character allowed; CR or LF could inject lines. */
const RETAINED_CONTROL_CHARS = /[\u0000-\u0008\u000a-\u001f\u007f]/;

/** Whether a raw logical line is a safe property line to keep. `allowModelled`
 *  is true inside a subcomponent, where names like DESCRIPTION are its own. */
function isRetainableTodoProperty(line: unknown, allowModelled: boolean): line is string {
  if (typeof line !== 'string' || RETAINED_CONTROL_CHARS.test(line)) return false;
  const colonIdx = findPropertyColon(line);
  if (colonIdx === line.length) return false;
  const left = line.slice(0, colonIdx);
  if ((left.match(/"/g) ?? []).length % 2 !== 0) return false;
  const semiIdx = left.indexOf(';');
  const rawName = semiIdx === -1 ? left : left.slice(0, semiIdx);
  if (!/^[A-Za-z0-9-]+$/.test(rawName)) return false;
  const name = rawName.toUpperCase();
  if (name === 'BEGIN' || name === 'END') return false;
  return allowModelled || !TODO_MODELLED_PROPERTIES.has(name);
}

/** Whether an array is exactly one complete, name-matched block with valid lines. */
function isRetainableTodoComponent(block: unknown): block is string[] {
  if (!Array.isArray(block) || block.length < 2) return false;
  const open: string[] = [];
  for (let i = 0; i < block.length; i++) {
    const line: unknown = block[i];
    if (typeof line !== 'string' || RETAINED_CONTROL_CHARS.test(line)) return false;
    if (/^(BEGIN|END):/i.test(line)) {
      const match = /^(BEGIN|END):([A-Za-z0-9-]+)$/i.exec(line);
      if (!match) return false;
      const name = match[2]!.toUpperCase();
      if (match[1]!.toUpperCase() === 'BEGIN') {
        if (TODO_FORBIDDEN_COMPONENTS.has(name) || (i > 0 && open.length === 0)) return false;
        open.push(name);
      } else {
        if (open.pop() !== name) return false;
        if (open.length === 0 && i !== block.length - 1) return false;
      }
    } else if (open.length === 0 || !isRetainableTodoProperty(line, true)) {
      return false;
    }
  }
  return open.length === 0;
}

type RetainedDateForm = { date: boolean; floating: boolean };

/** DATE vs DATE-TIME, and floating (no UTC designator, no TZID) for DATE-TIME. */
function retainedDateForm(value: string, params: Record<string, string> | undefined): RetainedDateForm {
  const date = (params?.['VALUE'] ?? '').toUpperCase() === 'DATE' || /^\d{8}$/.test(value);
  return { date, floating: !date && !/Z$/i.test(value) && !params?.['TZID'] };
}

/** RRULE UNTIL must have the DTSTART value type: DATE, floating local time, or UTC for UTC/TZID starts. */
function untilMatchesStart(rrule: string, start: RetainedDateForm): boolean {
  const until = rrule.split(';').find((part) => /^UNTIL=/i.test(part))?.slice(6);
  if (until === undefined) return true;
  if (start.date) return /^\d{8}$/.test(until);
  if (start.floating) return /^\d{8}T\d{6}$/.test(until);
  return /^\d{8}T\d{6}Z$/i.test(until);
}

/** Whether a retained VALARM still has the anchor its TRIGGER needs. Other components have no rule. */
function alarmAnchored(block: string[], hasStart: boolean, hasDue: boolean, durationWritten: boolean): boolean {
  if (!/^BEGIN:VALARM$/i.test(block[0]!)) return true;
  let depth = 0;
  for (const line of block) {
    if (/^BEGIN:/i.test(line)) { depth++; continue; }
    if (/^END:/i.test(line)) { depth--; continue; }
    if (depth !== 1) continue;
    const trigger = parseProperty(line);
    if (trigger.name !== 'TRIGGER') continue;
    if ((trigger.params['VALUE'] ?? '').toUpperCase() === 'DATE-TIME') return true;
    if ((trigger.params['RELATED'] ?? '').toUpperCase() === 'END') return hasDue || (hasStart && durationWritten);
    return hasStart;
  }
  return true;
}

/**
 * Retained lines to write for a VTODO: valid properties (source order), then
 * valid components (source order), minus temporal content whose anchor the
 * written DTSTART/DUE no longer supports. Inputs are never changed.
 */
function retainedTodoLines(todo: VTodo): string[] {
  const start = todo.dtstart ? retainedDateForm(todo.dtstart, todo.dtstartParams) : undefined;
  const hasDue = !!todo.due;
  const properties = (todo.unknownProperties ?? []).filter((line) => {
    if (!isRetainableTodoProperty(line, false)) return false;
    const { name, params, value } = parseProperty(line);
    switch (name) {
      case 'DURATION':
        // RFC 5545: DURATION needs DTSTART and excludes DUE; a DATE start allows days/weeks only.
        return !!start && !hasDue && (!start.date || !/T/i.test(value));
      case 'RRULE':
        return !!start && untilMatchesStart(value, start);
      case 'RDATE':
      case 'EXDATE':
        return !!start;
      case 'RECURRENCE-ID': {
        // RFC 5545 §3.8.4.4: same value type as DTSTART, floating if and only if DTSTART is.
        // Kept verbatim: it names the original occurrence, never compared with DTSTART.
        if (!start) return false;
        const id = retainedDateForm(value, params);
        return id.date === start.date && (id.date || id.floating === start.floating);
      }
      default:
        return true;
    }
  });
  const durationWritten = properties.some((line) => parseProperty(line).name === 'DURATION');
  const components = (todo.unknownComponents ?? []).filter(
    (block) => isRetainableTodoComponent(block) && alarmAnchored(block, !!start, hasDue, durationWritten),
  );
  return [...properties, ...components.flat()];
}

/** Fold a retained line at code-point boundaries: at most 75 UTF-8 octets per
 *  physical line, counting the leading space of each continuation line. */
function foldRetainedLine(line: string): string {
  const parts: string[] = [];
  let current = '';
  let octets = 0;
  let limit = 75;
  for (const ch of line) {
    const cp = ch.codePointAt(0)!;
    const size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (octets + size > limit) {
      parts.push(current);
      current = '';
      octets = 0;
      limit = 74;
    }
    current += ch;
    octets += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

/**
 * Generate an iCalendar VTODO string from properties.
 */
export function generateVTodo(todo: VTodo): string {
  const lines: string[] = [];
  lines.push('BEGIN:VTODO');

  lines.push(foldLine(`UID:${todo.uid}`));

  if (todo.summary) lines.push(foldLine(`SUMMARY:${escapeText(todo.summary)}`));
  if (todo.description) lines.push(foldLine(`DESCRIPTION:${escapeText(todo.description)}`));

  if (todo.dtstart) {
    if (todo.dtstartParams && Object.keys(todo.dtstartParams).length > 0) {
      const paramStr = Object.entries(todo.dtstartParams)
        .map(([k, v]) => `${k}=${v}`)
        .join(';');
      lines.push(foldLine(`DTSTART;${paramStr}:${todo.dtstart}`));
    } else {
      lines.push(foldLine(`DTSTART:${todo.dtstart}`));
    }
  }

  if (todo.due) {
    if (todo.dueParams && Object.keys(todo.dueParams).length > 0) {
      const paramStr = Object.entries(todo.dueParams)
        .map(([k, v]) => `${k}=${v}`)
        .join(';');
      lines.push(foldLine(`DUE;${paramStr}:${todo.due}`));
    } else {
      lines.push(foldLine(`DUE:${todo.due}`));
    }
  }

  if (todo.priority !== undefined) lines.push(foldLine(`PRIORITY:${todo.priority}`));
  if (todo.status) lines.push(foldLine(`STATUS:${todo.status}`));
  if (todo.completed) lines.push(foldLine(`COMPLETED:${todo.completed}`));
  if (todo.created) lines.push(foldLine(`CREATED:${todo.created}`));
  if (todo.lastModified) lines.push(foldLine(`LAST-MODIFIED:${todo.lastModified}`));
  if (todo.percentComplete !== undefined) lines.push(foldLine(`PERCENT-COMPLETE:${todo.percentComplete}`));
  if (todo.location) lines.push(foldLine(`LOCATION:${escapeText(todo.location)}`));
  if (todo.url) lines.push(foldLine(`URL:${todo.url}`));
  if (todo.categories && todo.categories.length > 0) {
    lines.push(foldLine(`CATEGORIES:${todo.categories.map(escapeText).join(',')}`));
  }

  for (const line of retainedTodoLines(todo)) lines.push(foldRetainedLine(line));

  lines.push('END:VTODO');
  return lines.join('\r\n');
}

/**
 * Parse a full VCALENDAR document and extract all VEVENT components.
 */
export function parseVCalendar(ical: string): VEvent[] {
  const unfolded = unfoldLines(ical);
  const lines = unfolded.split(/\r?\n/);
  const events: VEvent[] = [];

  let inEvent = false;
  let eventLines: string[] = [];

  for (const line of lines) {
    if (line.trim() === 'BEGIN:VEVENT') {
      inEvent = true;
      eventLines = ['BEGIN:VEVENT'];
    } else if (line.trim() === 'END:VEVENT') {
      eventLines.push('END:VEVENT');
      events.push(parseVEvent(eventLines.join('\r\n')));
      inEvent = false;
      eventLines = [];
    } else if (inEvent) {
      eventLines.push(line);
    }
  }

  return events;
}

/**
 * Generate a complete VCALENDAR document from an array of VEvent objects.
 */
export function generateVCalendar(events: VEvent[]): string {
  const lines: string[] = [];
  lines.push('BEGIN:VCALENDAR');
  lines.push('VERSION:2.0');
  lines.push('PRODID:-//SilentSuite//EN');

  for (const event of events) {
    lines.push(generateVEvent(event));
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
