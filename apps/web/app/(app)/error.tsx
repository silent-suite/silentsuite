'use client'

import { useEffect } from 'react'
import * as Sentry from '@sentry/nextjs'
import { useTranslations } from 'next-intl'
import { getSafeErrorDetails } from '@/app/lib/privacy-safe-errors'

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const t = useTranslations('AppError')

  useEffect(() => {
    console.error('App error boundary caught', getSafeErrorDetails(error))
    Sentry.captureException(error)
  }, [error])

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-md space-y-4 text-center">
        <h2 className="text-xl font-semibold text-[rgb(var(--foreground))]">{t('title')}</h2>
        <p className="text-sm text-[rgb(var(--muted))]">
          {t('description')}
        </p>
        {error.digest && (
          <p className="text-xs text-[rgb(var(--muted))]">
            {t('errorId')} <code className="rounded bg-[rgb(var(--surface))] px-1 py-0.5 font-mono text-xs">{error.digest}</code>
          </p>
        )}
        {process.env.NODE_ENV === 'development' && (
          <pre className="mt-2 max-h-40 overflow-auto rounded bg-[rgb(var(--surface))] p-3 text-left text-xs text-red-400">
            {error.message}
          </pre>
        )}
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={reset}
            className="rounded-lg bg-[rgb(var(--primary))] px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity"
          >
            {t('tryAgain')}
          </button>
          <a
            href="/calendar"
            className="rounded-lg border border-[rgb(var(--border))] px-4 py-2 text-sm font-medium text-[rgb(var(--muted))] hover:bg-[rgb(var(--surface))] transition-colors"
          >
            {t('goToCalendar')}
          </a>
        </div>
        <p className="text-xs text-[rgb(var(--muted))]">
          {t('contactPrefix')}{' '}
          <a href="mailto:info@silentsuite.io" className="text-emerald-500 hover:underline">
            info@silentsuite.io
          </a>
        </p>
      </div>
    </div>
  )
}
