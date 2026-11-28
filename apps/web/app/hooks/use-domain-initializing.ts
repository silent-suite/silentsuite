'use client'

import { useEtebaseStore, type InitialVisibleDomainKey } from '@/app/stores/use-etebase-store'

/**
 * True while a list domain is still unknown and Etebase initialization is
 * running. Initialization ends with `isInitialized` (every domain terminal, or
 * a failed init that leaves domains unknown) or with `restoreBlocked`. Not
 * gated on `account`: it is set only once the session is restored, so the
 * restore itself counts as initializing. List pages skip their skeleton once
 * items are painted, since cached items arrive while the domain is unknown.
 */
export function useDomainInitializing(domain: InitialVisibleDomainKey): boolean {
  return useEtebaseStore((state) => (
    state.domainLoadState[domain] === 'unknown' && !state.isInitialized && !state.restoreBlocked
  ))
}

/**
 * True while the task lists are still the local "My Tasks" placeholder and the
 * tasks domain is initializing. Remote lists are published before task items
 * load, so this ends as soon as real list names (and access levels) arrive, or
 * when initialization ends without them. Callers show a neutral loading state
 * instead of the placeholder name or a read-only hint that is not yet known.
 */
export function useTaskListsLoading(lists: ReadonlyArray<{ id: string }>): boolean {
  const initializing = useDomainInitializing('tasks')
  return initializing && lists.every((list) => list.id === 'default')
}
