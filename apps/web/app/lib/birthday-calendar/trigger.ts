/**
 * Requests a Birthdays run from a contact or collection caller (#738).
 *
 * Fire and forget: it never throws or rejects into the caller and is never
 * awaited, so a birthday failure (or a chunk that fails to load) cannot turn a
 * successful contact sync, save or initialization into a failure.
 *
 * Birthdays is an experimental opt-in: while it is off for the current account
 * this does nothing and no Birthdays session code is loaded.
 */
import { isCurrentAccountEpoch } from '@/app/lib/account-epoch'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { isBirthdaysEnabledFor } from '@/app/stores/use-experimental-store'

export function requestBirthdayReconcile(accountEpoch: number): void {
  if (!isCurrentAccountEpoch(accountEpoch)) return
  try {
    if (!isBirthdaysEnabledFor(useEtebaseStore.getState().accountFingerprint)) return
  } catch {
    return
  }
  void import('./session')
    .then(({ scheduleBirthdayReconcile }) => {
      if (isCurrentAccountEpoch(accountEpoch)) scheduleBirthdayReconcile()
    })
    .catch(() => {
      // Birthday generation never changes the caller's result.
    })
}
