/**
 * Wall-clock <-> instant conversion for IANA zones, shared by the event parser, the task model
 * and recurrence expansion.
 *
 * "Wall" values are wall-clock fields encoded as `Date.UTC(fields)` milliseconds, so calendar
 * arithmetic on them can use the UTC getters/setters without involving the host zone.
 *
 * Formatters are cached per zone: constructing `Intl.DateTimeFormat` dominates the cost of these
 * conversions, and recurrence expansion calls them repeatedly.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Cached formatter for `timeZone`. Throws (and caches nothing) for zones Intl does not know. */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** True when Intl accepts `timeZone`. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Wall clock of instant `utcMs` in `timeZone`, as `Date.UTC(fields)` ms. Throws for unknown zones. */
export function wallTimeInZone(timeZone: string, utcMs: number): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(utcMs));
  const p = (type: string) => parseInt(parts.find((x) => x.type === type)?.value ?? '0', 10);
  const hour = p('hour') === 24 ? 0 : p('hour'); // Intl midnight edge case
  return Date.UTC(p('year'), p('month') - 1, p('day'), hour, p('minute'), p('second'));
}

/** Offset of `timeZone` from UTC at `utcMs`, in ms. Throws for zones Intl does not know. */
export function zoneOffsetMs(timeZone: string, utcMs: number): number {
  return wallTimeInZone(timeZone, utcMs) - utcMs;
}

/**
 * The instant (ms) of a wall-clock time in `timeZone`, or null when Intl does not know the zone.
 * Per RFC 5545 §3.3.5 (applied to recurrence instances by §3.3.10, Verified Erratum 4271) a
 * repeated local time means its first occurrence and a skipped one uses the offset from before
 * the gap.
 */
export function wallTimeToInstant(timeZone: string, wallAsUtcMs: number): number | null {
  try {
    const before = zoneOffsetMs(timeZone, wallAsUtcMs - DAY_MS);
    const after = zoneOffsetMs(timeZone, wallAsUtcMs + DAY_MS);
    const valid = [before, after]
      .filter((offset) => zoneOffsetMs(timeZone, wallAsUtcMs - offset) === offset)
      .map((offset) => wallAsUtcMs - offset);
    return valid.length > 0 ? Math.min(...valid) : wallAsUtcMs - before;
  } catch {
    return null;
  }
}
