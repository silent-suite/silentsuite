import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { isSelfHosted } from '@/app/lib/self-hosted'

type SettingsLink = { label: string; href: string; hint: string; hostedOnly?: boolean }
type SettingsGroup = { id: string; label: string; links: SettingsLink[] }

const settingsGroups: SettingsGroup[] = [
  {
    id: 'account',
    label: 'Account',
    links: [
      { label: 'Account', href: '/settings/account', hint: 'Profile, date & time, reminders' },
      { label: 'Security', href: '/settings/security', hint: 'Password & account fingerprint' },
      { label: 'Subscription', href: '/settings/subscription', hint: 'Plan & billing', hostedOnly: true },
    ],
  },
  {
    id: 'data',
    label: 'Data',
    links: [
      { label: 'Sharing', href: '/settings/sharing', hint: 'Invitations & members' },
      { label: 'Import', href: '/settings/import', hint: 'Calendars, tasks & contacts' },
      { label: 'Export', href: '/settings/export', hint: 'Download your data' },
    ],
  },
  {
    id: 'apps',
    label: 'Get the apps',
    links: [
      { label: 'Mobile app', href: '/settings/mobile', hint: 'Android install options' },
      { label: 'Desktop bridge', href: '/settings/desktop', hint: 'Use desktop calendar clients' },
    ],
  },
  {
    id: 'advanced',
    label: 'Advanced',
    links: [
      { label: 'Experimental', href: '/settings/experimental', hint: 'Optional features in development' },
    ],
  },
]

function visibleGroups(): SettingsGroup[] {
  if (!isSelfHosted) return settingsGroups
  return settingsGroups.map((group) => ({
    ...group,
    links: group.links.filter((link) => !link.hostedOnly),
  }))
}

export function isSettingsLinkActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`)
}

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 dark:focus-visible:ring-emerald-300'

export function SettingsNav({ variant, pathname }: { variant: 'overview' | 'rail'; pathname: string }) {
  const isOverview = variant === 'overview'

  return (
    <nav aria-label="Settings" className={isOverview ? 'space-y-6' : 'space-y-4'}>
      {visibleGroups().map((group) => {
        const headingId = `settings-${variant}-${group.id}`
        return (
          <section key={group.id} aria-labelledby={headingId} className="space-y-2">
            <h2
              id={headingId}
              className="px-3 text-xs font-semibold uppercase tracking-wide text-[rgb(var(--muted))]"
            >
              {group.label}
            </h2>
            <ul
              className={
                isOverview
                  ? 'divide-y divide-[rgb(var(--border))] overflow-hidden rounded-lg border border-[rgb(var(--border))] bg-[rgb(var(--surface))]'
                  : 'space-y-1'
              }
            >
              {group.links.map((link) => {
                const isActive = !isOverview && isSettingsLinkActive(pathname, link.href)
                return (
                  <li key={link.href}>
                    {isOverview ? (
                      <Link
                        href={link.href}
                        className={`flex min-h-11 items-center gap-3 px-4 py-3 transition-colors hover:bg-[rgb(var(--primary))]/5 ${focusRing} focus-visible:ring-inset`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-[rgb(var(--foreground))]">{link.label}</span>
                          <span className="mt-0.5 block text-xs text-[rgb(var(--muted))]">{link.hint}</span>
                        </span>
                        <ChevronRight className="h-4 w-4 shrink-0 text-[rgb(var(--muted))]" aria-hidden="true" />
                      </Link>
                    ) : (
                      <Link
                        href={link.href}
                        aria-current={isActive ? 'page' : undefined}
                        className={`flex min-h-11 items-center rounded-md border-l-2 px-3 text-sm transition-colors ${focusRing} ${
                          isActive
                            ? 'border-[rgb(var(--primary))] bg-[rgb(var(--primary))]/10 font-medium text-[rgb(var(--foreground))]'
                            : 'border-transparent text-[rgb(var(--muted))] hover:bg-[rgb(var(--surface))] hover:text-[rgb(var(--foreground))]'
                        }`}
                      >
                        {link.label}
                      </Link>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
    </nav>
  )
}
