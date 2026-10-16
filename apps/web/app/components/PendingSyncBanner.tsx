'use client'

import { useCallback, useState, useEffect } from 'react'
import { AlertTriangle, CloudOff, RefreshCw, Trash2 } from 'lucide-react'
import { useSyncStore } from '@/app/stores/use-sync-store'
import {
  casStub,
  clearFailed,
  dismissLegacy,
  getAll,
  getStaleEntries,
  isLegacyEntry,
  MAX_QUEUE_SIZE,
  onCountChange,
  retryFailed,
  type OfflineQueueAccountGuard,
  type QueueEntry,
} from '@/app/lib/offline-queue'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useNoteStore } from '@/app/stores/use-note-store'
import { useContactStore } from '@/app/stores/use-contact-store'
import { AccountBoundaryChangedError, assertCurrentAccountEpoch, getAccountEpoch } from '@/app/lib/account-epoch'

type HeldReason = NonNullable<QueueEntry['held']>

/** #744 §12: each text states only the present fact about the kept record. */
const HELD_TEXT: Record<HeldReason, string> = {
  // A send that kept failing may or may not have reached the server.
  'retry-exhausted': "The server didn't confirm this change. Kept on this device.",
  'target-missing': "Not saved to the server: this item was deleted or isn't available to this account. Your edit is kept on this device.",
  unreadable: "Can't be read on this device right now; it may not have been saved.",
  'base-changed': "Not saved to the server: this item changed after your offline edit, so it wasn't saved over it. Your edit is kept on this device.",
}

/** The label of a row whose item no current store names; nothing is read from the kept record. */
const FALLBACK_LABEL: Partial<Record<QueueEntry['collectionType'], string>> = { notes: 'Note', contacts: 'Contact' }
const LEGACY_TEXT = "Can't be verified, won't be sent automatically; changes paused."

/** A held sealed record or a legacy entry, as last read from the queue. No body is ever read. */
interface QueueNotice {
  id: string
  rev: number | undefined
  itemUid?: string
  collectionType: QueueEntry['collectionType']
  held?: HeldReason
  legacy: boolean
}

