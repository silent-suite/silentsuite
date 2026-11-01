/**
 * Web Birthdays reconciler (#738).
 *
 * Listing and writes go through an injected transport. Event text and the
 * plan come from @silentsuite/core. Extra active calendars are retired before
 * their generated items are deleted. Already-retired calendars lose only
 * generated items, fenced on the root read in this run.
 */

import {
  birthdayEventContent,
  birthdayEventsFromSource,
  birthdayMarkerContent,
  parseBirthdayMarker,
  planBirthdayCalendar,
  type BirthdayCalendarSnapshot,
} from '@silentsuite/core'

export interface BirthdayGates {
  accountEpoch: number
  isCurrentEpoch: () => boolean
  canWrite: () => boolean
  isOnline: () => boolean
  hasSubtleCrypto: () => boolean
}

export interface BirthdayListedCollection {
  uid: string
  kind: 'calendar' | 'address-book'
  accessLevel: 'admin' | 'readWrite' | 'readOnly'
  /** Null when collection content could not be read. */
  content: string | null
  members: string[]
  membersComplete: boolean
  rootRevision: string
  /** Destination collection root to place in the transaction dependency list. */
  root: unknown
}

export interface BirthdayListedItem {
  itemUid: string
  /** Null when the item could not be decrypted or read. */
  content: string | null
  revision: string
}

export type BirthdayItemChange =
  | { op: 'create'; content: string }
  | { op: 'update'; itemUid: string; content: string }
  | { op: 'remove'; itemUid: string }

export interface BirthdayApplyInput {
  collectionUid: string
  rootRevision: string
  root: unknown
  changes: BirthdayItemChange[]
}

export interface BirthdayRetireInput {
  collectionUid: string
  rootRevision: string
  root: unknown
  content: string
}

export type BirthdayRetireResult =
  | { kind: 'retired'; rootRevision: string; root: unknown }
  | { kind: 'conflict' }
  | { kind: 'uncertain' }

export interface BirthdayTransport {
  listInventory(): Promise<{
    complete: boolean
    inventoryToken: string | null
    collections: BirthdayListedCollection[]
  }>
  listItems(collectionUid: string): Promise<{
    complete: boolean
    stoken: string | null
    items: BirthdayListedItem[]
  }>
  applyChanges(input: BirthdayApplyInput): Promise<'saved' | 'conflict' | 'uncertain'>
  /** Conditional marker update. Absent means retirement cannot be performed. */
  retireCalendar?(input: BirthdayRetireInput): Promise<BirthdayRetireResult>
  /**
   * Changes since the tokens captured by the fresh read. Incomplete means the
   * check failed; it is not proof that nothing changed. Must not decrypt contacts.
   */
  checkSourceTokens?(tokens: {
    inventoryToken: string
    books: Array<{ bookUid: string; stoken: string }>
  }): Promise<{ complete: boolean; inventoryChanged: boolean; changedBooks: string[] }>
  /** Local create plus upload of a private marked calendar. No invitation. */
  createBirthdayCalendar?(input: { name: string; content: string }): Promise<
    | { kind: 'created'; collectionUid: string; rootRevision: string; root: unknown }
    | { kind: 'uncertain' }
    | { kind: 'conflict' }
  >
}

export interface BirthdaySourceTokens {
  inventoryToken: string | null
  books: Array<{ bookUid: string; stoken: string | null }>
}

export type BirthdayReconcileResult =
  | { status: 'done'; sourceTokens: BirthdaySourceTokens }
  | { status: 'skipped'; reason: string; sourceTokens: BirthdaySourceTokens | null }
  | { status: 'failed'; reason: string; sourceTokens: BirthdaySourceTokens | null }
  | { status: 'pending'; reason: string; sourceTokens: BirthdaySourceTokens | null }

type GateBlock = 'stale-account' | 'offline' | 'read-only' | 'no-subtle-crypto'

function gateBlock(gates: BirthdayGates): GateBlock | null {
  if (!gates.isCurrentEpoch()) return 'stale-account'
  if (!gates.isOnline()) return 'offline'
  if (!gates.canWrite()) return 'read-only'
  if (!gates.hasSubtleCrypto()) return 'no-subtle-crypto'
  return null
}

