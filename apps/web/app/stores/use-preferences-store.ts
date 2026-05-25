import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  DEFAULT_SYNCED_PREFERENCES,
  createSyncedPreferences,
  getSyncedPreferenceTimestamps,
  getSyncedPreferenceValues,
  mergeSyncedPreferences,
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
  }
}

function normalizeValues(values: Partial<SyncedPreferenceValues>): SyncedPreferenceValues {
  return getSyncedPreferenceValues(createSyncedPreferences({ ...defaultSyncedValues(), ...values }, zeroTimestamps(), 0))
}

interface PreferencesState {
  timeFormat: TimeFormat
  firstDayOfWeek: FirstDayOfWeek
  defaultReminder: DefaultReminder
  notificationSound: boolean
  defaultTimezone: string // IANA timezone, e.g. 'Europe/Amsterdam'
  syncedPreferenceUpdatedAt: SyncedPreferenceTimestamps
  setTimeFormat: (format: TimeFormat) => void
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
      setTimeFormat: (timeFormat) => set((state) => ({
        timeFormat,
        syncedPreferenceUpdatedAt: { ...state.syncedPreferenceUpdatedAt, timeFormat: Date.now() },
      })),
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
          || timestamps.timeFormat !== state.syncedPreferenceUpdatedAt.timeFormat
          || timestamps.firstDayOfWeek !== state.syncedPreferenceUpdatedAt.firstDayOfWeek
          || timestamps.defaultReminder !== state.syncedPreferenceUpdatedAt.defaultReminder
          || timestamps.defaultTimezone !== state.syncedPreferenceUpdatedAt.defaultTimezone

        if (changed) {
          set({ ...values, syncedPreferenceUpdatedAt: timestamps })
        }
        return changed
      },
      resetSyncedPreferences: () => set({ ...defaultSyncedValues(), syncedPreferenceUpdatedAt: zeroTimestamps() }),
    }),
    {
      name: 'silentsuite-preferences',
    },
  ),
)
