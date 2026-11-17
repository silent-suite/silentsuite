import { describe, expect, it } from 'vitest'
import { parseVCalendar, serializeCalendarEvent, deserializeCalendarEvent } from '@silentsuite/core'
import { vEventToImportEvent } from '../import-mappers'

function imported(text: string) {
  const payload = vEventToImportEvent(parseVCalendar(text)[0]!, 'calendar')
  const now = new Date('2026-11-17T00:00:00Z')
  return serializeCalendarEvent({ ...payload, id: 'item', uid: payload.uid ?? 'item', created: now, updated: now })
}

describe('file time zone preservation', () => {
  it('maps undefined Windows references, including recurrence dates, to IANA', () => {
    const saved = imported(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:zone', 'DTSTART;TZID=W. Europe Standard Time:20261117T100000', 'DTEND;TZID=W. Europe Standard Time:20261117T110000',
      'EXDATE;TZID=W. Europe Standard Time:20261118T100000', 'RDATE;TZID=W. Europe Standard Time:20261119T100000', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'))
    expect(saved).not.toContain('W. Europe Standard Time')
    expect(saved).toContain('DTSTART;TZID=Europe/Berlin:20261117T100000')
    expect(saved).toContain('RDATE;TZID=Europe/Berlin:20261119T100000')
  })

  it('carries the definition of a quoted custom zone through file import and title editing', () => {
    const zone = '(UTC+01:00) Amsterdam, Berlin; custom'
    const definition = ['BEGIN:VTIMEZONE', `TZID:${zone}`, 'END:VTIMEZONE'].join('\r\n')
    const saved = imported(['BEGIN:VCALENDAR', definition, 'BEGIN:VEVENT', 'UID:custom', `DTSTART;TZID="${zone}":20261117T100000`, `DTEND;TZID="${zone}":20261117T110000`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'))
    expect(saved).toContain(definition)
    const edited = serializeCalendarEvent({ ...deserializeCalendarEvent(saved), title: 'New title' })
    expect(edited).toContain(`DTSTART;TZID="${zone}":20261117T100000`)
    expect(edited).toContain(definition)
  })
  it.each(['Custom/Absent', 'bad"zone', 'bad\u0001zone', 'bad\u007fzone'])('refuses %s while retaining valid siblings', (zone) => {
    const parsed = parseVCalendar(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:bad', `DTSTART;TZID=${zone}:20261117T100000`, 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:good', 'DTSTART:20261117T100000Z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'))
    expect(parsed).toHaveLength(2)
    expect(vEventToImportEvent(parsed[0]!, 'calendar')).toHaveProperty('importError')
    expect(vEventToImportEvent(parsed[1]!, 'calendar')).not.toHaveProperty('importError')
  })

  it('rejects an undefined zone appearing only on RDATE', () => {
    const [event] = parseVCalendar('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:bad-rdate\r\nDTSTART:20261117T100000Z\r\nRDATE;TZID=Custom/Absent:20261118T100000\r\nEND:VEVENT\r\nEND:VCALENDAR')
    expect(vEventToImportEvent(event!, 'calendar')).toHaveProperty('importError')
  })

})
