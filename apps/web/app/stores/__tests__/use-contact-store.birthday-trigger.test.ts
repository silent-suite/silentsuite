// @vitest-environment node
// #738: the real contact-store callers that request Birthdays generation.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Contact } from '@silentsuite/core'

const onLineDescriptor = vi.hoisted(() => {
  const original = Object.getOwnPropertyDescriptor(globalThis.navigator, 'onLine')
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, get: () => true })
  return original
})
afterAll(() => {
  if (onLineDescriptor) Object.defineProperty(globalThis.navigator, 'onLine', onLineDescriptor)
  else delete (globalThis.navigator as any).onLine
})

const birthdayMock = vi.hoisted(() => ({ scheduleBirthdayReconcile: vi.fn(), resetBirthdayProjection: vi.fn() }))
const toastMock = vi.hoisted(() => ({ showErrorToast: vi.fn() }))
vi.mock('@/app/lib/birthday-calendar/session', () => birthdayMock)
vi.mock('@/app/stores/use-toast-store', () => toastMock)
vi.mock('@/app/stores/use-sync-store', () => ({
  useSyncStore: { getState: () => ({ isOnline: true, simulateSyncCycle: vi.fn() }) },
}))

import { useContactStore, resetContactLifecycle } from '../use-contact-store'
import { useEtebaseStore } from '../use-etebase-store'
import { useContactListStore } from '../use-contact-list-store'
import { useAuthStore } from '../use-auth-store'
import { TEST_FINGERPRINT } from './offline-queue-store-test-utils'

function contact(id: string): Contact & { revision: string } {
  return { id, uid: id, displayName: 'Alex', name: { prefix: '', given: 'Alex', family: '', suffix: '' }, phones: [], emails: [], addresses: [], organization: '', title: '', notes: '', birthday: '1985-03-15', photoUrl: null, categories: [], listId: 'contacts-1', created_at: new Date(), updated_at: new Date(), revision: 'rev-1' }
}

function account(updateOutcome: 'remote' | 'queued' | 'reject', createdUid: string | null = 'remote-1') {
  const createItem = vi.fn(async (_type: string, _content: string, _tempId?: string, _collectionUid?: string, _meta?: unknown, onCommitted?: (item: any) => void) => {
    if (createdUid) onCommitted?.({ etag: 'rev-new', encryptedItem: { lastEtag: 'rev-new' } })
    return createdUid
  })
  const updateItem = vi.fn(async (_type: string, _id: string, _content: string, options?: { onSaved?: (etag: string) => void }) => {
    if (updateOutcome === 'reject') throw new Error('private')
    if (updateOutcome === 'remote') options?.onSaved?.('etag-2')
    return updateOutcome
  })
  const deleteItem = vi.fn(async () => 'remote')
  useEtebaseStore.setState({ account: {}, accountFingerprint: TEST_FINGERPRINT, itemCache: new Map([['c1', {}]]), createItem, updateItem, deleteItem } as any)
}

const settled = async () => {
  await vi.dynamicImportSettled()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('contact store requests Birthdays generation only after server-confirmed changes (#738)', () => {
  beforeEach(() => {
    resetContactLifecycle()
    useContactStore.setState({ contacts: [contact('c1')], syncStatus: 'synced', searchQuery: '', contactSaveStates: {} })
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    useContactListStore.setState({ lists: [{ id: 'contacts-1', name: 'Contacts', color: '#fff', visible: true, accessLevel: 2 }], activeListId: 'contacts-1' })
    useAuthStore.setState({ canWrite: () => true } as any)
    birthdayMock.scheduleBirthdayReconcile.mockReset()
    toastMock.showErrorToast.mockReset()
  })

  it('a server-confirmed update requests a run', async () => {
    account('remote')
    await expect(useContactStore.getState().updateContact('c1', { birthday: '1985-03-16' })).resolves.toBe(true)
    await settled()
    expect(birthdayMock.scheduleBirthdayReconcile).toHaveBeenCalledTimes(1)
  })

  it('a queued update is not remote confirmation', async () => {
    account('queued')
    await useContactStore.getState().updateContact('c1', { birthday: '1985-03-16' })
    await settled()
    expect(birthdayMock.scheduleBirthdayReconcile).not.toHaveBeenCalled()
  })

  it('a failed update requests nothing', async () => {
    account('reject')
    await expect(useContactStore.getState().updateContact('c1', { birthday: '1985-03-16' })).resolves.toBe(false)
    await settled()
    expect(birthdayMock.scheduleBirthdayReconcile).not.toHaveBeenCalled()
  })

  it('a Birthdays failure does not change a successful save', async () => {
    account('remote')
    birthdayMock.scheduleBirthdayReconcile.mockImplementation(() => { throw new Error('birthday chunk failed') })
    await expect(useContactStore.getState().updateContact('c1', { birthday: '1985-03-16' })).resolves.toBe(true)
    await settled()
    expect(birthdayMock.scheduleBirthdayReconcile).toHaveBeenCalledTimes(1)
    expect(useContactStore.getState().contacts.find((entry) => entry.id === 'c1')?.birthday).toBe('1985-03-16')
    expect(toastMock.showErrorToast).not.toHaveBeenCalled()
  })

  it('a committed create requests a run; an uncommitted one does not', async () => {
    account('remote', 'remote-1')
    await useContactStore.getState().createContact({ displayName: 'Lee', birthday: '--02-29' })
    await settled()
    expect(birthdayMock.scheduleBirthdayReconcile).toHaveBeenCalledTimes(1)

    birthdayMock.scheduleBirthdayReconcile.mockReset()
    account('remote', null)
    await useContactStore.getState().createContact({ displayName: 'Robin', birthday: '--12-31' })
    await settled()
    expect(birthdayMock.scheduleBirthdayReconcile).not.toHaveBeenCalled()
  })

  it('an accepted delete requests a run', async () => {
    account('remote')
    await expect(useContactStore.getState().deleteContact('c1')).resolves.toBe(true)
    await settled()
    expect(birthdayMock.scheduleBirthdayReconcile).toHaveBeenCalledTimes(1)
  })
})
