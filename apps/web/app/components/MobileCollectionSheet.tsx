'use client'

import { useEffect, useRef } from 'react'
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
const SHEET_FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function isTextField(node: EventTarget | null) {
  return node instanceof HTMLElement && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA')
}

function focusableIn(sheet: HTMLElement) {
  return Array.from(sheet.querySelectorAll<HTMLElement>(SHEET_FOCUSABLE)).filter((el) => {
    if (el.closest('[hidden], [aria-hidden="true"]')) return false
    if (el.offsetParent !== null) return true
    const style = window.getComputedStyle(el)
    return style.display !== 'none' && style.visibility !== 'hidden'
  })
}

export function MobileCollectionSheet({ type, open, onClose }: MobileCollectionSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => {
      const sheet = sheetRef.current
      if (!sheet) return
      // Focus already inside the sheet (a field the user reached, or a control a nested
      // confirmation restored) stays where it is.
      if (document.activeElement instanceof Node && sheet.contains(document.activeElement)) return
      // Another open dialog owns focus, as it owns the keyboard in onKeyDown below.
      if (Array.from(document.querySelectorAll('[aria-modal="true"]')).some((el) => el !== sheet)) return
      sheet.querySelector<HTMLElement>('[aria-label="Close collections"]')?.focus()
    })
    function onKeyDown(event: KeyboardEvent) {
      const sheet = sheetRef.current
      if (!sheet) return
      const otherModal = Array.from(document.querySelectorAll('[aria-modal="true"]')).some((el) => el !== sheet)
      if (otherModal) return
      if (event.key === 'Escape') {
        if (event.defaultPrevented) return
        if (isTextField(event.target) || isTextField(document.activeElement)) return
        if (sheet.querySelector('[role="menu"]')) return
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = focusableIn(sheet)
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      const active = document.activeElement
      if (!(active instanceof Node) || !sheet.contains(active)) {
        event.preventDefault()
        first.focus()
        return
      }
      if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown)
      if (restoreRef.current?.isConnected) restoreRef.current.focus()
    }
  }, [open])

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
        ref={sheetRef}
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
