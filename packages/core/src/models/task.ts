import { parseVTodo, generateVTodo } from '../utils/ical-parser.js';
import type { VTodo } from '../utils/ical-parser.js';
import type { Priority } from './types.js';

export type TaskStatus = 'needs-action' | 'in-process' | 'completed' | 'cancelled';

export type TaskICalDateKind = 'date' | 'floating' | 'utc' | 'tzid';

/**
 * The DTSTART/DUE value exactly as read from iCalendar. When present it is
 * authoritative for serialization and the matching Date field is a derived view.
 */
export interface TaskICalDate {
  kind: TaskICalDateKind;
  /** RFC 5545 value as read: YYYYMMDD, YYYYMMDDTHHMMSS or YYYYMMDDTHHMMSSZ. */
  value: string;
  /** TZID parameter verbatim (including any quotes); only for kind 'tzid'. */
  tzid?: string;
}

export interface Task {
  id: string;
  uid: string;
  title: string;
  description: string;
  start_date?: Date | null;
  due_date: Date | null;
  /** Source DTSTART identity. Anything that changes start_date must update or clear it. */
  start_ical?: TaskICalDate;
  /** Source DUE identity. Anything that changes due_date must update or clear it. */
  due_ical?: TaskICalDate;
  priority: Priority;
  completed: boolean;
  /** RFC 5545 VTODO STATUS. `completed` remains for legacy callers and is kept in sync. */
  status?: TaskStatus;
  /** RFC 5545 PERCENT-COMPLETE, clamped to 0-100. */
  percent_complete?: number;
  /** RFC 5545 LOCATION for clients that support task places/contexts. */
  location?: string;
  /** RFC 5545 URL for the task's canonical link/reference. */
  url?: string;
  /** User-defined labels/categories for grouping and filtering.
   *  Round-tripped via the ICS CATEGORIES property (comma-separated).
   *  Optional so existing callers keep compiling; deserialize paths default to []. */
  categories?: string[];
  listId?: string;
  created_at: Date;
  updated_at: Date;
}

// RFC 5545 priority mapping: 1=urgent, 2=high, 5=medium, 9=low
const PRIORITY_TO_ICAL: Record<Priority, number> = {
  urgent: 1,
  high: 2,
  medium: 5,
  low: 9,
};

const ICAL_TO_PRIORITY: Record<number, Priority> = {
  1: 'urgent',
  2: 'high',
  5: 'medium',
  9: 'low',
};

const TASK_STATUS_TO_ICAL: Record<TaskStatus, string> = {
  'needs-action': 'NEEDS-ACTION',
  'in-process': 'IN-PROCESS',
  completed: 'COMPLETED',
  cancelled: 'CANCELLED',
};

