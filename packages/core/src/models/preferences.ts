export const PREFERENCES_KIND = 'silentsuite.preferences.v1';

export const SYNCED_PREFERENCE_KEYS = [
  'timeFormat',
  'firstDayOfWeek',
  'defaultReminder',
  'defaultTimezone',
  'dateFormat',
  'dayStartHour',
  'dayEndHour',
] as const;

export type SyncedPreferenceKey = typeof SYNCED_PREFERENCE_KEYS[number];
export type TimeFormat = '12h' | '24h';
export type FirstDayOfWeek = 'monday' | 'sunday';
export type DefaultReminder = 'none' | '5' | '15' | '30' | '60' | '1440';
export type DateFormat = 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD' | 'system'
export type DayBoundaryHour = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24;

export interface SyncedPreferenceValues {
  timeFormat: TimeFormat;
  firstDayOfWeek: FirstDayOfWeek;
  defaultReminder: DefaultReminder;
  defaultTimezone: string;
  dateFormat: DateFormat;
  dayStartHour: DayBoundaryHour;
  dayEndHour: DayBoundaryHour;
}

export interface VersionedPreference<T> {
  value: T;
  updatedAt: number;
}

export interface SyncedPreferencesV1 {
  kind: typeof PREFERENCES_KIND;
  schemaVersion: 1;
  updatedAt: number;
  fields: {
    timeFormat: VersionedPreference<TimeFormat>;
    firstDayOfWeek: VersionedPreference<FirstDayOfWeek>;
    defaultReminder: VersionedPreference<DefaultReminder>;
    defaultTimezone: VersionedPreference<string>;
    dateFormat: VersionedPreference<DateFormat>;
    dayStartHour: VersionedPreference<DayBoundaryHour>;
    dayEndHour: VersionedPreference<DayBoundaryHour>;
  };
}

export type SyncedPreferenceTimestamps = Record<SyncedPreferenceKey, number>;

export const DEFAULT_SYNCED_PREFERENCES: SyncedPreferenceValues = {
  timeFormat: '12h',
  firstDayOfWeek: 'monday',
  defaultReminder: '15',
  defaultTimezone: 'UTC',
  dateFormat: 'system',
  dayStartHour: 7,
  dayEndHour: 23,
};

