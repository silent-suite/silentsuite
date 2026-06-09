'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { CalendarDays, CheckSquare, Users, Settings } from 'lucide-react'

const items = [
  { href: '/calendar', labelKey: 'calendar', icon: CalendarDays },
  { href: '/tasks', labelKey: 'tasks', icon: CheckSquare },
  { href: '/contacts', labelKey: 'contacts', icon: Users },
  { href: '/settings', labelKey: 'settings', icon: Settings },
]

export function BottomNav() {
  const t = useTranslations('Navigation')
  const pathname = usePathname()

  return (
    <nav
      aria-label={t('mobileNavigation')}
      className="fixed inset-x-0 bottom-0 z-50 flex border-t border-[rgb(var(--border))] bg-[rgb(var(--background))]/95 backdrop-blur-sm bottom-nav-safe md:hidden"
    >
      {items.map(({ href, labelKey, icon: Icon }) => {
        const isActive = pathname.startsWith(href)
        const label = t(labelKey)
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