const ICAL_TO_TASK_STATUS: Record<string, TaskStatus> = {
  'NEEDS-ACTION': 'needs-action',
  'IN-PROCESS': 'in-process',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

function icalPriorityToModel(value: number | undefined): Priority {
  if (value === undefined || value === 0) return 'medium';
  if (value <= 1) return 'urgent';
  if (value <= 4) return 'high';
  if (value <= 6) return 'medium';
  return 'low';
}

function formatICalDateTime(date: Date): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}${mo}${d}T${h}${mi}${s}`;
}

function formatICalUtcDateTime(date: Date): string {
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const h = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  const s = String(date.getUTCSeconds()).padStart(2, '0');
  return `${y}${mo}${d}T${h}${mi}${s}Z`;
}

function formatICalDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function parseICalDateValue(value: string): Date {
  const clean = value.replace(/[^0-9TZ]/g, '');
  const year = parseInt(clean.slice(0, 4), 10);
  const month = parseInt(clean.slice(4, 6), 10) - 1;
  const day = parseInt(clean.slice(6, 8), 10);

  if (clean.length <= 8) {
    return new Date(year, month, day);
  }

  const hour = parseInt(clean.slice(9, 11), 10);
  const minute = parseInt(clean.slice(11, 13), 10);
  const second = parseInt(clean.slice(13, 15), 10);

  if (clean.endsWith('Z')) {
    return new Date(Date.UTC(year, month, day, hour, minute, second));
  }
  return new Date(year, month, day, hour, minute, second);
}

function isDateOnly(value: string): boolean {
  return value.replace(/[^0-9TZ]/g, '').length <= 8;
}

const ICAL_DATE_VALUE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/;

/** Offset of `timeZone` from UTC at `utcMs`, in ms. Throws for zones Intl does not know. */
function zoneOffsetMs(timeZone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(utcMs));
  const p = (type: string) => parseInt(parts.find((x) => x.type === type)?.value ?? '0', 10);
  const hour = p('hour') === 24 ? 0 : p('hour');
  return Date.UTC(p('year'), p('month') - 1, p('day'), hour, p('minute'), p('second')) - utcMs;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The instant of a wall-clock time in `timeZone`, or null when Intl does not
 * know the zone. Per RFC 5545 §3.3.5 a repeated local time means its first
 * occurrence and a skipped one uses the offset from before the gap.
 */
function zonedWallTimeToDate(tzid: string, wallAsUtcMs: number): Date | null {
  const timeZone = tzid.replace(/^"(.*)"$/, '$1');
  try {
    const before = zoneOffsetMs(timeZone, wallAsUtcMs - DAY_MS);
    const after = zoneOffsetMs(timeZone, wallAsUtcMs + DAY_MS);
    const valid = [before, after]
      .filter((offset) => zoneOffsetMs(timeZone, wallAsUtcMs - offset) === offset)
      .map((offset) => wallAsUtcMs - offset);
    return new Date(valid.length > 0 ? Math.min(...valid) : wallAsUtcMs - before);
  } catch {
    return null;
  }
}

/**
 * Classify an iCalendar DTSTART/DUE value. Returns the derived Date and, for
 * values this model can reproduce exactly, the source identity to serialize.
 */
export function taskICalDateFromProperty(
  value: string,
  params?: Record<string, string>,
): { date: Date; source?: TaskICalDate } {
  const match = ICAL_DATE_VALUE.exec(value);
  const timed = match?.[4] !== undefined;
  // Unrecognised shapes, and VALUE=DATE on a timed value, keep the legacy parse with no source.
  if (!match || (timed && params?.['VALUE']?.toUpperCase() === 'DATE')) {
    return { date: parseICalDateValue(value) };
  }
  const date = parseICalDateValue(value);
  if (!timed) return { date, source: { kind: 'date', value } };
  // A trailing Z is UTC; a TZID alongside it is invalid and ignored.
  if (match[7]) return { date, source: { kind: 'utc', value } };
  const tzid = params?.['TZID'];
  if (!tzid) return { date, source: { kind: 'floating', value } };
  const [, y, mo, d, h, mi, s] = match.map(Number) as number[];
  const wall = Date.UTC(y!, mo! - 1, d!, h!, mi!, s!);
  // Unknown zones keep today's local wall-time reading; the TZID is still written back verbatim.
  return { date: zonedWallTimeToDate(tzid, wall) ?? date, source: { kind: 'tzid', value, tzid } };
}

function sourceParams(source: TaskICalDate): Record<string, string> | undefined {
  if (source.kind === 'date') return { VALUE: 'DATE' };
  if (source.kind === 'tzid' && source.tzid) return { TZID: source.tzid };
  return undefined;
}

function statusToICal(task: Task): string {
  if (task.completed) return 'COMPLETED';
  return TASK_STATUS_TO_ICAL[task.status ?? 'needs-action'];
}

function icalStatusToModel(value: string | undefined, completed: boolean): TaskStatus {
  if (completed) return 'completed';
  if (!value) return 'needs-action';
  return ICAL_TO_TASK_STATUS[value.toUpperCase()] ?? 'needs-action';
}

function normalizePercent(value: number | undefined, completed: boolean): number {
  if (completed) return 100;
  if (value === undefined || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Convert a Task to an iCalendar VTODO string.
 */
export function toVTodo(task: Task): string {
  const vtodo: VTodo = {
    uid: task.uid,
    summary: task.title || undefined,
    description: task.description || undefined,
    priority: PRIORITY_TO_ICAL[task.priority],
    status: statusToICal(task),
    percentComplete: normalizePercent(task.percent_complete, task.completed),
    location: task.location || undefined,
    url: task.url || undefined,
    categories: task.categories && task.categories.length > 0 ? task.categories : undefined,
    created: formatICalUtcDateTime(task.created_at),
    lastModified: formatICalUtcDateTime(task.updated_at),
  };

  if (task.start_date && task.start_ical) {
    vtodo.dtstart = task.start_ical.value;
    vtodo.dtstartParams = sourceParams(task.start_ical);
  } else if (task.start_date) {
    const startDateOnly = task.start_date.getHours() === 0
      && task.start_date.getMinutes() === 0
      && task.start_date.getSeconds() === 0;
    vtodo.dtstart = startDateOnly ? formatICalDate(task.start_date) : formatICalDateTime(task.start_date);
    if (startDateOnly) {
      vtodo.dtstartParams = { VALUE: 'DATE' };
    }
  }

  if (task.due_date && task.due_ical) {
    vtodo.due = task.due_ical.value;
    vtodo.dueParams = sourceParams(task.due_ical);
  } else if (task.due_date) {
    const dueDateOnly = task.due_date.getHours() === 0
      && task.due_date.getMinutes() === 0
      && task.due_date.getSeconds() === 0;
    vtodo.due = dueDateOnly ? formatICalDate(task.due_date) : formatICalDateTime(task.due_date);
    if (dueDateOnly) {
      vtodo.dueParams = { VALUE: 'DATE' };
    }
  }

  if (task.completed) {
    vtodo.completed = formatICalUtcDateTime(task.updated_at);
  }

  return generateVTodo(vtodo);
}

/**
 * Parse an iCalendar VTODO string into a Task.
 */
export function fromVTodo(vtodoStr: string): Task {
  const vtodo = parseVTodo(vtodoStr);
  const now = new Date();

  const start = vtodo.dtstart ? taskICalDateFromProperty(vtodo.dtstart, vtodo.dtstartParams) : null;
  const due = vtodo.due ? taskICalDateFromProperty(vtodo.due, vtodo.dueParams) : null;
  const completed = vtodo.status?.toUpperCase() === 'COMPLETED'
    || vtodo.percentComplete === 100
    || (vtodo.status === undefined && vtodo.completed !== undefined);
  const status = icalStatusToModel(vtodo.status, completed);

  return {
    id: vtodo.uid,
    uid: vtodo.uid,
    title: vtodo.summary ?? '',
    description: vtodo.description ?? '',
    start_date: start?.date ?? null,
    due_date: due?.date ?? null,
    ...(start?.source ? { start_ical: start.source } : {}),
    ...(due?.source ? { due_ical: due.source } : {}),
    priority: icalPriorityToModel(vtodo.priority),
    completed,
    status,
    percent_complete: normalizePercent(vtodo.percentComplete, completed),
    location: vtodo.location ?? '',
    url: vtodo.url ?? '',
    // Preserve CATEGORIES for round-trip; default to [] for legacy records
    categories: vtodo.categories ?? [],
    created_at: vtodo.created ? parseICalDateValue(vtodo.created) : now,
    updated_at: vtodo.lastModified ? parseICalDateValue(vtodo.lastModified) : now,
  };
}

/**
 * Serialize a Task to a string for Etebase item content.
 * Produces a complete VCALENDAR document (RFC 5545 compliant).
 */
export function serializeTask(task: Task): string {
  const vtodo = toVTodo(task);
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SilentSuite//EN',
    vtodo,
    'END:VCALENDAR',
  ].join('\r\n');
}

/**
 * Deserialize Etebase item content to a Task.
 */
export function deserializeTask(content: string): Task {
  return fromVTodo(content);
}
