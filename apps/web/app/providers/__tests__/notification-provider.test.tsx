import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deserializeCalendarEvent } from '@silentsuite/core'
import type { CalendarEvent } from '@silentsuite/core'
import { NOTIFICATION_LOOKAHEAD_MS, NOTIFICATION_MAX_FUTURE_MS } from '@/app/lib/constants'
import { NotificationProvider } from '../notification-provider'

// #886 / plan-v2 §7 item 8 as superseded by plan-v2-alarm-amendment.md (cases A and B).
// Real provider; stubbed boundaries only: calendar/preferences store selectors, window.Notification,
// navigator.serviceWorker (controller.postMessage + ready registration with showNotification and
// NO periodicSync). Fake clock. Semantic RED counts only after the real SCHEDULE_ALARMS post.

const state = vi.hoisted(() => ({
  events: [] as CalendarEvent[],
  notificationSound: false,
}))

vi.mock('@/app/stores/use-calendar-store', () => ({
  useCalendarStore: (selector: (s: { events: CalendarEvent[] }) => unknown) => selector({ events: state.events }),
}))

vi.mock('@/app/stores/use-preferences-store', () => ({
  usePreferencesStore: (selector: (s: { notificationSound: boolean }) => unknown) =>
    selector({ notificationSound: state.notificationSound }),
}))

const SERIES_ICS = [
  'BEGIN:VEVENT',
  'UID:E',
  'SUMMARY:Synthetic alarm series',
  'DTSTART:20260223T180000Z',
  'DTEND:20260223T190000Z',
  'RRULE:FREQ=WEEKLY',
  'EXDATE:20260316T180000Z',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'TRIGGER:-PT15M',
  'END:VALARM',
  'END:VEVENT',
].join('\r\n')

const postMessage = vi.fn()
const showNotification = vi.fn(async () => undefined)
const notificationConstructed = vi.fn()

class FakeNotification {
  static permission: NotificationPermission = 'granted'
  static requestPermission = vi.fn(async () => 'granted' as NotificationPermission)
  constructor(...args: unknown[]) {
    notificationConstructed(...args)
  }
}

type ScheduledAlarm = { id: string; title: string; time: string; triggerAt: number; triggerLabel: string }

function scheduleMessages(): ScheduledAlarm[][] {
  return postMessage.mock.calls
    .map(([message]) => message as { type?: string; alarms?: ScheduledAlarm[] })
    .filter((message) => message?.type === 'SCHEDULE_ALARMS')
    .map((message) => message.alarms ?? [])
}

const ms = (iso: string) => Date.parse(iso)

/** Let the timer callback's awaited serviceWorker.ready / showNotification chain settle. */
async function flushAsync() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

