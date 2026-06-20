import { describe, expect, it } from 'vitest'
import {
  endOfWeek,
  getWeekNumber,
  startOfWeek,
  weekdayLabels,
  weekStartIndex,
} from '../date'

function ymd(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${m}-${d}`
}

describe('weekStartIndex', () => {
  it('maps the preference to a JS getDay() index', () => {
    expect(weekStartIndex('monday')).toBe(1)
    expect(weekStartIndex('sunday')).toBe(0)
  })
})

describe('weekdayLabels', () => {
  it('orders labels from Monday for monday-start', () => {
    expect(weekdayLabels('monday')).toEqual(['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'])
  })

  it('orders labels from Sunday for sunday-start', () => {
    expect(weekdayLabels('sunday')).toEqual(['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'])
  })
})

describe('startOfWeek', () => {
  // 2026-06-20 is a Saturday.
  const saturday = new Date(2026, 5, 20, 14, 30)

  it('returns the Monday of the week for monday-start', () => {
    const start = startOfWeek(saturday, 'monday')
    expect(ymd(start)).toBe('2026-06-15') // Monday
    expect(start.getHours()).toBe(0)
  })

  it('returns the Sunday of the week for sunday-start', () => {
    const start = startOfWeek(saturday, 'sunday')
    expect(ymd(start)).toBe('2026-06-14') // Sunday
  })

  it('is idempotent on the first day itself', () => {
    const monday = new Date(2026, 5, 15)
    expect(ymd(startOfWeek(monday, 'monday'))).toBe('2026-06-15')
    const sunday = new Date(2026, 5, 14)
    expect(ymd(startOfWeek(sunday, 'sunday'))).toBe('2026-06-14')
  })
})

describe('endOfWeek', () => {
  const saturday = new Date(2026, 5, 20, 14, 30)

  it('returns the Sunday end-of-day for monday-start', () => {
    const end = endOfWeek(saturday, 'monday')
    expect(ymd(end)).toBe('2026-06-21') // Sunday
    expect(end.getHours()).toBe(23)
    expect(end.getMinutes()).toBe(59)
  })

  it('returns the Saturday end-of-day for sunday-start', () => {
    const end = endOfWeek(saturday, 'sunday')
    expect(ymd(end)).toBe('2026-06-20') // Saturday
    expect(end.getHours()).toBe(23)
  })
})

describe('getWeekNumber (monday-start = ISO-8601)', () => {
  it('week containing the first Thursday is week 1', () => {
    // 2026-01-01 is a Thursday → ISO 2026-W01.
    expect(getWeekNumber(new Date(2026, 0, 1), 'monday')).toBe(1)
  })

  it('late-December dates can belong to week 1 of the next year', () => {
    // 2024-12-30 (Monday) → ISO 2025-W01.
    expect(getWeekNumber(new Date(2024, 11, 30), 'monday')).toBe(1)
  })

  it('early-January dates can belong to the last week of the previous year', () => {
    // 2023-01-01 (Sunday) → ISO 2022-W52.
    expect(getWeekNumber(new Date(2023, 0, 1), 'monday')).toBe(52)
  })

  it('computes a mid-year week number', () => {
    // Week of Mon 2026-06-15 → ISO week 25.
    expect(getWeekNumber(new Date(2026, 5, 20), 'monday')).toBe(25)
    expect(getWeekNumber(new Date(2026, 5, 15), 'monday')).toBe(25)
  })

  it('gives every day in the same week the same number', () => {
    const numbers = new Set<number>()
    for (let day = 15; day <= 21; day++) {
      numbers.add(getWeekNumber(new Date(2026, 5, day), 'monday'))
    }
    expect(numbers).toEqual(new Set([25]))
  })
})

describe('getWeekNumber (sunday-start convention)', () => {
  it('numbers by the week-numbering year of the week Wednesday (4th day)', () => {
    // For sunday-start, the week Sun 2025-12-28 – Sat 2026-01-03 has its
    // Wednesday (2025-12-31) in 2025, so week 1 of 2026 starts Sun 2026-01-04.
    // The week of Sat 2026-06-20 (starting Sun 2026-06-14) is therefore week 24.
    expect(getWeekNumber(new Date(2026, 5, 20), 'sunday')).toBe(24)
    expect(getWeekNumber(new Date(2026, 5, 14), 'sunday')).toBe(24)
  })

  it('gives every day in the same sunday-start week the same number', () => {
    const numbers = new Set<number>()
    for (let day = 14; day <= 20; day++) {
      numbers.add(getWeekNumber(new Date(2026, 5, day), 'sunday'))
    }
    expect(numbers).toEqual(new Set([24]))
  })
})
