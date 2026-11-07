import { describe, it, expect } from 'vitest';
import {
  toVTodo,
  fromVTodo,
  serializeTask,
  deserializeTask,
  taskICalDateFromProperty,
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
  it('roundtrips structured task.org-style fields through VTODO', () => {
    const original = makeFullTask({
      start_date: new Date(2026, 2, 18, 0, 0, 0),
      due_date: new Date(2026, 2, 20, 0, 0, 0),
      status: 'in-process',
      percent_complete: 45,
      location: 'Office',
      url: 'https://example.com/tasks/1',
    });
    const ical = toVTodo(original);

    expect(ical).toContain('DTSTART;VALUE=DATE:20260318');
    expect(ical).toContain('DUE;VALUE=DATE:20260320');
    expect(ical).toContain('STATUS:IN-PROCESS');
    expect(ical).toContain('PERCENT-COMPLETE:45');
    expect(ical).toContain('LOCATION:Office');
    expect(ical).toContain('URL:https://example.com/tasks/1');

    const restored = fromVTodo(ical);
    expect(restored.start_date!.getFullYear()).toBe(2026);
    expect(restored.start_date!.getMonth()).toBe(2);
    expect(restored.start_date!.getDate()).toBe(18);
    expect(restored.status).toBe('in-process');
    expect(restored.percent_complete).toBe(45);
    expect(restored.location).toBe('Office');
    expect(restored.url).toBe('https://example.com/tasks/1');
    expect(restored.completed).toBe(false);
  });

  it('serializes cancelled tasks and clamps incomplete percent complete', () => {
    const task = makeFullTask({ status: 'cancelled', percent_complete: 125, completed: false });
    const vtodo = toVTodo(task);

    expect(vtodo).toContain('STATUS:CANCELLED');
    expect(vtodo).toContain('PERCENT-COMPLETE:100');
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

// ── DUE temporal preservation (#66) ──

describe('DUE temporal preservation (#66)', () => {
  it('round-trips a TZID DUE verbatim and resolves its instant in that zone', () => {
    const task = fromVTodo([
      'BEGIN:VTODO',
      'UID:tzid-due-task',
      'SUMMARY:New York deadline',
      'DUE;TZID=America/New_York:20260601T090000',
      'END:VTODO',
    ].join('\r\n'));

    const lines = toVTodo(task).split('\r\n');

    expect(lines.filter((line) => line.startsWith('DUE'))).toEqual([
      'DUE;TZID=America/New_York:20260601T090000',
    ]);
    expect(task.due_date!.toISOString()).toBe('2026-06-01T13:00:00.000Z');
  });

  function roundTrip(...dateLines: string[]) {
    const task = fromVTodo(['BEGIN:VTODO', 'UID:temporal-task', 'SUMMARY:Temporal', ...dateLines, 'END:VTODO'].join('\r\n'));
    const lines = toVTodo(task).split('\r\n');
    return {
      task,
      due: lines.filter((line) => line.startsWith('DUE')),
      start: lines.filter((line) => line.startsWith('DTSTART')),
    };
  }

  it('keeps a UTC DUE in UTC, including at midnight', () => {
    const nine = roundTrip('DUE:20260601T090000Z');
    expect(nine.due).toEqual(['DUE:20260601T090000Z']);
    expect(nine.task.due_date!.toISOString()).toBe('2026-06-01T09:00:00.000Z');

    expect(roundTrip('DUE:20260601T000000Z').due).toEqual(['DUE:20260601T000000Z']);
  });

  it('keeps a floating DUE floating, including at midnight', () => {
    const nine = roundTrip('DUE:20260601T090000');
    expect(nine.due).toEqual(['DUE:20260601T090000']);
    expect(nine.task.due_date!.getTime()).toBe(new Date(2026, 5, 1, 9, 0, 0).getTime());

    expect(roundTrip('DUE:20260601T000000').due).toEqual(['DUE:20260601T000000']);
  });

  it('keeps a TZID DUE at midnight timed', () => {
    expect(roundTrip('DUE;TZID=Europe/Berlin:20260601T000000').due).toEqual(['DUE;TZID=Europe/Berlin:20260601T000000']);
  });

  it('keeps date-only DUE values as local dates written with VALUE=DATE', () => {
    for (const line of ['DUE;VALUE=DATE:20260601', 'DUE:20260601']) {
      const { task, due } = roundTrip(line);
      expect(due).toEqual(['DUE;VALUE=DATE:20260601']);
      expect(task.due_date!.getTime()).toBe(new Date(2026, 5, 1).getTime());
    }
  });

  it('records the source identity of each temporal form', () => {
    expect(taskICalDateFromProperty('20260601', { VALUE: 'DATE' }).source).toEqual({ kind: 'date', value: '20260601' });
    expect(taskICalDateFromProperty('20260601T090000').source).toEqual({ kind: 'floating', value: '20260601T090000' });
    expect(taskICalDateFromProperty('20260601T090000Z').source).toEqual({ kind: 'utc', value: '20260601T090000Z' });
    expect(taskICalDateFromProperty('20260601T090000', { TZID: 'America/New_York' }).source)
      .toEqual({ kind: 'tzid', value: '20260601T090000', tzid: 'America/New_York' });
  });

  it('keeps independent DTSTART and DUE zones', () => {
    const { task, start, due } = roundTrip(
      'DTSTART;TZID=Europe/Berlin:20260530T080000',
      'DUE;TZID=America/New_York:20260601T090000',
    );
    expect(start).toEqual(['DTSTART;TZID=Europe/Berlin:20260530T080000']);
    expect(due).toEqual(['DUE;TZID=America/New_York:20260601T090000']);
    expect(task.start_date!.toISOString()).toBe('2026-05-30T06:00:00.000Z');
  });

  it('resolves a quoted recognised TZID and keeps its quotes', () => {
    const { task, due } = roundTrip('DUE;TZID="America/New_York":20260601T090000');
    expect(due).toEqual(['DUE;TZID="America/New_York":20260601T090000']);
    expect(task.due_date!.toISOString()).toBe('2026-06-01T13:00:00.000Z');
  });

  it('keeps an unknown TZID verbatim and falls back to local wall time', () => {
    for (const tzid of ['Eastern Standard Time', '"/mozilla.org/20070129_1/Europe/Berlin"']) {
      const { task, due } = roundTrip(`DUE;TZID=${tzid}:20260601T090000`);
      expect(due).toEqual([`DUE;TZID=${tzid}:20260601T090000`]);
      expect(task.due_date!.getTime()).toBe(new Date(2026, 5, 1, 9, 0, 0).getTime());
    }
  });

  // RFC 5545 §3.3.5: a skipped local time uses the offset before the gap; a
  // repeated local time means its first occurrence.
  it.each([
    ['New York gap', 'America/New_York', '20260308T023000', '2026-03-08T07:30:00.000Z'],
    ['Berlin gap', 'Europe/Berlin', '20260329T023000', '2026-03-29T01:30:00.000Z'],
    ['New York fold', 'America/New_York', '20261101T013000', '2026-11-01T05:30:00.000Z'],
    ['Berlin fold', 'Europe/Berlin', '20261025T023000', '2026-10-25T00:30:00.000Z'],
    ['Berlin summer', 'Europe/Berlin', '20260615T140000', '2026-06-15T12:00:00.000Z'],
  ])('resolves the %s instant', (_name, tzid, value, iso) => {
    const { task, due } = roundTrip(`DUE;TZID=${tzid}:${value}`);
    expect(task.due_date!.toISOString()).toBe(iso);
    expect(due).toEqual([`DUE;TZID=${tzid}:${value}`]);
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

// ── VALARM properties are not task fields (WEBX-02) ──
// Only checks that parent fields survive deserialize/serialize. It does not
// claim the VALARM block itself is preserved (it is not; see WEBX-03).

describe('VALARM properties are not promoted to task fields (WEBX-02)', () => {
  const remoteItem = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Example//Other Client//EN',
    'BEGIN:VTODO',
    'UID:task-1',
    'SUMMARY:Pay rent',
    'DESCRIPTION:Real description',
    'LOCATION:Home',
    'STATUS:NEEDS-ACTION',
    'BEGIN:VALARM',
    'ACTION:EMAIL',
    'UID:alarm-uid-1',
    'SUMMARY:Alarm subject',
    'DESCRIPTION:Reminder body',
    'LOCATION:Alarm location',
    'ATTENDEE:mailto:someone@example.com',
    'TRIGGER:-PT15M',
    'END:VALARM',
    'END:VTODO',
    'END:VCALENDAR',
  ].join('\r\n');

  it('fromVTodo takes uid, title, description and location from the VTODO, not its VALARM', () => {
    const task = fromVTodo(remoteItem);
    expect(task.uid).toBe('task-1');
    expect(task.id).toBe('task-1');
    expect(task.title).toBe('Pay rent');
    expect(task.description).toBe('Real description');
    expect(task.location).toBe('Home');
  });

  it('a web save (deserialize then serialize) writes the parent fields, not the alarm values', () => {
    const task = deserializeTask(remoteItem);
    const saved = serializeTask({ ...task, completed: true, status: 'completed' });

    expect(saved).toContain('UID:task-1');
    expect(saved).toContain('SUMMARY:Pay rent');
    expect(saved).toContain('DESCRIPTION:Real description');
    expect(saved).toContain('LOCATION:Home');

    const reread = deserializeTask(saved);
    expect(reread.uid).toBe('task-1');
    expect(reread.title).toBe('Pay rent');
    expect(reread.description).toBe('Real description');
    expect(reread.location).toBe('Home');
    expect(reread.completed).toBe(true);
  });
});

// ── Unsupported VTODO content survives a web edit (WEBX-03) ──
// These tests only cover the local deserialize → edit → serialize transform.
// Keeping RRULE does not add recurring-task behaviour; completing such a task
// still completes the item as today. Isolation checks run first, retention last.

describe('unsupported VTODO content survives task edits (WEBX-03)', () => {
  const logical = (text: string): string[] => text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const count = (lines: string[], line: string): number => lines.filter((l) => l === line).length;

  const alarmBlock = [
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:Water reminder',
    'TRIGGER:-PT30M',
    'END:VALARM',
  ];
  const retainedProps = [
    'RRULE:FREQ=WEEKLY;BYDAY=SA',
    'RELATED-TO;RELTYPE=PARENT:parent-uid-1',
    'X-EXAMPLE-ORDER:3',
  ];
  const remoteItem = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Example//Other Client//EN',
    'BEGIN:VTODO',
    'UID:task-p1',
    'SUMMARY:Water plants',
    // Anchor for RRULE and the start-relative alarm (2026-11-07 is a Saturday).
    'DTSTART:20261107T090000Z',
    'CREATED:20261101T080000Z',
    'LAST-MODIFIED:20261102T080000Z',
    'STATUS:NEEDS-ACTION',
    ...retainedProps,
    ...alarmBlock,
    'END:VTODO',
    'END:VCALENDAR',
  ].join('\r\n');

  it('keeps unsupported properties and the VALARM block when a task is renamed and completed', () => {
    const task = deserializeTask(remoteItem);
    const out = logical(serializeTask({ ...task, title: 'Water all plants', completed: true, status: 'completed' }));

    expect(count(out, 'SUMMARY:Water all plants')).toBe(1);
    expect(out).not.toContain('SUMMARY:Water plants');
    expect(count(out, 'STATUS:COMPLETED')).toBe(1);
    expect(out).not.toContain('STATUS:NEEDS-ACTION');
    expect(out.filter((l) => l.startsWith('UID:'))).toEqual(['UID:task-p1']);

    for (const line of retainedProps) expect(count(out, line)).toBe(1);
    const blockStart = out.indexOf('BEGIN:VALARM');
    expect(out.slice(blockStart, blockStart + alarmBlock.length)).toEqual(alarmBlock);
    expect(out.indexOf('SUMMARY:Water all plants')).toBeLessThan(blockStart);
    expect(blockStart).toBeLessThan(out.indexOf('END:VTODO'));
  });

  it('does not duplicate retained content across repeated saves', () => {
    const first = serializeTask({ ...deserializeTask(remoteItem), title: 'Edit one' });
    const out = logical(serializeTask({ ...deserializeTask(first), title: 'Edit two' }));

    expect(count(out, 'SUMMARY:Edit two')).toBe(1);
    expect(out.filter((l) => l.startsWith('SUMMARY:'))).toEqual(['SUMMARY:Edit two']);

    for (const line of [...retainedProps, ...alarmBlock]) expect(count(out, line)).toBe(1);
  });

  const durationItem = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VTODO',
    'UID:task-d1',
    'SUMMARY:Timed task',
    'DTSTART:20261110T090000Z',
    'DURATION:PT1H',
    'END:VTODO',
    'END:VCALENDAR',
  ].join('\r\n');

  it('keeps DURATION while the saved task writes no DUE', () => {
    const task = deserializeTask(durationItem);
    const out = logical(serializeTask({ ...task, title: 'Timed task renamed' }));

    expect(out.filter((l) => /^DUE[;:]/.test(l))).toEqual([]);
    expect(count(out, 'DTSTART:20261110T090000Z')).toBe(1);

    expect(count(out, 'DURATION:PT1H')).toBe(1);
  });

  it('control: a task that gains a DUE is saved with one DUE and no DURATION', () => {
    const task = deserializeTask(durationItem);
    const out = logical(serializeTask({ ...task, due_date: new Date(Date.UTC(2026, 10, 12, 17, 0, 0)), due_ical: undefined }));

    expect(out.filter((l) => /^DUE[;:]/.test(l))).toHaveLength(1);
    expect(out.filter((l) => l.startsWith('DURATION'))).toEqual([]);
  });

  it('control: a task without unsupported content serializes only modelled lines', () => {
    const plain = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VTODO',
      'UID:task-c1',
      'SUMMARY:Plain task',
      'DESCRIPTION:Nothing extra',
      'CREATED:20261101T080000Z',
      'LAST-MODIFIED:20261102T080000Z',
      'STATUS:NEEDS-ACTION',
      'PRIORITY:5',
      'END:VTODO',
      'END:VCALENDAR',
    ].join('\r\n');
    const modelled = new Set([
      'BEGIN', 'END', 'VERSION', 'PRODID', 'UID', 'SUMMARY', 'DESCRIPTION', 'DTSTART', 'DUE', 'PRIORITY',
      'STATUS', 'COMPLETED', 'CREATED', 'LAST-MODIFIED', 'PERCENT-COMPLETE', 'LOCATION', 'URL', 'CATEGORIES',
    ]);

    const out = logical(serializeTask({ ...deserializeTask(plain), title: 'Plain task edited' }));

    for (const line of out) expect(modelled.has(line.split(/[;:]/)[0]!.toUpperCase())).toBe(true);
    expect(out.filter((l) => /^BEGIN:/i.test(l))).toEqual(['BEGIN:VCALENDAR', 'BEGIN:VTODO']);
  });
});

// ── Retained content after task date edits (WEBX-03 corrections) ──
// Edits mirror the web store: a changed start_date without a new source drops
// start_ical. Retained DURATION, alarms and recurrence are written only while
// their anchors stay compatible. No recurrence expansion or rebasing.

describe('retained VTODO content stays consistent after task date edits (WEBX-03)', () => {
  const logical = (text: string): string[] => text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const count = (lines: string[], line: string): number => lines.filter((l) => l === line).length;
  const hasBlock = (lines: string[], block: string[]): boolean =>
    block.length > 0 && lines.some((_, i) => block.every((l, j) => lines[i + j] === l));

  const startAlarm = ['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Start reminder', 'TRIGGER:-PT15M', 'END:VALARM'];
  const endAlarm = ['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:End reminder', 'TRIGGER;RELATED=END:-PT5M', 'END:VALARM'];
  const absAlarm = [
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:Fixed reminder',
    'TRIGGER;VALUE=DATE-TIME:20261110T070000Z',
    'END:VALARM',
  ];
  const item = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VTODO',
    'UID:task-e1',
    'SUMMARY:Timed',
    'CREATED:20261101T080000Z',
    'LAST-MODIFIED:20261102T080000Z',
    'DTSTART:20261110T090000Z',
    'DURATION:PT1H',
    'RRULE:FREQ=DAILY;UNTIL=20261120T090000Z',
    'X-KEEP:1',
    ...startAlarm,
    ...endAlarm,
    ...absAlarm,
    'END:VTODO',
    'END:VCALENDAR',
  ].join('\r\n');

  it('keeps anchored content when only the title changes', () => {
    const out = logical(serializeTask({ ...deserializeTask(item), title: 'Timed renamed' }));

    expect(count(out, 'SUMMARY:Timed renamed')).toBe(1);
    expect(count(out, 'DTSTART:20261110T090000Z')).toBe(1);

    expect(count(out, 'DURATION:PT1H')).toBe(1);
    expect(count(out, 'RRULE:FREQ=DAILY;UNTIL=20261120T090000Z')).toBe(1);
    expect(count(out, 'X-KEEP:1')).toBe(1);
    expect(hasBlock(out, startAlarm)).toBe(true);
    expect(hasBlock(out, endAlarm)).toBe(true);
    expect(hasBlock(out, absAlarm)).toBe(true);
  });

  it('drops start-dependent content when the start date is cleared, keeping absolute alarms and other content', () => {
    const out = logical(serializeTask({ ...deserializeTask(item), start_date: null, start_ical: undefined }));

    expect(out.filter((l) => /^dtstart/i.test(l))).toEqual([]);
    expect(out.filter((l) => /^(duration|rrule)[;:]/i.test(l))).toEqual([]);
    expect(out).not.toContain('DESCRIPTION:Start reminder');
    expect(out).not.toContain('DESCRIPTION:End reminder');

    expect(count(out, 'X-KEEP:1')).toBe(1);
    expect(hasBlock(out, absAlarm)).toBe(true);
  });

  it('drops a sub-day DURATION and a date-time UNTIL when the start becomes date-only', () => {
    const out = logical(serializeTask({ ...deserializeTask(item), start_date: new Date(2026, 10, 10), start_ical: undefined }));

    expect(count(out, 'DTSTART;VALUE=DATE:20261110')).toBe(1);
    expect(out.filter((l) => /^(duration|rrule)[;:]/i.test(l))).toEqual([]);
    // RELATED=END needs DUE, or DTSTART with a written DURATION.
    expect(out).not.toContain('DESCRIPTION:End reminder');

    expect(count(out, 'X-KEEP:1')).toBe(1);
    expect(hasBlock(out, startAlarm)).toBe(true);
    expect(hasBlock(out, absAlarm)).toBe(true);
  });
});

// ── RECURRENCE-ID after task date edits (WEBX-03, RFC 5545 §3.8.4.4) ──
// A store edit that sets start_date without start_ical makes toVTodo write a
// floating local DTSTART, so a UTC RECURRENCE-ID is no longer compatible.

describe('retained RECURRENCE-ID after task date edits (WEBX-03)', () => {
  const logical = (text: string): string[] => text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const ridLines = (lines: string[]): string[] => lines.filter((l) => /^recurrence-id[;:]/i.test(l));

  const item = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VTODO',
    'UID:task-rid1',
    'SUMMARY:Moved occurrence',
    'CREATED:20261101T080000Z',
    'LAST-MODIFIED:20261102T080000Z',
    'DTSTART:20261110T090000Z',
    'RECURRENCE-ID:20261103T090000Z',
    'X-KEEP:1',
    'END:VTODO',
    'END:VCALENDAR',
  ].join('\r\n');

  it('keeps a compatible UTC RECURRENCE-ID verbatim when only the title changes', () => {
    const out = logical(serializeTask({ ...deserializeTask(item), title: 'Moved occurrence renamed' }));

    expect(out.filter((l) => /^dtstart[;:]/i.test(l))).toEqual(['DTSTART:20261110T090000Z']);

    expect(ridLines(out)).toEqual(['RECURRENCE-ID:20261103T090000Z']);
  });

  it('suppresses a UTC RECURRENCE-ID when the start is edited to a non-midnight local time', () => {
    const out = logical(serializeTask({
      ...deserializeTask(item),
      start_date: new Date(2026, 10, 10, 14, 30, 0),
      start_ical: undefined,
    }));

    // Current formatter: local wall time, no UTC designator, no TZID (floating).
    expect(out.filter((l) => /^dtstart[;:]/i.test(l))).toEqual(['DTSTART:20261110T143000']);
    expect(ridLines(out)).toEqual([]);

    expect(out.filter((l) => l === 'X-KEEP:1')).toHaveLength(1);
  });
});
