import { AccountBoundaryChangedError, assertCurrentAccountEpoch, getAccountEpoch, isCurrentAccountEpoch } from '@/app/lib/account-epoch'
import type { OfflineQueueAccountGuard } from '@/app/lib/offline-queue'

interface ActiveAccountState {
  account: unknown | null
  accountFingerprint: string | null
}

/** Capture queue ownership synchronously. Missing identity fails closed. */
export function captureOfflineQueueAccountGuard(
  state: ActiveAccountState,
): OfflineQueueAccountGuard | null {
  if (!state.account || !state.accountFingerprint) return null
  // A logout in another tab ends this account before anything is sent for it.
  const accountEpoch = getAccountEpoch()
  if (!isCurrentAccountEpoch(accountEpoch)) return null
  return {
    accountEpoch,
    accountFingerprint: state.accountFingerprint,
  }
}

/** Assert both the epoch and stable account identity at a publication boundary. */
export function assertOfflineQueueAccountGuard(
  guard: OfflineQueueAccountGuard,
  state: ActiveAccountState,
): void {
  assertCurrentAccountEpoch(guard.accountEpoch)
  if (!state.account || state.accountFingerprint !== guard.accountFingerprint) {
    throw new AccountBoundaryChangedError()
  }
}

export function isOfflineQueueBoundaryCancellation(error: unknown): boolean {
  return error instanceof AccountBoundaryChangedError
}
