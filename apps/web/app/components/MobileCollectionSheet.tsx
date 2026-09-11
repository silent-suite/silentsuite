'use client'

import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { CalendarListPanel } from './CalendarListPanel'
import { TaskListPanel } from './TaskListPanel'
import { ContactListPanel } from './ContactListPanel'
import { NotebookListPanel } from './NotebookListPanel'

export type MobileCollectionType = 'calendar' | 'tasks' | 'contacts' | 'notes'

interface MobileCollectionSheetProps {
  type: MobileCollectionType
  open: boolean
  onClose: () => void
}

/**
 * Mobile-only slide-up sheet that exposes the existing collection management
 * panels (calendars / task lists / address books / notebooks) which are
 * otherwise only reachable via the desktop sidebar (`hidden md:flex`). The
 * panels are reused as-is so all CRUD logic stays in one place.
 *
 * Rendered through a portal into the body: the page's `main` is its own
 * stacking context (`relative z-0`), so anything inside it sits under the
 * bottom nav no matter its z-index, and the nav was painting over the sheet's
 * last rows.
 */
export function MobileCollectionSheet({ type, open, onClose }: MobileCollectionSheetProps) {
  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <>
      {/* Backdrop. Sits above the bottom nav (z-50) so the sheet's last rows are
          not painted over and nav taps cannot fire while the sheet is open. */}
      <div
        className="fixed inset-0 z-[60] bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Slide-up sheet; dvh tracks the mobile browser chrome and the safe-area
          padding keeps the last row above the home indicator. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Collections"
        className="fixed inset-x-0 bottom-0 z-[60] max-h-[80vh] overflow-y-auto rounded-t-xl border-t border-[rgb(var(--border))] bg-[rgb(var(--background))] pb-[env(safe-area-inset-bottom)] shadow-2xl supports-[height:1dvh]:max-h-[80dvh]"
      >
        {/* Header */}
        <div className="sticky top-0 flex items-center justify-between border-b border-[rgb(var(--border))] bg-[rgb(var(--background))] px-4 py-3">
          <span className="text-sm font-semibold text-[rgb(var(--foreground))]">Collections</span>
          <button
            type="button"
            onClick={onClose}
            className="touch-target rounded-md text-[rgb(var(--muted))] hover:bg-[rgb(var(--surface))] hover:text-[rgb(var(--foreground))] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
            aria-label="Close collections"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Context-aware collection panel (reused from the desktop sidebar) */}
        <div className="pb-4">
          {type === 'calendar' && <CalendarListPanel />}
          {type === 'tasks' && <TaskListPanel />}
          {type === 'contacts' && <ContactListPanel />}
          {type === 'notes' && <NotebookListPanel />}
        </div>
      </div>
    </>,
    document.body,
  )
}
