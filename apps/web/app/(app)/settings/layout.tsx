'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { isSelfHosted } from '@/app/lib/self-hosted'

const allTabs = [
  { label: 'Account', href: '/settings/account' },
  { label: 'Subscription', href: '/settings/subscription' },
  { label: 'Security', href: '/settings/security' },
  { label: 'Mobile', href: '/settings/mobile' },
  { label: 'Import', href: '/settings/import' },
  { label: 'Export', href: '/settings/export' },
]

const tabs = isSelfHosted
  ? allTabs.filter((t) => t.href !== '/settings/subscription')
  : allTabs

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <h1 className="text-lg font-semibold text-[rgb(var(--foreground))]">Settings</h1>

      <nav className="flex gap-1 border-b border-[rgb(var(--border))] overflow-x-auto scrollbar-hide -mx-4 px-4 md:mx-0 md:px-0">
        {tabs.map((tab) => {
          const isActive = pathname.startsWith(tab.href)
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`whitespace-nowrap px-4 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? 'border-b-2 border-[rgb(var(--primary))] text-[rgb(var(--foreground))]'
                  : 'text-[rgb(var(--muted))] hover:text-[rgb(var(--foreground))]'
              }`}
            >
              {tab.label}
            </Link>
          )
        })}
      </nav>

      <div>{children}</div>
    </div>
  )
}
