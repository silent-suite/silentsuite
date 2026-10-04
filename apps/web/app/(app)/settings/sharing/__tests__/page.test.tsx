import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
// Real core and the SDK it bundles; only the SDK account boundary below is faked.
import * as Etebase from '../../../../../../../packages/core/node_modules/etebase'
import { getPublicKeyFingerprint } from '@silentsuite/core'
import { renderWithIntl } from '@/src/__tests__/render-with-intl'
import { bumpAccountEpoch } from '@/app/lib/account-epoch'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import SharingSettingsPage from '../page'

const toastStoreMock = vi.hoisted(() => ({ showErrorToast: vi.fn() }))

vi.mock('@/app/stores/use-toast-store', () => toastStoreMock)
vi.mock('@/app/lib/offline-queue', () => ({
  enqueue: vi.fn(async () => {}),
  getAll: vi.fn(async () => []),
  remove: vi.fn(async () => {}),
  removeItemMutations: vi.fn(async () => 0),
  isOfflineError: vi.fn(() => false),
}))
vi.mock('@/app/lib/secure-storage', () => ({
  secureGet: vi.fn(async () => null),
  secureSet: vi.fn(async () => {}),
  secureRemove: vi.fn(async () => {}),
  secureClear: vi.fn(async () => {}),
  migrateFromLocalStorage: vi.fn(async () => {}),
}))
vi.mock('@/app/stores/use-label-suggestions-store', () => ({
  useLabelSuggestionsStore: { getState: () => ({ recordUsage: vi.fn(async () => {}) }) },
}))

type SharingType = 'calendar' | 'tasks' | 'contacts' | 'notes'

function sharingKey(seed: number) {
  return new Uint8Array(32).map((_, index) => (seed + index) & 0xff)
}

function bytes(value: unknown) {
  return Array.from(value as Uint8Array)
}

/** Real fingerprint text as Testing Library normalizes it. */
function displayedFingerprint(key: Uint8Array) {
  return getPublicKeyFingerprint(key).replace(/\s+/g, ' ').trim()
}

function page<T>(data: T[]) {
  return { data, done: true, iterator: null }
}

function incomingInvitation(overrides: Record<string, unknown> = {}) {
  return {
    uid: 'invite-1',
    version: 1,
    username: 'me@example.com',
    collection: 'remote-col',
    accessLevel: 2,
    signedEncryptionKey: new Uint8Array([5, 6, 7, 8]),
    fromUsername: 'friend@example.com',
    fromPubkey: sharingKey(70),
    ...overrides,
  }
}

/** Fake Etebase SDK account: every method the real core sharing wrappers call is a spy. */
function createSdkAccount(id: string, incoming: unknown[] = []) {
  const invitationManager = {
    fetchUserProfile: vi.fn(),
    invite: vi.fn(async () => undefined),
    listIncoming: vi.fn(async () => page(incoming)),
    listOutgoing: vi.fn(async () => page([])),
    accept: vi.fn(async () => undefined),
    reject: vi.fn(async () => undefined),
    disinvite: vi.fn(async () => undefined),
  }
  const memberManager = {
    list: vi.fn(async () => page([])),
    remove: vi.fn(async () => undefined),
    leave: vi.fn(async () => undefined),
    modifyAccessLevel: vi.fn(async () => undefined),
  }
  const account = {
    id,
    getInvitationManager: () => invitationManager,
    getCollectionManager: () => ({ getMemberManager: () => memberManager }),
  }
  return { account, invitationManager }
}

function adminCollection(type: SharingType) {
  return { uid: `${type}-1`, accessLevel: 1, getMeta: () => ({ name: `Shared ${type}` }) }
}

function emptyCollections() {
  return { calendar: [], tasks: [], contacts: [], notes: [], preferences: [] } as Record<string, unknown[]>
}

function setupPage(type: SharingType = 'calendar', incoming: unknown[] = []) {
  const sdk = createSdkAccount('account-1', incoming)
  const collection = adminCollection(type)
  const collections = emptyCollections()
  collections[type] = [collection]
  useEtebaseStore.setState({
    account: sdk.account as any,
    collections: collections as any,
    accountFingerprint: 'account-1-fp',
    reconcileCollections: vi.fn(async () => {}),
  })
  renderWithIntl(<SharingSettingsPage />)
  return { ...sdk, collection }
}

function switchAccount() {
  const next = createSdkAccount('account-2')
  act(() => {
    bumpAccountEpoch()
    useEtebaseStore.setState({ account: next.account as any, accountFingerprint: 'account-2-fp' })
  })
  return next
}

