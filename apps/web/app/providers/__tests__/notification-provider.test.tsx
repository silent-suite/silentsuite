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
const showNotification = vi.fn(async (..._args: unknown[]) => undefined)
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
  it.each([
    ['TRIGGER:-PT1H30M', '2026-11-17T13:30:00Z', 'Event in 1.5 hour(s)'],
    ['TRIGGER:PT0S', '2026-11-17T15:00:00Z', 'Reminder title'],
    ['TRIGGER:PT15M', '2026-11-17T15:15:00Z', 'Reminder title'],
    ['TRIGGER;RELATED=END:-PT15M', '2026-11-17T15:45:00Z', 'Reminder title'],
    ['TRIGGER;VALUE=DATE-TIME:20261117T090000Z', '2026-11-17T09:00:00Z', 'Reminder title'],
  ])('schedules %s at its actual anchor', async (trigger, expected, title) => {
    vi.setSystemTime(new Date('2026-11-17T08:00:00Z'))
    state.events = [deserializeCalendarEvent(['BEGIN:VEVENT', 'UID:anchored', 'SUMMARY:Reminder title', 'DTSTART:20261117T150000Z', 'DTEND:20261117T160000Z',
      'RRULE:FREQ=DAILY;COUNT=3', 'BEGIN:VALARM', 'ACTION:DISPLAY', trigger, 'END:VALARM', 'END:VEVENT'].join('\r\n'))]
    const view = render(<NotificationProvider>{null}</NotificationProvider>)
    await flushAsync()
    const alarms = scheduleMessages().at(-1)!
    expect(alarms[0]?.triggerAt).toBe(ms(expected))
    if (trigger.includes('DATE-TIME')) expect(alarms).toHaveLength(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(ms(expected) - Date.now()) })
    expect(showNotification).toHaveBeenCalledTimes(1)
    expect(showNotification.mock.calls[0]?.[0]).toBe(title)
    view.unmount()
  })

  it('schedules an absolute reminder without an occurrence in range and does not repeat after rerender', async () => {
    vi.setSystemTime(new Date('2026-11-17T08:00:00Z'))
    state.events = [deserializeCalendarEvent(['BEGIN:VEVENT', 'UID:absolute', 'DTSTART:20270101T150000Z', 'DTEND:20270101T160000Z',
      'RRULE:FREQ=DAILY', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER;VALUE=DATE-TIME:20261117T090000Z', 'END:VALARM', 'END:VEVENT'].join('\r\n'))]
    const view = render(<NotificationProvider>{null}</NotificationProvider>)
    await flushAsync()
    expect(scheduleMessages().at(-1)).toHaveLength(1)
    state.events = [...state.events]
    view.rerender(<NotificationProvider>{null}</NotificationProvider>)
    await act(async () => { await vi.advanceTimersByTimeAsync(3600000) })
    expect(showNotification).toHaveBeenCalledTimes(1)
    state.events = [...state.events]
    view.rerender(<NotificationProvider>{null}</NotificationProvider>)
    await flushAsync()
    expect(scheduleMessages().at(-1)).toHaveLength(0)
    view.unmount()
  })

  it('finds an end reminder after the start has passed and uses nominal duration over DST', async () => {
    vi.setSystemTime(new Date('2026-03-08T12:00:00Z'))
    state.events = [deserializeCalendarEvent(['BEGIN:VEVENT', 'UID:nominal', 'DTSTART;TZID=America/New_York:20260307T100000', 'DURATION:P1D',
      'RRULE:FREQ=DAILY;COUNT=2', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER;RELATED=END:-PT15M', 'END:VALARM', 'END:VEVENT'].join('\r\n'))]
    const view = render(<NotificationProvider>{null}</NotificationProvider>)
    await flushAsync()
    expect(scheduleMessages().at(-1)?.map(a => a.triggerAt)).toEqual([ms('2026-03-08T13:45:00Z'), ms('2026-03-09T13:45:00Z')])
    view.unmount()
  })

  it('does not turn an email alarm into a browser notification', async () => {
    vi.setSystemTime(new Date('2026-03-09T12:00:00Z'))
    state.events = [deserializeCalendarEvent(SERIES_ICS.replace('ACTION:DISPLAY', 'ACTION:EMAIL'))]
    const view = render(<NotificationProvider>{null}</NotificationProvider>)
    await flushAsync()
    expect(scheduleMessages().at(-1)).toEqual([])
    view.unmount()
  })

  it('follows a moved occurrence and skips a cancelled one', async () => {
    vi.setSystemTime(new Date('2026-03-09T12:00:00Z'))
    state.events = [deserializeCalendarEvent(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Other Client//EN',
      'BEGIN:VEVENT', 'UID:moved', 'SUMMARY:Daily', 'DTSTART:20260309T180000Z', 'DTEND:20260309T190000Z',
      'RRULE:FREQ=DAILY;COUNT=3', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:moved', 'RECURRENCE-ID:20260310T180000Z', 'DTSTART:20260310T200000Z', 'DTEND:20260310T210000Z',
      'SUMMARY:Moved', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:moved', 'RECURRENCE-ID:20260311T180000Z', 'STATUS:CANCELLED', 'END:VEVENT',
      'END:VCALENDAR'].join('\r\n'))]
    const view = render(<NotificationProvider>{null}</NotificationProvider>)
    await flushAsync()
    expect(scheduleMessages().at(-1)?.map(a => [a.triggerAt, a.title])).toEqual([
      [ms('2026-03-09T17:45:00Z'), 'Daily'],
      [ms('2026-03-10T19:45:00Z'), 'Moved'],
    ])
    view.unmount()
  })

  it('keeps a moved occurrence apart from the occurrence it lands on', async () => {
    vi.setSystemTime(new Date('2026-03-09T12:00:00Z'))
    state.events = [deserializeCalendarEvent(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Other Client//EN',
      'BEGIN:VEVENT', 'UID:collide', 'SUMMARY:Daily', 'DTSTART:20260309T180000Z', 'DTEND:20260309T190000Z',
      'RRULE:FREQ=DAILY;COUNT=3', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:collide', 'RECURRENCE-ID:20260310T180000Z', 'DTSTART:20260311T180000Z', 'DTEND:20260311T190000Z',
      'SUMMARY:Moved', 'END:VEVENT',
      'END:VCALENDAR'].join('\r\n'))]
    const view = render(<NotificationProvider>{null}</NotificationProvider>)
    await flushAsync()
    const alarms = scheduleMessages().at(-1) ?? []
    expect(alarms.map(a => [a.triggerAt, a.title]).sort()).toEqual([
      [ms('2026-03-09T17:45:00Z'), 'Daily'],
      [ms('2026-03-11T17:45:00Z'), 'Daily'],
      [ms('2026-03-11T17:45:00Z'), 'Moved'],
    ].sort())
    expect(new Set(alarms.map(a => a.id)).size).toBe(3)
    view.unmount()
  })

})
