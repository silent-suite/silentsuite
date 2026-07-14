import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVEvent, generateVEvent, parseVTodo, generateVTodo } from './ical-parser.js';
import type { VEvent, VTodo } from './ical-parser.js';
import { parseVCard, generateVCard } from './vcard-parser.js';
import type { VCard } from './vcard-parser.js';

/**
 * Golden item-format corpus tests.
 *
 * These tests consume the fixture files under packages/core/fixtures/item-format/
 * (the item-format contract test bed, see its README.md). The same files and
 * manifest expectations are consumed by bridge/tests/test_item_format_fixtures.py.
 */

const CORPUS_DIR = fileURLToPath(new URL('../../fixtures/item-format', import.meta.url));

interface ManifestFixture {
  path: string;
  kind: 'vevent' | 'vtodo' | 'vcard';
  covers: string[];
  expected: Record<string, unknown>;
}

const manifest: { fixtures: ManifestFixture[] } = JSON.parse(
  readFileSync(join(CORPUS_DIR, 'manifest.json'), 'utf8'),
);

function readFixture(relPath: string): string {
  return readFileSync(join(CORPUS_DIR, relPath), 'utf8');
}

// ── Expectation dispatch ──
// Every manifest key must be handled explicitly; unknown keys fail the suite so
// the corpus and its consumers cannot drift apart silently.

function assertVEventExpectations(event: VEvent, expected: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(expected)) {
    switch (key) {
      case 'uid':
        expect(event.uid).toBe(value);
        break;
      case 'summary':
        expect(event.summary).toBe(value);
        break;
      case 'description':
        expect(event.description).toBe(value);
        break;
      case 'location':
        expect(event.location).toBe(value);
        break;
      case 'status':
        expect(event.status).toBe(value);
        break;
      case 'categories':
        expect(event.categories).toEqual(value);
        break;
      case 'rrule':
        expect(event.rrule).toBe(value);
        break;
      case 'dtstartUtc':
      case 'dtstartLocal':
        expect(event.dtstart).toBe(value);
        break;
      case 'dtendUtc':
      case 'dtendLocal':
        expect(event.dtend).toBe(value);
        break;
      case 'exdateLocal':
        expect(event.exdate).toEqual(value);
        break;
      case 'tzid':
        expect(event.dtstartParams?.TZID).toBe(value);
        expect(event.dtendParams?.TZID).toBe(value);
        if (event.exdate) {
          expect(event.exdateParams?.TZID).toBe(value);
        }
        break;
      case 'utcOffsetMinutes':
        // Timezone math is asserted by the bridge suite (vobject resolves the
        // VTIMEZONE); the core parser treats date-times as opaque strings.
        break;
      default:
        throw new Error(`unhandled expected key "${key}" for a vevent fixture`);
    }
  }
}

function assertVTodoExpectations(todo: VTodo, expected: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(expected)) {
    switch (key) {
      case 'uid':
        expect(todo.uid).toBe(value);
        break;
      case 'summary':
        expect(todo.summary).toBe(value);
        break;
      case 'description':
        expect(todo.description).toBe(value);
        break;
      case 'dueUtc':
        expect(todo.due).toBe(value);
        break;
      case 'priority':
        expect(todo.priority).toBe(value);
        break;
      case 'status':
        expect(todo.status).toBe(value);
        break;
      case 'percentComplete':
        expect(todo.percentComplete).toBe(value);
        break;
      case 'categories':
        expect(todo.categories).toEqual(value);
        break;
      default:
        throw new Error(`unhandled expected key "${key}" for a vtodo fixture`);
    }
  }
}

