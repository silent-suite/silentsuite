import { describe, expect, it } from 'vitest';
import {
  createEmptyLabelIndex,
  deserializeLabelIndex,
  mergeLabelIndexes,
  normalizeLabelIndex,
  recordLabelsUsed,
  serializeLabelIndex,
  suggestLabels,
} from './label-index.js';

describe('label index model', () => {
  it('normalizes labels case-insensitively and drops malformed entries', () => {
    const index = normalizeLabelIndex({
      version: 99,
      updatedAt: 'bad-date',
      labels: {
        Work: { label: ' Work ', count: 2.8, lastUsedAt: '2026-07-09T10:00:00Z', sources: { calendar: 2, nope: 9 } },
        work: { label: 'work', count: 5, lastUsedAt: '2026-07-09T11:00:00Z', sources: { tasks: 1 } },
        empty: { label: '   ', count: 1, lastUsedAt: '2026-07-09T10:00:00Z' },
        bad: null,
      },
    });

    expect(index.version).toBe(1);
    expect(index.updatedAt).toBe('1970-01-01T00:00:00.000Z');
    expect(Object.keys(index.labels)).toEqual(['work']);
    expect(index.labels.work).toMatchObject({
      label: 'work',
      count: 5,
      lastUsedAt: '2026-07-09T11:00:00.000Z',
      sources: { calendar: 2, tasks: 1 },
    });
  });

  it('records label usage with approximate per-source counters', () => {
    const index = recordLabelsUsed(
      createEmptyLabelIndex(),
      'calendar',
      [' Work ', 'work', 'Home'],
      new Date('2026-07-09T12:00:00Z'),
    );

    expect(Object.keys(index.labels)).toEqual(['work', 'home']);
    expect(index.labels.work).toMatchObject({
      label: 'Work',
      count: 1,
      lastUsedAt: '2026-07-09T12:00:00.000Z',
      sources: { calendar: 1 },
    });
    expect(index.labels.home?.count).toBe(1);
  });

  it('merges without count inflation by using max count and latest timestamp', () => {
    const older = recordLabelsUsed(createEmptyLabelIndex(), 'calendar', ['Work'], new Date('2026-07-09T10:00:00Z'));
    const newer = {
      version: 1,
      updatedAt: '2026-07-09T13:00:00.000Z',
      labels: {
        work: {
          label: 'WORK',
          count: 3,
          lastUsedAt: '2026-07-09T13:00:00.000Z',
          sources: { tasks: 3 },
        },
      },
    } as const;

    const merged = mergeLabelIndexes(older, newer, older);

    expect(merged.labels.work).toMatchObject({
      label: 'WORK',
      count: 3,
      lastUsedAt: '2026-07-09T13:00:00.000Z',
      sources: { calendar: 1, tasks: 3 },
    });
  });

  it('serializes and deserializes JSON safely', () => {
    const index = recordLabelsUsed(createEmptyLabelIndex(), 'contacts', ['VIP'], new Date('2026-07-09T12:00:00Z'));
    expect(deserializeLabelIndex(serializeLabelIndex(index))).toEqual(index);
    expect(deserializeLabelIndex('not json')).toBeNull();
  });

  it('suggests ranked labels while excluding existing labels', () => {
    const index = mergeLabelIndexes(
      recordLabelsUsed(createEmptyLabelIndex(), 'calendar', ['Work'], new Date('2026-07-09T10:00:00Z')),
      recordLabelsUsed(createEmptyLabelIndex(), 'tasks', ['Urgent', 'Personal'], new Date('2026-07-09T11:00:00Z')),
      recordLabelsUsed(createEmptyLabelIndex(), 'tasks', ['Urgent'], new Date('2026-07-09T12:00:00Z')),
    );

    expect(suggestLabels(index, '', ['personal'], 5)).toEqual(['Urgent', 'Work']);
    expect(suggestLabels(index, 'wo', [], 5)).toEqual(['Work']);
    expect(suggestLabels(index, '', [], 1)).toEqual(['Urgent']);
  });
});
