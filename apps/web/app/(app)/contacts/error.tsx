'use client'

import { useEffect } from 'react'

export default function ContactsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('Contacts error boundary caught:', error)
  }, [error])

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-md space-y-4 text-center">
        <h2 className="text-lg font-semibold text-[rgb(var(--foreground))]">Contacts unavailable</h2>
        <p className="text-sm text-[rgb(var(--muted))]">
          Failed to load your contacts. Please try again.
        </p>
        {process.env.NODE_ENV === 'development' && (
          <pre className="mt-2 max-h-40 overflow-auto rounded bg-[rgb(var(--surface))] p-3 text-left text-xs text-red-400">
            {error.message}
          </pre>
        )}
        <button
          onClick={reset}
          className="rounded-lg bg-[rgb(var(--primary))] px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity"
        >
          Retry
        </button>
      </div>
    </div>
  )
}
