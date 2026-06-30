import { describe, expect, it } from 'vitest';
import {
  createLabelIndex,
  deserializeLabelIndex,
  getLabelSuggestions,
  mergeLabelIndexes,
  recordLabelsUsed,
  serializeLabelIndex,
} from './label-index.js';

describe('label index', () => {
  it('normalizes, serializes, and deserializes labels by case-insensitive key', () => {
    const index = createLabelIndex([
      { label: ' Work ', count: 2, lastUsedAt: 10 },
      { label: 'work', count: 5, lastUsedAt: 5 },
      { label: 'Personal', count: 1, lastUsedAt: 20 },
    ], 30);

    const restored = deserializeLabelIndex(serializeLabelIndex(index));

    expect(Object.keys(restored.labels)).toEqual(['work', 'personal']);
    expect(restored.labels.work).toMatchObject({ label: 'Work', count: 5, lastUsedAt: 10 });
    expect(restored.labels.personal).toMatchObject({ label: 'Personal', count: 1, lastUsedAt: 20 });
  });

  it('records label use without duplicating keys', () => {
    const recorded = recordLabelsUsed(createLabelIndex([], 0), ['Work', ' work ', '', 'Home'], 100);

    expect(recorded.labels.work).toMatchObject({ label: 'work', count: 2, lastUsedAt: 100 });
    expect(recorded.labels.home).toMatchObject({ label: 'Home', count: 1, lastUsedAt: 100 });
  });

  it('merges idempotently with union/max/last-used semantics', () => {
    const first = createLabelIndex([
      { label: 'Work', count: 4, lastUsedAt: 10 },
      { label: 'Home', count: 1, lastUsedAt: 5 },
    ], 10);
    const second = createLabelIndex([
      { label: 'work', count: 2, lastUsedAt: 20 },
      { label: 'Urgent', count: 3, lastUsedAt: 15 },
    ], 20);

    const once = mergeLabelIndexes([first, second]);
    const twice = mergeLabelIndexes([once, first, second]);

    expect(twice.labels.work).toMatchObject({ label: 'Work', count: 4, lastUsedAt: 20 });
    expect(twice.labels.home).toMatchObject({ label: 'Home', count: 1, lastUsedAt: 5 });
    expect(twice.labels.urgent).toMatchObject({ label: 'Urgent', count: 3, lastUsedAt: 15 });
    expect(twice).toEqual(once);
  });

  it('ranks suggestions by count, recency, and excludes selected labels', () => {
    const index = createLabelIndex([
      { label: 'Work', count: 2, lastUsedAt: 10 },
      { label: 'Workout', count: 5, lastUsedAt: 2 },
      { label: 'Personal', count: 10, lastUsedAt: 20 },
    ], 20);

    expect(getLabelSuggestions(index, 'wor', 5, ['Workout'])).toEqual(['Work']);
    expect(getLabelSuggestions(index, '', 2)).toEqual(['Personal', 'Workout']);
  });

  it('rejects documents with a different explicit kind', () => {
    expect(() => deserializeLabelIndex(JSON.stringify({ kind: 'silentsuite.preferences.v1' }))).toThrow(/kind/);
  });
});
