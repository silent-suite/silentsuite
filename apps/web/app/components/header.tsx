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

  const title = Object.entries(titles).find(([path]) =>
    pathname.startsWith(path)
  )?.[1] ?? 'SilentSuite'

  // Update document title per page
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
            className="no-min-size flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-[rgb(var(--foreground))] hover:bg-[rgb(var(--surface))] focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 transition-colors"
            aria-label="User menu"
            aria-expanded={menuOpen}
          >
            <span className="hidden max-w-[140px] truncate text-xs text-[rgb(var(--muted))] sm:inline">
              {user?.email}
            </span>
            <ChevronDown className={`h-4 w-4 text-[rgb(var(--muted))] transition-transform ${menuOpen ? 'rotate-180' : ''}`} />
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-full z-[100] mt-1 w-48 rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--background))] py-1 shadow-lg">
              <div className="border-b border-[rgb(var(--border))] px-3 py-2">
                <p className="truncate text-xs text-[rgb(var(--muted))]">
                  {user?.email}
                </p>
              </div>
              <Link
                href="/settings/account"
                onClick={() => setMenuOpen(false)}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[rgb(var(--foreground))] hover:bg-[rgb(var(--surface))] transition-colors"
              >
                <Settings className="h-4 w-4" />
                Account settings
              </Link>
              <button
                onClick={() => {
                  setMenuOpen(false)
                  logout()
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[rgb(var(--foreground))] hover:bg-[rgb(var(--surface))] transition-colors"
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
