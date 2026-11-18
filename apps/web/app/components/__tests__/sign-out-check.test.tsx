// @vitest-environment node
import { act, fireEvent, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Node's realm for bytes, encoders and crypto, as the pinned SDK and libsodium
 * require; a real jsdom supplies only the DOM names Node lacks. The shared setup
 * file loads react-dom before this file runs, and react-dom decides at load
 * whether a DOM exists, so a fresh react-dom client is loaded once the DOM is up.
 */
const harness = vi.hoisted(() => {
  const nodeProcess = (globalThis as any).process
  const { createRequire } = nodeProcess.getBuiltinModule('node:module')
  const path = nodeProcess.getBuiltinModule('node:path')
  const requireWeb = createRequire(path.resolve(__dirname, '../../../package.json'))
  // IndexedDB belongs to Node's global, as in the node-environment store tests; with a
  // window present the auto installer would put it on the window instead.
  requireWeb('fake-indexeddb/auto')
  const { JSDOM } = requireWeb('jsdom')
  const jsdom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
  const window = jsdom.window
  const replaced: [string, PropertyDescriptor | undefined][] = []
  const install = (name: string, value: unknown) => {
    replaced.push([name, Object.getOwnPropertyDescriptor(globalThis, name)])
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  install('window', window)
  for (const name of Object.getOwnPropertyNames(window)) {
    // DOM names only: never anything Node already provides.
    if (name in globalThis) continue
    const value = window[name]
    install(name, typeof value === 'function' && !/^[A-Z]/.test(name) ? value.bind(window) : value)
  }
  const navigatorOnLine = Object.getOwnPropertyDescriptor(globalThis.navigator, 'onLine')
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, get: () => true })
  for (const id of Object.keys(requireWeb.cache)) {
    if (/[\\/]react-dom[\\/](client\.js|cjs[\\/]react-dom-client\.)/.test(id)) delete requireWeb.cache[id]
  }
  const client = requireWeb('react-dom/client')
  return {
    window,
    createRoot: client.createRoot as (container: Element) => { render: (node: ReactNode) => void; unmount: () => void },
    restore() {
      for (const [name, descriptor] of replaced.reverse()) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else delete (globalThis as any)[name]
      }
      if (navigatorOnLine) Object.defineProperty(globalThis.navigator, 'onLine', navigatorOnLine)
      else delete (globalThis.navigator as any).onLine
      window.close()
    },
  }
})


vi.mock('next/navigation', () => ({ usePathname: () => '/notes' }))
vi.mock('@/app/components/theme-toggle', () => ({ ThemeToggle: () => null }))
vi.mock('@/app/components/SyncIndicator', () => ({ SyncIndicator: () => null }))

import { NextIntlClientProvider } from 'next-intl'
import messages from '@/messages/en.json'
import { Header } from '../header'
import { _resetForTests as resetOfflineQueue, getAll, insertIfNoOutstanding, remove } from '@/app/lib/offline-queue'
import { bumpAccountEpoch } from '@/app/lib/account-epoch'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { getHeldNoteDraft, holdNoteDraft, resetNoteLifecycle, settleNoteTextForCount } from '@/app/stores/use-note-store'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { useSyncStore } from '@/app/stores/use-sync-store'
import { FINGERPRINT, deleteDatabase, queueGuard } from '@/app/stores/__tests__/web744-sdk-fixture'

const mounted: { unmount: () => void }[] = []

function ui() {
  return within(document.body)
}

function renderHeader() {
  const container = document.body.appendChild(document.createElement('div'))
  const root = harness.createRoot(container)
  act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <Header />
      </NextIntlClientProvider>,
    )
  })
  mounted.push({
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  })
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  })
}

async function clickLogOut() {
  fireEvent.click(ui().getByRole('button', { name: 'User menu' }))
  fireEvent.click(ui().getByRole('menuitem', { name: /Log out/ }))
  await settle()
}

/** A held sealed record of a note, as a refused save leaves it; its bytes are never opened here. */
function heldRecord(itemUid: string) {
  return insertIfNoOutstanding(
    { type: 'sealed-update', collectionType: 'notes', collectionUid: 'notebook-1113', itemUid, sealed: { iv: [1], ct: [2] }, rev: 1, held: 'base-changed' },
    queueGuard(),
  )
}

const dialog = () => ui().queryByRole('dialog')

