/**
 * Explicit Birthdays on/off (#738).
 *
 * Enable reuses a qualifying active calendar or creates a private one, then
 * uses runBirthdayCalendar. Disable retires every qualifying active calendar
 * and does not delete collections. Neither path invites anyone or edits contacts.
 */
import { birthdayMarkerContent, parseBirthdayMarker, planBirthdayCalendar } from '@silentsuite/core'
import { runBirthdayCalendar, type BirthdayRunInput } from './orchestrate'
import type { BirthdayListedCollection, BirthdayReconcileResult, BirthdayTransport } from './reconcile'

const BIRTHDAY_CALENDAR_NAME = 'Birthdays'

function blocked(gates: BirthdayRunInput['gates']): string | null {
  if (!gates.isCurrentEpoch()) return 'stale-account'
  if (!gates.isOnline()) return 'offline'
  if (!gates.canWrite()) return 'read-only'
  if (!gates.hasSubtleCrypto()) return 'no-subtle-crypto'
  return null
}

function failed(reason: string): BirthdayReconcileResult {
  return { status: 'failed', reason, sourceTokens: null }
}

function isQualifying(calendar: BirthdayListedCollection, username: string, state: 'active' | 'retired'): boolean {
  return calendar.kind === 'calendar'
    && calendar.accessLevel === 'admin'
    && calendar.membersComplete
    && calendar.members.length === 1
    && calendar.members[0] === username
    && parseBirthdayMarker(calendar.content) === state
}

export async function enableBirthdayCalendar(input: BirthdayRunInput): Promise<BirthdayReconcileResult> {
  try {
    const closed = blocked(input.gates)
    if (closed) return { status: 'skipped', reason: closed, sourceTokens: null }
    const inventory = await input.transport.listInventory()
    const afterList = blocked(input.gates)
    if (afterList) return { status: 'skipped', reason: afterList, sourceTokens: null }
    if (!inventory.complete) return failed('incomplete-inventory')
    if (inventory.collections.some((calendar) => calendar.kind === 'calendar' && calendar.content === null)) {
      return failed('unreadable-calendar')
    }
    if (inventory.collections.some((calendar) => calendar.kind === 'calendar' && calendar.accessLevel === 'admin' && parseBirthdayMarker(calendar.content) === 'active' && !calendar.membersComplete)) {
      return failed('incomplete-members')
    }
    if (inventory.collections.some((calendar) => isQualifying(calendar, input.username, 'active'))) {
      return runBirthdayCalendar(input)
    }
    if (!input.transport.createBirthdayCalendar) return failed('create-unavailable')
    const beforeCreate = blocked(input.gates)
    if (beforeCreate) return { status: 'skipped', reason: beforeCreate, sourceTokens: null }
    const created = await input.transport.createBirthdayCalendar({
      name: BIRTHDAY_CALENDAR_NAME,
      content: birthdayMarkerContent('active'),
    })
    const afterCreate = blocked(input.gates)
    if (afterCreate) return { status: 'pending', reason: afterCreate, sourceTokens: null }
    if (created.kind !== 'created') return { status: 'pending', reason: created.kind, sourceTokens: null }
    return runBirthdayCalendar(input)
  } catch {
    return failed('reconcile-failed')
  }
}

export async function disableBirthdayCalendar(input: BirthdayRunInput): Promise<BirthdayReconcileResult> {
  try {
    const closed = blocked(input.gates)
    if (closed) return { status: 'skipped', reason: closed, sourceTokens: null }
    const inventory = await input.transport.listInventory()
    const afterList = blocked(input.gates)
    if (afterList) return { status: 'skipped', reason: afterList, sourceTokens: null }
    if (!inventory.complete) return failed('incomplete-inventory')
    if (inventory.collections.some((calendar) => calendar.kind === 'calendar' && calendar.content === null)) {
      return failed('unreadable-calendar')
    }
    const marked = inventory.collections.filter((calendar) => calendar.kind === 'calendar' && parseBirthdayMarker(calendar.content))
    if (marked.some((calendar) => calendar.accessLevel === 'admin' && !calendar.membersComplete)) {
      return failed('incomplete-members')
    }
    const active = inventory.collections.filter((calendar) => isQualifying(calendar, input.username, 'active'))
    const retired = inventory.collections.filter((calendar) => isQualifying(calendar, input.username, 'retired'))
    const reads = new Map<string, { calendar: BirthdayListedCollection; items: Array<{ itemUid: string; content: string | null }> }>()
    for (const calendar of [...active, ...retired]) {
      const before = blocked(input.gates)
      if (before) return { status: 'skipped', reason: before, sourceTokens: null }
      const page = await input.transport.listItems(calendar.uid)
      const after = blocked(input.gates)
      if (after) return { status: 'skipped', reason: after, sourceTokens: null }
      if (!page.complete) return failed('incomplete-calendar')
      if (page.items.some((item) => item.content === null)) return failed('unreadable-calendar-item')
      reads.set(calendar.uid, { calendar, items: page.items })
    }
    for (const calendar of active) {
      const read = reads.get(calendar.uid)
      if (!read || !input.transport.retireCalendar) return failed('retirement-not-implemented')
      const before = blocked(input.gates)
      if (before) return { status: 'skipped', reason: before, sourceTokens: null }
      const retiredMarker = await input.transport.retireCalendar({
        collectionUid: calendar.uid,
        rootRevision: calendar.rootRevision,
        root: calendar.root,
        content: birthdayMarkerContent('retired'),
      })
      const after = blocked(input.gates)
      if (after) return { status: 'pending', reason: after, sourceTokens: null }
      if (retiredMarker.kind !== 'retired') return { status: 'pending', reason: retiredMarker.kind, sourceTokens: null }
      const cleaned = await deleteGenerated(input.transport, input.gates, calendar.uid, retiredMarker.rootRevision, retiredMarker.root, read.items)
      if (cleaned) return cleaned
    }
    for (const calendar of retired) {
      const read = reads.get(calendar.uid)
      if (!read) return failed('incomplete-calendar')
      const cleaned = await deleteGenerated(input.transport, input.gates, calendar.uid, calendar.rootRevision, calendar.root, read.items)
      if (cleaned) return cleaned
    }
    return { status: 'done', sourceTokens: { inventoryToken: inventory.inventoryToken, books: [] } }
  } catch {
    return failed('reconcile-failed')
  }
}

async function deleteGenerated(
  transport: BirthdayTransport,
  gates: BirthdayRunInput['gates'],
  collectionUid: string,
  rootRevision: string,
  root: unknown,
  items: Array<{ itemUid: string; content: string | null }>,
): Promise<BirthdayReconcileResult | null> {
  const planned = planBirthdayCalendar([], [{
    uid: collectionUid,
    state: 'retired',
    writable: true,
    complete: true,
    items,
  }])
  if (planned.kind === 'skip') return failed(planned.reason)
  const itemUids = planned.plan.cleanup.find((entry) => entry.calendarUid === collectionUid)?.itemUids ?? []
  if (itemUids.length === 0) return null
  const before = blocked(gates)
  if (before) return { status: 'skipped', reason: before, sourceTokens: null }
  const outcome = await transport.applyChanges({
    collectionUid,
    rootRevision,
    root,
    changes: itemUids.map((itemUid) => ({ op: 'remove', itemUid })),
  })
  const after = blocked(gates)
  if (outcome !== 'saved') return { status: 'pending', reason: outcome, sourceTokens: null }
  if (after) return { status: 'pending', reason: after, sourceTokens: null }
  return null
}
