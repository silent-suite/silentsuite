'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import type { CalendarEvent, SyncStatus, VAlarm } from '@silentsuite/core'
import type { RecurrenceScope } from '@/app/(app)/calendar/components/RecurrenceScopeDialog'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'

type CalendarView = 'week' | 'month'

interface NewCalendarEvent {
  title: string
  description?: string
  location?: string
  startDate: Date
  endDate: Date
  allDay?: boolean
  recurrenceRule?: string | null
  alarms?: VAlarm[]
  calendarId?: string
}

interface CalendarState {
  events: CalendarEvent[]
  isLoading: boolean
  syncStatus: SyncStatus
  currentView: CalendarView
  currentDate: Date
  selectedEventId: string | null
}

interface CalendarActions {
  createEvent: (event: NewCalendarEvent) => Promise<CalendarEvent>
  updateEvent: (id: string, patch: Partial<CalendarEvent>) => Promise<void>
  deleteEvent: (id: string) => Promise<void>
  updateRecurringEvent: (
    id: string,
    patch: Partial<CalendarEvent>,
    scope: RecurrenceScope,
    instanceDate: Date,
  ) => Promise<void>
  deleteRecurringEvent: (
    id: string,
    scope: RecurrenceScope,
    instanceDate: Date,
  ) => Promise<void>
  setCurrentView: (view: CalendarView) => void
  setCurrentDate: (date: Date) => void
  setSelectedEvent: (id: string | null) => void
  navigateForward: () => void
  navigateBackward: () => void
  navigateToday: () => void
  syncFromRemote: (events: CalendarEvent[]) => void
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date)
  result.setDate(result.getDate() + days)
  return result
}

function addMonths(date: Date, months: number): Date {
  const result = new Date(date)
  result.setMonth(result.getMonth() + months)
  return result
}

/** Format a Date as YYYYMMDD for RRULE UNTIL */
function formatUntilDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

/** Add UNTIL to an existing RRULE, replacing any existing UNTIL or COUNT */
function addUntilToRRule(rrule: string, untilDate: Date): string {
  const parts = rrule.split(';').filter(
    (p) => !p.startsWith('UNTIL=') && !p.startsWith('COUNT='),
  )
  parts.push(`UNTIL=${formatUntilDate(untilDate)}`)
  return parts.join(';')
}

/** Sync a single event to Etebase (used by create/update helpers) */
async function syncEventToEtebase(event: CalendarEvent, mode: 'create' | 'update', tempId?: string): Promise<string | null> {
  const etebase = useEtebaseStore.getState()
  if (!etebase.account) return null

  try {
    const { serializeCalendarEvent } = await import('@silentsuite/core')
    const content = serializeCalendarEvent(event)
    if (mode === 'create') {
      return await etebase.createItem('calendar', content, tempId)
    } else {
      // For updates of offline-created items, enqueue with tempId for compaction
      const itemInCache = etebase.itemCache.has(event.id)
      if (itemInCache) {
        await etebase.updateItem('calendar', event.id, content)
        return event.id
      } else {
        const { enqueue } = await import('@/app/lib/offline-queue')
        await enqueue({ type: 'update', collectionType: 'calendar', content, tempId: event.id })
        return event.id
      }
    }
  } catch (err) {
    console.error(`[calendar-store] Failed to ${mode} event in Etebase:`, err)
    return null
  }
}

