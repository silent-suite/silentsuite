import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { secureClear, secureGet, secureRemoveIfEqual, secureSet } from '../secure-storage'

describe('secureRemoveIfEqual', () => {
  beforeEach(async () => {
    await secureClear()
  })

  it('removes the key while it still holds the expected value', async () => {
    await secureSet('etebase_session', 'cancelled-session')
    await secureRemoveIfEqual('etebase_session', 'cancelled-session')
    expect(await secureGet('etebase_session')).toBeNull()
  })

  it('keeps a different value', async () => {
    await secureSet('etebase_session', 'newer-session')
    await secureRemoveIfEqual('etebase_session', 'cancelled-session')
    expect(await secureGet('etebase_session')).toBe('newer-session')
  })

  it('cannot remove a newer write issued after it, as a separate read then delete could', async () => {
    await secureSet('etebase_session', 'cancelled-session')
    const removal = secureRemoveIfEqual('etebase_session', 'cancelled-session')
    const newerWrite = secureSet('etebase_session', 'newer-session')
    await Promise.all([removal, newerWrite])
    expect(await secureGet('etebase_session')).toBe('newer-session')
  })

  it('keeps a newer write queued before it behind a pending cancelled write', async () => {
    const cancelledWrite = secureSet('etebase_session', 'cancelled-session')
    const newerWrite = secureSet('etebase_session', 'newer-session')
    await Promise.all([cancelledWrite, newerWrite])
    await secureRemoveIfEqual('etebase_session', 'cancelled-session')
    expect(await secureGet('etebase_session')).toBe('newer-session')
  })
})
