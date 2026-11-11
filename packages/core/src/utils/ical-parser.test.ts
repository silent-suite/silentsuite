import { describe, it, expect } from 'vitest';
import {
  parseVEvent,
  generateVEvent,
  parseVCalendar,
  generateVCalendar,
  parseVTodo,
  generateVTodo,
} from './ical-parser.js';
import type { VEvent, VAlarm, VTodo } from './ical-parser.js';

// ── Helpers ──

/** Strip \r so assertions work on both platforms */
function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

// ── parseVEvent / generateVEvent roundtrip ──

describe('parseVEvent', () => {
  it('parses a minimal VEVENT with UID and DTSTART', () => {
    const ical = [
      'BEGIN:VEVENT',
      'UID:abc-123',
      'DTSTART:20260315T100000',
      'END:VEVENT',
    ].join('\r\n');

    const event = parseVEvent(ical);
    expect(event.uid).toBe('abc-123');
    expect(event.dtstart).toBe('20260315T100000');
    expect(event.dtend).toBeUndefined();
    expect(event.summary).toBe('Untitled');
    expect(event.description).toBeUndefined();
    expect(event.location).toBeUndefined();
    expect(event.rrule).toBeUndefined();
    expect(event.exdate).toBeUndefined();
    expect(event.valarms).toBeUndefined();
  });

  it('parses all supported properties', () => {
    const ical = [
      'BEGIN:VEVENT',
      'UID:full-event-1',
      'DTSTART:20260315T100000',
      'DTEND:20260315T110000',
      'DURATION:PT1H',
      'SUMMARY:Team Standup',
      'DESCRIPTION:Daily morning meeting',
      'LOCATION:Conference Room A',
      'RRULE:FREQ=DAILY;COUNT=5',
      'EXDATE:20260316T100000,20260318T100000',
      'CREATED:20260301T080000',
      'LAST-MODIFIED:20260310T090000',
      'TRANSP:OPAQUE',
      'STATUS:CONFIRMED',
      'END:VEVENT',
    ].join('\r\n');

    const event = parseVEvent(ical);
    expect(event.uid).toBe('full-event-1');
    expect(event.dtstart).toBe('20260315T100000');
    expect(event.dtend).toBe('20260315T110000');
    expect(event.duration).toBe('PT1H');
    expect(event.summary).toBe('Team Standup');
    expect(event.description).toBe('Daily morning meeting');
    expect(event.location).toBe('Conference Room A');
    expect(event.rrule).toBe('FREQ=DAILY;COUNT=5');
    expect(event.exdate).toEqual(['20260316T100000', '20260318T100000']);
    expect(event.created).toBe('20260301T080000');
    expect(event.lastModified).toBe('20260310T090000');
    expect(event.transp).toBe('OPAQUE');
    expect(event.status).toBe('CONFIRMED');
  });

  it('handles LF-only line endings', () => {
    const ical = [
      'BEGIN:VEVENT',
      'UID:lf-only',
      'DTSTART:20260315T100000',
      'SUMMARY:LF Test',
      'END:VEVENT',
    ].join('\n');

    const event = parseVEvent(ical);
    expect(event.uid).toBe('lf-only');
    expect(event.summary).toBe('LF Test');
  });
});

// ── Escaping ──

describe('escaping', () => {
  it('unescapes commas in parsed text', () => {
    const ical = [
      'BEGIN:VEVENT',
      'UID:esc-1',
      'DTSTART:20260315T100000',
      'SUMMARY:Hello\\, World',
      'END:VEVENT',
    ].join('\r\n');

    const event = parseVEvent(ical);
    expect(event.summary).toBe('Hello, World');
  });

  it('unescapes semicolons in parsed text', () => {
    const ical = [
      'BEGIN:VEVENT',
      'UID:esc-2',
      'DTSTART:20260315T100000',
      'LOCATION:Room A\\; Floor 3',
      'END:VEVENT',
    ].join('\r\n');

    const event = parseVEvent(ical);
    expect(event.location).toBe('Room A; Floor 3');
  });

  it('unescapes backslashes in parsed text', () => {
    const ical = [
      'BEGIN:VEVENT',
      'UID:esc-3',
      'DTSTART:20260315T100000',
      'DESCRIPTION:path\\\\to\\\\file',
      'END:VEVENT',
    ].join('\r\n');

    const event = parseVEvent(ical);
    expect(event.description).toBe('path\\to\\file');
  });

  it('unescapes newlines in parsed text', () => {
    const ical = [
      'BEGIN:VEVENT',
      'UID:esc-4',
      'DTSTART:20260315T100000',
      'DESCRIPTION:Line 1\\nLine 2\\nLine 3',
      'END:VEVENT',
    ].join('\r\n');

    const event = parseVEvent(ical);
    expect(event.description).toBe('Line 1\nLine 2\nLine 3');
  });

  it('roundtrips text with commas, semicolons, backslashes, and newlines', () => {
    const original: VEvent = {
      uid: 'esc-roundtrip',
      dtstart: '20260315T100000',
      summary: 'Hello, World; Again',
      description: 'Line 1\nLine 2\nPath: C:\\Users\\test',
      location: 'Room A; Floor 3, Building 2',
    };

    const generated = generateVEvent(original);
    const parsed = parseVEvent(generated);

    expect(parsed.summary).toBe(original.summary);
    expect(parsed.description).toBe(original.description);
    expect(parsed.location).toBe(original.location);
  });
});

// ── Line folding ──

describe('line folding', () => {
  it('folds lines longer than 75 octets', () => {
    const longSummary = 'A'.repeat(200);
    const event: VEvent = {
      uid: 'fold-1',
      dtstart: '20260315T100000',
      summary: longSummary,
    };

    const generated = generateVEvent(event);
    const lines = generated.split('\r\n');

    // Each line (after unfolding) should not exceed 75 octets
    for (const line of lines) {
      // Continuation lines start with a space
      if (!line.startsWith(' ')) {
        expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
      } else {
        // continuation line + the leading space = at most 75 octets
        expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
      }
    }
  });

  it('roundtrips a long SUMMARY through fold/unfold', () => {
    const longSummary = 'ABCDEFGHIJ'.repeat(20); // 200 chars
    const event: VEvent = {
      uid: 'fold-roundtrip',
      dtstart: '20260315T100000',
      summary: longSummary,
    };

    const generated = generateVEvent(event);
    const parsed = parseVEvent(generated);
    expect(parsed.summary).toBe(longSummary);
  });

  it('does not fold lines that are exactly 75 octets', () => {
    // UID: has 4 chars, so we need 71 chars of value to reach 75 total
    const uid = 'A'.repeat(71);
    const event: VEvent = {
      uid,
      dtstart: '20260315T100000',
    };

    const generated = generateVEvent(event);
    const uidLine = generated.split('\r\n').find((l) => l.startsWith('UID:'));
    expect(uidLine).toBeDefined();
    expect(Buffer.byteLength(uidLine!, 'utf8')).toBe(75);
    // The next line should NOT be a continuation of UID
    const lines = generated.split('\r\n');
    const uidIdx = lines.indexOf(uidLine!);
    if (uidIdx + 1 < lines.length) {
      expect(lines[uidIdx + 1]!.startsWith(' ')).toBe(false);
    }
  });

  it('handles Unicode characters in folding correctly', () => {
    // Unicode chars take more than 1 byte
    const unicodeSummary = '\u{1F600}'.repeat(30); // each emoji is 4 bytes
    const event: VEvent = {
      uid: 'fold-unicode',
      dtstart: '20260315T100000',
      summary: unicodeSummary,
    };

    const generated = generateVEvent(event);
    const parsed = parseVEvent(generated);
    expect(parsed.summary).toBe(unicodeSummary);
  });
});

// ── DATE vs DATE-TIME ──

