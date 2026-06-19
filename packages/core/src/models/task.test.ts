import { describe, it, expect } from 'vitest';
import {
  toVTodo,
  fromVTodo,
  serializeTask,
  deserializeTask,
} from './task.js';
import type { Task } from './task.js';
import type { Priority } from './types.js';

// ── Helpers ──

function makeFullTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-001',
    uid: 'task-001',
    title: 'Review pull request',
    description: 'Check the new auth middleware changes',
    due_date: new Date(2026, 2, 20, 17, 0, 0), // March 20, 2026 17:00
    priority: 'high',
    completed: false,
    categories: ['Work', 'Urgent'],
    created_at: new Date(2026, 0, 1, 0, 0, 0),
    updated_at: new Date(2026, 2, 10, 12, 0, 0),
    ...overrides,
  };
}

function makeMinimalTask(): Task {
  return {
    id: 'min-001',
    uid: 'min-001',
    title: 'Quick note',
    description: '',
    due_date: null,
    priority: 'medium',
    completed: false,
    created_at: new Date(2026, 2, 15, 0, 0, 0),
    updated_at: new Date(2026, 2, 15, 0, 0, 0),
  };
}

// ── categories roundtrip (#291) ──

describe('categories roundtrip (#291)', () => {
  it('roundtrips multiple comma-separated categories', () => {
    const original = makeFullTask({ categories: ['Work', 'Home', 'Errands'] });
    const vtodo = toVTodo(original);

    expect(vtodo).toContain('CATEGORIES:Work,Home,Errands');

    const restored = fromVTodo(vtodo);
    expect(restored.categories).toEqual(['Work', 'Home', 'Errands']);
  });

  it('roundtrips a category containing an escaped comma', () => {
    const original = makeFullTask({ categories: ['Side, Project', 'Personal'] });
    const vtodo = toVTodo(original);

    expect(vtodo).toContain('CATEGORIES:Side\\, Project,Personal');

    const restored = fromVTodo(vtodo);
    expect(restored.categories).toEqual(['Side, Project', 'Personal']);
  });

  it('defaults categories to [] when deserializing a legacy record lacking CATEGORIES', () => {
    const legacy = [
      'BEGIN:VTODO',
      'UID:legacy-task-nocat',
      'SUMMARY:Legacy Task',
      'PRIORITY:5',
      'STATUS:NEEDS-ACTION',
      'END:VTODO',
    ].join('\r\n');

    const restored = deserializeTask(legacy);
    expect(restored.categories).toEqual([]);
  });

  it('omits the CATEGORIES line when categories is empty', () => {
    const task = makeFullTask({ categories: [] });
    const vtodo = toVTodo(task);

    expect(vtodo).not.toContain('CATEGORIES');
    expect(fromVTodo(vtodo).categories).toEqual([]);
  });

  it('omits the CATEGORIES line when categories is undefined', () => {
    const task = makeFullTask();
    delete task.categories;
    const vtodo = toVTodo(task);

    expect(vtodo).not.toContain('CATEGORIES');
    expect(fromVTodo(vtodo).categories).toEqual([]);
  });
});

// ── toVTodo / fromVTodo roundtrip ──

describe('toVTodo / fromVTodo roundtrip', () => {
  it('roundtrips a fully populated task', () => {
    const original = makeFullTask();
    const ical = toVTodo(original);
    const restored = fromVTodo(ical);

    expect(restored.uid).toBe(original.uid);
    expect(restored.title).toBe(original.title);
    expect(restored.description).toBe(original.description);
    expect(restored.due_date!.getTime()).toBe(original.due_date!.getTime());
    expect(restored.priority).toBe('high');
    expect(restored.completed).toBe(false);
  });

  it('roundtrips a minimal task (no due date, no description)', () => {
    const original = makeMinimalTask();
    const ical = toVTodo(original);
    const restored = fromVTodo(ical);

    expect(restored.uid).toBe(original.uid);
    expect(restored.title).toBe(original.title);
    expect(restored.due_date).toBeNull();
    expect(restored.description).toBe('');
    expect(restored.priority).toBe('medium');
    expect(restored.completed).toBe(false);
  });

  it('preserves id and uid (both set from vtodo UID)', () => {
    const original = makeFullTask({ id: 'my-id', uid: 'my-id' });
    const ical = toVTodo(original);
    const restored = fromVTodo(ical);

    expect(restored.id).toBe('my-id');
    expect(restored.uid).toBe('my-id');
  });
});

