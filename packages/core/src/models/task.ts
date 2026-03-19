import { parseVTodo, generateVTodo } from '../utils/ical-parser.js';
import type { VTodo } from '../utils/ical-parser.js';
import type { Priority } from './types.js';

export interface Task {
  id: string;
  uid: string;
  title: string;
  description: string;
  due_date: Date | null;
  priority: Priority;
  completed: boolean;
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

/**
 * Convert a Task to an iCalendar VTODO string.
 */
export function toVTodo(task: Task): string {
  const vtodo: VTodo = {
    uid: task.uid,
    summary: task.title || undefined,
    description: task.description || undefined,
    priority: PRIORITY_TO_ICAL[task.priority],
    status: task.completed ? 'COMPLETED' : 'NEEDS-ACTION',
    created: formatICalDateTime(task.created_at),
    lastModified: formatICalDateTime(task.updated_at),
  };

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
    vtodo.completed = formatICalDateTime(task.updated_at);
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
  const completed = vtodo.status?.toUpperCase() === 'COMPLETED';

  return {
    id: vtodo.uid,
    uid: vtodo.uid,
    title: vtodo.summary ?? '',
    description: vtodo.description ?? '',
    due_date,
    priority: icalPriorityToModel(vtodo.priority),
    completed,
    created_at: vtodo.created ? parseICalDateValue(vtodo.created) : now,
    updated_at: vtodo.lastModified ? parseICalDateValue(vtodo.lastModified) : now,
  };
}

/**
 * Serialize a Task to a string for Etebase item content.
 */
export function serializeTask(task: Task): string {
  return toVTodo(task);
}

/**
 * Deserialize Etebase item content to a Task.
 */
export function deserializeTask(content: string): Task {
  return fromVTodo(content);
}
