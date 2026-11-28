'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useCalendarStore } from '@/app/stores/use-calendar-store'
import { usePreferencesStore } from '@/app/stores/use-preferences-store'
import { NOTIFICATION_LOOKAHEAD_MS, NOTIFICATION_MAX_FUTURE_MS, MS_PER_MINUTE } from '@/app/lib/constants'
import { resolveTimeZone, parseICalDurationSeconds } from '@silentsuite/core'
import type { CalendarEvent } from '@silentsuite/core'
import { expandEventsForRange, isDetachedCancellation } from '@/app/(app)/calendar/lib/calendar-grid-events'

interface NotificationContextValue {
  permission: NotificationPermission | 'unsupported'
  requestPermission: () => Promise<NotificationPermission>
}

const NotificationContext = createContext<NotificationContextValue>({
  permission: 'unsupported',
  requestPermission: async () => 'denied',
})

export function useNotifications() {
  return useContext(NotificationContext)
}

function formatNotificationTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function formatTimeLabel(triggerMs: number): string {
  const triggerMinutes = triggerMs / (60 * 1000)
  if (triggerMinutes >= 1440) return `${triggerMinutes / 1440} day(s)`
  if (triggerMinutes >= 60) return `${triggerMinutes / 60} hour(s)`
  return `${triggerMinutes} minutes`
}

