'use client'

import { useEffect } from 'react'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { planningDispositionFor, useExperimentalStore, type PlanningDisposition } from '@/app/stores/use-experimental-store'

export function usePlanningEnabled(): boolean {
  const fingerprint = useEtebaseStore((state) => state.accountFingerprint)
  const enabled = useExperimentalStore((state) => (
    state.hydrated && !!fingerprint && state.planningAccounts.includes(fingerprint)
  ))
  useEffect(() => {
    useExperimentalStore.getState().hydrate()
  }, [])
  return enabled
}

export function usePlanningDisposition(): PlanningDisposition {
  const fingerprint = useEtebaseStore((state) => state.accountFingerprint)
  return useExperimentalStore((state) => planningDispositionFor(state, fingerprint))
}
