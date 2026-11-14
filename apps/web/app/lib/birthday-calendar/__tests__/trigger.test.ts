import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = vi.hoisted(() => ({ loads: 0, scheduleBirthdayReconcile: vi.fn() }))
vi.mock('@/app/lib/birthday-calendar/session', () => {
  session.loads += 1
  return { scheduleBirthdayReconcile: session.scheduleBirthdayReconcile }
})

import { getAccountEpoch } from '@/app/lib/account-epoch'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useExperimentalStore } from '@/app/stores/use-experimental-store'
import { requestBirthdayReconcile } from '../trigger'

const settled = async () => {
  await vi.dynamicImportSettled()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  localStorage.clear()
  session.scheduleBirthdayReconcile.mockReset()
  useEtebaseStore.setState({ accountFingerprint: 'fp-a' })
  useExperimentalStore.setState({ hydrated: false, notesAccounts: [], birthdayAccounts: [] })
})

describe('requestBirthdayReconcile experiment gate', () => {
  it('does nothing and loads no Birthdays session code while the experiment is off', async () => {
    requestBirthdayReconcile(getAccountEpoch())
    localStorage.setItem('silentsuite-experimental-birthdays-v1', '["fp-b"]')
    useExperimentalStore.setState({ hydrated: false })
    requestBirthdayReconcile(getAccountEpoch())
    await settled()
    expect(session.loads).toBe(0)
    expect(session.scheduleBirthdayReconcile).not.toHaveBeenCalled()
  })

  it('reads the stored choice for the current account and schedules a run when on', async () => {
    localStorage.setItem('silentsuite-experimental-birthdays-v1', '["fp-a"]')
    requestBirthdayReconcile(getAccountEpoch())
    await settled()
    expect(session.scheduleBirthdayReconcile).toHaveBeenCalledTimes(1)
  })
})
