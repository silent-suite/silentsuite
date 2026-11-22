import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Only a collection admin may delete a collection: deleting it removes it for
// the owner and every member. Etebase access: 0 read-only, 1 admin, 2 read/write.

const coreMock = vi.hoisted(() => ({ deleteCollection: vi.fn() }))
const toastMock = vi.hoisted(() => ({ showErrorToast: vi.fn() }))

vi.mock('@silentsuite/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@silentsuite/core')>(),
  ...coreMock,
}))
vi.mock('@/app/stores/use-toast-store', () => toastMock)

import { useEtebaseStore } from '../use-etebase-store'

function collection(uid: string, accessLevel: number | undefined) {
  return { uid, accessLevel, getMeta: () => ({ name: uid }) }
}

function install(target: ReturnType<typeof collection>) {
  useEtebaseStore.setState({
    account: {},
    collections: { calendar: [target, collection('cal-own', 1)], tasks: [], contacts: [], notes: [] },
    domainLoadState: { calendar: 'loaded', tasks: 'loaded', contacts: 'loaded', notes: 'loaded' },
  } as any)
}

describe('deleteCollection access', () => {
  beforeEach(() => {
    coreMock.deleteCollection.mockReset().mockResolvedValue(undefined)
    toastMock.showErrorToast.mockReset()
  })

  it.each([
    ['read/write', 2],
    ['read-only', 0],
    ['unknown', undefined],
  ])('refuses to delete a %s shared collection and sends nothing', async (_label, level) => {
    install(collection('cal-shared', level))

    const deleted = await useEtebaseStore.getState().deleteCollection('calendar', 'cal-shared')

    expect(deleted).toBe(false)
    expect(coreMock.deleteCollection).not.toHaveBeenCalled()
    expect(toastMock.showErrorToast).toHaveBeenCalledWith('Only an admin of this shared calendar can delete it.')
    expect(useEtebaseStore.getState().collections.calendar.map((c: any) => c.uid)).toContain('cal-shared')
  })

  it('deletes a collection the user administers', async () => {
    install(collection('cal-admin', 1))

    const deleted = await useEtebaseStore.getState().deleteCollection('calendar', 'cal-admin')

    expect(deleted).toBe(true)
    expect(coreMock.deleteCollection).toHaveBeenCalledTimes(1)
  })
})
