// @vitest-environment node
import { act, fireEvent, within } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { StrictMode, type ReactNode } from 'react'
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
  readNewerNoteVersion,
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
  respond,
  serverText,
} from '@/app/stores/__tests__/web744-sdk-fixture'

vi.setConfig({ testTimeout: 20_000 })

const BASE_TITLE = 'Base title 744'
const BASE_BODY = 'BASE BODY R0 744'
const PEER_BODY = 'ACKNOWLEDGED PEER BODY A 744'
const DRAFT_TITLE = 'Retained draft title B 744'
const OTHER_TITLE = 'Other note 849'

const mounted: { unmount: () => void }[] = []

function ui() {
  return within(document.body)
}

function renderNotesPage({ strict = false } = {}) {
  const container = document.body.appendChild(document.createElement('div'))
  const root = harness.createRoot(container)
  const page = (
    <NextIntlClientProvider locale="en" messages={messages}>
      <NotesPage />
    </NextIntlClientProvider>
  )
  act(() => {
    root.render(strict ? <StrictMode>{page}</StrictMode> : page)
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

  /** A second writable notebook, known to the server and to this context. */
  async function addNotebook(account: any) {
    const target = await account.getCollectionManager().create('etebase.md.note', { name: 'Target 849', mtime: 1 }, '')
    target.encryptedCollection.__markSaved()
    server.seed(target, [])
    act(() => {
      const { collections } = useEtebaseStore.getState()
      useEtebaseStore.setState({ collections: { ...collections, notes: [...collections.notes, target] } } as any)
      useNotebookStore.setState((state: any) => ({ lists: [...state.lists, { id: target.uid, name: 'Target 849', color: '#fff', visible: true, accessLevel: 2 }] }))
    })
    return target
  }

  const isSourceTransaction = (collection: any) => (method: string, path: string) => (
    method === 'post' && path.includes(collection.uid) && path.endsWith('item/transaction')
  )
  const notebookPicker = () => ui().getByRole('combobox', { name: 'Notebook' }) as HTMLSelectElement
  const movedCopy = (target: any) => useNoteStore.getState().notes.find((note: any) => note.notebookId === target.uid)

  /** A second saved note in the seeded notebook, known to the server and to this context. */
  async function addOtherNote(account: any, collection: any, item: any) {
    const other = await account.getCollectionManager().getItemManager(collection).create({ name: OTHER_TITLE, mtime: 1 }, 'OTHER BODY 849')
    other.encryptedItem.__markSaved()
    server.seed(collection, [item, other])
    const { itemCache, itemTypeMap, itemCollectionMap } = useEtebaseStore.getState()
    useEtebaseStore.setState({
      itemCache: new Map([...itemCache, [other.uid, other]]),
      itemTypeMap: new Map([...itemTypeMap, [other.uid, 'notes']]),
      itemCollectionMap: new Map([...itemCollectionMap, [other.uid, collection.uid]]),
    } as any)
    const at = new Date(500)
    useNoteStore.setState((state: any) => ({
      notes: [...state.notes, { id: other.uid, uid: other.uid, title: OTHER_TITLE, content: 'OTHER BODY 849', notebookId: collection.uid, created_at: at, updated_at: at, revision: other.etag }],
    }))
  }

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

  it('#744 adopts no refresh while its own save runs, and saves text typed back meanwhile on that save', async () => {
    const { account, collection, item } = await openSavedNote()
    // The server holds identical text at R1, so the R0 save rebinds through a fresh read.
    const peerItem = await peerWrites(account, collection, item, BASE_BODY)
    const rebindRead = server.holdNext(isItemGet(item.uid))
    fireEvent.change(titleBox(), { target: { value: 'Late own title 744' } })
    hideTab()
    await rebindRead.arrived
    // While that save waits, the editor turns clean and the refresh carries the server's R1
    // text over this context's optimistic record. R1 is older than the save, which lands on it.
    fireEvent.change(titleBox(), { target: { value: BASE_TITLE } })
    const refreshed = refreshFromServer(item.uid, peerItem, { title: BASE_TITLE, content: BASE_BODY })
    rebindRead.release(false)
    await settle()
    const late = await account.getCollectionManager().getItemManager(collection).fetch(item.uid)
    expect([late.getMeta().name, titleBox().value, saveStatus().textContent]).toEqual(['Late own title 744', BASE_TITLE, 'Unsaved changes'])
    // The late save's accepted record replaces only its own optimistic one, so the refresh stays.
    expect(storedNote(item.uid)).toBe(refreshed)
    const before = server.transactions.length

    hideTab()
    await settle()

    // 744 wired boundary
    expect(server.transactions.slice(before).map((sent) => sent.items[0].etag)).toEqual([late.etag])

    expect(await serverTitle(account, collection, item.uid)).toBe(BASE_TITLE)
    expect([titleBox().value, saveStatus().textContent]).toEqual([BASE_TITLE, 'Saved'])
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

  it('#849 keeps the note read-only while its move waits on the source delete, then opens the copy', async () => {
    const { account, collection } = await openSavedNote()
    const target = await addNotebook(account)
    const before = server.transactions.length
    // A clean note saves nothing first, so the first source transaction is the move's delete.
    const sourceDelete = server.holdNext(isSourceTransaction(collection))

    fireEvent.change(notebookPicker(), { target: { value: target.uid } })
    await sourceDelete.arrived
    expect([titleBox().readOnly, bodyBox().readOnly, notebookPicker().disabled]).toEqual([true, true, true])

    sourceDelete.release(false)
    await settle()
    const moved = movedCopy(target)
    expect([notebookPicker().value, titleBox().readOnly, bodyBox().readOnly, saveStatus().textContent]).toEqual([target.uid, false, false, ''])
    expect(ui().getAllByRole('button', { name: new RegExp(BASE_TITLE) })).toHaveLength(1)
    expect(server.transactions.length - before).toBe(1)
    expect(await serverText(account, target, moved!.id)).toBe(BASE_BODY)
  })

  it('#849 keeps a note opened again during its own move read-only, then opens the copy', async () => {
    const { account, collection, item } = await seedSavedNote()
    await addOtherNote(account, collection, item)
    renderNotesPage()
    fireEvent.click(ui().getByRole('button', { name: new RegExp(BASE_TITLE) }))
    await settle()
    const target = await addNotebook(account)
    const sourceDelete = server.holdNext(isSourceTransaction(collection))

    fireEvent.change(notebookPicker(), { target: { value: target.uid } })
    await sourceDelete.arrived
    fireEvent.click(ui().getByRole('button', { name: new RegExp(OTHER_TITLE) }))
    await settle()
    fireEvent.click(ui().getByRole('button', { name: new RegExp(BASE_TITLE) }))
    await settle()
    expect(titleBox().value).toBe(BASE_TITLE)
    expect([titleBox().readOnly, bodyBox().readOnly, notebookPicker().disabled]).toEqual([true, true, true])

    sourceDelete.release(false)
    await settle()
    expect([notebookPicker().value, titleBox().readOnly, bodyBox().readOnly, saveStatus().textContent]).toEqual([target.uid, false, false, ''])
    expect(ui().getAllByRole('button', { name: new RegExp(BASE_TITLE) })).toHaveLength(1)
    expect(await serverText(account, target, movedCopy(target)!.id)).toBe(BASE_BODY)
  })

  describe('#1113 D1 refused text, Save as a copy and the newer version', () => {
    // While a save runs, the row shows that save's optimistic title.
    const baseRow = () => ui().getByRole('button', { name: new RegExp(`^(${BASE_TITLE}|${DRAFT_TITLE})(?! [(]conflicted copy[)])`) })
    const otherRow = () => ui().getByRole('button', { name: new RegExp(OTHER_TITLE) })
    const otherNote = () => useNoteStore.getState().notes.find((note: any) => note.title === OTHER_TITLE)

    function beforeUnloadPrevented(): boolean {
      const event = new harness.window.Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }

    /** The note open with a draft typed on R0 that the server refused after a peer wrote A. */
    async function refusedDraft() {
      const { account, collection, item } = await seedSavedNote()
      await addOtherNote(account, collection, item)
      renderNotesPage()
      fireEvent.click(baseRow())
      await settle()
      fireEvent.change(titleBox(), { target: { value: DRAFT_TITLE } })
      const peerItem = await peerWritesA(account, collection, item)
      hideTab()
      await settle()
      expect(saveStatus()).toHaveTextContent('Not saved')
      return { account, collection, item, peerItem }
    }

    it('shows the refused text again when the note is opened after switching notes', async () => {
      const { account, collection, item } = await refusedDraft()
      fireEvent.click(otherRow())
      await settle()
      expect(titleBox().value).toBe(OTHER_TITLE)

      fireEvent.click(baseRow())
      await settle()

      expect([titleBox().value, bodyBox().value]).toEqual([DRAFT_TITLE, BASE_BODY])
      expect(saveStatus()).toHaveTextContent('Not saved')
      expect(await serverText(account, collection, item.uid)).toBe(PEER_BODY)
    })

    it('keeps a note read-only while its closing save runs, then shows the refused text', async () => {
      await refusedDraft()
      const closing = server.holdNext(isTransaction)
      fireEvent.click(otherRow())
      await closing.arrived
      fireEvent.click(baseRow())
      await settle()
      expect(ui().queryByRole('textbox', { name: 'Note title' })).toBeNull()
      expect(saveStatus()).toHaveTextContent('Saving your last changes to this note…')
      expect(document.querySelector('[aria-busy="true"]')?.getAttribute('translate')).toBe('no')

      closing.release(false)
      await settle()

      expect([titleBox().value, bodyBox().value, titleBox().readOnly]).toEqual([DRAFT_TITLE, BASE_BODY, false])
      expect(saveStatus()).toHaveTextContent('Not saved')
    })

    it('keeps a note with refused text listed when the server no longer lists it', async () => {
      await refusedDraft()
      fireEvent.click(otherRow())
      await settle()

      act(() => useNoteStore.getState().syncFromRemote([otherNote()]))
      await settle()

      expect(ui().getAllByRole('button', { name: new RegExp(BASE_TITLE) })).toHaveLength(1)
      fireEvent.click(baseRow())
      await settle()
      expect(titleBox().value).toBe(DRAFT_TITLE)
    })

    it('asks before the tab closes while refused text is only in this page, and not once the text is back to the saved one', async () => {
      const { account, collection, item } = await seedSavedNote()
      await addOtherNote(account, collection, item)
      // Other custody of the note: its refused text cannot get a record of its own.
      expect(await opaqueCustody(collection, item)).toBe(true)
      renderNotesPage()
      fireEvent.click(baseRow())
      await settle()
      fireEvent.change(titleBox(), { target: { value: DRAFT_TITLE } })
      hideTab()
      await settle()
      expect(saveStatus()).toHaveTextContent('Not saved')
      expect(beforeUnloadPrevented()).toBe(true)
      fireEvent.click(otherRow())
      await settle()
      expect(beforeUnloadPrevented()).toBe(true)
      fireEvent.click(baseRow())
      await settle()

      fireEvent.change(titleBox(), { target: { value: BASE_TITLE } })

      expect(beforeUnloadPrevented()).toBe(false)
    })

    it('does not ask before the tab closes once refused text is stored in its sealed record', async () => {
      const { item } = await refusedDraft()

      const records = await getAll(queueGuard())
      expect(records.map((record) => [record.itemUid, record.held])).toEqual([[item.uid, 'base-changed']])
      expect(beforeUnloadPrevented()).toBe(false)
    })

    it('asks again before the tab closes once text is typed after the stored refusal', async () => {
      await refusedDraft()
      expect(beforeUnloadPrevented()).toBe(false)

      fireEvent.change(bodyBox(), { target: { value: `${BASE_BODY} typed after` } })

      expect(beforeUnloadPrevented()).toBe(true)
    })

    it('opens kept text as an editable note when Strict Mode replays the editor effects', async () => {
      const { item } = await refusedDraft()
      fireEvent.click(otherRow())
      await settle()
      mounted.pop()!.unmount()
      await settle()
      const before = server.transactions.length

      renderNotesPage({ strict: true })
      fireEvent.click(baseRow())
      await settle()

      expect([titleBox().value, titleBox().readOnly]).toEqual([DRAFT_TITLE, false])
      expect(useNoteStore.getState().closingNoteIds).not.toContain(item.uid)
      // The replayed unmount flushes once, as any unmount does; it never starts a closing loop.
      expect(server.transactions.length - before).toBeLessThanOrEqual(1)
    })

    it("deletes the kept text's record once the text is saved", async () => {
      const { account, collection, peerItem } = await refusedDraft()
      expect(await getAll(queueGuard())).toHaveLength(1)
      // The peer puts the body back, so the server again matches the base the draft was typed on.
      await peerWrites(account, collection, peerItem, BASE_BODY)

      hideTab()
      await settle()

      expect(saveStatus()).toHaveTextContent('Saved')
      expect(await getAll(queueGuard())).toEqual([])
      expect(beforeUnloadPrevented()).toBe(false)
    })

    /** A reload of the page: its memory is gone; the account, its queue and its key stay. */
    async function reloadPage() {
      while (mounted.length > 0) mounted.pop()!.unmount()
      await settle()
      resetNoteLifecycle()
      renderNotesPage()
      await settle()
    }

    it('reopens refused text after a reload, with the reason and Save as a copy', async () => {
      const { account, collection, item } = await refusedDraft()

      await reloadPage()
      fireEvent.click(baseRow())
      await settle()

      expect([titleBox().value, bodyBox().value, titleBox().readOnly]).toEqual([DRAFT_TITLE, BASE_BODY, false])
      expect(saveStatus()).toHaveTextContent('Not saved')
      expect(ui().getByText(/^This browser could not confirm that the note is unchanged/)).toBeTruthy()
      fireEvent.click(ui().getByRole('button', { name: 'Save as a copy' }))
      await settle()

      expect(titleBox().value).toBe(`${DRAFT_TITLE} (conflicted copy)`)
      const response = await account.getCollectionManager().getItemManager(collection).list()
      expect(response.data.filter((candidate: any) => candidate.getMeta().name === `${DRAFT_TITLE} (conflicted copy)`)).toHaveLength(1)
      expect(await serverText(account, collection, item.uid)).toBe(PEER_BODY)
      expect(await getAll(queueGuard())).toEqual([])
    })

    it('reopens text whose save failed with an error after a reload, and saves it', async () => {
      const { account, collection, item } = await seedSavedNote()
      await addOtherNote(account, collection, item)
      // Every write fails until the page has reloaded, as the closing editor saves again.
      let failing = true
      EtebaseRequest.default = async (url: string, options: any) => {
        if (failing && isTransaction(...requestOf(url, options))) return respond(500, { detail: 'Server error' })
        return server.handle(url, options)
      }
      renderNotesPage()
      fireEvent.click(baseRow())
      await settle()
      fireEvent.change(titleBox(), { target: { value: DRAFT_TITLE } })
      hideTab()
      await settle()
      expect(saveStatus()).toHaveTextContent('Not saved')
      expect((await getAll(queueGuard())).map((record) => record.held)).toEqual(['retry-exhausted'])

      await reloadPage()
      expect(await serverTitle(account, collection, item.uid)).toBe(BASE_TITLE)
      failing = false
      fireEvent.click(baseRow())
      await settle()
      // Text whose save failed saves again once its editor opens, as before a reload.
      expect([titleBox().value, saveStatus().textContent]).toEqual([DRAFT_TITLE, 'Unsaved changes'])
      hideTab()
      await settle()

      expect(saveStatus()).toHaveTextContent('Saved')
      expect(await serverTitle(account, collection, item.uid)).toBe(DRAFT_TITLE)
      expect(await getAll(queueGuard())).toEqual([])
    })

    it('keeps reopened text unsaved even when it is empty, so the newer version is not adopted over it', async () => {
      const { account, collection, item } = await seedSavedNote()
      await addOtherNote(account, collection, item)
      renderNotesPage()
      fireEvent.click(baseRow())
      await settle()
      fireEvent.change(titleBox(), { target: { value: '' } })
      fireEvent.change(bodyBox(), { target: { value: '' } })
      await peerWritesA(account, collection, item)
      hideTab()
      await settle()
      expect(saveStatus()).toHaveTextContent('Not saved')

      await reloadPage()
      fireEvent.click(ui().getByRole('button', { name: new RegExp(BASE_TITLE) }))
      await settle()

      expect([titleBox().value, bodyBox().value]).toEqual(['', ''])
      expect(saveStatus()).toHaveTextContent('Not saved')
      expect(await getAll(queueGuard())).toHaveLength(1)
    })

    it('deletes the reopened text\'s record when the text is typed back to the saved text in the same editor', async () => {
      const { item } = await refusedDraft()
      expect(await getAll(queueGuard())).toHaveLength(1)

      fireEvent.change(titleBox(), { target: { value: BASE_TITLE } })
      await settle()

      expect(await getAll(queueGuard())).toEqual([])
      expect(storedNote(item.uid).title).toBe(BASE_TITLE)
    })

    it('drops kept text and the leave prompt on the account reset', async () => {
      await refusedDraft()
      fireEvent.click(otherRow())
      await settle()

      resetNoteLifecycle()

      expect(beforeUnloadPrevented()).toBe(false)
      fireEvent.click(baseRow())
      await settle()
      expect(titleBox().value).toBe(BASE_TITLE)
    })

    const COPY_TITLE = `${DRAFT_TITLE} (conflicted copy)`
    const copyButton = () => ui().getByRole('button', { name: /^(Save as a copy|Saving a copy…)$/ })
    const newerButton = () => ui().getByRole('button', { name: /^(Show|Hide) newer version$/ })
    const newerPanel = () => ui().queryByRole('region', { name: 'Newer version, read-only' })
    const storedCopies = () => useNoteStore.getState().notes.filter((note: any) => note.title === COPY_TITLE)

    /** Every live item on the server with this title. */
    async function serverCopies(account: any, collection: any, title = COPY_TITLE): Promise<any[]> {
      const response = await account.getCollectionManager().getItemManager(collection).list()
      return response.data.filter((candidate: any) => !candidate.isDeleted && candidate.getMeta().name === title)
    }

    /** A request's method and path as the reference server matches them. */
    const requestOf = (url: string, options: any): [string, string] => [
      String(options?.method ?? 'get').toLowerCase(),
      new URL(url).pathname.split('/').filter(Boolean).map(decodeURIComponent).join('/'),
    ]

    /** The server stores the next transaction, then its response is lost on the way back. */
    function loseNextTransactionResponse() {
      let armed = true
      EtebaseRequest.default = async (url: string, options: any) => {
        const response = await server.handle(url, options)
        if (armed && isTransaction(...requestOf(url, options))) {
          armed = false
          throw new TypeError('Network request failed')
        }
        return response
      }
    }

    it('offers Save as a copy with the reason, and makes one conflicted copy in the notebook on a double click', async () => {
      const { account, collection, item } = await refusedDraft()
      expect(ui().getByText(/^This note changed somewhere else after you started editing/)).toBeTruthy()
      const before = server.transactions.length

      const button = copyButton()
      fireEvent.click(button)
      fireEvent.click(button)
      await settle()

      expect(server.transactions.length - before).toBe(1)
      expect(storedCopies()).toHaveLength(1)
      const [copy] = await serverCopies(account, collection)
      expect(copy).toBeDefined()
      expect(new TextDecoder().decode(await copy.getContent())).toBe(BASE_BODY)
      // Fresh metadata, as Android's conflicted copy: the name and the time only.
      expect(Object.keys(copy.getMeta()).sort()).toEqual(['mtime', 'name'])
      expect(storedCopies()[0].notebookId).toBe(collection.uid)
      // The copy opens with the text; the other version stays as it was.
      expect([titleBox().value, bodyBox().value]).toEqual([COPY_TITLE, BASE_BODY])
      expect(saveStatus()).toHaveTextContent('Saved as a copy')
      expect(await serverText(account, collection, item.uid)).toBe(PEER_BODY)
      expect(beforeUnloadPrevented()).toBe(false)
    })

    it('keeps the title and body read-only while the copy is being made', async () => {
      await refusedDraft()
      const uploading = server.holdNext(isTransaction)
      fireEvent.click(copyButton())
      await uploading.arrived

      expect([titleBox().readOnly, bodyBox().readOnly, copyButton().textContent]).toEqual([true, true, 'Saving a copy…'])
      expect(beforeUnloadPrevented()).toBe(true)

      uploading.release(false)
      await settle()
      expect(titleBox().value).toBe(COPY_TITLE)
    })

    it('makes one copy when the first upload reached the server but its response was lost', async () => {
      const { account, collection } = await refusedDraft()
      loseNextTransactionResponse()
      fireEvent.click(copyButton())
      await settle()
      expect(ui().getByText(/^Not copied: the server did not confirm the copy/)).toBeTruthy()
      expect([titleBox().value, titleBox().readOnly]).toEqual([DRAFT_TITLE, false])
      expect(await serverCopies(account, collection)).toHaveLength(1)

      fireEvent.click(copyButton())
      await settle()

      expect(await serverCopies(account, collection)).toHaveLength(1)
      expect(storedCopies()).toHaveLength(1)
      expect([titleBox().value, bodyBox().value]).toEqual([COPY_TITLE, BASE_BODY])
    })

    it('puts typing after an unconfirmed copy onto that one copy', async () => {
      const { account, collection } = await refusedDraft()
      loseNextTransactionResponse()
      fireEvent.click(copyButton())
      await settle()
      fireEvent.change(bodyBox(), { target: { value: 'TYPED AFTER LOST COPY 1113' } })

      fireEvent.click(copyButton())
      await settle()
      expect([titleBox().value, bodyBox().value]).toEqual([COPY_TITLE, 'TYPED AFTER LOST COPY 1113'])
      hideTab()
      await settle()

      const copies = await serverCopies(account, collection)
      expect(copies).toHaveLength(1)
      expect(new TextDecoder().decode(await copies[0].getContent())).toBe('TYPED AFTER LOST COPY 1113')
      expect(saveStatus()).toHaveTextContent('Saved')
    })

    it('confirms a copy that landed and changed elsewhere without overwriting it', async () => {
      const { account, collection } = await refusedDraft()
      loseNextTransactionResponse()
      fireEvent.click(copyButton())
      await settle()
      const [landed] = await serverCopies(account, collection)
      await peerWrites(account, collection, landed, 'PEER EDIT OF THE COPY 1113')

      fireEvent.click(copyButton())
      await settle()

      const copies = await serverCopies(account, collection)
      expect(copies).toHaveLength(1)
      expect(new TextDecoder().decode(await copies[0].getContent())).toBe('PEER EDIT OF THE COPY 1113')
      expect([titleBox().value, bodyBox().value]).toEqual([COPY_TITLE, 'PEER EDIT OF THE COPY 1113'])
    })

    it('says when the copy was deleted elsewhere before it was confirmed, and makes a new one next time', async () => {
      const { account, collection } = await refusedDraft()
      loseNextTransactionResponse()
      fireEvent.click(copyButton())
      await settle()
      const [landed] = await serverCopies(account, collection)
      const tombstone = landed._clone()
      tombstone.delete()
      await account.getCollectionManager().getItemManager(collection).transaction([tombstone])

      fireEvent.click(copyButton())
      await settle()
      expect(ui().getByText(/^Not copied: the copy was deleted somewhere else/)).toBeTruthy()
      expect(titleBox().value).toBe(DRAFT_TITLE)

      fireEvent.click(copyButton())
      await settle()
      const copies = await serverCopies(account, collection)
      expect(copies).toHaveLength(1)
      expect(copies[0].uid).not.toBe(landed.uid)
      expect(titleBox().value).toBe(COPY_TITLE)
    })

    it('says a copy needs a connection while offline, sends nothing and keeps the text', async () => {
      await refusedDraft()
      const before = server.transactions.length
      Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, get: () => false })
      try {
        fireEvent.click(copyButton())
        await settle()
      } finally {
        Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, get: () => true })
      }

      expect(ui().getByText('Not copied: you are offline, and a copy needs a connection.')).toBeTruthy()
      expect([titleBox().value, titleBox().readOnly]).toEqual([DRAFT_TITLE, false])
      expect(server.transactions.length).toBe(before)
    })

    it('keeps a failed copy and its reason when the editor closes and opens again', async () => {
      const { account, collection } = await refusedDraft()
      loseNextTransactionResponse()
      fireEvent.click(copyButton())
      await settle()
      fireEvent.click(otherRow())
      await settle()

      fireEvent.click(baseRow())
      await settle()
      expect(titleBox().value).toBe(DRAFT_TITLE)
      expect(ui().getByText(/^Not copied: the server did not confirm the copy/)).toBeTruthy()
      fireEvent.click(copyButton())
      await settle()

      expect(await serverCopies(account, collection)).toHaveLength(1)
      expect(titleBox().value).toBe(COPY_TITLE)
    })

    it('finishes a copy whose editor closed meanwhile, and keeps the text when it fails', async () => {
      const { account, collection, item } = await refusedDraft()
      const sourceSaves = () => server.transactions.filter((sent) => sent.items.some((entry: any) => entry.uid === item.uid)).length
      const savesBefore = sourceSaves()
      const uploading = server.holdNext(isTransaction)
      fireEvent.click(copyButton())
      await uploading.arrived
      fireEvent.click(otherRow())
      await settle()
      expect(titleBox().value).toBe(OTHER_TITLE)
      // The copy owns the text: closing the editor sends no save of the source.
      expect(sourceSaves()).toBe(savesBefore)

      // The request fails before the server handles it: no copy, and the text is kept.
      uploading.release(true)
      await settle()
      expect(await serverCopies(account, collection)).toHaveLength(0)
      expect(titleBox().value).toBe(OTHER_TITLE)
      fireEvent.click(baseRow())
      await settle()
      expect(titleBox().value).toBe(DRAFT_TITLE)
      expect(ui().getByText(/^Not copied: the server did not confirm the copy/)).toBeTruthy()

      const second = server.holdNext(isTransaction)
      fireEvent.click(copyButton())
      await second.arrived
      fireEvent.click(otherRow())
      await settle()
      second.release(false)
      await settle()
      // Done with the editor closed: the copy is listed, the selection stays, nothing is held.
      expect(titleBox().value).toBe(OTHER_TITLE)
      expect(await serverCopies(account, collection)).toHaveLength(1)
      expect(storedCopies()).toHaveLength(1)
      expect(beforeUnloadPrevented()).toBe(false)
      fireEvent.click(baseRow())
      await settle()
      expect(titleBox().value).toBe(BASE_TITLE)
      expect(ui().queryByRole('button', { name: 'Save as a copy' })).toBeNull()
    })

    it('makes a new copy for a later refusal once the text was saved, and leaves the earlier copy as it was', async () => {
      const { account, collection } = await refusedDraft()
      loseNextTransactionResponse()
      fireEvent.click(copyButton())
      await settle()
      expect(await serverCopies(account, collection)).toHaveLength(1)
      // Back to the saved text: nothing is left to copy, and the attempt goes with it.
      fireEvent.change(titleBox(), { target: { value: BASE_TITLE } })
      fireEvent.change(titleBox(), { target: { value: 'SECOND DRAFT 1113' } })
      hideTab()
      await settle()
      expect(saveStatus()).toHaveTextContent('Not saved')

      fireEvent.click(copyButton())
      await settle()

      const [earlier] = await serverCopies(account, collection)
      expect(new TextDecoder().decode(await earlier.getContent())).toBe(BASE_BODY)
      expect(await serverCopies(account, collection, 'SECOND DRAFT 1113 (conflicted copy)')).toHaveLength(1)
      expect(titleBox().value).toBe('SECOND DRAFT 1113 (conflicted copy)')
    })

    it('sends only the current text when it changed after a copy that never reached the server', async () => {
      const { account, collection } = await refusedDraft()
      const first = server.holdNext(isTransaction)
      fireEvent.click(copyButton())
      await first.arrived
      first.release(true)
      await settle()
      expect(ui().getByText(/^Not copied: the server did not confirm the copy/)).toBeTruthy()
      fireEvent.change(bodyBox(), { target: { value: 'CURRENT TEXT 1113' } })

      fireEvent.click(copyButton())
      await settle()

      const copies = await serverCopies(account, collection)
      expect(copies).toHaveLength(1)
      expect(new TextDecoder().decode(await copies[0].getContent())).toBe('CURRENT TEXT 1113')
      // One upload reached the server for the copy: the current text, never the earlier one.
      expect(server.transactions.filter((sent) => sent.items.some((entry: any) => entry.uid === copies[0].uid))).toHaveLength(1)
    })

    it('offers no copy while a save of the note is still running', async () => {
      await refusedDraft()
      const saving = server.holdNext(isTransaction)
      fireEvent.change(bodyBox(), { target: { value: 'MORE TYPING 1113' } })
      hideTab()
      await saving.arrived
      expect(copyButton()).toBeDisabled()
      fireEvent.click(copyButton())

      saving.release(false)
      await settle()

      expect(storedCopies()).toHaveLength(0)
      expect(saveStatus()).toHaveTextContent('Not saved')
      expect(copyButton()).toBeEnabled()
    })

    it('marks no closing save for the next account when the account resets as the editor closes', async () => {
      const { item } = await refusedDraft()
      const saving = server.holdNext(isTransaction)
      fireEvent.change(bodyBox(), { target: { value: 'LAST TYPING 1113' } })
      hideTab()
      await saving.arrived

      mounted.pop()!.unmount()
      bumpAccountEpoch()
      resetNoteLifecycle()
      await act(async () => {
        await Promise.resolve()
      })

      expect(useNoteStore.getState().closingNoteIds).not.toContain(item.uid)
      expect(beforeUnloadPrevented()).toBe(false)
      saving.release(true)
      await settle()
    })

    it('says when the server still has the version the text started from', async () => {
      const { item } = await openSavedNote()
      expect(ui().getByTestId('note-notice')).toBeEmptyDOMElement()
      // An owed proof skips the first write; a missing fresh copy then proves nothing.
      markNoteObligation(item.uid)
      const transport = EtebaseRequest.default
      EtebaseRequest.default = async (url: string, options: any) => (
        isItemGet(item.uid)(...requestOf(url, options)) ? respond(404, { detail: 'Not found.' }) : transport(url, options)
      )
      fireEvent.change(titleBox(), { target: { value: DRAFT_TITLE } })
      hideTab()
      await settle()
      EtebaseRequest.default = transport
      expect(within(ui().getByTestId('note-notice')).getByText(/^This browser could not confirm that the note is unchanged/)).toBeTruthy()

      fireEvent.click(newerButton())
      await settle()

      expect(within(newerPanel()!).getByText('The server still has the version you started from.')).toBeTruthy()
      expect(titleBox().value).toBe(DRAFT_TITLE)
    })

    it('shows the newer version read-only and the row follows it with its SDK item, without touching the draft', async () => {
      const { item, peerItem } = await refusedDraft()
      expect(baseRow().textContent).not.toContain(PEER_BODY)

      fireEvent.click(newerButton())
      await settle()

      const panel = newerPanel()
      expect(panel).not.toBeNull()
      expect(panel!.getAttribute('translate')).toBe('no')
      expect(within(panel!).getByText(PEER_BODY)).toBeTruthy()
      expect(within(panel!).getByText(BASE_TITLE)).toBeTruthy()
      expect([titleBox().value, bodyBox().value]).toEqual([DRAFT_TITLE, BASE_BODY])
      // The list row shows the version read, and the item cache holds that same revision's
      // SDK item, as after a sync of this one note; the editor adopts none of it.
      expect(storedNote(item.uid)).toMatchObject({ title: BASE_TITLE, content: PEER_BODY, revision: peerItem.etag })
      expect(useEtebaseStore.getState().itemCache.get(item.uid).etag).toBe(peerItem.etag)
      expect(baseRow().textContent).toContain(PEER_BODY)

      fireEvent.click(newerButton())
      expect(newerPanel()).toBeNull()
    })

    it('does not move the row when the note changed while the newer version was read', async () => {
      const { item } = await refusedDraft()
      const transport = EtebaseRequest.default
      let replaced: any = null
      EtebaseRequest.default = async (url: string, options: any) => {
        const response = await transport(url, options)
        if (isItemGet(item.uid)(...requestOf(url, options)) && !replaced) {
          // A refresh lands between the read and its result.
          replaced = { ...storedNote(item.uid) }
          useNoteStore.setState((state: any) => ({ notes: state.notes.map((note: any) => (note.id === item.uid ? replaced : note)) }))
        }
        return response
      }
      fireEvent.click(newerButton())
      await settle()
      EtebaseRequest.default = transport

      expect(within(newerPanel()!).getByText(PEER_BODY)).toBeTruthy()
      expect(storedNote(item.uid)).toBe(replaced)
      expect(storedNote(item.uid).content).toBe(BASE_BODY)
      expect(useEtebaseStore.getState().itemCache.get(item.uid).etag).toBe(item.etag)
    })

    it('does not move the row when the item cache changed while the newer version was read', async () => {
      const { item } = await refusedDraft()
      const shown = storedNote(item.uid)
      const transport = EtebaseRequest.default
      let swapped: any = null
      EtebaseRequest.default = async (url: string, options: any) => {
        const response = await transport(url, options)
        if (isItemGet(item.uid)(...requestOf(url, options)) && !swapped) {
          // A sync replaces the cached SDK item between the read and its result.
          swapped = useEtebaseStore.getState().itemCache.get(item.uid)._clone()
          useEtebaseStore.setState({ itemCache: new Map([...useEtebaseStore.getState().itemCache, [item.uid, swapped]]) })
        }
        return response
      }
      fireEvent.click(newerButton())
      await settle()
      EtebaseRequest.default = transport

      expect(within(newerPanel()!).getByText(PEER_BODY)).toBeTruthy()
      expect(storedNote(item.uid)).toBe(shown)
      expect(useEtebaseStore.getState().itemCache.get(item.uid)).toBe(swapped)
    })

    it('keeps the metadata another device wrote when the draft, typed back onto the newer version, saves again', async () => {
      const { account, collection, item } = await seedSavedNote()
      await addOtherNote(account, collection, item)
      renderNotesPage()
      fireEvent.click(baseRow())
      await settle()
      fireEvent.change(titleBox(), { target: { value: DRAFT_TITLE } })
      const peerItem = item._clone()
      peerItem.setMeta({ ...peerItem.getMeta(), color: '#123456' })
      await peerItem.setContent(PEER_BODY)
      await account.getCollectionManager().getItemManager(collection).transaction([peerItem])
      hideTab()
      await settle()
      expect(saveStatus()).toHaveTextContent('Not saved')
      fireEvent.click(newerButton())
      await settle()
      fireEvent.change(titleBox(), { target: { value: BASE_TITLE } })
      await settle()
      expect(bodyBox().value).toBe(PEER_BODY)

      fireEvent.change(titleBox(), { target: { value: 'After the newer version 1113' } })
      hideTab()
      await settle()

      expect(saveStatus()).toHaveTextContent('Saved')
      const fresh = await account.getCollectionManager().getItemManager(collection).fetch(item.uid)
      expect(fresh.getMeta()).toMatchObject({ name: 'After the newer version 1113', color: '#123456' })
      expect(await serverText(account, collection, item.uid)).toBe(PEER_BODY)
    })

    it('leaves the row of a running save alone, so it ends paired with its cached item', async () => {
      const { item } = await openSavedNote()
      const write = server.holdNext(isTransaction)
      fireEvent.change(titleBox(), { target: { value: 'Saved during the read 1113' } })
      hideTab()
      await write.arrived
      // The row is the running save's optimistic record; a newer-version read lands meanwhile.
      expect(storedNote(item.uid).revision).toBeNull()
      const read = await readNewerNoteVersion(item.uid)
      expect(read.kind).toBe('note')

      write.release(false)
      await settle()

      const row = storedNote(item.uid)
      expect(row.title).toBe('Saved during the read 1113')
      expect(row.revision).not.toBeNull()
      expect(useEtebaseStore.getState().itemCache.get(item.uid).etag).toBe(row.revision)
    })

    it('takes a refreshed note into the editor once a refused save, run while the draft was typed back, ends', async () => {
      const { item, peerItem } = await refusedDraft()
      const write = server.holdNext(isTransaction)
      fireEvent.change(titleBox(), { target: { value: 'Second try 1113' } })
      hideTab()
      await write.arrived
      // A sync brings the server's own title and text over the running save's row.
      refreshFromServer(item.uid, peerItem, { title: BASE_TITLE, content: PEER_BODY })
      fireEvent.change(titleBox(), { target: { value: BASE_TITLE } })
      await settle()

      write.release(false)
      await settle()

      expect([titleBox().value, bodyBox().value]).toEqual([BASE_TITLE, PEER_BODY])
      expect(saveStatus()).not.toHaveTextContent('Not saved')
      expect(ui().queryByText(/This note changed somewhere else/)).toBeNull()
    })

    it('shows nothing unsaved or refused when a save refused after the draft was typed back ends', async () => {
      await refusedDraft()
      const write = server.holdNext(isTransaction)
      fireEvent.change(titleBox(), { target: { value: 'Third try 1113' } })
      hideTab()
      await write.arrived
      fireEvent.change(titleBox(), { target: { value: BASE_TITLE } })
      await settle()

      write.release(false)
      await settle()

      expect([titleBox().value, bodyBox().value]).toEqual([BASE_TITLE, BASE_BODY])
      expect(saveStatus()).not.toHaveTextContent('Not saved')
      expect(ui().queryByText(/This note changed somewhere else/)).toBeNull()
    })

    it('keeps text typed back to the saved version while a save runs, and once it is accepted', async () => {
      const { account, collection, item } = await openSavedNote()
      const write = server.holdNext(isTransaction)
      fireEvent.change(titleBox(), { target: { value: 'Typed then removed 1113' } })
      hideTab()
      await write.arrived
      // No wait after this change: its debounce must not run out while the write is held.
      fireEvent.change(titleBox(), { target: { value: BASE_TITLE } })

      write.release(false)
      await settle()
      // The save's accepted record is not adopted: the typed-back title is unsaved text on top of it.
      expect(await serverTitle(account, collection, item.uid)).toBe('Typed then removed 1113')
      expect([titleBox().value, saveStatus().textContent]).toEqual([BASE_TITLE, 'Unsaved changes'])
      hideTab()
      await settle()

      expect(await serverTitle(account, collection, item.uid)).toBe(BASE_TITLE)
      expect([titleBox().value, storedNote(item.uid)?.title, saveStatus().textContent]).toEqual([BASE_TITLE, BASE_TITLE, 'Saved'])
    })

    /** Saves a typed title, holds its write, and types the saved title back meanwhile. */
    async function typeBackDuringSave() {
      const opened = await openSavedNote()
      const write = server.holdNext(isTransaction)
      fireEvent.change(titleBox(), { target: { value: 'Typed then removed 1113' } })
      hideTab()
      await write.arrived
      fireEvent.change(titleBox(), { target: { value: BASE_TITLE } })
      expect([titleBox().value, server.transactions.length]).toEqual([BASE_TITLE, 0])
      return { ...opened, write }
    }

    it('saves text typed back to the saved version when a flush comes while a save runs', async () => {
      const { account, collection, item, write } = await typeBackDuringSave()
      // The debounce timer flushes the same way.
      hideTab()

      write.release(false)
      await settle()

      expect(await serverTitle(account, collection, item.uid)).toBe(BASE_TITLE)
      expect([titleBox().value, storedNote(item.uid)?.title, saveStatus().textContent]).toEqual([BASE_TITLE, BASE_TITLE, 'Saved'])
    })

    it('saves text typed back to the saved version when the editor closes while a save runs', async () => {
      const { account, collection, item, view, write } = await typeBackDuringSave()
      view.unmount()

      write.release(false)
      await settle()

      expect(await serverTitle(account, collection, item.uid)).toBe(BASE_TITLE)
      expect(storedNote(item.uid)?.title).toBe(BASE_TITLE)
    })

    it('takes a newer record that came while a repeated save ran, once that save is refused', async () => {
      const { account, collection, item } = await openSavedNote()
      const first = server.holdNext(isTransaction)
      fireEvent.change(titleBox(), { target: { value: DRAFT_TITLE } })
      hideTab()
      await first.arrived
      // The tab hides again while the first save runs, so the same text is queued again.
      hideTab()
      const second = server.holdNext(isTransaction)
      first.release(false)
      await second.arrived
      // Another device writes on top of the first save; sync brings that in while the repeat runs.
      const landed = await account.getCollectionManager().getItemManager(collection).fetch(item.uid)
      expect(landed.getMeta().name).toBe(DRAFT_TITLE)
      const peerItem = await peerWrites(account, collection, landed, PEER_BODY)
      refreshFromServer(item.uid, peerItem, { title: DRAFT_TITLE, content: PEER_BODY })

      second.release(false)
      await settle()
      expect(await serverText(account, collection, item.uid)).toBe(PEER_BODY)
      expect([titleBox().value, bodyBox().value]).toEqual([DRAFT_TITLE, PEER_BODY])
      fireEvent.change(titleBox(), { target: { value: 'After the peer 1113' } })
      hideTab()
      await settle()

      expect([await serverTitle(account, collection, item.uid), await serverText(account, collection, item.uid)]).toEqual(['After the peer 1113', PEER_BODY])
    })

    it('keeps its accepted save over a refresh read before that save landed', async () => {
      const { account, collection, item } = await openSavedNote()
      // The server holds identical text at R1, so the R0 save rebinds through a fresh read.
      const peerItem = await peerWrites(account, collection, item, BASE_BODY)
      const rebindRead = server.holdNext(isItemGet(item.uid))
      fireEvent.change(titleBox(), { target: { value: 'Late own title 1113' } })
      hideTab()
      await rebindRead.arrived
      // A sync that read R1 before the save landed brings it in while the save runs.
      refreshFromServer(item.uid, peerItem, { title: BASE_TITLE, content: BASE_BODY })

      rebindRead.release(false)
      await settle()

      // The store still holds the older R1, so taking it would turn the title back.
      expect([await serverTitle(account, collection, item.uid), storedNote(item.uid)?.title]).toEqual(['Late own title 1113', BASE_TITLE])
      expect([titleBox().value, saveStatus().textContent]).toEqual(['Late own title 1113', 'Saved'])
    })

    it('does not move the row for a read that ends after the draft was typed back to the saved text', async () => {
      const { item } = await refusedDraft()
      const read = server.holdNext(isItemGet(item.uid))
      fireEvent.click(newerButton())
      await read.arrived
      fireEvent.change(titleBox(), { target: { value: BASE_TITLE } })
      await settle()
      read.release(false)
      await settle()

      expect(newerPanel()).toBeNull()
      expect(storedNote(item.uid)).toMatchObject({ content: BASE_BODY })
      expect([titleBox().value, bodyBox().value]).toEqual([BASE_TITLE, BASE_BODY])
    })

    it('does not move the row for a newer-version read that ends after the account changed', async () => {
      const { item } = await refusedDraft()
      const shown = storedNote(item.uid)
      const cachedBefore = useEtebaseStore.getState().itemCache.get(item.uid)
      const read = server.holdNext(isItemGet(item.uid))
      fireEvent.click(newerButton())
      await read.arrived
      // Boundary test: the read's account guard, the epoch check and the epoch-tagged
      // unsaved-text check each stop this write; the row of the old account stays as it was.
      act(() => { bumpAccountEpoch() })
      read.release(false)
      await settle()

      expect(storedNote(item.uid)).toBe(shown)
      expect(storedNote(item.uid).content).toBe(BASE_BODY)
      expect(useEtebaseStore.getState().itemCache.get(item.uid)).toBe(cachedBefore)
    })

    it('adds no cached item for a note the item cache does not hold', async () => {
      const { item } = await refusedDraft()
      const shown = storedNote(item.uid)
      act(() => {
        const itemCache = new Map(useEtebaseStore.getState().itemCache)
        itemCache.delete(item.uid)
        useEtebaseStore.setState({ itemCache })
      })

      fireEvent.click(newerButton())
      await settle()

      expect(within(newerPanel()!).getByText(PEER_BODY)).toBeTruthy()
      expect(useEtebaseStore.getState().itemCache.has(item.uid)).toBe(false)
      expect(storedNote(item.uid)).toBe(shown)
    })

    it('closes the newer version and takes it into the editor once the draft is typed back to the saved text', async () => {
      const { account, collection, item } = await refusedDraft()
      fireEvent.click(newerButton())
      await settle()
      expect(newerPanel()).not.toBeNull()

      fireEvent.change(titleBox(), { target: { value: BASE_TITLE } })
      await settle()

      expect(newerPanel()).toBeNull()
      expect([titleBox().value, bodyBox().value]).toEqual([BASE_TITLE, PEER_BODY])
      expect(saveStatus()).not.toHaveTextContent('Not saved')
      expect(await serverText(account, collection, item.uid)).toBe(PEER_BODY)
    })

    it('closes the newer version once the note moves past the revision it shows', async () => {
      const { account, collection, item, peerItem } = await refusedDraft()
      fireEvent.click(newerButton())
      await settle()
      refreshFromServer(item.uid, peerItem, { content: PEER_BODY })
      await settle()
      expect(newerPanel()).not.toBeNull()

      const third = await peerWrites(account, collection, peerItem, 'THIRD BODY 1113')
      refreshFromServer(item.uid, third, { content: 'THIRD BODY 1113' })
      await settle()

      expect(newerPanel()).toBeNull()
      expect([titleBox().value, bodyBox().value]).toEqual([DRAFT_TITLE, BASE_BODY])
    })

    it('says the note was deleted elsewhere only for a tombstone, not for a missing copy', async () => {
      const { account, collection, item, peerItem } = await refusedDraft()
      const transport = EtebaseRequest.default
      EtebaseRequest.default = async (url: string, options: any) => (
        isItemGet(item.uid)(...requestOf(url, options))
          ? respond(404, { detail: 'Not found.' })
          : transport(url, options)
      )
      fireEvent.click(newerButton())
      await settle()
      expect(within(newerPanel()!).getByText('The newer version could not be loaded from the server.')).toBeTruthy()
      EtebaseRequest.default = transport
      fireEvent.click(newerButton())

      const tombstone = peerItem._clone()
      tombstone.delete()
      await account.getCollectionManager().getItemManager(collection).transaction([tombstone])
      fireEvent.click(newerButton())
      await settle()

      expect(within(newerPanel()!).getByText('This note was deleted somewhere else. Save your text as a copy to keep it.')).toBeTruthy()
      expect(titleBox().value).toBe(DRAFT_TITLE)
    })

    it('says when the newer version cannot be read, and the editor keeps working', async () => {
      const { account, collection, peerItem } = await refusedDraft()
      const other = peerItem._clone()
      await other.setMeta({ ...other.getMeta(), type: 'etebase.other' })
      await account.getCollectionManager().getItemManager(collection).transaction([other])

      fireEvent.click(newerButton())
      await settle()

      expect(within(newerPanel()!).getByText('The newer version could not be read in this browser.')).toBeTruthy()
      fireEvent.change(bodyBox(), { target: { value: 'STILL TYPING 1113' } })
      expect(bodyBox().value).toBe('STILL TYPING 1113')
    })
  })
})
