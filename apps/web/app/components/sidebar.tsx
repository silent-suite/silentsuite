'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  CalendarDays,
  CheckSquare,
  Users,
  Settings,
  Shield,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import { useSidebarStore, initializeSidebar } from '@/app/stores/use-sidebar-store'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { isSelfHosted } from '@/app/lib/self-hosted'
import { MiniCalendar } from '@/app/(app)/calendar/components/MiniCalendar'
import { CalendarListPanel } from '@/app/components/CalendarListPanel'
import { TaskListPanel } from '@/app/components/TaskListPanel'
import { ContactListPanel } from '@/app/components/ContactListPanel'
import { OnboardingChecklist } from '@/app/components/OnboardingChecklist'

const navItems = [
  { href: '/calendar', label: 'Calendar', icon: CalendarDays },
  { href: '/tasks', label: 'Tasks', icon: CheckSquare },
  { href: '/contacts', label: 'Contacts', icon: Users },
]

export function Sidebar() {
  const { isExpanded, toggle } = useSidebarStore()
  const pathname = usePathname()
  const isAdmin = useAuthStore((s) => s.user?.isAdmin) || isSelfHosted

  useEffect(() => {
    initializeSidebar()
  }, [])

  return (
    <nav
      aria-label="Main navigation"
      className="hidden md:flex flex-col border-r border-[rgb(var(--border))] bg-[rgb(var(--surface))] transition-[width] duration-200 ease-in-out z-40 overflow-visible"
      style={{ width: isExpanded ? 240 : 56 }}
    >
      {/* Logo */}
      <div className="flex h-12 items-center gap-2 overflow-hidden px-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[rgb(var(--primary))]/10 border border-[rgb(var(--primary))]/20">
          <Shield className="h-4 w-4 text-[rgb(var(--primary))]" />
        </div>
        {isExpanded && (
          <span className="truncate text-sm font-semibold text-[rgb(var(--foreground))]">
            SilentSuite
          </span>
        )}
      </div>

      {/* Context-aware sidebar panel */}
      {isExpanded && (
        <div className="border-t border-b border-[rgb(var(--border))]">
          {pathname.startsWith('/calendar') && (
            <>
              <MiniCalendar />
              <CalendarListPanel />
            </>
          )}
          {pathname.startsWith('/tasks') && (
            <TaskListPanel />
          )}
          {pathname.startsWith('/contacts') && (
            <ContactListPanel />
          )}
        </div>
      )}

      {/* Nav items */}
      <div className="mt-2 flex flex-1 flex-col gap-1 px-2">
        {navItems.map(({ href, label, icon: Icon }) => {
          const isActive = pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              className={`group relative flex items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 ${
                isActive
                  ? 'bg-[rgb(var(--primary))]/10 text-[rgb(var(--primary))] font-medium'
                  : 'text-[rgb(var(--muted))] hover:bg-[rgb(var(--background))] hover:text-[rgb(var(--foreground))]'
              }`}
              aria-current={isActive ? 'page' : undefined}
            >
              <Icon className="h-5 w-5 shrink-0" />
              {isExpanded ? (
                <span className="truncate">{label}</span>
              ) : (
                <span className="pointer-events-none absolute left-full ml-2 z-[100] hidden whitespace-nowrap rounded-md bg-[rgb(var(--foreground))] px-2 py-1 text-xs text-[rgb(var(--background))] shadow-lg group-hover:block">
                  {label}
                </span>
              )}
            </Link>
          )
        })}
      </div>

      {/* Onboarding checklist */}
      {isExpanded && <OnboardingChecklist />}

      {/* Bottom section */}
      <div className="flex flex-col gap-1 border-t border-[rgb(var(--border))] px-2 py-2">
        {isAdmin && (
          <Link
            href="/admin"
            className={`group relative flex items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 ${
              pathname.startsWith('/admin')
                ? 'bg-[rgb(var(--primary))]/10 text-[rgb(var(--primary))] font-medium'
                : 'text-[rgb(var(--muted))] hover:bg-[rgb(var(--background))] hover:text-[rgb(var(--foreground))]'
            }`}
            aria-current={pathname.startsWith('/admin') ? 'page' : undefined}
          >
            <Shield className="h-5 w-5 shrink-0" />
            {isExpanded ? (
              <span className="truncate">Admin</span>
            ) : (
              <span className="pointer-events-none absolute left-full ml-2 z-[100] hidden whitespace-nowrap rounded-md bg-[rgb(var(--foreground))] px-2 py-1 text-xs text-[rgb(var(--background))] shadow-lg group-hover:block">
                Admin
              </span>
            )}
          </Link>
        )}
        <Link
          href="/settings"
          className={`group relative flex items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 ${
            pathname.startsWith('/settings')
              ? 'bg-[rgb(var(--primary))]/10 text-[rgb(var(--primary))] font-medium'
              : 'text-[rgb(var(--muted))] hover:bg-[rgb(var(--background))] hover:text-[rgb(var(--foreground))]'
          }`}
          aria-current={pathname.startsWith('/settings') ? 'page' : undefined}
        >
          <Settings className="h-5 w-5 shrink-0" />
          {isExpanded ? (
            <span className="truncate">Settings</span>
          ) : (
            <span className="pointer-events-none absolute left-full ml-2 z-[100] hidden whitespace-nowrap rounded-md bg-[rgb(var(--foreground))] px-2 py-1 text-xs text-[rgb(var(--background))] shadow-lg group-hover:block">
              Settings
            </span>
          )}
        </Link>

        <button
          onClick={toggle}
          className="flex items-center gap-3 rounded-md px-2 py-2 text-sm text-[rgb(var(--muted))] hover:bg-[rgb(var(--background))] hover:text-[rgb(var(--foreground))] transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2"
          aria-label={isExpanded ? 'Collapse sidebar' : 'Expand sidebar'}
        >
          {isExpanded ? (
            <>
              <ChevronLeft className="h-5 w-5 shrink-0" />
              <span className="truncate">Collapse</span>
            </>
          ) : (
            <ChevronRight className="h-5 w-5 shrink-0" />
          )}
        </button>
      </div>
    </nav>
  )
}
