import { describe, expect, it } from 'vitest';
import { deserializeCalendarEvent, serializeCalendarEvent, expandEventRecurrence } from './calendar-event.js';
import { parseVEvent } from '../utils/ical-parser.js';

describe('imported event time zones', () => {
  it('reads each EXDATE line in its own zone', () => {
    const event = deserializeCalendarEvent([
      'BEGIN:VEVENT', 'UID:exdate-zones', 'DTSTART;TZID=Europe/Berlin:20260315T100000', 'RRULE:FREQ=DAILY;COUNT=4',
      'EXDATE;TZID=Europe/Berlin:20260316T100000', 'EXDATE;TZID=America/New_York:20260317T050000', 'END:VEVENT',
    ].join('\r\n'));
    expect(event.exceptions.map(d => d.toISOString())).toEqual(['2026-03-16T09:00:00.000Z', '2026-03-17T09:00:00.000Z']);
    expect(expandEventRecurrence(event, { start: new Date('2026-03-15Z'), end: new Date('2026-03-19Z') }).map(d => d.toISOString())).toEqual([
      '2026-03-15T09:00:00.000Z', '2026-03-18T09:00:00.000Z',
    ]);
  });

  it.each([
    ['"America/New_York"', '2026-11-17T15:00:00.000Z'],
    ['W. Europe Standard Time', '2026-11-17T09:00:00.000Z'],
    ['Custom/Unrecognised', '2026-11-17T10:00:00.000Z'],
  ])('reads %s without using the browser zone', (zone, expected) => {
    const event = deserializeCalendarEvent(['BEGIN:VEVENT', 'UID:zone', `DTSTART;TZID=${zone}:20261117T100000`, `DTEND;TZID=${zone}:20261117T110000`, 'END:VEVENT'].join('\r\n'));
    expect(event.startDate.toISOString()).toBe(expected);
    expect(serializeCalendarEvent({ ...event, title: 'Edited' })).toContain('20261117T100000');
    expect(parseVEvent(serializeCalendarEvent(event)).dtstartParams?.TZID?.replace(/^"(.*)"$/, '$1')).toBe(zone.replace(/^"(.*)"$/, '$1'));
  });

  it('quotes a custom identifier when an existing event is saved', () => {
    const zone = '(UTC+01:00) Amsterdam, Berlin';
    const event = deserializeCalendarEvent(['BEGIN:VCALENDAR', 'BEGIN:VTIMEZONE', `TZID:${zone}`, 'END:VTIMEZONE', 'BEGIN:VEVENT', 'UID:custom', `DTSTART;TZID="${zone}":20261117T100000`, `DTEND;TZID="${zone}":20261117T110000`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
    const saved = serializeCalendarEvent({ ...event, title: 'Edited' });
    expect(saved).toContain(`DTSTART;TZID="${zone}":20261117T100000`);
    expect(saved).toContain(`TZID:${zone}`);
    expect(deserializeCalendarEvent(saved).startDate.toISOString()).toBe('2026-11-17T10:00:00.000Z');
  });

  it('expands a Windows zone across DST using the mapped zone', () => {
    const event = deserializeCalendarEvent('BEGIN:VEVENT\r\nUID:dst\r\nDTSTART;TZID=W. Europe Standard Time:20260328T100000\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEND:VEVENT');
    expect(expandEventRecurrence(event, { start: new Date('2026-03-28Z'), end: new Date('2026-03-31Z') }).map(d => d.toISOString())).toEqual([
      '2026-03-28T09:00:00.000Z', '2026-03-29T08:00:00.000Z', '2026-03-30T08:00:00.000Z',
    ]);
  });
});
