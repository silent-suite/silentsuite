import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { importSourceKeyOf } from './source-key'

/*
 * Before a provider import writes, the items already on the server are read again, so an
 * import whose earlier save reached the server but whose acknowledgement was lost is never
 * written a second time. The visible store alone cannot tell: it drops unacknowledged items.
 * (Creates are not held in the offline queue: it refuses plaintext content, see
 * offline-queue.ts, so a lost acknowledgement is the only way a saved item goes unseen.)
 */

function keyOfContent(content: string): string | undefined {
  // Item content is iCalendar/vCard text: unfold before reading a property line.
  return importSourceKeyOf(content.replace(/\r?\n[ \t]/g, '').split(/\r?\n/))
}

/**
 * Import source keys of every item of `type` on the server, or null when the server could not
 * be read in full (offline, refused, or any item whose content could not be read): then nothing
 * may be written.
 */
export async function serverImportSourceKeys(type: 'calendar' | 'contacts'): Promise<Set<string> | null> {
  const etebase = useEtebaseStore.getState()
  if (!etebase.account) return null
  if (etebase.collections[type].length === 0) return new Set()
  let items: { content: string }[]
  // An item whose content could not be read may be an earlier, unacknowledged save: fail closed.
  const report = { unreadable: 0 }
  try {
    items = await etebase.refreshCollection(type, undefined, report)
  } catch {
    return null
  }
  if (report.unreadable > 0) return null
  // A failed refresh falls back to the local cache and marks the domain failed.
  if (useEtebaseStore.getState().domainLoadState[type] !== 'loaded') return null
  const keys = new Set<string>()
  for (const item of items) {
    const key = keyOfContent(item.content)
    if (key) keys.add(key)
  }
  return keys
}

export const RECONCILE_FAILED_MESSAGE =
  "Couldn't check what is already saved, so nothing was imported. Check your connection and try again."
