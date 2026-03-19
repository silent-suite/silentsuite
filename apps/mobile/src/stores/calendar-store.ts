import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { CalendarEvent } from '@silentsuite/core';
import { mmkvStorage } from './mmkv-storage';

interface CalendarState {
  events: CalendarEvent[];
  isLoading: boolean;
  selectedDate: Date;

  setEvents: (events: CalendarEvent[]) => void;
  addEvent: (event: CalendarEvent) => void;
  updateEvent: (id: string, event: Partial<CalendarEvent>) => void;
  removeEvent: (id: string) => void;
  setSelectedDate: (date: Date) => void;
}

export const useCalendarStore = create<CalendarState>()(
  persist(
    (set) => ({
      events: [],
      isLoading: false,
      selectedDate: new Date(),

      setEvents: (events) => set({ events }),
      addEvent: (event) => set((s) => ({ events: [...s.events, event] })),
      updateEvent: (id, updates) =>
        set((s) => ({
          events: s.events.map((e) => (e.id === id ? { ...e, ...updates } : e)),
        })),
      removeEvent: (id) => set((s) => ({ events: s.events.filter((e) => e.id !== id) })),
      setSelectedDate: (date) => set({ selectedDate: date }),
    }),
    {
      name: 'silentsuite-calendar',
      storage: createJSONStorage(() => mmkvStorage),
      partialize: (state) => ({ events: state.events, selectedDate: state.selectedDate }),
    },
  ),
);
