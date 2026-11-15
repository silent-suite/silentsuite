import { describe, expect, it } from 'vitest'
import { deserializeCalendarEvent, generateVCalendar, serializeCalendarEvent, type CalendarEvent } from '@silentsuite/core'
import { splitCalendarItem } from '@silentsuite/core/utils/ical-parser'
import { vEventToImportEvent, type ProviderImportVEvent } from '@/app/components/import/import-mappers'
import { importSourceKey, importSourceKeyOf, importSourceKeys } from '../../google-import/source-key'
import {
  EVENT_FIELDS, EXCEPTION_REQUIRED_FIELDS, LIST_SELECT, MASTER_EXPAND, MASTER_SELECT,
  mapMicrosoftCalendarEvents, resolveGraphTimeZone, type GraphCalendar, type GraphEvent,
} from '../calendar-mapper'
import { WINDOWS_TO_IANA } from '../windows-zones'
import { evaluateRRule } from './rfc5545-evaluator'

const ACCOUNT = 'tid-1.sub-1'
const calendar: GraphCalendar = { id: 'AAMkCal=', name: 'Calendar', isDefaultCalendar: true }
let uidSeq = 0
const newUid = () => `uid-${++uidSeq}`
const map = (events: GraphEvent[], incomplete?: ReadonlySet<string>) => mapMicrosoftCalendarEvents(ACCOUNT, calendar, events, incomplete, newUid)
const utc = (dateTime: string) => ({ dateTime: `${dateTime}.0000000`, timeZone: 'UTC' })
const occurrenceId = (date: string) => `AAMkADM0ZGRhMjk2LWJjZWYtNGZmMy04YWRlLTJlOTcwOTE1OWE5ZgBGAAAAAAA=.${date}`
const BERLIN = 'W. Europe Standard Time'

function master(overrides: Partial<GraphEvent> = {}): GraphEvent {
  return {
    id: 'master-1',
    iCalUId: 'ical-standup',
    type: 'seriesMaster',
    subject: 'Standup',
    start: utc('2026-06-01T07:00:00'),
    end: utc('2026-06-01T07:15:00'),
    isAllDay: false,
    originalStartTimeZone: BERLIN,
    originalEndTimeZone: BERLIN,
    showAs: 'busy',
    isReminderOn: true,
    reminderMinutesBeforeStart: 10,
    isCancelled: false,
    recurrence: {
      pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday'], firstDayOfWeek: 'sunday', index: 'first', month: 0, dayOfMonth: 0 },
      range: { type: 'numbered', startDate: '2026-06-01', numberOfOccurrences: 10, recurrenceTimeZone: BERLIN },
    },
    cancelledOccurrences: [],
    exceptionOccurrences: [],
    ...overrides,
  }
}

function exception(originalStart: string, overrides: Partial<GraphEvent> = {}): GraphEvent {
  return {
    id: `exc-${originalStart}`, iCalUId: 'ical-standup', type: 'exception', subject: 'Standup (moved)',
    originalStart, start: utc('2026-06-08T08:00:00'), end: utc('2026-06-08T08:15:00'), isAllDay: false,
    originalStartTimeZone: BERLIN, isReminderOn: false, isCancelled: false, ...overrides,
  }
}

function written(unit: ProviderImportVEvent): CalendarEvent {
  const payload = vEventToImportEvent(unit, 'target')
  return deserializeCalendarEvent(serializeCalendarEvent({ ...payload, id: 'item', uid: payload.uid!, created: new Date(0), updated: new Date(0) }))
}

