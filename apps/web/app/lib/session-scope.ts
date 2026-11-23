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

export function getSessionScope(): SessionScope {
  return sessionScope
}

export function setSessionScope(scope: SessionScope): void {
  sessionScope = scope
}

interface TabSessionRecord {
  /** The logout generation when it was written; any later logout voids it. */
  generation: string | null
  session: string
}

function currentLogoutGeneration(): string | null {
  return readLogoutGeneration() ?? null
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

/**
 * This tab's session copy, only while no logout happened anywhere since it was
 * written. A stale or unreadable copy is removed with this tab's names.
 */
export function readTabSession(): string | null {
  let raw: string | null
  try {
    raw = tabStorage()?.getItem(TAB_SESSION_KEY) ?? null
  } catch {
    return null
  }
  if (raw === null) return null
  try {
    const record = JSON.parse(raw) as Partial<TabSessionRecord>
    if (typeof record.session === 'string' && record.session
      && (record.generation ?? null) === currentLogoutGeneration()) return record.session
  } catch {
    // Unreadable: treated as stale below.
  }
  removeTabMaterial()
  return null
}

export function writeTabSession(value: string): void {
  const storage = tabStorage()
  if (!storage) throw new Error('Tab storage is not available')
  const record: TabSessionRecord = { generation: currentLogoutGeneration(), session: value }
  storage.setItem(TAB_SESSION_KEY, JSON.stringify(record))
}

export function removeTabSession(): void {
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
