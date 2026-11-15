import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { CalendarEvent } from '@silentsuite/core'
import { deserializeCalendarEvent, serializeCalendarEvent } from '@silentsuite/core'
import { expandEventRecurrence, fromVEvent } from '@silentsuite/core'
import { EventDialog, formatEventDateInput, formatEventTimeInput, parseEventDateInput, parseEventTimeInput } from '../EventDialog'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'

const mocks = vi.hoisted(() => ({
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  updateRecurringEvent: vi.fn(),
  deleteRecurringEvent: vi.fn(),
  onClose: vi.fn(),
  requestPermission: vi.fn(),
  preferences: {
    defaultReminder: 'none',
    timeFormat: '24h',
    defaultTimezone: 'UTC',
    dateFormat: 'system',
  },
  calendars: [
    { id: 'cal-a', name: 'Work', color: '#10b981', visible: true, accessLevel: 2 },
    { id: 'cal-b', name: 'Family', color: '#ef4444', visible: true, accessLevel: 1 },
  ] as Array<{ id: string; name: string; color: string; visible: boolean; accessLevel?: number }>,
}))

vi.mock('@/app/stores/use-calendar-store', () => ({
  useCalendarStore: function useCalendarStore<T>(selector: (state: {
    createEvent: typeof mocks.createEvent
    updateEvent: typeof mocks.updateEvent
    deleteEvent: typeof mocks.deleteEvent
    updateRecurringEvent: typeof mocks.updateRecurringEvent
    deleteRecurringEvent: typeof mocks.deleteRecurringEvent
  }) => T): T {
    return selector({
      createEvent: mocks.createEvent,
      updateEvent: mocks.updateEvent,
      deleteEvent: mocks.deleteEvent,
      updateRecurringEvent: mocks.updateRecurringEvent,
      deleteRecurringEvent: mocks.deleteRecurringEvent,
    })
  },
}))

vi.mock('@/app/stores/use-auth-store', () => ({
  useAuthStore: function useAuthStore<T>(selector: (state: { canWrite: () => boolean }) => T): T {
    return selector({ canWrite: () => true })
  },
}))

vi.mock('@/app/stores/use-calendar-list-store', () => ({
  useCalendarListStore: function useCalendarListStore<T>(selector: (state: {
    calendars: typeof mocks.calendars
    defaultCalendarId: string
  }) => T): T {
    return selector({ calendars: mocks.calendars, defaultCalendarId: 'cal-a' })
  },
}))

vi.mock('@/app/stores/use-preferences-store', () => {
  const usePreferencesStore = function usePreferencesStore<T>(selector: (currentState: typeof mocks.preferences) => T): T {
    return selector(mocks.preferences)
  }
  usePreferencesStore.getState = () => mocks.preferences
  return { usePreferencesStore }
})

vi.mock('@/app/providers/notification-provider', () => ({
  useNotifications: () => ({ permission: 'granted', requestPermission: mocks.requestPermission }),
}))

vi.mock('@/app/lib/use-focus-trap', () => ({
  useFocusTrap: vi.fn(),
}))

function makeEvent(overrides?: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: 'event-item-1',
    uid: 'stable-event-uid',
    title: 'Existing event',
    description: '',
    location: '',
    startDate: new Date('2026-06-01T09:00:00Z'),
    endDate: new Date('2026-06-01T10:00:00Z'),
    allDay: false,
    recurrenceRule: null,
    exceptions: [],
    alarms: [],
    calendarId: 'cal-a',
    timezone: 'UTC',
    created: new Date('2026-06-01T08:00:00Z'),
    updated: new Date('2026-06-01T08:00:00Z'),
    ...overrides,
  }
}