export function PendingSyncBanner() {
  const pendingCount = useSyncStore((s) => s.pendingQueueCount)
  const failedCount = useSyncStore((s) => s.failedQueueCount)
  const isOnline = useSyncStore((s) => s.isOnline)
  const replayOfflineQueue = useSyncStore((s) => s.replayOfflineQueue)
  const simulateSyncCycle = useSyncStore((s) => s.simulateSyncCycle)
  const account = useEtebaseStore((s) => s.account)
  const accountFingerprint = useEtebaseStore((s) => s.accountFingerprint)
  const notes = useNoteStore((s) => s.notes)
  const contacts = useContactStore((s) => s.contacts)

  const [hasStaleEntries, setHasStaleEntries] = useState(false)
  const [notices, setNotices] = useState<QueueNotice[]>([])
  const [noticeReads, setNoticeReads] = useState(0)
  const rereadNotices = useCallback(() => setNoticeReads((count) => count + 1), [])

  // Held and legacy records of this account, read again on every queue change.
  useEffect(() => {
    if (!account || !accountFingerprint) {
      setNotices([])
      return
    }
    let cancelled = false
    const guard = { accountEpoch: getAccountEpoch(), accountFingerprint }
    const read = () => {
      getAll(guard).then((entries) => {
        if (cancelled) return
        setNotices(entries
          .filter((entry) => (entry.sealed && entry.held) || isLegacyEntry(entry))
          .map((entry) => ({
            id: entry.id,
            rev: entry.rev,
            itemUid: entry.itemUid,
            collectionType: entry.collectionType,
            held: entry.sealed ? entry.held : undefined,
            legacy: isLegacyEntry(entry),
          })))
      }).catch(() => {
        if (!cancelled) setNotices([])
      })
    }
    read()
    const unsubscribe = onCountChange(read)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [account, accountFingerprint, noticeReads])

  // Check for stale entries periodically
  useEffect(() => {
    if (pendingCount === 0) {
      setHasStaleEntries(false)
      return
    }

    let cancelled = false
    const check = () => {
      if (!account || !accountFingerprint) return
      const guard = { accountEpoch: getAccountEpoch(), accountFingerprint }
      getStaleEntries(guard).then((stale) => {
        if (!cancelled) setHasStaleEntries(stale.length > 0)
      }).catch(() => {})
    }
    check()
    const interval = setInterval(check, 60_000) // re-check every minute
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [pendingCount, account, accountFingerprint])

  // A held or legacy record is listed even when nothing is pending or failed.
  if (pendingCount === 0 && failedCount === 0 && notices.length === 0) return null

  const isQueueNearLimit = pendingCount >= MAX_QUEUE_SIZE
  // Row actions are bound to the account as rendered; a later account makes them no-ops.
  const renderGuard: OfflineQueueAccountGuard | null = account && accountFingerprint
    ? { accountEpoch: getAccountEpoch(), accountFingerprint }
    : null

  // Titles come from the current stores at render; nothing about the record body is shown.
  const titleOf = (notice: QueueNotice): string | undefined => {
    let title: string | undefined
    if (notice.collectionType === 'notes') title = notes.find((note) => note.id === notice.itemUid)?.title
    if (notice.collectionType === 'contacts') title = contacts.find((contact) => contact.id === notice.itemUid)?.displayName
    return title || FALLBACK_LABEL[notice.collectionType]
  }

  /** Asserts the captured account, runs one queue action, then always reads the list again. */
  const runNoticeAction = async (guard: OfflineQueueAccountGuard, action: () => Promise<void>) => {
    try {
      assertCurrentAccountEpoch(guard.accountEpoch)
      await action()
    } catch (err) {
      if (!(err instanceof AccountBoundaryChangedError)) throw err
    } finally {
      rereadNotices()
    }
  }

  // Retry never forces a write: it only makes the record eligible, and replay proves it again.
  const handleRetryHeld = (guard: OfflineQueueAccountGuard, notice: QueueNotice) => runNoticeAction(guard, async () => {
    if (!await casStub(notice.id, notice.rev, { held: undefined, retryCount: 0 }, guard)) return
    await replayOfflineQueue()
    simulateSyncCycle()
  })

  const handleDiscardHeld = (guard: OfflineQueueAccountGuard, notice: QueueNotice) => runNoticeAction(guard, async () => {
    await casStub(notice.id, notice.rev, 'delete', guard)
  })

  const handleDismissLegacy = (guard: OfflineQueueAccountGuard, notice: QueueNotice) => runNoticeAction(guard, async () => {
    await dismissLegacy(notice.id, guard)
  })

  const handleRetryFailed = async () => {
    if (!account || !accountFingerprint) return
    try {
      await retryFailed({ accountEpoch: getAccountEpoch(), accountFingerprint })
      if (isOnline) {
        await replayOfflineQueue()
      }
    } catch (err) {
      if (err instanceof AccountBoundaryChangedError) return
      throw err
    }
  }

  const handleDiscardFailed = async () => {
    if (!account || !accountFingerprint) return
    try {
      await clearFailed({ accountEpoch: getAccountEpoch(), accountFingerprint })
    } catch (err) {
      if (err instanceof AccountBoundaryChangedError) return
      throw err
    }
  }

  return (
    <div className="mx-3 mt-2 space-y-2 md:mx-4">
      {/* Main pending/failed banner */}
      {(pendingCount > 0 || failedCount > 0) && (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
        <CloudOff className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />

        <span className="flex-1">
          {pendingCount > 0 && (
            <span>
              {pendingCount} change{pendingCount !== 1 ? 's' : ''} waiting to sync
            </span>
          )}
          {pendingCount > 0 && failedCount > 0 && <span className="mx-1">&middot;</span>}
          {failedCount > 0 && (
            <span className="text-red-700 dark:text-red-400">
              {failedCount} failed
            </span>
          )}
        </span>

        {failedCount > 0 && (
          <div className="flex items-center gap-1">
            <button
              onClick={handleRetryFailed}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-500/20 dark:text-amber-300"
            >
              <RefreshCw className="h-3 w-3" />
              Retry
            </button>
            <button
              onClick={handleDiscardFailed}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-red-800 transition-colors hover:bg-red-500/20 dark:text-red-400"
            >
              <Trash2 className="h-3 w-3" />
              Discard
            </button>
          </div>
        )}
      </div>
      )}

      {/* Held and legacy records (#744 §12): each action is bound to its record and the rendered account. */}
      {renderGuard && notices.map((notice) => {
        const title = titleOf(notice)
        return (
          <div
            key={notice.id}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200"
          >
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <span className="flex-1">
              {title && <span className="font-medium">{title}</span>}
              {title && <span className="mx-1">&middot;</span>}
              <span>{notice.legacy ? LEGACY_TEXT : HELD_TEXT[notice.held!]}</span>
            </span>
            <div className="flex items-center gap-1">
              {notice.legacy ? (
                <button
                  onClick={() => void handleDismissLegacy(renderGuard, notice)}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-500/20 dark:text-amber-300"
                >
                  Dismiss
                </button>
              ) : (
                <>
                  <button
                    onClick={() => void handleRetryHeld(renderGuard, notice)}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-500/20 dark:text-amber-300"
                  >
                    <RefreshCw className="h-3 w-3" />
                    Retry
                  </button>
                  <button
                    onClick={() => void handleDiscardHeld(renderGuard, notice)}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-red-800 transition-colors hover:bg-red-500/20 dark:text-red-400"
                  >
                    <Trash2 className="h-3 w-3" />
                    Discard
                  </button>
                </>
              )}
            </div>
          </div>
        )
      })}

      {/* Stale queue warning */}
      {hasStaleEntries && (
        <div className="flex items-center gap-2 rounded-lg border border-orange-500/30 bg-orange-500/10 px-3 py-2 text-sm text-orange-800 dark:text-orange-200">
          <AlertTriangle className="h-4 w-4 shrink-0 text-orange-600 dark:text-orange-400" />
          <span>Some changes have been pending for over 24 hours. Please check your internet connection.</span>
        </div>
      )}

      {/* Queue size limit warning */}
      {isQueueNearLimit && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-800 dark:text-red-200">
          <AlertTriangle className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
          <span>Offline queue is full ({MAX_QUEUE_SIZE} changes). Connect to the internet to sync your changes.</span>
        </div>
      )}
    </div>
  )
}
