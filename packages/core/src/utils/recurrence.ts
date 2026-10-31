import type { DateRange } from '../models/types.js';

/**
 * Parse an RRULE string into its component parts.
 */
interface RRuleParts {
  freq: string;
  interval: number;
  count?: number;
  until?: Date;
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
    result.until = parseICalDate(parts['UNTIL']);
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

function parseICalDate(value: string): Date {
  // Formats: 20260313, 20260313T120000, 20260313T120000Z
  const clean = value.replace(/[^0-9TZ]/g, '');
  const year = parseInt(clean.slice(0, 4), 10);
  const month = parseInt(clean.slice(4, 6), 10) - 1;
  const day = parseInt(clean.slice(6, 8), 10);

  if (clean.length <= 8) {
    return new Date(year, month, day);
  }

  const hour = parseInt(clean.slice(9, 11), 10);
  const minute = parseInt(clean.slice(11, 13), 10);
  const second = parseInt(clean.slice(13, 15), 10);

  if (clean.endsWith('Z')) {
    return new Date(Date.UTC(year, month, day, hour, minute, second));
  }
  return new Date(year, month, day, hour, minute, second);
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

function matchesByday(date: Date, byday: string[]): boolean {
  const dow = date.getDay();
  return byday.some((day) => {
    // Strip any numeric prefix (e.g., "2MO" → "MO")
    const dayAbbr = day.replace(/^-?\d+/, '');
    return DAY_MAP[dayAbbr] === dow;
  });
}

function addInterval(date: Date, freq: string, interval: number, originalDtstart?: Date): Date {
  const result = new Date(date.getTime());
  switch (freq) {
    case 'DAILY':
      result.setDate(result.getDate() + interval);
      break;
    case 'WEEKLY':
      result.setDate(result.getDate() + 7 * interval);
      break;
    case 'MONTHLY': {
      // Clamp to last day of target month to prevent drift (e.g. Jan 31 → Feb 28)
      const originalDay = originalDtstart ? originalDtstart.getDate() : date.getDate();
      result.setMonth(result.getMonth() + interval, 1); // Move to 1st of target month
      const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
      result.setDate(Math.min(originalDay, lastDay));
      break;
    }
    // YEARLY is expanded per year from DTSTART by expandYearly.
  }
  return result;
}

function datesEqual(a: Date, b: Date): boolean {
  return a.getTime() === b.getTime();
}

/**
 * The candidate dates of one year of a YEARLY rule, in order, at DTSTART's time of day.
 * Each year is built from DTSTART rather than from the previous occurrence, so a date
 * that does not exist in a year (Feb 29) is skipped instead of moving to Mar 1.
 * With both BYMONTH and BYMONTHDAY, every listed month and day is generated; a negative
 * BYMONTHDAY counts back from the end of the month (-1 is the last day).
 */
function yearlyCandidates(rule: RRuleParts, dtstart: Date, year: number): Date[] {
  const at = (month: number, day: number) => new Date(
    year, month, day, dtstart.getHours(), dtstart.getMinutes(), dtstart.getSeconds(), dtstart.getMilliseconds(),
  );
  if (rule.bymonth?.length && rule.bymonthday?.length) {
    const result: Date[] = [];
    const months = [...new Set(rule.bymonth)].filter((m) => m >= 1 && m <= 12).sort((a, b) => a - b);
    for (const month of months) {
      const lastDay = new Date(year, month, 0).getDate();
      const days = rule.bymonthday
        .map((day) => (day < 0 ? lastDay + 1 + day : day))
        .filter((day) => day >= 1 && day <= lastDay);
      for (const day of [...new Set(days)].sort((a, b) => a - b)) result.push(at(month - 1, day));
    }
    return result;
  }
  const date = at(dtstart.getMonth(), dtstart.getDate());
  return date.getMonth() === dtstart.getMonth() ? [date] : [];
}

function expandYearly(
  rule: RRuleParts,
  dtstart: Date,
  range: DateRange,
  exdateSet: Set<number>,
  maxIterations: number,
): Date[] {
  const results: Date[] = [];
  const generated = Boolean(rule.bymonth?.length && rule.bymonthday?.length);
  const interval = rule.interval >= 1 ? rule.interval : 1;
  let count = 0;

  for (let year = dtstart.getFullYear(), i = 0; i < maxIterations; year += interval, i++) {
    if (new Date(year, 0, 1).getTime() > range.end.getTime()) break;
    for (const current of yearlyCandidates(rule, dtstart, year)) {
      if (current.getTime() < dtstart.getTime()) continue;
      if (rule.until && current.getTime() > rule.until.getTime()) return results;
      if (current.getTime() > range.end.getTime()) return results;

      let matchesRule = true;
      if (rule.byday && rule.byday.length > 0) matchesRule = matchesByday(current, rule.byday);
      if (!generated && matchesRule && rule.bymonth && rule.bymonth.length > 0) {
        matchesRule = rule.bymonth.includes(current.getMonth() + 1);
      }
      if (!generated && matchesRule && rule.bymonthday && rule.bymonthday.length > 0) {
        matchesRule = rule.bymonthday.includes(current.getDate());
      }
      if (!matchesRule) continue;

      // As below: COUNT applies to rule-generated candidates before EXDATE removal.
      count++;
      if (current.getTime() >= range.start.getTime() && !exdateSet.has(current.getTime())) {
        results.push(current);
      }
      if (rule.count !== undefined && count >= rule.count) return results;
    }
  }
  return results;
}

/**
 * Expand an RRULE into occurrence dates within a given DateRange.
 * Filters out EXDATE exceptions.
 */
export function expandRecurrence(
  rrule: string,
  dtstart: Date,
  range: DateRange,
  exdates?: Date[],
): Date[] {
  const rule = parseRRule(rrule);
  const results: Date[] = [];
  const exdateSet = new Set(exdates?.map((d) => d.getTime()) ?? []);
  const MAX_ITERATIONS = 10000; // safety limit

  if (rule.freq === 'YEARLY') return expandYearly(rule, dtstart, range, exdateSet, MAX_ITERATIONS);

  let current = new Date(dtstart.getTime());
  let count = 0;
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    // Stop conditions
    if (rule.until && current.getTime() > rule.until.getTime()) break;
    if (current.getTime() > range.end.getTime()) break;

    let matchesRule = true;
    if (rule.byday && rule.byday.length > 0) {
      matchesRule = matchesByday(current, rule.byday);
    }
    if (matchesRule && rule.bymonth && rule.bymonth.length > 0) {
      matchesRule = rule.bymonth.includes(current.getMonth() + 1);
    }
    if (matchesRule && rule.bymonthday && rule.bymonthday.length > 0) {
      matchesRule = rule.bymonthday.includes(current.getDate());
    }

    if (matchesRule) {
      // COUNT applies to RRULE-generated candidates before EXDATE removes an
      // occurrence from the recurrence set. Keep this independent of range.start.
      count++;
      if (
        current.getTime() >= range.start.getTime()
        && !exdateSet.has(current.getTime())
      ) {
        results.push(new Date(current.getTime()));
      }
      if (rule.count !== undefined && count >= rule.count) break;
    }

    // Advance based on frequency
    if (rule.freq === 'WEEKLY' && rule.byday && rule.byday.length > 0) {
      // For WEEKLY with BYDAY, step one calendar day at a time (DST-safe)
      const next = new Date(current.getTime());
      next.setDate(next.getDate() + 1);
      // Preserve original time-of-day across DST transitions
      next.setHours(dtstart.getHours(), dtstart.getMinutes(), dtstart.getSeconds(), 0);
      // Check if we've completed a week cycle using calendar days
      const dtstartDay = Math.floor(dtstart.getTime() / 86400000);
      const nextDay = Math.floor(next.getTime() / 86400000);
      const daysSinceStart = nextDay - dtstartDay;
      if (daysSinceStart > 0 && daysSinceStart % 7 === 0 && rule.interval > 1) {
        next.setDate(next.getDate() + 7 * (rule.interval - 1));
      }
      current = next;
    } else {
      current = addInterval(current, rule.freq, rule.interval, dtstart);
    }
  }

  return results;
}
