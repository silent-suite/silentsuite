/**
 * Pure helpers for the generated Birthdays calendar (#738).
 *
 * Shared contract: contracts/birthday-calendar/v1-vectors.json. Web, Android and
 * Bridge each implement these rules; nothing here talks to the network.
 */

import { parseVCard } from '../utils/vcard-parser.js';

export const BIRTHDAY_MARKER_TYPE = 'silentsuite.birthdays';
export const BIRTHDAY_EVENT_UID_PREFIX = 'ss-bday1-';

export type BirthdayMarkerState = 'active' | 'retired';

export interface MonthDay {
  month: number;
  day: number;
}

export interface ContactBirthday extends MonthDay {
  name: string;
}

/** The marker state of a collection's content, or null when it is not a Birthdays calendar. */
export function parseBirthdayMarker(content: string | null | undefined): BirthdayMarkerState | null {
  if (!content) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const { type, v, state } = parsed as Record<string, unknown>;
  if (type !== BIRTHDAY_MARKER_TYPE || v !== 1) return null;
  return state === 'active' || state === 'retired' ? state : null;
}

/** The collection content that marks a Birthdays calendar. */
export function birthdayMarkerContent(state: BirthdayMarkerState): string {
  return JSON.stringify({ type: BIRTHDAY_MARKER_TYPE, v: 1, state });
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Month/day when it exists, in `year` or, for a year-less date, in some year. */
function existingMonthDay(year: number | null, month: number, day: number): MonthDay | null {
  if (month < 1 || month > 12 || day < 1) return null;
  const days = month === 2
    ? (year === null || isLeapYear(year) ? 29 : 28)
    : [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day <= days ? { month, day } : null;
}

/**
 * The month/day of a birthday as the contact model holds it (year-less `--MM-DD`,
 * or a full date, optionally with a time), or null for text and anything else.
 * The year only decides whether the date exists; it never reaches the event.
 */
export function normalizeBirthday(value: string | null | undefined, isText = false): MonthDay | null {
  if (isText || !value) return null;
  const text = value.trim();
  const yearless = /^--(\d{2})-?(\d{2})$/.exec(text);
  if (yearless) return existingMonthDay(null, Number(yearless[1]), Number(yearless[2]));
  const dated = /^(\d{4})-?(\d{2})-?(\d{2})(?:T[0-9:.,+\-Z]*)?$/.exec(text);
  if (dated) return existingMonthDay(Number(dated[1]), Number(dated[2]), Number(dated[3]));
  return null;
}

/** Whether the card itself has a non-empty FN; parseVCard fills a missing one with 'Untitled'. */
function hasOwnFormattedName(vcard: string): boolean {
  return vcard
    .replace(/\r\n[ \t]|\n[ \t]/g, '')
    .split(/\r?\n/)
    .some((line) => /^(?:[A-Za-z0-9-]+\.)?FN(?:;[^:]*)?:\s*\S/i.test(line));
}

/** The name and month/day a contact's birthday event gets, or null when it gets none. */
export function birthdayFromVCard(vcard: string): ContactBirthday | null {
  let card: ReturnType<typeof parseVCard>;
  try {
    card = parseVCard(vcard);
  } catch {
    return null;
  }
  const name = (hasOwnFormattedName(vcard) ? card.fn?.trim() : '')
    || [card.n?.given, card.n?.family].map((part) => part?.trim()).filter(Boolean).join(' ');
  if (!name) return null;
  const birthday = normalizeBirthday(card.bday, card.bdayIsText === true);
  return birthday ? { name, ...birthday } : null;
}

/**
 * The event UID for a contact, from its Etebase address-book and item uids — never
 * the vCard UID, so equal vCard UIDs in different address books stay separate.
 *
 * Uses the platform SHA-256 (Web Crypto). A browser page outside a secure context
 * (plain-HTTP self-host) has none; this then rejects, and callers skip generation
 * there rather than write anything, as the encrypted data cache does.
 */
export async function birthdayEventUid(bookUid: string, itemUid: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('SHA-256 is unavailable: Web Crypto needs a secure context');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(`${bookUid}/${itemUid}`));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return BIRTHDAY_EVENT_UID_PREFIX + hex.slice(0, 32);
}

/** A generated birthday event: what it is, before it becomes iCalendar text. */
export interface BirthdayEvent extends ContactBirthday {
  uid: string;
}

/**
 * What a birthday event means, as compared across clients. Date values read
 * `DATE:YYYYMMDD` when they carry VALUE=DATE, else their raw value; the summary is
 * unescaped. Folding, line endings, property order and other properties do not count.
 */
export interface BirthdayEventFields {
  uid: string;
  dtstart: string;
  dtend: string;
  rrule: string;
  summary: string;
}

/** Year every birthday event starts in: a leap year, so Feb 29 exists. Never shown as a birth year. */
const ANCHOR_YEAR = 1972;
const DAY_MS = 24 * 60 * 60 * 1000;
const LAST_DAY_OF_FEBRUARY = 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1';

function icsDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
}