// ── Priority mapping ──

describe('priority mapping', () => {
  const priorities: Array<{ model: Priority; ical: number }> = [
    { model: 'urgent', ical: 1 },
    { model: 'high', ical: 2 },
    { model: 'medium', ical: 5 },
    { model: 'low', ical: 9 },
  ];

  for (const { model, ical } of priorities) {
    it(`maps ${model} priority to PRIORITY:${ical} and back`, () => {
      const task = makeFullTask({ priority: model });
      const vtodo = toVTodo(task);
      expect(vtodo).toContain(`PRIORITY:${ical}`);

      const restored = fromVTodo(vtodo);
      expect(restored.priority).toBe(model);
    });
  }
});

// ── Completed vs incomplete tasks ──

describe('completed vs incomplete tasks', () => {
  it('serializes a completed task with STATUS:COMPLETED and COMPLETED timestamp', () => {
    const task = makeFullTask({ completed: true });
    const vtodo = toVTodo(task);

    expect(vtodo).toContain('STATUS:COMPLETED');
    expect(vtodo).toContain('COMPLETED:');
    expect(vtodo).toContain('PERCENT-COMPLETE:100');
  });

  it('serializes completion metadata as UTC timestamps for CalDAV clients', () => {
    const task = makeFullTask({
      completed: true,
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)),
      updated_at: new Date(Date.UTC(2026, 2, 10, 12, 0, 0)),
    });
    const vtodo = toVTodo(task);

    expect(vtodo).toContain('CREATED:20260101T000000Z');
    expect(vtodo).toContain('LAST-MODIFIED:20260310T120000Z');
    expect(vtodo).toContain('COMPLETED:20260310T120000Z');
  });

  it('serializes an incomplete task with STATUS:NEEDS-ACTION', () => {
    const task = makeFullTask({ completed: false });
    const vtodo = toVTodo(task);

    expect(vtodo).toContain('STATUS:NEEDS-ACTION');
    expect(vtodo).not.toContain('COMPLETED:');
    expect(vtodo).toContain('PERCENT-COMPLETE:0');
  });

  it('roundtrips a completed task', () => {
    const original = makeFullTask({ completed: true });
    const vtodo = toVTodo(original);
    const restored = fromVTodo(vtodo);

    expect(restored.completed).toBe(true);
  });

  it('roundtrips an incomplete task', () => {
    const original = makeFullTask({ completed: false });
    const vtodo = toVTodo(original);
    const restored = fromVTodo(vtodo);

    expect(restored.completed).toBe(false);
  });

  it('treats PERCENT-COMPLETE:100 as completed for tasks.org compatibility', () => {
    const task = fromVTodo([
      'BEGIN:VTODO',
      'UID:percent-complete-task',
      'SUMMARY:Done elsewhere',
      'STATUS:NEEDS-ACTION',
      'PERCENT-COMPLETE:100',
      'END:VTODO',
    ].join('\r\n'));

    expect(task.completed).toBe(true);
  });

  it('does not treat partial PERCENT-COMPLETE values as completed', () => {
    const task = fromVTodo([
      'BEGIN:VTODO',
      'UID:partial-progress-task',
      'SUMMARY:In progress',
      'PERCENT-COMPLETE:50',
      'END:VTODO',
    ].join('\r\n'));

    expect(task.completed).toBe(false);
  });

  it('treats a COMPLETED timestamp as completed for client compatibility', () => {
    const task = fromVTodo([
      'BEGIN:VTODO',
      'UID:completed-date-task',
      'SUMMARY:Done elsewhere',
      'COMPLETED:20260310T120000',
      'END:VTODO',
    ].join('\r\n'));

    expect(task.completed).toBe(true);
  });

  it('does not let a COMPLETED timestamp override an explicit incomplete status', () => {
    const task = fromVTodo([
      'BEGIN:VTODO',
      'UID:stale-completed-date-task',
      'SUMMARY:Marked incomplete elsewhere',
      'STATUS:NEEDS-ACTION',
      'COMPLETED:20260310T120000',
      'END:VTODO',
    ].join('\r\n'));

    expect(task.completed).toBe(false);
  });

  it('normalizes tasks.org-style completion on re-serialize', () => {
    const task = fromVTodo([
      'BEGIN:VTODO',
      'UID:tasks-org-completed-task',
      'SUMMARY:Done in tasks.org',
      'STATUS:NEEDS-ACTION',
      'PERCENT-COMPLETE:100',
      'END:VTODO',
    ].join('\r\n'));

    const vtodo = toVTodo(task);

    expect(task.completed).toBe(true);
    expect(vtodo).toContain('STATUS:COMPLETED');
    expect(vtodo).toContain('COMPLETED:');
    expect(vtodo).toContain('PERCENT-COMPLETE:100');
  });
});