function skipped(reason: string, sourceTokens: BirthdaySourceTokens | null = null): BirthdayReconcileResult {
  return { status: 'skipped', reason, sourceTokens }
}

function failed(reason: string, sourceTokens: BirthdaySourceTokens | null = null): BirthdayReconcileResult {
  return { status: 'failed', reason, sourceTokens }
}

async function applyFenced(
  transport: BirthdayTransport,
  gates: BirthdayGates,
  input: BirthdayApplyInput,
  sourceTokens: BirthdaySourceTokens,
): Promise<BirthdayReconcileResult | null> {
  const before = gateBlock(gates)
  if (before) return skipped(before, sourceTokens)
  const outcome = await transport.applyChanges(input)
  const after = gateBlock(gates)
  if (outcome !== 'saved') return { status: 'pending', reason: outcome, sourceTokens }
  if (after) return { status: 'pending', reason: after, sourceTokens }
  return null
}

function isOnlyMember(members: string[], username: string): boolean {
  return members.length === 1 && members[0] === username
}

/**
 * One fresh reconcile. Does not throw: a contact-sync caller can await this
 * without changing the sync result it already recorded.
 */
export async function reconcileBirthdays(input: {
  accountKey: string
  username: string
  gates: BirthdayGates
  transport: BirthdayTransport
}): Promise<BirthdayReconcileResult> {
  try {
    return await reconcileOnce(input)
  } catch {
    return failed('reconcile-failed')
  }
}

