'use client'

import { X } from 'lucide-react'
import { CalendarListPanel } from './CalendarListPanel'
import { TaskListPanel } from './TaskListPanel'
import { ContactListPanel } from './ContactListPanel'

export type MobileCollectionType = 'calendar' | 'tasks' | 'contacts'

interface MobileCollectionSheetProps {
  type: MobileCollectionType
  open: boolean
  onClose: () => void
}

/**
 * Mobile-only slide-up sheet that exposes the existing collection management
 * panels (calendars / task lists / address books) which are otherwise only
 * reachable via the desktop sidebar (`hidden md:flex`). The panels are reused
 * as-is so all CRUD logic stays in one place.
 */
export function MobileCollectionSheet({ type, open, onClose }: MobileCollectionSheetProps) {
  if (!open) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Slide-up sheet */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Collections"
        className="fixed inset-x-0 bottom-0 z-50 max-h-[80vh] overflow-y-auto rounded-t-xl border-t border-[rgb(var(--border))] bg-[rgb(var(--background))] shadow-2xl"
      >
        {/* Header */}
        <div className="sticky top-0 flex items-center justify-between border-b border-[rgb(var(--border))] bg-[rgb(var(--background))] px-4 py-3">
          <span className="text-sm font-semibold text-[rgb(var(--foreground))]">Collections</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-[rgb(var(--muted))] hover:bg-[rgb(var(--surface))] hover:text-[rgb(var(--foreground))] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
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
        </div>
      </div>
    </>
  )
}
