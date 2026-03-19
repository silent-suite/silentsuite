'use client'

import { useEffect } from 'react'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('Global error boundary caught:', error)
  }, [error])

  return (
    <div className="flex min-h-screen items-center justify-center bg-[rgb(var(--background))] p-6">
      <div className="max-w-md space-y-4 text-center">
        <h2 className="text-xl font-semibold text-[rgb(var(--foreground))]">Something went wrong</h2>
        <p className="text-sm text-[rgb(var(--muted))]">
          An unexpected error occurred. Please try again or return to login.
        </p>
        {process.env.NODE_ENV === 'development' && (
          <pre className="mt-2 max-h-40 overflow-auto rounded bg-[rgb(var(--surface))] p-3 text-left text-xs text-red-400">
            {error.message}
          </pre>
        )}
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={reset}
            className="rounded-lg bg-[rgb(var(--primary))] px-4 py-2 text-sm font-medium text-white hover:bg-[rgb(var(--primary-hover))] transition-colors"
          >
            Try again
          </button>
          <a
            href="/login"
            className="rounded-lg border border-[rgb(var(--border))] px-4 py-2 text-sm font-medium text-[rgb(var(--foreground))] hover:bg-[rgb(var(--surface))] transition-colors"
          >
            Return to login
          </a>
        </div>
      </div>
    </div>
  )
}
