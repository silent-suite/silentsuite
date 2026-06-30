import type { DateFormat, FirstDayOfWeek } from '@silentsuite/core'

function pad(n: number) {
  return String(n).padStart(2, '0')
}

/**
 * JS `Date.getDay()` index (0 = Sunday … 6 = Saturday) of the configured first
 * day of the week. Monday-start → 1, Sunday-start → 0.
 */
export function weekStartIndex(firstDay: FirstDayOfWeek): number {
  return firstDay === 'sunday' ? 0 : 1
}

/**
 * Start-of-day `Date` for the week containing `date`, honoring the first-day
 * preference. The returned date is at local midnight.
 */
export function startOfWeek(date: Date, firstDay: FirstDayOfWeek): Date {
  const startIdx = weekStartIndex(firstDay)
  const diff = (date.getDay() - startIdx + 7) % 7
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - diff)
}

/**
 * End-of-day `Date` (23:59:59.999) for the last day of the week containing
 * `date`, honoring the first-day preference.
 */
export function endOfWeek(date: Date, firstDay: FirstDayOfWeek): Date {
  const start = startOfWeek(date, firstDay)
  const end = new Date(start)
  end.setDate(start.getDate() + 6)
  end.setHours(23, 59, 59, 999)
  return end
}

const WEEKDAY_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const

/**
 * Two-letter weekday labels ordered starting from the configured first day.
 * Monday-start → `['Mo','Tu',…,'Su']`; Sunday-start → `['Su','Mo',…,'Sa']`.
 */
export function weekdayLabels(firstDay: FirstDayOfWeek): string[] {
  const startIdx = weekStartIndex(firstDay)
  return Array.from({ length: 7 }, (_, i) => WEEKDAY_SHORT[(startIdx + i) % 7]!)
}

/**
 * Calendar week number for `date`, honoring the first-day preference.
 *
 * For Monday-start this is exactly ISO-8601: weeks run Monday–Sunday and the
 * week-numbering year is the year containing that week's Thursday (its 4th day),
 * so week 1 is the week containing the year's first Thursday.
 *
 * Sunday-start uses the same algorithm generalized: weeks run Sunday–Saturday
 * and a week belongs to the year containing its Wednesday (the 4th day of a
 * Sunday-start week). This keeps numbering stable and ~aligned with ISO while
 * matching the user's chosen week boundaries. It is NOT the ISO standard, which
 * is only defined for Monday-start weeks.
 */
export function getWeekNumber(date: Date, firstDay: FirstDayOfWeek): number {
  const weekStart = startOfWeek(date, firstDay)
  // The 4th day of the week (Thursday for Monday-start, Wednesday for
  // Sunday-start) determines the week-numbering year.
  const anchor = new Date(weekStart)
  anchor.setDate(anchor.getDate() + 3)
  const weekYear = anchor.getFullYear()

  // Locate the start of week 1: the first week whose anchor falls in weekYear.
  const firstWeekStart = startOfWeek(new Date(weekYear, 0, 1), firstDay)
  const firstAnchor = new Date(firstWeekStart)
  firstAnchor.setDate(firstAnchor.getDate() + 3)
  const week1Start = firstAnchor.getFullYear() === weekYear
    ? firstWeekStart
    : new Date(firstWeekStart.getFullYear(), firstWeekStart.getMonth(), firstWeekStart.getDate() + 7)

  const diffMs = weekStart.getTime() - week1Start.getTime()
  return Math.round(diffMs / (7 * 24 * 60 * 60 * 1000)) + 1
}

export function formatDate(input: Date | string | number, format: DateFormat = 'system', options?: Intl.DateTimeFormatOptions, locale?: string) {
  const date = typeof input === 'string' || typeof input === 'number' ? new Date(input) : input
  const y = date.getFullYear()
  const m = pad(date.getMonth() + 1)
  const d = pad(date.getDate())

  switch (format) {
    case 'YYYY-MM-DD':
      return `${y}-${m}-${d}`
    case 'YYYY/MM/DD':
      return `${y}/${m}/${d}`
    case 'DD/MM/YYYY':
      return `${d}/${m}/${y}`
    case 'MM/DD/YYYY':
      return `${m}/${d}/${y}`
    case 'DD.MM.YYYY':
      return `${d}.${m}.${y}`
    case 'system':
    default:
      return date.toLocaleDateString(locale ?? undefined, options ?? { year: 'numeric', month: 'long', day: 'numeric' })
  }
}

export default formatDate
