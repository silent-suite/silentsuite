import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SyncIndicator } from '../SyncIndicator'
import type { SyncStatus } from '@silentsuite/core'

// Mock the sync store
const mockSyncState = {
  syncStatus: 'synced' as SyncStatus,
  lastSyncedAt: null as Date | null,
  error: null as string | null,
  pendingQueueCount: 0,
  partialLoad: false,
  simulateSyncCycle: vi.fn(),
}

vi.mock('@/app/stores/use-sync-store', () => ({
  useSyncStore: (selector: (s: typeof mockSyncState) => unknown) => selector(mockSyncState),
}))

vi.mock('@/app/lib/format-time-ago', () => ({
  formatTimeAgo: () => 'just now',
}))

describe('SyncIndicator', () => {
  beforeEach(() => {
    mockSyncState.syncStatus = 'synced'
    mockSyncState.lastSyncedAt = null
    mockSyncState.error = null
    mockSyncState.pendingQueueCount = 0
    mockSyncState.partialLoad = false
    mockSyncState.simulateSyncCycle.mockClear()
    sessionStorage.clear()
  })

  it('renders synced status with emerald color', () => {
    mockSyncState.syncStatus = 'synced'
    render(<SyncIndicator />)
    const dot = screen.getByRole('status')
    expect(dot).toHaveAttribute('aria-label', 'Sync status: synced')
    expect(dot.className).toContain('bg-emerald-500')
  })

  it('renders syncing status with amber color', () => {
    mockSyncState.syncStatus = 'syncing'
    render(<SyncIndicator />)
    const dot = screen.getByRole('status')
    expect(dot).toHaveAttribute('aria-label', 'Sync status: syncing')
    expect(dot.className).toContain('bg-amber-400')
  })

  it('renders a synced warning affordance when partial load is active', () => {
    mockSyncState.syncStatus = 'synced'
    mockSyncState.partialLoad = true
    render(<SyncIndicator />)
    const dot = screen.getByRole('status')
    expect(dot).toHaveAttribute('aria-label', 'Sync status: synced with warning')
    expect(dot.className).toContain('bg-amber-400')
  })

  it('renders offline status with gray color', () => {
    mockSyncState.syncStatus = 'offline'
    render(<SyncIndicator />)
    const dot = screen.getByRole('status')
    expect(dot).toHaveAttribute('aria-label', 'Sync status: offline')
    expect(dot.className).toContain('bg-gray-400')
  })

  it('renders error status with red color', () => {
    mockSyncState.syncStatus = 'error'
    render(<SyncIndicator />)
    const dot = screen.getByRole('status')
    expect(dot).toHaveAttribute('aria-label', 'Sync status: error')
    expect(dot.className).toContain('bg-red-500')
  })

  it('does not render diagnostics copy in the app chrome', () => {
    mockSyncState.syncStatus = 'error'
    sessionStorage.setItem('silentsuite.restore-diagnostics.v1', JSON.stringify({
      version: 1,
      source: 'restore',
      generatedAtMs: 1,
      etebaseHost: 'server.silentsuite.io',
      billingHost: 'api.silentsuite.io',
      failedPhase: 'restoreSession',
      entries: [{ phase: 'restoreSession', status: 'failed', errorName: 'Error' }],
    }))

    render(<SyncIndicator />)

    expect(screen.queryByRole('button', { name: 'Copy sync restore diagnostics' })).toBeNull()
    expect(screen.queryByText('Copy diagnostics')).toBeNull()
  })

  it('clicking sync button triggers simulateSyncCycle when available', () => {
    mockSyncState.syncStatus = 'synced'
    render(<SyncIndicator />)
    const button = screen.getByRole('button', { name: 'Sync now' })
    fireEvent.click(button)
    expect(mockSyncState.simulateSyncCycle).toHaveBeenCalledTimes(1)
  })
})
