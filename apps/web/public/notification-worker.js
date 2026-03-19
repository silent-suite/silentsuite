/**
 * notification-worker.js
 *
 * Imported by the main service worker (via importScripts) to handle
 * alarm scheduling and notification actions when the tab is backgrounded.
 *
 * Communication with the main app happens via postMessage.
 */

// ── IndexedDB helpers ──

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('silentsuite-alarms', 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('alarms')) {
        db.createObjectStore('alarms', { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function getAllAlarms() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('alarms', 'readonly')
    const store = tx.objectStore('alarms')
    const req = store.getAll()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function deleteAlarm(id) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('alarms', 'readwrite')
    const store = tx.objectStore('alarms')
    const req = store.delete(id)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

async function storeAlarms(alarms) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('alarms', 'readwrite')
    const store = tx.objectStore('alarms')
    store.clear()
    for (const alarm of alarms) {
      store.put(alarm)
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// ── Alarm scheduling ──

async function scheduleAlarms(alarms) {
  await storeAlarms(alarms)
}

// ── Check and fire alarms (called from periodic sync or setInterval) ──

async function checkAndFireAlarms() {
  const now = Date.now()
  const FIRE_WINDOW_MS = 2 * 60 * 1000 // 2-minute window

  let alarms
  try {
    alarms = await getAllAlarms()
  } catch {
    return
  }

  for (const alarm of alarms) {
    // Fire if trigger time is in the past but within the fire window
    if (alarm.triggerAt <= now && alarm.triggerAt > now - FIRE_WINDOW_MS) {
      try {
        await self.registration.showNotification(alarm.title, {
          body: alarm.time ? `${alarm.title} · ${alarm.time}` : alarm.title,
          icon: '/icon-192.svg',
          tag: alarm.id,
          actions: [
            { action: 'snooze', title: 'Snooze 5 min' },
            { action: 'dismiss', title: 'Dismiss' },
          ],
          data: {
            alarmId: alarm.id,
            eventTitle: alarm.title,
            eventTime: alarm.time,
          },
        })
      } catch {
        // showNotification may fail if permission revoked
      }
      await deleteAlarm(alarm.id)
    } else if (alarm.triggerAt <= now - FIRE_WINDOW_MS) {
      // Expired alarm, clean up
      await deleteAlarm(alarm.id)
    }
  }
}

// ── Message handler: receive alarm data from the main app ──

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SCHEDULE_ALARMS') {
    const { alarms } = event.data
    // alarms: Array<{ id, title, time, triggerAt, triggerLabel }>
    scheduleAlarms(alarms)
  }
})

// ── Periodic sync handler ──

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'check-alarms') {
    event.waitUntil(checkAndFireAlarms())
  }
})

// ── Notification click handler (snooze / dismiss / default open) ──

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  if (event.action === 'snooze') {
    // Re-schedule notification for 5 minutes from now
    const snoozeDelay = 5 * 60 * 1000
    const data = event.notification.data || {}

    event.waitUntil(
      new Promise((resolve) => {
        setTimeout(async () => {
          try {
            await self.registration.showNotification(event.notification.title, {
              body: event.notification.body,
              icon: event.notification.icon || '/icon-192.svg',
              tag: (event.notification.tag || 'snoozed') + '_snoozed',
              actions: [
                { action: 'snooze', title: 'Snooze 5 min' },
                { action: 'dismiss', title: 'Dismiss' },
              ],
              data: data,
            })
          } catch {
            // May fail
          }
          resolve()
        }, snoozeDelay)
      })
    )
  } else if (event.action === 'dismiss') {
    // Already closed above, nothing else to do
  } else {
    // Default click: focus or open the calendar
    event.waitUntil(
      self.clients
        .matchAll({ type: 'window', includeUncontrolled: true })
        .then((windowClients) => {
          for (const client of windowClients) {
            if (client.url.includes('/calendar') && 'focus' in client) {
              return client.focus()
            }
          }
          // Focus any existing window
          if (windowClients.length > 0 && 'focus' in windowClients[0]) {
            return windowClients[0].focus()
          }
          // Open a new window
          return self.clients.openWindow('/calendar')
        })
    )
  }
})

// ── Fallback: setInterval-based checking for browsers without periodic sync ──

// Check every 30 seconds as a fallback
setInterval(() => {
  checkAndFireAlarms()
}, 30 * 1000)
