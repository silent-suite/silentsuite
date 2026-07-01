'use client'

const STORAGE_KEY = 'silentsuite-sync-summary'

export interface LocalSyncSummary {
  schemaVersion: 1
  accountFingerprint: string
  savedAt: number
  calendarCount: number
  taskCount: number
  contactCount: number
}

export interface SyncSummaryCounts {
  calendarCount: number
  taskCount: number
  contactCount: number
}

function storage(): Storage | null {
  return typeof window === 'undefined' ? null : window.localStorage
}

function isSummary(value: unknown): value is LocalSyncSummary {
  if (!value || typeof value !== 'object') return false
  const summary = value as Record<string, unknown>
  return summary.schemaVersion === 1
    && typeof summary.accountFingerprint === 'string'
    && typeof summary.savedAt === 'number'
    && typeof summary.calendarCount === 'number'
    && typeof summary.taskCount === 'number'
    && typeof summary.contactCount === 'number'
}

export function readLocalSyncSummary(accountFingerprint: string | null): LocalSyncSummary | null {
  if (!accountFingerprint) return null
  const store = storage()
  if (!store) return null
  try {
    const raw = store.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!isSummary(parsed)) {
      store.removeItem(STORAGE_KEY)
      return null
    }
    if (parsed.accountFingerprint !== accountFingerprint) {
      store.removeItem(STORAGE_KEY)
      return null
    }
    return parsed
  } catch {
    store.removeItem(STORAGE_KEY)
    return null
  }
}

export function writeLocalSyncSummary(accountFingerprint: string, counts: SyncSummaryCounts): LocalSyncSummary | null {
  const store = storage()
  if (!store) return null
  const summary: LocalSyncSummary = {
    schemaVersion: 1,
    accountFingerprint,
    savedAt: Date.now(),
    calendarCount: Math.max(0, Math.trunc(counts.calendarCount)),
    taskCount: Math.max(0, Math.trunc(counts.taskCount)),
    contactCount: Math.max(0, Math.trunc(counts.contactCount)),
  }
  store.setItem(STORAGE_KEY, JSON.stringify(summary))
  return summary
}

export function clearLocalSyncSummary(): void {
  storage()?.removeItem(STORAGE_KEY)
}

export function boundedSyncPercentage(loaded: number, knownTotal: number | null): number | null {
  if (knownTotal === null || knownTotal <= 0) return null
  const safeLoaded = Math.max(0, loaded)
  return Math.min(100, Math.max(0, Math.floor((safeLoaded / knownTotal) * 100)))
}
