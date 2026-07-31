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
const mockPreferenceState = { integrity: 'valid' as 'valid' | 'failed' }

vi.mock('@/app/stores/use-sync-store', () => ({
  useSyncStore: (selector: (s: typeof mockSyncState) => unknown) => selector(mockSyncState),
}))
vi.mock('@/app/stores/use-preferences-sync-store', () => ({
  usePreferencesSyncStore: (selector: (s: typeof mockPreferenceState) => unknown) => selector(mockPreferenceState),
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
    mockPreferenceState.integrity = 'valid'
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

  it('shows a privacy-safe preference warning with the keyboard-accessible retry action', () => {
    mockPreferenceState.integrity = 'failed'
    render(<SyncIndicator />)

    const warning = screen.getByRole('status', { name: 'Account preferences could not be verified' })
    expect(warning).toBeInTheDocument()
    expect(warning).not.toHaveClass('hidden')
    expect(screen.getByText('!', { selector: '[aria-hidden="true"]' })).toBeInTheDocument()
    const retry = screen.getByRole('button', { name: 'Sync now' })
    retry.focus()
    expect(retry).toHaveFocus()
    expect(document.body.textContent).not.toMatch(/item|account-a|24h/i)
  })
})
