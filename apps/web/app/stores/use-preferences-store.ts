import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface PreferencesState {
  timeFormat: '12h' | '24h'
  firstDayOfWeek: 'monday' | 'sunday'
  defaultReminder: string // 'none', '5', '15', '30', '60', '1440'
  notificationSound: boolean
  defaultTimezone: string // IANA timezone, e.g. 'Europe/Amsterdam'
  setTimeFormat: (format: '12h' | '24h') => void
  setFirstDayOfWeek: (day: 'monday' | 'sunday') => void
  setDefaultReminder: (value: string) => void
  setNotificationSound: (enabled: boolean) => void
  setDefaultTimezone: (tz: string) => void
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      timeFormat: '12h',
      firstDayOfWeek: 'monday',
      defaultReminder: '15',
      notificationSound: true,
      defaultTimezone: typeof window !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC',
      setTimeFormat: (timeFormat) => set({ timeFormat }),
      setFirstDayOfWeek: (firstDayOfWeek) => set({ firstDayOfWeek }),
      setDefaultReminder: (defaultReminder) => set({ defaultReminder }),
      setNotificationSound: (notificationSound) => set({ notificationSound }),
      setDefaultTimezone: (defaultTimezone) => set({ defaultTimezone }),
    }),
    {
      name: 'silentsuite-preferences',
    },
  ),
)
