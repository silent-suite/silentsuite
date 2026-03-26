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
  /** Raw DTSTART parameters like TZID or VALUE */
  dtstartParams?: Record<string, string>;
  /** Raw DTEND parameters */
  dtendParams?: Record<string, string>;
}

export interface VTodo {
  uid: string;
  summary?: string;
  description?: string;
  due?: string;
  dueParams?: Record<string, string>;
  priority?: number;
  status?: string;
  completed?: string;
  created?: string;
  lastModified?: string;
  percentComplete?: number;
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
  if (trimmed.startsWith('BEGIN:VCALENDAR')) {
    // Extract the first VTODO block from the VCALENDAR wrapper
    const match = trimmed.match(/BEGIN:VTODO[\s\S]*?END:VTODO/);
    if (!match) {
      throw new Error('VCALENDAR contains no VTODO component');
    }
    ical = match[0];
  }

  const unfolded = unfoldLines(ical);
  const lines = unfolded.split(/\r?\n/).filter((l) => l.length > 0);

  const todo: VTodo = { uid: '' };

  for (const line of lines) {
    if (line === 'BEGIN:VTODO' || line === 'END:VTODO') continue;

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
    }
  }

  // Input validation
  if (!todo.uid) {
    todo.uid = crypto.randomUUID();
  }
  if (!todo.summary) {
    todo.summary = 'Untitled';
  }

  return todo;
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
