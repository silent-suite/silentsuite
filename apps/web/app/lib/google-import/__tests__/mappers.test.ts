import { describe, expect, it } from 'vitest'
import { deserializeCalendarEvent, serializeCalendarEvent, type CalendarEvent } from '@silentsuite/core'
import { vEventToImportEvent } from '@/app/components/import/import-mappers'
import { mapGoogleCalendarEvents, type GoogleCalendar, type GoogleEvent } from '../calendar-mapper'
import { mapGooglePeople } from '../contact-mapper'
import { IMPORT_SOURCE_PROPERTY, importSourceKey, importSourceKeyOf } from '../source-key'

const calendar: GoogleCalendar = { id: 'me@example.com', primary: true, timeZone: 'Europe/Berlin', defaultReminders: [{ method: 'popup', minutes: 10 }] }
let uidSeq = 0
const newUid = () => `uid-${++uidSeq}`

/** A weekly Berlin series with one moved, one cancelled and one EXDATE'd occurrence. */
const seriesFixture: GoogleEvent[] = [
  {
    id: 'standup',
    iCalUID: 'standup@google.com',
    summary: 'Standup',
    status: 'confirmed',
    start: { dateTime: '2026-06-01T09:00:00+02:00', timeZone: 'Europe/Berlin' },
    end: { dateTime: '2026-06-01T09:15:00+02:00', timeZone: 'Europe/Berlin' },
    recurrence: ['RRULE:FREQ=WEEKLY;COUNT=10', 'EXDATE;TZID=Europe/Berlin:20260615T090000'],
    reminders: { useDefault: true },
  },
  {
    id: 'standup_20260608T070000Z',
    iCalUID: 'standup@google.com',
    recurringEventId: 'standup',
    summary: 'Standup (moved)',
    originalStartTime: { dateTime: '2026-06-08T09:00:00+02:00', timeZone: 'Europe/Berlin' },
    start: { dateTime: '2026-06-08T10:00:00+02:00', timeZone: 'Europe/Berlin' },
    end: { dateTime: '2026-06-08T10:15:00+02:00', timeZone: 'Europe/Berlin' },
  },
  {
    id: 'standup_20260622T070000Z',
    iCalUID: 'standup@google.com',
    recurringEventId: 'standup',
    status: 'cancelled',
    originalStartTime: { dateTime: '2026-06-22T09:00:00+02:00', timeZone: 'Europe/Berlin' },
  },
]

function written(unit: ReturnType<typeof mapGoogleCalendarEvents>['units'][number], calendarId = 'target'): CalendarEvent {
  const payload = vEventToImportEvent(unit, calendarId)
  const event: CalendarEvent = {
    ...payload,
    id: 'item',
    uid: payload.uid!,
    created: new Date(0),
    updated: new Date(0),
  }
  return deserializeCalendarEvent(serializeCalendarEvent(event))
}