/** The fields a generated event must have: all-day on the anchor date, ending the next day (exclusive). */
export function birthdayEventFields(event: BirthdayEvent): BirthdayEventFields {
  const start = Date.UTC(ANCHOR_YEAR, event.month - 1, event.day);
  return {
    uid: event.uid,
    dtstart: `DATE:${icsDate(start)}`,
    dtend: `DATE:${icsDate(start + DAY_MS)}`,
    rrule: event.month === 2 && event.day === 29 ? LAST_DAY_OF_FEBRUARY : 'FREQ=YEARLY',
    summary: `🎂 ${event.name}`,
  };
}

function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_match, char: string) => (char === 'n' || char === 'N' ? '\n' : char));
}

/** RFC 5545 folding: lines of at most 75 octets, never splitting a character. */
function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const lines: string[] = [];
  let current = '';
  let octets = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (octets + size > 75) {
      lines.push(current);
      current = ' ';
      octets = 1;
    }
    current += char;
    octets += size;
  }
  lines.push(current);
  return lines.join('\r\n');
}

/** The iCalendar text this client writes for a birthday event. */
export function birthdayEventContent(event: BirthdayEvent): string {
  const fields = birthdayEventFields(event);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SilentSuite//Birthdays v1//EN',
    'BEGIN:VEVENT',
    `UID:${fields.uid}`,
    `DTSTAMP:${ANCHOR_YEAR}0101T000000Z`,
    `DTSTART;VALUE=DATE:${fields.dtstart.slice('DATE:'.length)}`,
    `DTEND;VALUE=DATE:${fields.dtend.slice('DATE:'.length)}`,
    `RRULE:${fields.rrule}`,
    `SUMMARY:${escapeText(fields.summary)}`,
    'TRANSP:TRANSPARENT',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/** A content line's upper-cased name, its parameters and its value; quoted parameters may hold ':'. */
function splitContentLine(line: string): { name: string; params: string[]; value: string } | null {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') quoted = !quoted;
    else if (char === ':' && !quoted) {
      const [name = '', ...params] = line.slice(0, i).split(';');
      return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
    }
  }
  return null;
}

/** The comparable fields of the first VEVENT in iCalendar text, or null without a VEVENT UID. */
export function parseBirthdayEventFields(ics: string): BirthdayEventFields | null {
  const lines = ics.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const found: Partial<Record<'UID' | 'DTSTART' | 'DTEND' | 'RRULE' | 'SUMMARY', string>> = {};
  let inEvent = false;
  let nested = 0;
  for (const line of lines) {
    const property = splitContentLine(line);
    if (!property) continue;
    const value = property.value.trim();
    if (!inEvent) {
      if (property.name === 'BEGIN' && value.toUpperCase() === 'VEVENT') inEvent = true;
      continue;
    }
    if (property.name === 'BEGIN') { nested++; continue; }
    if (property.name === 'END') {
      if (nested === 0) break;
      nested--;
      continue;
    }
    if (nested > 0) continue;
    const name = property.name as keyof typeof found;
    if (!['UID', 'DTSTART', 'DTEND', 'RRULE', 'SUMMARY'].includes(name) || found[name] !== undefined) continue;
    const isDate = property.params.some((param) => param.toUpperCase() === 'VALUE=DATE');
    found[name] = name === 'SUMMARY' ? unescapeText(property.value)
      : (name === 'DTSTART' || name === 'DTEND') && isDate ? `DATE:${value}` : value;
  }
  if (!found.UID) return null;
  return {
    uid: found.UID,
    dtstart: found.DTSTART ?? '',
    dtend: found.DTEND ?? '',
    rrule: found.RRULE ?? '',
    summary: found.SUMMARY ?? '',
  };
}