describe('DATE vs DATE-TIME values', () => {
  it('parses DATE-only values (8 digits)', () => {
    const ical = [
      'BEGIN:VEVENT',
      'UID:date-1',
      'DTSTART;VALUE=DATE:20260315',
      'DTEND;VALUE=DATE:20260316',
      'END:VEVENT',
    ].join('\r\n');

    const event = parseVEvent(ical);
    expect(event.dtstart).toBe('20260315');
    expect(event.dtend).toBe('20260316');
    expect(event.dtstartParams).toEqual({ VALUE: 'DATE' });
    expect(event.dtendParams).toEqual({ VALUE: 'DATE' });
  });

  it('parses DATE-TIME with Z suffix (UTC)', () => {
    const ical = [
      'BEGIN:VEVENT',
      'UID:datetime-z',
      'DTSTART:20260315T100000Z',
      'END:VEVENT',
    ].join('\r\n');

    const event = parseVEvent(ical);
    expect(event.dtstart).toBe('20260315T100000Z');
    expect(event.dtstartParams).toBeUndefined();
  });

  it('parses DATE-TIME with TZID parameter', () => {
    const ical = [
      'BEGIN:VEVENT',
      'UID:datetime-tz',
      'DTSTART;TZID=America/New_York:20260315T100000',
      'DTEND;TZID=America/New_York:20260315T110000',
      'END:VEVENT',
    ].join('\r\n');

    const event = parseVEvent(ical);
    expect(event.dtstart).toBe('20260315T100000');
    expect(event.dtstartParams).toEqual({ TZID: 'America/New_York' });
    expect(event.dtend).toBe('20260315T110000');
    expect(event.dtendParams).toEqual({ TZID: 'America/New_York' });
  });

  it('roundtrips DTSTART params through generate/parse', () => {
    const original: VEvent = {
      uid: 'tz-roundtrip',
      dtstart: '20260315T100000',
      dtend: '20260315T110000',
      dtstartParams: { TZID: 'Europe/London' },
      dtendParams: { TZID: 'Europe/London' },
    };

    const generated = generateVEvent(original);
    const parsed = parseVEvent(generated);

    expect(parsed.dtstartParams).toEqual({ TZID: 'Europe/London' });
    expect(parsed.dtendParams).toEqual({ TZID: 'Europe/London' });
    expect(parsed.dtstart).toBe('20260315T100000');
    expect(parsed.dtend).toBe('20260315T110000');
  });
});

// ── Multi-value properties: EXDATE ──

describe('EXDATE', () => {
  it('parses multiple comma-separated EXDATE values', () => {
    const ical = [
      'BEGIN:VEVENT',
      'UID:exdate-1',
      'DTSTART:20260315T100000',
      'EXDATE:20260316T100000,20260317T100000,20260318T100000',
      'END:VEVENT',
    ].join('\r\n');

    const event = parseVEvent(ical);
    expect(event.exdate).toEqual([
      '20260316T100000',
      '20260317T100000',
      '20260318T100000',
    ]);
  });

  it('accumulates EXDATE from multiple lines', () => {
    const ical = [
      'BEGIN:VEVENT',
      'UID:exdate-2',
      'DTSTART:20260315T100000',
      'EXDATE:20260316T100000',
      'EXDATE:20260318T100000',
      'END:VEVENT',
    ].join('\r\n');

    const event = parseVEvent(ical);
    expect(event.exdate).toEqual([
      '20260316T100000',
      '20260318T100000',
    ]);
  });

  it('roundtrips EXDATE through generate/parse', () => {
    const original: VEvent = {
      uid: 'exdate-rt',
      dtstart: '20260315T100000',
      exdate: ['20260316T100000', '20260318T100000'],
    };

    const generated = generateVEvent(original);
    const parsed = parseVEvent(generated);
    expect(parsed.exdate).toEqual(original.exdate);
  });
});

// ── VALARM parsing ──

describe('VALARM', () => {
  it('parses a single VALARM', () => {
    const ical = [
      'BEGIN:VEVENT',
      'UID:alarm-1',
      'DTSTART:20260315T100000',
      'SUMMARY:Meeting',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER:-PT15M',
      'DESCRIPTION:Reminder',
      'END:VALARM',
      'END:VEVENT',
    ].join('\r\n');

    const event = parseVEvent(ical);
    expect(event.valarms).toBeDefined();
    expect(event.valarms).toHaveLength(1);
    expect(event.valarms![0]!.action).toBe('DISPLAY');
    expect(event.valarms![0]!.trigger).toBe('-PT15M');
    expect(event.valarms![0]!.description).toBe('Reminder');
  });

  it('parses multiple VALARMs', () => {
    const ical = [
      'BEGIN:VEVENT',
      'UID:alarm-2',
      'DTSTART:20260315T100000',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER:-PT15M',
      'END:VALARM',
      'BEGIN:VALARM',
      'ACTION:EMAIL',
      'TRIGGER:-PT1H',
      'DESCRIPTION:Email reminder',
      'END:VALARM',
      'END:VEVENT',
    ].join('\r\n');

    const event = parseVEvent(ical);
    expect(event.valarms).toHaveLength(2);
    expect(event.valarms![0]!.action).toBe('DISPLAY');
    expect(event.valarms![0]!.trigger).toBe('-PT15M');
    expect(event.valarms![1]!.action).toBe('EMAIL');
    expect(event.valarms![1]!.trigger).toBe('-PT1H');
    expect(event.valarms![1]!.description).toBe('Email reminder');
  });

  it('roundtrips VALARMs through generate/parse', () => {
    const original: VEvent = {
      uid: 'alarm-rt',
      dtstart: '20260315T100000',
      summary: 'Meeting',
      valarms: [
        { action: 'DISPLAY', trigger: '-PT15M', description: 'Soon!' },
        { action: 'AUDIO', trigger: '-PT5M' },
      ],
    };

    const generated = generateVEvent(original);
    const parsed = parseVEvent(generated);

    expect(parsed.valarms).toHaveLength(2);
    expect(parsed.valarms![0]!.action).toBe('DISPLAY');
    expect(parsed.valarms![0]!.trigger).toBe('-PT15M');
    expect(parsed.valarms![0]!.description).toBe('Soon!');
    expect(parsed.valarms![1]!.action).toBe('AUDIO');
    expect(parsed.valarms![1]!.trigger).toBe('-PT5M');
    expect(parsed.valarms![1]!.description).toBeUndefined();
  });
});

// ── RRULE preservation ──

describe('RRULE preservation', () => {
  it('preserves RRULE through parse/generate roundtrip', () => {
    const rules = [
      'FREQ=DAILY;COUNT=10',
      'FREQ=WEEKLY;BYDAY=MO,WE,FR;INTERVAL=2',
      'FREQ=MONTHLY;BYMONTHDAY=15;UNTIL=20261231T235959Z',
      'FREQ=YEARLY;BYMONTH=3;BYDAY=2MO',
    ];

    for (const rule of rules) {
      const event: VEvent = {
        uid: `rrule-${rule}`,
        dtstart: '20260315T100000',
        rrule: rule,
      };

      const generated = generateVEvent(event);
      const parsed = parseVEvent(generated);
      expect(parsed.rrule).toBe(rule);
    }
  });
});

// ── Edge cases ──

describe('edge cases', () => {
  it('handles empty description', () => {
    const ical = [
      'BEGIN:VEVENT',
      'UID:edge-1',
      'DTSTART:20260315T100000',
      'DESCRIPTION:',
      'END:VEVENT',
    ].join('\r\n');

    const event = parseVEvent(ical);
    expect(event.description).toBe('');
  });

  it('handles missing optional fields gracefully', () => {
    const event: VEvent = {
      uid: 'minimal',
      dtstart: '20260315T100000',
    };

    const generated = generateVEvent(event);
    const parsed = parseVEvent(generated);

    expect(parsed.uid).toBe('minimal');
    expect(parsed.dtstart).toBe('20260315T100000');
    expect(parsed.dtend).toBeUndefined();
    expect(parsed.summary).toBe('Untitled');
    expect(parsed.description).toBeUndefined();
    expect(parsed.location).toBeUndefined();
    expect(parsed.rrule).toBeUndefined();
  });

  it('handles Unicode in SUMMARY', () => {
    const unicodeTitle = 'Rendez-vous \u00e0 caf\u00e9 \u2615 \u{1F1EB}\u{1F1F7}';
    const event: VEvent = {
      uid: 'unicode-1',
      dtstart: '20260315T100000',
      summary: unicodeTitle,
    };

    const generated = generateVEvent(event);
    const parsed = parseVEvent(generated);
    expect(parsed.summary).toBe(unicodeTitle);
  });

  it('handles SUMMARY with only spaces', () => {
    const event: VEvent = {
      uid: 'spaces-1',
      dtstart: '20260315T100000',
      summary: '   ',
    };

    const generated = generateVEvent(event);
    const parsed = parseVEvent(generated);
    expect(parsed.summary).toBe('   ');
  });
});

// ── generateVEvent ──