describe('EventDialog edit calendar selection', () => {
  beforeEach(() => {
    mocks.createEvent.mockReset()
    mocks.updateEvent.mockReset().mockResolvedValue(undefined)
    mocks.deleteEvent.mockReset()
    mocks.updateRecurringEvent.mockReset()
    mocks.deleteRecurringEvent.mockReset()
    mocks.onClose.mockReset()
    mocks.requestPermission.mockReset()
    mocks.preferences.timeFormat = '24h'
    mocks.preferences.defaultTimezone = 'UTC'
    mocks.preferences.dateFormat = 'system'
  })

  it.each([
    ['00:00', '00:00', '12:00 AM'],
    ['09:05', '09:05', '9:05 AM'],
    ['12:00', '12:00', '12:00 PM'],
    ['14:00', '14:00', '2:00 PM'],
    ['23:59', '23:59', '11:59 PM'],
  ])('formats %s according to the account time preference', (stored, expected24h, expected12h) => {
    expect(formatEventTimeInput(stored, '24h')).toBe(expected24h)
    expect(formatEventTimeInput(stored, '12h')).toBe(expected12h)
  })

  it.each([
    ['00:00', '24h', '00:00'],
    ['09:05', '24h', '09:05'],
    ['9:05', '24h', '09:05'],
    ['12:00', '24h', '12:00'],
    ['14:00', '24h', '14:00'],
    ['23:59', '24h', '23:59'],
    ['12:00 AM', '12h', '00:00'],
    ['9:05 AM', '12h', '09:05'],
    ['12:00 PM', '12h', '12:00'],
    ['2:00 PM', '12h', '14:00'],
    ['11:59 PM', '12h', '23:59'],
    ['14:00', '12h', '14:00'],
  ])('parses %s in %s mode back to HH:mm', (input, preference, expected) => {
    expect(parseEventTimeInput(input, preference)).toBe(expected)
  })

  it.each([
    ['2026-06-09', 'YYYY-MM-DD', '2026-06-09'],
    ['2026-06-09', 'DD/MM/YYYY', '09/06/2026'],
    ['2026-06-09', 'MM/DD/YYYY', '06/09/2026'],
    ['2026-06-09', 'DD.MM.YYYY', '09.06.2026'],
    ['2026-06-09', 'YYYY/MM/DD', '2026/06/09'],
    ['2026-06-09', 'system', '2026-06-09'],
  ] as const)('formats date input %s using %s', (isoDate, preference, expected) => {
    expect(formatEventDateInput(isoDate, preference)).toBe(expected)
  })

  it.each([
    ['09/06/2026', 'DD/MM/YYYY', '2026-06-09'],
    ['06/09/2026', 'MM/DD/YYYY', '2026-06-09'],
    ['09.06.2026', 'DD.MM.YYYY', '2026-06-09'],
    ['2026/06/09', 'YYYY/MM/DD', '2026-06-09'],
    ['2026-06-09', 'YYYY-MM-DD', '2026-06-09'],
    ['2026-06-09', 'system', '2026-06-09'],
  ] as const)('parses date input %s using %s', (input, preference, expected) => {
    expect(parseEventDateInput(input, preference)).toBe(expected)
  })

  it('rejects invalid typed dates', () => {
    expect(parseEventDateInput('31/02/2026', 'DD/MM/YYYY')).toBeNull()
    expect(parseEventDateInput('2026/31/02', 'YYYY/MM/DD')).toBeNull()
  })

  it('renders event dialog date controls as preference-formatted text fields', () => {
    mocks.preferences.dateFormat = 'DD.MM.YYYY'

    renderWithIntl(<EventDialog mode="edit" event={makeEvent({ startDate: new Date('2026-06-01T14:00:00Z'), endDate: new Date('2026-06-02T15:30:00Z') })} onClose={mocks.onClose} />)

    expect(screen.getByLabelText('Start date')).toHaveAttribute('type', 'text')
    expect(screen.getByLabelText('Start date')).toHaveValue('01.06.2026')
    expect(screen.getByLabelText('End date')).toHaveValue('02.06.2026')
  })

  it('normalizes typed preference-formatted dates on blur and saves ISO-backed dates', async () => {
    mocks.preferences.dateFormat = 'YYYY/MM/DD'

    renderWithIntl(
      <EventDialog
        mode="create"
        startDate={new Date('2026-06-01T14:00:00Z')}
        endDate={new Date('2026-06-01T14:30:00Z')}
        onClose={mocks.onClose}
      />,
    )

    fireEvent.change(screen.getByLabelText('Event title'), { target: { value: 'Date formatted event' } })
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026/6/9' } })
    fireEvent.blur(screen.getByLabelText('Start date'))
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026/6/10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    expect(screen.getByLabelText('Start date')).toHaveValue('2026/06/09')
    await waitFor(() => {
      expect(mocks.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: new Date('2026-06-09T14:00:00Z'),
          endDate: new Date('2026-06-10T14:30:00Z'),
        }),
      )
    })
  })

  it('marks invalid typed dates and blocks save until corrected', () => {
    mocks.preferences.dateFormat = 'DD/MM/YYYY'

    renderWithIntl(<EventDialog mode="create" startDate={new Date('2026-06-01T14:00:00Z')} onClose={mocks.onClose} />)

    fireEvent.change(screen.getByLabelText('Event title'), { target: { value: 'Invalid date event' } })
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '31/02/2026' } })

    expect(screen.getByLabelText('Start date')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('Use 09/06/2026 format')
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled()
  })

  it('renders event dialog time controls as 24-hour text fields for the 24-hour preference', () => {
    mocks.preferences.timeFormat = '24h'

    renderWithIntl(<EventDialog mode="edit" event={makeEvent({ startDate: new Date('2026-06-01T14:00:00Z'), endDate: new Date('2026-06-01T15:30:00Z') })} onClose={mocks.onClose} />)

    expect(screen.getByLabelText('Start time')).toHaveAttribute('type', 'text')
    expect(screen.getByLabelText('Start time')).toHaveValue('14:00')
    expect(screen.getByLabelText('End time')).toHaveValue('15:30')
  })

  it('renders event dialog time controls with AM/PM for the 12-hour preference', () => {
    mocks.preferences.timeFormat = '12h'

    renderWithIntl(<EventDialog mode="edit" event={makeEvent({ startDate: new Date('2026-06-01T14:00:00Z'), endDate: new Date('2026-06-01T15:30:00Z') })} onClose={mocks.onClose} />)

    expect(screen.getByLabelText('Start time')).toHaveValue('2:00 PM')
    expect(screen.getByLabelText('End time')).toHaveValue('3:30 PM')
  })

  it('accepts 24-hour typed values and saves unchanged HH:mm wall-clock times', async () => {
    mocks.preferences.timeFormat = '24h'

    renderWithIntl(
      <EventDialog
        mode="create"
        startDate={new Date('2026-06-01T14:00:00Z')}
        endDate={new Date('2026-06-01T14:30:00Z')}
        onClose={mocks.onClose}
      />,
    )

    fireEvent.change(screen.getByLabelText('Event title'), { target: { value: '24-hour event' } })
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '16:45' } })
    fireEvent.change(screen.getByLabelText('End time'), { target: { value: '17:30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    await waitFor(() => {
      expect(mocks.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: new Date('2026-06-01T16:45:00Z'),
          endDate: new Date('2026-06-01T17:30:00Z'),
          timezone: 'UTC',
        }),
      )
    })
  })

  it('includes calendarId in the edit patch when the selected calendar changes', async () => {
    renderWithIntl(<EventDialog mode="edit" event={makeEvent()} onClose={mocks.onClose} />)

    fireEvent.click(screen.getByRole('button', { name: /Family/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    await waitFor(() => {
      expect(mocks.updateEvent).toHaveBeenCalledWith(
        'event-item-1',
        expect.objectContaining({ calendarId: 'cal-b' }),
      )
    })
    expect(mocks.onClose).toHaveBeenCalledTimes(1)
  })

  it('emits a categories update when labels split from ["WorkHome"] to ["Work","Home"]', async () => {
    const event = makeEvent({ categories: ['WorkHome'] })

    renderWithIntl(<EventDialog mode="edit" event={event} onClose={mocks.onClose} />)

    // Replace the single "WorkHome" label with two labels "Work" and "Home".
    fireEvent.click(screen.getByLabelText('Remove label WorkHome'))
    const input = screen.getByLabelText('Event labels')
    fireEvent.change(input, { target: { value: 'Work' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.change(input, { target: { value: 'Home' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    await waitFor(() => {
      expect(mocks.updateEvent).toHaveBeenCalledWith(
        'event-item-1',
        expect.objectContaining({ categories: ['Work', 'Home'] }),
      )
    })
  })

  it('preserves imported custom minute reminders when saving unchanged', async () => {
    const event = makeEvent({
      alarms: [{ action: 'DISPLAY', trigger: '-PT11M', description: 'Existing event' }],
    })

    renderWithIntl(<EventDialog mode="edit" event={event} onClose={mocks.onClose} />)

    expect(screen.getByLabelText('Reminder 1')).toHaveValue('custom')
    expect(screen.getByLabelText('Custom reminder 1 minutes before')).toHaveValue(11)

    fireEvent.change(screen.getByLabelText('Event title'), { target: { value: 'Renamed custom reminder' } })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    await waitFor(() => {
      expect(mocks.updateEvent).toHaveBeenCalledWith(
        'event-item-1',
        expect.not.objectContaining({ alarms: expect.anything() }),
      )
    })
  })

  it('saves user-entered custom minute reminders as simple negative-duration VALARMs', async () => {
    renderWithIntl(<EventDialog mode="create" startDate={new Date('2026-06-01T09:00:00Z')} onClose={mocks.onClose} />)

    fireEvent.change(screen.getByLabelText('Event title'), { target: { value: 'Custom reminder event' } })
    fireEvent.click(screen.getByRole('button', { name: '+ Add' }))
    fireEvent.change(screen.getByLabelText('Reminder 1'), { target: { value: 'custom' } })
    fireEvent.change(screen.getByLabelText('Custom reminder 1 minutes before'), { target: { value: '11' } })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    await waitFor(() => {
      expect(mocks.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          alarms: [expect.objectContaining({ action: 'DISPLAY', trigger: '-PT11M' })],
        }),
      )
    })
  })

  it('deletes only the selected recurring occurrence when This event is chosen', async () => {
    const instanceDate = new Date('2026-06-03T09:00:00Z')
    const recurringEvent = makeEvent({ recurrenceRule: 'FREQ=DAILY;COUNT=5' })

    renderWithIntl(
      <EventDialog
        mode="edit"
        event={recurringEvent}
        instanceDate={instanceDate}
        onClose={mocks.onClose}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Delete event/ }))

    expect(screen.getByRole('dialog', { name: 'Delete recurring event' })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: /This event/ }))

    expect(mocks.deleteRecurringEvent).toHaveBeenCalledWith(
      recurringEvent.id,
      'this',
      instanceDate,
    )
    expect(mocks.onClose).toHaveBeenCalledTimes(1)
  })
})

// #886 / plan-v2 §3.2: editor transitions keep one consistent anchor. Each case applies the real
// saved patch the way the store does ({ ...event, ...patch }) and serializes it with the real codec.

describe('EventDialog anchor transitions (#886)', () => {
  beforeEach(() => {
    mocks.createEvent.mockReset()
    mocks.updateEvent.mockReset().mockResolvedValue(undefined)
    mocks.updateRecurringEvent.mockReset()
    mocks.onClose.mockReset()
    mocks.preferences.timeFormat = '24h'
    mocks.preferences.defaultTimezone = 'UTC'
    mocks.preferences.dateFormat = 'system'
  })

  async function savedPatch(): Promise<Partial<CalendarEvent>> {
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(mocks.updateEvent).toHaveBeenCalledTimes(1))
    return mocks.updateEvent.mock.calls[0]![1] as Partial<CalendarEvent>
  }

  const timedLines = (ics: string) => ics.split('\r\n').filter((line) => /^(DTSTART|DTEND)[:;]/.test(line))

  it('T2: an explicit zone change on a floating event clears floating and anchors the TZID', async () => {
    const event = makeEvent({
      timezone: undefined,
      floating: true,
      startDate: new Date('2026-06-01T09:00:00Z'),
      endDate: new Date('2026-06-01T10:00:00Z'),
    })
    renderWithIntl(<EventDialog mode="edit" event={event} onClose={mocks.onClose} />)

    fireEvent.change(screen.getByLabelText('Event timezone'), { target: { value: 'Europe/Berlin' } })
    const patch = await savedPatch()

    expect(patch.timezone).toBe('Europe/Berlin')
    const merged: CalendarEvent = { ...event, ...patch }
    expect(merged.floating).toBeUndefined()
    const ics = serializeCalendarEvent(merged)
    expect(timedLines(ics)[0]).toMatch(/^DTSTART;TZID=Europe\/Berlin:/)
    const reloaded = deserializeCalendarEvent(ics)
    expect(reloaded.timezone).toBe('Europe/Berlin')
    expect(reloaded).not.toHaveProperty('floating')
    expect(reloaded.startDate.getTime()).toBe(merged.startDate.getTime())
  })

  it('T3 control: a floating event saved without a zone change stays floating', async () => {
    const event = makeEvent({
      timezone: undefined,
      floating: true,
      startDate: new Date(2026, 5, 1, 9, 0, 0),
      endDate: new Date(2026, 5, 1, 10, 0, 0),
    })
    renderWithIntl(<EventDialog mode="edit" event={event} onClose={mocks.onClose} />)

    fireEvent.change(screen.getByLabelText('Event title'), { target: { value: 'Renamed floating' } })
    const patch = await savedPatch()

    expect(patch).not.toHaveProperty('floating')
    expect(patch).not.toHaveProperty('timezone')
    const merged: CalendarEvent = { ...event, ...patch }
    expect(merged.floating).toBe(true)
    expect(timedLines(serializeCalendarEvent(merged))).toEqual(['DTSTART:20260601T090000', 'DTEND:20260601T100000'])
  })

  it('T4: switching a floating timed event to all-day clears floating', async () => {
    const event = makeEvent({
      timezone: undefined,
      floating: true,
      startDate: new Date(2026, 5, 1, 9, 0, 0),
      endDate: new Date(2026, 5, 1, 10, 0, 0),
    })
    renderWithIntl(<EventDialog mode="edit" event={event} onClose={mocks.onClose} />)

    fireEvent.click(screen.getByLabelText('All day'))
    const patch = await savedPatch()

    expect(patch.allDay).toBe(true)
    const merged: CalendarEvent = { ...event, ...patch }
    expect(merged.floating).toBeUndefined()
    expect(timedLines(serializeCalendarEvent(merged))[0]).toMatch(/^DTSTART;VALUE=DATE:/)
  })

  it('T5: switching an all-day event to timed anchors it in the dialog zone, not UTC', async () => {
    mocks.preferences.defaultTimezone = 'Europe/Berlin'
    const event = makeEvent({
      allDay: true,
      timezone: undefined,
      startDate: new Date(2026, 5, 1),
      endDate: new Date(2026, 5, 2),
    })
    renderWithIntl(<EventDialog mode="edit" event={event} onClose={mocks.onClose} />)

    fireEvent.click(screen.getByLabelText('All day'))
    const patch = await savedPatch()

    expect(patch.allDay).toBe(false)
    expect(patch.timezone).toBe('Europe/Berlin')
    const merged: CalendarEvent = { ...event, ...patch }
    expect(merged.floating).toBeUndefined()
    const ics = serializeCalendarEvent(merged)
    expect(timedLines(ics)[0]).toMatch(/^DTSTART;TZID=Europe\/Berlin:/)
    expect(deserializeCalendarEvent(ics).timezone).toBe('Europe/Berlin')
  })

  it('T6 control: a UTC-anchored event saved with an unchanged zone stays UTC', async () => {
    const event = makeEvent({
      timezone: undefined,
      startDate: new Date('2026-06-01T09:00:00Z'),
      endDate: new Date('2026-06-01T10:00:00Z'),
    })
    renderWithIntl(<EventDialog mode="edit" event={event} onClose={mocks.onClose} />)

    fireEvent.change(screen.getByLabelText('Event title'), { target: { value: 'Renamed UTC' } })
    const patch = await savedPatch()

    expect(patch).not.toHaveProperty('timezone')
    expect(patch).not.toHaveProperty('floating')
    expect(timedLines(serializeCalendarEvent({ ...event, ...patch }))).toEqual([
      'DTSTART:20260601T090000Z',
      'DTEND:20260601T100000Z',
    ])
  })
})

