/*
 * Microsoft Graph patternedRecurrence -> RFC 5545 RRULE, plus a matcher that evaluates the Graph
 * pattern itself on calendar dates (YYYY-MM-DD), used to place DTSTART and to check that every
 * cancelled occurrence and every exception lies on the series.
 *
 * Graph lets `range.startDate` lie before the first matching date. The first occurrence is the first
 * matching date on or after it, and the interval counts from the period (week, month, year) of that
 * first occurrence (Microsoft's recurring-events guide: start 2017-08-29, every 2 months on the first
 * Thursday -> 2017-09-07, 2017-11-02, 2018-01-04, 2018-03-01). RFC 5545 counts INTERVAL from the
 * DTSTART period, so DTSTART = first occurrence plus the emitted rule gives the same dates.
 *
 * Anything outside the supported subset returns null, and the caller treats the series as unreadable.
 */

export interface GraphRecurrencePattern {
  type?: string
  interval?: number
  month?: number
  dayOfMonth?: number
  daysOfWeek?: string[]
  firstDayOfWeek?: string
  index?: string
}

export interface GraphRecurrenceRange {
  type?: string
  startDate?: string
  endDate?: string
  recurrenceTimeZone?: string
  numberOfOccurrences?: number
}

export interface GraphRecurrence {
  pattern?: GraphRecurrencePattern
  range?: GraphRecurrenceRange
}

export type SeriesEnd = { kind: 'none' } | { kind: 'count'; count: number } | { kind: 'until'; date: string }

export interface SeriesPattern {
  /** First occurrence date, on or after range.startDate. */
  readonly first: string
  /** The rule without its end part (no COUNT/UNTIL), INTERVAL always present. */
  readonly rule: string
  readonly end: SeriesEnd
  /** True when `date` is an occurrence date of the series: on the pattern, in phase, in range. */
  matches(date: string): boolean
  /** Occurrence dates from the first one, at most `limit` (and never past the range end). */
  expand(limit: number): string[]
}

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const
const RFC_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const
const INDEX: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, last: -1 }
const MAX_INTERVAL = 1000
const MAX_COUNT = 10000
/** Periods scanned to find the first occurrence; every accepted pattern matches in each period. */
const MAX_SCAN_PERIODS = 60
const DAY_MS = 86_400_000

/** Days since 1970-01-01 for a strict YYYY-MM-DD calendar date, else null. */
export function dayNumber(date: string | undefined): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? '')
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const ms = Date.UTC(y, mo - 1, d)
  const back = new Date(ms)
  if (y < 1 || back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  return ms / DAY_MS
}

export function dateOf(day: number): string {
  const d = new Date(day * DAY_MS)
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

const weekday = (day: number) => ((day % 7) + 7 + 4) % 7 // 1970-01-01 was a Thursday
const ymOf = (day: number) => { const d = new Date(day * DAY_MS); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 } }
const monthIndex = (day: number) => { const { y, m } = ymOf(day); return y * 12 + (m - 1) }
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()
const firstOfMonth = (y: number, m: number) => Date.UTC(y, m - 1, 1) / DAY_MS

type Kind = 'daily' | 'weekly' | 'absoluteMonthly' | 'relativeMonthly' | 'absoluteYearly' | 'relativeYearly'

interface Parsed {
  kind: Kind
  interval: number
  days: number[]
  wkst: number
  dayOfMonth: number
  month: number
  setpos: number
}

function parseDays(names: unknown): number[] | null {
  if (!Array.isArray(names) || names.length === 0) return null
  const days = new Set<number>()
  for (const name of names) {
    const i = typeof name === 'string' ? DAY_NAMES.indexOf(name.toLowerCase() as typeof DAY_NAMES[number]) : -1
    if (i < 0) return null
    days.add(i)
  }
  return [...days].sort((a, b) => a - b)
}

const isInt = (n: unknown, min: number, max: number): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max

function parsePattern(p: GraphRecurrencePattern | undefined): Parsed | null {
  if (!p || !isInt(p.interval, 1, MAX_INTERVAL)) return null
  const kind = p.type as Kind
  const base = { kind, interval: p.interval, days: [] as number[], wkst: 0, dayOfMonth: 0, month: 0, setpos: 0 }
  const relative = (): Parsed | null => {
    const days = parseDays(p.daysOfWeek)
    const setpos = INDEX[(p.index ?? 'first').toLowerCase()]
    return days && setpos ? { ...base, days, setpos } : null
  }
  switch (kind) {
    case 'daily':
      return base
    case 'weekly': {
      const days = parseDays(p.daysOfWeek)
      const wkst = DAY_NAMES.indexOf((p.firstDayOfWeek ?? 'sunday').toLowerCase() as typeof DAY_NAMES[number])
      return days && wkst >= 0 ? { ...base, days, wkst } : null
    }
    // Days 29-31: Outlook's behaviour in shorter months (skip or last day) is not documented for
    // Graph, so these are left out rather than risk a different set of dates.
    case 'absoluteMonthly':
      return isInt(p.dayOfMonth, 1, 28) ? { ...base, dayOfMonth: p.dayOfMonth } : null
    case 'relativeMonthly':
      return relative()
    case 'absoluteYearly':
      // Same rule: a date every year has (Feb 29 and impossible dates are left out).
      return isInt(p.month, 1, 12) && isInt(p.dayOfMonth, 1, p.month === 2 ? 28 : daysInMonth(2001, p.month))
        ? { ...base, month: p.month, dayOfMonth: p.dayOfMonth }
        : null
    case 'relativeYearly': {
      const r = relative()
      return r && isInt(p.month, 1, 12) ? { ...r, month: p.month } : null
    }
    default:
      return null
  }
}