/** Play a notification sound using the Web Audio API */
function playNotificationSound(): void {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()

    oscillator.connect(gain)
    gain.connect(ctx.destination)

    // Two-tone chime: C5 then E5
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(523.25, ctx.currentTime) // C5
    oscillator.frequency.setValueAtTime(659.25, ctx.currentTime + 0.15) // E5

    gain.gain.setValueAtTime(0.2, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4)

    oscillator.start(ctx.currentTime)
    oscillator.stop(ctx.currentTime + 0.4)

    // Clean up
    oscillator.onended = () => {
      gain.disconnect()
      oscillator.disconnect()
      ctx.close()
    }
  } catch {
    // AudioContext may not be available or may be blocked by autoplay policy
  }
}

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const events = useCalendarStore((s) => s.events)
  const notificationSound = usePreferencesStore((s) => s.notificationSound)
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('unsupported')
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const notificationSoundRef = useRef(notificationSound)

  // Keep sound preference ref in sync
  useEffect(() => {
    notificationSoundRef.current = notificationSound
  }, [notificationSound])

  // Check notification support
  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      setPermission(Notification.permission)
    }
  }, [])

  const requestPermission = useCallback(async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      return 'denied' as NotificationPermission
    }
    const result = await Notification.requestPermission()
    setPermission(result)
    return result
  }, [])

  // Schedule notifications for events with alarms (including recurring expansions)
  useEffect(() => {
    if (permission !== 'granted') return

    // Clear all existing timers
    for (const timer of timersRef.current.values()) {
      clearTimeout(timer)
    }
    timersRef.current.clear()

    const now = Date.now()
    const LOOKAHEAD_MS = NOTIFICATION_LOOKAHEAD_MS

    // Collect alarm data for service worker
    const swAlarmData: Array<{
      id: string
      title: string
      time: string
      triggerAt: number
      triggerLabel: string
    }> = []

    for (const event of events) {
      if (!event.alarms || event.alarms.length === 0 || isDetachedCancellation(event)) continue

      for (const [alarmIndex, alarm] of event.alarms.entries()) {
        if (alarm.action.toUpperCase() !== 'DISPLAY') continue
        const param = (key: string) => alarm.triggerParams?.[key]?.replace(/^"(.*)"$/, '$1').toUpperCase()
        const absolute = param('VALUE') === 'DATE-TIME'
        if (!absolute && event.timezone && !resolveTimeZone(event.timezone)) continue
        const relatedEnd = param('RELATED') === 'END'
        const seconds = absolute ? null : parseICalDurationSeconds(alarm.trigger)
        if (!absolute && seconds === null) continue
        const offset = (seconds ?? 0) * 1000
        // `instance` is the occurrence's recurrence identity: a moved one keeps its original start,
        // so it cannot collide with the occurrence it lands on.
        let occurrences: Array<{ start: Date; end: Date; title: string; instance: Date }>
        const single = [{ start: event.startDate, end: event.endDate, title: event.title, instance: event.startDate }]
        let absoluteAt = NaN
        if (absolute) {
          const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(alarm.trigger)
          if (!match) continue
          absoluteAt = Date.UTC(+match[1]!, +match[2]! - 1, +match[3]!, +match[4]!, +match[5]!, +match[6]!)
          if (new Date(absoluteAt).toISOString().replace(/[-:]/g, '').replace('.000', '') !== alarm.trigger) continue
          occurrences = single
        } else if (event.recurrenceRule) {
          // End anchors may belong to starts before the window. Nominal durations can vary
          // across offset transitions; the margin covers those without a second expander.
          const length = relatedEnd ? event.endDate.getTime() - event.startDate.getTime() : 0
          const margin = relatedEnd ? 2 * 86400000 : 0
          const start = now - offset - length - margin
          const end = now + NOTIFICATION_MAX_FUTURE_MS - offset - length + margin
          if (!Number.isFinite(start) || !Number.isFinite(end) || Math.abs(start) > 8.64e15 || Math.abs(end) > 8.64e15) continue
          try {
            // The agenda's expansion: moved occurrences at their new time, cancelled ones left out.
            occurrences = expandEventsForRange([event], { start: new Date(start), end: new Date(end) })
              .map((occurrence) => ({
                start: occurrence.startDate, end: occurrence.endDate, title: occurrence.title, instance: occurrence.instanceDate,
              }))
          } catch {
            occurrences = single
          }
        } else {
          occurrences = single
        }
        for (const { start: occStart, end: occEnd, title: occTitle, instance } of occurrences) {
          const alarmTime = absolute ? absoluteAt : (relatedEnd ? occEnd : occStart).getTime() + offset
          const timerId = absolute ? `${event.id}_absolute_${alarmIndex}_${alarm.trigger}`
            : `${event.id}_${instance.getTime()}_${alarm.trigger}${relatedEnd ? `_end_${alarmIndex}` : alarmIndex ? `_${alarmIndex}` : ''}`
          const notificationTitle = !absolute && !relatedEnd && offset < 0 ? `Event in ${formatTimeLabel(-offset)}` : occTitle
          // Only schedule if in the future and within lookahead window
          if (alarmTime > now && alarmTime < now + LOOKAHEAD_MS) {
            const delay = alarmTime - now
            const eventTitle = occTitle
            const eventTimeStr = formatNotificationTime(absolute ? new Date(alarmTime) : occStart)

            const timer = setTimeout(async () => {
              // Play notification sound if enabled
              if (notificationSoundRef.current) {
                playNotificationSound()
              }

              // Use service worker for rich notifications (with actions)
              if ('serviceWorker' in navigator) {
                try {
                  const registration = await navigator.serviceWorker.ready
                  await registration.showNotification(notificationTitle, {
                    body: `${eventTitle} · ${eventTimeStr}`,
                    icon: '/icon-192.svg',
                    tag: timerId,
                    silent: !notificationSoundRef.current,
                    // actions/data are supported by the SW Notification API but
                    // not typed in the standard TS lib
                    ...({
                      actions: [
                        { action: 'snooze', title: 'Snooze 5 min' },
                        { action: 'dismiss', title: 'Dismiss' },
                      ],
                      data: {
                        eventId: event.id,
                        eventStart: occStart.getTime(),
                      },
                    } as NotificationOptions),
                  })
                } catch {
                  // Fallback to basic Notification API
                  new Notification(notificationTitle, {
                    body: `${eventTitle} · ${eventTimeStr}`,
                    icon: '/icon-192.svg',
                    tag: timerId,
                    silent: !notificationSoundRef.current,
                  })
                }
              } else {
                new Notification(notificationTitle, {
                  body: `${eventTitle} · ${eventTimeStr}`,
                  icon: '/icon-192.svg',
                  tag: timerId,
                  silent: !notificationSoundRef.current,
                })
              }

              timersRef.current.delete(timerId)
            }, delay)

            timersRef.current.set(timerId, timer)
          }

          // Collect alarm data for service worker (broader window for background checks)
          if (alarmTime > now && alarmTime < now + NOTIFICATION_MAX_FUTURE_MS) {
            swAlarmData.push({
              id: timerId,
              title: occTitle,
              time: formatNotificationTime(absolute ? new Date(alarmTime) : occStart),
              triggerAt: alarmTime,
              triggerLabel: alarm.trigger,
            })
          }
        }
      }
    }

    // Send alarms to service worker for background checking
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'SCHEDULE_ALARMS',
        alarms: swAlarmData,
      })
    }

    // Register periodic sync if available
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then(async (registration) => {
        if ('periodicSync' in registration) {
          try {
            await (registration as any).periodicSync.register('check-alarms', {
              minInterval: MS_PER_MINUTE, // Check every minute
            })
          } catch {
            // Periodic sync not available or permission denied
          }
        }
      })
    }

    // Cleanup
    return () => {
      for (const timer of timersRef.current.values()) {
        clearTimeout(timer)
      }
      timersRef.current.clear()
    }
  }, [events, permission])

  return (
    <NotificationContext.Provider value={{ permission, requestPermission }}>
      {children}
    </NotificationContext.Provider>
  )
}