describe('generateVEvent', () => {
  it('generates valid VEVENT structure with BEGIN/END', () => {
    const event: VEvent = {
      uid: 'gen-1',
      dtstart: '20260315T100000',
      dtend: '20260315T110000',
      summary: 'Test Event',
    };

    const output = normalizeLineEndings(generateVEvent(event));
    expect(output).toContain('BEGIN:VEVENT');
    expect(output).toContain('END:VEVENT');
    expect(output.startsWith('BEGIN:VEVENT')).toBe(true);
    expect(output.endsWith('END:VEVENT')).toBe(true);
  });

  it('uses CRLF line endings', () => {
    const event: VEvent = {
      uid: 'gen-crlf',
      dtstart: '20260315T100000',
    };

    const output = generateVEvent(event);
    // All line breaks should be \r\n
    const crlfCount = (output.match(/\r\n/g) ?? []).length;
    const lfOnlyCount = (output.match(/(?<!\r)\n/g) ?? []).length;
    expect(crlfCount).toBeGreaterThan(0);
    expect(lfOnlyCount).toBe(0);
  });

  it('generates DATE params for all-day events', () => {
    const event: VEvent = {
      uid: 'allday-gen',
      dtstart: '20260315',
      dtend: '20260316',
      dtstartParams: { VALUE: 'DATE' },
      dtendParams: { VALUE: 'DATE' },
    };

    const output = normalizeLineEndings(generateVEvent(event));
    expect(output).toContain('DTSTART;VALUE=DATE:20260315');
    expect(output).toContain('DTEND;VALUE=DATE:20260316');
  });

  it('omits undefined optional properties', () => {
    const event: VEvent = {
      uid: 'sparse',
      dtstart: '20260315T100000',
    };

    const output = normalizeLineEndings(generateVEvent(event));
    expect(output).not.toContain('DTEND');
    expect(output).not.toContain('SUMMARY');
    expect(output).not.toContain('DESCRIPTION');
    expect(output).not.toContain('LOCATION');
    expect(output).not.toContain('RRULE');
    expect(output).not.toContain('EXDATE');
    expect(output).not.toContain('CREATED');
    expect(output).not.toContain('LAST-MODIFIED');
    expect(output).not.toContain('TRANSP');
    expect(output).not.toContain('STATUS');
  });
});

// ── Full roundtrip ──

describe('full VEvent roundtrip', () => {
  it('roundtrips a fully-populated event', () => {
    const original: VEvent = {
      uid: 'roundtrip-full',
      dtstart: '20260315T100000',
      dtend: '20260315T113000',
      summary: 'Sprint Review, Q1',
      description: 'Review Q1 goals\nDiscuss blockers',
      location: 'Building 5; Room 301',
      rrule: 'FREQ=WEEKLY;BYDAY=FR;COUNT=12',
      exdate: ['20260322T100000', '20260405T100000'],
      created: '20260101T000000',
      lastModified: '20260310T120000',
      transp: 'OPAQUE',
      status: 'CONFIRMED',
      valarms: [
        { action: 'DISPLAY', trigger: '-PT10M', description: 'Starting soon' },
      ],
    };

    const generated = generateVEvent(original);
    const parsed = parseVEvent(generated);

    expect(parsed.uid).toBe(original.uid);
    expect(parsed.dtstart).toBe(original.dtstart);
    expect(parsed.dtend).toBe(original.dtend);
    expect(parsed.summary).toBe(original.summary);
    expect(parsed.description).toBe(original.description);
    expect(parsed.location).toBe(original.location);
    expect(parsed.rrule).toBe(original.rrule);
    expect(parsed.exdate).toEqual(original.exdate);
    expect(parsed.created).toBe(original.created);
    expect(parsed.lastModified).toBe(original.lastModified);
    expect(parsed.transp).toBe(original.transp);
    expect(parsed.status).toBe(original.status);
    expect(parsed.valarms).toHaveLength(1);
    expect(parsed.valarms![0]!.description).toBe('Starting soon');
  });
});

// ── parseVCalendar / generateVCalendar ──

describe('parseVCalendar', () => {
  it('parses a VCALENDAR with a single event', () => {
    const ical = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//EN',
      'BEGIN:VEVENT',
      'UID:vcal-1',
      'DTSTART:20260315T100000',
      'SUMMARY:Single Event',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const events = parseVCalendar(ical);
    expect(events).toHaveLength(1);
    expect(events[0]!.uid).toBe('vcal-1');
    expect(events[0]!.summary).toBe('Single Event');
  });

  it('parses a VCALENDAR with multiple events', () => {
    const ical = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//EN',
      'BEGIN:VEVENT',
      'UID:vcal-2a',
      'DTSTART:20260315T100000',
      'SUMMARY:Event A',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:vcal-2b',
      'DTSTART:20260316T140000',
      'SUMMARY:Event B',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:vcal-2c',
      'DTSTART:20260317T090000',
      'SUMMARY:Event C',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const events = parseVCalendar(ical);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.uid)).toEqual(['vcal-2a', 'vcal-2b', 'vcal-2c']);
    expect(events.map((e) => e.summary)).toEqual(['Event A', 'Event B', 'Event C']);
  });

  it('handles empty VCALENDAR (no events)', () => {
    const ical = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//EN',
      'END:VCALENDAR',
    ].join('\r\n');

    const events = parseVCalendar(ical);
    expect(events).toHaveLength(0);
  });
});

describe('generateVCalendar', () => {
  it('generates a complete VCALENDAR document', () => {
    const events: VEvent[] = [
      { uid: 'gencal-1', dtstart: '20260315T100000', summary: 'Event 1' },
      { uid: 'gencal-2', dtstart: '20260316T140000', summary: 'Event 2' },
    ];

    const output = normalizeLineEndings(generateVCalendar(events));
    expect(output).toContain('BEGIN:VCALENDAR');
    expect(output).toContain('VERSION:2.0');
    expect(output).toContain('PRODID:-//SilentSuite//EN');
    expect(output).toContain('BEGIN:VEVENT');
    expect(output).toContain('END:VEVENT');
    expect(output).toContain('END:VCALENDAR');
  });

  it('generates empty calendar for no events', () => {
    const output = normalizeLineEndings(generateVCalendar([]));
    expect(output).toContain('BEGIN:VCALENDAR');
    expect(output).toContain('END:VCALENDAR');
    expect(output).not.toContain('BEGIN:VEVENT');
  });
});

describe('VCALENDAR roundtrip', () => {
  it('roundtrips multiple events through generate/parse', () => {
    const events: VEvent[] = [
      {
        uid: 'rt-cal-1',
        dtstart: '20260315T100000',
        dtend: '20260315T110000',
        summary: 'Morning Meeting',
      },
      {
        uid: 'rt-cal-2',
        dtstart: '20260316T140000',
        dtend: '20260316T150000',
        summary: 'Afternoon Review, Q1',
        description: 'Line 1\nLine 2',
      },
    ];

    const generated = generateVCalendar(events);
    const parsed = parseVCalendar(generated);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.uid).toBe('rt-cal-1');
    expect(parsed[0]!.summary).toBe('Morning Meeting');
    expect(parsed[1]!.uid).toBe('rt-cal-2');
    expect(parsed[1]!.summary).toBe('Afternoon Review, Q1');
    expect(parsed[1]!.description).toBe('Line 1\nLine 2');
  });
});

// ── Property parsing edge cases ──

describe('property parsing', () => {
  it('handles quoted parameter values with colons', () => {
    // TZID with a value containing special chars, colon in value
    const ical = [
      'BEGIN:VEVENT',
      'UID:param-1',
      'DTSTART;TZID="America/New_York":20260315T100000',
      'END:VEVENT',
    ].join('\r\n');

    const event = parseVEvent(ical);
    expect(event.dtstart).toBe('20260315T100000');
    // The TZID value includes the quotes since the parser doesn't strip them
    expect(event.dtstartParams).toBeDefined();
  });
});

// ── CATEGORIES (#291) ──

