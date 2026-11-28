'use client'

import { create } from 'zustand'

import type { CalendarEvent, SyncStatus, VAlarm } from '@silentsuite/core'
import { eventOccurrenceWallClock, gapWallClock, occurrenceEnd, occurrenceWallClock, overridesBefore, overridesInForm, overridesWithout, recurrenceRuleFrom, recurrenceTimeZone, splitRetainedRecurrenceDates, untilDateBefore, untilTimeBefore } from '@silentsuite/core'
import type { RecurrenceScope } from '@/app/(app)/calendar/components/RecurrenceScopeDialog'
import { overriddenOccurrence } from '@/app/(app)/calendar/lib/calendar-grid-events'
import { getSafeErrorDetails } from '@/app/lib/privacy-safe-errors'
import { ImportIncompleteError } from '@/app/lib/import-outcome'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { showErrorToast } from '@/app/stores/use-toast-store'
import { useCalendarListStore } from '@/app/stores/use-calendar-list-store'
import { useLabelSuggestionsStore } from '@/app/stores/use-label-suggestions-store'
import { getAccountEpoch, isCurrentAccountEpoch } from '@/app/lib/account-epoch'
import { selectManagedBirthdayCalendarIds, useBirthdayMarkerStore } from '@/app/lib/birthday-calendar/markers'
import { assertOfflineQueueAccountGuard, captureOfflineQueueAccountGuard, isOfflineQueueBoundaryCancellation } from '@/app/lib/offline-queue-account'

type CalendarView = 'week' | 'month'

interface NewCalendarEvent {
  title: string
  description?: string
  location?: string
  startDate: Date
  endDate: Date
  allDay?: boolean
  recurrenceRule?: string | null
  exceptions?: Date[]
  alarms?: VAlarm[]
  categories?: string[]
  calendarId?: string
  timezone?: string
  vtimezones?: string[][]
  importError?: string
  unknownComponents?: string[][]
  /** True only for a floating DATE-TIME source (no TZID, no Z); kept so it is written back floating. */
  floating?: true
  /** Original wall clock of a DST-gap TZID DTSTART (YYYYMMDDTHHMMSS); kept so it is written back. */
  startWallClock?: string
  /** Provider imports only (#48): the series UID, retained lines (incl. the import source), its
   *  same-UID RECURRENCE-ID overrides, STATUS and TRANSP, all written in the one item. */
  uid?: string
  unknownProperties?: string[]
  overrides?: string[][]
  status?: string
  transp?: string
}

interface CalendarState {
  events: CalendarEvent[]
  syncStatus: SyncStatus
  currentView: CalendarView
  currentDate: Date
  selectedEventId: string | null
  searchQuery: string
}

/**
 * A create that was not acknowledged and is not held in the offline queue. `unconfirmed` is false
 * only when nothing was sent; otherwise the event may or may not exist remotely.
 */
export class CalendarSaveError extends Error {
  constructor(readonly unconfirmed: boolean) {
    super(unconfirmed ? 'Event save not confirmed' : 'Event not saved')
    this.name = 'CalendarSaveError'
  }
}

