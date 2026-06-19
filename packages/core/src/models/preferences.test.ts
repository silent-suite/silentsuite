import { describe, expect, it } from 'vitest';
import {
  createSyncedPreferences,
  deserializePreferences,
  getSyncedPreferenceValues,
  mergeSyncedPreferences,
  serializePreferences,
} from './preferences.js';

describe('synced preferences', () => {
  it('serializes only synced account preferences', () => {
    const preferences = createSyncedPreferences(
      {
        timeFormat: '24h',
        firstDayOfWeek: 'sunday',
        defaultReminder: '30',
        defaultTimezone: 'Europe/Amsterdam',
      },
      {
        timeFormat: 10,
        firstDayOfWeek: 11,
        defaultReminder: 12,
        defaultTimezone: 13,
      },
      99,
    );

    const serialized = serializePreferences(preferences);
    const restored = deserializePreferences(serialized);

    expect(serialized).not.toContain('notificationSound');
    expect(getSyncedPreferenceValues(restored)).toEqual({
      timeFormat: '24h',
      firstDayOfWeek: 'sunday',
      defaultReminder: '30',
      defaultTimezone: 'Europe/Amsterdam',
      dateFormat: 'system',
    });
    expect(restored.updatedAt).toBe(99);
  });

  it('normalizes invalid remote values to safe defaults', () => {
    const restored = deserializePreferences(JSON.stringify({
      schemaVersion: 1,
      updatedAt: 20,
      fields: {
        timeFormat: { value: 'military', updatedAt: 1 },
        firstDayOfWeek: { value: 'friday', updatedAt: 2 },
        defaultReminder: { value: '999', updatedAt: 3 },
        defaultTimezone: { value: '', updatedAt: 4 },
      },
    }));

    expect(getSyncedPreferenceValues(restored)).toEqual({
      timeFormat: '12h',
      firstDayOfWeek: 'monday',
      defaultReminder: '15',
      defaultTimezone: 'UTC',
      dateFormat: 'system',
    });
  });

  it('merges by newest timestamp per field', () => {
    const first = createSyncedPreferences(
      {
        timeFormat: '24h',
        firstDayOfWeek: 'monday',
        defaultReminder: '15',
        defaultTimezone: 'UTC',
      },
      {
        timeFormat: 10,
        firstDayOfWeek: 10,
        defaultReminder: 10,
        defaultTimezone: 1,
      },
      10,
    );
    const second = createSyncedPreferences(
      {
        timeFormat: '12h',
        firstDayOfWeek: 'sunday',
        defaultReminder: '60',
        defaultTimezone: 'Europe/Amsterdam',
      },
      {
        timeFormat: 5,
        firstDayOfWeek: 20,
        defaultReminder: 20,
        defaultTimezone: 20,
      },
      20,
    );

    expect(getSyncedPreferenceValues(mergeSyncedPreferences([first, second]))).toEqual({
      timeFormat: '24h',
      firstDayOfWeek: 'sunday',
      defaultReminder: '60',
      defaultTimezone: 'Europe/Amsterdam',
      dateFormat: 'system',
    });
  });
});
