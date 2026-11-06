import { afterEach, describe, expect, it, vi } from 'vitest'
import { bumpAccountEpoch, getAccountEpoch } from '@/app/lib/account-epoch'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useSyncStore } from '@/app/stores/use-sync-store'
import { runBirthdayCalendar } from '../orchestrate'
import { scheduleBirthdayReconcile } from '../session'

vi.mock('../orchestrate', () => ({ runBirthdayCalendar: vi.fn(async () => ({ status: 'done', sourceTokens: { inventoryToken: 'inv', books: [] } })) }))

describe('birthday session facade', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
  })

  it('runs the post-checked engine after the debounce when the captured account is still current', async () => {
    vi.useFakeTimers()
    const account = { user: { username: 'me' } }
    useEtebaseStore.setState({ account, accountFingerprint: 'fp-1' } as any)
    useAuthStore.setState({ user: { isAdmin: true } } as any)
    useSyncStore.setState({ isOnline: true })

    scheduleBirthdayReconcile()
    await vi.advanceTimersByTimeAsync(5000)

    expect(runBirthdayCalendar).toHaveBeenCalledTimes(1)
  })

  it('does not run when the captured epoch changes during the debounce', async () => {
    vi.useFakeTimers()
    const account = { user: { username: 'me' } }
    useEtebaseStore.setState({ account, accountFingerprint: 'fp-1' } as any)
    useAuthStore.setState({ user: { isAdmin: true } } as any)
    useSyncStore.setState({ isOnline: true })
    const epoch = getAccountEpoch()

    scheduleBirthdayReconcile()
    bumpAccountEpoch()
    await vi.advanceTimersByTimeAsync(5000)

    expect(getAccountEpoch()).not.toBe(epoch)
    expect(runBirthdayCalendar).not.toHaveBeenCalled()
  })
})
