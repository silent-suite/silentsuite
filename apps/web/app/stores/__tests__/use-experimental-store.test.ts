import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useExperimentalStore } from '../use-experimental-store'

const key = 'silentsuite-experimental-v1'

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  useExperimentalStore.setState({ hydrated: false, notesAccounts: [] })
})

describe('experimental preferences', () => {
  it('defaults off, persists explicit choices, and restores after a reload', () => {
    useExperimentalStore.getState().hydrate()
    expect(useExperimentalStore.getState().notesAccounts).toEqual([])
    useExperimentalStore.getState().setNotesEnabled('account-a', true)
    useExperimentalStore.getState().setNotesEnabled('account-b', true)
    useExperimentalStore.getState().setNotesEnabled('account-a', false)
    useExperimentalStore.setState({ hydrated: false, notesAccounts: [] })
    useExperimentalStore.getState().hydrate()
    expect(useExperimentalStore.getState().notesAccounts).toEqual(['account-b'])
  })

  it.each(['not-json', 'true', '{}', '[true]', '["account-a", null]', '[""]'])('fails closed for malformed storage %s', (value) => {
    localStorage.setItem(key, value)
    useExperimentalStore.getState().hydrate()
    expect(useExperimentalStore.getState()).toMatchObject({ hydrated: true, notesAccounts: [] })
  })

  it('does not overwrite storage during hydration or before it', () => {
    localStorage.setItem(key, '["account-a"]')
    const write = vi.spyOn(Storage.prototype, 'setItem')
    useExperimentalStore.getState().setNotesEnabled('account-b', true)
    useExperimentalStore.getState().hydrate()
    expect(write).not.toHaveBeenCalled()
    expect(useExperimentalStore.getState().notesAccounts).toEqual(['account-a'])
  })

  it('allows a safe default when reading storage fails, but does not claim a failed write succeeded', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    useExperimentalStore.getState().hydrate()
    expect(useExperimentalStore.getState().hydrated).toBe(true)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(() => useExperimentalStore.getState().setNotesEnabled('account-a', true)).toThrow()
    expect(useExperimentalStore.getState().notesAccounts).toEqual([])
  })
})