/** Whether stored iCalendar text already means exactly this birthday event. */
export function isCurrentBirthdayEvent(ics: string, event: BirthdayEvent): boolean {
  const stored = parseBirthdayEventFields(ics);
  if (!stored) return false;
  const expected = birthdayEventFields(event);
  return (Object.keys(expected) as Array<keyof BirthdayEventFields>).every((key) => stored[key] === expected[key]);
}

/** Whether an event UID has the generated Birthdays form. */
export function isGeneratedBirthdayUid(uid: string): boolean {
  return /^ss-bday1-[0-9a-f]{32}$/.test(uid);
}

// ── Reconcile planning (pure: adapters read, write and fence) ──

/** One item as read; `content` is null when it could not be decrypted or read. */
export interface BirthdaySnapshotItem {
  itemUid: string;
  content: string | null;
}

/** Every address book listed for the account, each with its live contacts. */
export interface BirthdaySourceSnapshot {
  /** The address-book listing finished; an empty complete listing means no contacts. */
  inventoryComplete: boolean;
  books: Array<{ bookUid: string; complete: boolean; items: BirthdaySnapshotItem[] }>;
}

export type BirthdaySourceResult =
  | { ok: true; events: BirthdayEvent[] }
  | { ok: false; reason: 'incomplete-inventory' | 'incomplete-book' | 'unreadable-contact' };

/** A marked calendar as read in this run. */
export interface BirthdayCalendarSnapshot {
  uid: string;
  state: BirthdayMarkerState;
  /** Admin access and a verified current member list of exactly this user. */
  writable: boolean;
  complete: boolean;
  items: BirthdaySnapshotItem[];
}

export interface BirthdayCalendarPlan {
  /** The calendar generated events live in, or null when the feature is off. */
  canonical: string | null;
  create: BirthdayEvent[];
  update: Array<{ itemUid: string; event: BirthdayEvent }>;
  /** Generated items to delete from the canonical calendar. */
  remove: string[];
  /** Other active calendars to retire (before their cleanup). */
  retire: string[];
  /** Generated items to delete from retired or retiring calendars. */
  cleanup: Array<{ calendarUid: string; itemUids: string[] }>;
}

export type BirthdayPlanResult =
  | { kind: 'plan'; plan: BirthdayCalendarPlan }
  | { kind: 'skip'; reason: 'incomplete-calendar' | 'unreadable-calendar-item' };

