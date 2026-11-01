/**
 * Account-scoped Birthdays trigger for the web app.
 *
 * The encrypted collection marker is the consent. This module does not store
 * an enable flag, and it does not toast or publish when the captured account
 * is no longer current.
 */
import { deserializeCalendarEvent } from '@silentsuite/core'
import { getAccountEpoch, isCurrentAccountEpoch } from '@/app/lib/account-epoch'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { useCalendarStore } from '@/app/stores/use-calendar-store'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useSyncStore } from '@/app/stores/use-sync-store'
import { createEtebaseBirthdayTransport } from './etebase-transport'
import { disableBirthdayCalendar, enableBirthdayCalendar } from './lifecycle'
import {
  projectBirthdayMarkers,
  resetBirthdayMarkers,
  selectManagedBirthdayCalendarIds,
  publishBirthdayQualifying,
  selectQualifyingBirthdayCalendarIds,
  useBirthdayMarkerStore,
  type QualifyingInventory,
} from './markers'
import { runBirthdayCalendar } from './orchestrate'
import type { BirthdayGates, BirthdayTransport } from './reconcile'

const DEBOUNCE_MS = 5000
/** Transport calls that can change the server; any attempt means the visible calendars may be stale. */
const MUTATING = new Set<PropertyKey>(['applyChanges', 'retireCalendar', 'createBirthdayCalendar'])

type Origin = {
  epoch: number
  fingerprint: string
  account: object
  username: string
}

let timer: ReturnType<typeof setTimeout> | null = null
let pendingEpoch: number | null = null

/** Wraps the transport so the caller learns whether this run attempted any server write. */
function recordingWrites(transport: BirthdayTransport): { transport: BirthdayTransport; wrote: () => boolean } {
  let wrote = false
  const wrapped = new Proxy(transport, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      if (!MUTATING.has(prop)) return value.bind(target)
      return (...args: unknown[]) => {
        wrote = true
        return value.apply(target, args)
      }
    },
  })
  return { transport: wrapped, wrote: () => wrote }
}

/**
 * After a run that wrote, publish what the server now holds for this account: the
 * collection listing (which picks up a newly created calendar and re-seeds markers),
 * then the calendar events. Only after a write, so a quiet run never refreshes and the
 * refresh-triggered follow-up run ends the cycle.
 */
async function refreshCalendarsAfterWrite(origin: Origin): Promise<void> {
  if (!sameOrigin(origin)) return
  await useEtebaseStore.getState().reconcileCollections()
  if (!sameOrigin(origin)) return
  await useEtebaseStore.getState().refreshCollection('calendar')
  if (!sameOrigin(origin)) return
  const items = await useEtebaseStore.getState().fetchAllItems('calendar', origin.epoch)
  if (!sameOrigin(origin)) return
  const events = []
  for (const item of items) {
    try {
      events.push({ ...deserializeCalendarEvent(item.content), id: item.uid, calendarId: item.collectionUid })
    } catch {
      // An item that does not parse is left out; it must not hide the others.
    }
  }
  if (!sameOrigin(origin)) return
  useCalendarStore.getState().syncFromRemote(events)
}

function hasSubtleCrypto(): boolean {
  return Boolean(globalThis.crypto?.subtle)
}

function capture(): Origin | null {
  const live = useEtebaseStore.getState()
  const username = live.account?.user?.username
  if (!live.account || !live.accountFingerprint || typeof username !== 'string' || username.length === 0) return null
  return { epoch: getAccountEpoch(), fingerprint: live.accountFingerprint, account: live.account, username }
}

function sameOrigin(origin: Origin): boolean {
  const live = useEtebaseStore.getState()
  return isCurrentAccountEpoch(origin.epoch)
    && live.account === origin.account
    && live.accountFingerprint === origin.fingerprint
}

function gatesFor(origin: Origin): BirthdayGates {
  return {
    accountEpoch: origin.epoch,
    isCurrentEpoch: () => sameOrigin(origin),
    canWrite: () => useAuthStore.getState().canWrite(),
    isOnline: () => useSyncStore.getState().isOnline,
    hasSubtleCrypto,
  }
}

function ready(origin: Origin): boolean {
  return sameOrigin(origin) && useAuthStore.getState().canWrite() && useSyncStore.getState().isOnline && hasSubtleCrypto()
}

/** Debounced passive run. A newer schedule for the same process replaces the pending one. */
export function scheduleBirthdayReconcile(): void {
  const origin = capture()
  if (!origin || !ready(origin)) return
  if (timer) clearTimeout(timer)
  pendingEpoch = origin.epoch
  timer = setTimeout(() => {
    timer = null
    if (pendingEpoch !== origin.epoch) return
    pendingEpoch = null
    void runOrigin(origin)
  }, DEBOUNCE_MS)
}

