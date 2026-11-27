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
  return deviceTimezone()
}

/** The IANA zone this browser/device runs in. */
export function deviceTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/**
 * Timezone choices for a picker. `Intl.supportedValuesOf('timeZone')` leaves out
 * "UTC" and legacy aliases, so a select bound to such a value would show the first
 * entry instead. UTC always comes first, and `current` is kept when it is not listed.
 */
export function timezoneOptions(current?: string): string[] {
  let supported: string[]
  try {
    supported = Intl.supportedValuesOf('timeZone')
  } catch {
    supported = []
  }
  const rest = supported.filter((tz) => tz !== 'UTC')
  const head = ['UTC']
  if (current && current !== 'UTC' && !rest.includes(current)) head.unshift(current)
  return [...head, ...rest]
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

/** Readable zone name for labels, e.g. "Europe/Berlin (GMT+1)" or "UTC". */
export function timezoneDisplayName(tz: string, refDate: Date = new Date()): string {
  const name = tz.replace(/_/g, ' ')
  const short = shortTimezoneLabel(tz, refDate)
  return short === tz ? name : `${name} (${short})`
}

/** Whether clocks in `a` and `b` read differently at `refDate`. */
export function zonesShowDifferentTimes(a: string, b: string, refDate: Date = new Date()): boolean {
  if (a === b) return false
  const pa = partsInZone(refDate, a)
  const pb = partsInZone(refDate, b)
  return pa.day !== pb.day || pa.hour !== pb.hour || pa.minute !== pb.minute
}
