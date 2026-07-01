'use client'

import { useSyncStore, type DomainSyncProgress, type InitialSyncDomain } from '@/app/stores/use-sync-store'
import { boundedSyncPercentage } from '@/app/lib/sync-summary'

const domainLabels: Record<InitialSyncDomain, { label: string; noun: string }> = {
  calendar: { label: 'Calendar', noun: 'events' },
  tasks: { label: 'Tasks', noun: 'tasks' },
  contacts: { label: 'Contacts', noun: 'contacts' },
}

const phaseLabels: Record<string, string> = {
  restoring: 'Restoring encrypted session',
  calendar: 'Loading calendar',
  tasks: 'Loading tasks',
  contacts: 'Loading contacts',
  preferences: 'Finishing encrypted settings',
  error: 'Sync needs attention',
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value)
}

export function formatInitialSyncCount(domain: InitialSyncDomain, progress: DomainSyncProgress): string {
  const { noun } = domainLabels[domain]
  const loaded = formatNumber(progress.loaded)
  const percentage = boundedSyncPercentage(progress.loaded, progress.knownTotal)

  if (progress.knownTotal === null || progress.knownTotal <= 0 || percentage === null) {
    return `${loaded} ${noun} loaded so far`
  }

  const known = formatNumber(progress.knownTotal)
  const overLastSync = progress.loaded > progress.knownTotal ? ' — more than last sync' : ''
  return `${loaded} / about ${known} ${noun} loaded (${percentage}%)${overLastSync}`
}

export function InitialSyncProgress() {
  const progress = useSyncStore((s) => s.initialSyncProgress)

  if (!progress.active || progress.phase === 'blocked') return null

  const activeDomain: InitialSyncDomain = progress.phase === 'tasks'
    ? 'tasks'
    : progress.phase === 'contacts'
      ? 'contacts'
      : 'calendar'
  const activeProgress = progress[activeDomain]
  const percent = boundedSyncPercentage(activeProgress.loaded, activeProgress.knownTotal)

  return (
    <section
      aria-label="Initial encrypted data sync progress"
      className="border-b border-[rgb(var(--border))] bg-emerald-500/10 px-4 py-3 text-sm text-[rgb(var(--foreground))]"
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="font-medium">{phaseLabels[progress.phase] ?? 'Loading encrypted data'}</p>
            <p className="text-xs text-[rgb(var(--muted))]">
              Encrypted data is loading and decrypting locally in this browser.
            </p>
          </div>
          <p className="text-xs tabular-nums text-[rgb(var(--muted))]">
            {formatInitialSyncCount(activeDomain, activeProgress)}
          </p>
        </div>
        {percent !== null && (
          <div className="h-1.5 overflow-hidden rounded-full bg-[rgb(var(--surface))]" aria-hidden="true">
            <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${percent}%` }} />
          </div>
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[rgb(var(--muted))]">
          {(Object.keys(domainLabels) as InitialSyncDomain[]).map((domain) => (
            <span key={domain}>
              {domainLabels[domain].label}: {formatInitialSyncCount(domain, progress[domain])}
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}
