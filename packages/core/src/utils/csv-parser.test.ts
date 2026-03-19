import { describe, it, expect, vi } from 'vitest';
import { parseTodoistCsv } from './csv-parser.js';

const HEADER = 'TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE,DURATION,DURATION_UNIT';

function makeCsv(...rows: string[]): string {
  return [HEADER, ...rows].join('\n');
}

describe('parseTodoistCsv', () => {
  it('parses a basic task', () => {
    const csv = makeCsv('task,Buy groceries,,4,1,me,,,,,,');
    const todos = parseTodoistCsv(csv);
    expect(todos).toHaveLength(1);
    expect(todos[0].summary).toBe('Buy groceries');
    expect(todos[0].status).toBe('NEEDS-ACTION');
  });

  it('returns empty array for empty input', () => {
    expect(parseTodoistCsv('')).toEqual([]);
  });

  it('returns empty array for header-only input', () => {
    expect(parseTodoistCsv(HEADER)).toEqual([]);
  });

  it('returns empty array for non-Todoist CSV', () => {
    expect(parseTodoistCsv('NAME,EMAIL\nJohn,john@example.com')).toEqual([]);
  });

  it('skips empty lines', () => {
    const csv = HEADER + '\n\n' + 'task,Do stuff,,4,1,me,,,,,,\n\n';
    const todos = parseTodoistCsv(csv);
    expect(todos).toHaveLength(1);
  });

  // Priority mapping
  describe('priority mapping', () => {
    it('maps Todoist priority 1 (highest) to iCal 1', () => {
      const csv = makeCsv('task,Urgent task,,1,1,me,,,,,,');
      expect(parseTodoistCsv(csv)[0].priority).toBe(1);
    });

    it('maps Todoist priority 2 (medium) to iCal 5', () => {
      const csv = makeCsv('task,Medium task,,2,1,me,,,,,,');
      expect(parseTodoistCsv(csv)[0].priority).toBe(5);
    });

    it('maps Todoist priority 3 (low) to iCal 9', () => {
      const csv = makeCsv('task,Low task,,3,1,me,,,,,,');
      expect(parseTodoistCsv(csv)[0].priority).toBe(9);
    });

    it('maps Todoist priority 4 (none) to iCal 0', () => {
      const csv = makeCsv('task,Normal task,,4,1,me,,,,,,');
      expect(parseTodoistCsv(csv)[0].priority).toBe(0);
    });
  });

  // Date parsing
  describe('date parsing', () => {
    it('parses ISO date format (YYYY-MM-DD)', () => {
      const csv = makeCsv('task,Task with date,,4,1,me,,2025-10-15,,,,');
      expect(parseTodoistCsv(csv)[0].due).toBe('20251015');
    });

    it('parses ISO datetime format', () => {
      const csv = makeCsv('task,Task with time,,4,1,me,,2025-10-15 14:30,,,,');
      expect(parseTodoistCsv(csv)[0].due).toBe('20251015T143000');
    });

    it('parses named month format (Mon DD YYYY)', () => {
      const csv = makeCsv('task,Task with date,,4,1,me,,Oct 15 2025,,,,');
      expect(parseTodoistCsv(csv)[0].due).toBe('20251015');
    });

    it('parses named month format with time', () => {
      const csv = makeCsv('task,Task with time,,4,1,me,,Oct 15 2025 14:30,,,,');
      expect(parseTodoistCsv(csv)[0].due).toBe('20251015T143000');
    });

    it('handles empty date field', () => {
      const csv = makeCsv('task,No date task,,4,1,me,,,,,,');
      expect(parseTodoistCsv(csv)[0].due).toBeUndefined();
    });

    it('handles single-digit day', () => {
      const csv = makeCsv('task,Task,,4,1,me,,Jan 5 2025,,,,');
      expect(parseTodoistCsv(csv)[0].due).toBe('20250105');
    });
  });

  // Completed tasks
  describe('completed tasks', () => {
    it('sets status to COMPLETED for completed tasks', () => {
      const csv = makeCsv('completed,Done task,,4,1,me,,2025-10-15,,,,');
      const todo = parseTodoistCsv(csv)[0];
      expect(todo.status).toBe('COMPLETED');
      expect(todo.completed).toBeDefined();
    });

    it('sets status to NEEDS-ACTION for active tasks', () => {
      const csv = makeCsv('task,Active task,,4,1,me,,,,,,');
      expect(parseTodoistCsv(csv)[0].status).toBe('NEEDS-ACTION');
      expect(parseTodoistCsv(csv)[0].completed).toBeUndefined();
    });
  });

  // Sub-tasks
  describe('sub-tasks', () => {
    it('prefixes sub-tasks (indent > 1) with → ', () => {
      const csv = makeCsv(
        'task,Parent task,,4,1,me,,,,,,',
        'task,Child task,,4,2,me,,,,,,',
        'task,Grandchild,,4,3,me,,,,,,'
      );
      const todos = parseTodoistCsv(csv);
      expect(todos).toHaveLength(3);
      expect(todos[0].summary).toBe('Parent task');
      expect(todos[1].summary).toBe('→ Child task');
      expect(todos[2].summary).toBe('→ Grandchild');
    });
  });

  // UTF-8 special characters
  describe('UTF-8 support', () => {
    it('handles UTF-8 characters in task names', () => {
      const csv = makeCsv('task,Ärztetermin bücher,,4,1,me,,,,,,');
      expect(parseTodoistCsv(csv)[0].summary).toBe('Ärztetermin bücher');
    });

    it('handles emoji in task names', () => {
      const csv = makeCsv('task,🎉 Party planen,,4,1,me,,,,,,');
      expect(parseTodoistCsv(csv)[0].summary).toBe('🎉 Party planen');
    });

    it('handles CJK characters', () => {
      const csv = makeCsv('task,買い物リスト,,4,1,me,,,,,,');
      expect(parseTodoistCsv(csv)[0].summary).toBe('買い物リスト');
    });
  });

  // Quoted fields
  describe('quoted CSV fields', () => {
    it('handles commas inside quoted fields', () => {
      const csv = makeCsv('task,"Buy eggs, milk, bread",,4,1,me,,,,,,');
      expect(parseTodoistCsv(csv)[0].summary).toBe('Buy eggs, milk, bread');
    });

    it('handles escaped quotes inside quoted fields', () => {
      const csv = makeCsv('task,"Task with ""quotes""",,4,1,me,,,,,,');
      expect(parseTodoistCsv(csv)[0].summary).toBe('Task with "quotes"');
    });

    it('handles quoted description field', () => {
      const csv = makeCsv('task,My Task,"A longer description, with commas",4,1,me,,,,,,');
      const todo = parseTodoistCsv(csv)[0];
      expect(todo.summary).toBe('My Task');
      expect(todo.description).toBe('A longer description, with commas');
    });
  });

  // UIDs
  describe('UID generation', () => {
    it('generates unique UIDs for each task', () => {
      const csv = makeCsv(
        'task,Task 1,,4,1,me,,,,,,',
        'task,Task 2,,4,1,me,,,,,,'
      );
      const todos = parseTodoistCsv(csv);
      expect(todos[0].uid).toBeTruthy();
      expect(todos[1].uid).toBeTruthy();
      expect(todos[0].uid).not.toBe(todos[1].uid);
    });
  });

  // Windows line endings
  it('handles Windows-style line endings (CRLF)', () => {
    const csv = HEADER + '\r\n' + 'task,CRLF task,,4,1,me,,,,,,\r\n';
    const todos = parseTodoistCsv(csv);
    expect(todos).toHaveLength(1);
    expect(todos[0].summary).toBe('CRLF task');
  });

  // Multiple tasks end-to-end
  it('parses a realistic multi-task export', () => {
    const csv = makeCsv(
      'task,Plan vacation,"Research destinations",2,1,me,,Oct 15 2025,,,,',
      'task,Book flights,,1,2,me,,2025-11-01,,,,',
      'completed,Pack bags,,4,2,me,,2025-10-30,,,,',
    );
    const todos = parseTodoistCsv(csv);
    expect(todos).toHaveLength(3);

    expect(todos[0].summary).toBe('Plan vacation');
    expect(todos[0].description).toBe('Research destinations');
    expect(todos[0].priority).toBe(5);
    expect(todos[0].due).toBe('20251015');
    expect(todos[0].status).toBe('NEEDS-ACTION');

    expect(todos[1].summary).toBe('→ Book flights');
    expect(todos[1].priority).toBe(1);
    expect(todos[1].due).toBe('20251101');

    expect(todos[2].summary).toBe('→ Pack bags');
    expect(todos[2].status).toBe('COMPLETED');
  });
});