describe('CATEGORIES (VEvent)', () => {
  it('parses a single CATEGORIES value', () => {
    const ical = [
      'BEGIN:VEVENT',
      'UID:cat-1',
      'DTSTART:20260315T100000',
      'CATEGORIES:Work',
      'END:VEVENT',
    ].join('\r\n');

    const event = parseVEvent(ical);
    expect(event.categories).toEqual(['Work']);
  });

  it('parses multiple comma-separated CATEGORIES', () => {
    const ical = [
      'BEGIN:VEVENT',
      'UID:cat-2',
      'DTSTART:20260315T100000',
      'CATEGORIES:Work,Personal,Travel',
      'END:VEVENT',
    ].join('\r\n');

    const event = parseVEvent(ical);
    expect(event.categories).toEqual(['Work', 'Personal', 'Travel']);
  });

  it('unescapes commas within a single category value', () => {
    const ical = [
      'BEGIN:VEVENT',
      'UID:cat-3',
      'DTSTART:20260315T100000',
      'CATEGORIES:Travel\\, Inc.,Personal',
      'END:VEVENT',
    ].join('\r\n');

    const event = parseVEvent(ical);
    expect(event.categories).toEqual(['Travel, Inc.', 'Personal']);
  });

  it('emits CATEGORIES joined by commas with each value escaped', () => {
    const event: VEvent = {
      uid: 'cat-gen',
      dtstart: '20260315T100000',
      categories: ['Work', 'Travel, Inc.'],
    };

    const generated = generateVEvent(event);
    expect(generated).toContain('CATEGORIES:Work,Travel\\, Inc.');
  });

  it('roundtrips CATEGORIES through generate/parse', () => {
    const original: VEvent = {
      uid: 'cat-rt',
      dtstart: '20260315T100000',
      categories: ['Work', 'Personal', 'Side, Project'],
    };

    const generated = generateVEvent(original);
    const parsed = parseVEvent(generated);
    expect(parsed.categories).toEqual(original.categories);
  });

  it('defaults categories to undefined when CATEGORIES is absent', () => {
    const ical = [
      'BEGIN:VEVENT',
      'UID:cat-none',
      'DTSTART:20260315T100000',
      'END:VEVENT',
    ].join('\r\n');

    const event = parseVEvent(ical);
    expect(event.categories).toBeUndefined();
  });

  it('omits CATEGORIES line when categories is empty or undefined', () => {
    const without: VEvent = { uid: 'cat-omit', dtstart: '20260315T100000' };
    expect(generateVEvent(without)).not.toContain('CATEGORIES');

    const empty: VEvent = { uid: 'cat-omit2', dtstart: '20260315T100000', categories: [] };
    expect(generateVEvent(empty)).not.toContain('CATEGORIES');
  });
});

describe('CATEGORIES (VTodo)', () => {
  it('parses multiple comma-separated CATEGORIES from a VTODO', () => {
    const ical = [
      'BEGIN:VTODO',
      'UID:todo-cat-1',
      'SUMMARY:Task with labels',
      'CATEGORIES:Work,Urgent',
      'END:VTODO',
    ].join('\r\n');

    const todo = parseVTodo(ical);
    expect(todo.categories).toEqual(['Work', 'Urgent']);
  });

  it('unescapes commas within a single VTODO category value', () => {
    const ical = [
      'BEGIN:VTODO',
      'UID:todo-cat-2',
      'SUMMARY:Escaped',
      'CATEGORIES:Side\\, Project,Personal',
      'END:VTODO',
    ].join('\r\n');

    const todo = parseVTodo(ical);
    expect(todo.categories).toEqual(['Side, Project', 'Personal']);
  });

  it('emits CATEGORIES in a generated VTODO', () => {
    const todo: VTodo = {
      uid: 'todo-cat-gen',
      summary: 'Labelled task',
      categories: ['Work', 'Home'],
    };

    const generated = generateVTodo(todo);
    expect(generated).toContain('CATEGORIES:Work,Home');
  });

  it('roundtrips CATEGORIES through VTODO generate/parse', () => {
    const original: VTodo = {
      uid: 'todo-cat-rt',
      summary: 'Roundtrip',
      categories: ['Errands', 'Weekend, Fun'],
    };

    const generated = generateVTodo(original);
    const parsed = parseVTodo(generated);
    expect(parsed.categories).toEqual(original.categories);
  });

  it('defaults categories to undefined when VTODO lacks CATEGORIES', () => {
    const ical = [
      'BEGIN:VTODO',
      'UID:todo-cat-none',
      'SUMMARY:No labels',
      'END:VTODO',
    ].join('\r\n');

    const todo = parseVTodo(ical);
    expect(todo.categories).toBeUndefined();
  });

  it('omits CATEGORIES line when VTODO categories is empty or undefined', () => {
    const without: VTodo = { uid: 'todo-cat-omit', summary: 'x' };
    expect(generateVTodo(without)).not.toContain('CATEGORIES');

    const empty: VTodo = { uid: 'todo-cat-omit2', summary: 'x', categories: [] };
    expect(generateVTodo(empty)).not.toContain('CATEGORIES');
  });
});

// ── VTODO nested components (WEBX-02) ──
// Properties inside a subcomponent (VALARM or any other nested block) belong to
// that subcomponent, never to the task. These tests only cover which values the
// parser assigns to the VTODO; they make no claim that subcomponents are kept.

describe('parseVTodo nested components (WEBX-02)', () => {
  const emailAlarm = [
    'BEGIN:VALARM',
    'ACTION:EMAIL',
    'UID:alarm-uid-1',
    'SUMMARY:Alarm subject',
    'DESCRIPTION:Reminder body',
    'ATTENDEE:mailto:someone@example.com',
    'TRIGGER:-PT15M',
    'END:VALARM',
  ];

  it('keeps parent UID, SUMMARY and DESCRIPTION when a bare VTODO has a conflicting VALARM', () => {
    const ical = [
      'BEGIN:VTODO',
      'UID:task-1',
      'SUMMARY:Pay rent',
      'DESCRIPTION:Real description',
      ...emailAlarm,
      'END:VTODO',
    ].join('\r\n');

    const todo = parseVTodo(ical);
    expect(todo.uid).toBe('task-1');
    expect(todo.summary).toBe('Pay rent');
    expect(todo.description).toBe('Real description');
  });

  it('keeps parent UID, SUMMARY and DESCRIPTION inside a full VCALENDAR with a conflicting VALARM', () => {
    const ical = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Example//Other Client//EN',
      'BEGIN:VTODO',
      'UID:task-1',
      'SUMMARY:Pay rent',
      'DESCRIPTION:Real description',
      ...emailAlarm,
      'END:VTODO',
      'END:VCALENDAR',
    ].join('\r\n');

    const todo = parseVTodo(ical);
    expect(todo.uid).toBe('task-1');
    expect(todo.summary).toBe('Pay rent');
    expect(todo.description).toBe('Real description');
  });

  it('ignores properties in multiple and nested subcomponents and resumes top-level parsing after them', () => {
    const ical = [
      'BEGIN:VTODO',
      'UID:task-2',
      'SUMMARY:Parent summary',
      'DESCRIPTION:Parent description',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:First alarm',
      'BEGIN:X-INNER',
      'SUMMARY:Inner summary',
      'CATEGORIES:InnerOnly',
      'END:X-INNER',
      // Still inside the first VALARM after the inner block ends.
      'UID:alarm-after-inner',
      'URL:https://alarm.example.com',
      'TRIGGER:-PT5M',
      'END:VALARM',
      'BEGIN:VALARM',
      'ACTION:EMAIL',
      'SUMMARY:Second alarm subject',
      'DESCRIPTION:Second alarm body',
      'PRIORITY:9',
      'TRIGGER:-P1D',
      'END:VALARM',
      // Top-level VTODO properties after the subcomponents must still be read.
      'LOCATION:Office',
      'PRIORITY:1',
      'STATUS:IN-PROCESS',
      'END:VTODO',
    ].join('\r\n');

    const todo = parseVTodo(ical);
    expect(todo.uid).toBe('task-2');
    expect(todo.summary).toBe('Parent summary');
    expect(todo.description).toBe('Parent description');
    expect(todo.url).toBeUndefined();
    expect(todo.categories).toBeUndefined();
    expect(todo.location).toBe('Office');
    expect(todo.priority).toBe(1);
    expect(todo.status).toBe('IN-PROCESS');
  });

  it('control: a bare VTODO without subcomponents parses as before', () => {
    const ical = [
      'BEGIN:VTODO',
      'UID:task-3',
      'SUMMARY:Plain task',
      'DESCRIPTION:Plain description',
      'LOCATION:Home',
      'PRIORITY:5',
      'STATUS:NEEDS-ACTION',
      'END:VTODO',
    ].join('\r\n');

    const todo = parseVTodo(ical);
    expect(todo.uid).toBe('task-3');
    expect(todo.summary).toBe('Plain task');
    expect(todo.description).toBe('Plain description');
    expect(todo.location).toBe('Home');
    expect(todo.priority).toBe(5);
    expect(todo.status).toBe('NEEDS-ACTION');
  });

  it('control: a VCALENDAR wrapper still yields its first VTODO and ignores components outside it', () => {
    const ical = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VTIMEZONE',
      'TZID:Europe/Berlin',
      'BEGIN:STANDARD',
      'DTSTART:19701025T030000',
      'TZOFFSETFROM:+0200',
      'TZOFFSETTO:+0100',
      'END:STANDARD',
      'END:VTIMEZONE',
      'BEGIN:VTODO',
      'UID:task-4',
      'SUMMARY:Wrapped task',
      'DUE;TZID=Europe/Berlin:20261110T090000',
      'END:VTODO',
      'BEGIN:VTODO',
      'UID:task-5',
      'SUMMARY:Second task',
      'END:VTODO',
      'END:VCALENDAR',
    ].join('\r\n');

    const todo = parseVTodo(ical);
    expect(todo.uid).toBe('task-4');
    expect(todo.summary).toBe('Wrapped task');
    expect(todo.due).toBe('20261110T090000');
    expect(todo.dueParams).toEqual({ TZID: 'Europe/Berlin' });
  });
});

