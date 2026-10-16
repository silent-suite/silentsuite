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

const toastMock = vi.hoisted(() => ({ showErrorToast: vi.fn() }))
vi.mock('@/app/stores/use-toast-store', () => toastMock)
vi.mock('@/app/stores/use-label-suggestions-store', () => ({
  useLabelSuggestionsStore: { getState: () => ({ recordUsage: vi.fn(), reset: vi.fn() }) },
}))

import { PendingSyncBanner } from '../PendingSyncBanner'
import { _resetForTests as resetOfflineQueue, casStub, removeItemMutations } from '@/app/lib/offline-queue'
import { _resetForTests as resetDataCache } from '@/app/lib/data-cache'
import { bumpAccountEpoch } from '@/app/lib/account-epoch'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import { useNoteStore } from '@/app/stores/use-note-store'
import { useNotebookStore } from '@/app/stores/use-notebook-store'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { useSyncStore } from '@/app/stores/use-sync-store'
import {
  EtebaseRequest,
  ReferenceServer,
  deleteDatabase,
  installNoteAccount,
  makeSavedNote,
  queueGuard,
  serverText,
} from '@/app/stores/__tests__/web744-sdk-fixture'

vi.setConfig({ testTimeout: 20_000 })

const BASE_TITLE = 'Kept note title 744'
const BASE_BODY = 'BASE BODY R0 744'
const PEER_BODY = 'PEER BODY A 744'
const HELD_BODY = 'PRIVATE HELD BODY B 744'
const BASE_CHANGED_TEXT = "This offline edit doesn't match the current saved version, so it wasn't saved over it. It's kept on this device."
const LEGACY_TEXT = "Can't be verified, won't be sent automatically; changes paused."

const mounted: { unmount: () => void }[] = []

function ui() {
  return within(document.body)
}

