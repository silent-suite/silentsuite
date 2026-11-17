import type { DateRange } from '../models/types.js';
import { resolveTimeZone, wallTimeInZone, wallTimeToInstant } from './zoned-time.js';

/**
 * Options for {@link expandRecurrence}.
 */
export interface RecurrenceOptions {
  /** IANA zone or 'UTC' in which DTSTART's wall clock repeats. Omitted = host-local
   *  (floating and all-day events, and legacy callers). Windows labels resolve through CLDR;
   *  an unknown explicit label uses the parser's deterministic UTC approximation. */
  timeZone?: string;
  /** DTSTART's intended wall clock (`YYYYMMDDTHHMMSS`) in `timeZone`, for a DTSTART inside a DST
   *  gap whose wall time cannot be recovered from the instant. Used only with an IANA zone and only
   *  when it resolves exactly to `dtstart`; otherwise ignored. */
  startWallClock?: string;
}

/**
 * Parse an RRULE string into its component parts.
 */
interface RRuleParts {
  freq: string;
  interval: number;
  count?: number;
  /** Raw UNTIL value; resolved in the expansion zone. */
  until?: string;
  byday?: string[];
  bymonth?: number[];
  bymonthday?: number[];
  bysetpos?: number[];
  wkst?: string;
}

function parseRRule(rrule: string): RRuleParts {
  // Strip "RRULE:" prefix if present
  const rule = rrule.replace(/^RRULE:/i, '');
  const parts: Record<string, string> = {};
  for (const segment of rule.split(';')) {
    const eqIdx = segment.indexOf('=');
    if (eqIdx !== -1) {
      parts[segment.slice(0, eqIdx).toUpperCase()] = segment.slice(eqIdx + 1);
    }
  }

  const result: RRuleParts = {
    freq: parts['FREQ'] ?? 'DAILY',
    interval: parts['INTERVAL'] ? parseInt(parts['INTERVAL'], 10) : 1,
  };

  if (parts['COUNT']) {
    result.count = parseInt(parts['COUNT'], 10);
  }
  if (parts['UNTIL']) {
    result.until = parts['UNTIL'];
  }
  if (parts['BYDAY']) {
    result.byday = parts['BYDAY'].split(',');
  }
  if (parts['BYMONTH']) {
    result.bymonth = parts['BYMONTH'].split(',').map((m) => parseInt(m, 10));
  }
  if (parts['BYMONTHDAY']) {
    result.bymonthday = parts['BYMONTHDAY'].split(',').map((d) => parseInt(d, 10));
  }

  if (parts['BYSETPOS']) result.bysetpos = parts['BYSETPOS'].split(',').map(Number);
  result.wkst = parts['WKST']?.toUpperCase() ?? 'MO';
  result.freq = result.freq.toUpperCase();
  if (!Number.isSafeInteger(result.interval) || result.interval < 1) result.interval = 1;
  return result;
}

// ── Zone adapter ──
//
// The loop works on "civil" values: the wall clock in the expansion zone encoded as
// Date.UTC(fields) milliseconds, manipulated only with UTC getters/setters. A Zone converts
// between instants and civil values.

const DAY_MS = 24 * 60 * 60 * 1000;

interface Zone {
  toCivil(instantMs: number): number;
  fromCivil(civilMs: number): number;
}

/** Host-local zone: today's Date semantics (a wall time in a host DST gap moves past the gap). */
const HOST_ZONE: Zone = {
  toCivil(instantMs) {
    const d = new Date(instantMs);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
  },
  fromCivil(civilMs) {
    const c = new Date(civilMs);
    return new Date(
      c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate(),
      c.getUTCHours(), c.getUTCMinutes(), c.getUTCSeconds(), c.getUTCMilliseconds(),
    ).getTime();
  },
};

const UTC_ZONE: Zone = {
  toCivil: (instantMs) => instantMs,
  fromCivil: (civilMs) => civilMs,
};

const msPart = (ms: number): number => ((ms % 1000) + 1000) % 1000;

