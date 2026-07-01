import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SyncIndicator } from '../SyncIndicator'
import type { SyncStatus } from '@silentsuite/core'

// Mock the sync store
const mockSyncState = {
  syncStatus: 'synced' as SyncStatus,
  lastSyncedAt: null as Date | null,
  error: null as string | null,
  pendingQueueCount: 0,
  initialSyncProgress: {
    active: false,
    phase: 'idle' as any,
    calendar: { loaded: 0, knownTotal: null, done: false },
    tasks: { loaded: 0, knownTotal: null, done: false },
    contacts: { loaded: 0, knownTotal: null, done: false },
    message: null,
  },
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
    mockSyncState.initialSyncProgress = {
      active: false,
      phase: 'idle',
      calendar: { loaded: 0, knownTotal: null, done: false },
      tasks: { loaded: 0, knownTotal: null, done: false },
      contacts: { loaded: 0, knownTotal: null, done: false },
      message: null,
    }
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

  it('shows initial sync progress in the tooltip', async () => {
    mockSyncState.syncStatus = 'syncing'
    mockSyncState.initialSyncProgress = {
      ...mockSyncState.initialSyncProgress,
      active: true,
      phase: 'calendar',
      calendar: { loaded: 42, knownTotal: 100, done: false },
    }
    render(<SyncIndicator />)

    fireEvent.mouseEnter(screen.getByRole('status').closest('div')!.parentElement!)

    expect(await screen.findByText('Loading encrypted calendar data locally (42 events)')).toBeInTheDocument()
  })
})