interface CalendarActions {
  /**
   * Resolves once the server acknowledged the event, or once the create is held in the offline
   * queue; otherwise removes the temporary event and rejects with CalendarSaveError.
   */
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
  /** Resolves the requested count only when every event was acknowledged; otherwise rejects with ImportIncompleteError. */
  importEvents: (newEvents: NewCalendarEvent[]) => Promise<number>
  syncFromRemote: (events: CalendarEvent[]) => void
  setSearchQuery: (q: string) => void
  getFilteredEvents: () => CalendarEvent[]
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

/**
 * Apply an edit patch. A start-instant change that does not set `startWallClock` explicitly drops
 * any retained gap wall clock, so it never revives after later edits. An explicit key (including
 * undefined) wins; an absent or unchanged start keeps it.
 */
function mergeEventPatch(base: CalendarEvent, patch: Partial<CalendarEvent>): CalendarEvent {
  const merged: CalendarEvent = { ...base, ...patch }
  if (
    patch.startDate !== undefined
    && !('startWallClock' in patch)
    && patch.startDate.getTime() !== base.startDate.getTime()
  ) {
    delete merged.startWallClock
  }
  // Overrides follow a changed DTSTART form now, so the in-memory event holds them as written.
  return { ...merged, ...overridesInForm(base, merged) }
}

/**
 * A scoped copy (this / this and future) takes the selected occurrence as its DTSTART. Its wall
 * clock comes from the series itself; it is kept only when that wall time lies in a DST gap, and
 * the master's own retained wall clock never carries over.
 */
function withOccurrenceWallClock(base: CalendarEvent, master: CalendarEvent, instanceDate: Date): CalendarEvent {
  const intended = eventOccurrenceWallClock(master, instanceDate)
  const wall = intended ? gapWallClock(master.timezone, intended) : undefined
  const copy: CalendarEvent = { ...base }
  if (wall) copy.startWallClock = wall
  else delete copy.startWallClock
  return copy
}

/**
 * A scoped copy is a new item with a new UID. The series' retained raw lines (RECURRENCE-ID,
 * attendees and the like) and its overrides describe the original item, so the copy starts
 * without them, as it did before they were kept. A "this and future" split moves later RDATEs
 * separately. VTIMEZONE blocks still describe the copy's TZID and stay.
 */
const WITHOUT_RETAINED_CONTENT = {
  unknownProperties: undefined,
  unknownComponents: undefined,
  overrides: undefined,
  overridesForm: undefined,
} as const

/** Add an UNTIL value to an existing RRULE, replacing any existing UNTIL or COUNT */
function addUntilToRRule(rrule: string, until: string): string {
  const parts = rrule.split(';').filter(
    (p) => !p.startsWith('UNTIL=') && !p.startsWith('COUNT='),
  )
  parts.push(`UNTIL=${until}`)
  return parts.join(';')
}

/**
 * The UNTIL that ends `master` before the occurrence at `instanceDate`. All-day series take the
 * previous date (a DATE UNTIL). Zoned and UTC series take the UTC instant one second before the
 * occurrence; floating series take 23:59:59 on the previous day. A date-only UNTIL on a timed
 * series is read as that day's midnight and would also drop the previous day's occurrence.
 */
function untilBeforeOccurrence(master: CalendarEvent, instanceDate: Date): string {
  const timeZone = recurrenceTimeZone(master)
  if (master.allDay) return untilDateBefore(instanceDate, timeZone)
  // A floating series uses the occurrence's own wall-clock date, which a host DST gap can move.
  const wallClock = timeZone === undefined && master.recurrenceRule
    ? occurrenceWallClock(master.recurrenceRule, master.startDate, instanceDate)
    : undefined
  return untilTimeBefore(instanceDate, timeZone, wallClock)
}

/**
 * Creates still waiting for the server, keyed by the temporary local id. Each resolves to the
 * acknowledged item UID, or null when the create was not acknowledged (queued offline or failed).
 */
const savingCreates = new Map<string, Promise<string | null>>()

/** Mark a create of `tempId` as pending; call the result once the local id was replaced. */
function trackCreate(tempId: string): (itemUid: string | null) => void {
  let settle!: (itemUid: string | null) => void
  savingCreates.set(tempId, new Promise((resolve) => { settle = resolve }))
  return (itemUid) => {
    savingCreates.delete(tempId)
    settle(itemUid)
  }
}

/**
 * The id to sync an edit or delete under. An event edited while its create is still in flight has
 * only a temporary id with no Etebase item behind it yet, so wait for the create and use the item
 * UID it was given (the temporary id if the create was not acknowledged). Without a pending create
 * this returns the id synchronously: the caller must not yield before capturing its account. After
 * a wait, the caller must still check that its account epoch is current before reading any account
 * state.
 */
function syncTargetId(id: string): string | Promise<string> {
  const saving = savingCreates.get(id)
  if (!saving) return id
  return saving.then((itemUid) => itemUid ?? id)
}

/** Sync a single event to Etebase (used by create/update helpers) */
async function syncEventToEtebase(event: CalendarEvent, mode: 'create' | 'update', tempId?: string, sourceCalendarId?: string): Promise<string | null> {
  const etebase = useEtebaseStore.getState()
  if (!etebase.account) return null
  const guard = captureOfflineQueueAccountGuard(etebase)
  if (!guard) return null

  let content: string | undefined
  try {
    const { serializeCalendarEvent } = await import('@silentsuite/core')
    assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState())
    content = serializeCalendarEvent(event)
    if (mode === 'create') {
      return await etebase.createItem('calendar', content, tempId, event.calendarId)
    } else {
      // For updates of offline-created items, enqueue with tempId for compaction
      const itemInCache = etebase.itemCache.has(event.id)
      if (itemInCache) {
        const currentCollectionUid = etebase.itemCollectionMap.get(event.id) ?? sourceCalendarId
        if (event.calendarId && currentCollectionUid && event.calendarId !== currentCollectionUid) {
          const movedItemUid = await etebase.moveItem('calendar', event.id, content, event.calendarId, currentCollectionUid)
          if (!movedItemUid) throw new Error(`Failed to move event ${event.id} to calendar ${event.calendarId}`)
          return movedItemUid
        }
        await etebase.updateItem('calendar', event.id, content)
        void useLabelSuggestionsStore.getState().recordUsage('calendar', event.categories ?? [])
        return event.id
      } else {
        const { enqueue } = await import('@/app/lib/offline-queue')
        assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState())
        await enqueue({ type: 'update', collectionType: 'calendar', collectionUid: event.calendarId, content, tempId: event.id }, guard)
        assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState())
        return event.id
      }
    }
  } catch (err) {
    try { assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState()) } catch { return null }
    const { enqueue, isOfflineError } = await import('@/app/lib/offline-queue')
    if (!isOfflineError(err)) {
      showErrorToast('Failed to save event. Please try again.')
    } else if (mode === 'update' && content) {
      const latestEtebase = useEtebaseStore.getState()
      const sourceCollectionUid = latestEtebase.itemCollectionMap.get(event.id) ?? sourceCalendarId
      if (
        latestEtebase.itemCache.has(event.id)
        && sourceCollectionUid
        && event.calendarId
        && event.calendarId !== sourceCollectionUid
      ) {
        try {
          assertOfflineQueueAccountGuard(guard, latestEtebase)
          await enqueue({
            type: 'move',
            collectionType: 'calendar',
            collectionUid: sourceCollectionUid,
            targetCollectionUid: event.calendarId,
            content,
            itemUid: event.id,
          }, guard)
          assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState())
        } catch (queueError) {
          if (isOfflineQueueBoundaryCancellation(queueError)) return null
          throw queueError
        }
      }
    }
    try { assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState()) } catch { return null }
    console.error(`[calendar-store] Failed to ${mode} event in Etebase`, getSafeErrorDetails(err))
    return null
  }
}

