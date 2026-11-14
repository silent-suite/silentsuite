import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isBirthdaysEnabledFor, useExperimentalStore } from '../use-experimental-store'

const key = 'silentsuite-experimental-v1'
const birthdaysKey = 'silentsuite-experimental-birthdays-v1'

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  useExperimentalStore.setState({ hydrated: false, notesAccounts: [], birthdayAccounts: [] })
})

describe('experimental preferences', () => {
  it('defaults off, persists explicit choices, and restores after a reload', () => {
    useExperimentalStore.getState().hydrate()
    expect(useExperimentalStore.getState().notesAccounts).toEqual([])
    useExperimentalStore.getState().setNotesEnabled('account-a', true)
    useExperimentalStore.getState().setNotesEnabled('account-b', true)
    useExperimentalStore.getState().setNotesEnabled('account-a', false)
    useExperimentalStore.setState({ hydrated: false, notesAccounts: [], birthdayAccounts: [] })
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

  it('keeps the Birthdays choice per account under its own key, off by default', () => {
    expect(isBirthdaysEnabledFor('account-a')).toBe(false)
    useExperimentalStore.getState().setBirthdaysEnabled('account-a', true)
    useExperimentalStore.getState().setBirthdaysEnabled('account-b', true)
    useExperimentalStore.getState().setBirthdaysEnabled('account-b', false)
    expect(localStorage.getItem(key)).toBeNull()
    expect(JSON.parse(localStorage.getItem(birthdaysKey)!)).toEqual(['account-a'])
    useExperimentalStore.setState({ hydrated: false, notesAccounts: [], birthdayAccounts: [] })
    expect(isBirthdaysEnabledFor('account-a')).toBe(true)
    expect(isBirthdaysEnabledFor('account-b')).toBe(false)
    expect(isBirthdaysEnabledFor(null)).toBe(false)
    expect(useExperimentalStore.getState().notesAccounts).toEqual([])
  })

  it('does not change Notes when Birthdays is toggled, or Birthdays when Notes is', () => {
    localStorage.setItem(key, '["account-a"]')
    useExperimentalStore.getState().hydrate()
    useExperimentalStore.getState().setBirthdaysEnabled('account-b', true)
    useExperimentalStore.getState().setNotesEnabled('account-a', false)
    expect(localStorage.getItem(key)).toBe('[]')
    expect(localStorage.getItem(birthdaysKey)).toBe('["account-b"]')
  })

  it.each(['not-json', 'true', '{}', '[true]', '["account-a", null]', '[""]'])('fails closed for malformed Birthdays storage %s', (value) => {
    localStorage.setItem(birthdaysKey, value)
    localStorage.setItem(key, '["account-a"]')
    expect(isBirthdaysEnabledFor('account-a')).toBe(false)
    expect(useExperimentalStore.getState()).toMatchObject({ hydrated: true, notesAccounts: ['account-a'], birthdayAccounts: [] })
  })

  it('keeps Birthdays off when storage cannot be read, and does not claim a failed write succeeded', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(isBirthdaysEnabledFor('account-a')).toBe(false)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(() => useExperimentalStore.getState().setBirthdaysEnabled('account-a', true)).toThrow()
    expect(isBirthdaysEnabledFor('account-a')).toBe(false)
  })
})
