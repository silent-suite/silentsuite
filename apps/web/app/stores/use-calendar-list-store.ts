import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface CalendarList {
  id: string
  name: string
  color: string
  visible: boolean
}

const DEFAULT_COLORS = [
  '#10b981', // emerald
  '#3b82f6', // blue
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#f97316', // orange
]

interface CalendarListState {
  calendars: CalendarList[]
  defaultCalendarId: string
  addCalendar: (name: string, color?: string) => void
  removeCalendar: (id: string) => void
  updateCalendar: (id: string, updates: Partial<CalendarList>) => void
  toggleVisibility: (id: string) => void
  setDefaultCalendar: (id: string) => void
  getNextColor: () => string
}

export const useCalendarListStore = create<CalendarListState>()(
  persist(
    (set, get) => ({
      calendars: [
        { id: 'default', name: 'Personal', color: '#10b981', visible: true },
      ],
      defaultCalendarId: 'default',
      addCalendar: (name, color) => {
        const nextColor = color || get().getNextColor()
        set((state) => ({
          calendars: [
            ...state.calendars,
            {
              id: `cal_${Date.now()}`,
              name,
              color: nextColor,
              visible: true,
            },
          ],
        }))
      },
      removeCalendar: (id) => {
        if (id === 'default') return // Can't remove default
        set((state) => ({
          calendars: state.calendars.filter((c) => c.id !== id),
          // Reset default if we're removing the default calendar
          defaultCalendarId: state.defaultCalendarId === id ? 'default' : state.defaultCalendarId,
        }))
      },
      updateCalendar: (id, updates) => {
        set((state) => ({
          calendars: state.calendars.map((c) =>
            c.id === id ? { ...c, ...updates } : c,
          ),
        }))
      },
      toggleVisibility: (id) => {
        set((state) => ({
          calendars: state.calendars.map((c) =>
            c.id === id ? { ...c, visible: !c.visible } : c,
          ),
        }))
      },
      setDefaultCalendar: (id) => {
        const { calendars } = get()
        if (calendars.some((c) => c.id === id)) {
          set({ defaultCalendarId: id })
        }
      },
      getNextColor: () => {
        const { calendars } = get()
        const usedColors = new Set(calendars.map((c) => c.color))
        return DEFAULT_COLORS.find((c) => !usedColors.has(c)) || DEFAULT_COLORS[calendars.length % DEFAULT_COLORS.length]
      },
    }),
    {
      name: 'silentsuite-calendar-lists',
    },
  ),
)
