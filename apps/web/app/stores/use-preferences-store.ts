import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  DEFAULT_SYNCED_PREFERENCES,
  createSyncedPreferences,
  getSyncedPreferenceTimestamps,
  getSyncedPreferenceValues,
  mergeSyncedPreferences,
  type DayBoundaryHour,
  type DefaultReminder,
  type FirstDayOfWeek,
  type SyncedPreferencesV1,
  type SyncedPreferenceTimestamps,
  type SyncedPreferenceValues,
  type TimeFormat,
} from '@silentsuite/core'

function getSystemTimezone(): string {
  return typeof window !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC'
}

function defaultSyncedValues(): SyncedPreferenceValues {
  return {
    ...DEFAULT_SYNCED_PREFERENCES,
    defaultTimezone: getSystemTimezone(),
  }
}

function zeroTimestamps(): SyncedPreferenceTimestamps {
  return {
    timeFormat: 0,
    firstDayOfWeek: 0,
    defaultReminder: 0,
    defaultTimezone: 0,
    dateFormat: 0,
    dayStartHour: 0,
    dayEndHour: 0,
  }
}

function normalizeValues(values: Partial<SyncedPreferenceValues>): SyncedPreferenceValues {
  return getSyncedPreferenceValues(createSyncedPreferences({ ...defaultSyncedValues(), ...values }, zeroTimestamps(), 0))
}

interface PersistedPreferencesState extends Partial<SyncedPreferenceValues> {
  syncedPreferenceUpdatedAt?: Partial<SyncedPreferenceTimestamps>
}

function migrateStoredPreferences(persisted: unknown): unknown {
  if (!persisted || typeof persisted !== 'object') return persisted
  const root = persisted as { state?: PersistedPreferencesState }
  const state = root.state
  if (!state) return persisted

  const dayStartWasOldDefault = state.dayStartHour === 0
  const dayEndWasOldDefault = state.dayEndHour === 24
  const dayBoundsWereNeverChanged =
    (state.syncedPreferenceUpdatedAt?.dayStartHour ?? 0) === 0
    && (state.syncedPreferenceUpdatedAt?.dayEndHour ?? 0) === 0

  if (dayStartWasOldDefault && dayEndWasOldDefault && dayBoundsWereNeverChanged) {
    root.state = {
      ...state,
      dayStartHour: DEFAULT_SYNCED_PREFERENCES.dayStartHour,
      dayEndHour: DEFAULT_SYNCED_PREFERENCES.dayEndHour,
    }
  }

  return root
}

