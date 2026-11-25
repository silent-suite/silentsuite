'use client'

import { useEffect } from 'react'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useExperimentalStore } from '@/app/stores/use-experimental-store'

export function useLoginEmailChangeEnabled(): boolean {
  const fingerprint = useEtebaseStore((state) => state.accountFingerprint)
  const enabled = useExperimentalStore((state) => (
    state.hydrated && !!fingerprint && state.loginEmailChangeAccounts.includes(fingerprint)
  ))
  useEffect(() => {
    useExperimentalStore.getState().hydrate()
  }, [])
  return enabled
}
