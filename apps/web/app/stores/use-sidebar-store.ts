'use client'

import { create } from 'zustand'

interface SidebarState {
  isExpanded: boolean
  toggle: () => void
  setExpanded: (expanded: boolean) => void
}

const STORAGE_KEY = 'silentsuite-sidebar-expanded'

function getInitialExpanded(): boolean {
  if (typeof window === 'undefined') return true
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored !== null) return stored === 'true'
  return window.innerWidth >= 1280
}

export const useSidebarStore = create<SidebarState>((set) => ({
  isExpanded: true, // SSR default, hydrated on mount
  toggle: () =>
    set((state) => {
      const next = !state.isExpanded
      localStorage.setItem(STORAGE_KEY, String(next))
      return { isExpanded: next }
    }),
  setExpanded: (expanded: boolean) => {
    localStorage.setItem(STORAGE_KEY, String(expanded))
    set({ isExpanded: expanded })
  },
}))

export function initializeSidebar() {
  useSidebarStore.setState({ isExpanded: getInitialExpanded() })
}