async function runOrigin(origin: Origin): Promise<void> {
  if (!ready(origin)) return
  try {
    const recorded = recordingWrites(createEtebaseBirthdayTransport(origin.account as never, gatesFor(origin)))
    if (!ready(origin)) return
    await runBirthdayCalendar({
      accountKey: origin.fingerprint,
      username: origin.username,
      gates: gatesFor(origin),
      transport: recorded.transport,
    })
    if (!sameOrigin(origin)) return
    if (recorded.wrote()) await refreshCalendarsAfterWrite(origin)
    if (!sameOrigin(origin)) return
    await projectMarkers(origin)
    await projectQualifying(origin, recorded.transport)
  } catch {
    // A birthday failure must not surface as a contact-sync or toast failure.
  }
}

/** Publishes qualifying consent from the adapter's fresh inventory (with membership) for this account. */
async function projectQualifying(origin: Origin, transport: BirthdayTransport): Promise<void> {
  if (!sameOrigin(origin)) return
  let inventory: QualifyingInventory | null = null
  try {
    inventory = (await transport.listInventory()) ?? null
  } catch {
    inventory = null
  }
  publishBirthdayQualifying({ epoch: origin.epoch, fingerprint: origin.fingerprint, isCurrent: () => sameOrigin(origin) }, origin.username, inventory)
}

/** Re-reads the content markers of this account's listed calendars into the reactive projection. */
async function projectMarkers(origin: Origin): Promise<void> {
  await projectBirthdayMarkers({
    epoch: origin.epoch,
    fingerprint: origin.fingerprint,
    isCurrent: () => sameOrigin(origin),
  }, useEtebaseStore.getState().collections?.calendar ?? [])
}

/** Managed (active Birthdays) calendar ids for the current account; a stable, shared list. */
export function managedBirthdayCalendarIds(): readonly string[] {
  return selectManagedBirthdayCalendarIds(
    useBirthdayMarkerStore.getState().snapshot, getAccountEpoch(), useEtebaseStore.getState().accountFingerprint)
}

/** Kept for existing callers: same as managedBirthdayCalendarIds. */
export function birthdayActiveCalendarIds(): string[] {
  return [...managedBirthdayCalendarIds()]
}

/** Whether a calendar is a managed Birthdays calendar for the current account. */
export function isManagedBirthdayCalendar(calendarId: string | null | undefined): boolean {
  return Boolean(calendarId) && managedBirthdayCalendarIds().includes(calendarId!)
}

/** React hook: this account's verified qualifying Birthdays calendars (generation is on). */
export function useQualifyingBirthdayCalendarIds(): readonly string[] {
  const snapshot = useBirthdayMarkerStore((state) => state.snapshot)
  const fingerprint = useEtebaseStore((state) => state.accountFingerprint)
  return selectQualifyingBirthdayCalendarIds(snapshot, getAccountEpoch(), fingerprint)
}

/** React hook for the UI: re-renders when this account's managed calendars change. */
export function useManagedBirthdayCalendarIds(): readonly string[] {
  const snapshot = useBirthdayMarkerStore((state) => state.snapshot)
  const fingerprint = useEtebaseStore((state) => state.accountFingerprint)
  return selectManagedBirthdayCalendarIds(snapshot, getAccountEpoch(), fingerprint)
}

/** Drop a leaving account's debounce and marker projection. A newer epoch is left alone. */
export function resetBirthdayProjection(epoch: number): void {
  if (timer && pendingEpoch === epoch) {
    clearTimeout(timer)
    timer = null
    pendingEpoch = null
  }
  resetBirthdayMarkers(epoch)
}

export async function enableBirthdayCalendarFromSession(): Promise<{ status: string }> {
  const origin = capture()
  if (!origin || !ready(origin)) return { status: 'skipped' }
  try {
    const recorded = recordingWrites(createEtebaseBirthdayTransport(origin.account as never, gatesFor(origin)))
    if (!ready(origin)) return { status: 'skipped' }
    const result = await enableBirthdayCalendar({
      accountKey: origin.fingerprint,
      username: origin.username,
      gates: gatesFor(origin),
      transport: recorded.transport,
    })
    if (recorded.wrote()) await refreshCalendarsAfterWrite(origin)
    if (sameOrigin(origin)) await projectMarkers(origin)
    await projectQualifying(origin, recorded.transport)
    return { status: result.status }
  } catch {
    return { status: 'failed' }
  }
}

export async function disableBirthdayCalendarFromSession(): Promise<{ status: string }> {
  const origin = capture()
  if (!origin || !ready(origin)) return { status: 'skipped' }
  try {
    const recorded = recordingWrites(createEtebaseBirthdayTransport(origin.account as never, gatesFor(origin)))
    if (!ready(origin)) return { status: 'skipped' }
    const result = await disableBirthdayCalendar({
      accountKey: origin.fingerprint,
      username: origin.username,
      gates: gatesFor(origin),
      transport: recorded.transport,
    })
    if (recorded.wrote()) await refreshCalendarsAfterWrite(origin)
    if (sameOrigin(origin)) await projectMarkers(origin)
    await projectQualifying(origin, recorded.transport)
    return { status: result.status }
  } catch {
    return { status: 'failed' }
  }
}
