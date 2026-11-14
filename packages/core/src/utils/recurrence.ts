import type { DateRange } from '../models/types.js';
import { isKnownTimeZone, wallTimeInZone, wallTimeToInstant } from './zoned-time.js';

/**
 * Options for {@link expandRecurrence}.
 */
export interface RecurrenceOptions {
  /** IANA zone or 'UTC' in which DTSTART's wall clock repeats. Omitted = host-local
   *  (floating and all-day events, and legacy callers). A zone Intl does not know falls back
   *  to host-local, matching how the parser reads such a TZID. */
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
  return isKnownTimeZone(timeZone) ? ianaZone(timeZone) : HOST_ZONE;
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

function matchesByday(civil: Date, byday: string[]): boolean {
  const dow = civil.getUTCDay();
  return byday.some((day) => {
    // Strip any numeric prefix (e.g., "2MO" → "MO")
    const dayAbbr = day.replace(/^-?\d+/, '');
    return DAY_MAP[dayAbbr] === dow;
  });
}

function addInterval(civil: Date, freq: string, interval: number, civilDtstart: Date): Date {
  const result = new Date(civil.getTime());
  switch (freq) {
    case 'DAILY':
      result.setUTCDate(result.getUTCDate() + interval);
      break;
    case 'WEEKLY':
      result.setUTCDate(result.getUTCDate() + 7 * interval);
      break;
    case 'MONTHLY': {
      // Clamp to last day of target month to prevent drift (e.g. Jan 31 → Feb 28)
      const originalDay = civilDtstart.getUTCDate();
      result.setUTCMonth(result.getUTCMonth() + interval, 1); // Move to 1st of target month
      const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
      result.setUTCDate(Math.min(originalDay, lastDay));
      break;
    }
    // YEARLY is expanded per year from DTSTART by expandYearly.
  }
  return result;
}

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

/**
 * The candidate civil values of one year of a YEARLY rule, in order, at DTSTART's civil time of
 * day in the expansion zone. Each year is built from DTSTART rather than from the previous
 * occurrence, so a date that does not exist in a year (Feb 29) is skipped instead of moving to
 * Mar 1. With both BYMONTH and BYMONTHDAY, every listed month and day is generated; a negative
 * BYMONTHDAY counts back from the end of the month (-1 is the last day).
 */
function yearlyCandidates(rule: RRuleParts, civilDtstart: Date, year: number): number[] {
  const at = (month: number, day: number): number => civilAt(
    year, month, day,
    civilDtstart.getUTCHours(), civilDtstart.getUTCMinutes(), civilDtstart.getUTCSeconds(), civilDtstart.getUTCMilliseconds(),
  );
  if (rule.bymonth?.length && rule.bymonthday?.length) {
    const result: number[] = [];
    const months = [...new Set(rule.bymonth)].filter((m) => m >= 1 && m <= 12).sort((a, b) => a - b);
    for (const month of months) {
      const lastDay = new Date(civilAt(year, month, 0)).getUTCDate();
      const days = rule.bymonthday
        .map((day) => (day < 0 ? lastDay + 1 + day : day))
        .filter((day) => day >= 1 && day <= lastDay);
      for (const day of [...new Set(days)].sort((a, b) => a - b)) result.push(at(month - 1, day));
    }
    return result;
  }
  const c = at(civilDtstart.getUTCMonth(), civilDtstart.getUTCDate());
  return new Date(c).getUTCMonth() === civilDtstart.getUTCMonth() ? [c] : [];
}

/** Values {@link expandWithCivil} has already resolved for the expansion, passed to YEARLY. */
interface YearlyExpansion {
  zone: Zone;
  rule: RRuleParts;
  dtstart: Date;
  exdateSet: Set<number>;
  untilMs: number | undefined;
  untilCivil: number | undefined;
  rangeStartMs: number;
  rangeEndMs: number;
  rangeStartCivil: number;
  rangeEndCivil: number;
  civilDtstart: Date;
  firstCivil: number;
  maxIterations: number;
}

/**
 * YEARLY expansion: per-year candidates on the expansion zone's calendar, with the same bounds,
 * first-instant, filter, COUNT and EXDATE handling as the main loop in {@link expandWithCivil}.
 */
function expandYearly(x: YearlyExpansion): CivilOccurrence[] {
  const { zone, rule } = x;
  const results: CivilOccurrence[] = [];
  const generated = Boolean(rule.bymonth?.length && rule.bymonthday?.length);
  const interval = rule.interval >= 1 ? rule.interval : 1;
  let count = 0;

  for (let year = x.civilDtstart.getUTCFullYear(), i = 0; i < x.maxIterations; year += interval, i++) {
    const yearStart = civilAt(year, 0, 1);
    if (yearStart > x.rangeEndCivil + CIVIL_MARGIN_MS) break;
    if (x.untilCivil !== undefined && yearStart > x.untilCivil + CIVIL_MARGIN_MS) break;

    for (const candidate of yearlyCandidates(rule, x.civilDtstart, year)) {
      // Host calendar: a date the host skipped entirely takes the real date it resolves to,
      // as in the main loop.
      const civil = zone === HOST_ZONE && !hostDateExists(candidate)
        ? HOST_ZONE.toCivil(HOST_ZONE.fromCivil(candidate))
        : candidate;
      if (civil < x.firstCivil) continue;

      // The supplied DTSTART instant is the first occurrence (see the main loop).
      let instant: number | undefined = civil === x.firstCivil ? x.dtstart.getTime() : undefined;
      const instantOf = (): number => (instant ??= zone.fromCivil(civil));

      // Candidates are in civil order, so the first one past a bound ends the expansion.
      if (x.untilMs !== undefined && x.untilCivil !== undefined) {
        if (civil > x.untilCivil + CIVIL_MARGIN_MS) return results;
        if (civil >= x.untilCivil - CIVIL_MARGIN_MS && instantOf() > x.untilMs) return results;
      }
      if (civil > x.rangeEndCivil + CIVIL_MARGIN_MS) return results;
      if (civil >= x.rangeEndCivil - CIVIL_MARGIN_MS && instantOf() > x.rangeEndMs) return results;

      const day = new Date(civil);
      let matchesRule = true;
      if (rule.byday && rule.byday.length > 0) matchesRule = matchesByday(day, rule.byday);
      if (!generated && matchesRule && rule.bymonth && rule.bymonth.length > 0) {
        matchesRule = rule.bymonth.includes(day.getUTCMonth() + 1);
      }
      if (!generated && matchesRule && rule.bymonthday && rule.bymonthday.length > 0) {
        matchesRule = rule.bymonthday.includes(day.getUTCDate());
      }
      if (!matchesRule) continue;

      // As in the main loop: COUNT applies to rule-generated candidates before EXDATE removal,
      // independent of range.start.
      count++;
      if (civil >= x.rangeStartCivil - CIVIL_MARGIN_MS) {
        const at = instantOf();
        if (at >= x.rangeStartMs && !x.exdateSet.has(at)) results.push({ at, civil });
      }
      if (rule.count !== undefined && count >= rule.count) return results;
    }
  }
  return results;
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
  const dtstartDay = Math.floor(civilDtstart.getTime() / DAY_MS);
  const firstCivil = civilDtstart.getTime();

  if (rule.freq === 'YEARLY') {
    return expandYearly({
      zone, rule, dtstart, exdateSet, untilMs, untilCivil,
      rangeStartMs, rangeEndMs, rangeStartCivil, rangeEndCivil,
      civilDtstart, firstCivil, maxIterations: MAX_ITERATIONS,
    });
  }

  let current = new Date(firstCivil);
  let count = 0;
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    // Host calendar: a date the host skipped entirely is not a candidate of its own. It takes
    // the real date the host resolves it to (as native Date stepping does) before filtering,
    // counting and stepping, so no duplicate or impossible weekday/month-day occurs.
    if (zone === HOST_ZONE && !hostDateExists(current.getTime())) {
      current = new Date(HOST_ZONE.toCivil(HOST_ZONE.fromCivil(current.getTime())));
    }

    const civil = current.getTime();
    // The supplied DTSTART instant is the first occurrence (an ambiguous local time keeps the
    // instant given rather than the one its wall clock would resolve to).
    let instant: number | undefined = civil === firstCivil ? dtstart.getTime() : undefined;
    const instantOf = (): number => (instant ??= zone.fromCivil(civil));

    // Stop conditions (instant semantics; civil prefilter avoids conversion far from bounds)
    if (untilMs !== undefined && untilCivil !== undefined) {
      if (civil > untilCivil + CIVIL_MARGIN_MS) break;
      if (civil >= untilCivil - CIVIL_MARGIN_MS && instantOf() > untilMs) break;
    }
    if (civil > rangeEndCivil + CIVIL_MARGIN_MS) break;
    if (civil >= rangeEndCivil - CIVIL_MARGIN_MS && instantOf() > rangeEndMs) break;

    let matchesRule = true;
    if (rule.byday && rule.byday.length > 0) {
      matchesRule = matchesByday(current, rule.byday);
    }
    if (matchesRule && rule.bymonth && rule.bymonth.length > 0) {
      matchesRule = rule.bymonth.includes(current.getUTCMonth() + 1);
    }
    if (matchesRule && rule.bymonthday && rule.bymonthday.length > 0) {
      matchesRule = rule.bymonthday.includes(current.getUTCDate());
    }

    if (matchesRule) {
      // COUNT applies to RRULE-generated candidates before EXDATE removes an
      // occurrence from the recurrence set. Keep this independent of range.start.
      count++;
      if (civil >= rangeStartCivil - CIVIL_MARGIN_MS) {
        const at = instantOf();
        if (at >= rangeStartMs && !exdateSet.has(at)) {
          results.push({ at, civil });
        }
      }
      if (rule.count !== undefined && count >= rule.count) break;
    }

    // Advance based on frequency
    if (rule.freq === 'WEEKLY' && rule.byday && rule.byday.length > 0) {
      // For WEEKLY with BYDAY, step one calendar day at a time in the zone's calendar
      const next = new Date(civil);
      next.setUTCDate(next.getUTCDate() + 1);
      // Preserve original time-of-day
      next.setUTCHours(civilDtstart.getUTCHours(), civilDtstart.getUTCMinutes(), civilDtstart.getUTCSeconds(), 0);
      // Check if we've completed a week cycle using calendar days
      const nextDay = Math.floor(next.getTime() / DAY_MS);
      const daysSinceStart = nextDay - dtstartDay;
      if (daysSinceStart > 0 && daysSinceStart % 7 === 0 && rule.interval > 1) {
        next.setUTCDate(next.getUTCDate() + 7 * (rule.interval - 1));
      }
      current = next;
    } else {
      current = addInterval(current, rule.freq, rule.interval, civilDtstart);
    }
  }

  return results;
}
