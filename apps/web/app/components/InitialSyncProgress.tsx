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

  if (!progress.active || progress.phase === 'blocked' || progress.phase === 'error') return null

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
      className="border-b border-[rgb(var(--border))] bg-[rgb(var(--surface))]/60 px-4 py-2 text-xs text-[rgb(var(--muted))]"
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-medium text-[rgb(var(--foreground))]">{phaseLabels[progress.phase] ?? 'Loading encrypted data'}</span>
          <span>Decrypting locally in this browser.</span>
          <span className="tabular-nums">{formatInitialSyncCount(activeDomain, activeProgress)}</span>
        </div>
        {percent !== null && (
          <div className="h-1 overflow-hidden rounded-full bg-[rgb(var(--border))]" aria-hidden="true">
            <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${percent}%` }} />
          </div>
        )}
        <div className="flex flex-wrap gap-x-3 gap-y-1">
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
