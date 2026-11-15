'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const RIGHT_SIDEBAR_ID = 'app-right-sidebar'

/** Full-height column on the right of the app shell; empty (and zero width) unless a page fills it. */
export function RightSidebarSlot() {
  return <div id={RIGHT_SIDEBAR_ID} className="hidden md:flex" />
}

/**
 * Renders a page's sidebar into the shell's right column, so it spans the full height like the
 * left navigation. Without the shell (tests, other layouts) it renders in place.
 */
export function RightSidebarPortal({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null | undefined>(undefined)
  useEffect(() => { setTarget(document.getElementById(RIGHT_SIDEBAR_ID)) }, [])
  if (target === undefined) return null
  return target ? createPortal(children, target) : <>{children}</>
}
