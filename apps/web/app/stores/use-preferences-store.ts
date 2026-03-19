import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface PreferencesState {
  timeFormat: '12h' | '24h'
  firstDayOfWeek: 'monday' | 'sunday'
  defaultReminder: string // 'none', '5', '15', '30', '60', '1440'
  notificationSound: boolean
  setTimeFormat: (format: '12h' | '24h') => void
  setFirstDayOfWeek: (day: 'monday' | 'sunday') => void
  setDefaultReminder: (value: string) => void
  setNotificationSound: (enabled: boolean) => void
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      timeFormat: '12h',
      firstDayOfWeek: 'monday',
      defaultReminder: '15',
      notificationSound: true,
      setTimeFormat: (timeFormat) => set({ timeFormat }),
      setFirstDayOfWeek: (firstDayOfWeek) => set({ firstDayOfWeek }),
      setDefaultReminder: (defaultReminder) => set({ defaultReminder }),
      setNotificationSound: (notificationSound) => set({ notificationSound }),
    }),
    {
      name: 'silentsuite-preferences',
    },
  ),
)