interface PreferencesState {
  timeFormat: TimeFormat
  firstDayOfWeek: FirstDayOfWeek
  defaultReminder: DefaultReminder
  notificationSound: boolean
  defaultTimezone: string // IANA timezone, e.g. 'Europe/Amsterdam'
  dateFormat: import('@silentsuite/core').DateFormat
  dayStartHour: DayBoundaryHour
  dayEndHour: DayBoundaryHour
  syncedPreferenceUpdatedAt: SyncedPreferenceTimestamps
  setTimeFormat: (format: TimeFormat) => void
  setDateFormat: (format: import('@silentsuite/core').DateFormat) => void
  setDayBounds: (start: DayBoundaryHour, end: DayBoundaryHour) => void
  setFirstDayOfWeek: (day: FirstDayOfWeek) => void
  setDefaultReminder: (value: DefaultReminder) => void
  setNotificationSound: (enabled: boolean) => void
  setDefaultTimezone: (tz: string) => void
  toSyncedPreferences: () => SyncedPreferencesV1
  applySyncedPreferences: (preferences: SyncedPreferencesV1) => boolean
  resetSyncedPreferences: () => void
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set, get) => ({
      ...defaultSyncedValues(),
      notificationSound: true,
      syncedPreferenceUpdatedAt: zeroTimestamps(),
      setDateFormat: (dateFormat) => set((state) => ({
        dateFormat,
        syncedPreferenceUpdatedAt: { ...state.syncedPreferenceUpdatedAt, dateFormat: Date.now() },
      })),
      setTimeFormat: (timeFormat) => set((state) => ({
        timeFormat,
        syncedPreferenceUpdatedAt: { ...state.syncedPreferenceUpdatedAt, timeFormat: Date.now() },
      })),
      setDayBounds: (start, end) => set((state) => {
        const { dayStartHour, dayEndHour } = normalizeValues({ dayStartHour: start, dayEndHour: end })
        const now = Date.now()
        return {
          dayStartHour,
          dayEndHour,
          syncedPreferenceUpdatedAt: {
            ...state.syncedPreferenceUpdatedAt,
            dayStartHour: now,
            dayEndHour: now,
          },
        }
      }),
      setFirstDayOfWeek: (firstDayOfWeek) => set((state) => ({
        firstDayOfWeek,
        syncedPreferenceUpdatedAt: { ...state.syncedPreferenceUpdatedAt, firstDayOfWeek: Date.now() },
      })),
      setDefaultReminder: (value) => set((state) => {
        const { defaultReminder } = normalizeValues({ defaultReminder: value })
        return {
          defaultReminder,
          syncedPreferenceUpdatedAt: { ...state.syncedPreferenceUpdatedAt, defaultReminder: Date.now() },
        }
      }),
      setNotificationSound: (notificationSound) => set({ notificationSound }),
      setDefaultTimezone: (value) => set((state) => {
        const { defaultTimezone } = normalizeValues({ defaultTimezone: value })
        return {
          defaultTimezone,
          syncedPreferenceUpdatedAt: { ...state.syncedPreferenceUpdatedAt, defaultTimezone: Date.now() },
        }
      }),
      toSyncedPreferences: () => {
        const state = get()
        return createSyncedPreferences(
          {
            timeFormat: state.timeFormat,
            firstDayOfWeek: state.firstDayOfWeek,
            defaultReminder: state.defaultReminder,
            defaultTimezone: state.defaultTimezone,
            dateFormat: (state as any).dateFormat,
            dayStartHour: state.dayStartHour,
            dayEndHour: state.dayEndHour,
          },
          state.syncedPreferenceUpdatedAt,
          0,
        )
      },
      applySyncedPreferences: (preferences) => {
        const state = get()
        const merged = mergeSyncedPreferences([state.toSyncedPreferences(), preferences])
        const values = getSyncedPreferenceValues(merged)
        const timestamps = getSyncedPreferenceTimestamps(merged)
        const changed = values.timeFormat !== state.timeFormat
          || values.firstDayOfWeek !== state.firstDayOfWeek
          || values.defaultReminder !== state.defaultReminder
          || values.defaultTimezone !== state.defaultTimezone
          || values.dateFormat !== (state as any).dateFormat
          || values.dayStartHour !== state.dayStartHour
          || values.dayEndHour !== state.dayEndHour
          || timestamps.timeFormat !== state.syncedPreferenceUpdatedAt.timeFormat
          || timestamps.firstDayOfWeek !== state.syncedPreferenceUpdatedAt.firstDayOfWeek
          || timestamps.defaultReminder !== state.syncedPreferenceUpdatedAt.defaultReminder
          || timestamps.defaultTimezone !== state.syncedPreferenceUpdatedAt.defaultTimezone
          || timestamps.dateFormat !== state.syncedPreferenceUpdatedAt.dateFormat
          || timestamps.dayStartHour !== state.syncedPreferenceUpdatedAt.dayStartHour
          || timestamps.dayEndHour !== state.syncedPreferenceUpdatedAt.dayEndHour

        if (changed) {
          set({ ...values, syncedPreferenceUpdatedAt: timestamps })
        }
        return changed
      },
      resetSyncedPreferences: () => set({ ...defaultSyncedValues(), syncedPreferenceUpdatedAt: zeroTimestamps() }),
    }),
    {
      name: 'silentsuite-preferences',
      version: 2,
      migrate: migrateStoredPreferences,
    },
  ),
)