function renderBanner() {
  const container = document.body.appendChild(document.createElement('div'))
  const root = harness.createRoot(container)
  act(() => {
    root.render(<PendingSyncBanner />)
  })
  const view = {
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
  mounted.push(view)
  return view
}

/** Lets the real queue, SDK crypto and IndexedDB work finish. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  })
}

async function queueRecords(): Promise<any[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('silentsuite-offline-queue')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    if (!db.objectStoreNames.contains('mutations')) return []
    return await new Promise<any[]>((resolve, reject) => {
      const request = db.transaction('mutations', 'readonly').objectStore('mutations').getAll()
      request.onsuccess = () => resolve(request.result ?? [])
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

describe('#744 the pending sync banner lists kept and legacy offline changes', () => {
  const originalRequest = EtebaseRequest.default
  let server: ReferenceServer

  beforeEach(async () => {
    await resetOfflineQueue()
    await resetDataCache()
    await deleteDatabase('silentsuite-offline-queue')
    await deleteDatabase('silentsuite-data-cache')
    server = new ReferenceServer()
    EtebaseRequest.default = (url: string, options: unknown) => server.handle(url, options)
    useAuthStore.setState({ canWrite: () => true } as any)
    // Offline here only keeps the cycle from refreshing over the network; replay itself still runs.
    useSyncStore.setState({ pendingQueueCount: 0, failedQueueCount: 0, isOnline: false })
  })

  afterEach(async () => {
    while (mounted.length > 0) mounted.pop()!.unmount()
    await settle()
    EtebaseRequest.default = originalRequest
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    useNoteStore.setState({ notes: [] })
  })

  afterAll(() => {
    harness.restore()
  })

  async function savedNote() {
    const { account, collection, item } = await makeSavedNote(BASE_TITLE, BASE_BODY)
    server.seed(collection, [item])
    installNoteAccount(account, collection, item)
    useNotebookStore.setState({ lists: [{ id: collection.uid, name: 'Notebook 744', color: '#fff', visible: true, accessLevel: 2 }] } as any)
    const at = new Date(1000)
    useNoteStore.setState({
      notes: [{ id: item.uid, uid: item.uid, title: BASE_TITLE, content: BASE_BODY, notebookId: collection.uid, created_at: at, updated_at: at, revision: item.etag }],
    } as any)
    return { account, collection, item }
  }

  /** A real offline edit B, sealed, then held as base-changed after a peer wrote A. */
  async function noteWithHeldEdit() {
    const { account, collection, item } = await savedNote()
    server.offline = true
    expect(await useNoteStore.getState().updateNote(
      item.uid,
      { title: BASE_TITLE, content: HELD_BODY },
      { base: { title: BASE_TITLE, content: BASE_BODY, revision: item.etag } },
    )).toBe(true)
    server.offline = false
    const peer = item._clone()
    await peer.setContent(PEER_BODY)
    await account.getCollectionManager().getItemManager(collection).transaction([peer])
    await useSyncStore.getState().replayOfflineQueue()
    const [held] = await queueRecords()
    expect(held?.held).toBe('base-changed')
    return { account, collection, item, held }
  }

  it('#744 lists a lone held edit under its current title while nothing is pending or failed', async () => {
    const { held } = await noteWithHeldEdit()
    renderBanner()
    await settle()

    // 744 wired boundary
    expect(ui().queryByText(BASE_CHANGED_TEXT)).not.toBeNull()

    expect(ui().queryByText(BASE_TITLE)).not.toBeNull()
    expect(ui().getAllByRole('button').map((button) => button.textContent)).toEqual(['Retry', 'Discard'])
    expect(document.body.textContent).not.toContain(HELD_BODY)
    expect(held.sealed).toBeDefined()
  })

  it('#744 retries a held edit only by making it eligible, and replay holds it again without overwriting', async () => {
    const { account, collection, item, held } = await noteWithHeldEdit()
    renderBanner()
    await settle()

    fireEvent.click(ui().getByRole('button', { name: 'Retry' }))
    await settle()
    const [after] = await queueRecords()

    // 744 wired boundary
    expect([after?.held, after?.rev > held.rev, after?.sealed]).toEqual(['base-changed', true, held.sealed])

    expect(await serverText(account, collection, item.uid)).toBe(PEER_BODY)
    expect(ui().queryByText(BASE_CHANGED_TEXT)).not.toBeNull()
  })

  it('#744 discards only the held edit at the revision it was shown with', async () => {
    const { held } = await noteWithHeldEdit()
    renderBanner()
    await settle()

    // The record moves on before the shown row is acted on: the stale Discard does nothing.
    expect(await casStub(held.id, held.rev, { retryCount: 1 }, queueGuard())).toBe(true)
    fireEvent.click(ui().getByRole('button', { name: 'Discard' }))
    await settle()
    const kept = await queueRecords()

    // 744 wired boundary
    expect(kept.map((record) => [record.id, record.rev, record.held])).toEqual([[held.id, held.rev + 1, 'base-changed']])

    fireEvent.click(ui().getByRole('button', { name: 'Discard' }))
    await settle()
    expect(await queueRecords()).toEqual([])
    expect(ui().queryByText(BASE_CHANGED_TEXT)).toBeNull()
  })

  it('#744 ignores a held-row action after the account changed', async () => {
    const { held } = await noteWithHeldEdit()
    renderBanner()
    await settle()

    bumpAccountEpoch()
    fireEvent.click(ui().getByRole('button', { name: 'Discard' }))
    await settle()

    // 744 wired boundary
    expect((await queueRecords()).map((record) => [record.id, record.rev])).toEqual([[held.id, held.rev]])
  })

  it('#744 never sends a legacy content-free update, keeps it through cleanup, and pauses the note until Dismiss', async () => {
    const { account, collection, item } = await savedNote()
    server.offline = true
    // A content-free update from the pre-custody path: body only in the display cache.
    expect(await useEtebaseStore.getState().updateItem('notes', item.uid, 'LEGACY CACHED BODY 744', {
      persistEncryptedOfflineContent: true,
      meta: { name: BASE_TITLE, mtime: 2 },
    })).toBe('queued')
    server.offline = false

    await useSyncStore.getState().replayOfflineQueue()

    // 744 wired boundary
    expect(await serverText(account, collection, item.uid)).toBe(BASE_BODY)

    const [legacy] = await queueRecords()
    expect([legacy?.type, legacy?.content, legacy?.sealed]).toEqual(['update', undefined, undefined])
    expect(await removeItemMutations('notes', item.uid, queueGuard())).toBe(0)
    expect((await queueRecords()).map((record) => record.id)).toEqual([legacy.id])
    renderBanner()
    await settle()
    expect(ui().queryByText(LEGACY_TEXT)).not.toBeNull()
    expect(ui().getAllByRole('button').map((button) => button.textContent)).toEqual(['Dismiss'])
    const base = { title: BASE_TITLE, content: BASE_BODY, revision: item.etag }
    expect(await useNoteStore.getState().updateNote(item.uid, { title: BASE_TITLE, content: 'PAUSED EDIT 744' }, { base })).toBe(false)
    expect(await serverText(account, collection, item.uid)).toBe(BASE_BODY)

    fireEvent.click(ui().getByRole('button', { name: 'Dismiss' }))
    await settle()
    expect(await queueRecords()).toEqual([])
    expect(ui().queryByText(LEGACY_TEXT)).toBeNull()
    expect(await useNoteStore.getState().updateNote(item.uid, { title: BASE_TITLE, content: 'AFTER DISMISS 744' }, { base })).toBe(true)
    expect(await serverText(account, collection, item.uid)).toBe('AFTER DISMISS 744')
  })
})