// ── VTODO nested components: final regression edges (WEBX-02) ──
// Malformed-input policy only: nested content is skipped while a nested block is
// open. These tests do not require component-name validation (for example, that
// an END matches the BEGIN it closes). Outer VTODO markers stay uppercase here
// because their handling is unchanged by WEBX-02.

describe('parseVTodo nested component edges (WEBX-02)', () => {
  it('treats mixed-case nested BEGIN/END markers as a subcomponent and resumes top-level parsing', () => {
    const ical = [
      'BEGIN:VTODO',
      'UID:task-ci',
      'SUMMARY:Parent summary',
      'begin:valarm',
      'ACTION:DISPLAY',
      'UID:alarm-uid-ci',
      'SUMMARY:Alarm subject',
      'TRIGGER:-PT15M',
      'End:VAlarm',
      'LOCATION:Office',
      'END:VTODO',
    ].join('\r\n');

    const todo = parseVTodo(ical);
    expect(todo.uid).toBe('task-ci');
    expect(todo.summary).toBe('Parent summary');
    expect(todo.location).toBe('Office');
  });

  it('keeps parent values before an unclosed nested block and ignores the values inside it', () => {
    const ical = [
      'BEGIN:VTODO',
      'UID:task-unclosed',
      'SUMMARY:Parent summary',
      'DESCRIPTION:Parent description',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'UID:alarm-uid-unclosed',
      'SUMMARY:Alarm subject',
      'DESCRIPTION:Alarm description',
      'LOCATION:Alarm location',
      'END:VTODO',
    ].join('\r\n');

    const todo = parseVTodo(ical);
    expect(todo.uid).toBe('task-unclosed');
    expect(todo.summary).toBe('Parent summary');
    expect(todo.description).toBe('Parent description');
    expect(todo.location).toBeUndefined();
  });

  it('uses the existing UID and summary fallbacks when those properties exist only inside a nested block', () => {
    const ical = [
      'BEGIN:VTODO',
      'DESCRIPTION:Parent only',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'UID:alarm-only-uid',
      'SUMMARY:Alarm-only summary',
      'TRIGGER:-PT15M',
      'END:VALARM',
      'END:VTODO',
    ].join('\r\n');

    const todo = parseVTodo(ical);
    // Existing fallbacks: a generated crypto.randomUUID() and 'Untitled'.
    expect(todo.uid).not.toBe('alarm-only-uid');
    expect(todo.uid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(todo.summary).toBe('Untitled');
    expect(todo.description).toBe('Parent only');
  });
});

// ── VTODO unsupported content retention (WEBX-03) ──
// Parse then generate must keep unsupported VTODO property lines and whole
// nested components. Modelled fields stay authoritative. In each test the
// isolation/compatibility checks run first and the retention check runs last,
// so a failure on unchanged code is the missing retained content.

describe('generateVTodo(parseVTodo()) retains unsupported VTODO content (WEBX-03)', () => {
  const logical = (text: string): string[] => text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const count = (lines: string[], line: string): number => lines.filter((l) => l === line).length;

  it('retains unsupported properties and whole nested components, properties before components', () => {
    const alarmBlock = [
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'UID:alarm-r1',
      'DESCRIPTION:Reminder',
      'TRIGGER:-PT15M',
      'BEGIN:X-INNER',
      'X-INNER-PROP:1',
      'END:X-INNER',
      'END:VALARM',
    ];
    const retainedProps = [
      'DTSTAMP:20261101T090000Z',
      'RRULE:FREQ=WEEKLY;BYDAY=MO',
      'RELATED-TO;RELTYPE=PARENT:parent-uid-1',
      'CLASS:PRIVATE',
      'X-EXAMPLE-FLAG;X-PARAM="a:b":value',
      'SEQUENCE:2',
    ];
    const ical = [
      'BEGIN:VTODO',
      'UID:task-r1',
      'SUMMARY:Parent',
      // Anchor for RRULE and the start-relative alarm (2026-11-02 is a Monday).
      'DTSTART:20261102T090000Z',
      ...retainedProps.slice(0, 5),
      ...alarmBlock,
      // A property after a component is still a VTODO property.
      retainedProps[5]!,
      'END:VTODO',
    ].join('\r\n');

    const todo = parseVTodo(ical);
    const out = logical(generateVTodo(todo));

    expect(todo.uid).toBe('task-r1');
    expect(todo.summary).toBe('Parent');
    expect(out[0]).toBe('BEGIN:VTODO');
    expect(out[out.length - 1]).toBe('END:VTODO');
    expect(count(out, 'UID:task-r1')).toBe(1);
    expect(count(out, 'SUMMARY:Parent')).toBe(1);
    expect(out.filter((l) => l.startsWith('UID:'))).toEqual(
      out.includes('UID:alarm-r1') ? ['UID:task-r1', 'UID:alarm-r1'] : ['UID:task-r1'],
    );

    for (const line of retainedProps) expect(count(out, line)).toBe(1);
    const blockStart = out.indexOf('BEGIN:VALARM');
    expect(out.slice(blockStart, blockStart + alarmBlock.length)).toEqual(alarmBlock);
    expect(out.indexOf('SUMMARY:Parent')).toBeLessThan(out.indexOf(retainedProps[0]!));
    for (let i = 1; i < retainedProps.length; i++) {
      expect(out.indexOf(retainedProps[i - 1]!)).toBeLessThan(out.indexOf(retainedProps[i]!));
    }
    expect(out.indexOf('SEQUENCE:2')).toBeLessThan(blockStart);
  });

  it('refolds a long retained line at 75 octets and it unfolds to the same logical line', () => {
    const longLine = `X-EXAMPLE-NOTE:${'abcdefghij'.repeat(12)}`;
    const ical = [
      'BEGIN:VTODO',
      'UID:task-r2',
      'SUMMARY:Fold',
      `${longLine.slice(0, 75)}\r\n ${longLine.slice(75)}`,
      'END:VTODO',
    ].join('\r\n');

    const generated = generateVTodo(parseVTodo(ical));
    const encoder = new TextEncoder();
    for (const physical of generated.split('\r\n')) {
      expect(encoder.encode(physical).length).toBeLessThanOrEqual(75);
    }

    expect(logical(generated)).toContain(longLine);
  });

  it('drops malformed or misplaced nested content and unsafe lines, keeping well-formed siblings', () => {
    const goodAlarm = ['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Kept', 'TRIGGER:-PT5M', 'END:VALARM'];
    const ical = [
      'BEGIN:VTODO',
      'UID:task-r3',
      'SUMMARY:Malformed',
      // Anchor for the start-relative alarm that should be kept.
      'DTSTART:20261102T090000Z',
      // END name does not match its BEGIN: the whole block is not retained.
      'BEGIN:VALARM',
      'X-MISMATCH-PROP:1',
      'END:X-OTHER',
      // A top-level component type cannot be a VTODO subcomponent.
      'BEGIN:VEVENT',
      'UID:event-inside-todo',
      'END:VEVENT',
      'X-NOCOLON',
      'X BAD:1',
      'X-GOOD:1',
      ...goodAlarm,
      // Never closed before END:VTODO.
      'BEGIN:X-OPEN',
      'X-OPEN-PROP:1',
      'END:VTODO',
    ].join('\r\n');

    const todo = parseVTodo(ical);
    const out = logical(generateVTodo(todo));

    expect(todo.uid).toBe('task-r3');
    expect(out.filter((l) => l.startsWith('UID:'))).toEqual(['UID:task-r3']);
    for (const absent of [
      'X-MISMATCH-PROP:1',
      'END:X-OTHER',
      'BEGIN:VEVENT',
      'END:VEVENT',
      'X-NOCOLON',
      'X BAD:1',
      'BEGIN:X-OPEN',
      'X-OPEN-PROP:1',
    ]) {
      expect(out).not.toContain(absent);
    }
    expect(out.filter((l) => /^BEGIN:/i.test(l))).toEqual(
      out.includes('BEGIN:VALARM') ? ['BEGIN:VTODO', 'BEGIN:VALARM'] : ['BEGIN:VTODO'],
    );

    expect(count(out, 'X-GOOD:1')).toBe(1);
    const blockStart = out.indexOf('BEGIN:VALARM');
    expect(out.slice(blockStart, blockStart + goodAlarm.length)).toEqual(goodAlarm);
  });

  it('retains only the first VTODO content from a VCALENDAR, not wrapper or sibling components', () => {
    const ical = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Example//Other Client//EN',
      'X-WR-CALNAME:Example list',
      'BEGIN:VTIMEZONE',
      'TZID:Europe/Berlin',
      'X-TZ-PROP:1',
      'END:VTIMEZONE',
      'BEGIN:VTODO',
      'UID:task-first',
      'SUMMARY:First',
      'X-FIRST:1',
      'END:VTODO',
      'BEGIN:VTODO',
      'UID:task-second',
      'X-SECOND:1',
      'END:VTODO',
      'END:VCALENDAR',
    ].join('\r\n');

    const out = logical(generateVTodo(parseVTodo(ical)));

    for (const absent of [
      'VERSION:2.0',
      'PRODID:-//Example//Other Client//EN',
      'X-WR-CALNAME:Example list',
      'BEGIN:VTIMEZONE',
      'TZID:Europe/Berlin',
      'X-TZ-PROP:1',
      'UID:task-second',
      'X-SECOND:1',
    ]) {
      expect(out).not.toContain(absent);
    }
    expect(count(out, 'UID:task-first')).toBe(1);

    expect(count(out, 'X-FIRST:1')).toBe(1);
  });

  it('control: a VTODO with only modelled properties generates byte-identical output', () => {
    const ical = [
      'BEGIN:VTODO',
      'UID:task-r5',
      'SUMMARY:Modelled only',
      'DESCRIPTION:Plain text',
      'DTSTART;VALUE=DATE:20261109',
      'DUE;TZID=Europe/Berlin:20261110T090000',
      'PRIORITY:5',
      'STATUS:IN-PROCESS',
      'CREATED:20261101T080000Z',
      'LAST-MODIFIED:20261102T080000Z',
      'PERCENT-COMPLETE:40',
      'LOCATION:Office',
      'URL:https://example.com/task',
      'CATEGORIES:Work,Home',
      'END:VTODO',
    ].join('\r\n');

    expect(generateVTodo(parseVTodo(ical))).toBe(ical);
  });
});

