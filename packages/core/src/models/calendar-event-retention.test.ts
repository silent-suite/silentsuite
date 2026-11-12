// WEB-03: saving an event keeps VEVENT content the model does not edit.
import { describe, it, expect } from 'vitest';
import {
  deserializeCalendarEvent,
  serializeCalendarEvent,
  toVEvent,
  fromVEvent,
  expandEventRecurrence,
  splitRetainedRecurrenceDates,
} from './calendar-event.js';
import type { CalendarEvent } from './calendar-event.js';
import { generateVEvent, parseVEvent } from '../utils/ical-parser.js';

const CRLF = '\r\n';

/** One VCALENDAR item as another CalDAV client would store it. */
const RICH_ITEM = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Other Client//EN',
  'BEGIN:VEVENT',
  'UID:rich-001',
  'DTSTAMP:20260101T000000Z',
  'DTSTART;TZID=Europe/Vienna:20260706T100000',
  'DURATION:PT1H30M',
  'RRULE:FREQ=WEEKLY;COUNT=4',
  'SUMMARY:Planning',
  'CATEGORIES:Work',
  'STATUS:CONFIRMED',
  'TRANSP:TRANSPARENT',
  'CLASS:PRIVATE',
  'SEQUENCE:3',
  'URL:https://example.invalid/meeting',
  'ORGANIZER;CN=Org:mailto:org@example.invalid',
  'ATTENDEE;CN=Guest;PARTSTAT=ACCEPTED:mailto:guest@example.invalid',
  'X-EXAMPLE-PROP:keep-me',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'TRIGGER:-PT15M',
  'DESCRIPTION:Reminder',
  'END:VALARM',
  'BEGIN:X-EXAMPLE-COMPONENT',
  'SUMMARY:inner summary',
  'X-INNER:1',
  'END:X-EXAMPLE-COMPONENT',
  'END:VEVENT',
  'END:VCALENDAR',
].join(CRLF);

/** The edit the web store performs: deserialize, merge a patch, serialize. */
function edit(content: string, patch: Partial<CalendarEvent>): string {
  const event = deserializeCalendarEvent(content);
  return serializeCalendarEvent({ ...event, ...patch, updated: new Date('2026-07-01T00:00:00Z') });
}

const lines = (ics: string) => ics.split(CRLF);
const count = (ics: string, line: string) => lines(ics).filter((l) => l === line).length;

describe('a title-only edit keeps unsupported VEVENT content (WEB-03)', () => {
  const written = edit(RICH_ITEM, { title: 'Planning v2' });

  it.each([
    'DTSTAMP:20260101T000000Z',
    'CLASS:PRIVATE',
    'SEQUENCE:3',
    'URL:https://example.invalid/meeting',
    'ORGANIZER;CN=Org:mailto:org@example.invalid',
    'ATTENDEE;CN=Guest;PARTSTAT=ACCEPTED:mailto:guest@example.invalid',
    'X-EXAMPLE-PROP:keep-me',
    'STATUS:CONFIRMED',
    'TRANSP:TRANSPARENT',
  ])('keeps %s exactly once', (line) => {
    expect(count(written, line)).toBe(1);
  });

  it('keeps an unsupported subcomponent whole, after the alarm', () => {
    const out = lines(written);
    const begin = out.indexOf('BEGIN:X-EXAMPLE-COMPONENT');
    expect(out.slice(begin, begin + 4)).toEqual([
      'BEGIN:X-EXAMPLE-COMPONENT',
      'SUMMARY:inner summary',
      'X-INNER:1',
      'END:X-EXAMPLE-COMPONENT',
    ]);
    expect(out.indexOf('END:VALARM')).toBeLessThan(begin);
  });

  it('writes retained properties before any subcomponent', () => {
    const out = lines(written);
    expect(out.indexOf('X-EXAMPLE-PROP:keep-me')).toBeLessThan(out.indexOf('BEGIN:VALARM'));
  });

  it('writes the alarm once, from the model', () => {
    expect(count(written, 'BEGIN:VALARM')).toBe(1);
    expect(count(written, 'TRIGGER:-PT15M')).toBe(1);
  });

  it('control: modelled fields are written as before', () => {
    expect(written).toMatch(/^UID:rich-001$/m);
    expect(written).toMatch(/^SUMMARY:Planning v2$/m);
    expect(written).toMatch(/^DTSTART;TZID=Europe\/Vienna:20260706T100000$/m);
    expect(written).toMatch(/^RRULE:FREQ=WEEKLY;COUNT=4$/m);
    expect(written).toMatch(/^CATEGORIES:Work$/m);
  });

  it('does not read properties inside an unsupported subcomponent as event fields', () => {
    expect(deserializeCalendarEvent(RICH_ITEM).title).toBe('Planning');
  });

  it('does not change the source string', () => {
    const before = RICH_ITEM.slice();
    deserializeCalendarEvent(RICH_ITEM);
    expect(RICH_ITEM).toBe(before);
  });
});

