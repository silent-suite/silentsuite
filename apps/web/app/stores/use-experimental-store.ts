import { create } from 'zustand'

const STORAGE_KEY = 'silentsuite-experimental-v1'
const BIRTHDAYS_STORAGE_KEY = 'silentsuite-experimental-birthdays-v1'

interface ExperimentalState {
  hydrated: boolean
  /** Public-key fingerprints only: never email addresses, credentials or note content. */
  notesAccounts: string[]
  /** Public-key fingerprints only, kept under its own key so the Notes format is untouched. */
  birthdayAccounts: string[]
  hydrate: () => void
  setNotesEnabled: (accountFingerprint: string, enabled: boolean) => void
  setBirthdaysEnabled: (accountFingerprint: string, enabled: boolean) => void
}

function readAccounts(key: string): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (Array.isArray(stored) && stored.every((value) => typeof value === 'string' && value.length > 0)) {
      return [...new Set(stored)]
    }
  } catch {
    // Unavailable or malformed storage must never opt someone in.
  }
  return []
}

function updateAccounts(current: string[], accountFingerprint: string, enabled: boolean): string[] {
  const accounts = new Set(current)
  if (enabled) accounts.add(accountFingerprint)
  else accounts.delete(accountFingerprint)
  return [...accounts]
}

export const useExperimentalStore = create<ExperimentalState>((set, get) => ({
  hydrated: false,
  notesAccounts: [],
  birthdayAccounts: [],
  hydrate: () => {
    if (get().hydrated || typeof window === 'undefined') return
    set({ hydrated: true, notesAccounts: readAccounts(STORAGE_KEY), birthdayAccounts: readAccounts(BIRTHDAYS_STORAGE_KEY) })
  },
  setNotesEnabled: (accountFingerprint, enabled) => {
    if (!accountFingerprint || !get().hydrated) return
    const notesAccounts = updateAccounts(get().notesAccounts, accountFingerprint, enabled)
    // Persist first: a storage failure is reported by Settings, not a false success.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notesAccounts))
    set({ notesAccounts })
  },
  setBirthdaysEnabled: (accountFingerprint, enabled) => {
    if (!accountFingerprint || !get().hydrated) return
    const birthdayAccounts = updateAccounts(get().birthdayAccounts, accountFingerprint, enabled)
    localStorage.setItem(BIRTHDAYS_STORAGE_KEY, JSON.stringify(birthdayAccounts))
    set({ birthdayAccounts })
  },
}))

/** Synchronous check for non-React callers; reads storage first if needed. */
export function isBirthdaysEnabledFor(accountFingerprint: string | null | undefined): boolean {
  const store = useExperimentalStore.getState()
  store.hydrate()
  const { hydrated, birthdayAccounts } = useExperimentalStore.getState()
  return hydrated && !!accountFingerprint && birthdayAccounts.includes(accountFingerprint)
}
