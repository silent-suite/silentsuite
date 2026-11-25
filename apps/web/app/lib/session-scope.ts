/**
 * Where a signed-in browser keeps the Etebase session and decrypted names.
 *
 * With "Keep me signed in on this device" off, the session lives only in this
 * tab's sessionStorage, never in IndexedDB, and decrypted collection and label
 * names follow it there instead of localStorage. Browsers delete sessionStorage
 * when the tab closes (session restore can keep it longer), so this shrinks the
 * on-disk exposure rather than removing it.
 */
import type { StateStorage } from 'zustand/middleware'
import { readLogoutGeneration } from '@/app/lib/account-epoch'

/** This tab's copy of the Etebase session when the device is not remembered. */
export const TAB_SESSION_KEY = 'silentsuite-tab-etebase-session'

/**
 * Where this tab may read and write its Etebase session, decided by the auth
 * store from a verified sign-in, restore or refresh before any account is
 * published: 'device' (IndexedDB) for self-hosted and Billing-confirmed
 * remembered devices, 'tab' otherwise, null while undecided or signed out.
 * It lives in memory only, so every page load decides again.
 */
export type SessionScope = 'tab' | 'device' | null
let sessionScope: SessionScope = null
/**
 * For 'device': the Billing user the stored session must belong to, checked on
 * every read; null for self-hosted, which has no Billing owner.
 */
let deviceOwner: string | null = null

export function getSessionScope(): SessionScope {
  return sessionScope
}

export function getDeviceOwner(): string | null {
  return deviceOwner
}

const scopedStores = new Set<() => unknown>()

/**
 * Name stores hydrate when they are created, before the scope is known. Each
 * registers its rehydrate function, which runs whenever the scope moves to or
 * from 'device', so a remembered or self-hosted reload reads its saved names.
 */
export function registerScopedStore(rehydrate: () => unknown): void {
  scopedStores.add(rehydrate)
}

export function setSessionScope(scope: SessionScope, owner: string | null = null): void {
  const previous = sessionScope
  sessionScope = scope
  deviceOwner = scope === 'device' ? owner : null
  if (previous === scope || (previous !== 'device' && scope !== 'device')) return
  for (const rehydrate of scopedStores) {
    try {
      void rehydrate()
    } catch {
      // A store that can't rehydrate keeps its in-memory state.
    }
  }
}

/**
 * The server identity a saved session was last confirmed for (server `whoami`),
 * kept with the session in the same place and replaced or removed with it.
 */
export interface SessionIdentity {
  id: number
  loginVersion: number
  username: string
}

export function isSessionIdentity(value: unknown): value is SessionIdentity {
  const v = value as Partial<SessionIdentity> | null
  return typeof v === 'object' && v !== null
    && Number.isSafeInteger(v.id) && (v.id as number) > 0
    && Number.isSafeInteger(v.loginVersion) && (v.loginVersion as number) >= 0
    && typeof v.username === 'string' && v.username.length > 0
}

interface TabSessionRecord {
  /** The logout generation when it was written; any later logout voids it. */
  generation: string | null
  /** The Billing user this copy was confirmed for; null until confirmed. */
  owner: string | null
  session: string
  /** Absent until the first confirmed `whoami` for this session. */
  identity?: SessionIdentity
}

/** The current logout generation, or undefined when it can't be read. */
function currentLogoutGeneration(): string | null | undefined {
  try {
    return readLogoutGeneration()
  } catch {
    return undefined
  }
}

/** Persisted stores that hold decrypted collection or label names. */
export const NAME_STORE_KEYS = [
  'silentsuite-calendar-lists',
  'silentsuite-task-lists',
  'silentsuite-contact-lists',
  'silentsuite-notebooks',
  'silentsuite-label-colors',
] as const

function tabStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

function deviceStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function readTabRecord(): TabSessionRecord | null {
  let raw: string | null
  try {
    raw = tabStorage()?.getItem(TAB_SESSION_KEY) ?? null
  } catch {
    return null
  }
  if (raw === null) return null
  try {
    const record = JSON.parse(raw) as Partial<TabSessionRecord>
    const generation = currentLogoutGeneration()
    if (typeof record.session === 'string' && record.session
      && generation !== undefined && record.generation === generation
      && (record.owner === null || typeof record.owner === 'string')) {
      const identity = isSessionIdentity(record.identity) ? { identity: record.identity } : {}
      return { generation: record.generation, owner: record.owner, session: record.session, ...identity }
    }
  } catch {
    // Unreadable: treated as stale below.
  }
  removeTabMaterial()
  return null
}