describe('DURATION-only events (WEB-03)', () => {
  it('load with their real length', () => {
    const event = deserializeCalendarEvent(RICH_ITEM);
    expect(event.endDate.getTime() - event.startDate.getTime()).toBe(90 * 60 * 1000);
  });

  it('keep their DURATION, and no DTEND, on a title-only save', () => {
    const written = edit(RICH_ITEM, { title: 'Planning v2' });
    expect(count(written, 'DURATION:PT1H30M')).toBe(1);
    expect(written).not.toMatch(/^DTEND/m);
  });

  it('are written with DTEND once the length is edited', () => {
    const event = deserializeCalendarEvent(RICH_ITEM);
    const written = edit(RICH_ITEM, { endDate: new Date(event.startDate.getTime() + 2 * 3600_000) });
    expect(written).toMatch(/^DTEND;TZID=Europe\/Vienna:20260706T120000$/m);
    expect(written).not.toMatch(/^DURATION:/m);
  });

  it('an all-day event with DURATION:P2D spans two days', () => {
    const event = fromVEvent(
      ['BEGIN:VEVENT', 'UID:d', 'DTSTART;VALUE=DATE:20260706', 'DURATION:P2D', 'SUMMARY:Trip', 'END:VEVENT'].join(CRLF),
    );
    expect(event.allDay).toBe(true);
    expect(event.endDate).toEqual(new Date(2026, 6, 8));
  });

  it('control: an unreadable DURATION keeps the old zero-length result', () => {
    const event = fromVEvent(
      ['BEGIN:VEVENT', 'UID:d', 'DTSTART:20260706T100000Z', 'DURATION:-PT1H', 'SUMMARY:x', 'END:VEVENT'].join(CRLF),
    );
    expect(event.endDate.getTime()).toBe(event.startDate.getTime());
  });
});

describe('STATUS and TRANSP round trip through the event model (WEB-03)', () => {
  it('are kept when present', () => {
    const event = deserializeCalendarEvent(RICH_ITEM);
    expect(event.status).toBe('CONFIRMED');
    expect(event.transp).toBe('TRANSPARENT');
  });

  it('stay absent when the source has none', () => {
    const plain = ['BEGIN:VEVENT', 'UID:p', 'DTSTART:20260706T100000Z', 'DTEND:20260706T110000Z', 'SUMMARY:p', 'END:VEVENT'].join(CRLF);
    const event = fromVEvent(plain);
    expect(event.status).toBeUndefined();
    expect(event.transp).toBeUndefined();
    expect(toVEvent(event)).not.toMatch(/^(STATUS|TRANSP):/m);
  });
});

describe('events without unsupported content serialize as before (WEB-03)', () => {
  it('adds no lines to a plain event', () => {
    const plain = [
      'BEGIN:VEVENT',
      'UID:p',
      'DTSTART:20260706T100000Z',
      'DTEND:20260706T110000Z',
      'SUMMARY:p',
      'CREATED:20260101T000000Z',
      'LAST-MODIFIED:20260101T000000Z',
      'END:VEVENT',
    ].join(CRLF);
    const event = fromVEvent(plain);
    expect(event.unknownProperties).toBeUndefined();
    expect(event.unknownComponents).toBeUndefined();
    expect(toVEvent(event)).toBe(plain);
  });
});

