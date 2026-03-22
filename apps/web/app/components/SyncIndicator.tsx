'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { RefreshCw } from 'lucide-react'
import { useSyncStore } from '@/app/stores/use-sync-store'
import { formatTimeAgo } from '@/app/lib/format-time-ago'
import type { SyncStatus } from '@silentsuite/core'

const dotStyles: Record<SyncStatus, string> = {
  synced: 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]',
  syncing: 'bg-amber-400',
  offline: 'bg-gray-400',
  error: 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]',
}

const ariaLabels: Record<SyncStatus, string> = {
  synced: 'Sync status: synced',
  syncing: 'Sync status: syncing',
  offline: 'Sync status: offline',
  error: 'Sync status: error',
}

function getTooltipText(status: SyncStatus, lastSyncedAt: Date | null, error: string | null, pendingCount: number): string {
  const queueSuffix = pendingCount > 0 ? ` (${pendingCount} queued)` : ''
  switch (status) {
    case 'synced':
      return (lastSyncedAt ? `Synced ${formatTimeAgo(lastSyncedAt)}` : 'Synced') + queueSuffix
    case 'syncing':
      return 'Syncing...' + queueSuffix
    case 'offline':
      return `Offline. Changes saved locally.${queueSuffix}`
    case 'error':
      return (error ?? 'Sync error. Retrying...') + queueSuffix
  }
}

export function SyncIndicator() {
  const syncStatus = useSyncStore((s) => s.syncStatus)
  const lastSyncedAt = useSyncStore((s) => s.lastSyncedAt)
  const error = useSyncStore((s) => s.error)
  const simulateSyncCycle = useSyncStore((s) => s.simulateSyncCycle)
  const pendingQueueCount = useSyncStore((s) => s.pendingQueueCount)
  const [showTooltip, setShowTooltip] = useState(false)
  const [tooltipText, setTooltipText] = useState('')
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const isSyncing = syncStatus === 'syncing'
  const isOffline = syncStatus === 'offline'
  const isError = syncStatus === 'error'

  const handleSync = useCallback(() => {
    if (isSyncing || isOffline) return
    simulateSyncCycle()
  }, [isSyncing, isOffline, simulateSyncCycle])

  // Update tooltip text on an interval while visible so relative times stay fresh
  useEffect(() => {
    if (showTooltip) {
      setTooltipText(getTooltipText(syncStatus, lastSyncedAt, error, pendingQueueCount))
      intervalRef.current = setInterval(() => {
        setTooltipText(getTooltipText(syncStatus, lastSyncedAt, error, pendingQueueCount))
      }, 1000)
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [showTooltip, syncStatus, lastSyncedAt, error, pendingQueueCount])

  return (
    <div
      className="relative flex items-center gap-1.5"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      {/* Status dot with smooth transition */}
      <div className="relative">
        <div
          className={`h-2 w-2 rounded-full transition-all duration-300 ${dotStyles[syncStatus]}`}
          role="status"
          aria-label={ariaLabels[syncStatus]}
        />
        {pendingQueueCount > 0 && (
          <span className="absolute -top-1.5 -right-1.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-500 text-[8px] font-bold leading-none text-white">
            {pendingQueueCount > 9 ? '9+' : pendingQueueCount}
          </span>
        )}
      </div>

      {/* Error label */}
      {isError && (
        <button
          onClick={handleSync}
          className="hidden text-xs text-rose-400 hover:text-rose-300 md:inline"
        >
          Sync error
        </button>
      )}

      {/* Pending count label */}
      {!isError && pendingQueueCount > 0 && (
        <span className="hidden text-xs text-amber-400 md:inline">
          {pendingQueueCount} pending
        </span>
      )}

      {/* Sync button */}
      <button
        onClick={handleSync}
        disabled={isSyncing || isOffline}
        className="no-min-size rounded-md p-1.5 text-[rgb(var(--muted))] transition-colors hover:bg-[rgb(var(--surface))] hover:text-[rgb(var(--foreground))] disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
        aria-label="Sync now"
        title="Sync now"
      >
        <RefreshCw className={`h-3.5 w-3.5 transition-transform duration-300 ${isSyncing ? 'animate-spin' : ''}`} />
      </button>

      {showTooltip && (
        <div className="absolute top-full right-0 z-50 mt-2 whitespace-nowrap rounded-md border border-[rgb(var(--border))] bg-[rgb(var(--background))] px-2.5 py-1.5 text-xs text-[rgb(var(--foreground))] shadow-md md:left-1/2 md:right-auto md:-translate-x-1/2">
          {tooltipText}
          <div className="absolute bottom-full right-3 md:left-1/2 md:right-auto md:-translate-x-1/2 border-4 border-transparent border-b-[rgb(var(--border))]" />
        </div>
      )}
    </div>
  )
}
