import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createEtebaseBirthdayTransport: vi.fn(() => ({})),
  runBirthdayCalendar: vi.fn(async () => ({ status: 'done', sourceTokens: null })),
  enableBirthdayCalendar: vi.fn(async () => ({ status: 'done', sourceTokens: null })),
  disableBirthdayCalendar: vi.fn(async () => ({ status: 'done', sourceTokens: null })),
}))
vi.mock('../orchestrate', () => ({ runBirthdayCalendar: mocks.runBirthdayCalendar }))
vi.mock('../lifecycle', () => ({
  enableBirthdayCalendar: mocks.enableBirthdayCalendar,
  disableBirthdayCalendar: mocks.disableBirthdayCalendar,
}))

/**
 * Fresh modules for a signed-in, opted-in account, with the transport module held
 * unloaded until release(), so the account can change while a run waits for it.
 */
async function sessionWithHeldTransport() {
  vi.resetModules()
  let release = () => {}
  const loaded = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.doMock('../etebase-transport', async () => {
    await loaded
    return { createEtebaseBirthdayTransport: mocks.createEtebaseBirthdayTransport }
  })
  const session = await import('../session')
  const { bumpAccountEpoch } = await import('@/app/lib/account-epoch')
  const { useAuthStore } = await import('@/app/stores/use-auth-store')
  const { useEtebaseStore } = await import('@/app/stores/use-etebase-store')
  const { useExperimentalStore } = await import('@/app/stores/use-experimental-store')
  const { useSyncStore } = await import('@/app/stores/use-sync-store')
  useEtebaseStore.setState({ account: { user: { username: 'me' } }, accountFingerprint: 'fp-1' } as never)
  useAuthStore.setState({ canWrite: () => true } as never)
  useSyncStore.setState({ isOnline: true } as never)
  useExperimentalStore.setState({ hydrated: true, birthdayAccounts: ['fp-1'] })
  return { session, bumpAccountEpoch, release }
}

// Each case imports the session and its stores again.
const TIMEOUT_MS = 30_000

describe('Birthdays runs while the transport loads', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.useRealTimers())

  it('a passive run stops when the account changed during the load', async () => {
    const { session, bumpAccountEpoch, release } = await sessionWithHeldTransport()
    vi.useFakeTimers()

    session.scheduleBirthdayReconcile()
    await vi.advanceTimersByTimeAsync(5000)
    expect(mocks.createEtebaseBirthdayTransport).not.toHaveBeenCalled()

    bumpAccountEpoch()
    release()
    await vi.dynamicImportSettled()

    // The run got past the load; the check after it stopped the run.
    expect(mocks.createEtebaseBirthdayTransport).toHaveBeenCalledTimes(1)
    expect(mocks.runBirthdayCalendar).not.toHaveBeenCalled()
  }, TIMEOUT_MS)

  it.each([
    ['turning on', 'enableBirthdayCalendarFromSession', mocks.enableBirthdayCalendar],
    ['turning off', 'disableBirthdayCalendarFromSession', mocks.disableBirthdayCalendar],
  ] as const)('%s is skipped when the account changed during the load', async (_label, action, lifecycleCall) => {
    const { session, bumpAccountEpoch, release } = await sessionWithHeldTransport()

    const result = session[action]()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mocks.createEtebaseBirthdayTransport).not.toHaveBeenCalled()

    bumpAccountEpoch()
    release()

    await expect(result).resolves.toEqual({ status: 'skipped' })
    expect(mocks.createEtebaseBirthdayTransport).toHaveBeenCalledTimes(1)
    expect(lifecycleCall).not.toHaveBeenCalled()
  }, TIMEOUT_MS)
})
