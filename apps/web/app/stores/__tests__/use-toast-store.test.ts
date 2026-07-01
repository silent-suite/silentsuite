import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginPassiveStartupToastCycle,
  endPassiveStartupToastCycle,
  showErrorToast,
  useToastStore,
} from '../use-toast-store'

beforeEach(() => {
  vi.stubGlobal('crypto', { randomUUID: vi.fn(() => `toast-${Math.random()}`) })
  endPassiveStartupToastCycle()
  useToastStore.setState({ toasts: [] })
})

describe('useToastStore passive startup coalescing', () => {
  it('coalesces duplicate passive startup errors per source and cycle', () => {
    beginPassiveStartupToastCycle()

    showErrorToast('Failed to save preferences. Please try again.', { source: 'preferences' })
    showErrorToast('Failed to save preferences. Please try again.', { source: 'preferences' })
    showErrorToast('Failed to save preferences. Please try again.', { source: 'labelIndex' })

    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
      'Failed to save preferences. Please try again.',
      'Failed to save preferences. Please try again.',
    ])
  })

  it('allows a later explicit action-scoped failure after the passive cycle ends', () => {
    beginPassiveStartupToastCycle()
    showErrorToast('Failed to save preferences. Please try again.', { source: 'preferences' })
    showErrorToast('Failed to save preferences. Please try again.', { source: 'preferences' })
    endPassiveStartupToastCycle()

    showErrorToast('Failed to save preferences. Please try again.', { source: 'preferences' })

    expect(useToastStore.getState().toasts).toHaveLength(2)
  })
})
