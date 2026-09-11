import { describe, expect, it } from 'vitest';
import {
  deserializeNote,
  isMarkdownNoteItem,
  noteFromEtebaseItem,
  noteToItemMeta,
  serializeNote,
} from './note.js';
import type { Note } from './note.js';

function makeNote(overrides?: Partial<Note>): Note {
  return {
    id: 'note-1',
    uid: 'note-1',
    title: 'Shopping list',
    content: '- [x] Apples\n- [ ] Oranges',
    notebookId: 'nb-1',
    created_at: new Date(1_700_000_000_000),
    updated_at: new Date(1_700_000_100_000),
    ...overrides,
  };
}

describe('isMarkdownNoteItem', () => {
  it('treats missing and empty type as a note', () => {
    expect(isMarkdownNoteItem(undefined)).toBe(true);
    expect(isMarkdownNoteItem(null)).toBe(true);
    expect(isMarkdownNoteItem({})).toBe(true);
    expect(isMarkdownNoteItem({ name: 'Hi', mtime: 1 })).toBe(true);
    expect(isMarkdownNoteItem({ type: null })).toBe(true);
    expect(isMarkdownNoteItem({ type: '' })).toBe(true);
  });

  it('skips items with a future type', () => {
    expect(isMarkdownNoteItem({ type: 'attachment' })).toBe(false);
  });
});

describe('noteFromEtebaseItem', () => {
  it('reads title and mtime from item meta and markdown from content', () => {
    const note = noteFromEtebaseItem(
      'abc',
      '# Hello',
      { name: 'Hello', mtime: 1_700_000_000_000 },
      'nb-1',
    );
    expect(note).toMatchObject({
      id: 'abc',
      uid: 'abc',
      title: 'Hello',
      content: '# Hello',
      notebookId: 'nb-1',
    });
    expect(note.updated_at.getTime()).toBe(1_700_000_000_000);
  });

  it('falls back to now when mtime is outside the range a Date can hold', () => {
    for (const mtime of [1e20, -1e20, 8_640_000_000_000_001, Number.NaN, Number.POSITIVE_INFINITY]) {
      const note = noteFromEtebaseItem('abc', 'body', { name: 'Hello', mtime });
      expect(Number.isNaN(note.updated_at.getTime())).toBe(false);
      expect(Number.isNaN(note.created_at.getTime())).toBe(false);
      expect(() => note.updated_at.toISOString()).not.toThrow();
    }
  });

  it('keeps mtime at the edges of the Date range', () => {
    const note = noteFromEtebaseItem('abc', 'body', { name: 'Hello', mtime: 8_640_000_000_000_000 });
    expect(note.updated_at.getTime()).toBe(8_640_000_000_000_000);
  });

  it('falls back to Untitled when name is missing', () => {
    const note = noteFromEtebaseItem('abc', 'body', {});
    expect(note.title).toBe('Untitled');
  });
});

describe('serializeNote / deserializeNote', () => {
  it('roundtrips a cache envelope without treating it as Etebase content', () => {
    const original = makeNote();
    const raw = serializeNote(original);
    expect(JSON.parse(raw)).toEqual({
      title: 'Shopping list',
      content: '- [x] Apples\n- [ ] Oranges',
      mtime: 1_700_000_100_000,
    });
    const restored = deserializeNote(raw, 'note-1', 'nb-1');
    expect(restored.title).toBe(original.title);
    expect(restored.content).toBe(original.content);
    expect(restored.notebookId).toBe('nb-1');
    expect(restored.updated_at.getTime()).toBe(original.updated_at.getTime());
  });

  it('treats raw markdown as a note body', () => {
    const restored = deserializeNote('# Draft', 'uid-2', 'nb-2');
    expect(restored.title).toBe('Untitled');
    expect(restored.content).toBe('# Draft');
    expect(restored.uid).toBe('uid-2');
  });

  it('keeps a cached note readable when its mtime is out of Date range', () => {
    for (const mtime of [1e20, -1e20, 8_640_000_000_000_001]) {
      const raw = JSON.stringify({ title: 'Cached', content: 'body', mtime });
      const restored = deserializeNote(raw, 'uid-3', 'nb-3');
      expect(restored.title).toBe('Cached');
      expect(restored.content).toBe('body');
      expect(Number.isNaN(restored.updated_at.getTime())).toBe(false);
      expect(Number.isNaN(restored.created_at.getTime())).toBe(false);
      expect(() => restored.updated_at.toISOString()).not.toThrow();
    }
  });

  it('serializes a note whose date is invalid without writing a NaN mtime', () => {
    const raw = serializeNote(makeNote({ updated_at: new Date(Number.NaN) }));
    const parsed = JSON.parse(raw) as { mtime: number };
    expect(Number.isFinite(parsed.mtime)).toBe(true);
    expect(() => deserializeNote(raw, 'uid-4').updated_at.toISOString()).not.toThrow();
  });
});

describe('noteToItemMeta', () => {
  it('omits type so the item stays a markdown note', () => {
    expect(noteToItemMeta(makeNote())).toEqual({
      name: 'Shopping list',
      mtime: 1_700_000_100_000,
    });
  });
});
