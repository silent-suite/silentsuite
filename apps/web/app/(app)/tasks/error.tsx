'use client'

import { useEffect } from 'react'
import * as Sentry from '@sentry/nextjs'

export default function TasksError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('Tasks error boundary caught:', error)
    Sentry.captureException(error)
  }, [error])

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-md space-y-4 text-center">
        <h2 className="text-lg font-semibold text-[rgb(var(--foreground))]">Tasks unavailable</h2>
        <p className="text-sm text-[rgb(var(--muted))]">
          Failed to load your tasks. Check your connection and try again.
        </p>
        {error.digest && (
          <p className="text-xs text-[rgb(var(--muted))]">
            Error ID: <code className="rounded bg-[rgb(var(--surface))] px-1 py-0.5 font-mono text-xs">{error.digest}</code>
          </p>
        )}
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
        <p className="text-xs text-[rgb(var(--muted))]">
          If this keeps happening, contact us at{' '}
          <a href="mailto:info@silentsuite.io" className="text-emerald-500 hover:underline">
            info@silentsuite.io
          </a>
        </p>
      </div>
    </div>
  )
}
