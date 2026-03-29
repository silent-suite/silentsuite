'use client'

import { WifiOff } from 'lucide-react'

export default function OfflinePage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[rgb(var(--background))] px-4 text-center">
      <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-gray-800/50">
        <WifiOff className="h-8 w-8 text-gray-400" />
      </div>

      <h1 className="mb-2 text-xl font-semibold text-[rgb(var(--foreground))]">
        You&apos;re offline
      </h1>

      <p className="mb-8 max-w-sm text-sm text-[rgb(var(--muted))]">
        Your changes are saved locally and will sync automatically when
        you&apos;re back online.
      </p>

      <div className="flex items-center gap-2 text-xs text-[rgb(var(--muted))]">
        <div className="h-2 w-2 rounded-full bg-gray-400" />
        <span>Offline — changes saved locally</span>
      </div>

      <button
        onClick={() => window.location.reload()}
        className="mt-6 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
      >
        Try again
      </button>
    </div>
  )
}