// #886 F1: a gap-start DTSTART keeps its original wall clock through the editor. Recurring
// saves go through the real "Edit recurring event" scope dialog to updateRecurringEvent;
// standalone saves reach updateEvent. The captured patch is merged as the store does and
// serialized/reloaded with the real codec.

describe('EventDialog gap-start DTSTART (#886 F1)', () => {
  beforeEach(() => {
    mocks.createEvent.mockReset()
    mocks.updateEvent.mockReset().mockResolvedValue(undefined)
    mocks.updateRecurringEvent.mockReset()
    mocks.onClose.mockReset()
    mocks.preferences.timeFormat = '24h'
    mocks.preferences.defaultTimezone = 'UTC'
    mocks.preferences.dateFormat = 'system'
  })

  const gapEvent = (start: string, end: string, rrule: string | null, uid = 'gap-dialog'): CalendarEvent =>
    fromVEvent([
      'BEGIN:VEVENT', `UID:${uid}`, 'SUMMARY:Gap event',
      `DTSTART;TZID=America/Los_Angeles:${start}`, `DTEND;TZID=America/Los_Angeles:${end}`,
      ...(rrule ? [`RRULE:${rrule}`] : []),
      'END:VEVENT',
    ].join('\r\n'))
  const G = () => gapEvent('20260308T023000', '20260308T043000', 'FREQ=WEEKLY;COUNT=3')
  const GS = () => gapEvent('20260308T023045', '20260308T043045', 'FREQ=WEEKLY;COUNT=3')
  const S = () => gapEvent('20260308T023000', '20260308T043000', null, 'gap-standalone')
  const march = { start: new Date('2026-03-01T00:00:00Z'), end: new Date('2026-04-01T00:00:00Z') }
  const dtstart = (ics: string) => ics.split('\r\n').find((l) => l.startsWith('DTSTART'))

  async function savedRecurringPatch(scope: RegExp) {
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    const scopeDialog = await screen.findByRole('dialog', { name: 'Edit recurring event' })
    fireEvent.click(within(scopeDialog).getByRole('button', { name: scope }))
    await waitFor(() => expect(mocks.updateRecurringEvent).toHaveBeenCalledTimes(1))
    return mocks.updateRecurringEvent.mock.calls[0]! as [string, Partial<CalendarEvent>, string, Date]
  }

  it('row 18: shows the original 02:30 start for a recurring gap-start event', () => {
    const event = G()
    renderWithIntl(<EventDialog mode="edit" event={event} instanceDate={event.startDate} onClose={mocks.onClose} />)
    expect(screen.getByLabelText('Start time')).toHaveValue('02:30')
  })

  it.each([
    [/All events/, 'all'],
    [/This event/, 'this'],
  ] as const)('row 19: a title-only save with seconds keeps exact instants (scope %s)', async (scopeName, scope) => {
    const event = GS()
    renderWithIntl(<EventDialog mode="edit" event={event} instanceDate={event.startDate} onClose={mocks.onClose} />)
    fireEvent.change(screen.getByLabelText('Event title'), { target: { value: 'Renamed gap' } })

    const [id, patch, chosenScope, instance] = await savedRecurringPatch(scopeName)

    expect(id).toBe(event.id)
    expect(chosenScope).toBe(scope)
    expect(instance.getTime()).toBe(event.startDate.getTime())
    expect(patch.title).toBe('Renamed gap')
    expect(patch).not.toHaveProperty('startDate')
    expect(patch).not.toHaveProperty('endDate')
    expect(patch).not.toHaveProperty('startWallClock')
    const ics = serializeCalendarEvent({ ...event, ...patch })
    expect(dtstart(ics)).toBe('DTSTART;TZID=America/Los_Angeles:20260308T023045')
    expect(expandEventRecurrence(deserializeCalendarEvent(ics), march).map((d) => d.toISOString())).toEqual([
      '2026-03-08T10:30:45.000Z',
      '2026-03-15T09:30:45.000Z',
      '2026-03-22T09:30:45.000Z',
    ])
  })

  it('row 20a (field): retyping the start time explicitly clears the wall clock', async () => {
    const event = G()
    renderWithIntl(<EventDialog mode="edit" event={event} instanceDate={event.startDate} onClose={mocks.onClose} />)
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '03:30' } })
    fireEvent.change(screen.getByLabelText('Event title'), { target: { value: 'Retimed' } })

    const [, patch] = await savedRecurringPatch(/All events/)

    expect('startWallClock' in patch).toBe(true)
    expect(patch.startWallClock).toBeUndefined()
    expect(dtstart(serializeCalendarEvent({ ...event, ...patch }))).toBe('DTSTART;TZID=America/Los_Angeles:20260308T033000')
  })

  it('row 20b (field): a non-equivalent zone change explicitly clears the wall clock', async () => {
    const event = G()
    renderWithIntl(<EventDialog mode="edit" event={event} instanceDate={event.startDate} onClose={mocks.onClose} />)
    fireEvent.change(screen.getByLabelText('Event timezone'), { target: { value: 'Europe/Berlin' } })

    const [, patch] = await savedRecurringPatch(/All events/)

    expect(patch.timezone).toBe('Europe/Berlin')
    expect('startWallClock' in patch).toBe(true)
    expect(patch.startWallClock).toBeUndefined()
    expect(dtstart(serializeCalendarEvent({ ...event, ...patch }))).toMatch(/^DTSTART;TZID=Europe\/Berlin:/)
  })

  it('row 20c (field): switching to all-day explicitly clears the wall clock', async () => {
    const event = G()
    renderWithIntl(<EventDialog mode="edit" event={event} instanceDate={event.startDate} onClose={mocks.onClose} />)
    fireEvent.click(screen.getByLabelText('All day'))

    const [, patch] = await savedRecurringPatch(/All events/)

    expect(patch.allDay).toBe(true)
    expect('startWallClock' in patch).toBe(true)
    expect(patch.startWallClock).toBeUndefined()
    expect(dtstart(serializeCalendarEvent({ ...event, ...patch }))).toMatch(/^DTSTART;VALUE=DATE:/)
  })

  it('row 20s: a standalone title-only save keeps the original gap DTSTART', async () => {
    const event = S()
    renderWithIntl(<EventDialog mode="edit" event={event} onClose={mocks.onClose} />)
    fireEvent.change(screen.getByLabelText('Event title'), { target: { value: 'Renamed standalone' } })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(mocks.updateEvent).toHaveBeenCalledTimes(1))

    const patch = mocks.updateEvent.mock.calls[0]![1] as Partial<CalendarEvent>
    expect(patch).not.toHaveProperty('startDate')
    expect(dtstart(serializeCalendarEvent({ ...event, ...patch }))).toBe('DTSTART;TZID=America/Los_Angeles:20260308T023000')
  })
})