// ── Due date serialization ──

describe('due date serialization', () => {
  it('serializes a date-only due date with VALUE=DATE', () => {
    const task = makeFullTask({
      due_date: new Date(2026, 2, 20), // midnight = date-only
    });
    const vtodo = toVTodo(task);

    expect(vtodo).toContain('DUE;VALUE=DATE:20260320');
  });

  it('serializes a datetime due date without VALUE=DATE', () => {
    const task = makeFullTask({
      due_date: new Date(2026, 2, 20, 17, 30, 0),
    });
    const vtodo = toVTodo(task);

    expect(vtodo).toContain('DUE:20260320T173000');
    expect(vtodo).not.toContain('VALUE=DATE');
  });

  it('handles null due date (no DUE property)', () => {
    const task = makeFullTask({ due_date: null });
    const vtodo = toVTodo(task);

    expect(vtodo).not.toContain('DUE');
  });
});

// ── serializeTask / deserializeTask ──

describe('serializeTask / deserializeTask', () => {
  it('serialize produces a VCALENDAR-wrapped VTODO string', () => {
    const task = makeFullTask();
    const serialized = serializeTask(task);

    expect(typeof serialized).toBe('string');
    expect(serialized).toContain('BEGIN:VCALENDAR');
    expect(serialized).toContain('VERSION:2.0');
    expect(serialized).toContain('PRODID:-//SilentSuite//EN');
    expect(serialized).toContain('BEGIN:VTODO');
    expect(serialized).toContain('END:VTODO');
    expect(serialized).toContain('END:VCALENDAR');
  });

  it('deserialize restores a Task from VCALENDAR-wrapped string', () => {
    const task = makeFullTask();
    const serialized = serializeTask(task);
    const restored = deserializeTask(serialized);

    expect(restored.uid).toBe(task.uid);
    expect(restored.title).toBe(task.title);
    expect(restored.description).toBe(task.description);
  });

  it('roundtrips through serialize/deserialize', () => {
    const original = makeFullTask({
      title: 'Roundtrip Test, Special; chars',
      description: 'Multi\nline\ndescription',
    });

    const serialized = serializeTask(original);
    const restored = deserializeTask(serialized);

    expect(restored.uid).toBe(original.uid);
    expect(restored.title).toBe(original.title);
    expect(restored.description).toBe(original.description);
    expect(restored.due_date!.getTime()).toBe(original.due_date!.getTime());
    expect(restored.priority).toBe(original.priority);
    expect(restored.completed).toBe(original.completed);
  });

  // P1: backward compatibility — existing Etebase items stored as bare VTODO
  it('deserialize handles legacy bare VTODO (backward compatibility)', () => {
    const bareVTodo = [
      'BEGIN:VTODO',
      'UID:legacy-task-001',
      'SUMMARY:Legacy Task',
      'PRIORITY:5',
      'STATUS:NEEDS-ACTION',
      'END:VTODO',
    ].join('\r\n');

    const restored = deserializeTask(bareVTodo);
    expect(restored.uid).toBe('legacy-task-001');
    expect(restored.title).toBe('Legacy Task');
    expect(restored.priority).toBe('medium');
    expect(restored.completed).toBe(false);
  });

  // P1: forward compatibility — new VCALENDAR-wrapped items
  it('deserialize handles VCALENDAR-wrapped VTODO (forward compatibility)', () => {
    const wrapped = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//SilentSuite//EN',
      'BEGIN:VTODO',
      'UID:wrapped-task-001',
      'SUMMARY:Wrapped Task',
      'PRIORITY:2',
      'STATUS:NEEDS-ACTION',
      'END:VTODO',
      'END:VCALENDAR',
    ].join('\r\n');

    const restored = deserializeTask(wrapped);
    expect(restored.uid).toBe('wrapped-task-001');
    expect(restored.title).toBe('Wrapped Task');
    expect(restored.priority).toBe('high');
    expect(restored.completed).toBe(false);
  });
});

