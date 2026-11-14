import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import {
  parseBirthdayMarker,
  birthdayFromVCard,
  birthdayEventUid,
  isGeneratedBirthdayUid,
  birthdayEventFields,
  birthdayEventContent,
  parseBirthdayEventFields,
  isCurrentBirthdayEvent,
  birthdayEventsFromSource,
  planBirthdayCalendar,
  decideAfterBirthdayRun,
  type BirthdayEvent,
  type BirthdayEventFields,
  type BirthdaySourceSnapshot,
  type BirthdaySourceResult,
  type BirthdayCalendarSnapshot,
  type BirthdayPlanResult,
  type BirthdayPostCheck,
} from './birthday-calendar.js';
import * as core from '../index.js';
import { expandRecurrence } from '../utils/recurrence.js';
import { deserializeCalendarEvent } from '../models/calendar-event.js';

interface Vectors {
  marker: Array<{ content: string; state: 'active' | 'retired' | null }>;
  birthdays: Array<{ case: string; vcard: string; expected: { name: string; month: number; day: number } | null }>;
  identity: Array<{ bookUid: string; itemUid: string; uid: string }>;
  events: Array<{ case: string; event: BirthdayEvent; fields: BirthdayEventFields; ics: string[] }>;
  eventMismatches: Array<{ case: string; event: BirthdayEvent; ics: string }>;
  sources: Array<{ case: string; snapshot: BirthdaySourceSnapshot; expected: BirthdaySourceResult }>;
  plans: Array<{ case: string; events: BirthdayEvent[]; calendars: BirthdayCalendarSnapshot[]; expected: BirthdayPlanResult }>;
  postChecks: Array<{ case: string; check: BirthdayPostCheck; rerunsSoFar: number; decision: string }>;
}

const vectors: Vectors = JSON.parse(
  readFileSync(new URL('../../../../contracts/birthday-calendar/v1-vectors.json', import.meta.url), 'utf8'),
);

describe('Birthdays calendar marker', () => {
  it.each(vectors.marker)('reads $content as $state', ({ content, state }) => {
    expect(parseBirthdayMarker(content)).toBe(state);
  });

  it('is not a marker when there is no content', () => {
    expect(parseBirthdayMarker(null)).toBeNull();
    expect(parseBirthdayMarker(undefined)).toBeNull();
  });
});

describe('contact birthdays', () => {
  it.each(vectors.birthdays)('$case', ({ vcard, expected }) => {
    expect(birthdayFromVCard(vcard)).toEqual(expected);
  });
});

