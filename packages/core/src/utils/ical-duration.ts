/** RFC 5545 duration, as signed seconds. Invalid is distinct from PT0S. */
export function parseICalDurationSeconds(value: string): number | null {
  const match = /^([+-])?P(?:(\d+)W|(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?)$/i.exec(value);
  if (!match || !match.slice(2).some((part) => part !== undefined)) return null;
  if (/T$/i.test(value)) return null;
  const seconds = Number(match[2] ?? 0) * 604800 + Number(match[3] ?? 0) * 86400
    + Number(match[4] ?? 0) * 3600 + Number(match[5] ?? 0) * 60 + Number(match[6] ?? 0);
  if (!Number.isSafeInteger(seconds)) return null;
  return seconds === 0 ? 0 : match[1] === '-' ? -seconds : seconds;
}
