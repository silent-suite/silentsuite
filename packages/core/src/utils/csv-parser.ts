/**
 * Todoist CSV export parser.
 * Converts Todoist CSV exports into VTodo[] for import into SilentSuite.
 */

import type { VTodo } from './ical-parser.js';

/** Todoist CSV column names */
const EXPECTED_COLUMNS = [
  'TYPE', 'CONTENT', 'DESCRIPTION', 'PRIORITY', 'INDENT',
  'AUTHOR', 'RESPONSIBLE', 'DATE', 'DATE_LANG', 'TIMEZONE',
  'DURATION', 'DURATION_UNIT',
] as const;

/**
 * Map Todoist priority (1=highest, 4=none) to iCal priority (1=high, 9=low, 0=undefined).
 */
function mapPriority(todoistPriority: number): number {
  switch (todoistPriority) {
    case 1: return 1;  // high
    case 2: return 5;  // medium
    case 3: return 9;  // low
    case 4: return 0;  // none/undefined
    default: return 0;
  }
}

/**
 * Parse a single CSV line respecting quoted fields.
 * Handles commas inside quoted fields and escaped quotes ("").
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        current += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
        i++;
      } else {
        current += ch;
        i++;
      }
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Parse a Todoist date string into an iCal date or datetime string.
 * Handles formats like: "Oct 15 2025", "2025-10-15", "Oct 15 2025 14:30"
 */
function parseTodoistDate(dateStr: string): string | undefined {
  const trimmed = dateStr.trim();
  if (!trimmed) return undefined;

  // ISO format: 2025-10-15 or 2025-10-15T14:30:00
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (isoMatch) {
    const [, y, m, d, hr, min] = isoMatch;
    if (hr != null) {
      return `${y}${m}${d}T${hr}${min}00`;
    }
    return `${y}${m}${d}`;
  }

  // Month name format: "Oct 15 2025" or "Oct 15 2025 14:30"
  const months: Record<string, string> = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
  };
  const namedMatch = trimmed.match(/^(\w{3})\s+(\d{1,2})\s+(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (namedMatch) {
    const [, mon, day, year, hr, min] = namedMatch;
    const mm = months[mon];
    if (!mm) return undefined;
    const dd = day.padStart(2, '0');
    if (hr != null) {
      return `${year}${mm}${dd}T${hr.padStart(2, '0')}${min}00`;
    }
    return `${year}${mm}${dd}`;
  }

  return undefined;
}

function generateUid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Parse a Todoist CSV export string into an array of VTodo objects.
 */
export function parseTodoistCsv(csvContent: string): VTodo[] {
  const lines = csvContent.split(/\r?\n/);
  if (lines.length === 0) return [];

  // Find and parse header line
  const headerLine = lines[0];
  const headers = parseCsvLine(headerLine).map((h) => h.trim().toUpperCase());

  // Validate it looks like a Todoist export
  const contentIdx = headers.indexOf('CONTENT');
  if (contentIdx === -1) return [];

  const col = (name: string) => headers.indexOf(name);

  const todos: VTodo[] = [];
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = parseCsvLine(line);
    const content = fields[contentIdx]?.trim();
    if (!content) continue;

    const indent = parseInt(fields[col('INDENT')] || '1', 10);
    const isSubtask = indent > 1;

    const priority = parseInt(fields[col('PRIORITY')] || '4', 10);
    const type = (fields[col('TYPE')] || '').trim().toLowerCase();
    const description = fields[col('DESCRIPTION')]?.trim() || undefined;
    const dateStr = fields[col('DATE')] || '';

    const due = parseTodoistDate(dateStr);
    const isCompleted = type === 'completed';

    const todo: VTodo = {
      uid: generateUid(),
      summary: isSubtask ? `→ ${content}` : content,
      description,
      priority: mapPriority(priority),
      due,
      status: isCompleted ? 'COMPLETED' : 'NEEDS-ACTION',
      completed: isCompleted ? now : undefined,
      created: now,
    };

    todos.push(todo);
  }

  return todos;
}