describe('parseVEvent finds the first VEVENT by whole logical lines (WEB-03)', () => {
  it('a value containing END:VEVENT does not cut the event short', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:m',
      'DTSTART:20260706T100000Z',
      'DESCRIPTION:text END:VEVENT more',
      'SUMMARY:after the marker',
      'X-AFTER:1',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join(CRLF);
    const event = parseVEvent(ics);
    expect(event.description).toBe('text END:VEVENT more');
    expect(event.summary).toBe('after the marker');
    expect(event.unknownProperties).toEqual(['X-AFTER:1']);
  });

  it('finds a lowercase or folded VCALENDAR wrapper', () => {
    const ics = ['begin:vcal', ' endar', 'BEGIN:VEVENT', 'UID:l', 'DTSTART:20260706T100000Z', 'SUMMARY:l', 'END:VEVENT', 'end:vcalendar'].join(CRLF);
    expect(parseVEvent(ics).uid).toBe('l');
  });
});

describe('retained VEVENT lines are checked again when writing (WEB-03)', () => {
  const base = { uid: 'g', dtstart: '20260706T100000Z', summary: 'g' };

  it('drops property lines with control characters, unsafe names or modelled names', () => {
    const out = generateVEvent({
      ...base,
      unknownProperties: ['X-OK:1', 'X-BAD:1\r\nSUMMARY:injected', 'BAD NAME:1', 'SUMMARY:modelled', 'BEGIN:VALARM', 'X-NOCOLON'],
    });
    expect(out).toMatch(/^X-OK:1$/m);
    expect(out).not.toMatch(/injected|BAD NAME|SUMMARY:modelled|X-NOCOLON/);
    expect(count(out, 'BEGIN:VALARM')).toBe(0);
  });

  it('drops broken, forbidden or alarm subcomponents', () => {
    const out = generateVEvent({
      ...base,
      unknownComponents: [
        ['BEGIN:X-OK', 'X-A:1', 'END:X-OK'],
        ['BEGIN:X-OPEN', 'X-B:1'],
        ['BEGIN:X-ONE', 'END:X-TWO'],
        ['BEGIN:VEVENT', 'UID:other', 'END:VEVENT'],
        ['BEGIN:VTIMEZONE', 'TZID:x', 'END:VTIMEZONE'],
        ['BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT5M', 'END:VALARM'],
      ],
    });
    expect(out).toMatch(/^BEGIN:X-OK$/m);
    expect(out).not.toMatch(/X-OPEN|X-ONE|UID:other|VTIMEZONE|BEGIN:VALARM/);
  });

  it('folds long retained lines at 75 octets', () => {
    const long = `X-NOTE:${'é'.repeat(60)}`;
    const out = generateVEvent({ ...base, unknownProperties: [long] });
    for (const physical of lines(out)) expect(Buffer.byteLength(physical, 'utf8')).toBeLessThanOrEqual(75);
    expect(parseVEvent(out).unknownProperties).toEqual([long]);
  });
});

describe('retained recurrence lines follow the written DTSTART form (WEB-03)', () => {
  const timed = [
    'BEGIN:VEVENT',
    'UID:r',
    'DTSTART:20260706T100000Z',
    'DTEND:20260706T110000Z',
    'SUMMARY:r',
    'RDATE:20260801T100000Z',
    'END:VEVENT',
  ].join(CRLF);

  it('keeps RDATE while the start keeps its value type', () => {
    expect(toVEvent(fromVEvent(timed))).toMatch(/^RDATE:20260801T100000Z$/m);
  });

  it('drops RDATE when the event becomes all-day', () => {
    const event = fromVEvent(timed);
    const out = toVEvent({ ...event, allDay: true, startDate: new Date(2026, 6, 6), endDate: new Date(2026, 6, 7) });
    expect(out).not.toMatch(/^RDATE/m);
  });

  it('drops RECURRENCE-ID whose value type no longer matches DTSTART', () => {
    const out = generateVEvent({
      uid: 'o',
      dtstart: '20260706',
      dtstartParams: { VALUE: 'DATE' },
      unknownProperties: ['RECURRENCE-ID:20260706T100000Z'],
    });
    expect(out).not.toMatch(/^RECURRENCE-ID/m);
  });
});

