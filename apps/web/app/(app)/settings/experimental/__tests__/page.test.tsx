import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ExperimentalSettingsPage from '../page'
import { BottomNav } from '@/app/components/bottom-nav'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useExperimentalStore } from '@/app/stores/use-experimental-store'
import { bumpAccountEpoch } from '@/app/lib/account-epoch'

const calls = vi.hoisted(() => ({ create: vi.fn(), canWrite: vi.fn(() => true) }))
vi.mock('next/navigation', () => ({ usePathname: () => '/settings/experimental' }))
vi.mock('@/app/stores/use-auth-store', () => ({ useAuthStore: { getState: () => ({ canWrite: calls.canWrite }) } }))
vi.mock('@/app/stores/use-etebase-store', async () => {
  const { create } = await import('zustand')
  return { useEtebaseStore: create(() => ({
    account: {}, accountFingerprint: 'account-a', isInitialized: true, restoreBlocked: false,
    domainLoadState: { notes: 'loaded' }, collections: { notes: [] }, createCollection: calls.create,
  })) }
})

function renderSettings() {
  return renderWithIntl(<><ExperimentalSettingsPage /><BottomNav /></>)
}

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  useExperimentalStore.setState({ hydrated: false, notesAccounts: [] })
  useEtebaseStore.setState({ accountFingerprint: 'account-a', isInitialized: true, restoreBlocked: false, collections: { calendar: [], tasks: [], contacts: [], notes: [], preferences: [] }, domainLoadState: { calendar: 'loaded', tasks: 'loaded', contacts: 'loaded', notes: 'loaded', preferences: 'unknown' } })
  calls.canWrite.mockReturnValue(true)
  calls.create.mockReset().mockImplementation(async () => {
    useEtebaseStore.setState({ collections: { ...useEtebaseStore.getState().collections, notes: [{ uid: 'notebook' }] } })
    return 'notebook'
  })
})

describe('Experimental Notes opt-in', () => {
  it('is off without creating anything; enabling creates a notebook once and updates mounted navigation', async () => {
    renderSettings()
    const toggle = screen.getByRole('switch', { name: 'Enable Notes' })
    expect(toggle).not.toBeChecked()
    expect(calls.create).not.toHaveBeenCalled()
    expect(screen.queryByRole('link', { name: 'Notes' })).not.toBeInTheDocument()
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toBeChecked())
    expect(calls.create).toHaveBeenCalledExactlyOnceWith('notes', 'Personal Notes', '#f59e0b')
    expect(screen.getByRole('link', { name: 'Notes' })).toBeInTheDocument()
    const collections = useEtebaseStore.getState().collections
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).not.toBeChecked())
    expect(screen.queryByRole('link', { name: 'Notes' })).not.toBeInTheDocument()
    expect(useEtebaseStore.getState().collections).toBe(collections)
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toBeChecked())
    expect(calls.create).toHaveBeenCalledTimes(1)
  })

  it('reuses existing notebooks even for a read-only account', async () => {
    useEtebaseStore.setState({ collections: { ...useEtebaseStore.getState().collections, notes: [{ uid: 'existing' }] } })
    calls.canWrite.mockReturnValue(false)
    renderSettings()
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(screen.getByRole('switch')).toBeChecked())
    expect(calls.create).not.toHaveBeenCalled()
  })

  it('restores the setting on reload and isolates account switches without manual rerender', async () => {
    localStorage.setItem('silentsuite-experimental-v1', '["account-a"]')
    renderSettings()
    expect(screen.getByRole('switch')).toBeChecked()
    act(() => { bumpAccountEpoch(); useEtebaseStore.setState({ accountFingerprint: null }) })
    expect(screen.getByRole('switch')).not.toBeChecked()
    expect(screen.getByRole('switch')).toBeDisabled()
    act(() => useEtebaseStore.setState({ accountFingerprint: 'account-b' }))
    expect(screen.getByRole('switch')).not.toBeChecked()
    act(() => useEtebaseStore.setState({ accountFingerprint: 'account-a' }))
    expect(screen.getByRole('switch')).toBeChecked()
    expect(calls.create).not.toHaveBeenCalled()
  })

  it('does not opt in after notebook creation fails and permits retry', async () => {
    calls.create.mockResolvedValueOnce(null)
    renderSettings()
    fireEvent.click(screen.getByRole('switch'))
    await screen.findByRole('alert')
    expect(screen.getByRole('switch')).not.toBeChecked()
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(screen.getByRole('switch')).toBeChecked())
  })

  it('does not apply a stale enable when the account changes during creation', async () => {
    let resolve!: (value: string) => void
    calls.create.mockReturnValue(new Promise<string>((done) => { resolve = done }))
    renderSettings()
    fireEvent.click(screen.getByRole('switch'))
    act(() => { bumpAccountEpoch(); useEtebaseStore.setState({ accountFingerprint: 'account-b' }) })
    await act(async () => resolve('old-notebook'))
    expect(screen.getByRole('switch')).not.toBeChecked()
    expect(useExperimentalStore.getState().notesAccounts).toEqual([])
    expect(screen.getByRole('switch')).not.toBeDisabled()
  })

  it.each(['unknown', 'failed'] as const)('cannot create based on a %s notebook read', (status) => {
    useEtebaseStore.setState({ domainLoadState: { ...useEtebaseStore.getState().domainLoadState, notes: status } })
    renderSettings()
    expect(screen.getByRole('switch')).toBeDisabled()
    expect(calls.create).not.toHaveBeenCalled()
  })

  it('reports storage failures without falsely enabling Notes', async () => {
    renderSettings()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    fireEvent.click(screen.getByRole('switch'))
    await screen.findByRole('alert')
    expect(screen.getByRole('switch')).not.toBeChecked()
  })
})