function startInvite(username = 'friend@example.com', access = 'readWrite') {
  fireEvent.change(screen.getByPlaceholderText('friend@example.com'), { target: { value: username } })
  fireEvent.change(screen.getByRole('combobox'), { target: { value: access } })
  const inviteButton = screen.getByRole('button', { name: 'Invite' })
  inviteButton.focus()
  fireEvent.click(inviteButton)
  return inviteButton
}

function inviteDialog() {
  return screen.findByRole('dialog', { name: 'Verify security fingerprint' })
}

beforeAll(async () => {
  await Etebase.ready
})

beforeEach(() => {
  toastStoreMock.showErrorToast.mockReset()
})

describe('SharingSettingsPage invite fingerprint confirmation', () => {
  it.each(['calendar', 'tasks', 'contacts', 'notes'] as const)('shows the fetched %s recipient fingerprint and sends only after confirmation', async (type) => {
    const key = sharingKey(11)
    const { account, invitationManager, collection } = setupPage(type)
    invitationManager.fetchUserProfile.mockResolvedValueOnce({ pubkey: key })

    startInvite()
    const dialog = await inviteDialog()

    expect(within(dialog).getByText(displayedFingerprint(key))).toBeInTheDocument()
    expect(within(dialog).getByText(/Settings → Security → Account fingerprint/)).toBeInTheDocument()
    expect(within(dialog).getByText(/username is supplied by the server and is not verified/i)).toBeInTheDocument()
    expect(invitationManager.fetchUserProfile).toHaveBeenCalledWith('friend@example.com')
    expect(invitationManager.invite).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))

    fireEvent.click(within(dialog).getByRole('button', { name: 'Fingerprint matches, send invitation' }))

    await screen.findByText('Invitation sent to friend@example.com.')
    expect(invitationManager.fetchUserProfile).toHaveBeenCalledTimes(1)
    expect(invitationManager.invite).toHaveBeenCalledTimes(1)
    const [calledCollection, calledUsername, calledKey, calledAccess] = invitationManager.invite.mock.calls[0] as unknown[]
    expect(useEtebaseStore.getState().account).toBe(account)
    expect(calledCollection).toBe(collection)
    expect(calledUsername).toBe('friend@example.com')
    expect(calledKey).not.toBe(key)
    expect(bytes(calledKey)).toEqual(bytes(key))
    expect(displayedFingerprint(calledKey as Uint8Array)).toBe(within(dialog).getByText(displayedFingerprint(key)).textContent?.replace(/\s+/g, ' ').trim())
    expect(calledAccess).toBe(Etebase.CollectionAccessLevel.ReadWrite)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('focuses Cancel in the same commit that shows the dialog, even when React yields before passive effects', async () => {
    const { invitationManager } = setupPage()
    invitationManager.fetchUserProfile.mockResolvedValueOnce({ pubkey: sharingKey(17) })
    let focusedWhenShown: Element | null | undefined
    const observer = new MutationObserver(() => {
      if (focusedWhenShown === undefined && screen.queryByRole('dialog')) focusedWhenShown = document.activeElement
    })
    observer.observe(document.body, { childList: true, subtree: true })
    // Every clock read overruns React's 5ms scheduler slice, as on a loaded runner, so work after the commit is deferred to a later task.
    let clock = performance.now()
    const now = vi.spyOn(performance, 'now').mockImplementation(() => (clock += 10))

    try {
      startInvite()
      const dialog = await inviteDialog()

      expect(focusedWhenShown).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))
      expect(invitationManager.invite).not.toHaveBeenCalled()
    } finally {
      now.mockRestore()
      observer.disconnect()
    }
  })

  it.each([
    ['Cancel', (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))],
    ['Escape', (dialog: HTMLElement) => fireEvent.keyDown(dialog, { key: 'Escape' })],
    ['backdrop', () => fireEvent.mouseDown(screen.getByTestId('sharing-dialog-backdrop'))],
  ])('sends nothing when the dialog is dismissed with %s and restores focus', async (_label, dismiss) => {
    const { invitationManager } = setupPage()
    invitationManager.fetchUserProfile.mockResolvedValueOnce({ pubkey: sharingKey(12) })
    const inviteButton = startInvite()
    const dialog = await inviteDialog()

    dismiss(dialog)

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(inviteButton)
    expect(invitationManager.invite).not.toHaveBeenCalled()
    expect(screen.queryByText(/Invitation sent/)).toBeNull()
  })

  it('sends one invitation when confirm is double-clicked', async () => {
    let release!: () => void
    const { invitationManager } = setupPage()
    invitationManager.fetchUserProfile.mockResolvedValueOnce({ pubkey: sharingKey(13) })
    invitationManager.invite.mockImplementationOnce(() => new Promise<undefined>((resolve) => { release = () => resolve(undefined) }))
    startInvite()
    const dialog = await inviteDialog()
    const confirm = within(dialog).getByRole('button', { name: 'Fingerprint matches, send invitation' })

    fireEvent.click(confirm)
    fireEvent.click(confirm)
    await waitFor(() => expect(invitationManager.invite).toHaveBeenCalledTimes(1))
    await act(async () => { release() })

    await screen.findByText('Invitation sent to friend@example.com.')
    expect(invitationManager.invite).toHaveBeenCalledTimes(1)
    expect(bytes(invitationManager.invite.mock.calls[0][2])).toEqual(bytes(sharingKey(13)))
  })

  it('closes the pending invite without sending when the username, access, collection, or account changes', async () => {
    const { invitationManager } = setupPage()
    invitationManager.fetchUserProfile.mockResolvedValue({ pubkey: sharingKey(14) })

    startInvite()
    await inviteDialog()
    fireEvent.change(screen.getByPlaceholderText('friend@example.com'), { target: { value: 'other@example.com' } })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    startInvite()
    await inviteDialog()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'admin' } })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    startInvite()
    await inviteDialog()
    act(() => {
      useEtebaseStore.setState({ collections: emptyCollections() as any })
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    const replacement = adminCollection('calendar')
    act(() => {
      useEtebaseStore.setState({ collections: { ...emptyCollections(), calendar: [replacement] } as any })
    })
    startInvite()
    await inviteDialog()
    const next = switchAccount()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    expect(invitationManager.fetchUserProfile).toHaveBeenCalledTimes(4)
    expect(invitationManager.invite).not.toHaveBeenCalled()
    expect(next.invitationManager.invite).not.toHaveBeenCalled()
    expect(screen.queryByText(/Invitation sent/)).toBeNull()
  })

  it('shows no dialog when the account switches before the profile fetch resolves', async () => {
    let release!: (value: unknown) => void
    const { invitationManager } = setupPage()
    invitationManager.fetchUserProfile.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    startInvite()
    await waitFor(() => expect(invitationManager.fetchUserProfile).toHaveBeenCalledTimes(1))

    const next = switchAccount()
    await act(async () => { release({ pubkey: sharingKey(15) }) })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(invitationManager.invite).not.toHaveBeenCalled()
    expect(next.invitationManager.invite).not.toHaveBeenCalled()
    expect(toastStoreMock.showErrorToast).not.toHaveBeenCalled()
  })

  it('re-fetches the key on retry after a failed lookup', async () => {
    const { invitationManager } = setupPage()
    invitationManager.fetchUserProfile
      .mockRejectedValueOnce(new Error('lookup failed'))
      .mockResolvedValueOnce({ pubkey: sharingKey(16) })

    startInvite()
    await waitFor(() => expect(toastStoreMock.showErrorToast).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
    const dialog = await inviteDialog()
    expect(within(dialog).getByText(displayedFingerprint(sharingKey(16)))).toBeInTheDocument()
    expect(invitationManager.fetchUserProfile).toHaveBeenCalledTimes(2)
    expect(invitationManager.invite).not.toHaveBeenCalled()
  })
})

