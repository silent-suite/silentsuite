import { logger } from '@/app/lib/logger'

/**
 * Parse each remote item on its own. An item that does not parse (for example
 * an event without DTSTART written by another client) is left out, so it
 * cannot hide the others or fail the whole load. Only the number of skipped
 * items is reported: never their uid, title or content.
 */
export function parseRemoteItems<I, T>(domain: 'calendar' | 'tasks', items: readonly I[], parse: (item: I) => T): T[] {
  const parsed: T[] = []
  let skipped = 0
  for (const item of items) {
    try {
      parsed.push(parse(item))
    } catch {
      skipped += 1
    }
  }
  if (skipped > 0) logger.warn(`[sync] Skipped ${skipped} ${domain} item(s) that could not be parsed`)
  return parsed
}