/** Occurrence days of one month for the monthly/yearly kinds. */
function monthDays(pt: Parsed, y: number, m: number): number[] {
  const start = firstOfMonth(y, m)
  if (pt.kind === 'absoluteMonthly' || pt.kind === 'absoluteYearly') return [start + pt.dayOfMonth - 1]
  const all: number[] = []
  for (let d = 0; d < daysInMonth(y, m); d++) if (pt.days.includes(weekday(start + d))) all.push(start + d)
  const pick = pt.setpos > 0 ? all[pt.setpos - 1] : all[all.length + pt.setpos]
  return pick === undefined ? [] : [pick]
}

/** The first day number (>= 0) that falls on the week-start day: weeks are counted from it. */
const weekEpoch = (pt: Parsed) => (pt.wkst - 4 + 7) % 7

/** The period index of `day` (days, weeks, months or years) and the occurrence days of a period. */
function periodOf(pt: Parsed, day: number): number {
  switch (pt.kind) {
    case 'daily': return day
    case 'weekly': return (day - ((weekday(day) - pt.wkst + 7) % 7) - weekEpoch(pt)) / 7
    case 'absoluteMonthly': case 'relativeMonthly': return monthIndex(day)
    default: return ymOf(day).y
  }
}

function periodDays(pt: Parsed, period: number): number[] {
  switch (pt.kind) {
    case 'daily': return [period]
    case 'weekly': {
      const weekStart = period * 7 + weekEpoch(pt)
      const out: number[] = []
      for (let i = 0; i < 7; i++) if (pt.days.includes(weekday(weekStart + i))) out.push(weekStart + i)
      return out
    }
    case 'absoluteMonthly': case 'relativeMonthly':
      return monthDays(pt, Math.floor(period / 12), (period % 12) + 1)
    default:
      return monthDays(pt, period, pt.month)
  }
}

function ruleOf(pt: Parsed): string {
  const byday = pt.days.map((d) => RFC_DAYS[d]).join(',')
  const relative = pt.days.length === 1 ? `BYDAY=${pt.setpos}${byday}` : `BYDAY=${byday};BYSETPOS=${pt.setpos}`
  switch (pt.kind) {
    case 'daily': return `FREQ=DAILY;INTERVAL=${pt.interval}`
    case 'weekly': return `FREQ=WEEKLY;INTERVAL=${pt.interval};BYDAY=${byday};WKST=${RFC_DAYS[pt.wkst]}`
    case 'absoluteMonthly': return `FREQ=MONTHLY;INTERVAL=${pt.interval};BYMONTHDAY=${pt.dayOfMonth}`
    case 'relativeMonthly': return `FREQ=MONTHLY;INTERVAL=${pt.interval};${relative}`
    case 'absoluteYearly': return `FREQ=YEARLY;INTERVAL=${pt.interval};BYMONTH=${pt.month};BYMONTHDAY=${pt.dayOfMonth}`
    case 'relativeYearly': return `FREQ=YEARLY;INTERVAL=${pt.interval};BYMONTH=${pt.month};${relative}`
  }
}

/** Parses a Graph recurrence into a series pattern; null when any part is outside the supported subset. */
export function seriesPattern(recurrence: GraphRecurrence | null | undefined): SeriesPattern | null {
  const pt = parsePattern(recurrence?.pattern ?? undefined)
  const range = recurrence?.range
  const startDay = dayNumber(range?.startDate)
  if (!pt || !range || startDay === null) return null

  let first: number | null = null
  for (let p = periodOf(pt, startDay), n = 0; first === null && n < MAX_SCAN_PERIODS; p++, n++) {
    first = periodDays(pt, p).find((d) => d >= startDay) ?? null
  }
  if (first === null) return null
  const firstDay = first
  const firstPeriod = periodOf(pt, firstDay)

  const inPattern = (day: number): boolean => {
    if (day < firstDay) return false
    const offset = periodOf(pt, day) - firstPeriod
    return offset % pt.interval === 0 && periodDays(pt, periodOf(pt, day)).includes(day)
  }
  function* walk(): Generator<number> {
    for (let p = firstPeriod; ; p += pt!.interval) for (const d of periodDays(pt!, p)) if (d >= firstDay) yield d
  }

  let end: SeriesEnd
  let lastDay = Infinity
  if (range.type === 'noEnd') {
    end = { kind: 'none' }
  } else if (range.type === 'endDate') {
    const endDay = dayNumber(range.endDate)
    if (endDay === null || endDay < firstDay) return null
    end = { kind: 'until', date: dateOf(endDay) }
    lastDay = endDay
  } else if (range.type === 'numbered') {
    if (!isInt(range.numberOfOccurrences, 1, MAX_COUNT)) return null
    end = { kind: 'count', count: range.numberOfOccurrences }
    let n = 0
    for (const d of walk()) if (++n === range.numberOfOccurrences) { lastDay = d; break }
  } else {
    return null
  }

  return {
    first: dateOf(firstDay),
    rule: ruleOf(pt),
    end,
    matches(date: string) {
      const day = dayNumber(date)
      return day !== null && day <= lastDay && inPattern(day)
    },
    expand(limit: number) {
      const out: string[] = []
      if (limit <= 0) return out
      for (const d of walk()) {
        if (d > lastDay) break
        out.push(dateOf(d))
        if (out.length >= limit) break
      }
      return out
    },
  }
}

/** The full RRULE value; `until` is the formatted UNTIL value for an endDate range (DATE or UTC DATE-TIME). */
export function rruleFor(series: SeriesPattern, until?: string): string | null {
  if (series.end.kind === 'none') return series.rule
  if (series.end.kind === 'count') return `${series.rule};COUNT=${series.end.count}`
  return until ? `${series.rule};UNTIL=${until}` : null
}