/** DTSTART + RRULE of a unit through the independent RFC 5545 evaluator. */
function rfcDates(unit: ProviderImportVEvent, n: number): string[] {
  const v = unit.dtstart
  const date = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`
  const time = v.length > 8 ? `${v.slice(9, 11)}:${v.slice(11, 13)}:${v.slice(13, 15)}` : undefined
  return evaluateRRule({ date, time, tzid: unit.dtstartParams?.['TZID'] }, unit.rrule!, n)
}

describe('Microsoft calendar mapping: series', () => {
  it('makes a series with its cancelled and changed occurrences one unit, kept whole through the writer', () => {
    const { units, unreadable } = map([master({
      cancelledOccurrences: [occurrenceId('2026-06-15')],
      exceptionOccurrences: [
        exception('2026-06-08T07:00:00Z'),
        exception('2026-06-22T07:00:00.0000000Z', { isCancelled: true, start: utc('2026-06-22T07:00:00'), end: utc('2026-06-22T07:15:00') }),
      ],
    })])
    expect(unreadable).toBe(0)
    expect(units).toHaveLength(1)
    const unit = units[0]!
    expect(unit.sourceKey).toBe(importSourceKey('microsoft', ACCOUNT, 'AAMkCal=', 'ical-standup'))
    expect(unit.uid).toMatch(/^uid-/)
    expect(unit.dtstart).toBe('20260601T090000')
    expect(unit.dtstartParams).toEqual({ TZID: 'Europe/Berlin' })
    expect(unit.dtend).toBe('20260601T091500')
    expect(unit.rrule).toBe('FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;WKST=SU;COUNT=10')
    expect(unit.exdate).toEqual(['20260615T090000', '20260622T090000'])
    expect(unit.exdateParams).toEqual({ TZID: 'Europe/Berlin' })
    expect(unit.overrides).toHaveLength(1)
    expect(unit.overrides![0]).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20260608T090000')
    expect(unit.overrides![0]).toContain(`UID:${unit.uid}`)
    expect(unit.overrides![0]).toContain('DTSTART;TZID=Europe/Berlin:20260608T100000')
    expect(rfcDates(unit, 3)).toEqual(['2026-06-01', '2026-06-08', '2026-06-15'])

    const event = written(unit)
    expect(event.uid).toBe(unit.uid)
    expect(event.timezone).toBe('Europe/Berlin')
    expect(event.startDate.toISOString()).toBe('2026-06-01T07:00:00.000Z')
    expect(event.recurrenceRule).toBe(unit.rrule)
    expect(event.exceptions.map((d) => d.toISOString())).toEqual(['2026-06-15T07:00:00.000Z', '2026-06-22T07:00:00.000Z'])
    expect(event.overrides![0]!.some((line) => line === 'SUMMARY:Standup (moved)')).toBe(true)
    expect(event.alarms).toEqual([{ action: 'DISPLAY', trigger: '-PT10M', description: 'Reminder' }])
    expect(importSourceKeyOf(event.unknownProperties)).toBe(unit.sourceKey)

    // The same item read back through the shared splitter keeps master and override together.
    const split = splitCalendarItem(generateVCalendar([unit]))
    expect(split).not.toBeNull()
  })

  it('places DTSTART on the first occurrence of an off-pattern start (Aug 29 2017 example) with UNTIL at the end of the end date', () => {
    const { units } = map([master({
      start: utc('2017-08-29T16:00:00'), end: utc('2017-08-29T17:00:00'),
      originalStartTimeZone: 'Pacific Standard Time', originalEndTimeZone: 'Pacific Standard Time',
      recurrence: {
        pattern: { type: 'relativeMonthly', interval: 2, daysOfWeek: ['thursday'], index: 'first', firstDayOfWeek: 'sunday' },
        range: { type: 'endDate', startDate: '2017-08-29', endDate: '2018-03-01', recurrenceTimeZone: 'Pacific Standard Time' },
      },
      cancelledOccurrences: [occurrenceId('2017-11-02')],
    })])
    const unit = units[0]!
    expect(unit.dtstart).toBe('20170907T090000')
    expect(unit.dtstartParams).toEqual({ TZID: 'America/Los_Angeles' })
    expect(unit.dtend).toBe('20170907T100000')
    expect(unit.rrule).toBe('FREQ=MONTHLY;INTERVAL=2;BYDAY=1TH;UNTIL=20180302T075959Z')
    expect(unit.exdate).toEqual(['20171102T090000'])
    expect(rfcDates(unit, 10)).toEqual(['2017-09-07', '2017-11-02', '2018-01-04', '2018-03-01'])
  })

  it('reads cancelled occurrence dates as local dates, near local midnight and across a DST change', () => {
    const daily = (start: string, startDate: string, cancelled: string[]) => master({
      start: utc(start), end: utc(start),
      recurrence: { pattern: { type: 'daily', interval: 1 }, range: { type: 'noEnd', startDate, recurrenceTimeZone: BERLIN } },
      cancelledOccurrences: cancelled.map(occurrenceId),
    })
    // 23:30 Berlin: the UTC date of each occurrence is the same day, its instant moves at the DST change.
    const late = map([daily('2026-03-27T22:30:00', '2026-03-27', ['2026-03-28', '2026-03-30'])]).units[0]!
    expect(late.dtstart).toBe('20260327T233000')
    expect(late.exdate).toEqual(['20260328T233000', '20260330T233000'])
    expect(written(late).exceptions.map((d) => d.toISOString())).toEqual(['2026-03-28T22:30:00.000Z', '2026-03-30T21:30:00.000Z'])
    // 00:15 Berlin: each occurrence's UTC instant falls on the previous day; the id's date is the local one.
    const early = map([{ ...daily('2026-03-26T23:15:00', '2026-03-27', ['2026-03-29', '2026-03-30']), iCalUId: 'ical-early' }]).units[0]!
    expect(early.dtstart).toBe('20260327T001500')
    expect(early.exdate).toEqual(['20260329T001500', '20260330T001500'])
    expect(written(early).exceptions.map((d) => d.toISOString())).toEqual(['2026-03-28T23:15:00.000Z', '2026-03-29T22:15:00.000Z'])
  })

  it('maps an all-day series with a cancelled and a moved occurrence, for both all-day value shapes', () => {
    const allDay = (start: GraphEvent['start'], end: GraphEvent['end'], originalStart: string) => master({
      isAllDay: true, start, end,
      recurrence: { pattern: { type: 'weekly', interval: 1, daysOfWeek: ['monday'], firstDayOfWeek: 'monday' }, range: { type: 'endDate', startDate: '2026-07-06', endDate: '2026-08-31', recurrenceTimeZone: BERLIN } },
      cancelledOccurrences: [occurrenceId('2026-07-13')],
      exceptionOccurrences: [exception(originalStart, { isAllDay: true, subject: 'Bins (Tuesday)', start: utc('2026-07-21T00:00:00'), end: utc('2026-07-22T00:00:00') })],
    })
    const floating = map([allDay(utc('2026-07-06T00:00:00'), utc('2026-07-07T00:00:00'), '2026-07-20T00:00:00Z')]).units[0]!
    const zoned = map([{ ...allDay(utc('2026-07-05T22:00:00'), utc('2026-07-06T22:00:00'), '2026-07-19T22:00:00Z'), iCalUId: 'ical-2' }]).units[0]!
    for (const unit of [floating, zoned]) {
      expect(unit.dtstart).toBe('20260706')
      expect(unit.dtstartParams).toEqual({ VALUE: 'DATE' })
      expect(unit.dtend).toBe('20260707')
      expect(unit.rrule).toBe('FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;WKST=MO;UNTIL=20260831')
      expect(unit.exdate).toEqual(['20260713'])
      expect(unit.exdateParams).toBeUndefined()
      expect(unit.overrides![0]).toContain('RECURRENCE-ID;VALUE=DATE:20260720')
      expect(rfcDates(unit, 3)).toEqual(['2026-07-06', '2026-07-13', '2026-07-20'])
      const event = written(unit)
      expect(event.allDay).toBe(true)
      expect(event.exceptions.map((d) => d.getDate())).toEqual([13])
    }
  })

  it('uses a recurrence time zone that differs from the series zone only when both give the same dates and instants', () => {
    const paris = map([master({
      originalStartTimeZone: 'Romance Standard Time',
      cancelledOccurrences: [occurrenceId('2026-06-15')],
    })])
    expect(paris.unreadable).toBe(0)
    expect(paris.units[0]!.dtstartParams).toEqual({ TZID: 'Europe/Paris' })
    expect(paris.units[0]!.exdate).toEqual(['20260615T090000'])

    const pacific = map([master({ originalStartTimeZone: 'Pacific Standard Time', start: utc('2026-06-01T16:00:00'), end: utc('2026-06-01T17:00:00'), cancelledOccurrences: [occurrenceId('2026-06-15')] })])
    expect(pacific).toEqual({ units: [], unreadable: 1 })
  })
})

describe('Microsoft calendar mapping: DST fall-back', () => {
  it('a series starting in the repeated hour is left out unmarked; one in the first 02:30 imports', () => {
    const weekly = { pattern: { type: 'weekly', interval: 1, daysOfWeek: ['sunday'], firstDayOfWeek: 'sunday' }, range: { type: 'numbered', startDate: '2026-10-25', numberOfOccurrences: 3, recurrenceTimeZone: BERLIN } }
    const second = map([master({ iCalUId: 'late', start: utc('2026-10-25T01:30:00'), end: utc('2026-10-25T01:45:00'), recurrence: weekly })])
    expect(second).toMatchObject({ units: [], unreadable: 1 })
    const first = map([master({ iCalUId: 'early', start: utc('2026-10-25T00:30:00'), end: utc('2026-10-25T00:45:00'), recurrence: weekly })])
    expect(first.unreadable).toBe(0)
    expect(written(first.units[0]!).startDate.toISOString()).toBe('2026-10-25T00:30:00.000Z')
  })

  it('a moved occurrence in the repeated hour keeps its exact time', () => {
    const { units, unreadable } = map([master({
      exceptionOccurrences: [exception('2026-06-08T07:00:00Z', { start: utc('2026-10-25T01:30:00'), end: utc('2026-10-25T01:45:00') })],
    })])
    expect(unreadable).toBe(0)
    expect(units[0]!.overrides!.join('\n')).toContain('DTSTART:20261025T013000Z')
  })
})

describe('Microsoft calendar mapping: unreadable series', () => {
  const cases: [string, GraphEvent, ReadonlySet<string>?][] = [
    ['unparseable cancelled id', master({ cancelledOccurrences: ['AAMk-no-date'] })],
    ['cancelled id with an impossible date', master({ cancelledOccurrences: [occurrenceId('2026-06-31')] })],
    ['cancelled date off the pattern', master({ cancelledOccurrences: [occurrenceId('2026-06-16')] })],
    ['cancelled date past COUNT', master({ cancelledOccurrences: [occurrenceId('2026-08-10')] })],
    ['exception without originalStart', master({ exceptionOccurrences: [{ ...exception('2026-06-08T07:00:00Z'), originalStart: undefined }] })],
    ['exception without end', master({ exceptionOccurrences: [{ ...exception('2026-06-08T07:00:00Z'), end: undefined }] })],
    ['exception at a time that is no occurrence', master({ exceptionOccurrences: [exception('2026-06-08T07:30:00Z')] })],
    ['exception on a date that is no occurrence', master({ exceptionOccurrences: [exception('2026-06-09T07:00:00Z')] })],
    ['exception with an unreadable start', master({ exceptionOccurrences: [exception('2026-06-08T07:00:00Z', { start: { dateTime: 'soon', timeZone: 'UTC' } })] })],
    ['changed occurrence that is also cancelled', master({ cancelledOccurrences: [occurrenceId('2026-06-08')], exceptionOccurrences: [exception('2026-06-08T07:00:00Z')] })],
    ['two changes of one occurrence', master({ exceptionOccurrences: [exception('2026-06-08T07:00:00Z'), exception('2026-06-08T07:00:00Z', { subject: 'Other' })] })],
    ['master not re-read (no cancelledOccurrences)', master({ cancelledOccurrences: undefined })],
    ['master not re-read (no exceptionOccurrences)', master({ exceptionOccurrences: undefined })],
    ['incomplete master detail read', master(), new Set(['master-1'])],
    ['unsupported pattern', master({ recurrence: { pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 31 }, range: { type: 'noEnd', startDate: '2026-06-01' } } })],
    ['unresolvable recurrence time zone', master({ recurrence: { ...master().recurrence!, range: { ...master().recurrence!.range!, recurrenceTimeZone: 'tzone://Microsoft/Custom' } } })],
    ['no iCalUId', master({ iCalUId: undefined })],
  ]
  for (const [name, event, incomplete] of cases) {
    it(`leaves the series out unmarked: ${name}`, () => {
      expect(map([event], incomplete)).toEqual({ units: [], unreadable: 1 })
    })
  }

  it('leaves a custom-zone series out, then imports it once its recurrence time zone resolves', () => {
    const custom = (recurrenceTimeZone?: string) => master({
      originalStartTimeZone: 'tzone://Microsoft/Custom', originalEndTimeZone: 'tzone://Microsoft/Custom',
      start: utc('2026-03-27T08:00:00'), end: utc('2026-03-27T09:00:00'),
      recurrence: { pattern: { type: 'daily', interval: 1 }, range: { type: 'numbered', startDate: '2026-03-27', numberOfOccurrences: 5, ...(recurrenceTimeZone ? { recurrenceTimeZone } : {}) } },
      cancelledOccurrences: [occurrenceId('2026-03-30')],
    })
    const first = map([custom(), custom('tzone://Microsoft/Custom')])
    expect(first).toEqual({ units: [], unreadable: 2 })
    const keysAfterFirstRun = importSourceKeys(first.units)

    const retry = map([custom(BERLIN)])
    expect(retry.unreadable).toBe(0)
    const unit = retry.units[0]!
    expect(keysAfterFirstRun.has(unit.sourceKey)).toBe(false)
    expect(unit.dtstart).toBe('20260327T090000')
    expect(unit.dtstartParams).toEqual({ TZID: 'Europe/Berlin' })
    expect(unit.rrule).toBe('FREQ=DAILY;INTERVAL=1;COUNT=5')
    expect(unit.exdate).toEqual(['20260330T090000'])
    expect(rfcDates(unit, 10)).toEqual(['2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31'])
    // Across the DST change the wall clock stays at 09:00 and the instant moves.
    expect(written(unit).exceptions.map((d) => d.toISOString())).toEqual(['2026-03-30T07:00:00.000Z'])
  })

  it('counts each unreadable unit once and still imports the readable ones', () => {
    const result = map([
      master({ cancelledOccurrences: ['bad'] }),
      { id: 's1', iCalUId: 'single-1', type: 'singleInstance', subject: 'Fine', start: utc('2026-06-01T10:00:00'), end: utc('2026-06-01T11:00:00'), originalStartTimeZone: BERLIN },
      { id: 's2', iCalUId: 'single-2', type: 'singleInstance', start: { dateTime: 'nope', timeZone: 'UTC' }, end: utc('2026-06-01T11:00:00') },
    ])
    expect(result.unreadable).toBe(2)
    expect(result.units.map((u) => u.summary)).toEqual(['Fine'])
  })
})

describe('Microsoft calendar mapping: single events and fields', () => {
  const single = (overrides: Partial<GraphEvent>): GraphEvent => ({
    id: 'e1', iCalUId: 'ical-e1', type: 'singleInstance', subject: 'Call',
    start: utc('2026-07-01T12:30:00'), end: utc('2026-07-01T13:00:00'), isAllDay: false,
    originalStartTimeZone: 'Eastern Standard Time', originalEndTimeZone: 'Eastern Standard Time', showAs: 'busy',
    isReminderOn: false, reminderMinutesBeforeStart: 15, isCancelled: false, recurrence: null, ...overrides,
  })

  it('writes a timed event in its Windows or IANA zone, and in UTC when the zone is unknown or custom', () => {
    const { units } = map([
      single({}),
      single({ iCalUId: 'ical-e2', originalStartTimeZone: 'Asia/Tokyo' }),
      single({ iCalUId: 'ical-e3', originalStartTimeZone: 'tzone://Microsoft/Custom' }),
      single({ iCalUId: 'ical-e4', originalStartTimeZone: 'Mars Standard Time' }),
    ])
    expect(units.map((u) => [u.dtstart, u.dtstartParams, u.dtend])).toEqual([
      ['20260701T083000', { TZID: 'America/New_York' }, '20260701T090000'],
      ['20260701T213000', { TZID: 'Asia/Tokyo' }, '20260701T220000'],
      ['20260701T123000Z', undefined, '20260701T130000Z'],
      ['20260701T123000Z', undefined, '20260701T130000Z'],
    ])
    for (const unit of units) expect(written(unit).startDate.toISOString()).toBe('2026-07-01T12:30:00.000Z')
  })

  it('keeps an instant in the repeated hour after a DST fall-back exact by writing it in UTC', () => {
    // Berlin falls back at 01:00Z on 2026-10-25: 00:30Z and 01:30Z are both 02:30 local.
    const berlin = { originalStartTimeZone: BERLIN, originalEndTimeZone: BERLIN }
    const { units, unreadable } = map([
      single({ iCalUId: 'f1', ...berlin, start: utc('2026-10-25T00:30:00'), end: utc('2026-10-25T00:45:00') }),
      single({ iCalUId: 'f2', ...berlin, start: utc('2026-10-25T01:30:00'), end: utc('2026-10-25T01:45:00') }),
      single({ iCalUId: 'f3', ...berlin, start: utc('2026-10-25T02:30:00'), end: utc('2026-10-25T02:45:00') }),
    ])
    expect(unreadable).toBe(0)
    expect(units.map((u) => [u.dtstart, u.dtstartParams])).toEqual([
      ['20261025T023000', { TZID: 'Europe/Berlin' }],
      ['20261025T013000Z', undefined],
      ['20261025T033000', { TZID: 'Europe/Berlin' }],
    ])
    expect(units.map((u) => written(u).startDate.toISOString())).toEqual([
      '2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z', '2026-10-25T02:30:00.000Z',
    ])
    expect(units.map((u) => written(u).endDate.toISOString())).toEqual([
      '2026-10-25T00:45:00.000Z', '2026-10-25T01:45:00.000Z', '2026-10-25T02:45:00.000Z',
    ])
  })

  it('maps single and multi-day all-day events in both shapes, with an exclusive end date', () => {
    const { units, unreadable } = map([
      single({ iCalUId: 'a1', isAllDay: true, start: utc('2026-07-01T00:00:00'), end: utc('2026-07-02T00:00:00') }),
      single({ iCalUId: 'a2', isAllDay: true, start: utc('2026-07-01T00:00:00'), end: utc('2026-07-04T00:00:00') }),
      single({ iCalUId: 'a3', isAllDay: true, originalStartTimeZone: BERLIN, originalEndTimeZone: BERLIN, start: utc('2026-06-30T22:00:00'), end: utc('2026-07-03T22:00:00') }),
      // Not midnight in either reading: unreadable.
      single({ iCalUId: 'a4', isAllDay: true, start: utc('2026-07-01T05:00:00'), end: utc('2026-07-02T05:00:00') }),
    ])
    expect(unreadable).toBe(1)
    expect(units.map((u) => [u.dtstart, u.dtend, u.dtstartParams])).toEqual([
      ['20260701', '20260702', { VALUE: 'DATE' }],
      ['20260701', '20260704', { VALUE: 'DATE' }],
      ['20260701', '20260704', { VALUE: 'DATE' }],
    ])
    const multi = written(units[1]!)
    expect(multi.allDay).toBe(true)
    expect([multi.startDate.getDate(), multi.endDate.getDate()]).toEqual([1, 4])
  })

  it('maps subject, text body, location, free/busy and reminders; skips cancelled events and occurrence entries', () => {
    const { units, unreadable } = map([
      single({ subject: 'Lunch', body: { contentType: 'text', content: 'Bring notes\r\n' }, location: { displayName: 'Cafe' }, showAs: 'free', isReminderOn: true, reminderMinutesBeforeStart: 0 }),
      single({ iCalUId: 'html', body: { contentType: 'html', content: '<p>x</p>' }, isReminderOn: true, reminderMinutesBeforeStart: 30 }),
      single({ iCalUId: 'cancelled', isCancelled: true }),
      single({ iCalUId: 'occ', type: 'occurrence' }),
      single({ iCalUId: undefined }),
      single({ iCalUId: 'odd', type: 'singleInstance', recurrence: master().recurrence }),
      single({}), // same iCalUId as the first: one unit
    ])
    expect(unreadable).toBe(2)
    expect(units).toHaveLength(2)
    const [lunch, html] = units
    expect(lunch).toMatchObject({ summary: 'Lunch', description: 'Bring notes', location: 'Cafe', transp: 'TRANSPARENT' })
    expect(lunch!.valarms).toEqual([{ action: 'DISPLAY', trigger: 'PT0S', description: 'Reminder' }])
    expect(lunch!.unknownProperties).toEqual([`X-SILENTSUITE-IMPORT-SOURCE:${lunch!.sourceKey}`])
    expect(html!.description).toBeUndefined()
    expect(html!.transp).toBeUndefined()
    expect(html!.valarms).toEqual([{ action: 'DISPLAY', trigger: '-PT30M', description: 'Reminder' }])
    expect(written(lunch!).transp).toBe('TRANSPARENT')
  })
})

describe('Microsoft calendar projections and zones', () => {
  it('selects the plan fields', () => {
    const f = 'id,iCalUId,type,subject,body,location,start,end,isAllDay,originalStartTimeZone,originalEndTimeZone,showAs,isReminderOn,reminderMinutesBeforeStart,isCancelled'
    expect(EVENT_FIELDS.join(',')).toBe(f)
    expect(LIST_SELECT).toBe(`${f},recurrence`)
    expect(MASTER_SELECT).toBe(`${f},recurrence,cancelledOccurrences,exceptionOccurrences`)
    expect(MASTER_EXPAND).toBe(`exceptionOccurrences($select=${f},originalStart)`)
    expect(EXCEPTION_REQUIRED_FIELDS).toEqual(['originalStart', 'start', 'end'])
  })

  it('maps Windows zone names through the CLDR table and passes IANA names through', () => {
    expect(Object.keys(WINDOWS_TO_IANA)).toHaveLength(142)
    for (const zone of Object.values(WINDOWS_TO_IANA)) expect(resolveGraphTimeZone(zone), zone).not.toBeNull()
    expect(resolveGraphTimeZone('W. Europe Standard Time')).toBe('Europe/Berlin')
    expect(resolveGraphTimeZone('Pacific Standard Time')).toBe('America/Los_Angeles')
    expect(resolveGraphTimeZone('Europe/Lisbon')).toBe('Europe/Lisbon')
    expect(resolveGraphTimeZone('tzone://Microsoft/Utc')).toBe('UTC')
    expect(resolveGraphTimeZone('tzone://Microsoft/Custom')).toBeNull()
    expect(resolveGraphTimeZone('Mars Standard Time')).toBeNull()
    expect(resolveGraphTimeZone('Europe/Berlin;X=1')).toBeNull()
    expect(resolveGraphTimeZone(undefined)).toBeNull()
  })
})
