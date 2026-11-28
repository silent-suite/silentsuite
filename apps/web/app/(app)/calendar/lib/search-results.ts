import type { CalendarEvent } from '@silentsuite/core'
import { expandEventsForRange } from './calendar-grid-events'

const DAY_MS = 86_400_000

export interface SearchResult {
  event: CalendarEvent
  /** Start of the occurrence the result shows and opens. */
  startDate: Date
  /** The series occurrence to open; undefined for a one-off event. */
  instanceDate?: Date
}

function earliest<T extends { startDate: Date }>(items: T[]): T | undefined {
  return items.reduce<T | undefined>((min, item) => (!min || item.startDate < min.startDate ? item : min), undefined)
}

function latest<T extends { startDate: Date }>(items: T[]): T | undefined {
  return items.reduce<T | undefined>((max, item) => (!max || item.startDate > max.startDate ? item : max), undefined)
}

/**
 * The occurrence a search result shows for a repeating event: the first one from the start of
 * today, else the most recent one. Undefined when the series has no occurrence left to show.
 */
function searchOccurrence(event: CalendarEvent, now: Date) {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  // A year covers any series that repeats at least yearly; a longer look only runs when needed.
  for (const days of [366, 366 * 100]) {
    const next = earliest(expandEventsForRange([event], { start: today, end: new Date(today.getTime() + days * DAY_MS) }))
    if (next) return next
  }
  if (event.startDate >= today) return undefined
  return latest(expandEventsForRange([event], { start: event.startDate, end: new Date(today.getTime() - 1) }))
}

/** Search results in date order, each repeating event at its next (or latest) occurrence. */
export function toSearchResults(events: CalendarEvent[], now: Date = new Date()): SearchResult[] {
  return events
    .map((event): SearchResult => {
      if (!event.recurrenceRule) return { event, startDate: event.startDate }
      const occurrence = searchOccurrence(event, now)
      return occurrence
        ? { event, startDate: occurrence.startDate, instanceDate: occurrence.instanceDate }
        : { event, startDate: event.startDate }
    })
    .sort((a, b) => a.startDate.getTime() - b.startDate.getTime())
}
