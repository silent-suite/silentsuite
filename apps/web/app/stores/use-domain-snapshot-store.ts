import { create } from 'zustand'
import { getAccountEpoch } from '@/app/lib/account-epoch'

/** Domains whose server snapshot is written into a UI store that exports read. */
export type SnapshotDomain = 'calendar' | 'tasks' | 'contacts'

interface DomainSnapshotState {
  /** Account epoch in which each domain's loaded server snapshot last reached its UI store. */
  appliedEpoch: Partial<Record<SnapshotDomain, number>>
  markApplied: (domain: SnapshotDomain, accountEpoch: number) => void
}

/**
 * Records that a domain's loaded server snapshot has been written into its UI
 * store (tasks, contacts or calendar). `domainLoadState` turns 'loaded' when the
 * server read finishes, before the decrypted items reach those stores, so code
 * that serializes the store arrays needs both. Cache hydration never marks a
 * domain. Marks are tied to the account epoch, so an account switch voids them.
 */
export const useDomainSnapshotStore = create<DomainSnapshotState>((set) => ({
  appliedEpoch: {},
  markApplied: (domain, accountEpoch) =>
    set((state) => ({ appliedEpoch: { ...state.appliedEpoch, [domain]: accountEpoch } })),
}))

/** Whether the domain's loaded server snapshot reached its UI store for the current account. */
export function isSnapshotApplied(
  appliedEpoch: Partial<Record<SnapshotDomain, number>>,
  domain: SnapshotDomain,
): boolean {
  return appliedEpoch[domain] === getAccountEpoch()
}
