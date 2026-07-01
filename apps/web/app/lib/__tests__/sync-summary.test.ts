import { describe, it, expect, beforeEach } from 'vitest'
import { clearLocalSyncSummary, readLocalSyncSummary, writeLocalSyncSummary, boundedSyncPercentage } from '../sync-summary'

describe('sync-summary', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('stores only aggregate counts scoped to the account fingerprint', () => {
    writeLocalSyncSummary('fingerprint-a', { calendarCount: 12, taskCount: 3, contactCount: 4 })

    const summary = readLocalSyncSummary('fingerprint-a')

    expect(summary).toMatchObject({
      schemaVersion: 1,
      accountFingerprint: 'fingerprint-a',
      calendarCount: 12,
      taskCount: 3,
      contactCount: 4,
    })
    expect(Object.keys(summary!)).toEqual([
      'schemaVersion',
      'accountFingerprint',
      'savedAt',
      'calendarCount',
      'taskCount',
      'contactCount',
    ])
  })

  it('ignores and clears summaries for a different fingerprint', () => {
    writeLocalSyncSummary('fingerprint-a', { calendarCount: 1, taskCount: 2, contactCount: 3 })

    expect(readLocalSyncSummary('fingerprint-b')).toBeNull()
    expect(localStorage.getItem('silentsuite-sync-summary')).toBeNull()
  })

  it('clears the local summary', () => {
    writeLocalSyncSummary('fingerprint-a', { calendarCount: 1, taskCount: 2, contactCount: 3 })
    clearLocalSyncSummary()

    expect(readLocalSyncSummary('fingerprint-a')).toBeNull()
  })

  it('bounds progress percentages', () => {
    expect(boundedSyncPercentage(20, 100)).toBe(20)
    expect(boundedSyncPercentage(150, 100)).toBe(100)
    expect(boundedSyncPercentage(-5, 100)).toBe(0)
    expect(boundedSyncPercentage(5, 0)).toBeNull()
    expect(boundedSyncPercentage(5, null)).toBeNull()
  })
})
