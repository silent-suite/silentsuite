import 'temporal-polyfill/global'

/** Return the IANA TZ name to use for the calendar grid: user preference, then browser local. */
export function resolveUserTimezone(preferred: string | undefined): string {
  if (preferred) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: preferred })
      return preferred
    } catch {
      // fall through
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** Wall-clock components of `date` as observed in `tz`. */
export function partsInZone(date: Date, tz: string): {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
} {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const parts = fmt.formatToParts(date)
  const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10)
  let hour = get('hour')
  if (hour === 24) hour = 0 // Intl midnight edge case
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
  }
}

/** YYYY-MM-DD wall-clock date in `tz`, suitable for <input type="date">. */
export function formatDateForInputInZone(date: Date, tz: string): string {
  const p = partsInZone(date, tz)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

/** HH:MM 24h wall-clock time in `tz`, suitable for <input type="time">. */
export function formatTimeForInputInZone(date: Date, tz: string): string {
  const p = partsInZone(date, tz)
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
}

/** Build a UTC instant from a wall-clock interpreted in `tz`. */
export function instantFromWallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): Date {
  const zdt = Temporal.PlainDateTime.from({
    year,
    month,
    day,
    hour,
    minute,
    second: 0,
  }).toZonedDateTime(tz)
  return new Date(zdt.epochMilliseconds)
}

/** Short timezone label for badges, e.g. "GMT+2" or city name. */
export function shortTimezoneLabel(tz: string, refDate: Date = new Date()): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'short',
    })
    const parts = fmt.formatToParts(refDate)
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? tz
  } catch {
    return tz
  }
}