describe('birthday event identity', () => {
  it('uses vectors that match an independent SHA-256', () => {
    const oracle = vectors.identity.map(({ bookUid, itemUid }) =>
      `ss-bday1-${createHash('sha256').update(`${bookUid}/${itemUid}`, 'utf8').digest('hex').slice(0, 32)}`);
    expect(vectors.identity.map(({ uid }) => uid)).toEqual(oracle);
  });

  it.each(vectors.identity)('derives $uid from the Etebase uids', async ({ bookUid, itemUid, uid }) => {
    await expect(birthdayEventUid(bookUid, itemUid)).resolves.toBe(uid);
  });

  it('gives the same item different uids in different address books', async () => {
    const [first, second] = vectors.identity;
    expect(first!.itemUid).toBe(second!.itemUid);
    expect(await birthdayEventUid(first!.bookUid, first!.itemUid))
      .not.toBe(await birthdayEventUid(second!.bookUid, second!.itemUid));
  });

  it('uses the platform digest and refuses without one (e.g. a page served over plain HTTP)', async () => {
    const [vector] = vectors.identity;
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest');
    try {
      await expect(birthdayEventUid(vector!.bookUid, vector!.itemUid)).resolves.toBe(vector!.uid);
      expect(digest).toHaveBeenCalledWith('SHA-256', expect.anything());
    } finally {
      digest.mockRestore();
    }

    vi.stubGlobal('crypto', {});
    try {
      await expect(birthdayEventUid(vector!.bookUid, vector!.itemUid)).rejects.toThrow(/SHA-256 is unavailable/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('recognises only the generated uid form', () => {
    for (const { uid } of vectors.identity) expect(isGeneratedBirthdayUid(uid)).toBe(true);
    for (const uid of ['', 'ss-bday1-', 'ss-bday1-C8970A5B3457981540F4EE428F84A1F4', 'ss-bday2-c8970a5b3457981540f4ee428f84a1f4',
      'ss-bday1-c8970a5b3457981540f4ee428f84a1f', 'ss-bday1-c8970a5b3457981540f4ee428f84a1f4x', 'user-event@example.com']) {
      expect(isGeneratedBirthdayUid(uid)).toBe(false);
    }
  });
});

describe('birthday reconcile planning', () => {
  it.each(vectors.sources)('source: $case', async ({ snapshot, expected }) => {
    await expect(birthdayEventsFromSource(snapshot)).resolves.toEqual(expected);
  });

  it.each(vectors.plans)('plan: $case', ({ events, calendars, expected }) => {
    expect(planBirthdayCalendar(events, calendars)).toEqual(expected);
  });

  it('plans the same whatever order the calendars and items were listed in', () => {
    for (const { events, calendars, expected } of vectors.plans) {
      const reversed = [...calendars].reverse().map((calendar) => ({ ...calendar, items: [...calendar.items].reverse() }));
      expect(planBirthdayCalendar([...events].reverse(), reversed)).toEqual(expected);
    }
  });

  it('plans nothing more once its own plan is applied', () => {
    const vector = vectors.plans.find(({ expected }) => expected.kind === 'plan' && expected.plan.create.length > 0
      && expected.plan.update.length > 0)!;
    const result = planBirthdayCalendar(vector.events, vector.calendars);
    if (result.kind !== 'plan') throw new Error('expected a plan');
    const canonical = vector.calendars.find(({ uid }) => uid === result.plan.canonical)!;
    const removed = new Set(result.plan.remove);
    const updated = new Map(result.plan.update.map(({ itemUid, event }) => [itemUid, event]));
    const applied: BirthdayCalendarSnapshot = {
      ...canonical,
      items: [
        ...canonical.items.filter(({ itemUid }) => !removed.has(itemUid)).map((item) =>
          updated.has(item.itemUid) ? { itemUid: item.itemUid, content: birthdayEventContent(updated.get(item.itemUid)!) } : item),
        ...result.plan.create.map((event, index) => ({ itemUid: `item-new-${index}`, content: birthdayEventContent(event) })),
      ],
    };
    expect(planBirthdayCalendar(vector.events, [applied])).toEqual({
      kind: 'plan',
      plan: { canonical: canonical.uid, create: [], update: [], remove: [], retire: [], cleanup: [] },
    });
  });

  it.each(vectors.postChecks)('after a run: $case', ({ check, rerunsSoFar, decision }) => {
    expect(decideAfterBirthdayRun(check, rerunsSoFar)).toBe(decision);
  });

  it('is exported from the core package', () => {
    for (const name of ['parseBirthdayMarker', 'birthdayMarkerContent', 'birthdayFromVCard', 'normalizeBirthday',
      'birthdayEventUid', 'isGeneratedBirthdayUid', 'birthdayEventFields', 'birthdayEventContent',
      'parseBirthdayEventFields', 'isCurrentBirthdayEvent', 'birthdayEventsFromSource', 'planBirthdayCalendar',
      'decideAfterBirthdayRun']) {
      expect(typeof (core as Record<string, unknown>)[name], name).toBe('function');
    }
    expect((core as Record<string, unknown>).BIRTHDAY_MARKER_TYPE).toBe('silentsuite.birthdays');
    expect((core as Record<string, unknown>).BIRTHDAY_MAX_RERUNS).toBe(2);
  });
});

describe('birthday event text', () => {
  const utf8Length = (line: string) => new TextEncoder().encode(line).length;

  it.each(vectors.events)('$case: expected fields', ({ event, fields }) => {
    expect(birthdayEventFields(event)).toEqual(fields);
  });

  it.each(vectors.events)('$case: every text variant parses to the fields', ({ fields, ics }) => {
    for (const text of ics) expect(parseBirthdayEventFields(text)).toEqual(fields);
  });

  it.each(vectors.events)('$case: own output parses back, folds within 75 octets and counts as current',
    ({ event, fields, ics }) => {
      const content = birthdayEventContent(event);
      expect(parseBirthdayEventFields(content)).toEqual(fields);
      for (const line of content.split('\r\n')) expect(utf8Length(line)).toBeLessThanOrEqual(75);
      expect(content.endsWith('\r\n')).toBe(true);
      for (const text of [content, ...ics]) expect(isCurrentBirthdayEvent(text, event)).toBe(true);
    });

  it('writes the canonical text exactly when nothing needs folding', () => {
    const [ordinary, leap, yearEnd] = vectors.events;
    for (const vector of [ordinary!, leap!, yearEnd!]) expect(birthdayEventContent(vector.event)).toBe(vector.ics[0]);
  });

  it.each(vectors.eventMismatches)('$case: is not current', ({ event, ics }) => {
    expect(isCurrentBirthdayEvent(ics, event)).toBe(false);
  });

  it('has no fields without a VEVENT UID', () => {
    expect(parseBirthdayEventFields('')).toBeNull();
    expect(parseBirthdayEventFields('not ical')).toBeNull();
    expect(parseBirthdayEventFields('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n')).toBeNull();
  });

  it('is an all-day yearly event the app expands on the birthday every year', () => {
    for (const [event, expected] of [
      [vectors.events[0]!.event, ['2026-03-15', '2027-03-15', '2028-03-15']],
      [vectors.events[1]!.event, ['2026-02-28', '2027-02-28', '2028-02-29']],
    ] as const) {
      const parsed = deserializeCalendarEvent(birthdayEventContent(event));
      expect(parsed.allDay).toBe(true);
      const dates = expandRecurrence(parsed.recurrenceRule!, parsed.startDate, {
        start: new Date(2026, 0, 1), end: new Date(2028, 11, 31),
      });
      expect(dates.map((d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`))
        .toEqual(expected);
      expect(parsed.endDate.getTime() - parsed.startDate.getTime()).toBeGreaterThan(0);
    }
  });
});