/** Code-unit order, the same in every language (never locale order). */
function compareUids(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The desired events, or why the source cannot decide them; absence is never inferred from a partial read. */
export async function birthdayEventsFromSource(snapshot: BirthdaySourceSnapshot): Promise<BirthdaySourceResult> {
  if (!snapshot.inventoryComplete) return { ok: false, reason: 'incomplete-inventory' };
  if (snapshot.books.some((book) => !book.complete)) return { ok: false, reason: 'incomplete-book' };
  if (snapshot.books.some((book) => book.items.some((item) => item.content === null))) {
    return { ok: false, reason: 'unreadable-contact' };
  }
  const events: BirthdayEvent[] = [];
  for (const book of snapshot.books) {
    for (const item of book.items) {
      const birthday = birthdayFromVCard(item.content!);
      if (birthday) events.push({ uid: await birthdayEventUid(book.bookUid, item.itemUid), ...birthday });
    }
  }
  return { ok: true, events: events.sort((a, b) => compareUids(a.uid, b.uid)) };
}

/** Generated items by event UID, each group ordered by item uid (the first is kept). */
function generatedItems(items: BirthdaySnapshotItem[]): Map<string, BirthdaySnapshotItem[]> {
  const groups = new Map<string, BirthdaySnapshotItem[]>();
  for (const item of items) {
    const uid = item.content === null ? undefined : parseBirthdayEventFields(item.content)?.uid;
    if (!uid || !isGeneratedBirthdayUid(uid)) continue;
    groups.set(uid, [...(groups.get(uid) ?? []), item]);
  }
  for (const group of groups.values()) group.sort((a, b) => compareUids(a.itemUid, b.itemUid));
  return groups;
}

/** Generated item uids of a calendar that was listed completely and readably; none otherwise. */
function cleanupOf(calendar: BirthdayCalendarSnapshot): string[] {
  if (!calendar.complete || calendar.items.some((item) => item.content === null)) return [];
  return [...generatedItems(calendar.items).values()].flat().map(({ itemUid }) => itemUid).sort(compareUids);
}

/**
 * What to write so the calendars hold exactly `events`. Only writable calendars count;
 * the active one with the smallest uid is canonical, other active ones are retired, and
 * retired ones lose their generated items. Items that are not generated are never touched.
 */
export function planBirthdayCalendar(events: BirthdayEvent[], calendars: BirthdayCalendarSnapshot[]): BirthdayPlanResult {
  const writable = calendars.filter((calendar) => calendar.writable).sort((a, b) => compareUids(a.uid, b.uid));
  const [canonical, ...others] = writable.filter((calendar) => calendar.state === 'active');
  const retiring = others.map(({ uid }) => uid);
  const plan: BirthdayCalendarPlan = {
    canonical: canonical?.uid ?? null, create: [], update: [], remove: [], retire: retiring, cleanup: [],
  };
  for (const calendar of writable) {
    if (calendar === canonical) continue;
    const itemUids = cleanupOf(calendar);
    if (itemUids.length > 0) plan.cleanup.push({ calendarUid: calendar.uid, itemUids });
  }
  if (!canonical) return { kind: 'plan', plan };
  if (!canonical.complete) return { kind: 'skip', reason: 'incomplete-calendar' };
  if (canonical.items.some((item) => item.content === null)) return { kind: 'skip', reason: 'unreadable-calendar-item' };

  const wanted = new Map(events.map((event) => [event.uid, event]));
  const existing = generatedItems(canonical.items);
  for (const [uid, [kept, ...extra]] of existing) {
    plan.remove.push(...extra.map(({ itemUid }) => itemUid));
    const event = wanted.get(uid);
    if (!event) plan.remove.push(kept!.itemUid);
    else if (!isCurrentBirthdayEvent(kept!.content!, event)) plan.update.push({ itemUid: kept!.itemUid, event });
  }
  plan.create = [...wanted.values()].filter(({ uid }) => !existing.has(uid)).sort((a, b) => compareUids(a.uid, b.uid));
  plan.update.sort((a, b) => compareUids(a.itemUid, b.itemUid));
  plan.remove.sort(compareUids);
  return { kind: 'plan', plan };
}

/** The post-commit source check: did contacts change since this run read them? */
export interface BirthdayPostCheck {
  /** The check itself finished. */
  complete: boolean;
  inventoryChanged: boolean;
  changedBooks: string[];
}

export const BIRTHDAY_MAX_RERUNS = 2;

/** After a committed run: done, run again from fresh reads, or leave it pending for the next trigger. */
export function decideAfterBirthdayRun(check: BirthdayPostCheck, rerunsSoFar: number): 'done' | 'rerun' | 'pending' {
  if (!check.complete) return 'pending';
  if (!check.inventoryChanged && check.changedBooks.length === 0) return 'done';
  return rerunsSoFar < BIRTHDAY_MAX_RERUNS ? 'rerun' : 'pending';
}
