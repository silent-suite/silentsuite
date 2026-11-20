import { getAll as getQueuedMutations } from '@/app/lib/offline-queue'
import { getAccountEpoch, isCurrentAccountEpoch } from '@/app/lib/account-epoch'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { noteIdsWithTextOnlyInPage } from '@/app/stores/use-note-store'

const COUNT_TIMEOUT_MS = 5000

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

/** Changes only on this device for the account, as a sign-out would delete them (#1113 D1). */
export interface LocalOnlyChanges {
  count: number
  /** One key per change: a queue record, or a note whose text is only in this page and has no record. */
  keys: ReadonlySet<string>
}

/**
 * Changes only on this device for the account (#1113 D1), which a sign-out
 * deletes: every offline queue record of the account (pending, failed, held,
 * legacy), plus each note with text only in this page and no queue record (a
 * note with both counts once). Null when the queue cannot be read for this
 * account, which the caller treats as having changes.
 */
export async function readLocalOnlyChanges(account: SignOutAccount): Promise<LocalOnlyChanges | null> {
  if (!account.accountFingerprint || !isSignOutAccountCurrent(account)) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // A queue that does not answer (a blocked database) counts as having changes, so Log out still has a way out.
    const timedOut = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), COUNT_TIMEOUT_MS) })
    const records = await Promise.race([
      getQueuedMutations({ accountEpoch: account.accountEpoch, accountFingerprint: account.accountFingerprint }),
      timedOut,
    ])
    if (records === null) return null
    if (!isSignOutAccountCurrent(account)) return null
    const keys = new Set<string>()
    const queuedItems = new Set<string>()
    for (const record of records) {
      keys.add(`record:${record.id}`)
      if (record.itemUid) queuedItems.add(record.itemUid)
    }
    for (const id of noteIdsWithTextOnlyInPage()) {
      if (!queuedItems.has(id)) keys.add(`note:${id}`)
    }
    return { count: keys.size, keys }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** The number of changes only on this device for the account, or null when they cannot be counted. */
export async function countLocalOnlyChanges(account: SignOutAccount): Promise<number | null> {
  return (await readLocalOnlyChanges(account))?.count ?? null
}
