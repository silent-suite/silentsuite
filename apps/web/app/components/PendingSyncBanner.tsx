'use client'

import { CloudOff, RefreshCw, Trash2 } from 'lucide-react'
import { useSyncStore } from '@/app/stores/use-sync-store'
import { clearFailed, retryFailed } from '@/app/lib/offline-queue'

export function PendingSyncBanner() {
  const pendingCount = useSyncStore((s) => s.pendingQueueCount)
  const failedCount = useSyncStore((s) => s.failedQueueCount)
  const isOnline = useSyncStore((s) => s.isOnline)
  const replayOfflineQueue = useSyncStore((s) => s.replayOfflineQueue)

  if (pendingCount === 0 && failedCount === 0) return null

  const handleRetryFailed = async () => {
    await retryFailed()
    if (isOnline) {
      await replayOfflineQueue()
    }
  }

  const handleDiscardFailed = async () => {
    await clearFailed()
  }

  return (
    <div className="mx-3 mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200 md:mx-4">
      <CloudOff className="h-4 w-4 shrink-0 text-amber-400" />

      <span className="flex-1">
        {pendingCount > 0 && (
          <span>
            {pendingCount} change{pendingCount !== 1 ? 's' : ''} waiting to sync
          </span>
        )}
        {pendingCount > 0 && failedCount > 0 && <span className="mx-1">·</span>}
        {failedCount > 0 && (
          <span className="text-red-400">
            {failedCount} failed
          </span>
        )}
      </span>

      {failedCount > 0 && (
        <div className="flex items-center gap-1">
          <button
            onClick={handleRetryFailed}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-500/20"
          >
            <RefreshCw className="h-3 w-3" />
            Retry
          </button>
          <button
            onClick={handleDiscardFailed}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/20"
          >
            <Trash2 className="h-3 w-3" />
            Discard
          </button>
        </div>
      )}
    </div>
  )
}
