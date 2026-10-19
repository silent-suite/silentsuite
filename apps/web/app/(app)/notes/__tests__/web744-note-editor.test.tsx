// @vitest-environment node
import { act, fireEvent, within } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import messages from '@/messages/en.json'

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
  const requireWeb = createRequire(path.resolve(__dirname, '../../../../package.json'))
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
// Only external UI widgets are replaced; the editor, stores, core and SDK are real.
vi.mock('@/app/components/PullToRefresh', () => ({
  PullToRefresh: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/app/components/MobileCollectionSheet', () => ({
  MobileCollectionSheet: () => null,
}))
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}))
vi.mock('../MarkdownEditor', () => ({
  // Carries the page's readOnly through, as the real CodeMirror editor applies it.
  MarkdownEditor: ({ value, onChange, ariaLabel, readOnly }: { value: string; onChange: (value: string) => void; ariaLabel: string; readOnly?: boolean }) => (
    <textarea aria-label={ariaLabel} value={value} readOnly={readOnly} onChange={(event) => onChange(event.target.value)} />
  ),
}))

import NotesPage from '../page'
import { _resetForTests as resetOfflineQueue, getAll, insertIfNoOutstanding, replay } from '@/app/lib/offline-queue'
import { _resetForTests as resetDataCache } from '@/app/lib/data-cache'
import { bumpAccountEpoch } from '@/app/lib/account-epoch'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import {
  getMountedNoteEditor,
  getNoteObligation,
  markNoteObligation,
  registerNoteEditor,
  resetNoteLifecycle,
  useNoteStore,
} from '@/app/stores/use-note-store'
import { useNotebookStore } from '@/app/stores/use-notebook-store'
import { useAuthStore } from '@/app/stores/use-auth-store'
import { useSidebarStore } from '@/app/stores/use-sidebar-store'
import { useExperimentalStore } from '@/app/stores/use-experimental-store'
import {
  EtebaseRequest,
  FINGERPRINT,
  ReferenceServer,
  deleteDatabase,
  installNoteAccount,
  makeSavedNote,
  queueGuard,
  serverText,
} from '@/app/stores/__tests__/web744-sdk-fixture'

vi.setConfig({ testTimeout: 20_000 })

const BASE_TITLE = 'Base title 744'
const BASE_BODY = 'BASE BODY R0 744'
const PEER_BODY = 'ACKNOWLEDGED PEER BODY A 744'
const DRAFT_TITLE = 'Retained draft title B 744'

const mounted: { unmount: () => void }[] = []

function ui() {
  return within(document.body)
}

function renderNotesPage() {
  const container = document.body.appendChild(document.createElement('div'))
  const root = harness.createRoot(container)
  act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <NotesPage />
      </NextIntlClientProvider>,
    )
  })
  let unmounted = false
  const view = {
    container,
    unmount: () => {
      if (unmounted) return
      unmounted = true
      act(() => root.unmount())
      container.remove()
    },
  }
  mounted.push(view)
  return view
}

/** Lets the real editor chain, SDK crypto and IndexedDB work finish. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  })
}

function hideTab() {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
  document.dispatchEvent(new harness.window.Event('visibilitychange'))
}

async function serverTitle(account: any, collection: any, uid: string): Promise<string> {
  const fresh = await account.getCollectionManager().getItemManager(collection).fetch(uid)
  return fresh.getMeta().name
}

const titleBox = () => ui().getByRole('textbox', { name: 'Note title' }) as HTMLInputElement
const bodyBox = () => ui().getByRole('textbox', { name: 'Note body' }) as HTMLTextAreaElement
const saveStatus = () => ui().getByRole('status')

function storedNote(uid: string): any {
  return useNoteStore.getState().notes.find((note) => note.id === uid)
}

/** A sealed custody record whose bytes this test never needs to open. */
function opaqueCustody(collection: any, item: any) {
  return insertIfNoOutstanding(
    { type: 'sealed-update', collectionType: 'notes', collectionUid: collection.uid, itemUid: item.uid, sealed: { iv: [1], ct: [2] }, rev: 1 },
    queueGuard(),
  )
}

