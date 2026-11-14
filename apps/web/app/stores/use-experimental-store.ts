import { create } from 'zustand'

const STORAGE_KEY = 'silentsuite-experimental-v1'
const BIRTHDAYS_STORAGE_KEY = 'silentsuite-experimental-birthdays-v1'
const PLANNING_STORAGE_KEY = 'silentsuite-experimental-planning-v1'
const PLANNING_DISPOSITION_STORAGE_KEY = 'silentsuite-experimental-planning-disposition-v1'

/** What the planning view does with a task once its calendar event is confirmed saved. */
export type PlanningDisposition = 'label' | 'complete' | 'delete'
const PLANNING_DISPOSITIONS: readonly PlanningDisposition[] = ['label', 'complete', 'delete']

interface ExperimentalState {
  hydrated: boolean
  /** Public-key fingerprints only: never email addresses, credentials or note content. */
  notesAccounts: string[]
  /** Public-key fingerprints only, kept under its own key so the Notes format is untouched. */
  birthdayAccounts: string[]
  /** Public-key fingerprints only. */
  planningAccounts: string[]
  /** Per account fingerprint; a missing entry means 'label'. */
  planningDispositions: Record<string, PlanningDisposition>
  hydrate: () => void
  setNotesEnabled: (accountFingerprint: string, enabled: boolean) => void
  setBirthdaysEnabled: (accountFingerprint: string, enabled: boolean) => void
  setPlanningEnabled: (accountFingerprint: string, enabled: boolean) => void
  setPlanningDisposition: (accountFingerprint: string, disposition: PlanningDisposition) => void
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

function readDispositions(): Record<string, PlanningDisposition> {
  const result: Record<string, PlanningDisposition> = {}
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(PLANNING_DISPOSITION_STORAGE_KEY) ?? 'null')
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      for (const [account, value] of Object.entries(stored)) {
        // Anything unrecognised falls back to the non-destructive default.
        if (account && PLANNING_DISPOSITIONS.includes(value as PlanningDisposition)) result[account] = value as PlanningDisposition
      }
    }
  } catch {
    // Unavailable or malformed storage keeps the default.
  }
  return result
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
  planningAccounts: [],
  planningDispositions: {},
  hydrate: () => {
    if (get().hydrated || typeof window === 'undefined') return
    set({
      hydrated: true,
      notesAccounts: readAccounts(STORAGE_KEY),
      birthdayAccounts: readAccounts(BIRTHDAYS_STORAGE_KEY),
      planningAccounts: readAccounts(PLANNING_STORAGE_KEY),
      planningDispositions: readDispositions(),
    })
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
  setPlanningEnabled: (accountFingerprint, enabled) => {
    if (!accountFingerprint || !get().hydrated) return
    const planningAccounts = updateAccounts(get().planningAccounts, accountFingerprint, enabled)
    localStorage.setItem(PLANNING_STORAGE_KEY, JSON.stringify(planningAccounts))
    set({ planningAccounts })
  },
  setPlanningDisposition: (accountFingerprint, disposition) => {
    if (!accountFingerprint || !get().hydrated || !PLANNING_DISPOSITIONS.includes(disposition)) return
    const planningDispositions = { ...get().planningDispositions, [accountFingerprint]: disposition }
    localStorage.setItem(PLANNING_DISPOSITION_STORAGE_KEY, JSON.stringify(planningDispositions))
    set({ planningDispositions })
  },
}))

export function planningDispositionFor(state: Pick<ExperimentalState, 'planningDispositions'>, accountFingerprint: string | null | undefined): PlanningDisposition {
  return (accountFingerprint && state.planningDispositions[accountFingerprint]) || 'label'
}

/** Synchronous check for non-React callers; reads storage first if needed. */
export function isBirthdaysEnabledFor(accountFingerprint: string | null | undefined): boolean {
  const store = useExperimentalStore.getState()
  store.hydrate()
  const { hydrated, birthdayAccounts } = useExperimentalStore.getState()
  return hydrated && !!accountFingerprint && birthdayAccounts.includes(accountFingerprint)
}