function ianaZone(timeZone: string): Zone {
  return {
    toCivil(instantMs) {
      const ms = msPart(instantMs);
      return wallTimeInZone(timeZone, instantMs - ms) + ms;
    },
    fromCivil(civilMs) {
      const ms = msPart(civilMs);
      const instant = wallTimeToInstant(timeZone, civilMs - ms);
      return instant === null ? HOST_ZONE.fromCivil(civilMs) : instant + ms;
    },
  };
}

function resolveZone(timeZone: string | undefined): Zone {
  if (timeZone === undefined) return HOST_ZONE;
  if (timeZone.toUpperCase() === 'UTC') return UTC_ZONE;
  const resolved = resolveTimeZone(timeZone);
  return resolved ? ianaZone(resolved) : UTC_ZONE;
}

/**
 * The civil date (YYYYMMDD) of the day before `instance`, taken in `timeZone` (an IANA zone or
 * 'UTC'; omitted = host-local). Used as a date-only UNTIL that ends a series before an occurrence.
 * The day is computed on the zone's calendar, so a host DST change cannot move it.
 */
export function untilDateBefore(instance: Date, timeZone?: string): string {
  const civil = new Date(resolveZone(timeZone).toCivil(instance.getTime()));
  civil.setUTCDate(civil.getUTCDate() - 1);
  const y = civil.getUTCFullYear();
  const m = String(civil.getUTCMonth() + 1).padStart(2, '0');
  const d = String(civil.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/**
 * A date-time UNTIL that ends a timed series before the occurrence at `instance`, so the
 * occurrence on the previous day stays in the series. With a zone (an IANA zone or 'UTC') it is
 * the UTC instant one second before the occurrence (`…Z`), as RFC 5545 requires for a zoned
 * DTSTART. Without one (floating) it is 23:59:59 on the previous day as a floating wall clock;
 * pass the occurrence's own `wallClock` (YYYYMMDDTHHMMSS, see occurrenceWallClock) so a host DST
 * gap cannot move it to another date. A floating series with several occurrences a day also
 * loses the earlier ones on the selected day.
 */
export function untilTimeBefore(instance: Date, timeZone?: string, wallClock?: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = (c: Date) => `${c.getUTCFullYear()}${pad(c.getUTCMonth() + 1)}${pad(c.getUTCDate())}`;
  if (timeZone !== undefined) {
    const c = new Date(Math.floor(instance.getTime() / 1000) * 1000 - 1000);
    return `${date(c)}T${pad(c.getUTCHours())}${pad(c.getUTCMinutes())}${pad(c.getUTCSeconds())}Z`;
  }
  const c = new Date(parseWallClock(wallClock) ?? HOST_ZONE.toCivil(instance.getTime()));
  c.setUTCDate(c.getUTCDate() - 1);
  return `${date(c)}T235959`;
}

/** UNTIL as an instant: `…Z` is absolute; a date or floating value is a wall clock in the zone. */
function parseUntil(value: string, zone: Zone): number {
  // Formats: 20260313, 20260313T120000, 20260313T120000Z
  const clean = value.replace(/[^0-9TZ]/g, '');
  const year = parseInt(clean.slice(0, 4), 10);
  const month = parseInt(clean.slice(4, 6), 10) - 1;
  const day = parseInt(clean.slice(6, 8), 10);

  if (clean.length <= 8) {
    return zone.fromCivil(Date.UTC(year, month, day));
  }

  const hour = parseInt(clean.slice(9, 11), 10);
  const minute = parseInt(clean.slice(11, 13), 10);
  const second = parseInt(clean.slice(13, 15), 10);

  if (clean.endsWith('Z')) {
    return Date.UTC(year, month, day, hour, minute, second);
  }
  return zone.fromCivil(Date.UTC(year, month, day, hour, minute, second));
}

const DAY_MAP: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

/**
 * Civil and instant orderings can disagree only when two values are closer than the largest
 * possible difference of two UTC offsets (-12h..+14h, so 26h). Beyond this margin a civil
 * comparison is decisive and no Intl conversion is needed.
 */
const CIVIL_MARGIN_MS = 36 * 60 * 60 * 1000;

/**
 * Civil ms for the given fields. Unlike `Date.UTC`, a year 0-99 is not read as 1900-1999, so a
 * civil year stays the year given (as the previous `setUTCFullYear` stepping kept it). Fields
 * out of range roll over as with `Date.UTC` (day 0 is the last day of the previous month).
 */
function civilAt(year: number, month: number, day: number, h = 0, mi = 0, s = 0, ms = 0): number {
  const c = new Date(0);
  c.setUTCFullYear(year, month, day);
  c.setUTCHours(h, mi, s, ms);
  return c.getTime();
}

/** Calendar-period start, independent of DTSTART's weekday/day of month. */
function periodStart(rule: RRuleParts, start: Date, index: number): number {
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth();
  const day = start.getUTCDate();
  const step = index * rule.interval;
  switch (rule.freq) {
    case 'YEARLY': return civilAt(year + step, 0, 1);
    case 'MONTHLY': return civilAt(year, month + step, 1);
    case 'WEEKLY': {
      const weekStart = DAY_MAP[rule.wkst ?? 'MO'] ?? 1;
      return civilAt(year, month, day - (start.getUTCDay() - weekStart + 7) % 7 + step * 7);
    }
    default: return civilAt(year, month, day + step);
  }
}

function matchesWeekday(day: Date, values: string[], ordinalYear: boolean): boolean {
  return values.some(value => {
    const match = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(value);
    if (!match || DAY_MAP[match[2]!.toUpperCase()] !== day.getUTCDay()) return false;
    if (!match[1]) return true;
    const ordinal = Number(match[1]);
    if (!ordinal) return false;
    const year = day.getUTCFullYear();
    const first = ordinalYear ? civilAt(year, 0, 1) : civilAt(year, day.getUTCMonth(), 1);
    const after = ordinalYear ? civilAt(year + 1, 0, 1) : civilAt(year, day.getUTCMonth() + 1, 1);
    const at = civilAt(year, day.getUTCMonth(), day.getUTCDate());
    return ordinal > 0 ? Math.floor((at - first) / DAY_MS / 7) + 1 === ordinal
      : Math.floor((after - DAY_MS - at) / DAY_MS / 7) + 1 === -ordinal;
  });
}

/** Sorted, unique candidates for one frequency period; BYSETPOS is applied last. */
function periodCandidates(rule: RRuleParts, start: Date, first: number, zone: Zone): number[] {
  const date = new Date(first);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const time = start.getUTCHours() * 3600000 + start.getUTCMinutes() * 60000 + start.getUTCSeconds() * 1000 + start.getUTCMilliseconds();
  const possible: number[] = [];
  if (rule.freq === 'YEARLY' || rule.freq === 'MONTHLY') {
    // Select months and month days before allocating dates or resolving host-zone gaps.
    // Birthdays anchored decades ago need only one candidate per year.
    const months = rule.freq === 'MONTHLY' ? [month]
      : rule.bymonth?.length ? [...new Set(rule.bymonth.filter(value => value >= 1 && value <= 12).map(value => value - 1))].sort((a, b) => a - b)
        : !rule.byday?.length && !rule.bymonthday?.length ? [start.getUTCMonth()]
          : Array.from({ length: 12 }, (_, index) => index);
    for (const candidateMonth of months) {
      if (rule.bymonth?.length && !rule.bymonth.includes(candidateMonth + 1)) continue;
      const monthStart = civilAt(year, candidateMonth, 1);
      const last = new Date(civilAt(year, candidateMonth + 1, 0)).getUTCDate();
      const days = rule.bymonthday?.length
        ? [...new Set(rule.bymonthday.map(value => value < 0 ? last + value + 1 : value))].sort((a, b) => a - b)
        : rule.byday?.length ? Array.from({ length: last }, (_, index) => index + 1) : [start.getUTCDate()];
      for (const day of days) {
        if (day >= 1 && day <= last) possible.push(monthStart + (day - 1) * DAY_MS + time);
      }
    }
  } else {
    for (let i = 0; i < (rule.freq === 'WEEKLY' ? 7 : 1); i++) possible.push(first + i * DAY_MS + time);
  }
  const matches = (at: number): boolean => {
    const day = new Date(at);
    if (rule.bymonth?.length && !rule.bymonth.includes(day.getUTCMonth() + 1)) return false;
    if (rule.freq === 'YEARLY' && !rule.bymonth?.length && !rule.byday?.length && !rule.bymonthday?.length
      && day.getUTCMonth() !== start.getUTCMonth()) return false;
    if (rule.bymonthday?.length) {
      const last = new Date(civilAt(day.getUTCFullYear(), day.getUTCMonth() + 1, 0)).getUTCDate();
      if (!rule.bymonthday.some(value => (value < 0 ? last + value + 1 : value) === day.getUTCDate())) return false;
    }
    if (rule.byday?.length) return matchesWeekday(day, rule.byday, rule.freq === 'YEARLY' && !rule.bymonth?.length);
    return rule.freq !== 'WEEKLY' || day.getUTCDay() === start.getUTCDay();
  };
  const candidates: number[] = [];
  for (let at of possible) {
    if (!matches(at)) continue;
    if (zone === HOST_ZONE && !hostDateExists(at)) {
      at = HOST_ZONE.toCivil(HOST_ZONE.fromCivil(at));
      // A skipped civil date may resolve onto a different weekday or month.
      if (!matches(at)) continue;
    }
    candidates.push(at);
  }
  if (!rule.bysetpos?.length) return [...new Set(candidates)];
  return [...new Set(rule.bysetpos.map(position => candidates[position > 0 ? position - 1 : candidates.length + position])
    .filter((value): value is number => value !== undefined))].sort((a, b) => a - b);
}

/**
 * Expand an RRULE into occurrence dates within a given DateRange.
 * Filters out EXDATE exceptions.
 *
 * Occurrences repeat DTSTART's wall clock in `options.timeZone` (or host-local when omitted).
 * BYDAY/BYMONTH/BYMONTHDAY are evaluated on that zone's calendar. Each occurrence is computed
 * from the wall clock, so a time in a DST gap moves past the gap on that day only.
 */
export function expandRecurrence(
  rrule: string,
  dtstart: Date,
  range: DateRange,
  exdates?: Date[],
  options?: RecurrenceOptions,
): Date[] {
  // Each occurrence instant is emitted once. In a zone that skipped a whole date, a missing civil
  // day can resolve onto the next day's instant; COUNT has already counted both civil candidates.
  const seen = new Set<number>();
  const out: Date[] = [];
  for (const o of expandWithCivil(rrule, dtstart, range, exdates, options)) {
    if (seen.has(o.at)) continue;
    seen.add(o.at);
    out.push(new Date(o.at));
  }
  return out;
}

/**
 * The series wall clock (`YYYYMMDDTHHMMSS`, in `options.timeZone`) of the occurrence generated at
 * exactly `instance`, taken from the same recurrence stepping as {@link expandRecurrence} (EXDATEs
 * ignored). Undefined unless exactly one generated occurrence has that instant.
 */
export function occurrenceWallClock(
  rrule: string,
  dtstart: Date,
  instance: Date,
  options?: RecurrenceOptions,
): string | undefined {
  const matches = expandWithCivil(rrule, dtstart, { start: instance, end: instance }, [], options)
    .filter((o) => o.at === instance.getTime());
  if (matches.length !== 1) return undefined;
  const c = new Date(matches[0]!.civil);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${c.getUTCFullYear()}${pad(c.getUTCMonth() + 1)}${pad(c.getUTCDate())}T${pad(c.getUTCHours())}${pad(c.getUTCMinutes())}${pad(c.getUTCSeconds())}`;
}

/**
 * How many RRULE occurrences the series generates before `instance`, counted the way COUNT counts
 * them: EXDATEs do not reduce it, and a date the host skipped still counts once per candidate.
 */
export function occurrencesBefore(
  rrule: string,
  dtstart: Date,
  instance: Date,
  options?: RecurrenceOptions,
): number {
  if (instance.getTime() <= dtstart.getTime()) return 0;
  return expandWithCivil(rrule, dtstart, { start: dtstart, end: new Date(instance.getTime() - 1) }, [], options).length;
}

/** Decode a `YYYYMMDDTHHMMSS` wall clock to civil ms, or undefined. */
function parseWallClock(wall: string | undefined): number | undefined {
  if (!wall) return undefined;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(wall);
  if (!m) return undefined;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

interface CivilOccurrence {
  /** Occurrence instant (ms). */
  at: number;
  /** Occurrence wall clock in the expansion zone, as civil ms. */
  civil: number;
}

/**
 * True when the host calendar has the civil date of `civil` (civil ms). A host that skipped an
 * entire day (e.g. Pacific/Apia on 2011-12-30) resolves that date's midnight to a later date;
 * hour gaps, including a gap at midnight, resolve within the same date.
 */
function hostDateExists(civil: number): boolean {
  const day = Math.floor(civil / DAY_MS);
  return Math.floor(HOST_ZONE.toCivil(HOST_ZONE.fromCivil(day * DAY_MS)) / DAY_MS) === day;
}

function expandWithCivil(
  rrule: string,
  dtstart: Date,
  range: DateRange,
  exdates?: Date[],
  options?: RecurrenceOptions,
): CivilOccurrence[] {
  const zone = resolveZone(options?.timeZone);
  const rule = parseRRule(rrule);
  const results: CivilOccurrence[] = [];
  const exdateSet = new Set(exdates?.map((d) => d.getTime()) ?? []);
  const MAX_ITERATIONS = 10000; // safety limit

  const untilMs = rule.until !== undefined ? parseUntil(rule.until, zone) : undefined;
  const untilCivil = untilMs !== undefined ? zone.toCivil(untilMs) : undefined;
  const rangeStartMs = range.start.getTime();
  const rangeEndMs = range.end.getTime();
  const rangeStartCivil = zone.toCivil(rangeStartMs);
  const rangeEndCivil = zone.toCivil(rangeEndMs);

  // A DST-gap DTSTART's intended wall clock cannot be recovered from the instant; when supplied
  // and consistent with DTSTART, later occurrences repeat it instead of the normalized clock.
  const suppliedCivil = zone !== HOST_ZONE && zone !== UTC_ZONE ? parseWallClock(options?.startWallClock) : undefined;
  const civilDtstart = new Date(
    suppliedCivil !== undefined && zone.fromCivil(suppliedCivil) === dtstart.getTime()
      ? suppliedCivil
      : zone.toCivil(dtstart.getTime()),
  );
  const firstCivil = civilDtstart.getTime();
  if (!Number.isFinite(firstCivil) || !Number.isFinite(rangeEndCivil)) return [];
  const supportedFrequency = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq);
  let count = 0;
  let previousCivil: number | undefined;

  for (let period = 0; period < (supportedFrequency ? MAX_ITERATIONS : 1); period++) {
    const first = periodStart(rule, civilDtstart, period);
    if (!Number.isFinite(first) || first > rangeEndCivil + CIVIL_MARGIN_MS) break;
    if (untilCivil !== undefined && first > untilCivil + CIVIL_MARGIN_MS) break;
    // Preserve the seed-only fallback for frequencies this engine does not expand.
    const candidates = supportedFrequency ? periodCandidates(rule, civilDtstart, first, zone).filter(civil => civil >= firstCivil) : [firstCivil];
    // DTSTART always counts first, even when an imported rule does not match its seed.
    if (period === 0 && !candidates.includes(firstCivil)) candidates.unshift(firstCivil);
    for (const civil of candidates) {
      // A date absent from the host calendar is not a second candidate for its next day.
      if (civil === previousCivil) continue;
      previousCivil = civil;
      let instant: number | undefined = civil === firstCivil ? dtstart.getTime() : undefined;
      const instantOf = (): number => (instant ??= zone.fromCivil(civil));
      if (untilMs !== undefined && untilCivil !== undefined) {
        if (civil > untilCivil + CIVIL_MARGIN_MS) return results;
        if (civil >= untilCivil - CIVIL_MARGIN_MS && instantOf() > untilMs) return results;
      }
      if (civil > rangeEndCivil + CIVIL_MARGIN_MS) return results;
      if (civil >= rangeEndCivil - CIVIL_MARGIN_MS && instantOf() > rangeEndMs) return results;
      count++;
      if (civil >= rangeStartCivil - CIVIL_MARGIN_MS) {
        const at = instantOf();
        if (at >= rangeStartMs && !exdateSet.has(at)) results.push({ at, civil });
      }
      if (rule.count !== undefined && count >= rule.count) return results;
    }
  }
  return results;
}
