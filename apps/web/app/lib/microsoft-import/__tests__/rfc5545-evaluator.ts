/*
 * Test-only RFC 5545 RRULE evaluator for the subset the Microsoft mapper emits:
 * FREQ DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, BYMONTH, BYMONTHDAY (positive), BYDAY (plain or with
 * ordinal, ordinals relative to the month), BYSETPOS, COUNT, UNTIL (DATE or UTC DATE-TIME), WKST.
 *
 * Written from RFC 5545 §3.3.10 independently of the mapper's Graph pattern matcher, and used as an
 * oracle instead of packages/core's expander (which ignores ordinal BYDAY and BYSETPOS). It works on
 * calendar dates; a timed DTSTART's time of day and TZID only matter for comparing with UNTIL.
 */

const CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

interface Rule {
  freq: string
  interval: number
  bymonth?: number[]
  bymonthday?: number[]
  byday?: { ord: number; wd: number }[]
  bysetpos?: number[]
  count?: number
  until?: string
  wkst: number
}

function parseRule(rrule: string): Rule {
  const parts = new Map<string, string>()
  for (const part of rrule.split(';')) {
    const [k, v] = part.split('=')
    if (!k || v === undefined || parts.has(k)) throw new Error(`bad RRULE part ${part}`)
    parts.set(k, v)
  }
  const known = new Set(['FREQ', 'INTERVAL', 'BYMONTH', 'BYMONTHDAY', 'BYDAY', 'BYSETPOS', 'COUNT', 'UNTIL', 'WKST'])
  for (const k of parts.keys()) if (!known.has(k)) throw new Error(`unsupported ${k}`)
  if (parts.has('COUNT') && parts.has('UNTIL')) throw new Error('COUNT and UNTIL')
  const ints = (v: string | undefined) => v?.split(',').map((x) => { const n = Number(x); if (!Number.isInteger(n)) throw new Error(x); return n })
  return {
    freq: parts.get('FREQ')!,
    interval: Number(parts.get('INTERVAL') ?? 1),
    bymonth: ints(parts.get('BYMONTH')),
    bymonthday: ints(parts.get('BYMONTHDAY')),
    byday: parts.get('BYDAY')?.split(',').map((x) => {
      const m = /^([+-]?\d)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(x)
      if (!m) throw new Error(x)
      return { ord: m[1] ? Number(m[1]) : 0, wd: CODES.indexOf(m[2]!) }
    }),
    bysetpos: ints(parts.get('BYSETPOS')),
    count: parts.has('COUNT') ? Number(parts.get('COUNT')) : undefined,
    until: parts.get('UNTIL'),
    wkst: CODES.indexOf(parts.get('WKST') ?? 'MO'),
  }
}

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))
const iso = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000)

function daysOfMonth(y: number, m: number): Date[] {
  const out: Date[] = []
  for (let d = utc(y, m, 1); d.getUTCMonth() === m - 1; d = addDays(d, 1)) out.push(d)
  return out
}

/** Dates of one month selected by BYMONTHDAY / BYDAY (ordinals within the month). */
function inMonth(rule: Rule, y: number, m: number, dtstart: Date): Date[] {
  const all = daysOfMonth(y, m)
  if (rule.bymonthday) return all.filter((d) => rule.bymonthday!.includes(d.getUTCDate()))
  if (rule.byday) {
    const out: Date[] = []
    for (const { ord, wd } of rule.byday) {
      const same = all.filter((d) => d.getUTCDay() === wd)
      if (ord === 0) out.push(...same)
      else { const pick = ord > 0 ? same[ord - 1] : same[same.length + ord]; if (pick) out.push(pick) }
    }
    return out
  }
  return all.filter((d) => d.getUTCDate() === dtstart.getUTCDate())
}

