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

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-[60] bg-black/40" onClick={onCancel} />

      {/* Dialog */}
      <div
        ref={containerRef}
        role="dialog"
        aria-label={title}
        aria-modal="true"
        className="fixed inset-0 z-[61] flex items-center justify-center p-4"
      >
        <div className="w-full max-w-sm rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--background))] shadow-xl">
          <div className="p-4">
            <h3 className="text-base font-semibold text-[rgb(var(--foreground))] mb-1">
              {title}
            </h3>
            <p className="text-xs text-[rgb(var(--muted))] mb-4">
              This is a recurring event. How would you like to {isDelete ? 'delete' : 'edit'} it?
            </p>

            <div className="flex flex-col gap-2">
              {(['this', 'this_and_future', 'all'] as RecurrenceScope[]).map((scope) => (
                <button
                  key={scope}
                  onClick={() => handleScopeClick(scope)}
                  className={`flex flex-col items-start rounded-md border px-3 py-2.5 text-left transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500 ${
                    isDelete && scope === 'all'
                      ? 'border-red-500/30 hover:bg-red-500/10 text-red-500'
                      : 'border-[rgb(var(--border))] hover:bg-[rgb(var(--surface))] text-[rgb(var(--foreground))]'
                  }`}
                >
                  <span className="text-sm font-medium">{SCOPE_LABELS[scope]}</span>
                  <span className="text-xs text-[rgb(var(--muted))]">
                    {SCOPE_DESCRIPTIONS[scope][mode]}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="border-t border-[rgb(var(--border))] px-4 py-3 flex justify-end">
            <button
              onClick={onCancel}
              className="rounded-md px-3 py-1.5 text-sm text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))] transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