async function reconcileOnce(input: {
  accountKey: string
  username: string
  gates: BirthdayGates
  transport: BirthdayTransport
}): Promise<BirthdayReconcileResult> {
  const blocked = gateBlock(input.gates)
  if (blocked) return skipped(blocked)

  const inventory = await input.transport.listInventory()
  const afterInventory = gateBlock(input.gates)
  if (afterInventory) return skipped(afterInventory)
  if (!inventory.complete || inventory.inventoryToken === null) return failed('incomplete-inventory')

  const books = inventory.collections.filter((collection) => collection.kind === 'address-book')
  const calendars = inventory.collections.filter((collection) => collection.kind === 'calendar')

  for (const calendar of calendars) {
    if (calendar.content === null) return failed('unreadable-calendar')
    const marker = parseBirthdayMarker(calendar.content)
    // C3 membership is checked for the active destination only; retired repair needs write access, not members.
    if (marker === 'active' && calendar.accessLevel === 'admin' && !calendar.membersComplete) {
      return failed('incomplete-members')
    }
  }

  const destinations = calendars.filter((calendar) => {
    const marker = parseBirthdayMarker(calendar.content)
    // C3: the active destination is Admin with a complete member list of exactly this user.
    if (marker === 'active') {
      return calendar.accessLevel === 'admin'
        && calendar.membersComplete
        && isOnlyMember(calendar.members, input.username)
    }
    // F3: every retired calendar the user can write to loses its generated items; nothing is created there.
    return marker === 'retired' && (calendar.accessLevel === 'admin' || calendar.accessLevel === 'readWrite')
  })

  const sourceTokens: BirthdaySourceTokens = { inventoryToken: inventory.inventoryToken, books: [] }
  const sourceBooks: Array<{ bookUid: string; complete: boolean; items: Array<{ itemUid: string; content: string | null }> }> = []
  for (const book of books) {
    const afterBookGate = gateBlock(input.gates)
    if (afterBookGate) return skipped(afterBookGate, sourceTokens)
    const page = await input.transport.listItems(book.uid)
    const afterBook = gateBlock(input.gates)
    if (afterBook) return skipped(afterBook, sourceTokens)
    sourceTokens.books.push({ bookUid: book.uid, stoken: page.stoken })
    if (!page.complete || page.stoken === null) return failed('incomplete-book', sourceTokens)
    if (page.items.some((item) => item.content === null)) return failed('unreadable-contact', sourceTokens)
    sourceBooks.push({
      bookUid: book.uid,
      complete: true,
      items: page.items.map((item) => ({ itemUid: item.itemUid, content: item.content })),
    })
  }

  const source = await birthdayEventsFromSource({ inventoryComplete: true, books: sourceBooks })
  const afterSource = gateBlock(input.gates)
  if (afterSource) return skipped(afterSource, sourceTokens)
  if (!source.ok) return failed(source.reason, sourceTokens)

  const snapshots: BirthdayCalendarSnapshot[] = []
  const byUid = new Map<string, BirthdayListedCollection>()
  for (const calendar of destinations) {
    const beforeList = gateBlock(input.gates)
    if (beforeList) return skipped(beforeList, sourceTokens)
    const page = await input.transport.listItems(calendar.uid)
    const afterList = gateBlock(input.gates)
    if (afterList) return skipped(afterList, sourceTokens)
    if (!page.complete) return failed('incomplete-calendar', sourceTokens)
    if (page.items.some((item) => item.content === null)) return failed('unreadable-calendar-item', sourceTokens)
    const state = parseBirthdayMarker(calendar.content)
    if (state !== 'active' && state !== 'retired') return failed('canonical-mismatch', sourceTokens)
    byUid.set(calendar.uid, calendar)
    snapshots.push({
      uid: calendar.uid,
      state,
      writable: true,
      complete: true,
      items: page.items.map((item) => ({ itemUid: item.itemUid, content: item.content })),
    })
  }
  if (snapshots.length === 0) return skipped('feature-off', sourceTokens)

  const planned = planBirthdayCalendar(source.events, snapshots)
  if (planned.kind === 'skip') return failed(planned.reason, sourceTokens)
  const plan = planned.plan
  if (plan.canonical && !byUid.has(plan.canonical)) return failed('canonical-mismatch', sourceTokens)

  for (const uid of plan.retire) {
    const calendar = byUid.get(uid)
    if (!calendar || !input.transport.retireCalendar) return failed('retirement-not-implemented', sourceTokens)
    const beforeRetire = gateBlock(input.gates)
    if (beforeRetire) return skipped(beforeRetire, sourceTokens)
    const retired = await input.transport.retireCalendar({
      collectionUid: uid,
      rootRevision: calendar.rootRevision,
      root: calendar.root,
      content: birthdayMarkerContent('retired'),
    })
    const afterRetire = gateBlock(input.gates)
    if (afterRetire) return { status: 'pending', reason: afterRetire, sourceTokens }
    if (retired.kind !== 'retired') return { status: 'pending', reason: retired.kind, sourceTokens }
    const cleanup = plan.cleanup.find((entry) => entry.calendarUid === uid)
    if (!cleanup || cleanup.itemUids.length === 0) continue
    const cleaned = await applyFenced(input.transport, input.gates, {
      collectionUid: uid,
      rootRevision: retired.rootRevision,
      root: retired.root,
      changes: cleanup.itemUids.map((itemUid) => ({ op: 'remove', itemUid })),
    }, sourceTokens)
    if (cleaned) return cleaned
  }

  for (const entry of plan.cleanup) {
    if (plan.retire.includes(entry.calendarUid) || entry.itemUids.length === 0) continue
    const calendar = byUid.get(entry.calendarUid)
    if (!calendar) return failed('missing-calendar', sourceTokens)
    const cleaned = await applyFenced(input.transport, input.gates, {
      collectionUid: entry.calendarUid,
      rootRevision: calendar.rootRevision,
      root: calendar.root,
      changes: entry.itemUids.map((itemUid) => ({ op: 'remove', itemUid })),
    }, sourceTokens)
    if (cleaned) return cleaned
  }

  const canonical = plan.canonical ? byUid.get(plan.canonical) : undefined
  if (plan.canonical && !canonical) return failed('canonical-mismatch', sourceTokens)
  const changes: BirthdayItemChange[] = canonical ? [
    ...plan.create.map((event) => ({ op: 'create' as const, content: birthdayEventContent(event) })),
    ...plan.update.map((change) => ({ op: 'update' as const, itemUid: change.itemUid, content: birthdayEventContent(change.event) })),
    ...plan.remove.map((itemUid) => ({ op: 'remove' as const, itemUid })),
  ] : []
  if (changes.length === 0 || !canonical) return { status: 'done', sourceTokens }
  const written = await applyFenced(input.transport, input.gates, {
    collectionUid: canonical.uid,
    rootRevision: canonical.rootRevision,
    root: canonical.root,
    changes,
  }, sourceTokens)
  return written ?? { status: 'done', sourceTokens }
}