/**
 * Starts an invite and changes a form field in the microtask right after the dialog commit,
 * before React's deferred effects task. Returns the field value read straight after the change.
 */
async function changeFieldAsDialogCommits(field: () => HTMLInputElement | HTMLSelectElement, value: string) {
  // Every scheduler slice looks overrun, so the dialog commit yields before its passive effects run.
  let clock = performance.now()
  const now = vi.spyOn(performance, 'now').mockImplementation(() => (clock += 10))
  let observer: MutationObserver | undefined
  try {
    const changed = new Promise<string>((resolve) => {
      observer = new MutationObserver(() => {
        if (!document.querySelector('[role="dialog"]')) return
        observer?.disconnect()
        const target = field()
        fireEvent.change(target, { target: { value } })
        resolve(target.value)
      })
      observer.observe(document.body, { childList: true, subtree: true })
    })
    startInvite()
    return await changed
  } finally {
    observer?.disconnect()
    now.mockRestore()
  }
}

describe('SharingSettingsPage invite form input as the dialog commits', () => {
  it.each([
    ['access selection', () => screen.getByRole('combobox') as HTMLSelectElement, 'admin'],
    ['username', () => screen.getByPlaceholderText('friend@example.com') as HTMLInputElement, 'other@example.com'],
  ] as const)('keeps the %s chosen as the dialog commits and closes the pending invite', async (_label, field, value) => {
    const { invitationManager } = setupPage()
    invitationManager.fetchUserProfile.mockResolvedValueOnce({ pubkey: sharingKey(17) })

    expect(await changeFieldAsDialogCommits(field, value)).toBe(value)

    expect(field()).toHaveValue(value)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(field()).toHaveValue(value)
    expect(invitationManager.fetchUserProfile).toHaveBeenCalledTimes(1)
    expect(invitationManager.invite).not.toHaveBeenCalled()
    expect(screen.queryByText(/Invitation sent/)).toBeNull()
  })
})