/**
 * This tab's session copy, only while no logout happened anywhere since it was
 * written (an unreadable generation counts as changed). A stale or unreadable
 * copy is removed with this tab's names.
 */
export function readTabSession(): string | null {
  return readTabRecord()?.session ?? null
}

/** This tab's session copy together with the identity saved beside it. */
export function readTabSessionWithIdentity(): { session: string; identity: SessionIdentity | null } | null {
  const record = readTabRecord()
  return record ? { session: record.session, identity: record.identity ?? null } : null
}

/** The Billing user this tab's copy was confirmed for, or null. */
export function readTabSessionOwner(): string | null {
  return readTabRecord()?.owner ?? null
}

/**
 * Write this tab's copy, replacing any earlier one. The old copy is removed
 * first, so a failed write never leaves it readable.
 */
export function writeTabSession(value: string, owner: string | null = null, identity: SessionIdentity | null = null): void {
  removeTabSession()
  const storage = tabStorage()
  if (!storage) throw new Error('Tab storage is not available')
  const generation = currentLogoutGeneration()
  if (generation === undefined) throw new Error('The logout generation is not readable')
  const record: TabSessionRecord = { generation, owner, session: value, ...(identity ? { identity } : {}) }
  storage.setItem(TAB_SESSION_KEY, JSON.stringify(record))
}

/**
 * Records the Billing user a fresh copy was confirmed for, only if the copy is
 * still the session that sign-in saved. A copy already bound to someone else
 * belongs to an earlier sign-in and is removed.
 */
export function bindTabSession(owner: string, expectedSession: string): void {
  const record = readTabRecord()
  if (!record || record.session !== expectedSession) return
  if (record.owner !== null && record.owner !== owner) {
    removeTabMaterial()
    return
  }
  try {
    tabStorage()?.setItem(TAB_SESSION_KEY, JSON.stringify({ ...record, owner }))
  } catch {
    // Unbound copies are rejected at the next restore, which then asks to unlock.
  }
}

let tabSessionChanges = 0

/**
 * How many times this tab's session copy has been written or removed since the
 * page loaded (every call counts, even when nothing was stored). Lets a
 * pending durable save see that a later operation in this tab took over.
 */
export function tabSessionChangeCount(): number {
  return tabSessionChanges
}

export function removeTabSession(): void {
  tabSessionChanges += 1
  try {
    tabStorage()?.removeItem(TAB_SESSION_KEY)
  } catch {
    // Unavailable storage holds nothing to remove.
  }
}

/** Remove this tab's session copy and decrypted names (not this tab's account any more). */
export function removeTabMaterial(): void {
  removeTabSession()
  removeTabNames()
}

/** Drop decrypted names from localStorage; the in-memory stores keep them. */
export function removePersistentNames(): void {
  const storage = deviceStorage()
  for (const key of NAME_STORE_KEYS) {
    try {
      storage?.removeItem(key)
    } catch {
      // Best effort; the next store write lands in tab storage.
    }
  }
}

/** Drop decrypted names from this tab's sessionStorage (logout). */
export function removeTabNames(): void {
  const storage = tabStorage()
  for (const key of NAME_STORE_KEYS) {
    try {
      storage?.removeItem(key)
    } catch {
      // Best effort.
    }
  }
}

/**
 * zustand storage for stores holding decrypted names: localStorage only while
 * this tab's session scope is 'device', sessionStorage otherwise (including
 * before the scope is decided and while signed out). A write also removes the
 * key from the other storage.
 */
export const tabScopedStateStorage: StateStorage = {
  getItem: (name) => {
    const target = sessionScope === 'device' ? deviceStorage() : tabStorage()
    try {
      return target?.getItem(name) ?? null
    } catch {
      return null
    }
  },
  setItem: (name, value) => {
    const onDevice = sessionScope === 'device'
    const target = onDevice ? deviceStorage() : tabStorage()
    const other = onDevice ? tabStorage() : deviceStorage()
    try {
      target?.setItem(name, value)
    } catch {
      // Quota or unavailable storage: the in-memory store stays authoritative.
    }
    try {
      other?.removeItem(name)
    } catch {
      // Best effort.
    }
  },
  removeItem: (name) => {
    for (const storage of [tabStorage(), deviceStorage()]) {
      try {
        storage?.removeItem(name)
      } catch {
        // Best effort.
      }
    }
  },
}