describe('Google Calendar mapping', () => {
  it('makes a series with its changed and cancelled occurrences one unit, kept whole through the writer', () => {
    // Order on the wire is not guaranteed: an exception may come before its master.
    const { units, unreadable } = mapGoogleCalendarEvents('me@example.com', calendar, [seriesFixture[2]!, seriesFixture[1]!, seriesFixture[0]!], newUid)
    expect(unreadable).toBe(0)
    expect(units).toHaveLength(1)
    const unit = units[0]!
    expect(unit.sourceKey).toBe(importSourceKey('google', 'me@example.com', 'me@example.com', 'standup@google.com'))
    expect(unit.dtstart).toBe('20260601T090000')
    expect(unit.dtstartParams).toEqual({ TZID: 'Europe/Berlin' })
    expect(unit.rrule).toBe('FREQ=WEEKLY;COUNT=10')
    expect(unit.exdate).toEqual(['20260615T090000', '20260622T090000'])
    expect(unit.overrides).toHaveLength(1)
    expect(unit.overrides![0]).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20260608T090000')
    expect(unit.overrides![0]).toContain(`UID:${unit.uid}`)

    const event = written(unit)
    expect(event.uid).toBe(unit.uid)
    expect(event.timezone).toBe('Europe/Berlin')
    expect(event.recurrenceRule).toBe('FREQ=WEEKLY;COUNT=10')
    expect(event.exceptions.map((d) => d.toISOString())).toEqual(['2026-06-15T07:00:00.000Z', '2026-06-22T07:00:00.000Z'])
    expect(event.overrides).toHaveLength(1)
    expect(event.overrides![0]!.some((line) => line === 'SUMMARY:Standup (moved)')).toBe(true)
    expect(event.alarms).toEqual([{ action: 'DISPLAY', trigger: '-PT10M', description: 'Reminder' }])
    expect(importSourceKeyOf(event.unknownProperties)).toBe(unit.sourceKey)
  })

  it('maps all-day events as dates and timed events without a zone to UTC', () => {
    const { units } = mapGoogleCalendarEvents('me@example.com', calendar, [
      { id: 'a', iCalUID: 'a@google.com', summary: 'Holiday', start: { date: '2026-07-01' }, end: { date: '2026-07-03' }, transparency: 'transparent' },
      { id: 'b', iCalUID: 'b@google.com', summary: 'Call', start: { dateTime: '2026-07-01T08:30:00-04:00' }, end: { dateTime: '2026-07-01T09:00:00-04:00' }, reminders: { useDefault: false } },
    ], newUid)
    const [allDay, timed] = units.map((unit) => written(unit))
    expect(allDay!.allDay).toBe(true)
    expect([allDay!.startDate.getDate(), allDay!.endDate.getDate()]).toEqual([1, 3])
    expect(allDay!.transp).toBe('TRANSPARENT')
    expect(timed!.allDay).toBe(false)
    expect(timed!.startDate.toISOString()).toBe('2026-07-01T12:30:00.000Z')
    expect(timed!.alarms).toEqual([])
  })

  it('keeps an all-day series with an all-day cancelled occurrence', () => {
    const { units } = mapGoogleCalendarEvents('me@example.com', calendar, [
      { id: 'bin', iCalUID: 'bin@google.com', summary: 'Bins', start: { date: '2026-06-01' }, end: { date: '2026-06-02' }, recurrence: ['RRULE:FREQ=WEEKLY'] },
      { id: 'bin_x', iCalUID: 'bin@google.com', recurringEventId: 'bin', status: 'cancelled', originalStartTime: { date: '2026-06-08' } },
    ], newUid)
    expect(units).toHaveLength(1)
    expect(units[0]!.exdate).toEqual(['20260608'])
    expect(written(units[0]!).exceptions.map((d) => d.getDate())).toEqual([8])
  })

  it('keeps an occurrence whose series is not visible as its own event, and drops a lone cancellation', () => {
    const { units } = mapGoogleCalendarEvents('me@example.com', calendar, [
      { id: 'x_1', iCalUID: 'x@google.com', recurringEventId: 'x', summary: 'One visit', originalStartTime: { dateTime: '2026-06-01T09:00:00Z' }, start: { dateTime: '2026-06-01T09:00:00Z' }, end: { dateTime: '2026-06-01T10:00:00Z' } },
      { id: 'y_1', iCalUID: 'y@google.com', recurringEventId: 'y', status: 'cancelled', originalStartTime: { dateTime: '2026-06-01T09:00:00Z' } },
    ], newUid)
    expect(units.map((u) => u.summary)).toEqual(['One visit'])
    expect(units[0]!.sourceKey).toBe(importSourceKey('google', 'me@example.com', 'me@example.com', 'x@google.com#2026-06-01T09:00:00Z'))
  })

  it('skips working-location and birthday entries and unreadable starts', () => {
    const { units, unreadable } = mapGoogleCalendarEvents('me@example.com', calendar, [
      { id: 'w', eventType: 'workingLocation', start: { date: '2026-06-01' }, end: { date: '2026-06-02' } },
      { id: 'bd', eventType: 'birthday', start: { date: '2026-06-01' }, end: { date: '2026-06-02' }, recurrence: ['RRULE:FREQ=YEARLY'] },
      { id: 'bad', summary: 'No start' },
    ], newUid)
    expect(units).toEqual([])
    expect(unreadable).toBe(1)
  })

  it('never lets a provider recurrence line add a property', () => {
    const { units } = mapGoogleCalendarEvents('me@example.com', calendar, [
      { id: 'inj', iCalUID: 'inj@google.com', summary: 'S', start: { dateTime: '2026-06-01T09:00:00Z' }, end: { dateTime: '2026-06-01T10:00:00Z' }, recurrence: ['RRULE:FREQ=DAILY\r\nATTACH:https://evil.example', 'RDATE:20260610T090000Z'] },
    ], newUid)
    const event = written(units[0]!)
    const text = serializeCalendarEvent({ ...event, id: 'i' })
    expect(text).not.toContain('evil.example')
    expect(event.recurrenceRule).toBeNull()
    expect(event.unknownProperties).toContain('RDATE:20260610T090000Z')
  })

  it('scopes keys by calendar, so the same event in two calendars stays two items', () => {
    const event: GoogleEvent = { id: 'e', iCalUID: 'shared@google.com', start: { dateTime: '2026-06-01T09:00:00Z' }, end: { dateTime: '2026-06-01T10:00:00Z' } }
    const a = mapGoogleCalendarEvents('me@example.com', calendar, [event], newUid).units[0]!
    const b = mapGoogleCalendarEvents('me@example.com', { id: 'other@group.calendar.google.com' }, [event], newUid).units[0]!
    expect(a.sourceKey).not.toBe(b.sourceKey)
    expect(a.unknownProperties).toContain(`${IMPORT_SOURCE_PROPERTY}:${a.sourceKey}`)
  })
})

