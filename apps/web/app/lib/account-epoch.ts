let accountEpoch = 0

/**
 * Non-secret marker that only an explicit logout writes and nothing removes, so
 * an open tab can tell that a logout happened in another tab even after a newer
 * login there. A session rewrite of the same account never changes it.
 */
export const LOGOUT_GENERATION_KEY = 'silentsuite-logout-generation'

/**
 * The generation this tab's account was bound under, for the epoch it was bound
 * in; null while none is bound. Any later boundary ends the binding.
 */
let ownedGeneration: { value: string | null; epoch: number } | null = null
let logoutElsewhereHandler: (() => void) | null = null
let logoutElsewhereScheduled = false

/** The stored generation, or undefined when storage cannot be read (SSR, blocked storage). */
export function readLogoutGeneration(): string | null | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined
    return localStorage.getItem(LOGOUT_GENERATION_KEY)
  } catch {
    return undefined
  }
}

/** Writes a fresh generation and returns what storage now holds. */
export function writeLogoutGeneration(): string | null | undefined {
  try {
    localStorage.setItem(LOGOUT_GENERATION_KEY, `${Date.now()}-${Math.random().toString(36).slice(2)}`)
  } catch {
    // An unwritable store cannot signal other tabs; the value read back stays authoritative.
  }
  return readLogoutGeneration()
}

/** Binds the current epoch's account to `value`; an unreadable value binds nothing. */
export function establishLogoutGeneration(value: string | null | undefined): void {
  ownedGeneration = value === undefined ? null : { value, epoch: accountEpoch }
  logoutElsewhereScheduled = false
}

export function releaseLogoutGeneration(): void {
  ownedGeneration = null
  logoutElsewhereScheduled = false
}

/** The bound generation, compared by identity so a later binding is never mistaken for it. */
export function boundLogoutGeneration(): object | null {
  return ownedGeneration
}

/** True only while an account is bound and another tab has since logged out. */
export function hasLostLogoutGeneration(): boolean {
  if (!ownedGeneration || ownedGeneration.epoch !== accountEpoch) return false
  const current = readLogoutGeneration()
  return current !== undefined && current !== ownedGeneration.value
}

/** The one handler told, outside the caller's stack, that the bound generation was lost. */
export function onLogoutElsewhere(handler: () => void): () => void {
  logoutElsewhereHandler = handler
  return () => {
    if (logoutElsewhereHandler === handler) logoutElsewhereHandler = null
  }
}

function generationHeld(): boolean {
  if (!hasLostLogoutGeneration()) return true
  const handler = logoutElsewhereHandler
  if (handler && !logoutElsewhereScheduled) {
    logoutElsewhereScheduled = true
    queueMicrotask(() => {
      if (logoutElsewhereHandler === handler) handler()
    })
  }
  return false
}

export function getAccountEpoch(): number {
  return accountEpoch
}

export function bumpAccountEpoch(): number {
  accountEpoch += 1
  return accountEpoch
}

export function isCurrentAccountEpoch(epoch: number): boolean {
  return epoch === accountEpoch && generationHeld()
}

export class AccountBoundaryChangedError extends Error {
  constructor() {
    super('Account boundary changed while account-scoped work was in flight')
    this.name = 'AccountBoundaryChangedError'
  }
}

export function assertCurrentAccountEpoch(epoch: number): void {
  if (!isCurrentAccountEpoch(epoch)) throw new AccountBoundaryChangedError()
}
