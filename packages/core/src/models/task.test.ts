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
  });

  it('serializes an incomplete task with STATUS:NEEDS-ACTION', () => {
    const task = makeFullTask({ completed: false });
    const vtodo = toVTodo(task);

    expect(vtodo).toContain('STATUS:NEEDS-ACTION');
    expect(vtodo).not.toContain('COMPLETED:');
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