export const useCalendarStore = create<CalendarState & CalendarActions>()(persist((set, get) => ({
  events: [],
  isLoading: false,
  syncStatus: 'synced' as SyncStatus,
  currentView: 'week',
  currentDate: new Date(),
  selectedEventId: null,

  createEvent: async (newEvent: NewCalendarEvent) => {
    const tempId = crypto.randomUUID()
    const now = new Date()
    const event: CalendarEvent = {
      id: tempId,
      uid: tempId,
      title: newEvent.title,
      description: newEvent.description ?? '',
      location: newEvent.location ?? '',
      startDate: newEvent.startDate,
      endDate: newEvent.endDate,
      allDay: newEvent.allDay ?? false,
      recurrenceRule: newEvent.recurrenceRule ?? null,
      exceptions: [],
      alarms: newEvent.alarms ?? [],
      calendarId: newEvent.calendarId ?? 'default',
      created: now,
      updated: now,
    }

    // Optimistic local update
    set((state) => ({ events: [...state.events, event] }))

    // Sync to Etebase (pass tempId for offline queue mapping)
    const itemUid = await syncEventToEtebase(event, 'create', tempId)
    if (itemUid) {
      set((state) => ({
        events: state.events.map((e) =>
          e.id === tempId ? { ...e, id: itemUid, uid: itemUid } : e,
        ),
      }))
      return { ...event, id: itemUid, uid: itemUid }
    }

    return event
  },

  updateEvent: async (id: string, patch: Partial<CalendarEvent>) => {
    const { events } = get()
    const index = events.findIndex((e) => e.id === id)
    if (index === -1) return

    // Optimistic update
    const updated = { ...events[index], ...patch, updated: new Date() }
    const next = [...events]
    next[index] = updated
    set({ events: next })

    // Sync to Etebase
    await syncEventToEtebase(updated, 'update')
  },

  deleteEvent: async (id: string) => {
    // Optimistic update
    set((state) => ({ events: state.events.filter((e) => e.id !== id) }))

    // Sync to Etebase
    const etebase = useEtebaseStore.getState()
    if (etebase.account) {
      const itemInCache = etebase.itemCache.has(id)
      if (itemInCache) {
        try {
          await etebase.deleteItem('calendar', id)
        } catch (err) {
          console.error('[calendar-store] Failed to delete event in Etebase:', err)
        }
      } else {
        // Item was created offline — enqueue delete with tempId for compaction
        const { enqueue } = await import('@/app/lib/offline-queue')
        await enqueue({ type: 'delete', collectionType: 'calendar', tempId: id })
      }
    }
  },

  updateRecurringEvent: async (
    id: string,
    patch: Partial<CalendarEvent>,
    scope: RecurrenceScope,
    instanceDate: Date,
  ) => {
    const { events } = get()
    const master = events.find((e) => e.id === id)
    if (!master) return

    const now = new Date()

    switch (scope) {
      case 'this': {
        // Add EXDATE to master event, create standalone modified event
        const masterIndex = events.findIndex((e) => e.id === id)
        const updatedMaster = {
          ...master,
          exceptions: [...master.exceptions, instanceDate],
          updated: now,
        }
        const duration = master.endDate.getTime() - master.startDate.getTime()
        const newTempId = crypto.randomUUID()
        const standaloneEvent: CalendarEvent = {
          ...master,
          id: newTempId,
          uid: newTempId,
          recurrenceRule: null,
          exceptions: [],
          startDate: instanceDate,
          endDate: new Date(instanceDate.getTime() + duration),
          ...patch,
          created: now,
          updated: now,
        }
        const next = [...events]
        next[masterIndex] = updatedMaster
        next.push(standaloneEvent)
        set({ events: next })

        // Sync both changes to Etebase
        await syncEventToEtebase(updatedMaster, 'update')
        const newItemUid = await syncEventToEtebase(standaloneEvent, 'create')
        if (newItemUid) {
          set((state) => ({
            events: state.events.map((e) =>
              e.id === newTempId ? { ...e, id: newItemUid, uid: newItemUid } : e,
            ),
          }))
        }
        break
      }
      case 'this_and_future': {
        // Add UNTIL to master's RRULE (day before instanceDate)
        const dayBefore = addDays(instanceDate, -1)
        const masterIndex = events.findIndex((e) => e.id === id)
        const updatedMaster = {
          ...master,
          recurrenceRule: master.recurrenceRule
            ? addUntilToRRule(master.recurrenceRule, dayBefore)
            : null,
          updated: now,
        }

        // Create new recurring event from instanceDate with the patch applied
        const duration = master.endDate.getTime() - master.startDate.getTime()
        const newTempId = crypto.randomUUID()
        const newRecurring: CalendarEvent = {
          ...master,
          id: newTempId,
          uid: newTempId,
          startDate: instanceDate,
          endDate: new Date(instanceDate.getTime() + duration),
          exceptions: [],
          ...patch,
          created: now,
          updated: now,
        }

        const next = [...events]
        next[masterIndex] = updatedMaster
        next.push(newRecurring)
        set({ events: next })

        // Sync both changes to Etebase
        await syncEventToEtebase(updatedMaster, 'update')
        const newItemUid = await syncEventToEtebase(newRecurring, 'create')
        if (newItemUid) {
          set((state) => ({
            events: state.events.map((e) =>
              e.id === newTempId ? { ...e, id: newItemUid, uid: newItemUid } : e,
            ),
          }))
        }
        break
      }
      case 'all': {
        // Update the master event directly
        const masterIndex = events.findIndex((e) => e.id === id)
        const updated = { ...master, ...patch, updated: now }
        const next = [...events]
        next[masterIndex] = updated
        set({ events: next })

        // Sync to Etebase
        await syncEventToEtebase(updated, 'update')
        break
      }
    }
  },

  deleteRecurringEvent: async (
    id: string,
    scope: RecurrenceScope,
    instanceDate: Date,
  ) => {
    const { events } = get()
    const master = events.find((e) => e.id === id)
    if (!master) return

    const now = new Date()

    switch (scope) {
      case 'this': {
        // Add EXDATE to master
        const masterIndex = events.findIndex((e) => e.id === id)
        const updatedMaster = {
          ...master,
          exceptions: [...master.exceptions, instanceDate],
          updated: now,
        }
        const next = [...events]
        next[masterIndex] = updatedMaster
        set({ events: next })

        // Sync to Etebase
        await syncEventToEtebase(updatedMaster, 'update')
        break
      }
      case 'this_and_future': {
        // Add UNTIL to master's RRULE (day before instanceDate)
        const dayBefore = addDays(instanceDate, -1)
        const masterIndex = events.findIndex((e) => e.id === id)
        const updatedMaster = {
          ...master,
          recurrenceRule: master.recurrenceRule
            ? addUntilToRRule(master.recurrenceRule, dayBefore)
            : null,
          updated: now,
        }
        const next = [...events]
        next[masterIndex] = updatedMaster
        set({ events: next })

        // Sync to Etebase
        await syncEventToEtebase(updatedMaster, 'update')
        break
      }
      case 'all': {
        // Delete the master event entirely
        set({ events: events.filter((e) => e.id !== id) })

        // Sync to Etebase
        const etebase = useEtebaseStore.getState()
        if (etebase.account) {
          const itemInCache = etebase.itemCache.has(id)
          if (itemInCache) {
            try {
              await etebase.deleteItem('calendar', id)
            } catch (err) {
              console.error('[calendar-store] Failed to delete recurring event in Etebase:', err)
            }
          } else {
            const { enqueue } = await import('@/app/lib/offline-queue')
            await enqueue({ type: 'delete', collectionType: 'calendar', tempId: id })
          }
        }
        break
      }
    }
  },

  setCurrentView: (view: CalendarView) => set({ currentView: view }),
  setCurrentDate: (date: Date) => set({ currentDate: date }),
  setSelectedEvent: (id: string | null) => set({ selectedEventId: id }),

  navigateForward: () => {
    const { currentView, currentDate } = get()
    switch (currentView) {
      case 'week':
        set({ currentDate: addDays(currentDate, 7) })
        break
      case 'month':
        set({ currentDate: addMonths(currentDate, 1) })
        break
    }
  },

  navigateBackward: () => {
    const { currentView, currentDate } = get()
    switch (currentView) {
      case 'week':
        set({ currentDate: addDays(currentDate, -7) })
        break
      case 'month':
        set({ currentDate: addMonths(currentDate, -1) })
        break
    }
  },

  navigateToday: () => set({ currentDate: new Date() }),

  syncFromRemote: (remoteEvents: CalendarEvent[]) => {
    set({ events: remoteEvents, syncStatus: 'synced' })
  },
}),
{
  name: "silentsuite-calendar",
  partialize: (state) => ({ events: state.events }),
  storage: {
    getItem: (name) => {
      const raw = localStorage.getItem(name)
      if (!raw) return null
      const parsed = JSON.parse(raw)
      if (parsed?.state?.events) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parsed.state.events = parsed.state.events.map((e: any) => ({
          ...e,
          startDate: new Date(e.startDate),
          endDate: new Date(e.endDate),
          created: new Date(e.created),
          updated: new Date(e.updated),
          alarms: e.alarms ?? [],
        }))
      }
      return parsed
    },
    setItem: (name, value) => localStorage.setItem(name, JSON.stringify(value)),
    removeItem: (name) => localStorage.removeItem(name),
  },
},
))

export type { CalendarView, NewCalendarEvent }
