// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

// A queue whose database never answers, as a blocked IndexedDB open does.
vi.mock('@/app/lib/offline-queue', () => ({ getAll: () => new Promise(() => {}) }))
vi.mock('@/app/stores/use-note-store', () => ({ countNoteTextOnlyInPage: () => 0 }))
vi.mock('@/app/stores/use-etebase-store', () => ({
  useEtebaseStore: { getState: () => ({ accountFingerprint: 'account-1113' }) },
}))

import { captureSignOutAccount, countLocalOnlyChanges } from '../local-only-changes'

describe('#1113 D1 the Log out count', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('counts as unknown, not as zero, when the queue does not answer', async () => {
    vi.useFakeTimers()
    const counting = countLocalOnlyChanges(captureSignOutAccount())
    await vi.advanceTimersByTimeAsync(5000)

    await expect(counting).resolves.toBeNull()
  })
})
