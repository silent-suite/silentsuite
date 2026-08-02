'use client'

import { TriangleAlert } from 'lucide-react'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useSyncStore } from '@/app/stores/use-sync-store'

export function PartialLoadBanner() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const restoreBlocked = useEtebaseStore((s) => s.restoreBlocked)
  const partialLoad = useSyncStore((s) => s.partialLoad)
  const syncStatus = useSyncStore((s) => s.syncStatus)
  const simulateSyncCycle = useSyncStore((s) => s.simulateSyncCycle)

  if (!partialLoad || restoreBlocked || !isAuthenticated) return null

  const disabled = syncStatus === 'syncing' || syncStatus === 'offline'

  return (
    <div className="mx-3 mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm md:mx-4">
      <TriangleAlert className="h-4 w-4 flex-none text-amber-600 dark:text-amber-300" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-amber-800 dark:text-amber-100">
        Some of your data could not be loaded and is not shown right now. Your information is safe. Retry to load it again.
      </p>
      <button
        type="button"
        onClick={() => simulateSyncCycle()}
        disabled={disabled}
        className="rounded-md border border-amber-600/40 px-2.5 py-1 text-xs font-medium text-amber-800 transition-colors hover:border-amber-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-300/40 dark:text-amber-100 dark:hover:border-amber-200 dark:hover:text-white"
      >
        Retry sync
      </button>
    </div>
  )
}