describe('nominal DURATION days and weeks keep the wall clock across DST (WEB-03 review)', () => {
  const single = (start: string, duration: string) =>
    ['BEGIN:VEVENT', 'UID:dst', `DTSTART;TZID=America/New_York:${start}`, `DURATION:${duration}`, 'SUMMARY:dst', 'END:VEVENT'].join(CRLF);

  it('P1D across the US spring change ends at the same wall clock (23 hours)', () => {
    const event = fromVEvent(single('20260307T100000', 'P1D'));
    expect(event.startDate.toISOString()).toBe('2026-03-07T15:00:00.000Z');
    expect(event.endDate.toISOString()).toBe('2026-03-08T14:00:00.000Z');
  });

  it('P1W across the US spring change ends at the same wall clock', () => {
    const event = fromVEvent(single('20260305T100000', 'P1W'));
    expect(event.endDate.toISOString()).toBe('2026-03-12T14:00:00.000Z');
  });

  it('P1DT2H adds the exact hours after the nominal day', () => {
    const event = fromVEvent(single('20260307T100000', 'P1DT2H'));
    expect(event.endDate.toISOString()).toBe('2026-03-08T16:00:00.000Z');
  });

  it('a title-only save of a DST-straddling P1D keeps the stored DURATION', () => {
    const written = edit(single('20260307T100000', 'P1D'), { title: 'renamed' });
    expect(count(written, 'DURATION:P1D')).toBe(1);
    expect(written).not.toMatch(/^DTEND/m);
  });

  it.each(['P1D', 'P1W'])('a recurring %s series straddling a later DST change keeps its DURATION on a title-only save', (duration) => {
    const series = [
      'BEGIN:VEVENT',
      'UID:dst-series',
      'DTSTART;TZID=America/New_York:20260226T100000',
      `DURATION:${duration}`,
      'RRULE:FREQ=WEEKLY;COUNT=4',
      'SUMMARY:series',
      'END:VEVENT',
    ].join(CRLF);
    const event = fromVEvent(series);
    // The first occurrence has no DST change inside it: an exact 1 or 7 days.
    expect(event.endDate.getTime() - event.startDate.getTime()).toBe((duration === 'P1W' ? 7 : 1) * 86_400_000);
    // The series still crosses the 8 March change, and each occurrence keeps 10:00 local.
    const starts = expandEventRecurrence(event, { start: new Date('2026-02-01T00:00:00Z'), end: new Date('2026-04-01T00:00:00Z') });
    expect(starts.map((d) => d.toISOString())).toEqual([
      '2026-02-26T15:00:00.000Z',
      '2026-03-05T15:00:00.000Z',
      '2026-03-12T14:00:00.000Z',
      '2026-03-19T14:00:00.000Z',
    ]);
    const written = edit(series, { title: 'renamed' });
    expect(count(written, `DURATION:${duration}`)).toBe(1);
    expect(written).not.toMatch(/^DTEND/m);
  });

  it('control: a UTC P1D is exactly 24 hours', () => {
    const event = fromVEvent(['BEGIN:VEVENT', 'UID:u', 'DTSTART:20260307T150000Z', 'DURATION:P1D', 'SUMMARY:u', 'END:VEVENT'].join(CRLF));
    expect(event.endDate.toISOString()).toBe('2026-03-08T15:00:00.000Z');
  });
});

describe('splitRetainedRecurrenceDates (WEB-03 review)', () => {
  const base = { allDay: false, timezone: 'Europe/Vienna' as string | undefined };

  it('splits RDATE values at the cutoff and keeps other lines before it', () => {
    const { before, from } = splitRetainedRecurrenceDates(
      { ...base, unknownProperties: ['X-A:1', 'RDATE;TZID=Europe/Vienna:20260701T100000,20260801T100000', 'RDATE:20260901T080000Z'] },
      new Date('2026-07-15T00:00:00Z'),
    );
    expect(before).toEqual(['X-A:1', 'RDATE;TZID=Europe/Vienna:20260701T100000']);
    expect(from).toEqual(['RDATE;TZID=Europe/Vienna:20260801T100000', 'RDATE:20260901T080000Z']);
  });

  it('counts a value exactly at the cutoff as later, and reads a zone-less value in the event zone', () => {
    const { before, from } = splitRetainedRecurrenceDates(
      { ...base, unknownProperties: ['RDATE:20260801T100000'] },
      new Date('2026-08-01T08:00:00Z'),
    );
    expect(before).toBeUndefined();
    expect(from).toEqual(['RDATE:20260801T100000']);
  });

  it('judges a PERIOD by its start', () => {
    const { from } = splitRetainedRecurrenceDates(
      { ...base, unknownProperties: ['RDATE;VALUE=PERIOD:20260801T080000Z/PT1H'] },
      new Date('2026-08-01T07:00:00Z'),
    );
    expect(from).toEqual(['RDATE;VALUE=PERIOD:20260801T080000Z/PT1H']);
  });
});