describe('Google contact mapping', () => {
  it('maps names, phones, emails, addresses, birthdays, notes, organization, groups and starred', () => {
    const [card, yearless, textual] = mapGooglePeople('people/1', [
      {
        resourceName: 'people/c1',
        names: [{ displayName: 'Dr. Ann B. Lee', givenName: 'Ann', middleName: 'B.', familyName: 'Lee', honorificPrefix: 'Dr.' }],
        phoneNumbers: [{ value: '+49 30 1', type: 'work' }, { value: '+49 170 2', type: 'mobile', metadata: { primary: true } }],
        emailAddresses: [{ value: 'ann@example.com', type: 'home' }, { value: 'ann@work.example', type: 'custom' }],
        addresses: [{ type: 'home', streetAddress: 'Main St 1', extendedAddress: 'Apt 2', city: 'Berlin', region: 'BE', postalCode: '10115', country: 'Germany' }, { type: 'work' }],
        birthdays: [{ date: { year: 1990, month: 1, day: 31 } }],
        biographies: [{ value: 'Met at the conference.' }],
        organizations: [{ name: 'ACME', title: 'Engineer' }],
        memberships: [
          { contactGroupMembership: { contactGroupResourceName: 'contactGroups/fam' } },
          { contactGroupMembership: { contactGroupResourceName: 'contactGroups/myContacts' } },
          { contactGroupMembership: { contactGroupResourceName: 'contactGroups/starred' } },
        ],
      },
      { resourceName: 'people/c2', names: [{ givenName: 'Bo' }], birthdays: [{ date: { month: 2, day: 9 } }] },
      { resourceName: 'people/c3', organizations: [{ name: 'Plumber Ltd' }], birthdays: [{ text: 'Spring 1980' }] },
      { resourceName: 'people/c1', names: [{ displayName: 'Duplicate row' }] },
    ], [
      { resourceName: 'contactGroups/fam', name: 'family', formattedName: 'Family', groupType: 'USER_CONTACT_GROUP' },
      { resourceName: 'contactGroups/myContacts', name: 'myContacts', groupType: 'SYSTEM_CONTACT_GROUP' },
    ])
    expect(card).toMatchObject({
      fn: 'Dr. Ann B. Lee',
      n: { given: 'Ann B.', family: 'Lee', prefix: 'Dr.', suffix: '' },
      tel: [{ type: 'cell', value: '+49 170 2' }, { type: 'work', value: '+49 30 1' }],
      email: [{ type: 'home', value: 'ann@example.com' }, { type: 'other', value: 'ann@work.example' }],
      adr: [{ type: 'home', street: 'Main St 1\nApt 2', city: 'Berlin', state: 'BE', postalCode: '10115', country: 'Germany' }],
      bday: '1990-01-31',
      note: 'Met at the conference.',
      org: 'ACME',
      title: 'Engineer',
      categories: ['Family'],
      favorite: true,
      sourceKey: importSourceKey('google', 'people/1', 'connections', 'people/c1'),
    })
    expect(importSourceKeyOf(card!.unknownProperties)).toBe(card!.sourceKey)
    expect(yearless).toMatchObject({ fn: 'Bo', bday: '--02-09' })
    expect(textual).toMatchObject({ fn: 'Plumber Ltd', bday: 'Spring 1980', bdayIsText: true })
    expect(textual!.favorite).toBeUndefined()
  })

  it('never merges different people, even with the same name and email', () => {
    const cards = mapGooglePeople('people/1', [
      { resourceName: 'people/a', names: [{ displayName: 'Sam' }], emailAddresses: [{ value: 'sam@example.com' }] },
      { resourceName: 'people/b', names: [{ displayName: 'Sam' }], emailAddresses: [{ value: 'sam@example.com' }] },
    ], [])
    expect(cards.map((c) => c.sourceKey)).toEqual([
      importSourceKey('google', 'people/1', 'connections', 'people/a'),
      importSourceKey('google', 'people/1', 'connections', 'people/b'),
    ])
  })
})
