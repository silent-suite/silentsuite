import { getAll as getQueuedMutations } from '@/app/lib/offline-queue'
import { getAccountEpoch, isCurrentAccountEpoch } from '@/app/lib/account-epoch'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { countNoteTextOnlyInPage } from '@/app/stores/use-note-store'

/** The account a sign-out check was made for: this tab's account epoch and Etebase fingerprint. */
export interface SignOutAccount {
  accountEpoch: number
  accountFingerprint: string | null
}

export function captureSignOutAccount(): SignOutAccount {
  return { accountEpoch: getAccountEpoch(), accountFingerprint: useEtebaseStore.getState().accountFingerprint }
}

/** Whether the tab still has the exact account the check was made for. */
export function isSignOutAccountCurrent(account: SignOutAccount): boolean {
  return isCurrentAccountEpoch(account.accountEpoch) && useEtebaseStore.getState().accountFingerprint === account.accountFingerprint
}

/**
 * Changes only on this device for the account (#1113 D1), which a sign-out
 * deletes: every offline queue record of the account (pending, failed, held,
 * legacy), plus note text that exists only in this page. Null when the queue
 * cannot be read for this account, which the caller treats as having changes.
 */
export async function countLocalOnlyChanges(account: SignOutAccount): Promise<number | null> {
  if (!account.accountFingerprint || !isSignOutAccountCurrent(account)) return null
  try {
    const records = await getQueuedMutations({ accountEpoch: account.accountEpoch, accountFingerprint: account.accountFingerprint })
    if (!isSignOutAccountCurrent(account)) return null
    return records.length + countNoteTextOnlyInPage()
  } catch {
    return null
  }
}