async function readAllRecords(dbName: string, storeName: string): Promise<any[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    if (!db.objectStoreNames.contains(storeName)) return []
    return await new Promise<any[]>((resolve, reject) => {
      const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll()
      request.onsuccess = () => resolve(request.result ?? [])
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

async function openRawStub(record: any): Promise<any | null> {
  const [key] = await readAllRecords('silentsuite-data-cache', 'crypto')
  if (!record?.sealed || !(key instanceof CryptoKey)) return null
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: Uint8Array.from(record.sealed.iv), additionalData: new TextEncoder().encode(`${FINGERPRINT}|notes|${record.itemUid}`) },
      key,
      Uint8Array.from(record.sealed.ct),
    )
    return JSON.parse(new TextDecoder().decode(plaintext))
  } catch {
    return null
  }
}

describe('#744 the rendered note editor saves only through its captured base', () => {
  const originalRequest = EtebaseRequest.default
  let server: ReferenceServer

  beforeEach(async () => {
    await resetOfflineQueue()
    await resetDataCache()
    await deleteDatabase('silentsuite-offline-queue')
    await deleteDatabase('silentsuite-data-cache')
    // The real account reset of note lifecycle state, so no case inherits another's entries.
    resetNoteLifecycle()
    server = new ReferenceServer()
    EtebaseRequest.default = (url: string, options: unknown) => server.handle(url, options)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    useAuthStore.setState({ canWrite: () => true } as any)
    useExperimentalStore.setState({ hydrated: true, notesAccounts: [FINGERPRINT] } as any)
    useSidebarStore.setState({ isExpanded: true } as any)
  })

  afterEach(async () => {
    while (mounted.length > 0) mounted.pop()!.unmount()
    // Unmount flushes finish against this case's reference server, never the real transport.
    await settle()
    EtebaseRequest.default = originalRequest
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    useNoteStore.setState({ notes: [] })
  })

  afterAll(() => {
    harness.restore()
  })

  async function seedSavedNote() {
    const { account, collection, item } = await makeSavedNote(BASE_TITLE, BASE_BODY)
    server.seed(collection, [item])
    installNoteAccount(account, collection, item)
    useNotebookStore.setState({
      lists: [{ id: collection.uid, name: 'Notebook 744', color: '#fff', visible: true, accessLevel: 2 }],
      activeListId: 'all',
    } as any)
    const at = new Date(1000)
    useNoteStore.setState({
      notes: [{ id: item.uid, uid: item.uid, title: BASE_TITLE, content: BASE_BODY, notebookId: collection.uid, created_at: at, updated_at: at, revision: item.etag }],
    } as any)
    return { account, collection, item }
  }

  async function openSavedNote() {
    const { account, collection, item } = await seedSavedNote()
    const view = renderNotesPage()
    fireEvent.click(ui().getByRole('button', { name: new RegExp(BASE_TITLE) }))
    await settle()
    return { account, collection, item, view }
  }

  async function peerWritesA(account: any, collection: any, item: any) {
    const peerItem = item._clone()
    await peerItem.setContent(PEER_BODY)
    await account.getCollectionManager().getItemManager(collection).transaction([peerItem])
    return peerItem
  }

  /** Another device writes `body` over `source` through the reference server. */
  async function peerWrites(account: any, collection: any, source: any, body: string) {
    const peerItem = source._clone()
    await peerItem.setContent(body)
    await account.getCollectionManager().getItemManager(collection).transaction([peerItem])
    return peerItem
  }

  /** This context refreshes a peer revision into its SDK cache and note store. */
  function refreshFromServer(uid: string, peerItem: any, patch: { title?: string; content?: string }) {
    act(() => {
      useEtebaseStore.setState({ itemCache: new Map([[uid, peerItem]]) })
      useNoteStore.setState((state) => ({
        notes: state.notes.map((note: any) => (note.id === uid ? { ...note, ...patch, revision: peerItem.etag } : note)),
      }))
    })
    return storedNote(uid)
  }

  const isItemGet = (uid: string) => (method: string, path: string) => method === 'get' && path.endsWith(`item/${uid}`)
  const isTransaction = (method: string, path: string) => method === 'post' && path.endsWith('item/transaction')

  it('#744 refuses a dirty draft typed on R0 after acknowledged A was refreshed in, and A stays', async () => {
    const { account, collection, item } = await openSavedNote()
    fireEvent.change(ui().getByRole('textbox', { name: 'Note title' }), { target: { value: DRAFT_TITLE } })
    const peerItem = await peerWritesA(account, collection, item)
    // This context refreshes A into its SDK cache and note store while the draft stays dirty.
    act(() => {
      useEtebaseStore.setState({ itemCache: new Map([[item.uid, peerItem]]) })
      useNoteStore.setState((state) => ({
        notes: state.notes.map((note: any) => (note.id === item.uid ? { ...note, content: PEER_BODY, revision: peerItem.etag } : note)),
      }))
    })

    hideTab()
    await settle()

    // 744 wired boundary
    expect(await serverText(account, collection, item.uid)).toBe(PEER_BODY)

    expect(await serverTitle(account, collection, item.uid)).toBe(BASE_TITLE)
    expect(ui().getByRole('textbox', { name: 'Note title' })).toHaveValue(DRAFT_TITLE)
  })

  it('#744 refuses a dirty draft when a peer changed the note and this tab never saw it', async () => {
    const { account, collection, item } = await openSavedNote()
    fireEvent.change(ui().getByRole('textbox', { name: 'Note title' }), { target: { value: DRAFT_TITLE } })
    await peerWritesA(account, collection, item)

    hideTab()
    await settle()

    // 744 wired boundary
    expect(await serverText(account, collection, item.uid)).toBe(PEER_BODY)

    expect(ui().getByRole('textbox', { name: 'Note title' })).toHaveValue(DRAFT_TITLE)
  })

  it('#744 saves two successive own edits through their own lineage', async () => {
    const { account, collection, item } = await openSavedNote()
    const title = ui().getByRole('textbox', { name: 'Note title' })
    fireEvent.change(title, { target: { value: 'First own title 744' } })
    hideTab()
    await settle()
    fireEvent.change(title, { target: { value: 'Second own title 744' } })
    hideTab()
    await settle()

    // 744 wired boundary
    expect(await serverTitle(account, collection, item.uid)).toBe('Second own title 744')

    expect(await serverText(account, collection, item.uid)).toBe(BASE_BODY)
  })

  it('#744 saves a captured draft when the editor unmounts', async () => {
    const { account, collection, item, view } = await openSavedNote()
    fireEvent.change(ui().getByRole('textbox', { name: 'Note title' }), { target: { value: 'Unmount title 744' } })

    view.unmount()
    await settle()

    // 744 wired boundary
    expect(await serverTitle(account, collection, item.uid)).toBe('Unmount title 744')
  })

  it('#744 obliges a note whose editor mounts while custody is outstanding', async () => {
    const { account, collection, item } = await makeSavedNote(BASE_TITLE, BASE_BODY)
    server.seed(collection, [item])
    installNoteAccount(account, collection, item)
    // Outstanding custody already exists for this note when its editor opens.
    expect(await insertIfNoOutstanding(
      { type: 'sealed-update', collectionType: 'notes', collectionUid: collection.uid, itemUid: item.uid, sealed: { iv: [1], ct: [2] }, rev: 1 },
      queueGuard(),
    )).toBe(true)
    useNotebookStore.setState({
      lists: [{ id: collection.uid, name: 'Notebook 744', color: '#fff', visible: true, accessLevel: 2 }],
      activeListId: 'all',
    } as any)
    const at = new Date(1000)
    useNoteStore.setState({
      notes: [{ id: item.uid, uid: item.uid, title: BASE_TITLE, content: BASE_BODY, notebookId: collection.uid, created_at: at, updated_at: at, revision: item.etag }],
    } as any)
    renderNotesPage()
    fireEvent.click(ui().getByRole('button', { name: new RegExp(BASE_TITLE) }))
    await settle()

    // 744 wired boundary
    expect(getNoteObligation(item.uid)).toBeDefined()
  })

  it('#744 adopts a clean refresh at a newer revision with identical text as a new exact base', async () => {
    const { account, collection, item } = await openSavedNote()
    const peerItem = await peerWrites(account, collection, item, BASE_BODY)
    expect(peerItem.etag).not.toBe(item.etag)
    refreshFromServer(item.uid, peerItem, {})
    const before = server.transactions.length

    fireEvent.change(titleBox(), { target: { value: 'Own title on R1 744' } })
    hideTab()
    await settle()

    // 744 wired boundary
    expect(server.transactions.slice(before).map((sent) => sent.items[0].etag)).toEqual([peerItem.etag])

    expect(await serverTitle(account, collection, item.uid)).toBe('Own title on R1 744')
  })

  it('#744 releases an obligation on a fresh proof of the adopted base with nothing outstanding', async () => {
    const { account, collection, item } = await openSavedNote()
    const obligation = markNoteObligation(item.uid)
    expect(getNoteObligation(item.uid)).toBe(obligation)
    const peerItem = await peerWrites(account, collection, item, PEER_BODY)

    refreshFromServer(item.uid, peerItem, { content: PEER_BODY })
    await settle()

    // 744 wired boundary
    expect(getNoteObligation(item.uid)).toBeUndefined()

    expect(bodyBox()).toHaveValue(PEER_BODY)
  })

  it('#744 keeps the obligation when the server moved past the adopted base', async () => {
    const { account, collection, item } = await openSavedNote()
    const obligation = markNoteObligation(item.uid)
    const peerA = await peerWrites(account, collection, item, PEER_BODY)
    await peerWrites(account, collection, peerA, 'NEWER PEER BODY A2 744')

    // This context only learned of A; the fresh read sees A2.
    refreshFromServer(item.uid, peerA, { content: PEER_BODY })
    await settle()

    // 744 wired boundary
    expect(getNoteObligation(item.uid)).toBe(obligation)

    expect(bodyBox()).toHaveValue(PEER_BODY)
  })

  it('#744 keeps the obligation while custody is outstanding, even when the server matches', async () => {
    const { account, collection, item } = await openSavedNote()
    const obligation = markNoteObligation(item.uid)
    expect(await opaqueCustody(collection, item)).toBe(true)
    const peerItem = await peerWrites(account, collection, item, PEER_BODY)

    refreshFromServer(item.uid, peerItem, { content: PEER_BODY })
    await settle()

    // 744 wired boundary
    expect(getNoteObligation(item.uid)).toBe(obligation)

    expect(bodyBox()).toHaveValue(PEER_BODY)
  })

  it('#744 keeps the obligation when typing starts a new period while the release proof is in flight', async () => {
    const { account, collection, item } = await openSavedNote()
    const obligation = markNoteObligation(item.uid)
    const peerItem = await peerWrites(account, collection, item, PEER_BODY)
    const proofRead = server.holdNext(isItemGet(item.uid))

    refreshFromServer(item.uid, peerItem, { content: PEER_BODY })
    await proofRead.arrived
    fireEvent.change(titleBox(), { target: { value: DRAFT_TITLE } })
    // The fresh read still matches the adopted base; only the period moved on.
    proofRead.release(false)
    await settle()

    // 744 wired boundary
    expect(getNoteObligation(item.uid)).toBe(obligation)

    expect(titleBox()).toHaveValue(DRAFT_TITLE)
  })

  it('#744 obliges a clean note once it turns dirty while custody is outstanding', async () => {
    const { collection, item } = await openSavedNote()
    expect(await opaqueCustody(collection, item)).toBe(true)
    await settle()
    // Still clean: the custody that appeared after mount is not read yet.
    expect(getNoteObligation(item.uid)).toBeUndefined()

    fireEvent.change(titleBox(), { target: { value: DRAFT_TITLE } })
    await settle()

    // 744 wired boundary
    expect(getNoteObligation(item.uid)).toBeDefined()
  })

  it('#744 queues an own successor through its predecessor base and the original server proof', async () => {
    const { account, collection, item } = await openSavedNote()
    server.offline = true
    fireEvent.change(titleBox(), { target: { value: 'Queued first 744' } })
    hideTab()
    await settle()
    const [first] = await readAllRecords('silentsuite-offline-queue', 'mutations')
    const firstPayload = await openRawStub(first)
    expect([first?.rev, firstPayload?.body?.meta?.name, firstPayload?.base?.revision]).toEqual([1, 'Queued first 744', item.etag])

    fireEvent.change(titleBox(), { target: { value: 'Queued second 744' } })
    hideTab()
    await settle()
    const records = await readAllRecords('silentsuite-offline-queue', 'mutations')
    const successor = await openRawStub(records[0])

    // 744 wired boundary
    expect([records.length, records[0]?.rev, successor?.body?.meta?.name, successor?.base?.revision, successor?.prior?.length])
      .toEqual([1, 2, 'Queued second 744', item.etag, 1])

    expect(successor?.base?.digest).toBe(firstPayload?.base?.digest)
    expect(saveStatus()).toHaveTextContent('Saved')
    server.offline = false
    const guard = queueGuard()
    await replay((queued, checkpoint) => useEtebaseStore.getState().replayQueuedMutation(queued, guard, checkpoint), guard)
    expect(await serverTitle(account, collection, item.uid)).toBe('Queued second 744')
    expect(await serverText(account, collection, item.uid)).toBe(BASE_BODY)
    expect(await getAll(guard)).toEqual([])
  })

  it('#744 never lets a late accepted save advance a newer lineage of the same editor', async () => {
    const { account, collection, item } = await openSavedNote()
    // The server holds identical text at R1, so the R0 save rebinds through a fresh read.
    const peerItem = await peerWrites(account, collection, item, BASE_BODY)
    const rebindRead = server.holdNext(isItemGet(item.uid))
    fireEvent.change(titleBox(), { target: { value: 'Late own title 744' } })
    hideTab()
    await rebindRead.arrived
    // While that save waits, the editor turns clean and adopts R1 as a new lineage. The
    // refresh carries the server's R1 text over this context's optimistic record.
    fireEvent.change(titleBox(), { target: { value: BASE_TITLE } })
    const adopted = refreshFromServer(item.uid, peerItem, { title: BASE_TITLE, content: BASE_BODY })
    rebindRead.release(false)
    await settle()
    expect(await serverTitle(account, collection, item.uid)).toBe('Late own title 744')
    const before = server.transactions.length

    hideTab()
    await settle()

    // 744 wired boundary
    expect(server.transactions.length).toBe(before)

    expect(storedNote(item.uid)).toBe(adopted)
    expect(titleBox()).toHaveValue(BASE_TITLE)
  })

  it('#744 never lets a late accepted save advance another account', async () => {
    const { account, collection, item } = await openSavedNote()
    const cachedBefore = useEtebaseStore.getState().itemCache.get(item.uid)
    const write = server.holdNext(isTransaction)
    fireEvent.change(titleBox(), { target: { value: 'Old account title 744' } })
    hideTab()
    await write.arrived
    const nextAccountNotes: any[] = []
    act(() => {
      bumpAccountEpoch()
      useNoteStore.setState({ notes: nextAccountNotes })
    })

    write.release(false)
    await settle()

    // 744 wired boundary
    expect([useNoteStore.getState().notes, useEtebaseStore.getState().itemCache.get(item.uid)]).toEqual([nextAccountNotes, cachedBefore])

    expect(useNoteStore.getState().notes).toBe(nextAccountNotes)
    expect(useEtebaseStore.getState().itemCache.get(item.uid)).toBe(cachedBefore)
    expect([getNoteObligation(item.uid), getMountedNoteEditor(item.uid)]).toEqual([undefined, undefined])
    // The remote write itself had already left; only local state is withheld.
    expect(await serverTitle(account, collection, item.uid)).toBe('Old account title 744')
  })

  it('#744 keeps refused typing visible as Not saved across a refresh of the note', async () => {
    const { account, collection, item } = await openSavedNote()
    fireEvent.change(titleBox(), { target: { value: DRAFT_TITLE } })
    const peerItem = await peerWritesA(account, collection, item)
    hideTab()
    await settle()
    expect(saveStatus()).toHaveTextContent('Not saved')

    refreshFromServer(item.uid, peerItem, { content: PEER_BODY })
    await settle()

    // 744 wired boundary
    expect(saveStatus()).toHaveTextContent('Not saved')

    expect([titleBox().value, bodyBox().value]).toEqual([DRAFT_TITLE, BASE_BODY])
    expect(await serverText(account, collection, item.uid)).toBe(PEER_BODY)
  })

  it('#744 keeps a later editor of the same note registered, and its obligation, when an older editor unmounts', async () => {
    const { item } = await seedSavedNote()
    const obligation = markNoteObligation(item.uid)
    const older = renderNotesPage()
    fireEvent.click(within(older.container).getByRole('button', { name: new RegExp(BASE_TITLE) }))
    await settle()
    const olderEditor = getMountedNoteEditor(item.uid)
    const later = renderNotesPage()
    fireEvent.click(within(later.container).getByRole('button', { name: new RegExp(BASE_TITLE) }))
    await settle()
    const laterEditor = getMountedNoteEditor(item.uid)
    expect(laterEditor).toBeDefined()
    expect(laterEditor).not.toBe(olderEditor)

    older.unmount()
    await settle()

    // 744 wired boundary
    expect([getMountedNoteEditor(item.uid), getNoteObligation(item.uid)]).toEqual([laterEditor, obligation])

    expect(getMountedNoteEditor(item.uid)).toBe(laterEditor)
    expect(getNoteObligation(item.uid)).toBe(obligation)
    // Unmounting is not a release: the same obligation stays once no editor is mounted.
    later.unmount()
    await settle()
    expect(getMountedNoteEditor(item.uid)).toBeUndefined()
    expect(getNoteObligation(item.uid)).toBe(obligation)
  })

  it('#744 clears note obligations and mounted editors on the real logout reset', async () => {
    const SENTINEL = 'web744-sentinel-note'
    const editor = {
      periodGen: () => 0,
      isClean: () => true,
      chainIdle: () => true,
      base: () => ({ title: BASE_TITLE, content: BASE_BODY, revision: null }),
      flushAndWait: async () => {},
    }
    // Observe the store's own maps: native set runs unchanged, only its receiver is kept.
    const nativeSet = Map.prototype.set
    const receivers: Map<unknown, any>[] = []
    Map.prototype.set = function observedSet(this: Map<unknown, any>, key: unknown, value: unknown) {
      if (key === SENTINEL && value && typeof value === 'object' && 'accountEpoch' in value) receivers.push(this)
      return nativeSet.call(this, key, value)
    }
    let obligation: object
    try {
      obligation = markNoteObligation(SENTINEL)
      registerNoteEditor(SENTINEL, editor)
    } finally {
      Map.prototype.set = nativeSet
    }
    const obligations = receivers.find((map) => map.get(SENTINEL)?.obligation === obligation)
    const editors = receivers.find((map) => map.get(SENTINEL)?.editor === editor)
    // beforeEach ran the real reset, so each map holds exactly this case's entry.
    expect([obligations?.get(SENTINEL)?.obligation, editors?.get(SENTINEL)?.editor]).toEqual([obligation!, editor])
    expect([obligations?.size, editors?.size]).toEqual([1, 1])
    // External transport only: the hosted session delete answers locally.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    try {
      await useAuthStore.getState().logout()
    } finally {
      fetchSpy.mockRestore()
    }

    // 744 wired boundary
    expect([obligations!.size, editors!.size]).toEqual([0, 0])
  })

  it('#744 keeps the open editor and its refused typing, read-only, when its notebook disappears', async () => {
    const { account, collection, item } = await openSavedNote()
    // A second notebook, so this one can disappear while the account keeps a notebook.
    const other = await account.getCollectionManager().create('etebase.md.note', { name: 'Other 744', mtime: 1 }, '')
    other.encryptedCollection.__markSaved()
    server.seed(other, [])
    act(() => {
      const { collections } = useEtebaseStore.getState()
      useEtebaseStore.setState({ collections: { ...collections, notes: [...collections.notes, other] } } as any)
    })
    fireEvent.change(titleBox(), { target: { value: DRAFT_TITLE } })
    await peerWritesA(account, collection, item)
    hideTab()
    await settle()
    expect(saveStatus()).toHaveTextContent('Not saved')
    const editor = getMountedNoteEditor(item.uid)
    expect(editor).toBeDefined()
    // Another device deletes the notebook; the real reconcile, then a refresh that no longer lists the note.
    const gone = await account.getCollectionManager().fetch(collection.uid)
    gone.delete()
    server.replaceCollection(gone)
    await act(async () => {
      await useEtebaseStore.getState().reconcileCollections()
    })
    act(() => useNoteStore.getState().syncFromRemote([]))
    await settle()
    const before = server.transactions.length
    hideTab()
    await settle()

    // 744 wired boundary
    expect([getMountedNoteEditor(item.uid) === editor, titleBox().value, titleBox().readOnly, bodyBox().readOnly])
      .toEqual([true, DRAFT_TITLE, true, true])

    expect(saveStatus()).toHaveTextContent('Not saved')
    expect(server.transactions.length).toBe(before)
    expect(await serverTitle(account, collection, item.uid)).toBe(BASE_TITLE)
  })

  it('#744 keeps typing that began while a delete of the open note was in flight', async () => {
    await openSavedNote()
    const deleting = server.holdNext(isTransaction)
    fireEvent.click(ui().getAllByRole('button', { name: /delete/i })[0]!)
    const deleteButtons = ui().getAllByRole('button', { name: /delete/i })
    fireEvent.click(deleteButtons[deleteButtons.length - 1]!)
    await deleting.arrived
    fireEvent.change(titleBox(), { target: { value: 'Typed during delete 744' } })

    deleting.release(false)
    await settle()

    // 744 wired boundary
    expect((ui().queryByRole('textbox', { name: 'Note title' }) as HTMLInputElement | null)?.value).toBe('Typed during delete 744')
  })
})
