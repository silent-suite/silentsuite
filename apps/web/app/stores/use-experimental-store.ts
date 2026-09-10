import { create } from 'zustand'

const STORAGE_KEY = 'silentsuite-experimental-v1'

interface ExperimentalState {
  hydrated: boolean
  /** Public-key fingerprints only: never email addresses, credentials or note content. */
  notesAccounts: string[]
  hydrate: () => void
  setNotesEnabled: (accountFingerprint: string, enabled: boolean) => void
}

export const useExperimentalStore = create<ExperimentalState>((set, get) => ({
  hydrated: false,
  notesAccounts: [],
  hydrate: () => {
    if (get().hydrated || typeof window === 'undefined') return
    let notesAccounts: string[] = []
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
      if (Array.isArray(stored) && stored.every((value) => typeof value === 'string' && value.length > 0)) {
        notesAccounts = [...new Set(stored)]
      }
    } catch {
      // Unavailable or malformed storage must never opt someone in.
    }
    set({ hydrated: true, notesAccounts })
  },
  setNotesEnabled: (accountFingerprint, enabled) => {
    if (!accountFingerprint || !get().hydrated) return
    const accounts = new Set(get().notesAccounts)
    if (enabled) accounts.add(accountFingerprint)
    else accounts.delete(accountFingerprint)
    const notesAccounts = [...accounts]
    // Persist first: a storage failure is reported by Settings, not a false success.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notesAccounts))
    set({ notesAccounts })
  },
}))
