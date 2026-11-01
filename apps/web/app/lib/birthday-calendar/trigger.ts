/**
 * Requests a Birthdays run from a contact or collection caller (#738).
 *
 * Fire and forget: it never throws or rejects into the caller and is never
 * awaited, so a birthday failure (or a chunk that fails to load) cannot turn a
 * successful contact sync, save or initialization into a failure.
 */
import { isCurrentAccountEpoch } from '@/app/lib/account-epoch'

export function requestBirthdayReconcile(accountEpoch: number): void {
  if (!isCurrentAccountEpoch(accountEpoch)) return
  void import('./session')
    .then(({ scheduleBirthdayReconcile }) => {
      if (isCurrentAccountEpoch(accountEpoch)) scheduleBirthdayReconcile()
    })
    .catch(() => {
      // Birthday generation never changes the caller's result.
    })
}
