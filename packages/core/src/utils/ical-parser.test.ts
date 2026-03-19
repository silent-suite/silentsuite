import { describe, it, expect } from 'vitest';
import {
  parseVEvent,
  generateVEvent,
  parseVCalendar,
  generateVCalendar,
} from './ical-parser.js';
import type { VEvent, VAlarm } from './ical-parser.js';

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
