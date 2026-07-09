import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { PartialLoadBanner } from '../partial-load-banner'

const authState = {
  isAuthenticated: false,
}

const etebaseState = {
  restoreBlocked: false,
}

const syncState = {
  partialLoad: false,
  syncStatus: 'synced' as const,
  simulateSyncCycle: vi.fn(),
}

vi.mock('@/app/stores/use-auth-store', () => ({
  useAuthStore: (selector: (s: typeof authState) => unknown) => selector(authState),
}))

vi.mock('@/app/stores/use-etebase-store', () => ({
  useEtebaseStore: (selector: (s: typeof etebaseState) => unknown) => selector(etebaseState),
}))

vi.mock('@/app/stores/use-sync-store', () => ({
  useSyncStore: (selector: (s: typeof syncState) => unknown) => selector(syncState),
}))

describe('PartialLoadBanner', () => {
  beforeEach(() => {
    authState.isAuthenticated = false
    etebaseState.restoreBlocked = false
    syncState.partialLoad = false
    syncState.syncStatus = 'synced'
    syncState.simulateSyncCycle.mockClear()
  })

  it('renders when authenticated with a partial load', () => {
    authState.isAuthenticated = true
    syncState.partialLoad = true

    render(<PartialLoadBanner />)

    expect(screen.getByText(/Some of your data could not be loaded/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry sync/i })).toBeEnabled()
  })

  it('hides when restore-blocked is active, unauthenticated, or healthy', () => {
    authState.isAuthenticated = true
    syncState.partialLoad = true
    etebaseState.restoreBlocked = true
    const { container, rerender } = render(<PartialLoadBanner />)
    expect(container).toBeEmptyDOMElement()

    etebaseState.restoreBlocked = false
    authState.isAuthenticated = false
    rerender(<PartialLoadBanner />)
    expect(container).toBeEmptyDOMElement()

    authState.isAuthenticated = true
    syncState.partialLoad = false
    rerender(<PartialLoadBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('uses static privacy-safe copy and retries sync', () => {
    authState.isAuthenticated = true
    syncState.partialLoad = true

    const { container } = render(<PartialLoadBanner />)
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/restoreSession|sessionRead|listItems|syncEngine|item-|col-|uid|token/i)
    expect(text).not.toMatch(/error|failed/i)

    fireEvent.click(screen.getByRole('button', { name: /retry sync/i }))
    expect(syncState.simulateSyncCycle).toHaveBeenCalledTimes(1)
  })

  it('disables retry while syncing or offline', () => {
    authState.isAuthenticated = true
    syncState.partialLoad = true
    syncState.syncStatus = 'syncing'

    const { rerender } = render(<PartialLoadBanner />)
    expect(screen.getByRole('button', { name: /retry sync/i })).toBeDisabled()

    syncState.syncStatus = 'offline'
    rerender(<PartialLoadBanner />)
    expect(screen.getByRole('button', { name: /retry sync/i })).toBeDisabled()
  })
})
