import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useDomainInitializing } from '../use-domain-initializing'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'

const DOMAINS = ['calendar', 'tasks', 'contacts', 'notes'] as const

function setDomain(domain: (typeof DOMAINS)[number], status: 'loaded' | 'failed') {
  useEtebaseStore.setState((state) => ({ domainLoadState: { ...state.domainLoadState, [domain]: status } }))
}

describe('useDomainInitializing (#747)', () => {
  beforeEach(() => {
    // Cold restore: no account yet, every domain unknown, initialization running.
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
  })

  describe.each(DOMAINS)('%s', (domain) => {
    it('is true during a cold restore before any account is restored', () => {
      expect(useEtebaseStore.getState().account).toBeNull()
      expect(renderHook(() => useDomainInitializing(domain)).result.current).toBe(true)
    })

    it.each(['loaded', 'failed'] as const)('ends when its own domain is %s, not when another domain is', (status) => {
      const { result } = renderHook(() => useDomainInitializing(domain))
      const other = DOMAINS.find((candidate) => candidate !== domain)!
      act(() => setDomain(other, status))
      expect(result.current).toBe(true)
      act(() => setDomain(domain, status))
      expect(result.current).toBe(false)
    })

    it('ends when initialization ends with the domain still unknown', () => {
      const { result } = renderHook(() => useDomainInitializing(domain))
      act(() => useEtebaseStore.setState({ isInitialized: true }))
      expect(result.current).toBe(false)
    })

    it('ends when the session restore is blocked', () => {
      const { result } = renderHook(() => useDomainInitializing(domain))
      act(() => useEtebaseStore.setState({ restoreBlocked: true }))
      expect(result.current).toBe(false)
    })
  })
})
