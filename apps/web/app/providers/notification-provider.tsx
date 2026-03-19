'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useCalendarStore } from '@/app/stores/use-calendar-store'
import { usePreferencesStore } from '@/app/stores/use-preferences-store'
import { expandRecurrence } from '@silentsuite/core'
import type { CalendarEvent } from '@silentsuite/core'

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

/** Parse a VALARM trigger like '-PT15M', '-PT1H', '-P1D' into milliseconds */
function parseTriggerMs(trigger: string): number {
  if (trigger.startsWith('-P')) {
    const dayMatch = trigger.match(/-P(\d+)D/)
    if (dayMatch) return parseInt(dayMatch[1]!, 10) * 24 * 60 * 60 * 1000

    const hourMatch = trigger.match(/-PT(\d+)H/)
    if (hourMatch) return parseInt(hourMatch[1]!, 10) * 60 * 60 * 1000

    const minMatch = trigger.match(/-PT(\d+)M/)
    if (minMatch) return parseInt(minMatch[1]!, 10) * 60 * 1000
  }
  return 0
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
    const LOOKAHEAD_MS = 24 * 60 * 60 * 1000 // 24 hours
    const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000
    const range = { start: new Date(now), end: new Date(now + TWO_WEEKS_MS) }

    // Collect alarm data for service worker
    const swAlarmData: Array<{
      id: string
      title: string
      time: string
      triggerAt: number
      triggerLabel: string
    }> = []

    for (const event of events) {
      if (!event.alarms || event.alarms.length === 0) continue

      // Expand recurring events into individual occurrences
      let occurrences: Date[]
      if (event.recurrenceRule) {
        try {
          occurrences = expandRecurrence(
            event.recurrenceRule,
            event.startDate,
            range,
            event.exceptions,
          )
        } catch {
          occurrences = [event.startDate]
        }
      } else {
        occurrences = [event.startDate]
      }

      for (const occStart of occurrences) {
        for (const alarm of event.alarms) {
          const triggerMs = parseTriggerMs(alarm.trigger)
          if (triggerMs === 0) continue

          const alarmTime = occStart.getTime() - triggerMs

          // Only schedule if in the future and within lookahead window
          if (alarmTime > now && alarmTime < now + LOOKAHEAD_MS) {
            const delay = alarmTime - now
            const timerId = `${event.id}_${occStart.getTime()}_${alarm.trigger}`
            const timeLabel = formatTimeLabel(triggerMs)
            const eventTitle = event.title
            const eventTimeStr = formatNotificationTime(occStart)

            const timer = setTimeout(async () => {
              // Play notification sound if enabled
              if (notificationSoundRef.current) {
                playNotificationSound()
              }

              // Use service worker for rich notifications (with actions)
              if ('serviceWorker' in navigator) {
                try {
                  const registration = await navigator.serviceWorker.ready
                  await registration.showNotification(`Event in ${timeLabel}`, {
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
                  new Notification(`Event in ${timeLabel}`, {
                    body: `${eventTitle} · ${eventTimeStr}`,
                    icon: '/icon-192.svg',
                    tag: timerId,
                    silent: !notificationSoundRef.current,
                  })
                }
              } else {
                new Notification(`Event in ${timeLabel}`, {
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
          if (alarmTime > now && alarmTime < now + TWO_WEEKS_MS) {
            swAlarmData.push({
              id: `${event.id}_${occStart.getTime()}_${alarm.trigger}`,
              title: event.title,
              time: formatNotificationTime(occStart),
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
              minInterval: 60 * 1000, // Check every minute
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