// #295: the mobile bottom nav sits outside the calendar page's `main`, which is its own stacking
// context, so a dialog rendered inside the page paints under the nav and the nav stays tappable.
// This checks where the dialog is mounted; it does not measure painted geometry.

describe('EventDialog mounts above the bottom nav', () => {
  beforeEach(() => {
    mocks.createEvent.mockReset()
    mocks.onClose.mockReset()
    mocks.preferences.timeFormat = '24h'
    mocks.preferences.defaultTimezone = 'UTC'
    mocks.preferences.dateFormat = 'system'
  })

  /** The outermost `fixed` element between the role=dialog card and <body>: the overlay's own wrapper. */
  function outerOverlay(dialog: HTMLElement): HTMLElement | null {
    let outer: HTMLElement | null = null
    for (let node: HTMLElement | null = dialog; node && node !== document.body; node = node.parentElement) {
      if (node.classList.contains('fixed')) outer = node
    }
    return outer
  }

  it('portals the dialog and its backdrop to <body>, closes through onClose, and leaves nothing behind on unmount', () => {
    const view = renderWithIntl(
      <EventDialog
        mode="create"
        startDate={new Date('2026-06-01T14:00:00Z')}
        endDate={new Date('2026-06-01T14:30:00Z')}
        onClose={mocks.onClose}
      />,
    )

    const dialog = screen.getByRole('dialog', { name: 'New event' })
    expect(screen.getByLabelText('Event title')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument()

    expect(view.container.contains(dialog), 'dialog is rendered inside the render container').toBe(false)
    const outer = outerOverlay(dialog)
    expect(outer, 'fixed overlay wrapper').not.toBeNull()
    expect(outer!.parentElement, 'overlay wrapper is a direct child of <body>').toBe(document.body)
    const backdrop = document.querySelector<HTMLElement>('div[aria-hidden="true"][class*="z-[200]"]')
    expect(backdrop, 'EventDialog backdrop').not.toBeNull()
    expect(backdrop!.parentElement, 'backdrop is a direct child of <body>').toBe(document.body)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(mocks.onClose).toHaveBeenCalledTimes(1)
    expect(mocks.createEvent).not.toHaveBeenCalled()

    view.unmount()
    expect(screen.queryByRole('dialog', { name: 'New event' })).not.toBeInTheDocument()
    expect(document.querySelector('div[aria-hidden="true"][class*="z-[200]"]')).toBeNull()
  })
})

// #295: on a 320px phone the location and labels fields sat in a grid with no explicit column below
// `sm`, so its implicit column grew to the fields' minimum content width and pushed both past the
// Details card and the screen edge. jsdom does not lay out CSS; this checks the grid's column classes.

describe('EventDialog details fit narrow screens', () => {
  beforeEach(() => {
    mocks.onClose.mockReset()
    mocks.preferences.timeFormat = '24h'
    mocks.preferences.defaultTimezone = 'UTC'
    mocks.preferences.dateFormat = 'system'
  })

  it('keeps location and labels in one grid with a shrinkable single column below sm and two columns from sm', () => {
    renderWithIntl(
      <EventDialog
        mode="create"
        startDate={new Date('2026-06-01T14:00:00Z')}
        endDate={new Date('2026-06-01T14:30:00Z')}
        onClose={mocks.onClose}
      />,
    )

    const locationCell = screen.getByLabelText('Event location').parentElement!
    const grid = locationCell.parentElement!
    expect(grid.className).toMatch(/(^|\s)grid(\s|$)/)
    const cells = Array.from(grid.children) as HTMLElement[]
    expect(cells).toHaveLength(2)
    expect(cells[0]).toBe(locationCell)
    const labelsCell = cells[1]!
    expect(labelsCell.querySelector('svg[class*="lucide-tag"]'), 'labels field icon').not.toBeNull()
    expect(within(labelsCell).getAllByRole('textbox').length).toBeGreaterThan(0)

    // Two columns from sm stay as they are.
    expect(grid.className).toContain('sm:grid-cols-[minmax(0,1fr)_auto]')
    // Below sm the single column is explicit and may shrink to the card width.
    expect(grid.className).toMatch(/(^|\s)(grid-cols-1|grid-cols-\[minmax\(0,1fr\)\])(\s|$)/)
  })
})

describe('EventDialog in a calendar shared read-only', () => {
  const sharedReadOnly = { id: 'cal-shared', name: 'Shared', color: '#3b82f6', visible: true, accessLevel: 0 }

  beforeEach(() => {
    mocks.createEvent.mockReset().mockResolvedValue(undefined)
    mocks.updateEvent.mockReset().mockResolvedValue(undefined)
    mocks.deleteEvent.mockReset()
    mocks.onClose.mockReset()
    mocks.calendars.push(sharedReadOnly)
    return () => {
      mocks.calendars.splice(mocks.calendars.indexOf(sharedReadOnly), 1)
    }
  })

  it('opens the event read-only: no save, no delete, Enter does not save', () => {
    renderWithIntl(<EventDialog mode="edit" event={makeEvent({ calendarId: 'cal-shared' })} onClose={mocks.onClose} />)

    const done = screen.getByRole('button', { name: 'Done' })
    expect(done).toBeDisabled()
    expect(done).toHaveAttribute('title', 'This calendar is read-only')
    const title = screen.getByRole('textbox', { name: 'Event title' })
    expect(title).toHaveAttribute('readonly')
    expect(screen.queryByRole('button', { name: /Delete event/ })).toBeNull()
    expect(screen.queryByRole('button', { name: '+ Add' })).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Repeat frequency' })).toBeDisabled()

    fireEvent.keyDown(title, { key: 'Enter' })
    expect(mocks.updateEvent).not.toHaveBeenCalled()
    expect(mocks.updateRecurringEvent).not.toHaveBeenCalled()
  })

  it('keeps an event in a writable calendar editable and does not offer the read-only calendar as a target', async () => {
    renderWithIntl(<EventDialog mode="edit" event={makeEvent({ calendarId: 'cal-a' })} onClose={mocks.onClose} />)

    expect(screen.getByRole('button', { name: /Delete event/ })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Event title' })).not.toHaveAttribute('readonly')
    expect(screen.getByRole('combobox', { name: 'Repeat frequency' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Family' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Shared' })).toBeNull()

    fireEvent.change(screen.getByRole('textbox', { name: 'Event title' }), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(mocks.updateEvent).toHaveBeenCalledWith('event-item-1', expect.objectContaining({ title: 'Renamed' })))
  })

  it('does not create a new event in a read-only default calendar', async () => {
    const original = mocks.calendars.splice(0, mocks.calendars.length)
    mocks.calendars.push({ id: 'cal-a', name: 'Work', color: '#10b981', visible: true, accessLevel: 0 }, sharedReadOnly)
    try {
      renderWithIntl(<EventDialog mode="create" startDate={new Date('2026-06-01T14:00:00Z')} onClose={mocks.onClose} />)
      fireEvent.change(screen.getByRole('textbox', { name: 'Event title' }), { target: { value: 'Planning' } })
      expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled()
      expect(screen.queryByRole('button', { name: 'Work' })).toBeNull()
    } finally {
      mocks.calendars.splice(0, mocks.calendars.length, ...original)
    }
    expect(mocks.createEvent).not.toHaveBeenCalled()
  })

  it('applies no recurring delete chosen after the calendar turned read-only', () => {
    mocks.deleteRecurringEvent.mockReset()
    const event = makeEvent({ calendarId: 'cal-a', recurrenceRule: 'FREQ=DAILY;COUNT=5' })
    const instanceDate = new Date('2026-06-03T09:00:00Z')
    const view = renderWithIntl(<EventDialog mode="edit" event={event} instanceDate={instanceDate} onClose={mocks.onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /Delete event/ }))
    expect(screen.getByRole('dialog', { name: 'Delete recurring event' })).toBeVisible()

    // A store update replaces the list, as the list store does.
    const original = mocks.calendars
    mocks.calendars = original.map((calendar) => (calendar.id === 'cal-a' ? { ...calendar, accessLevel: 0 } : calendar))
    try {
      view.rerender(<EventDialog mode="edit" event={event} instanceDate={instanceDate} onClose={mocks.onClose} />)
      fireEvent.click(screen.getByRole('button', { name: /This event/ }))
    } finally {
      mocks.calendars = original
    }
    expect(mocks.deleteRecurringEvent).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Delete recurring event' })).toBeNull()
  })
})

// WEB-01: an occurrence opened from the grid is edited at its own date and time.
describe('EventDialog edits a later occurrence at its own date (WEB-01)', () => {
  beforeEach(() => {
    mocks.updateRecurringEvent.mockReset()
    mocks.onClose.mockReset()
    mocks.preferences.timeFormat = '24h'
    mocks.preferences.defaultTimezone = 'UTC'
    mocks.preferences.dateFormat = 'system'
  })

  const weekly = () => makeEvent({
    startDate: new Date('2026-06-01T09:00:00Z'),
    endDate: new Date('2026-06-01T09:30:00Z'),
    recurrenceRule: 'FREQ=WEEKLY;COUNT=5',
  })
  const occurrence = new Date('2026-06-15T09:00:00Z')

  async function saveWithScope(scope: RegExp) {
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    const scopeDialog = await screen.findByRole('dialog', { name: 'Edit recurring event' })
    fireEvent.click(within(scopeDialog).getByRole('button', { name: scope }))
    await waitFor(() => expect(mocks.updateRecurringEvent).toHaveBeenCalledTimes(1))
    return mocks.updateRecurringEvent.mock.calls[0]! as [string, Partial<CalendarEvent>, string, Date]
  }

  it('shows the selected occurrence date and time, not the series start', () => {
    renderWithIntl(<EventDialog mode="edit" event={weekly()} instanceDate={occurrence} onClose={mocks.onClose} />)

    expect(screen.getByLabelText('Start date')).toHaveValue('2026-06-15')
    expect(screen.getByLabelText('Start time')).toHaveValue('09:00')
    expect(screen.getByLabelText('End date')).toHaveValue('2026-06-15')
    expect(screen.getByLabelText('End time')).toHaveValue('09:30')
  })

  it.each([
    [/This event/, 'this'],
    [/This and all future/, 'this_and_future'],
  ] as const)('a time change saved for %s is dated at the occurrence', async (scopeName, scope) => {
    const event = weekly()
    renderWithIntl(<EventDialog mode="edit" event={event} instanceDate={occurrence} onClose={mocks.onClose} />)
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '10:00' } })

    const [id, patch, chosenScope, instance] = await saveWithScope(scopeName)

    expect([id, chosenScope, instance]).toEqual([event.id, scope, occurrence])
    expect(patch.startDate).toEqual(new Date('2026-06-15T10:00:00Z'))
    expect(patch.endDate).toEqual(new Date('2026-06-15T10:30:00Z'))
  })

  it('the same time change saved for all events moves the series start by the same amount', async () => {
    renderWithIntl(<EventDialog mode="edit" event={weekly()} instanceDate={occurrence} onClose={mocks.onClose} />)
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '10:00' } })

    const [, patch, chosenScope] = await saveWithScope(/All events/)

    expect(chosenScope).toBe('all')
    expect(patch.startDate).toEqual(new Date('2026-06-01T10:00:00Z'))
    expect(patch.endDate).toEqual(new Date('2026-06-01T10:30:00Z'))
  })

  it('a date change saved for all events shifts the series start by the same days', async () => {
    renderWithIntl(<EventDialog mode="edit" event={weekly()} instanceDate={occurrence} onClose={mocks.onClose} />)
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-06-16' } })
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-06-16' } })

    const [, patch] = await saveWithScope(/All events/)

    expect(patch.startDate).toEqual(new Date('2026-06-02T09:00:00Z'))
    expect(patch.endDate).toEqual(new Date('2026-06-02T09:30:00Z'))
  })

  it.each([
    [/This event/],
    [/This and all future/],
    [/All events/],
  ] as const)('control: a title-only save for %s carries no dates', async (scopeName) => {
    renderWithIntl(<EventDialog mode="edit" event={weekly()} instanceDate={occurrence} onClose={mocks.onClose} />)
    fireEvent.change(screen.getByLabelText('Event title'), { target: { value: 'Renamed' } })

    const [, patch] = await saveWithScope(scopeName)

    expect(patch).toEqual({ title: 'Renamed' })
  })

  it('control: an all-events save of a UTC series opened in summer keeps its start when only the title changes', async () => {
    mocks.preferences.defaultTimezone = 'Europe/Berlin'
    const event = makeEvent({
      startDate: new Date('2026-01-05T09:00:00Z'),
      endDate: new Date('2026-01-05T09:30:00Z'),
      recurrenceRule: 'FREQ=WEEKLY',
      timezone: undefined,
    })
    renderWithIntl(<EventDialog mode="edit" event={event} instanceDate={new Date('2026-07-06T09:00:00Z')} onClose={mocks.onClose} />)
    expect(screen.getByLabelText('Start time')).toHaveValue('11:00')
    fireEvent.change(screen.getByLabelText('Event title'), { target: { value: 'Renamed' } })

    const [, patch] = await saveWithScope(/All events/)

    expect(patch).toEqual({ title: 'Renamed' })
  })
})

