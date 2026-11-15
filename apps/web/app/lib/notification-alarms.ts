// Reminders handed to the service worker (public/notification-worker.js) are
// kept in their own IndexedDB database, outside the account data cache.
const ALARM_DB = 'silentsuite-alarms'
const ALARM_STORE = 'alarms'

/**
 * Drop every reminder the service worker holds. Used on logout.
 *
 * The controlling worker is told first, so it clears after any SCHEDULE_ALARMS
 * message still queued behind it. A page can be uncontrolled (first load, hard
 * reload) while a registered worker is running with a reminder check or a
 * snooze pending, so every worker of the origin's registrations is told too,
 * each once. The store is also emptied from the page, which covers a worker
 * that is not running. The page empties the store instead of deleting the
 * database because the worker keeps its connections open, which would leave
 * deleteDatabase blocked.
 */
export async function clearScheduledAlarms(): Promise<void> {
  const container = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker
  const notified = new Set<ServiceWorker>()
  const notify = (worker: ServiceWorker | null | undefined) => {
    if (!worker || notified.has(worker)) return
    notified.add(worker)
    try {
      worker.postMessage({ type: 'CLEAR_ALARMS' })
    } catch {
      // The direct clear below still runs.
    }
  }
  notify(container?.controller)
  try {
    // getRegistrations resolves with [] when nothing is registered, unlike `ready`.
    const registrations = typeof container?.getRegistrations === 'function' ? await container.getRegistrations() : []
    for (const registration of registrations) {
      notify(registration.active)
      notify(registration.waiting)
      notify(registration.installing)
    }
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
