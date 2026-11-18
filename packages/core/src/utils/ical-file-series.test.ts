import { describe, expect, it } from 'vitest';
import { parseVCalendar } from './ical-parser.js';

const master = ['BEGIN:VEVENT', 'UID:series', 'DTSTART:20261117T100000Z', 'DTEND:20261117T110000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'STATUS:CONFIRMED', 'TRANSP:TRANSPARENT', 'END:VEVENT'];
const moved = ['BEGIN:VEVENT', 'UID:series', 'RECURRENCE-ID:20261118T100000Z', 'DTSTART:20261118T120000Z', 'DTEND:20261118T130000Z', 'X-KEPT:value', 'END:VEVENT'];
const cancelled = ['BEGIN:VEVENT', 'UID:series', 'RECURRENCE-ID:20261119T100000Z', 'DTSTART:20261119T100000Z', 'STATUS:CANCELLED', 'END:VEVENT'];
const calendar = (...blocks: string[][]) => ['BEGIN:VCALENDAR', ...blocks.flat(), 'END:VCALENDAR'].join('\r\n');

describe('file recurrence units', () => {
  it('groups overrides before or after their master and keeps raw override data', () => {
    const events = parseVCalendar(calendar(moved, master, cancelled));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ uid: 'series', status: 'CONFIRMED', transp: 'TRANSPARENT', overrides: [moved, cancelled] });
  });
  it('keeps orphan overrides as separate events', () => {
    const events = parseVCalendar(calendar(moved, cancelled));
    expect(events).toHaveLength(2);
    expect(events[0]?.unknownProperties).toContain('RECURRENCE-ID:20261118T100000Z');
    expect(events[1]?.status).toBe('CANCELLED');
  });
  it('rejects an entire unit with an undefined zone only in its override', () => {
    const bad = moved.map(line => line.replace('RECURRENCE-ID:', 'RECURRENCE-ID;TZID=Custom/Missing:'));
    const events = parseVCalendar(calendar(master, bad, master.map(line => line.replace('UID:series', 'UID:other'))));
    expect(events).toHaveLength(2);
    expect(events[0]?.importError).toBeTruthy();
    expect(events[1]?.importError).toBeUndefined();
  });
  it('normalizes every Windows reference across a whole series without definitions', () => {
    const windows = (block: string[]) => block.map(line => line.replace(/^(DTSTART|DTEND|RECURRENCE-ID):(.+)Z$/, '$1;TZID=W. Europe Standard Time:$2'));
    const [event] = parseVCalendar(calendar(windows(master), windows(moved)));
    expect(event?.overrides?.[0]).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20261118T100000');
    expect(event?.overrides?.[0]).toContain('DTSTART;TZID=Europe/Berlin:20261118T120000');
    expect(event?.dtstartParams?.TZID).toBe('Europe/Berlin');
  });
  it('does not cross-attach distinct UIDs or combine separate files with the same UID', () => {
    const other = (block: string[]) => block.map(line => line.replace('UID:series', 'UID:other'));
    const events = parseVCalendar(calendar(master, other(master), moved, other(cancelled)));
    expect(events.map(event => event.overrides)).toEqual([[moved], [other(cancelled)]]);
    expect([...parseVCalendar(calendar(master, moved)), ...parseVCalendar(calendar(master, cancelled))].map(event => event.overrides)).toEqual([[moved], [cancelled]]);
  });
  it.each([
    ['blank line', ['']],
    ['trailing alarm marker whitespace', ['BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM ']],
    ['stray property', ['BROKEN']],
    ['odd quote', ['X-ODD;LABEL="unfinished:value']],
  ])('keeps the existing lenient master import for a %s', (_label, extra) => {
    const source = [...master.slice(0, -1), ...extra, 'END:VEVENT '];
    const [event] = parseVCalendar(calendar(source));
    expect(event?.importError).toBeUndefined();
    expect(event?.dtstart).toBe('20261117T100000Z');
  });
  it('normalizes blank lines and component marker whitespace in retained overrides', () => {
    const source = [...moved.slice(0, -1), '', 'BEGIN:VALARM ', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM ', 'END:VEVENT '];
    const [event] = parseVCalendar(calendar(master, source));
    expect(event?.importError).toBeUndefined();
    expect(event?.overrides?.[0]).toContain('END:VALARM');
    expect(event?.overrides?.[0]).not.toContain('');
    expect(event?.overrides?.[0]?.at(-1)).toBe('END:VEVENT');
  });
  it('still refuses malformed retained override properties and undefined time zones', () => {
    for (const extra of ['BROKEN', 'RDATE;TZID=Unknown/Zone:20261119T100000']) {
      const [event] = parseVCalendar(calendar(master, [...moved.slice(0, -1), extra, 'END:VEVENT']));
      expect(event?.importError).toBeTruthy();
    }
  });
  it('reports each ambiguous duplicate master as a failed unit', () => {
    const events = parseVCalendar(calendar(master, master, moved));
    expect(events).toHaveLength(2);
    expect(events.every(event => event.importError)).toBe(true);
  });
});
