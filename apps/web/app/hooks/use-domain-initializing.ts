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