// WEB-04: a create that is not saved keeps the dialog and its input.
describe('EventDialog create that is not saved (WEB-04)', () => {
  beforeEach(() => {
    mocks.createEvent.mockReset()
    mocks.onClose.mockReset()
    mocks.preferences.timeFormat = '24h'
    mocks.preferences.defaultTimezone = 'UTC'
    mocks.preferences.dateFormat = 'system'
  })

  function renderCreate() {
    renderWithIntl(
      <EventDialog
        mode="create"
        startDate={new Date('2026-06-01T14:00:00Z')}
        endDate={new Date('2026-06-01T14:30:00Z')}
        onClose={mocks.onClose}
      />,
    )
    fireEvent.change(screen.getByLabelText('Event title'), { target: { value: 'Unsaved meeting' } })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  }

  function saveError(unconfirmed: boolean) {
    return Object.assign(new Error('not saved'), { name: 'CalendarSaveError', unconfirmed })
  }

  it.each([
    [false, 'Event not saved. Please try again.'],
    [true, "Couldn't confirm this event was saved. If it appears in your calendar after the next sync, don't add it again."],
  ] as const)('keeps the dialog open with the input when the create rejects (unconfirmed=%s)', async (unconfirmed, message) => {
    mocks.createEvent.mockRejectedValue(saveError(unconfirmed))
    renderCreate()

    expect(await screen.findByText(message)).toBeVisible()
    expect(mocks.onClose).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Event title')).toHaveValue('Unsaved meeting')
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled()
  })

  it('control: a saved create closes the dialog', async () => {
    mocks.createEvent.mockResolvedValue({})
    renderCreate()

    await waitFor(() => expect(mocks.onClose).toHaveBeenCalledTimes(1))
  })
})