// ── S6 safety corrections (WEBX-03) ──
// Extraction by logical line, write-side revalidation of retained arrays,
// UTF-8-safe folding of retained lines, and temporal anchors for retained
// DURATION, alarms and recurrence. Direct generator cases pass the two planned
// optional VTodo arrays (unknownProperties, unknownComponents) by cast.
// Isolation checks run first; the retention check runs last.

describe('VTODO retention safety corrections (WEBX-03)', () => {
  const logical = (text: string): string[] => text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const count = (lines: string[], line: string): number => lines.filter((l) => l === line).length;
  const hasBlock = (lines: string[], block: string[]): boolean =>
    block.length > 0 && lines.some((_, i) => block.every((l, j) => lines[i + j] === l));
  const octets = (s: string): number => new TextEncoder().encode(s).length;
  /** Encode to UTF-8 and decode again, as stored item content would be. */
  const viaUtf8 = (s: string): string => new TextDecoder().decode(new TextEncoder().encode(s));
  const vtodo = (...body: string[]): string => ['BEGIN:VTODO', ...body, 'END:VTODO'].join('\r\n');
  const roundTrip = (...body: string[]): string[] => logical(generateVTodo(parseVTodo(vtodo(...body))));

  // ── VCALENDAR extraction boundary ──

  it('extracts the VTODO by whole logical lines, not a marker substring inside a value', () => {
    const ical = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VTODO',
      'UID:task-x1',
      'X-NOTE:literal END:VTODO text',
      'SUMMARY:After marker',
      'X-AFTER:1',
      'END:VTODO',
      'END:VCALENDAR',
    ].join('\r\n');

    const todo = parseVTodo(ical);
    expect(todo.summary).toBe('After marker');

    const out = logical(generateVTodo(todo));
    expect(count(out, 'X-NOTE:literal END:VTODO text')).toBe(1);
    expect(count(out, 'X-AFTER:1')).toBe(1);
    expect(logical(generateVTodo(parseVTodo(generateVTodo(todo))))).toEqual(out);
  });

  it('control: a VCALENDAR whose VTODO never ends still has no VTODO component', () => {
    const ical = ['BEGIN:VCALENDAR', 'BEGIN:VTODO', 'UID:task-x2', 'END:VCALENDAR'].join('\r\n');
    expect(() => parseVTodo(ical)).toThrow('VCALENDAR contains no VTODO component');
  });

  // ── Write-side revalidation of retained arrays ──

  it('revalidates retained property lines when generating', () => {
    const unknownProperties = [
      'X-SAFE;X-P="a;b:c":ok',
      'X-TAB:a\tb',
      'X-INJECT:a\r\nUID:evil-1',
      'X-INJECT-LF:a\nSTATUS:COMPLETED',
      'X-CTRL:a\u0001b',
      'Status;X-A=1:COMPLETED',
      'uid:evil-2',
      'Dtstart;VALUE=DATE:20000101',
      'BEGIN:VALARM',
      'END:VTODO',
      'X-NOCOLON',
      'X BAD:1',
      'X-UNBALANCED;X-P="a:b',
    ];
    const before = [...unknownProperties];
    const todo = { uid: 'task-g1', summary: 'Generated', status: 'NEEDS-ACTION', unknownProperties } as VTodo;

    const generated = generateVTodo(todo);
    const out = logical(generated);

    expect(generated.split('\r\n').every((l) => !/[\r\n]/.test(l))).toBe(true);
    expect(out.filter((l) => /^uid/i.test(l))).toEqual(['UID:task-g1']);
    expect(out.filter((l) => /^status/i.test(l))).toEqual(['STATUS:NEEDS-ACTION']);
    expect(out.filter((l) => /^dtstart/i.test(l))).toEqual([]);
    expect(out.filter((l) => /^(begin|end)[:;]/i.test(l))).toEqual(['BEGIN:VTODO', 'END:VTODO']);
    expect(out.some((l) => l.includes('evil') || l.includes('\u0001'))).toBe(false);
    for (const absent of ['X-NOCOLON', 'X BAD:1', 'X-UNBALANCED;X-P="a:b']) expect(out).not.toContain(absent);
    expect(unknownProperties).toEqual(before);

    expect(count(out, 'X-SAFE;X-P="a;b:c":ok')).toBe(1);
    expect(count(out, 'X-TAB:a\tb')).toBe(1);
  });

  it('revalidates retained components when generating and drops invalid blocks whole', () => {
    const absolute = [
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'UID:alarm-g2',
      'DESCRIPTION:Absolute',
      'TRIGGER;VALUE=DATE-TIME:20261110T080000Z',
      'END:VALARM',
    ];
    const mixedCase = ['Begin:X-Outer', 'BEGIN:x-inner', 'X-P:1', 'END:X-INNER', 'end:x-outer'];
    const unknownComponents = [
      absolute,
      mixedCase,
      ['BEGIN:X-A', 'X-P:evil-two-blocks', 'END:X-A', 'BEGIN:X-B', 'END:X-B'],
      ['BEGIN:X-A', 'BEGIN:X-B', 'X-P:evil-crossed', 'END:X-A', 'END:X-B'],
      ['BEGIN:X-WRAP', 'BEGIN:VEVENT', 'UID:evil-event', 'END:VEVENT', 'END:X-WRAP'],
      ['BEGIN:X-WRAP', 'BEGIN:vtimezone', 'X-P:evil-tz', 'END:vtimezone', 'END:X-WRAP'],
      ['BEGIN:X-C', 'X-P:a\r\nUID:evil-c', 'END:X-C'],
      ['BEGIN:X-D', 'BEGIN;X=1:X-E', 'X-P:evil-d', 'END:X-D'],
      ['BEGIN:X-OPEN', 'X-P:evil-open'],
      [],
    ];
    const before = unknownComponents.map((c) => [...c]);
    const todo = { uid: 'task-g2', summary: 'Components', unknownComponents } as VTodo;

    const out = logical(generateVTodo(todo));

    expect(out.some((l) => l.includes('evil'))).toBe(false);
    expect(out.filter((l) => /^uid/i.test(l) && l !== 'UID:alarm-g2')).toEqual(['UID:task-g2']);
    const allowedBegins = new Set(['BEGIN:VTODO', 'BEGIN:VALARM', 'Begin:X-Outer', 'BEGIN:x-inner']);
    expect(out.filter((l) => /^begin/i.test(l)).every((l) => allowedBegins.has(l))).toBe(true);
    expect(out[out.length - 1]).toBe('END:VTODO');
    expect(unknownComponents).toEqual(before);

    expect(hasBlock(out, absolute)).toBe(true);
    expect(hasBlock(out, mixedCase)).toBe(true);
  });

  it('keeps retained content per item when two items are generated in turn', () => {
    const a = {
      uid: 'task-a',
      summary: 'A',
      unknownProperties: ['X-ONLY-A:1'],
      unknownComponents: [['BEGIN:X-CA', 'X-P:a', 'END:X-CA']],
    } as VTodo;
    const b = { uid: 'task-b', summary: 'B', unknownProperties: ['X-ONLY-B:1'] } as VTodo;
    const snapshot = JSON.stringify([a, b]);

    const a1 = logical(generateVTodo(a));
    const b1 = logical(generateVTodo(b));
    const a2 = logical(generateVTodo(a));

    expect(a2).toEqual(a1);
    expect(b1.some((l) => l.includes('ONLY-A') || l.includes('X-CA'))).toBe(false);
    expect(a1.some((l) => l.includes('ONLY-B'))).toBe(false);
    expect(JSON.stringify([a, b])).toBe(snapshot);

    expect(count(a1, 'X-ONLY-A:1')).toBe(1);
    expect(hasBlock(a1, ['BEGIN:X-CA', 'X-P:a', 'END:X-CA'])).toBe(true);
    expect(count(b1, 'X-ONLY-B:1')).toBe(1);
  });

  // ── Folding of retained lines ──

  it('folds a retained line whose remainder is exactly 75 octets within 75 octets per physical line', () => {
    const line = `X-EXAMPLE-BOUNDARY:${'b'.repeat(131)}`;
    const generated = generateVTodo(parseVTodo(vtodo('UID:task-f1', 'SUMMARY:Fold', line)));

    for (const physical of generated.split('\r\n')) expect(octets(physical)).toBeLessThanOrEqual(75);

    expect(count(logical(viaUtf8(generated)), line)).toBe(1);
  });

  it('folds retained BMP multi-byte text without splitting characters', () => {
    const line = `X-EXAMPLE-BMP:${'é€'.repeat(40)}`;
    const generated = generateVTodo(parseVTodo(vtodo('UID:task-f2', 'SUMMARY:BMP', line)));

    for (const physical of generated.split('\r\n')) expect(octets(physical)).toBeLessThanOrEqual(75);

    expect(count(logical(viaUtf8(generated)), line)).toBe(1);
  });

  it('folds supplementary characters at code-point boundaries in properties and components', () => {
    // 72 ASCII octets, then 4-octet characters: a code-unit cut would split a surrogate pair.
    const prop = `X-EXAMPLE-EMOJI:${'a'.repeat(56)}${'\u{1F600}'.repeat(20)}`;
    const alarm = [
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${'a'.repeat(60)}${'\u{1F600}'.repeat(20)}`,
      'TRIGGER;VALUE=DATE-TIME:20261110T080000Z',
      'END:VALARM',
    ];
    const generated = generateVTodo(parseVTodo(vtodo('UID:task-f3', 'SUMMARY:Emoji', prop, ...alarm)));

    for (const physical of generated.split('\r\n')) expect(octets(physical)).toBeLessThanOrEqual(75);

    const out = logical(viaUtf8(generated));
    expect(count(out, prop)).toBe(1);
    expect(hasBlock(out, alarm)).toBe(true);
  });

  it('control: long modelled properties keep the existing fold', () => {
    const summaryLine = `SUMMARY:${'s'.repeat(100)}`;
    const generated = generateVTodo({ uid: 'task-f4', summary: 's'.repeat(100) });
    expect(generated).toContain(`${summaryLine.slice(0, 75)}\r\n ${summaryLine.slice(75)}`);
  });

  // ── Temporal anchors for retained content ──

  it('keeps a day-based DURATION with a date-only DTSTART and suppresses a sub-day one', () => {
    const subDay = roundTrip('UID:task-t1', 'SUMMARY:Day', 'DTSTART;VALUE=DATE:20261110', 'DURATION:PT1H');
    const wholeDay = roundTrip('UID:task-t2', 'SUMMARY:Day', 'DTSTART;VALUE=DATE:20261110', 'DURATION:P1D');

    expect(subDay.filter((l) => /^duration/i.test(l))).toEqual([]);
    expect(count(wholeDay, 'DTSTART;VALUE=DATE:20261110')).toBe(1);

    expect(count(wholeDay, 'DURATION:P1D')).toBe(1);
  });

  it('control: DURATION without DTSTART, or alongside DUE, is not written', () => {
    const noStart = roundTrip('UID:task-t3', 'SUMMARY:No start', 'DURATION:PT1H');
    const withDue = roundTrip(
      'UID:task-t4', 'SUMMARY:Due', 'DTSTART:20261110T090000Z', 'DUE:20261110T100000Z', 'DURATION:PT1H',
    );

    expect(noStart.filter((l) => /^duration/i.test(l))).toEqual([]);
    expect(withDue.filter((l) => /^duration/i.test(l))).toEqual([]);
    expect(withDue.filter((l) => /^due[;:]/i.test(l))).toEqual(['DUE:20261110T100000Z']);
  });

  it('keeps alarms whose trigger anchor is written and drops start-relative alarms without DTSTART', () => {
    const startAlarm = ['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Start', 'TRIGGER:-PT10M', 'END:VALARM'];
    const endAlarm = ['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:End', 'TRIGGER;RELATED=END:-PT10M', 'END:VALARM'];
    const absAlarm = [
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:Absolute',
      'TRIGGER;VALUE=DATE-TIME:20261110T080000Z',
      'END:VALARM',
    ];
    const dueOnly = roundTrip('UID:task-t5', 'SUMMARY:Due only', 'DUE:20261110T100000Z', ...startAlarm, ...endAlarm, ...absAlarm);
    const startAndDuration = roundTrip(
      'UID:task-t6', 'SUMMARY:Start and duration', 'DTSTART:20261110T090000Z', 'DURATION:PT1H', ...endAlarm,
    );

    expect(dueOnly).not.toContain('DESCRIPTION:Start');
    expect(dueOnly.filter((l) => /^due[;:]/i.test(l))).toEqual(['DUE:20261110T100000Z']);

    expect(hasBlock(dueOnly, endAlarm)).toBe(true);
    expect(hasBlock(dueOnly, absAlarm)).toBe(true);
    expect(hasBlock(startAndDuration, endAlarm)).toBe(true);
  });

  it('keeps recurrence whose UNTIL matches the DTSTART value type', () => {
    const dateStart = roundTrip(
      'UID:task-t7', 'SUMMARY:Daily', 'DTSTART;VALUE=DATE:20261110', 'RRULE:FREQ=DAILY;UNTIL=20261120', 'EXDATE;VALUE=DATE:20261112',
    );
    const utcStart = roundTrip('UID:task-t8', 'SUMMARY:Daily', 'DTSTART:20261110T090000Z', 'RRULE:FREQ=DAILY;UNTIL=20261120T090000Z');

    expect(count(dateStart, 'DTSTART;VALUE=DATE:20261110')).toBe(1);

    expect(count(dateStart, 'RRULE:FREQ=DAILY;UNTIL=20261120')).toBe(1);
    expect(count(dateStart, 'EXDATE;VALUE=DATE:20261112')).toBe(1);
    expect(count(utcStart, 'RRULE:FREQ=DAILY;UNTIL=20261120T090000Z')).toBe(1);
  });

  it('control: recurrence without DTSTART, or with an UNTIL of another value type, is not written', () => {
    const recurrence = (lines: string[]) => lines.filter((l) => /^(rrule|rdate|exdate|recurrence-id)[;:]/i.test(l));
    const noStart = roundTrip(
      'UID:task-t9', 'SUMMARY:No start', 'RRULE:FREQ=WEEKLY', 'RDATE:20261115T090000Z', 'EXDATE:20261112T090000Z',
    );
    const dateUntilUtcStart = roundTrip('UID:task-t10', 'SUMMARY:Mismatch', 'DTSTART:20261110T090000Z', 'RRULE:FREQ=DAILY;UNTIL=20261120');
    const utcUntilFloatingStart = roundTrip(
      'UID:task-t11', 'SUMMARY:Mismatch', 'DTSTART:20261110T090000', 'RRULE:FREQ=DAILY;UNTIL=20261120T090000Z',
    );

    expect(recurrence(noStart)).toEqual([]);
    expect(recurrence(dateUntilUtcStart)).toEqual([]);
    expect(recurrence(utcUntilFloatingStart)).toEqual([]);
  });
});

// ── RECURRENCE-ID form compatibility (WEBX-03, RFC 5545 §3.8.4.4) ──
// Kept only with a written DTSTART of the same value type (DATE vs DATE-TIME),
// and floating ("date with local time", §3.3.5 FORM #1) if and only if DTSTART
// is floating. UTC and TZID forms are both non-floating: this is not UNTIL's
// UTC rule. The line is kept verbatim; its value is the original occurrence
// and is never compared with or rebased onto DTSTART.

describe('retained RECURRENCE-ID follows DTSTART value type and local-time form (WEBX-03)', () => {
  const logical = (text: string): string[] => text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const roundTrip = (...body: string[]): string[] =>
    logical(generateVTodo(parseVTodo(['BEGIN:VTODO', 'UID:task-rid', 'SUMMARY:Occurrence', ...body, 'END:VTODO'].join('\r\n'))));
  const ridLines = (lines: string[]): string[] => lines.filter((l) => /^recurrence-id[;:]/i.test(l));

  it.each([
    ['DATE', 'DTSTART;VALUE=DATE:20261110', 'RECURRENCE-ID;VALUE=DATE:20261103'],
    ['floating', 'DTSTART:20261110T090000', 'RECURRENCE-ID:20261103T090000'],
    ['UTC', 'DTSTART:20261110T090000Z', 'RECURRENCE-ID:20261103T090000Z'],
    ['TZID-local', 'DTSTART;TZID=Europe/Berlin:20261110T090000', 'RECURRENCE-ID;TZID=Europe/Berlin:20261103T090000'],
    [
      'TZID id with a UTC start',
      'DTSTART:20261110T090000Z',
      'RECURRENCE-ID;TZID=Europe/Berlin;RANGE=THISANDFUTURE:20261103T100000',
    ],
  ])('keeps a compatible %s RECURRENCE-ID verbatim even though it differs from DTSTART', (_form, start, rid) => {
    const out = roundTrip(start, rid);

    expect(out.filter((l) => /^dtstart[;:]/i.test(l))).toEqual([start]);

    expect(ridLines(out)).toEqual([rid]);
  });

  it.each([
    ['a DATE start with a DATE-TIME id', 'DTSTART;VALUE=DATE:20261110', 'RECURRENCE-ID:20261103T090000Z'],
    ['a DATE-TIME start with a DATE id', 'DTSTART:20261110T090000Z', 'RECURRENCE-ID;VALUE=DATE:20261103'],
    ['a UTC start with a floating id', 'DTSTART:20261110T090000Z', 'RECURRENCE-ID:20261103T090000'],
    ['a TZID start with a floating id', 'DTSTART;TZID=Europe/Berlin:20261110T090000', 'RECURRENCE-ID:20261103T090000'],
    ['a floating start with a UTC id', 'DTSTART:20261110T090000', 'RECURRENCE-ID:20261103T090000Z'],
    ['a floating start with a TZID id', 'DTSTART:20261110T090000', 'RECURRENCE-ID;TZID=Europe/Berlin:20261103T090000'],
  ])('control: suppresses RECURRENCE-ID for %s', (_case, start, rid) => {
    expect(ridLines(roundTrip(start, rid))).toEqual([]);
  });

  it('control: suppresses RECURRENCE-ID when no DTSTART is written', () => {
    expect(ridLines(roundTrip('RECURRENCE-ID:20261103T090000Z'))).toEqual([]);
  });
});

// ── VCALENDAR wrapper detection (WEBX-02 review follow-up, RFC 5545 §3.1) ──
// Names are case-insensitive and any line may be folded, so the outer wrapper
// is found on the first logical line, not by a raw uppercase prefix.

describe('parseVTodo finds the VCALENDAR wrapper by its logical line (WEBX-02)', () => {
  const body = [
    'VERSION:2.0',
    'BEGIN:VTODO',
    'UID:task-case',
    'SUMMARY:Parent task',
    'DESCRIPTION:Parent description',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'SUMMARY:Alarm summary',
    'TRIGGER:-PT15M',
    'END:VALARM',
    'END:VTODO',
    'END:VCALENDAR',
  ];

  it.each([
    ['uppercase', 'BEGIN:VCALENDAR'],
    ['lowercase value', 'BEGIN:vcalendar'],
    ['all lowercase', 'begin:vcalendar'],
    ['folded', 'BEGIN:VCAL\r\n ENDAR'],
  ])('keeps the task fields for a %s opening', (_form, opening) => {
    const todo = parseVTodo([opening, ...body].join('\r\n'));

    expect(todo.uid).toBe('task-case');
    expect(todo.summary).toBe('Parent task');
    expect(todo.description).toBe('Parent description');
  });
});

// ── RDATE/EXDATE form compatibility (WEBX-03 review follow-up, RFC 5545 §3.8.5) ──
// Kept only while every value has the written DTSTART's value type and the same
// floating/non-floating form (the RECURRENCE-ID rule). PERIOD values are judged
// by their start. Lines are kept verbatim, never rebased.

describe('retained RDATE/EXDATE follow DTSTART value type and local-time form (WEBX-03)', () => {
  const logical = (text: string): string[] => text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const roundTrip = (...body: string[]): string[] =>
    logical(generateVTodo(parseVTodo(['BEGIN:VTODO', 'UID:task-rd', 'SUMMARY:Series', ...body, 'END:VTODO'].join('\r\n'))));
  const setLines = (lines: string[]): string[] => lines.filter((l) => /^(rdate|exdate)[;:]/i.test(l));

  it.each([
    ['DATE', 'DTSTART;VALUE=DATE:20261110', 'EXDATE;VALUE=DATE:20261112,20261113'],
    ['DATE rdate', 'DTSTART;VALUE=DATE:20261110', 'RDATE;VALUE=DATE:20261120'],
    ['UTC', 'DTSTART:20261110T090000Z', 'EXDATE:20261112T090000Z'],
    ['TZID with a UTC start', 'DTSTART:20261110T090000Z', 'RDATE;TZID=Europe/Berlin:20261120T100000'],
    ['floating', 'DTSTART:20261110T090000', 'EXDATE:20261112T090000,20261113T090000'],
    ['UTC PERIOD', 'DTSTART:20261110T090000Z', 'RDATE;VALUE=PERIOD:20261120T090000Z/PT1H'],
  ])('keeps a compatible %s line verbatim', (_form, start, line) => {
    expect(setLines(roundTrip(start, 'RRULE:FREQ=DAILY;COUNT=5', line))).toEqual([line]);
  });

  it.each([
    ['a DATE start with a DATE-TIME exdate', 'DTSTART;VALUE=DATE:20261110', 'EXDATE:20261112T090000Z'],
    ['a DATE start with a DATE-TIME rdate', 'DTSTART;VALUE=DATE:20261110', 'RDATE:20261120T090000Z'],
    ['a DATE start with a PERIOD rdate', 'DTSTART;VALUE=DATE:20261110', 'RDATE;VALUE=PERIOD:20261120T090000Z/PT1H'],
    ['a DATE-TIME start with a DATE exdate', 'DTSTART:20261110T090000Z', 'EXDATE;VALUE=DATE:20261112'],
    ['a UTC start with a floating rdate', 'DTSTART:20261110T090000Z', 'RDATE:20261120T090000'],
    ['a floating start with a UTC exdate', 'DTSTART:20261110T090000', 'EXDATE:20261112T090000Z'],
    ['a UTC start with one floating value in a list', 'DTSTART:20261110T090000Z', 'EXDATE:20261112T090000Z,20261113T090000'],
  ])('control: suppresses the line for %s', (_case, start, line) => {
    expect(setLines(roundTrip(start, 'RRULE:FREQ=DAILY;COUNT=5', line))).toEqual([]);
  });
});