describe('NotificationProvider schedules zone-correct alarms for a UTC-anchored series (#886)', () => {
  let originalNotification: PropertyDescriptor | undefined
  let originalServiceWorker: PropertyDescriptor | undefined

  beforeEach(() => {
    originalNotification = Object.getOwnPropertyDescriptor(window, 'Notification')
    originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker')
    postMessage.mockReset()
    showNotification.mockReset().mockResolvedValue(undefined)
    notificationConstructed.mockReset()
    Object.defineProperty(window, 'Notification', { configurable: true, writable: true, value: FakeNotification })
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        controller: { postMessage },
        ready: Promise.resolve({ showNotification }),
      },
    })
    state.events = [deserializeCalendarEvent(SERIES_ICS)]
    state.notificationSound = false
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalNotification) Object.defineProperty(window, 'Notification', originalNotification)
    else delete (window as { Notification?: unknown }).Notification
    if (originalServiceWorker) Object.defineProperty(navigator, 'serviceWorker', originalServiceWorker)
    else delete (navigator as { serviceWorker?: unknown }).serviceWorker
    state.events = []
  })

  it('setup: fixture and real scheduler constants match the amendment', () => {
    expect(NOTIFICATION_LOOKAHEAD_MS).toBe(86_400_000)
    expect(NOTIFICATION_MAX_FUTURE_MS).toBe(1_209_600_000)
    const [event] = state.events
    expect(event!.id).toBe('E')
    expect(event!.startDate.toISOString()).toBe('2026-02-23T18:00:00.000Z')
    expect(event!.exceptions.map((d) => d.toISOString())).toEqual(['2026-03-16T18:00:00.000Z'])
    expect(event!.alarms.map((a) => a.trigger)).toEqual(['-PT15M'])
  })

  it('case A (clock 2026-03-09T12:00Z): one alarm for 03-09 18:00Z, 03-16 excluded, 03-23 outside the window', async () => {
    vi.setSystemTime(new Date('2026-03-09T12:00:00.000Z'))
    let view: ReturnType<typeof render> | undefined
    await act(async () => {
      view = render(<NotificationProvider>{null}</NotificationProvider>)
    })

    const messages = scheduleMessages()
    expect(messages.length).toBeGreaterThan(0) // setup boundary: the real post happened
    const alarms = messages[messages.length - 1]!

    const id = `E_${ms('2026-03-09T18:00:00.000Z')}_-PT15M`
    expect(alarms).toHaveLength(1)
    expect(alarms[0]).toMatchObject({ id, triggerAt: ms('2026-03-09T17:45:00.000Z'), triggerLabel: '-PT15M' })
    // Exclusion: neither the RFC instance nor a host-shifted one for 03-16.
    expect(alarms.some((a) => a.id.includes(String(ms('2026-03-16T18:00:00.000Z'))))).toBe(false)
    expect(alarms.some((a) => a.id.includes(String(ms('2026-03-16T17:00:00.000Z'))))).toBe(false)
    // Negative window control: 03-23 is past now + 14 days (03-23T12:00Z).
    expect(alarms.some((a) => a.id.includes(String(ms('2026-03-23T18:00:00.000Z'))))).toBe(false)
    expect(alarms.some((a) => a.id.includes(String(ms('2026-03-23T17:00:00.000Z'))))).toBe(false)

    // Page timer: fires once at 17:45Z (5 h 45 min after the clock).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000 + 45 * 60 * 1000)
    })
    await flushAsync()
    expect(showNotification).toHaveBeenCalledTimes(1)
    expect(showNotification).toHaveBeenCalledWith(
      'Event in 15 minutes',
      expect.objectContaining({ tag: id, data: { eventId: 'E', eventStart: ms('2026-03-09T18:00:00.000Z') } }),
    )
    expect(notificationConstructed).not.toHaveBeenCalled()

    // Nothing else fires before the end of the one-day lookahead.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NOTIFICATION_LOOKAHEAD_MS - (5 * 60 * 60 * 1000 + 45 * 60 * 1000))
    })
    expect(showNotification).toHaveBeenCalledTimes(1)

    view!.unmount()
  })

  it('case B (clock 2026-03-15T12:00Z): one alarm for 03-23 18:00Z, 03-16 excluded, 03-30 outside the window', async () => {
    vi.setSystemTime(new Date('2026-03-15T12:00:00.000Z'))
    let view: ReturnType<typeof render> | undefined
    await act(async () => {
      view = render(<NotificationProvider>{null}</NotificationProvider>)
    })

    const messages = scheduleMessages()
    expect(messages.length).toBeGreaterThan(0) // setup boundary: the real post happened
    const alarms = messages[messages.length - 1]!

    expect(alarms).toHaveLength(1)
    expect(alarms[0]).toMatchObject({
      id: `E_${ms('2026-03-23T18:00:00.000Z')}_-PT15M`,
      triggerAt: ms('2026-03-23T17:45:00.000Z'),
    })
    expect(alarms.some((a) => a.id.includes(String(ms('2026-03-16T18:00:00.000Z'))))).toBe(false)
    expect(alarms.some((a) => a.id.includes(String(ms('2026-03-16T17:00:00.000Z'))))).toBe(false)
    expect(alarms.some((a) => a.id.includes(String(ms('2026-03-30T18:00:00.000Z'))))).toBe(false)

    // Timer control (passes before and after the repair): no page notification within 31 h.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31 * 60 * 60 * 1000)
    })
    expect(showNotification).not.toHaveBeenCalled()
    expect(notificationConstructed).not.toHaveBeenCalled()

    view!.unmount()
  })
})
