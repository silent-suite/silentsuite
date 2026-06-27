import { parseVTodo, generateVTodo } from '../utils/ical-parser.js';
import type { VTodo } from '../utils/ical-parser.js';
import type { Priority } from './types.js';

export type TaskStatus = 'needs-action' | 'in-process' | 'completed' | 'cancelled';

export interface Task {
  id: string;
  uid: string;
  title: string;
  description: string;
  start_date?: Date | null;
  due_date: Date | null;
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

  if (task.start_date) {
    const startDateOnly = task.start_date.getHours() === 0
      && task.start_date.getMinutes() === 0
      && task.start_date.getSeconds() === 0;
    vtodo.dtstart = startDateOnly ? formatICalDate(task.start_date) : formatICalDateTime(task.start_date);
    if (startDateOnly) {
      vtodo.dtstartParams = { VALUE: 'DATE' };
    }
  }

  if (task.due_date) {
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

  const due_date = vtodo.due ? parseICalDateValue(vtodo.due) : null;
  const completed = vtodo.status?.toUpperCase() === 'COMPLETED'
    || vtodo.percentComplete === 100
    || (vtodo.status === undefined && vtodo.completed !== undefined);
  const status = icalStatusToModel(vtodo.status, completed);

  return {
    id: vtodo.uid,
    uid: vtodo.uid,
    title: vtodo.summary ?? '',
    description: vtodo.description ?? '',
    start_date: vtodo.dtstart ? parseICalDateValue(vtodo.dtstart) : null,
    due_date,
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
