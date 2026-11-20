'use client'

import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import { ModalDialog } from '@/app/components/modal-dialog'
import { isSignOutAccountCurrent, readLocalOnlyChanges, type LocalOnlyChanges, type SignOutAccount } from '@/app/lib/local-only-changes'
import { settleNoteTextForCount } from '@/app/stores/use-note-store'
import { useSyncStore } from '@/app/stores/use-sync-store'

type Stage = 'unsynced' | 'confirm' | 'syncing' | 'deleting'

const BUTTON_CLASS = 'rounded-lg px-4 py-2 max-md:min-h-[44px] text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50'

/**
 * Asked before a sign-out that would delete changes only on this device (#1113 D1):
 * held, pending and failed offline changes and note text only in this page.
 * `changes` is null when they could not be counted, which counts as having changes.
 * The dialog is bound to the account it was opened for: once that account is no
 * longer this tab's, every action closes it without signing out. Log out and delete
 * asks once more, then reads the changes again right before signing out, and asks
 * again when it finds any change the user was not shown.
 */
export function SignOutDialog({ account, changes: initialChanges, onLogout, onClose }: {
  account: SignOutAccount
  changes: LocalOnlyChanges | null
  onLogout: () => Promise<void>
  onClose: () => void
}) {
  const t = useTranslations('SignOut')
  const [changes, setChanges] = useState(initialChanges)
  const count = changes?.count ?? null
  const [stage, setStage] = useState<Stage>('unsynced')
  // The changes the user agreed to delete in the second step; null when they could not be counted.
  const [agreed, setAgreed] = useState<LocalOnlyChanges | null>(null)
  const busy = stage === 'syncing' || stage === 'deleting'
  // Cancel works at any time, also while Sync now runs; once closed, nothing here logs out.
  const open = useRef(true)
  const close = () => {
    open.current = false
    onClose()
  }

  const logOutIfCurrent = async () => {
    if (!open.current) return
    if (!isSignOutAccountCurrent(account)) {
      close()
      return
    }
    close()
    await onLogout()
  }

  const syncNow = async () => {
    setStage('syncing')
    try {
      await settleNoteTextForCount()
      if (isSignOutAccountCurrent(account)) await useSyncStore.getState().replayOfflineQueue()
    } catch {
      // The count below says what is still only on this device.
    }
    if (!open.current) return
    if (!isSignOutAccountCurrent(account)) {
      close()
      return
    }
    const left = await readLocalOnlyChanges(account)
    if (!open.current) return
    if (left?.count === 0) {
      await logOutIfCurrent()
      return
    }
    setChanges(left)
    setStage('unsynced')
  }

  const deleteAndLogOut = async () => {
    setStage('deleting')
    const now = await readLocalOnlyChanges(account)
    if (!open.current) return
    if (!isSignOutAccountCurrent(account)) {
      close()
      return
    }
    // A change the user was not shown, or no longer countable after a count: ask again with what is known now.
    if (agreed !== null && (now === null || [...now.keys].some((key) => !agreed.keys.has(key)))) {
      setChanges(now)
      setAgreed(now)
      setStage('confirm')
      return
    }
    await logOutIfCurrent()
  }

  const message = stage === 'confirm'
    ? (count === null ? t('confirmUnknown') : t('confirmCount', { count }))
    : (count === null ? t('unsyncedUnknown') : t('unsyncedCount', { count }))

  if (typeof document === 'undefined') return null
  return createPortal(
    <ModalDialog
      title={stage === 'confirm' ? t('confirmTitle') : t('unsyncedTitle')}
      description={message}
      onClose={stage === 'deleting' ? undefined : close}
      closeOnEscape={stage !== 'deleting'}
    >
      <p className="mt-2 text-sm text-[rgb(var(--muted))]" aria-live="polite">
        {stage === 'syncing' ? t('syncing') : message}
      </p>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={close} disabled={stage === 'deleting'} className={`${BUTTON_CLASS} text-[rgb(var(--foreground))] hover:bg-[rgb(var(--background))]`}>
          {t('cancel')}
        </button>
        {stage === 'confirm' || stage === 'deleting' ? (
          <button type="button" onClick={() => void deleteAndLogOut()} disabled={busy} className={`${BUTTON_CLASS} bg-red-600 text-white hover:bg-red-500`}>
            {t('deleteAndLogOut')}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => {
                setAgreed(changes)
                setStage('confirm')
              }}
              disabled={busy}
              className={`${BUTTON_CLASS} text-red-700 hover:bg-red-500/10 dark:text-red-400`}
            >
              {t('logOutAndDelete')}
            </button>
            <button type="button" onClick={() => void syncNow()} disabled={busy} className={`${BUTTON_CLASS} bg-emerald-600 text-white hover:bg-emerald-500`}>
              {t('syncNow')}
            </button>
          </>
        )}
      </div>
    </ModalDialog>,
    document.body,
  )
}
