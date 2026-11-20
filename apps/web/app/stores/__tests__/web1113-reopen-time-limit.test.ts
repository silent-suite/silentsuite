// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

const opened = vi.hoisted(() => ({ calls: 0 }))
vi.mock('@/app/stores/use-toast-store', () => ({ showErrorToast: vi.fn() }))
vi.mock('@/app/stores/use-label-suggestions-store', () => ({
  useLabelSuggestionsStore: { getState: () => ({ recordUsage: vi.fn() }) },
}))
// A queue that never answers, as a blocked database does.
vi.mock('@/app/stores/use-etebase-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/stores/use-etebase-store')>()),
  openHeldNoteRecords: () => {
    opened.calls += 1
    return new Promise(() => {})
  },
}))

import { reopenHeldNoteText, resetNoteLifecycle, useNoteStore } from '../use-note-store'

describe('#1113 D1 reopening held note text', () => {
  afterEach(() => {
    vi.useRealTimers()
    resetNoteLifecycle()
  })

  it('opens notes after a time limit when the queue never answers, and does not try again in this page', async () => {
    vi.useFakeTimers()
    const reopening = reopenHeldNoteText()
    expect(useNoteStore.getState().heldTextReopen).toBe('running')

    await vi.advanceTimersByTimeAsync(5000)
    await reopening

    expect(useNoteStore.getState().heldTextReopen).toBe('idle')
    await reopenHeldNoteText()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(useNoteStore.getState().heldTextReopen).toBe('idle')
    expect(opened.calls).toBe(1)
  })
})