const DEFAULT_TIMESTAMPS: SyncedPreferenceTimestamps = {
  timeFormat: 0,
  firstDayOfWeek: 0,
  defaultReminder: 0,
  defaultTimezone: 0,
  dateFormat: 0,
  dayStartHour: 0,
  dayEndHour: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function timeFormat(value: unknown, fallback: TimeFormat): TimeFormat {
  return value === '12h' || value === '24h' ? value : fallback;
}

function firstDayOfWeek(value: unknown, fallback: FirstDayOfWeek): FirstDayOfWeek {
  return value === 'monday' || value === 'sunday' ? value : fallback;
}

function defaultReminder(value: unknown, fallback: DefaultReminder): DefaultReminder {
  return value === 'none' || value === '5' || value === '15' || value === '30' || value === '60' || value === '1440'
    ? value
    : fallback;
}

function defaultTimezone(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function dateFormat(value: unknown, fallback: DateFormat): DateFormat {
  return value === 'DD/MM/YYYY' || value === 'MM/DD/YYYY' || value === 'YYYY-MM-DD' || value === 'system' ? value : fallback
}

function dayBoundaryHour(value: unknown, fallback: DayBoundaryHour): DayBoundaryHour {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 24
    ? value as DayBoundaryHour
    : fallback;
}

function normalizeDayBounds(start: DayBoundaryHour, end: DayBoundaryHour): { dayStartHour: DayBoundaryHour; dayEndHour: DayBoundaryHour } {
  if (start < end) return { dayStartHour: start, dayEndHour: end };
  return {
    dayStartHour: DEFAULT_SYNCED_PREFERENCES.dayStartHour,
    dayEndHour: DEFAULT_SYNCED_PREFERENCES.dayEndHour,
  };
}

function valuesWithDefaults(values: Partial<SyncedPreferenceValues> = {}): SyncedPreferenceValues {
  const dayBounds = normalizeDayBounds(
    dayBoundaryHour(values.dayStartHour, DEFAULT_SYNCED_PREFERENCES.dayStartHour),
    dayBoundaryHour(values.dayEndHour, DEFAULT_SYNCED_PREFERENCES.dayEndHour),
  );
  return {
    timeFormat: timeFormat(values.timeFormat, DEFAULT_SYNCED_PREFERENCES.timeFormat),
    firstDayOfWeek: firstDayOfWeek(values.firstDayOfWeek, DEFAULT_SYNCED_PREFERENCES.firstDayOfWeek),
    defaultReminder: defaultReminder(values.defaultReminder, DEFAULT_SYNCED_PREFERENCES.defaultReminder),
    defaultTimezone: defaultTimezone(values.defaultTimezone, DEFAULT_SYNCED_PREFERENCES.defaultTimezone),
    dateFormat: dateFormat(values.dateFormat, DEFAULT_SYNCED_PREFERENCES.dateFormat),
    ...dayBounds,
  };
}

export function createSyncedPreferences(
  values: Partial<SyncedPreferenceValues> = {},
  timestamps: Partial<SyncedPreferenceTimestamps> = {},
  now = Date.now(),
): SyncedPreferencesV1 {
  const normalizedValues = valuesWithDefaults(values);
  const normalizedTimestamps: SyncedPreferenceTimestamps = {
    timeFormat: timestamp(timestamps.timeFormat, now),
    firstDayOfWeek: timestamp(timestamps.firstDayOfWeek, now),
    defaultReminder: timestamp(timestamps.defaultReminder, now),
    defaultTimezone: timestamp(timestamps.defaultTimezone, now),
    dateFormat: timestamp(timestamps.dateFormat, now),
    dayStartHour: timestamp(timestamps.dayStartHour, now),
    dayEndHour: timestamp(timestamps.dayEndHour, now),
  };
  const updatedAt = Math.max(...SYNCED_PREFERENCE_KEYS.map((key) => normalizedTimestamps[key]));

  return {
    kind: PREFERENCES_KIND,
    schemaVersion: 1,
    updatedAt,
    fields: {
      timeFormat: { value: normalizedValues.timeFormat, updatedAt: normalizedTimestamps.timeFormat },
      firstDayOfWeek: { value: normalizedValues.firstDayOfWeek, updatedAt: normalizedTimestamps.firstDayOfWeek },
      defaultReminder: { value: normalizedValues.defaultReminder, updatedAt: normalizedTimestamps.defaultReminder },
      defaultTimezone: { value: normalizedValues.defaultTimezone, updatedAt: normalizedTimestamps.defaultTimezone },
      dateFormat: { value: normalizedValues.dateFormat, updatedAt: normalizedTimestamps.dateFormat },
      dayStartHour: { value: normalizedValues.dayStartHour, updatedAt: normalizedTimestamps.dayStartHour },
      dayEndHour: { value: normalizedValues.dayEndHour, updatedAt: normalizedTimestamps.dayEndHour },
    },
  };
}

export function normalizeSyncedPreferences(input: unknown): SyncedPreferencesV1 {
  const root = isRecord(input) ? input : {};
  if ('kind' in root && root.kind !== PREFERENCES_KIND) {
    throw new Error('Invalid preferences kind');
  }
  const fields = isRecord(root.fields) ? root.fields : {};
  const rootUpdatedAt = timestamp(root.updatedAt, 0);

  const timeFormatField = isRecord(fields.timeFormat) ? fields.timeFormat : {};
  const firstDayField = isRecord(fields.firstDayOfWeek) ? fields.firstDayOfWeek : {};
  const reminderField = isRecord(fields.defaultReminder) ? fields.defaultReminder : {};
  const timezoneField = isRecord(fields.defaultTimezone) ? fields.defaultTimezone : {};
  const dateFormatField = isRecord(fields.dateFormat) ? fields.dateFormat : {};
  const dayStartHourField = isRecord(fields.dayStartHour) ? fields.dayStartHour : {};
  const dayEndHourField = isRecord(fields.dayEndHour) ? fields.dayEndHour : {};

  return createSyncedPreferences(
    {
      timeFormat: timeFormat(timeFormatField.value, DEFAULT_SYNCED_PREFERENCES.timeFormat),
      firstDayOfWeek: firstDayOfWeek(firstDayField.value, DEFAULT_SYNCED_PREFERENCES.firstDayOfWeek),
      defaultReminder: defaultReminder(reminderField.value, DEFAULT_SYNCED_PREFERENCES.defaultReminder),
      defaultTimezone: defaultTimezone(timezoneField.value, DEFAULT_SYNCED_PREFERENCES.defaultTimezone),
      dateFormat: dateFormat(dateFormatField.value, DEFAULT_SYNCED_PREFERENCES.dateFormat),
      ...normalizeDayBounds(
        dayBoundaryHour(dayStartHourField.value, DEFAULT_SYNCED_PREFERENCES.dayStartHour),
        dayBoundaryHour(dayEndHourField.value, DEFAULT_SYNCED_PREFERENCES.dayEndHour),
      ),
    },
    {
      timeFormat: timestamp(timeFormatField.updatedAt, rootUpdatedAt),
      firstDayOfWeek: timestamp(firstDayField.updatedAt, rootUpdatedAt),
      defaultReminder: timestamp(reminderField.updatedAt, rootUpdatedAt),
      defaultTimezone: timestamp(timezoneField.updatedAt, rootUpdatedAt),
      dateFormat: timestamp(dateFormatField.updatedAt, rootUpdatedAt),
      dayStartHour: timestamp(dayStartHourField.updatedAt, rootUpdatedAt),
      dayEndHour: timestamp(dayEndHourField.updatedAt, rootUpdatedAt),
    },
    0,
  );
}

export function getSyncedPreferenceValues(preferences: SyncedPreferencesV1): SyncedPreferenceValues {
  const normalized = normalizeSyncedPreferences(preferences);
  return {
    timeFormat: normalized.fields.timeFormat.value,
    firstDayOfWeek: normalized.fields.firstDayOfWeek.value,
    defaultReminder: normalized.fields.defaultReminder.value,
    defaultTimezone: normalized.fields.defaultTimezone.value,
    dateFormat: normalized.fields.dateFormat.value,
    dayStartHour: normalized.fields.dayStartHour.value,
    dayEndHour: normalized.fields.dayEndHour.value,
  };
}

export function getSyncedPreferenceTimestamps(preferences: SyncedPreferencesV1): SyncedPreferenceTimestamps {
  const normalized = normalizeSyncedPreferences(preferences);
  return {
    timeFormat: normalized.fields.timeFormat.updatedAt,
    firstDayOfWeek: normalized.fields.firstDayOfWeek.updatedAt,
    defaultReminder: normalized.fields.defaultReminder.updatedAt,
    defaultTimezone: normalized.fields.defaultTimezone.updatedAt,
    dateFormat: normalized.fields.dateFormat.updatedAt,
    dayStartHour: normalized.fields.dayStartHour.updatedAt,
    dayEndHour: normalized.fields.dayEndHour.updatedAt,
  };
}

export function mergeSyncedPreferences(preferences: SyncedPreferencesV1[]): SyncedPreferencesV1 {
  let merged = createSyncedPreferences(DEFAULT_SYNCED_PREFERENCES, DEFAULT_TIMESTAMPS, 0);

  for (const preference of preferences) {
    const normalized = normalizeSyncedPreferences(preference);
    const nextValues = getSyncedPreferenceValues(merged);
    const nextTimestamps = getSyncedPreferenceTimestamps(merged);

    for (const key of SYNCED_PREFERENCE_KEYS) {
      const incoming = normalized.fields[key];
      if (incoming.updatedAt >= nextTimestamps[key]) {
        nextValues[key] = incoming.value as never;
        nextTimestamps[key] = incoming.updatedAt;
      }
    }

    merged = createSyncedPreferences(nextValues, nextTimestamps, 0);
  }

  return merged;
}

export function serializePreferences(preferences: SyncedPreferencesV1): string {
  return JSON.stringify(normalizeSyncedPreferences(preferences));
}

export function deserializePreferences(content: string): SyncedPreferencesV1 {
  return normalizeSyncedPreferences(JSON.parse(content) as unknown);
}