describe('#1113 D1 Log out counts changes only on this device first', () => {
  let logout: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    await resetOfflineQueue()
    await deleteDatabase('silentsuite-offline-queue')
    resetNoteLifecycle()
    logout = vi.fn(async () => {})
    useAuthStore.setState({ user: { email: 'user@example.invalid' }, logout } as any)
    useEtebaseStore.setState({ accountFingerprint: FINGERPRINT } as any)
  })

  afterEach(async () => {
    while (mounted.length > 0) mounted.pop()!.unmount()
    await settleNoteTextForCount()
    resetNoteLifecycle()
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
  })

  afterAll(() => {
    harness.restore()
  })

  it('logs out at once when nothing is only on this device', async () => {
    renderHeader()
    await clickLogOut()

    expect(dialog()).toBeNull()
    expect(logout).toHaveBeenCalledTimes(1)
  })

  it('shows the count of held records and held note text, and Cancel keeps both', async () => {
    expect(await heldRecord('note-a')).toBe(true)
    // Text whose save failed without a refusal stays only in this page.
    holdNoteDraft('note-b', { draft: { title: 'PRIVATE B', content: 'PRIVATE B BODY' }, base: { title: '', content: '', revision: null }, failed: 'error' })
    await settleNoteTextForCount()
    renderHeader()

    await clickLogOut()

    expect(dialog()).not.toBeNull()
    expect(ui().getAllByText('2 changes are only on this device. Logging out deletes them.').length).toBeGreaterThan(0)
    for (const name of ['Sync now', 'Cancel', 'Log out and delete']) expect(ui().getByRole('button', { name })).toBeTruthy()
    fireEvent.click(ui().getByRole('button', { name: 'Cancel' }))
    await settle()

    expect(dialog()).toBeNull()
    expect(logout).not.toHaveBeenCalled()
    expect((await getAll(queueGuard())).map((record) => record.itemUid)).toEqual(['note-a'])
    expect(getHeldNoteDraft('note-b')?.draft.content).toBe('PRIVATE B BODY')
  })

  it('treats a count that fails as having changes: no plain log out, only a confirmed delete', async () => {
    // No account fingerprint: this account's queue cannot be read.
    useEtebaseStore.setState({ accountFingerprint: null } as any)
    renderHeader()

    await clickLogOut()

    expect(logout).not.toHaveBeenCalled()
    expect(ui().getAllByText(/could not check for changes that are only on this device/).length).toBeGreaterThan(0)
    fireEvent.click(ui().getByRole('button', { name: 'Log out and delete' }))
    await settle()
    expect(logout).not.toHaveBeenCalled()
    expect(ui().getByRole('button', { name: 'Delete and log out' })).toBeTruthy()
    fireEvent.click(ui().getByRole('button', { name: 'Delete and log out' }))
    await settle()

    expect(logout).toHaveBeenCalledTimes(1)
  })

  it('counts again right before deleting and asks again when there is more than was agreed', async () => {
    expect(await heldRecord('note-a')).toBe(true)
    renderHeader()
    await clickLogOut()
    fireEvent.click(ui().getByRole('button', { name: 'Log out and delete' }))
    await settle()
    expect(ui().getAllByText(/^1 change that is only on this device will be deleted/).length).toBeGreaterThan(0)

    expect(await heldRecord('note-c')).toBe(true)
    fireEvent.click(ui().getByRole('button', { name: 'Delete and log out' }))
    await settle()

    expect(logout).not.toHaveBeenCalled()
    expect(ui().getAllByText(/^2 changes that are only on this device will be deleted/).length).toBeGreaterThan(0)
    fireEvent.click(ui().getByRole('button', { name: 'Delete and log out' }))
    await settle()
    expect(logout).toHaveBeenCalledTimes(1)
  })

  it('does nothing once the account it counted for is no longer this tab\'s', async () => {
    expect(await heldRecord('note-a')).toBe(true)
    renderHeader()
    await clickLogOut()
    fireEvent.click(ui().getByRole('button', { name: 'Log out and delete' }))
    await settle()

    bumpAccountEpoch()
    fireEvent.click(ui().getByRole('button', { name: 'Delete and log out' }))
    await settle()

    expect(logout).not.toHaveBeenCalled()
    expect(dialog()).toBeNull()
  })

  it('Sync now syncs, counts again and logs out once nothing is left', async () => {
    expect(await insertIfNoOutstanding(
      { type: 'delete', collectionType: 'tasks', collectionUid: 'list-1113', itemUid: 'task-1113' },
      queueGuard(),
    )).toBe(true)
    const replayOfflineQueue = vi.fn(async () => {
      for (const record of await getAll(queueGuard())) await remove(record.id, queueGuard())
      return 1
    })
    useSyncStore.setState({ replayOfflineQueue } as any)
    renderHeader()
    await clickLogOut()
    expect(ui().getAllByText('1 change is only on this device. Logging out deletes it.').length).toBeGreaterThan(0)

    fireEvent.click(ui().getByRole('button', { name: 'Sync now' }))
    await settle()

    expect(replayOfflineQueue).toHaveBeenCalledTimes(1)
    expect(logout).toHaveBeenCalledTimes(1)
  })

  it('Sync now keeps the dialog with the new count while held changes remain', async () => {
    expect(await heldRecord('note-a')).toBe(true)
    useSyncStore.setState({ replayOfflineQueue: vi.fn(async () => 0) } as any)
    renderHeader()
    await clickLogOut()

    fireEvent.click(ui().getByRole('button', { name: 'Sync now' }))
    await settle()

    expect(logout).not.toHaveBeenCalled()
    expect(ui().getAllByText('1 change is only on this device. Logging out deletes it.').length).toBeGreaterThan(0)
  })
})