function candidates(rule: Rule, period: number, dtstart: Date): Date[] {
  const y0 = dtstart.getUTCFullYear(), m0 = dtstart.getUTCMonth() + 1
  let set: Date[]
  switch (rule.freq) {
    case 'DAILY':
      set = [addDays(dtstart, period * rule.interval)]
      break
    case 'WEEKLY': {
      const back = (dtstart.getUTCDay() - rule.wkst + 7) % 7
      const weekStart = addDays(dtstart, -back + 7 * period * rule.interval)
      const week = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
      const wds = rule.byday ? rule.byday.map((b) => b.wd) : [dtstart.getUTCDay()]
      set = week.filter((d) => wds.includes(d.getUTCDay()))
      break
    }
    case 'MONTHLY': {
      const idx = (y0 * 12 + m0 - 1) + period * rule.interval
      const y = Math.floor(idx / 12), m = (idx % 12) + 1
      set = rule.bymonth && !rule.bymonth.includes(m) ? [] : inMonth(rule, y, m, dtstart)
      break
    }
    case 'YEARLY': {
      const y = y0 + period * rule.interval
      set = (rule.bymonth ?? [m0]).flatMap((m) => inMonth(rule, y, m, dtstart))
      break
    }
    default:
      throw new Error(`unsupported FREQ ${rule.freq}`)
  }
  set = [...new Map(set.map((d) => [d.getTime(), d])).values()].sort((a, b) => a.getTime() - b.getTime())
  if (rule.bysetpos) {
    const n = set.length
    set = rule.bysetpos.map((p) => (p > 0 ? set[p - 1] : set[n + p])).filter((d): d is Date => !!d)
      .sort((a, b) => a.getTime() - b.getTime())
  }
  return set
}

/** UTC instant of a wall clock in an IANA zone (first match; test fixtures avoid DST gaps). */
function zonedInstant(date: string, time: string, zone: string): number {
  const target = Date.parse(`${date}T${time}Z`)
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
    const ms = target - offset * 60_000
    const f = new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    if (f.format(new Date(ms)).replace(' ', 'T') === `${date}T${time}`) return ms
  }
  throw new Error('no instant')
}

export interface EvalStart {
  /** YYYY-MM-DD */
  date: string
  /** HH:MM:SS for a timed DTSTART; absent for VALUE=DATE. */
  time?: string
  /** TZID of a timed DTSTART (UTC when absent). */
  tzid?: string
}

/** Occurrence dates (YYYY-MM-DD) of DTSTART + RRULE, at most `limit`. Throws if DTSTART is not an instance. */
export function evaluateRRule(start: EvalStart, rrule: string, limit = 50, maxPeriods = 5000): string[] {
  const rule = parseRule(rrule)
  const [y, m, d] = start.date.split('-').map(Number)
  const dtstart = utc(y!, m!, d!)
  const untilOk = (date: Date): boolean => {
    if (!rule.until) return true
    if (/^\d{8}$/.test(rule.until)) return iso(date).replace(/-/g, '') <= rule.until
    const u = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(rule.until)
    if (!u || !start.time) throw new Error('UNTIL type must match DTSTART')
    const untilMs = Date.UTC(+u[1]!, +u[2]! - 1, +u[3]!, +u[4]!, +u[5]!, +u[6]!)
    const at = start.tzid ? zonedInstant(iso(date), start.time, start.tzid) : Date.parse(`${iso(date)}T${start.time}Z`)
    return at <= untilMs
  }
  const out: string[] = []
  for (let p = 0; p < maxPeriods; p++) {
    const set = candidates(rule, p, dtstart).filter((x) => x.getTime() >= dtstart.getTime())
    if (p === 0 && (set.length === 0 || set[0]!.getTime() !== dtstart.getTime())) throw new Error('DTSTART is not the first instance')
    for (const date of set) {
      if (!untilOk(date)) return out
      out.push(iso(date))
      if (out.length >= limit || (rule.count !== undefined && out.length >= rule.count)) return out
    }
  }
  return out
}
