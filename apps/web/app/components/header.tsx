'use client'

import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { LogOut, ChevronDown, Shield, Settings, Lock } from 'lucide-react'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { ThemeToggle } from '@/app/components/theme-toggle'
import { SyncIndicator } from '@/app/components/SyncIndicator'

const titles: Record<string, string> = {
  '/calendar': 'Calendar',
  '/tasks': 'Tasks',
  '/contacts': 'Contacts',
  '/settings': 'Settings',
}

export function Header() {
  const pathname = usePathname()
  const { user, logout } = useAuthStore()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuItemsRef = useRef<(HTMLAnchorElement | HTMLButtonElement | null)[]>([])

  const title = Object.entries(titles).find(([path]) =>
    pathname.startsWith(path)
  )?.[1] ?? 'SilentSuite'

  // L-01: Page titles are set via useEffect rather than Next.js metadata API because
  // this app uses a client-side layout with 'use client' throughout the (app) route group.
  // The Header component already knows the current route via usePathname(), making this
  // the natural place to manage document.title. Moving to the metadata API would require
  // refactoring the entire layout hierarchy to support server components.
  useEffect(() => {
    document.title = title === 'SilentSuite' ? 'SilentSuite' : `${title} | SilentSuite`
  }, [title])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // Auto-focus first menu item on open
  useEffect(() => {
    if (menuOpen) {
      requestAnimationFrame(() => menuItemsRef.current[0]?.focus())
    }
  }, [menuOpen])

  const handleMenuKeyDown = (e: React.KeyboardEvent) => {
    const items = menuItemsRef.current.filter(Boolean) as HTMLElement[]
    const idx = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      items[(idx + 1) % items.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      items[(idx - 1 + items.length) % items.length]?.focus()
    } else if (e.key === 'Home') {
      e.preventDefault()
      items[0]?.focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      items[items.length - 1]?.focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setMenuOpen(false)
    }
  }

  return (
    <header className="relative z-40 flex h-12 shrink-0 items-center justify-between border-b border-[rgb(var(--border))] bg-[rgb(var(--background))]/95 backdrop-blur-sm px-4">
      {/* Mobile: show SilentSuite branding since sidebar is hidden */}
      <div className="flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[rgb(var(--primary))]/10 border border-[rgb(var(--primary))]/20 md:hidden">
          <Shield className="h-3.5 w-3.5 text-[rgb(var(--primary))]" />
        </div>
        <h1 className="text-sm font-semibold text-[rgb(var(--foreground))]">
          {title}
        </h1>
      </div>

      <div className="flex items-center gap-1">
        <SyncIndicator />
        <div className="hidden sm:flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1">
          <Lock className="h-3 w-3 text-emerald-500" />
          <span className="text-[10px] font-medium text-emerald-500">E2E Encrypted</span>
        </div>
        <ThemeToggle />

        {/* User menu */}
        <div ref={menuRef} className="relative">
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="flex items-center gap-1 rounded-md px-2 py-1.5 min-h-[44px] md:min-h-0 text-sm text-[rgb(var(--foreground))] hover:bg-[rgb(var(--surface))] focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 transition-colors"
            aria-label="User menu"
            aria-haspopup="true"
            aria-expanded={menuOpen}
          >
            <span className="hidden max-w-[140px] truncate text-xs text-[rgb(var(--muted))] sm:inline">
              {user?.email}
            </span>
            <ChevronDown className={`h-4 w-4 text-[rgb(var(--muted))] transition-transform ${menuOpen ? 'rotate-180' : ''}`} />
          </button>

          {menuOpen && (
            <div
              className="absolute right-0 top-full z-[100] mt-1 w-48 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--background))] py-1 shadow-lg"
              role="menu"
              aria-label="User menu"
              onKeyDown={handleMenuKeyDown}
            >
              <div className="border-b border-[rgb(var(--border))] px-3 py-2">
                <p className="truncate text-xs text-[rgb(var(--muted))]">
                  {user?.email}
                </p>
              </div>
              <Link
                ref={(el) => { menuItemsRef.current[0] = el }}
                href="/settings/account"
                onClick={() => setMenuOpen(false)}
                role="menuitem"
                tabIndex={-1}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[rgb(var(--foreground))] hover:bg-[rgb(var(--surface))] focus:bg-[rgb(var(--surface))] focus:outline-none transition-colors"
              >
                <Settings className="h-4 w-4" />
                Account settings
              </Link>
              <button
                ref={(el) => { menuItemsRef.current[1] = el }}
                onClick={() => {
                  setMenuOpen(false)
                  logout()
                }}
                role="menuitem"
                tabIndex={-1}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[rgb(var(--foreground))] hover:bg-[rgb(var(--surface))] focus:bg-[rgb(var(--surface))] focus:outline-none transition-colors"
              >
                <LogOut className="h-4 w-4" />
                Log out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
