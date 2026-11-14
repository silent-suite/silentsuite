// Reminders handed to the service worker (public/notification-worker.js) are
// kept in their own IndexedDB database, outside the account data cache.
const ALARM_DB = 'silentsuite-alarms'
const ALARM_STORE = 'alarms'

/**
 * Drop every reminder the service worker holds. Used on logout.
 *
 * The worker is told first, so it clears after any SCHEDULE_ALARMS message
 * still queued behind it. The store is also emptied from the page, which covers
 * a page without a controlling worker. The page empties the store instead of
 * deleting the database because the worker keeps its connections open, which
 * would leave deleteDatabase blocked.
 */
export async function clearScheduledAlarms(): Promise<void> {
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_ALARMS' })
  } catch {
    // The direct clear below still runs.
  }
  if (typeof indexedDB === 'undefined') return

  await new Promise<void>((resolve, reject) => {
    // No version: open whatever version exists, and never create a database
    // that was not there.
    const req = indexedDB.open(ALARM_DB)
    req.onupgradeneeded = () => req.transaction?.abort()
    req.onerror = () => {
      if (req.error?.name === 'AbortError') resolve()
      else reject(req.error)
    }
    req.onsuccess = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(ALARM_STORE)) {
        db.close()
        resolve()
        return
      }
      const tx = db.transaction(ALARM_STORE, 'readwrite')
      tx.objectStore(ALARM_STORE).clear()
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => { db.close(); reject(tx.error) }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  })
}