describe('SharingSettingsPage incoming invitation confirmation', () => {
  it('never shows the recipient username as the sender', async () => {
    setupPage('calendar', [incomingInvitation({ fromUsername: undefined })])

    expect(await screen.findByText('From Unknown sender')).toBeInTheDocument()
    expect(screen.queryByText(/me@example\.com/)).toBeNull()
  })

  it('requires confirmation and accepts the snapshot that was displayed even after a refresh', async () => {
    const original = incomingInvitation()
    const { invitationManager } = setupPage('calendar', [original])
    expect(await screen.findByText('From friend@example.com')).toBeInTheDocument()
    expect(screen.getByText(displayedFingerprint(sharingKey(70)))).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    const dialog = await screen.findByRole('dialog', { name: 'Verify sender fingerprint' })
    expect(within(dialog).getByText(displayedFingerprint(sharingKey(70)))).toBeInTheDocument()
    expect(within(dialog).getByText(/name is supplied by the server and is not verified/i)).toBeInTheDocument()
    expect(invitationManager.accept).not.toHaveBeenCalled()

    // Mutating the listed object and refreshing to a different key must not change what is accepted.
    original.fromPubkey.fill(0)
    original.signedEncryptionKey.fill(0)
    invitationManager.listIncoming.mockResolvedValue(page([
      incomingInvitation({ fromPubkey: sharingKey(200), signedEncryptionKey: new Uint8Array([1]) }),
    ]))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(invitationManager.listIncoming).toHaveBeenCalledTimes(2))
    await screen.findByText(displayedFingerprint(sharingKey(200)))

    const stillOpen = screen.getByRole('dialog', { name: 'Verify sender fingerprint' })
    expect(within(stillOpen).getByText(displayedFingerprint(sharingKey(70)))).toBeInTheDocument()
    const confirm = within(stillOpen).getByRole('button', { name: 'Fingerprint matches, accept' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)

    await screen.findByText('Invitation accepted. Shared collections are refreshing now.')
    expect(invitationManager.accept).toHaveBeenCalledTimes(1)
    const [snapshot] = invitationManager.accept.mock.calls[0] as any[]
    expect(snapshot).not.toBe(original)
    expect(snapshot.uid).toBe('invite-1')
    expect(bytes(snapshot.fromPubkey)).toEqual(bytes(sharingKey(70)))
    expect(bytes(snapshot.signedEncryptionKey)).toEqual([5, 6, 7, 8])
  })

  it('cancelling the accept dialog accepts nothing', async () => {
    const { invitationManager } = setupPage('calendar', [incomingInvitation()])
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    const dialog = await screen.findByRole('dialog', { name: 'Verify sender fingerprint' })
    fireEvent.keyDown(dialog, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(invitationManager.accept).not.toHaveBeenCalled()
  })

  it('closes the accept dialog without accepting when the account switches', async () => {
    const { invitationManager } = setupPage('calendar', [incomingInvitation()])
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    await screen.findByRole('dialog', { name: 'Verify sender fingerprint' })

    const next = switchAccount()

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(invitationManager.accept).not.toHaveBeenCalled()
    expect(next.invitationManager.accept).not.toHaveBeenCalled()
  })

  it('disables accept for a malformed sender key but still allows reject', async () => {
    const { invitationManager } = setupPage('calendar', [incomingInvitation({ fromPubkey: new Uint8Array(3) })])

    expect(await screen.findByText('Sender key unavailable')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Accept' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    await screen.findByText('Invitation rejected.')
    expect(invitationManager.reject).toHaveBeenCalledTimes(1)
    expect(invitationManager.accept).not.toHaveBeenCalled()
  })
})

describe('SharingSettingsPage copy', () => {
  it('qualifies the encryption claim and points to the existing Security fingerprint', async () => {
    setupPage()

    expect(await screen.findByText('End-to-end encrypted sharing')).toBeInTheDocument()
    expect(screen.queryByText('Zero-knowledge sharing')).toBeNull()
    expect(screen.getByText(/removing a member does not revoke a key they already received/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Settings → Security' })).toHaveAttribute('href', '/settings/security')
  })
})