function assertVCardExpectations(vcard: VCard, expected: Record<string, unknown>, raw: string): void {
  for (const [key, value] of Object.entries(expected)) {
    switch (key) {
      case 'uid':
        expect(vcard.uid).toBe(value);
        break;
      case 'fn':
        expect(vcard.fn).toBe(value);
        break;
      case 'n': {
        const n = value as { family: string; given: string; prefix?: string; suffix?: string };
        expect(vcard.n?.family).toBe(n.family);
        expect(vcard.n?.given).toBe(n.given);
        expect(vcard.n?.prefix).toBe(n.prefix);
        expect(vcard.n?.suffix).toBe(n.suffix);
        break;
      }
      case 'org':
        expect(vcard.org).toBe(value);
        break;
      case 'title':
        expect(vcard.title).toBe(value);
        break;
      case 'note':
        expect(vcard.note).toBe(value);
        break;
      case 'categories':
        expect(vcard.categories).toEqual(value);
        break;
      case 'email': {
        const emails = value as Array<{ type: string; value: string }>;
        for (const expectedEmail of emails) {
          expect(vcard.email).toContainEqual(expectedEmail);
        }
        break;
      }
      case 'tel': {
        const tels = value as Array<{ type: string; value: string }>;
        for (const expectedTel of tels) {
          expect(vcard.tel).toContainEqual(expectedTel);
        }
        break;
      }
      case 'telUri':
        // Pins the raw on-the-wire TEL;VALUE=uri form in the fixture itself.
        expect(raw).toContain(`TEL;VALUE=uri:${value}`);
        break;
      case 'telNumber':
        // The core parser normalizes tel: URIs to a plain number.
        expect(vcard.tel?.map((t) => t.value)).toContain(value);
        break;
      case 'cellNumber':
        expect(vcard.tel).toContainEqual({ type: 'cell', value: value as string });
        break;
      case 'favorite':
        // Canonical `X-SILENTSUITE-FAVORITE:1` resolves to true; the parser
        // leaves the field undefined when the resolved value is false.
        expect(vcard.favorite ?? false).toBe(value);
        break;
      default:
        throw new Error(`unhandled expected key "${key}" for a vcard fixture`);
    }
  }
}

// ── Corpus completeness ──

describe('item-format corpus manifest', () => {
  it('lists every fixture file on disk, and every listed file exists', () => {
    const onDisk = ['ics', 'vcf']
      .flatMap((dir) =>
        readdirSync(join(CORPUS_DIR, dir))
          .filter((f) => f.endsWith('.ics') || f.endsWith('.vcf'))
          .map((f) => `${dir}/${f}`),
      )
      .sort();
    const inManifest = manifest.fixtures.map((f) => f.path).sort();
    expect(inManifest).toEqual(onDisk);
  });

  it('covers the contract dimensions: categories, tzid, recurrence, escaping', () => {
    const covered = new Set(manifest.fixtures.flatMap((f) => f.covers));
    for (const dimension of ['categories', 'tzid', 'rrule', 'exdate', 'escaping']) {
      expect(covered, `corpus lost coverage of "${dimension}"`).toContain(dimension);
    }
  });
});

// ── Fixture-driven parse + round-trip tests ──

describe.each(manifest.fixtures)('fixture $path', (fixture) => {
  const raw = readFixture(fixture.path);

  if (fixture.kind === 'vevent') {
    it('parses to the expected contract fields', () => {
      assertVEventExpectations(parseVEvent(raw), fixture.expected);
    });

    it('round-trips through generateVEvent without losing contract fields', () => {
      const parsed = parseVEvent(raw);
      const reparsed = parseVEvent(generateVEvent(parsed));
      assertVEventExpectations(reparsed, fixture.expected);
      expect(reparsed).toEqual(parsed);
    });
  }

  if (fixture.kind === 'vtodo') {
    it('parses to the expected contract fields', () => {
      assertVTodoExpectations(parseVTodo(raw), fixture.expected);
    });

    it('round-trips through generateVTodo without losing contract fields', () => {
      const parsed = parseVTodo(raw);
      const reparsed = parseVTodo(generateVTodo(parsed));
      assertVTodoExpectations(reparsed, fixture.expected);
      expect(reparsed).toEqual(parsed);
    });
  }

  if (fixture.kind === 'vcard') {
    it('parses to the expected contract fields', () => {
      assertVCardExpectations(parseVCard(raw), fixture.expected, raw);
    });

    it('round-trips through generateVCard without losing contract fields', () => {
      const parsed = parseVCard(raw);
      const regenerated = generateVCard(parsed);
      const reparsed = parseVCard(regenerated);
      // telUri is a raw-wire assertion on the fixture file; the regenerated
      // card intentionally carries the normalized number instead.
      const { telUri: _telUri, ...roundTripExpected } = fixture.expected;
      assertVCardExpectations(reparsed, roundTripExpected, regenerated);
      expect(reparsed).toEqual(parsed);
    });
  }
});