// ── Edge cases ──

describe('edge cases', () => {
  it('handles task with empty title', () => {
    const task = makeFullTask({ title: '' });
    const vtodo = toVTodo(task);
    const restored = fromVTodo(vtodo);

    expect(restored.title).toBe('Untitled');
  });

  it('handles task with no description', () => {
    const task = makeFullTask({ description: '' });
    const vtodo = toVTodo(task);
    const restored = fromVTodo(vtodo);

    expect(restored.description).toBe('');
  });

  it('sets id equal to uid from VTODO', () => {
    const ical = [
      'BEGIN:VTODO',
      'UID:unique-id-123',
      'SUMMARY:Test',
      'PRIORITY:5',
      'STATUS:NEEDS-ACTION',
      'END:VTODO',
    ].join('\r\n');

    const task = fromVTodo(ical);
    expect(task.id).toBe('unique-id-123');
    expect(task.uid).toBe('unique-id-123');
  });

  it('defaults created_at/updated_at to current time when missing from VTODO', () => {
    const before = Date.now();
    const ical = [
      'BEGIN:VTODO',
      'UID:no-dates',
      'SUMMARY:No timestamps',
      'PRIORITY:5',
      'STATUS:NEEDS-ACTION',
      'END:VTODO',
    ].join('\r\n');

    const task = fromVTodo(ical);
    const after = Date.now();

    expect(task.created_at.getTime()).toBeGreaterThanOrEqual(before);
    expect(task.created_at.getTime()).toBeLessThanOrEqual(after);
    expect(task.updated_at.getTime()).toBeGreaterThanOrEqual(before);
    expect(task.updated_at.getTime()).toBeLessThanOrEqual(after);
  });

  it('defaults priority to medium when PRIORITY is missing', () => {
    const ical = [
      'BEGIN:VTODO',
      'UID:no-priority',
      'SUMMARY:No priority set',
      'STATUS:NEEDS-ACTION',
      'END:VTODO',
    ].join('\r\n');

    const task = fromVTodo(ical);
    expect(task.priority).toBe('medium');
  });

  it('handles missing SUMMARY', () => {
    const ical = [
      'BEGIN:VTODO',
      'UID:no-summary',
      'PRIORITY:5',
      'STATUS:NEEDS-ACTION',
      'END:VTODO',
    ].join('\r\n');

    const task = fromVTodo(ical);
    expect(task.title).toBe('Untitled');
  });
});
