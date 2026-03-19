'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { CalendarDays, CheckSquare, Users, Settings } from 'lucide-react'

const items = [
  { href: '/calendar', label: 'Calendar', icon: CalendarDays },
  { href: '/tasks', label: 'Tasks', icon: CheckSquare },
  { href: '/contacts', label: 'Contacts', icon: Users },
  { href: '/settings', label: 'Settings', icon: Settings },
]

export function BottomNav() {
  const pathname = usePathname()

  return (
    <nav
      aria-label="Mobile navigation"
      className="fixed inset-x-0 bottom-0 z-50 flex border-t border-[rgb(var(--border))] bg-[rgb(var(--background))]/95 backdrop-blur-sm bottom-nav-safe md:hidden"
    >
      {items.map(({ href, label, icon: Icon }) => {
        const isActive = pathname.startsWith(href)
        return (
          <Link
            key={href}
            href={href}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500 ${
              isActive
                ? 'text-[rgb(var(--primary))]'
                : 'text-[rgb(var(--muted))] active:text-[rgb(var(--foreground))]'
            }`}
            aria-current={isActive ? 'page' : undefined}
          >
            <div
              className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
                isActive ? 'bg-[rgb(var(--primary))]/10' : ''
              }`}
            >
              <Icon className="h-5 w-5" strokeWidth={isActive ? 2.5 : 2} />
            </div>
            <span>{label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