const MANAGED_CALENDAR_MESSAGE = 'Birthdays calendar events come from your contacts. Edit the contact instead.'

/** The current account's managed Birthdays calendars (generated, never user-written). */
function managedCalendarIds(): readonly string[] {
  return selectManagedBirthdayCalendarIds(
    useBirthdayMarkerStore.getState().snapshot, getAccountEpoch(), useEtebaseStore.getState().accountFingerprint)
}

function assertUserWritableCalendar(calendarId: string | null | undefined): void {
  if (calendarId && managedCalendarIds().includes(calendarId)) throw new Error(MANAGED_CALENDAR_MESSAGE)
}

function defaultCalendarId(): string {
  const { calendars, defaultCalendarId } = useCalendarListStore.getState()
  const managed = managedCalendarIds()
  const writable = calendars.filter((calendar) => !managed.includes(calendar.id))
  if (writable.some((calendar) => calendar.id === defaultCalendarId)) return defaultCalendarId
  // Calendars exist but every one is managed: there is no ordinary target, so refuse rather
  // than fall back to a phantom id.
  if (calendars.length > 0 && writable.length === 0) {
    throw new Error(`There is no calendar to add events to. ${MANAGED_CALENDAR_MESSAGE}`)
  }
  return writable[0]?.id ?? 'default'
}

