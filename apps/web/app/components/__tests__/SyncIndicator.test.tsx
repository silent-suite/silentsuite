import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SyncIndicator } from '../SyncIndicator'
import type { SyncStatus } from '@silentsuite/core'

// Mock the sync store
const mockSyncState = {
  syncStatus: 'synced' as SyncStatus,
  lastSyncedAt: null as Date | null,
  error: null as string | null,
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
    expect(dot.className).toContain('bg-amber-500')
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
})
