/**
 * Account-scoped projection of which calendars are active Birthdays calendars (#738).
 *
 * Identity comes only from each collection's encrypted content marker, never from
 * its name or a stored flag. Only calendar uids are kept, in memory.
 */
import { create } from 'zustand'
import { parseBirthdayMarker } from '@silentsuite/core'

const CONTENT_AS_STRING = 1

export interface BirthdayMarkerSnapshot {
  epoch: number
  fingerprint: string
  /** Sorted uids of calendars whose content marker is active. */
  activeIds: readonly string[]
  /**
   * Active calendars that are this account's current generation consent: verified
   * Admin with a complete member list of exactly this user. Absent until verified.
   */
  qualifyingIds?: readonly string[]
}

export interface BirthdayMarkerScope {
  epoch: number
  fingerprint: string
  /** Still the same account and session when the projection is published. */
  isCurrent: () => boolean
}

export interface MarkedCollection {
  uid: string
  getContent?: (format?: number) => Promise<unknown>
}

/** Qualifying-consent calendar uids for this account (generation is on), or a shared empty list. */
export function selectQualifyingBirthdayCalendarIds(
  snapshot: BirthdayMarkerSnapshot | null,
  epoch: number,
  fingerprint: string | null,
): readonly string[] {
  return sameScope(snapshot, epoch, fingerprint) ? snapshot.qualifyingIds ?? NO_BIRTHDAY_CALENDARS : NO_BIRTHDAY_CALENDARS
}

function sameIds(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return (a ?? []).length === b.length && b.every((uid, index) => uid === a![index])
}

/** A fresh adapter inventory listing, or null when it could not be read completely. */
export interface QualifyingInventory {
  complete: boolean
  collections: ReadonlyArray<{
    uid: string
    kind: 'calendar' | 'address-book'
    accessLevel: 'admin' | 'readWrite' | 'readOnly'
    content: string | null
    members: readonly string[]
    membersComplete: boolean
  }>
}

/**
 * Publishes this account's qualifying consent from a fresh adapter inventory: an active
 * calendar it administers whose complete member list is exactly `username`. A missing or
 * incomplete inventory changes nothing; a calendar whose content or members could not be
 * read keeps the status this account already had. Never throws.
 */
export function publishBirthdayQualifying(scope: BirthdayMarkerScope, username: string, inventory: QualifyingInventory | null): void {
  try {
    if (!inventory || !inventory.complete || !scope.isCurrent()) return
    const current = useBirthdayMarkerStore.getState().snapshot
    const base = sameScope(current, scope.epoch, scope.fingerprint)
      ? current
      : { epoch: scope.epoch, fingerprint: scope.fingerprint, activeIds: NO_BIRTHDAY_CALENDARS }
    const prior = new Set(base.qualifyingIds ?? [])
    const next: string[] = []
    for (const listed of inventory.collections) {
      if (listed.kind !== 'calendar') continue
      if (listed.content === null || !listed.membersComplete) {
        if (prior.has(listed.uid)) next.push(listed.uid)
        continue
      }
      if (listed.accessLevel === 'admin'
        && listed.members.length === 1
        && listed.members[0] === username
        && parseBirthdayMarker(listed.content) === 'active') next.push(listed.uid)
    }
    next.sort()
    if (sameIds(base.qualifyingIds, next)) return
    useBirthdayMarkerStore.setState({ snapshot: { ...base, qualifyingIds: Object.freeze(next) } })
  } catch {
    // Consent stays as it was.
  }
}

export const useBirthdayMarkerStore = create<{ snapshot: BirthdayMarkerSnapshot | null }>(() => ({ snapshot: null }))

export const NO_BIRTHDAY_CALENDARS: readonly string[] = Object.freeze([])

function sameScope(snapshot: BirthdayMarkerSnapshot | null, epoch: number, fingerprint: string | null): snapshot is BirthdayMarkerSnapshot {
  return Boolean(snapshot && snapshot.epoch === epoch && snapshot.fingerprint === fingerprint)
}

/**
 * Reads each calendar's content marker and publishes the active ones for `scope`.
 * A calendar whose content cannot be read stays protected if this account already
 * knew it as active; it is never newly marked from a failed read. Never throws.
 */
export async function projectBirthdayMarkers(scope: BirthdayMarkerScope, calendars: readonly MarkedCollection[]): Promise<void> {
  try {
    const prior = useBirthdayMarkerStore.getState().snapshot
    const known = new Set(sameScope(prior, scope.epoch, scope.fingerprint) ? prior.activeIds : [])
    const active: string[] = []
    for (const calendar of calendars) {
      let content: string | null
      try {
        const raw = await calendar.getContent?.(CONTENT_AS_STRING)
        content = typeof raw === 'string' ? raw : raw instanceof Uint8Array ? new TextDecoder().decode(raw) : ''
      } catch {
        content = null
      }
      if (content === null ? known.has(calendar.uid) : parseBirthdayMarker(content) === 'active') active.push(calendar.uid)
    }
    if (!scope.isCurrent()) return
    active.sort()
    const current = useBirthdayMarkerStore.getState().snapshot
    if (sameScope(current, scope.epoch, scope.fingerprint)
      && current.activeIds.length === active.length
      && current.activeIds.every((uid, index) => uid === active[index])) return
    // Verified consent carries over for calendars that are still active.
    const qualifyingIds = sameScope(current, scope.epoch, scope.fingerprint) && current.qualifyingIds
      ? Object.freeze(current.qualifyingIds.filter((uid) => active.includes(uid)))
      : undefined
    useBirthdayMarkerStore.setState({
      snapshot: { epoch: scope.epoch, fingerprint: scope.fingerprint, activeIds: Object.freeze(active), ...(qualifyingIds ? { qualifyingIds } : {}) },
    })
  } catch {
    // A projection failure leaves the previous protection in place.
  }
}

/** Managed calendar uids for this account, or a shared empty list. Stable per snapshot. */
export function selectManagedBirthdayCalendarIds(
  snapshot: BirthdayMarkerSnapshot | null,
  epoch: number,
  fingerprint: string | null,
): readonly string[] {
  return sameScope(snapshot, epoch, fingerprint) ? snapshot.activeIds : NO_BIRTHDAY_CALENDARS
}

/** Drop the leaving account's projection; a newer account's is left alone. */
export function resetBirthdayMarkers(epoch: number): void {
  if (useBirthdayMarkerStore.getState().snapshot?.epoch === epoch) useBirthdayMarkerStore.setState({ snapshot: null })
}
