import { parseICalDateValue } from '@silentsuite/core'

export interface CalendarContentItem {
  uid: string
  content: string
  collectionUid: string
}

export interface CalendarItemPartitions<T extends CalendarContentItem> {
  priority: T[]
  backlog: T[]
}

const PRIORITY_PAST_DAYS = 30

function unfoldICal(content: string): string {
  return content.replace(/\r?\n[ \t]/g, '')
}

function getPropertyLine(content: string, name: string): string | null {
  const unfolded = unfoldICal(content)
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = unfolded.match(new RegExp(`^${escapedName}(?:;[^:]*)?:.+$`, 'im'))
  return match?.[0] ?? null
}

function getPropertyValue(content: string, name: string): string | null {
  const line = getPropertyLine(content, name)
  if (!line) return null
  const colon = line.indexOf(':')
  return colon === -1 ? null : line.slice(colon + 1).trim()
}

function getTzidFromLine(line: string | null): string | undefined {
  if (!line) return undefined
  const match = line.match(/(?:^|;)TZID=([^;:]+)/i)
  return match?.[1]
}

function parseICalPropertyDate(content: string, name: string): Date | null {
  const line = getPropertyLine(content, name)
  if (!line) return null
  const value = getPropertyValue(content, name)
  if (!value) return null
  try {
    return parseICalDateValue(value, getTzidFromLine(line)).date
  } catch {
    return null
  }
}

function rruleUntilDate(content: string): Date | null {
  const rrule = getPropertyValue(content, 'RRULE')
  const until = rrule?.match(/(?:^|;)UNTIL=([^;]+)/i)?.[1]
  if (!until) return null
  try {
    return parseICalDateValue(until).date
  } catch {
    return null
  }
}

function isPriorityCalendarItem(item: CalendarContentItem, now: Date): boolean {
  const priorityStart = new Date(now)
  priorityStart.setDate(priorityStart.getDate() - PRIORITY_PAST_DAYS)

  const recurrenceRule = getPropertyValue(item.content, 'RRULE')
  if (recurrenceRule) {
    const until = rruleUntilDate(item.content)
    return !until || until >= priorityStart
  }

  const endDate = parseICalPropertyDate(item.content, 'DTEND')
  const startDate = parseICalPropertyDate(item.content, 'DTSTART')
  const comparisonDate = endDate ?? startDate

  // If a malformed/legacy item cannot be classified cheaply, keep it in the
  // fast path so the full deserializer can decide without hiding it behind old
  // history.
  if (!comparisonDate) return true

  return comparisonDate >= priorityStart
}

export function partitionCalendarItemsForFastPaint<T extends CalendarContentItem>(
  items: T[],
  now: Date = new Date(),
): CalendarItemPartitions<T> {
  const priority: T[] = []
  const backlog: T[] = []

  for (const item of items) {
    if (isPriorityCalendarItem(item, now)) {
      priority.push(item)
    } else {
      backlog.push(item)
    }
  }

  return { priority, backlog }
}