export const useCalendarStore = create<CalendarState & CalendarActions>()((set, get) => ({
  events: [],
  syncStatus: 'synced' as SyncStatus,
  currentView: 'week',
  currentDate: new Date(),
  selectedEventId: null,
  searchQuery: '',

  createEvent: async (newEvent: NewCalendarEvent) => {
    if (!useAuthStore.getState().canWrite()) throw new Error('Your subscription has ended. Upgrade to make changes.')
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
      exceptions: newEvent.exceptions ?? [],
      alarms: newEvent.alarms ?? [],
      categories: newEvent.categories ?? [],
      calendarId: newEvent.calendarId ?? defaultCalendarId(),
      timezone: newEvent.timezone,
      ...(newEvent.floating === true ? { floating: true as const } : {}),
      ...(newEvent.startWallClock ? { startWallClock: newEvent.startWallClock } : {}),
      created: now,
      updated: now,
    }
    assertUserWritableCalendar(event.calendarId)

    // Optimistic local update
    set((state) => ({ events: [...state.events, event] }))
    // An unacknowledged temp event would vanish on the next refresh; the dialog keeps the input.
    const withdraw = (unconfirmed: boolean): never => {
      set((state) => {
        const remaining = state.events.filter((e) => e.id !== tempId)
        return remaining.length === state.events.length ? state : { events: remaining }
      })
      throw new CalendarSaveError(unconfirmed)
    }

    const etebase = useEtebaseStore.getState()
    if (!etebase.account) return withdraw(false)

    // Sync to Etebase (pass tempId for offline queue mapping)
    const settleCreate = trackCreate(tempId)
    let itemUid: string | null = null
    try {
      itemUid = await syncEventToEtebase(event, 'create', tempId)
      if (itemUid) {
        void useLabelSuggestionsStore.getState().recordUsage('calendar', event.categories ?? [])
        set((state) => ({
          events: state.events.map((e) =>
            e.id === tempId ? { ...e, id: itemUid! } : e,
          ),
        }))
      }
    } finally {
      settleCreate(itemUid)
    }
    if (itemUid) return { ...event, id: itemUid }

    // Not acknowledged. A create admitted to the offline queue is durable local custody awaiting
    // replay, so the temp event stays; anything else may or may not exist remotely.
    const guard = captureOfflineQueueAccountGuard(useEtebaseStore.getState())
    if (guard) {
      try {
        const { readOutstanding } = await import('@/app/lib/offline-queue')
        const outstanding = await readOutstanding({ collectionType: 'calendar', itemUid: tempId }, guard)
        if (outstanding.some((entry) => entry.type === 'create')) return event
      } catch {
        // An unreadable queue proves nothing: the create stays unconfirmed.
      }
    }
    return withdraw(true)
  },

  updateEvent: async (id: string, patch: Partial<CalendarEvent>) => {
    if (!useAuthStore.getState().canWrite()) throw new Error('Your subscription has ended. Upgrade to make changes.')
    const { events } = get()
    const index = events.findIndex((e) => e.id === id)
    if (index === -1) return
    assertUserWritableCalendar(events[index].calendarId)
    assertUserWritableCalendar(patch.calendarId)

    // Optimistic update
    const updated = { ...mergeEventPatch(events[index]!, patch), updated: new Date() }
    const next = [...events]
    next[index] = updated
    set({ events: next })

    // Wait for a pending create (see syncTargetId); drop the sync if the account changed.
    const accountEpoch = getAccountEpoch()
    const target = syncTargetId(id)
    const targetId = typeof target === 'string' ? target : await target
    if (!isCurrentAccountEpoch(accountEpoch)) return
    // Sync to Etebase
    const syncedItemUid = await syncEventToEtebase({ ...updated, id: targetId }, 'update', undefined, events[index].calendarId)
    if (syncedItemUid && syncedItemUid !== targetId) {
      set((state) => ({
        events: state.events.map((e) =>
          e.id === targetId ? { ...e, id: syncedItemUid } : e,
        ),
        selectedEventId: state.selectedEventId === targetId ? syncedItemUid : state.selectedEventId,
      }))
    }
  },

  deleteEvent: async (id: string) => {
    if (!useAuthStore.getState().canWrite()) throw new Error('Your subscription has ended. Upgrade to make changes.')
    const eventToDelete = get().events.find((e) => e.id === id)
    assertUserWritableCalendar(eventToDelete?.calendarId)
    // Optimistic update
    set((state) => ({ events: state.events.filter((e) => e.id !== id) }))

    // Wait for a pending create (see syncTargetId); drop the sync if the account changed.
    const accountEpoch = getAccountEpoch()
    const target = syncTargetId(id)
    const targetId = typeof target === 'string' ? target : await target
    if (!isCurrentAccountEpoch(accountEpoch)) return
    // Sync to Etebase
    const etebase = useEtebaseStore.getState()
    if (etebase.account) {
      const guard = captureOfflineQueueAccountGuard(etebase)
      if (!guard) return
      const itemInCache = etebase.itemCache.has(targetId)
      if (itemInCache) {
        try {
          await etebase.deleteItem('calendar', targetId)
        } catch (err) {
          // If the error is a network/offline error, enqueue for later replay.
          // Non-offline errors are logged and the optimistic removal stands.
          const { isOfflineError, enqueue } = await import('@/app/lib/offline-queue')
          try { assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState()) } catch { return }
          if (isOfflineError(err)) {
            try {
              await enqueue({ type: 'delete', collectionType: 'calendar', collectionUid: etebase.itemCollectionMap.get(targetId), itemUid: targetId }, guard)
              assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState())
            } catch (queueError) {
              if (isOfflineQueueBoundaryCancellation(queueError)) return
              throw queueError
            }
          } else {
            showErrorToast('Failed to delete event. Please try again.')
          }
          console.error('[calendar-store] Failed to delete event in Etebase', getSafeErrorDetails(err))
        }
      } else {
        // Item was created offline — enqueue delete with tempId for compaction
        const { enqueue } = await import('@/app/lib/offline-queue')
        try {
          assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState())
          await enqueue({ type: 'delete', collectionType: 'calendar', collectionUid: eventToDelete?.calendarId, tempId: id }, guard)
          assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState())
        } catch (queueError) {
          if (isOfflineQueueBoundaryCancellation(queueError)) return
          throw queueError
        }
      }
    }
  },

  updateRecurringEvent: async (
    id: string,
    patch: Partial<CalendarEvent>,
    scope: RecurrenceScope,
    instanceDate: Date,
  ) => {
    if (!useAuthStore.getState().canWrite()) throw new Error('Your subscription has ended. Upgrade to make changes.')
    const { events } = get()
    const master = events.find((e) => e.id === id)
    if (!master) return
    assertUserWritableCalendar(master.calendarId)

    const now = new Date()

    /** Save a scoped edit: the master's new EXDATE or UNTIL, and the edited copy as a new item. */
    const saveScopedEdit = async (updatedMaster: CalendarEvent, copy: CalendarEvent) => {
      const next = [...events]
      next[events.indexOf(master)] = updatedMaster
      next.push(copy)
      set({ events: next })

      const settleCopy = trackCreate(copy.id)
      let copyItemUid: string | null = null
      try {
        // Wait for a pending create (see syncTargetId); drop the sync if the account changed.
        const accountEpoch = getAccountEpoch()
        const target = syncTargetId(id)
        const targetId = typeof target === 'string' ? target : await target
        if (!isCurrentAccountEpoch(accountEpoch)) return

        // Sync both changes to Etebase
        await syncEventToEtebase({ ...updatedMaster, id: targetId }, 'update', undefined, master.calendarId)
        copyItemUid = await syncEventToEtebase(copy, 'create')
        if (copyItemUid) {
          set((state) => ({
            events: state.events.map((e) =>
              e.id === copy.id ? { ...e, id: copyItemUid! } : e,
            ),
          }))
        }
      } finally {
        settleCopy(copyItemUid)
      }
    }

    switch (scope) {
      case 'this': {
        // Add EXDATE to master event, create standalone modified event
        const updatedMaster = {
          ...master,
          exceptions: [...master.exceptions, instanceDate],
          // The removed occurrence's override would otherwise stay in the item.
          ...overridesWithout(master, instanceDate),
          updated: now,
        }
        const newTempId = crypto.randomUUID()
        // An occurrence another client moved or changed keeps that override's time and fields.
        const overridden = overriddenOccurrence(master, instanceDate)
        const standaloneBase = overridden
          ? { ...overridden, id: newTempId, uid: newTempId, ...WITHOUT_RETAINED_CONTENT, recurrenceRule: null, exceptions: [] }
          : withOccurrenceWallClock({
            ...master,
            id: newTempId,
            uid: newTempId,
            ...WITHOUT_RETAINED_CONTENT,
            recurrenceRule: null,
            exceptions: [],
            startDate: instanceDate,
            // A day or week DURATION keeps its wall-clock length at this occurrence.
            endDate: occurrenceEnd(master, instanceDate),
          }, master, instanceDate)
        const standaloneEvent: CalendarEvent = {
          ...mergeEventPatch(standaloneBase, patch),
          created: now,
          updated: now,
        }
        await saveScopedEdit(updatedMaster, standaloneEvent)
        break
      }
      case 'this_and_future': {
        // End the master's RRULE just before instanceDate
        const until = untilBeforeOccurrence(master, instanceDate)
        // Retained RDATEs at or after the cut leave the original series with its RRULE.
        const retainedDates = splitRetainedRecurrenceDates(master, instanceDate)
        const updatedMaster = {
          ...master,
          recurrenceRule: master.recurrenceRule
            ? addUntilToRRule(master.recurrenceRule, until)
            : null,
          unknownProperties: retainedDates.before,
          // Overrides of occurrences from the cut on leave the original with them.
          ...overridesBefore(master, instanceDate),
          updated: now,
        }

        // Create new recurring event from instanceDate with the patch applied
        const newTempId = crypto.randomUUID()
        const newRecurringBase = withOccurrenceWallClock({
          ...master,
          id: newTempId,
          uid: newTempId,
          ...WITHOUT_RETAINED_CONTENT,
          // The new series takes over the original's later retained RDATEs.
          unknownProperties: retainedDates.from,
          // A COUNT keeps only the occurrences still to come, so the two series add up to the original.
          recurrenceRule: recurrenceRuleFrom(master, instanceDate),
          startDate: instanceDate,
          // A day or week DURATION keeps its wall-clock length at this occurrence.
          endDate: occurrenceEnd(master, instanceDate),
          exceptions: [],
        }, master, instanceDate)
        const newRecurring: CalendarEvent = {
          ...mergeEventPatch(newRecurringBase, patch),
          created: now,
          updated: now,
        }

        await saveScopedEdit(updatedMaster, newRecurring)
        break
      }
      case 'all': {
        // Update the master event directly
        const masterIndex = events.findIndex((e) => e.id === id)
        const updated = { ...mergeEventPatch(master, patch), updated: now }
        const next = [...events]
        next[masterIndex] = updated
        set({ events: next })

        // Wait for a pending create (see syncTargetId); drop the sync if the account changed.
        const accountEpoch = getAccountEpoch()
        const target = syncTargetId(id)
        const targetId = typeof target === 'string' ? target : await target
        if (!isCurrentAccountEpoch(accountEpoch)) return
        // Sync to Etebase
        const movedItemUid = await syncEventToEtebase({ ...updated, id: targetId }, 'update', undefined, master.calendarId)
        if (movedItemUid && movedItemUid !== targetId) {
          set((state) => ({
            events: state.events.map((e) =>
              e.id === targetId ? { ...e, id: movedItemUid } : e,
            ),
            selectedEventId: state.selectedEventId === targetId ? movedItemUid : state.selectedEventId,
          }))
        }
        break
      }
    }
  },

  deleteRecurringEvent: async (
    id: string,
    scope: RecurrenceScope,
    instanceDate: Date,
  ) => {
    if (!useAuthStore.getState().canWrite()) throw new Error('Your subscription has ended. Upgrade to make changes.')
    const { events } = get()
    const master = events.find((e) => e.id === id)
    if (!master) return
    assertUserWritableCalendar(master.calendarId)

    const now = new Date()

    switch (scope) {
      case 'this': {
        // Add EXDATE to master
        const masterIndex = events.findIndex((e) => e.id === id)
        const updatedMaster = {
          ...master,
          exceptions: [...master.exceptions, instanceDate],
          // The removed occurrence's override would otherwise stay in the item.
          ...overridesWithout(master, instanceDate),
          updated: now,
        }
        const next = [...events]
        next[masterIndex] = updatedMaster
        set({ events: next })

        // Wait for a pending create (see syncTargetId); drop the sync if the account changed.
        const accountEpoch = getAccountEpoch()
        const target = syncTargetId(id)
        const targetId = typeof target === 'string' ? target : await target
        if (!isCurrentAccountEpoch(accountEpoch)) return
        // Sync to Etebase
        await syncEventToEtebase({ ...updatedMaster, id: targetId }, 'update')
        break
      }
      case 'this_and_future': {
        // End the master's RRULE just before instanceDate
        const until = untilBeforeOccurrence(master, instanceDate)
        const masterIndex = events.findIndex((e) => e.id === id)
        // Retained RDATEs at or after the cut leave the original series with its RRULE.
        const retainedDates = splitRetainedRecurrenceDates(master, instanceDate)
        const updatedMaster = {
          ...master,
          recurrenceRule: master.recurrenceRule
            ? addUntilToRRule(master.recurrenceRule, until)
            : null,
          unknownProperties: retainedDates.before,
          // Overrides of occurrences from the cut on leave the original with them.
          ...overridesBefore(master, instanceDate),
          updated: now,
        }
        const next = [...events]
        next[masterIndex] = updatedMaster
        set({ events: next })

        // Wait for a pending create (see syncTargetId); drop the sync if the account changed.
        const accountEpoch = getAccountEpoch()
        const target = syncTargetId(id)
        const targetId = typeof target === 'string' ? target : await target
        if (!isCurrentAccountEpoch(accountEpoch)) return
        // Sync to Etebase
        await syncEventToEtebase({ ...updatedMaster, id: targetId }, 'update')
        break
      }
      case 'all': {
        // Delete the master event entirely
        set({ events: events.filter((e) => e.id !== id) })

        // Wait for a pending create (see syncTargetId); drop the sync if the account changed.
        const accountEpoch = getAccountEpoch()
        const target = syncTargetId(id)
        const targetId = typeof target === 'string' ? target : await target
        if (!isCurrentAccountEpoch(accountEpoch)) return
        // Sync to Etebase
        const etebase = useEtebaseStore.getState()
        if (etebase.account) {
          const guard = captureOfflineQueueAccountGuard(etebase)
          if (!guard) break
          const itemInCache = etebase.itemCache.has(targetId)
          if (itemInCache) {
            try {
              await etebase.deleteItem('calendar', targetId)
            } catch (err) {
              const { isOfflineError, enqueue } = await import('@/app/lib/offline-queue')
              try { assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState()) } catch { break }
              if (isOfflineError(err)) {
                try {
                  await enqueue({ type: 'delete', collectionType: 'calendar', collectionUid: etebase.itemCollectionMap.get(targetId), itemUid: targetId }, guard)
                  assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState())
                } catch (queueError) {
                  if (isOfflineQueueBoundaryCancellation(queueError)) break
                  throw queueError
                }
              } else {
                showErrorToast('Failed to delete event. Please try again.')
              }
              console.error('[calendar-store] Failed to delete recurring event in Etebase', getSafeErrorDetails(err))
            }
          } else {
            const { enqueue } = await import('@/app/lib/offline-queue')
            try {
              assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState())
              await enqueue({ type: 'delete', collectionType: 'calendar', collectionUid: master.calendarId, tempId: id }, guard)
              assertOfflineQueueAccountGuard(guard, useEtebaseStore.getState())
            } catch (queueError) {
              if (isOfflineQueueBoundaryCancellation(queueError)) break
              throw queueError
            }
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

  importEvents: async (newEvents: NewCalendarEvent[]) => {
    if (!useAuthStore.getState().canWrite()) throw new Error('Your subscription has ended. Upgrade to make changes.')
    if (newEvents.length === 0) return 0
    for (const newEvent of newEvents) assertUserWritableCalendar(newEvent.calendarId ?? defaultCalendarId())

    const now = new Date()
    const events: CalendarEvent[] = newEvents.map((ne) => {
      const tempId = crypto.randomUUID()
      return {
        id: tempId,
        uid: ne.uid ?? tempId,
        title: ne.title,
        description: ne.description ?? '',
        location: ne.location ?? '',
        startDate: ne.startDate,
        endDate: ne.endDate,
        allDay: ne.allDay ?? false,
        recurrenceRule: ne.recurrenceRule ?? null,
        exceptions: ne.exceptions ?? [],
        alarms: ne.alarms ?? [],
        categories: ne.categories ?? [],
        calendarId: ne.calendarId ?? defaultCalendarId(),
        timezone: ne.timezone,
        ...(ne.vtimezones?.length ? { vtimezones: ne.vtimezones } : {}),
        ...(ne.unknownComponents?.length ? { unknownComponents: ne.unknownComponents } : {}),
        ...(ne.floating === true ? { floating: true as const } : {}),
        ...(ne.startWallClock ? { startWallClock: ne.startWallClock } : {}),
        ...(ne.unknownProperties && ne.unknownProperties.length > 0 ? { unknownProperties: ne.unknownProperties } : {}),
        ...(ne.overrides && ne.overrides.length > 0 ? { overrides: ne.overrides } : {}),
        ...(ne.status ? { status: ne.status } : {}),
        ...(ne.transp ? { transp: ne.transp } : {}),
        created: now,
        updated: now,
      }
    })

    // Optimistic local update — add all at once
    set((state) => ({ events: [...state.events, ...events] }))

    // Batch sync to Etebase. Input positions the server acknowledged; the rest are rolled back.
    const acknowledged = new Set<number>()
    let uncertain = false
    const etebase = useEtebaseStore.getState()
    if (etebase.account) {
      try {
        const { serializeCalendarEvent } = await import('@silentsuite/core')
        const groups = new Map<string | undefined, number[]>()
        events.forEach((event, position) => {
          groups.set(event.calendarId, [...(groups.get(event.calendarId) ?? []), position])
        })

        for (const [targetCollectionUid, positions] of groups) {
          const validPositions: number[] = []
          const contents: Array<{ content: string; tempId: string }> = []
          for (const position of positions) {
            try {
              if (newEvents[position]?.importError) continue
              const event = events[position]!
              if (!Number.isFinite(event.startDate.getTime()) || !Number.isFinite(event.endDate.getTime())) continue
              contents.push({ content: serializeCalendarEvent(event), tempId: event.id })
              validPositions.push(position)
            } catch {
              // This event is definitely unsaved; valid siblings still reach the batch.
            }
          }
          if (contents.length === 0) continue
          let uids: Array<string | null>
          try {
            uids = await etebase.createItemsBatch('calendar', contents, targetCollectionUid)
          } catch {
            uncertain = true
            continue
          }
          if (uids.filter(Boolean).length < contents.length) uncertain = true
          // Each acknowledged event takes its item id for this concrete collection and keeps its own VEVENT UID.
          const itemIds = new Map<string, string>()
          validPositions.forEach((position, index) => {
            const itemUid = uids[index]
            if (!itemUid) return
            itemIds.set(events[position]!.id, itemUid)
            acknowledged.add(position)
          })
          if (itemIds.size === 0) continue
          set((state) => ({
            events: state.events.map((e) => {
              const itemUid = itemIds.get(e.id)
              return itemUid ? { ...e, id: itemUid } : e
            }),
          }))
        }
      } catch (err) {
        console.error('[calendar-store] Failed to batch import events', getSafeErrorDetails(err))
      }
    }

    if (acknowledged.size === events.length) return events.length
    const unsaved = events.map((_, position) => position).filter((position) => !acknowledged.has(position))
    // Unacknowledged temp events would vanish on the next refresh; the importer keeps their input.
    const tempIds = new Set(unsaved.map((position) => events[position]!.id))
    set((state) => {
      const remaining = state.events.filter((e) => !tempIds.has(e.id))
      return remaining.length === state.events.length ? state : { events: remaining }
    })
    throw new ImportIncompleteError(acknowledged.size, unsaved, uncertain)
  },

  syncFromRemote: (remoteEvents: CalendarEvent[]) => {
    set({ events: remoteEvents, syncStatus: 'synced' })
  },

  setSearchQuery: (q: string) => set({ searchQuery: q }),

  getFilteredEvents: () => {
    const { events, searchQuery } = get()
    const q = searchQuery.trim().toLowerCase()
    if (!q) return events
    return events.filter((e) => {
      const title = (e.title ?? '').toLowerCase()
      const desc = (e.description ?? '').toLowerCase()
      const loc = (e.location ?? '').toLowerCase()
      const cats = (e.categories ?? []).join(' ').toLowerCase()
      return title.includes(q) || desc.includes(q) || loc.includes(q) || cats.includes(q)
    })
  },
}))

export type { CalendarView, NewCalendarEvent }
