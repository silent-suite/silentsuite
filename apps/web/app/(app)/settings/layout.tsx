'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { SettingsNav } from './settings-nav'

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const isOverview = pathname === '/settings'

  if (isOverview) {
    return (
      <div className="mx-auto w-full max-w-4xl space-y-6">
        <h1 className="text-lg font-semibold text-[rgb(var(--foreground))]">Settings</h1>
        <div>{children}</div>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <Link
        href="/settings"
        className="-ml-2 inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm font-medium text-[rgb(var(--muted))] transition-colors hover:text-[rgb(var(--foreground))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 dark:focus-visible:ring-emerald-300 lg:hidden"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        Settings
      </Link>
      <h1 className="sr-only text-lg font-semibold text-[rgb(var(--foreground))] lg:not-sr-only">Settings</h1>

      <div className="lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-8">
        <aside className="hidden lg:block">
          <SettingsNav variant="rail" pathname={pathname} />
        </aside>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  )
}
