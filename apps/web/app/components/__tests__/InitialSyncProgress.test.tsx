import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { InitialSyncProgress, formatInitialSyncCount } from '../InitialSyncProgress'
import type { InitialSyncProgressState } from '@/app/stores/use-sync-store'

const mockState: { initialSyncProgress: InitialSyncProgressState } = {
  initialSyncProgress: {
    active: true,
    phase: 'calendar',
    calendar: { loaded: 600, knownTotal: null, done: false },
    tasks: { loaded: 0, knownTotal: null, done: false },
    contacts: { loaded: 0, knownTotal: null, done: false },
    message: null,
  },
}

vi.mock('@/app/stores/use-sync-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/stores/use-sync-store')>()),
  useSyncStore: (selector: (state: typeof mockState) => unknown) => selector(mockState),
}))

describe('InitialSyncProgress', () => {
  beforeEach(() => {
    mockState.initialSyncProgress = {
      active: true,
      phase: 'calendar',
      calendar: { loaded: 600, knownTotal: null, done: false },
      tasks: { loaded: 0, knownTotal: null, done: false },
      contacts: { loaded: 0, knownTotal: null, done: false },
      message: null,
    }
  })

  it('shows first-sync counts without a percentage when totals are unknown', () => {
    render(<InitialSyncProgress />)

    expect(screen.getByText(/Decrypting locally in this browser/i)).toBeInTheDocument()
    expect(screen.getAllByText(/600 events loaded so far/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/600 \/ about/)).not.toBeInTheDocument()
  })

  it('shows approximate totals and bounded percentage for later syncs', () => {
    mockState.initialSyncProgress.calendar = { loaded: 600, knownTotal: 3000, done: false }

    render(<InitialSyncProgress />)

    expect(screen.getAllByText(/600 \/ about 3,000 events loaded \(20%\)/).length).toBeGreaterThan(0)
  })

  it('handles zero and over-last-sync totals safely', () => {
    expect(formatInitialSyncCount('calendar', { loaded: 5, knownTotal: 0, done: false })).toBe('5 events loaded so far')
    expect(formatInitialSyncCount('tasks', { loaded: 12, knownTotal: 10, done: false })).toBe('12 / about 10 tasks loaded (100%) — more than last sync')
  })

  it('does not render when inactive, blocked, or errored', () => {
    mockState.initialSyncProgress.active = false
    const { rerender } = render(<InitialSyncProgress />)
    expect(screen.queryByLabelText('Initial encrypted data sync progress')).not.toBeInTheDocument()

    mockState.initialSyncProgress.active = true
    mockState.initialSyncProgress.phase = 'blocked'
    rerender(<InitialSyncProgress />)
    expect(screen.queryByLabelText('Initial encrypted data sync progress')).not.toBeInTheDocument()

    mockState.initialSyncProgress.phase = 'error'
    rerender(<InitialSyncProgress />)
    expect(screen.queryByLabelText('Initial encrypted data sync progress')).not.toBeInTheDocument()
  })
})
