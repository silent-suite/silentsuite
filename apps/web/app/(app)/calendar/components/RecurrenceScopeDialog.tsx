'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useFocusTrap } from '@/app/lib/use-focus-trap'

export type RecurrenceScope = 'this' | 'this_and_future' | 'all'

interface RecurrenceScopeDialogProps {
  /** 'edit' or 'delete' — affects wording and styling */
  mode: 'edit' | 'delete'
  /** Called with the chosen scope */
  onConfirm: (scope: RecurrenceScope) => void
  /** Called when the dialog is dismissed without action */
  onCancel: () => void
}

const SCOPE_LABELS: Record<RecurrenceScope, string> = {
  this: 'This event',
  this_and_future: 'This and all future events',
  all: 'All events',
}

const SCOPE_DESCRIPTIONS: Record<RecurrenceScope, Record<'edit' | 'delete', string>> = {
  this: {
    edit: 'Only modify this single occurrence',
    delete: 'Only remove this single occurrence',
  },
  this_and_future: {
    edit: 'Modify this and all future occurrences',
    delete: 'Remove this and all future occurrences',
  },
  all: {
    edit: 'Modify every occurrence of this event',
    delete: 'Permanently delete all occurrences',
  },
}

export function RecurrenceScopeDialog({
  mode,
  onConfirm,
  onCancel,
}: RecurrenceScopeDialogProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  // Focus trap
  useFocusTrap(containerRef)

  // Escape to cancel
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  const handleScopeClick = useCallback(
    (scope: RecurrenceScope) => {
      onConfirm(scope)
    },
    [onConfirm],
  )

  const isDelete = mode === 'delete'
  const title = isDelete ? 'Delete recurring event' : 'Edit recurring event'
  const focusRing = 'focus:outline-none focus:ring-2 focus:ring-emerald-500/80 focus:ring-offset-2 focus:ring-offset-[rgb(var(--background))]'

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-[300] bg-slate-950/50 backdrop-blur-sm dark:bg-black/70" onClick={onCancel} />

      {/* Dialog */}
      <div
        ref={containerRef}
        role="dialog"
        aria-label={title}
        aria-modal="true"
        className="fixed inset-0 z-[301] flex items-center justify-center p-4"
      >
        <div className="w-full max-w-md overflow-hidden rounded-3xl border border-[rgb(var(--border))] bg-[rgb(var(--background))] text-[rgb(var(--foreground))] shadow-2xl shadow-black/25 dark:shadow-black/60">
          <div className="border-b border-[rgb(var(--border))] px-5 py-4">
            <h3 className="text-base font-semibold tracking-tight text-[rgb(var(--foreground))]">
              {title}
            </h3>
            <p className="mt-1 text-sm leading-relaxed text-[rgb(var(--muted))]">
              This is a recurring event. Choose how broadly to {isDelete ? 'delete' : 'edit'} it.
            </p>
          </div>

          <div className="space-y-2 px-5 py-4">
            {(['this', 'this_and_future', 'all'] as RecurrenceScope[]).map((scope) => (
              <button
                key={scope}
                onClick={() => handleScopeClick(scope)}
                className={`flex w-full flex-col items-start rounded-2xl border px-4 py-3 text-left shadow-sm shadow-black/5 transition-colors ${focusRing} ${
                  isDelete && scope === 'all'
                    ? 'border-red-500/30 bg-red-500/5 text-red-600 hover:bg-red-500/10 dark:text-red-400'
                    : 'border-[rgb(var(--border))] bg-[rgb(var(--surface))]/60 text-[rgb(var(--foreground))] hover:border-emerald-500/40 hover:bg-[rgb(var(--surface))]'
                }`}
              >
                <span className="text-sm font-semibold">{SCOPE_LABELS[scope]}</span>
                <span className="mt-0.5 text-xs leading-relaxed text-[rgb(var(--muted))]">
                  {SCOPE_DESCRIPTIONS[scope][mode]}
                </span>
              </button>
            ))}
          </div>

          <div className="flex justify-end border-t border-[rgb(var(--border))] bg-[rgb(var(--surface))]/35 px-5 py-4">
            <button
              onClick={onCancel}
              className={`rounded-full border border-[rgb(var(--border))] px-4 py-2 text-sm font-semibold text-[rgb(var(--muted))] transition-colors hover:bg-[rgb(var(--surface))] hover:text-[rgb(var(--foreground))] ${focusRing}`}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
