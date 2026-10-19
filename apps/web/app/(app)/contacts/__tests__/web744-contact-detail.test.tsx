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
// Only UI widgets outside the detail's save behavior are replaced; stores, core and SDK are real.
vi.mock('@/app/components/LabelEditor', () => ({
  LabelEditor: () => null,
  LabelChips: () => null,
}))
vi.mock('@/app/components/MobileCollectionSheet', () => ({
  MobileCollectionSheet: () => null,
}))

import ContactsPage from '../page'
import { _resetForTests as resetOfflineQueue } from '@/app/lib/offline-queue'
import { _resetForTests as resetDataCache } from '@/app/lib/data-cache'
import { bumpAccountEpoch } from '@/app/lib/account-epoch'
import { deserializeContact, serializeContact } from '@silentsuite/core'
import { useEtebaseStore } from '@/app/stores/use-etebase-store'
import * as contactStore from '@/app/stores/use-contact-store'
import { useContactStore } from '@/app/stores/use-contact-store'
import { useContactListStore } from '@/app/stores/use-contact-list-store'
import { useAuthStore } from '@/app/stores/use-auth-store'
import {
  EtebaseRequest,
  ReferenceServer,
  deleteDatabase,
  installContactAccount,
  makeSavedContact,
} from '@/app/stores/__tests__/web744-sdk-fixture'

vi.setConfig({ testTimeout: 20_000 })

const BASE_GIVEN = 'Base Person 744'
const OTHER_GIVEN = 'Other Person 744'
const PEER_GIVEN = 'Peer Person A 744'

const mounted: { unmount: () => void }[] = []

function ui() {
  return within(document.body)
}

function contactVcard(uid: string, given: string): string {
  const at = new Date(1000)
  return serializeContact({
    id: uid, uid, displayName: given, name: { prefix: '', given, family: '', suffix: '' },
    phones: [], emails: [], addresses: [], organization: '', title: '', notes: '', birthday: null,
    photoUrl: null, categories: [], favorite: false, created_at: at, updated_at: at,
  } as any)
}

function renderContactsPage() {
  const container = document.body.appendChild(document.createElement('div'))
  const root = harness.createRoot(container)
  act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ContactsPage />
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

/** Lets the real store chain, SDK crypto and IndexedDB work finish. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  })
}

function openContact(given: string) {
  fireEvent.click(ui().getAllByText(given)[0]!.closest('button')!)
}

describe('#744 the rendered contact detail saves only through its captured record base', () => {
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
  })

  afterEach(async () => {
    while (mounted.length > 0) mounted.pop()!.unmount()
    await settle()
    EtebaseRequest.default = originalRequest
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    useContactStore.setState({ contacts: [] } as any)
  })

  afterAll(() => {
    harness.restore()
  })

  async function seedContacts() {
    const { account, collection } = await makeSavedContact('')
    const manager = account.getCollectionManager().getItemManager(collection)
    const baseVcard = contactVcard('vcard-base-744', BASE_GIVEN)
    const otherVcard = contactVcard('vcard-other-744', OTHER_GIVEN)
    const item = await manager.create({ mtime: 1 }, baseVcard)
    item.encryptedItem.__markSaved()
    const other = await manager.create({ mtime: 1 }, otherVcard)
    other.encryptedItem.__markSaved()
    server.seed(collection, [item, other])
    installContactAccount(account, collection, item)
    useEtebaseStore.setState({
      itemCache: new Map([[item.uid, item], [other.uid, other]]),
      itemTypeMap: new Map([[item.uid, 'contacts'], [other.uid, 'contacts']]),
      itemCollectionMap: new Map([[item.uid, collection.uid], [other.uid, collection.uid]]),
    } as any)
    useContactListStore.setState({ lists: [{ id: collection.uid, name: 'Address book 744', color: '#fff', visible: true, accessLevel: 2 }], activeListId: 'all' } as any)
    useContactStore.setState({
      contacts: [
        { ...deserializeContact(baseVcard), id: item.uid, listId: collection.uid, revision: item.etag },
        { ...deserializeContact(otherVcard), id: other.uid, listId: collection.uid, revision: other.etag },
      ],
    } as any)
    return { account, collection, item, other }
  }

  it('#744 shows a refused edit as Not saved in the selected detail, and keeps it across a refresh', async () => {
    const { account, collection, item } = await seedContacts()
    renderContactsPage()
    openContact(BASE_GIVEN)
    await settle()
    // Another device writes A; this tab has not seen it.
    const peerItem = item._clone()
    await peerItem.setContent(contactVcard('vcard-base-744', PEER_GIVEN))
    await account.getCollectionManager().getItemManager(collection).transaction([peerItem])
    fireEvent.click(ui().getByRole('button', { name: 'Edit contact' }))
    const organization = ui().getByPlaceholderText('Organization')
    fireEvent.change(organization, { target: { value: 'Draft org 744' } })
    fireEvent.blur(organization)
    await settle()
    expect(deserializeContact((await (async () => {
      const fresh = await account.getCollectionManager().getItemManager(collection).fetch(item.uid)
      return new TextDecoder().decode(await fresh.getContent())
    })())).name.given).toBe(PEER_GIVEN)

    act(() => {
      useContactStore.getState().syncFromRemote([
        { ...deserializeContact(contactVcard('vcard-base-744', PEER_GIVEN)), id: item.uid, listId: collection.uid, revision: peerItem.etag },
      ] as any)
    })
    await settle()

    // 744 wired boundary
    expect(ui().queryByRole('status')?.textContent).toContain('Not saved')

    expect(ui().getByPlaceholderText('Organization')).toHaveValue('Draft org 744')
  })

  it('#744 keeps the selected drafted detail and its Not saved typing visible when the search no longer lists it', async () => {
    const { account, collection, item } = await seedContacts()
    renderContactsPage()
    openContact(BASE_GIVEN)
    await settle()
    // Another device writes A; this tab's save of the rename is refused.
    const peerItem = item._clone()
    await peerItem.setContent(contactVcard('vcard-base-744', PEER_GIVEN))
    await account.getCollectionManager().getItemManager(collection).transaction([peerItem])
    act(() => useContactStore.getState().setSearchQuery(BASE_GIVEN))
    fireEvent.click(ui().getByRole('button', { name: 'Edit contact' }))
    const given = ui().getByPlaceholderText('Given name')
    fireEvent.change(given, { target: { value: 'Renamed Draft 744' } })
    fireEvent.blur(given)
    await settle()
    const shown = [(ui().queryByPlaceholderText('Given name') as HTMLInputElement | null)?.value, ui().queryByRole('status')?.textContent?.includes('Not saved')]
    // The search is shared store state; later cases start without it.
    act(() => useContactStore.getState().setSearchQuery(''))

    // 744 wired boundary
    expect(shown).toEqual(['Renamed Draft 744', true])
  })

  it('#744 keeps typing begun while a delete was in flight in the same open detail, Not saved', async () => {
    await seedContacts()
    renderContactsPage()
    openContact(BASE_GIVEN)
    await settle()
    const isTransaction = (method: string, path: string) => method === 'post' && path.endsWith('item/transaction')
    fireEvent.click(ui().getByRole('button', { name: 'Edit contact' }))
    const deleting = server.holdNext(isTransaction)
    fireEvent.click(ui().getByRole('button', { name: 'Delete contact' }))
    fireEvent.click(within(ui().getByRole('dialog')).getByRole('button', { name: 'Delete contact' }))
    await deleting.arrived
    // New typing, saved on a real blur while the accepted delete is still on its way.
    const saving = server.holdNext(isTransaction)
    const given = ui().getByPlaceholderText('Given name')
    fireEvent.change(given, { target: { value: 'Late Draft 744' } })
    fireEvent.blur(given)
    await saving.arrived
    deleting.release(false)
    await settle()
    saving.release(false)
    await settle()
    const shown = [(ui().queryByPlaceholderText('Given name') as HTMLInputElement | null)?.value, ui().queryByRole('status')?.textContent?.includes('Not saved')]

    // 744 wired boundary
    expect(shown).toEqual(['Late Draft 744', true])
  })

  it('#744 closes the detail of a clean contact once its delete is accepted', async () => {
    await seedContacts()
    renderContactsPage()
    openContact(BASE_GIVEN)
    await settle()
    fireEvent.click(ui().getByRole('button', { name: 'Delete contact' }))
    fireEvent.click(within(ui().getByRole('dialog')).getByRole('button', { name: 'Delete contact' }))
    await settle()

    // 744 wired boundary
    expect(ui().queryByRole('heading', { name: BASE_GIVEN })).toBeNull()
  })

  it('#744 keeps unblurred typing through delete refresh, then blur refusal and another refresh', async () => {
    const { account, collection, item, other } = await seedContacts()
    renderContactsPage()
    openContact(BASE_GIVEN)
    await settle()
    const owner = contactStore.getContactOwner(item.uid)
    const displayRecord = useContactStore.getState().contacts.find((contact) => contact.id === item.uid)
    const manager = account.getCollectionManager().getItemManager(collection)
    const refresh = async () => {
      const response = await manager.list()
      const remote = await Promise.all(response.data.filter((record) => !record.isDeleted).map(async (record) => ({
        ...deserializeContact(new TextDecoder().decode(await record.getContent())),
        id: record.uid, listId: collection.uid, revision: record.etag,
      })))
      act(() => useContactStore.getState().syncFromRemote(remote))
      await settle()
    }
    const isTransaction = (method: string, path: string) => method === 'post' && path.endsWith('item/transaction')
    fireEvent.click(ui().getByRole('button', { name: 'Edit contact' }))
    const deleting = server.holdNext(isTransaction)
    fireEvent.click(ui().getByRole('button', { name: 'Delete contact' }))
    fireEvent.click(within(ui().getByRole('dialog')).getByRole('button', { name: 'Delete contact' }))
    await deleting.arrived
    const given = ui().getByPlaceholderText('Given name') as HTMLInputElement
    given.focus()
    fireEvent.change(given, { target: { value: 'Focused Draft 744' } })
    expect(contactStore.hasContactFieldDraft(item.uid)).toBe(true)
    deleting.release(false)
    await settle()
    expect((await manager.fetch(item.uid)).isDeleted).toBe(true)
    expect(ui().queryByPlaceholderText('Given name')).toBe(given)
    const sent = server.transactions.length

    await refresh()

    // 744 wired boundary: ordinary omission must not unmount the focused field.
    expect(ui().queryByPlaceholderText('Given name')).toBe(given)
    expect(document.activeElement).toBe(given)
    expect(given.value).toBe('Focused Draft 744')
    expect(contactStore.getContactOwner(item.uid)).toBe(owner)
    expect(useContactStore.getState().contacts.find((contact) => contact.id === item.uid)).toBe(displayRecord)
    expect(useContactStore.getState().contactSaveStates[item.uid]).toBeUndefined()
    expect(server.transactions.length).toBe(sent)
    expect(useContactStore.getState().contacts.filter((contact) => contact.id === other.uid)).toHaveLength(1)

    // The real DOM blur starts the ordinary save before the bubbling field witness clears.
    act(() => given.blur())
    expect(contactStore.hasContactFieldDraft(item.uid)).toBe(false)
    expect(useContactStore.getState().contactSaveStates[item.uid]).toBe('pending')
    act(() => useContactStore.getState().syncFromRemote([]))
    expect(ui().queryByPlaceholderText('Given name')).toBe(given)
    await settle()
    expect(useContactStore.getState().contactSaveStates[item.uid]).toBe('refused')
    expect(ui().queryByRole('status')?.textContent).toContain('Not saved')
    await refresh()
    expect(ui().queryByPlaceholderText('Given name')).toBe(given)
    expect(given.value).toBe('Focused Draft 744')
    expect(ui().queryByRole('status')?.textContent).toContain('Not saved')
    expect(contactStore.getContactOwner(item.uid)).toBe(owner)
    expect((await manager.fetch(item.uid)).isDeleted).toBe(true)
    expect(server.transactions.length).toBe(sent)
  })

  it('#744 characterizes clean omission and present remote updates without duplicate contacts', async () => {
    contactStore.resetContactLifecycle()
    const { item } = await seedContacts()
    const record = useContactStore.getState().contacts.find((contact) => contact.id === item.uid)!
    const remote = { ...record, organization: 'Remote organization 744' }
    act(() => useContactStore.getState().syncFromRemote([remote]))
    expect(useContactStore.getState().contacts).toEqual([remote])
    act(() => useContactStore.getState().syncFromRemote([]))
    expect(useContactStore.getState().contacts).toEqual([])
  })

  it('#744 characterizes clean departure and isolates an old field owner after account reset', async () => {
    const { item } = await seedContacts()
    const record = useContactStore.getState().contacts.find((contact) => contact.id === item.uid)!
    renderContactsPage()
    openContact(BASE_GIVEN)
    await settle()
    fireEvent.click(ui().getByRole('button', { name: 'Edit contact' }))
    const given = ui().getByPlaceholderText('Given name') as HTMLInputElement
    given.focus()
    fireEvent.change(given, { target: { value: 'Departing Draft 744' } })
    const departed = contactStore.getContactOwner(item.uid)!
    openContact(OTHER_GIVEN)
    await settle()
    expect(contactStore.getContactOwner(item.uid)).toBeUndefined()
    act(() => useContactStore.getState().syncFromRemote([]))
    expect(useContactStore.getState().contacts).toEqual([])

    act(() => useContactStore.getState().syncFromRemote([record]))
    openContact(BASE_GIVEN)
    await settle()
    fireEvent.click(ui().getByRole('button', { name: 'Edit contact' }))
    const reopened = contactStore.getContactOwner(item.uid)!
    expect(reopened).not.toBe(departed)
    fireEvent.change(ui().getByPlaceholderText('Given name'), { target: { value: 'Reset Draft 744' } })
    contactStore.setContactFieldDraft(item.uid, departed, false)
    expect(contactStore.hasContactFieldDraft(item.uid)).toBe(true)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    try {
      await act(async () => { await useAuthStore.getState().logout() })
    } finally {
      fetchSpy.mockRestore()
    }
    expect(contactStore.getContactOwner(item.uid)).toBeUndefined()
    contactStore.setContactFieldDraft(item.uid, reopened, true)
    act(() => useContactStore.getState().syncFromRemote([]))
    expect(contactStore.hasContactFieldDraft(item.uid)).toBe(false)
    expect(useContactStore.getState().contacts).toEqual([])
  })

  it('#744 keeps the detail open until the server confirms a delete, then leaves another selection alone', async () => {
    await seedContacts()
    renderContactsPage()
    openContact(BASE_GIVEN)
    await settle()
    const removal = server.holdNext((method, path) => method === 'post' && /item\/(batch|transaction)$/.test(path))
    fireEvent.click(ui().getByRole('button', { name: 'Delete contact' }))
    fireEvent.click(within(ui().getByRole('dialog')).getByRole('button', { name: 'Delete contact' }))
    await removal.arrived
    await settle()

    // 744 wired boundary
    expect(ui().queryByRole('heading', { name: BASE_GIVEN })).not.toBeNull()

    openContact(OTHER_GIVEN)
    removal.release(false)
    await settle()
    expect(ui().queryAllByText(BASE_GIVEN)).toHaveLength(0)
    expect(ui().queryByRole('heading', { name: OTHER_GIVEN })).not.toBeNull()
  })

  it('#744 keeps a detail owner while its photo is pending, and a reopened detail owns the contact afresh', async () => {
    const { item } = await seedContacts()
    renderContactsPage()
    openContact(BASE_GIVEN)
    await settle()
    const first = (contactStore as any).getContactOwner?.(item.uid)
    expect(first).toBeDefined()
    // jsdom never decodes the image, so the photo stays in processing.
    const input = document.body.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new harness.window.File(['photo'], 'photo.png', { type: 'image/png' })] } })
    openContact(OTHER_GIVEN)
    await settle()

    // 744 wired boundary
    expect((contactStore as any).getContactOwner?.(item.uid)).toBe(first)

    openContact(BASE_GIVEN)
    await settle()
    const reopened = (contactStore as any).getContactOwner(item.uid)
    expect(reopened).toBeDefined()
    expect(reopened).not.toBe(first)
    openContact(OTHER_GIVEN)
    await settle()
    expect((contactStore as any).getContactOwner(item.uid)).toBeUndefined()
  })

  it('#744 clears contact draft ledgers and detail owners on the real logout reset', async () => {
    const { account, collection, item } = await seedContacts()
    const nativeSet = Map.prototype.set
    const receivers: Map<unknown, any>[] = []
    Map.prototype.set = function observedSet(this: Map<unknown, any>, key: unknown, value: unknown) {
      if (key === item.uid && value && typeof value === 'object' && 'accountEpoch' in value) receivers.push(this)
      return nativeSet.call(this, key, value)
    }
    try {
      renderContactsPage()
      openContact(BASE_GIVEN)
      await settle()
      const peerItem = item._clone()
      await peerItem.setContent(contactVcard('vcard-base-744', PEER_GIVEN))
      await account.getCollectionManager().getItemManager(collection).transaction([peerItem])
      await useContactStore.getState().updateContact(item.uid, { organization: 'Reset org 744' })
    } finally {
      Map.prototype.set = nativeSet
    }
    const ledgers = receivers.find((map) => map.get(item.uid)?.draft)
    const owners = receivers.find((map) => map.get(item.uid)?.token)
    expect([ledgers?.has(item.uid), owners?.has(item.uid)]).toEqual([true, true])
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    try {
      await act(async () => { await useAuthStore.getState().logout() })
    } finally {
      fetchSpy.mockRestore()
    }

    // 744 wired boundary
    expect([ledgers!.size, owners!.size]).toEqual([0, 0])
  })

  describe('#744 contact photos through controlled browser image ports', () => {
    const decodes: (() => void)[] = []
    const photoData = 'data:image/jpeg;base64,UEhPVE8gNzQ0'
    let restorePorts: () => void = () => {}

    beforeEach(() => {
      const win = harness.window as any
      const OriginalImage = win.Image
      const canvasProto = win.HTMLCanvasElement.prototype
      const getContext = canvasProto.getContext
      const toDataURL = canvasProto.toDataURL
      // The browser's image decoder and canvas are external ports: decoding finishes when the test says.
      win.Image = class ControlledImage {
        onload: (() => void) | null = null
        onerror: ((err: unknown) => void) | null = null
        width = 512
        height = 384
        set src(_value: string) { decodes.push(() => this.onload?.()) }
      }
      canvasProto.getContext = function controlledContext() { return { drawImage: () => {} } }
      canvasProto.toDataURL = function controlledEncode(type: string) { return type === 'image/jpeg' ? photoData : '' }
      restorePorts = () => {
        win.Image = OriginalImage
        canvasProto.getContext = getContext
        canvasProto.toDataURL = toDataURL
        decodes.length = 0
      }
    })

    afterEach(() => restorePorts())

    function choosePhoto() {
      const input = document.body.querySelector('input[type="file"]') as HTMLInputElement
      fireEvent.change(input, { target: { files: [new harness.window.File(['photo'], 'photo.png', { type: 'image/png' })] } })
    }

    async function decodeNext() {
      await act(async () => { decodes.shift()!() })
      await settle()
    }

    async function serverContact(account: any, collection: any, uid: string) {
      const fresh = await account.getCollectionManager().getItemManager(collection).fetch(uid)
      return deserializeContact(new TextDecoder().decode(await fresh.getContent()))
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

    it('#744 completes a photo after its detail left, through the ordinary save, without touching the reopened owner', async () => {
      const { account, collection, item } = await seedContacts()
      renderContactsPage()
      openContact(BASE_GIVEN)
      await settle()
      choosePhoto()
      await settle()
      expect(decodes).toHaveLength(1)
      openContact(OTHER_GIVEN)
      await settle()
      openContact(BASE_GIVEN)
      await settle()
      const reopened = (contactStore as any).getContactOwner(item.uid)

      await decodeNext()

      // 744 wired boundary
      expect((await serverContact(account, collection, item.uid)).photoUrl).toBe(photoData)

      expect((contactStore as any).getContactOwner(item.uid)).toBe(reopened)
    })

    it('#744 drains a departed owner only once its own pending photo has settled', async () => {
      const { account, collection, item } = await seedContacts()
      renderContactsPage()
      openContact(BASE_GIVEN)
      await settle()
      const first = (contactStore as any).getContactOwner(item.uid)
      choosePhoto()
      await settle()
      openContact(OTHER_GIVEN)
      await settle()
      expect((contactStore as any).getContactOwner(item.uid)).toBe(first)

      await decodeNext()

      // 744 wired boundary
      expect((contactStore as any).getContactOwner(item.uid)).toBeUndefined()

      expect((await serverContact(account, collection, item.uid)).photoUrl).toBe(photoData)
    })

    it('#744 never saves a photo decoded after its origin account was replaced', async () => {
      const { account, collection, item } = await seedContacts()
      renderContactsPage()
      openContact(BASE_GIVEN)
      await settle()
      choosePhoto()
      await settle()
      const sent = server.transactions.length
      act(() => { bumpAccountEpoch() })

      await decodeNext()

      // 744 wired boundary
      expect(server.transactions.length).toBe(sent)

      expect((await serverContact(account, collection, item.uid)).photoUrl ?? null).toBeNull()
    })

    it('#744 refuses an ordinary photo against favorite custody, keeping its ciphertext and the draft Not saved', async () => {
      const { account, collection, item } = await seedContacts()
      server.offline = true
      await act(async () => { await useContactStore.getState().setContactFavorite(item.uid, true) })
      const [queued] = await queueRecords()
      server.offline = false
      renderContactsPage()
      openContact(BASE_GIVEN)
      await settle()
      choosePhoto()
      await settle()

      await decodeNext()

      // 744 wired boundary
      expect(ui().queryByRole('status')?.textContent).toContain('Not saved')

      const records = await queueRecords()
      expect(records.map((record) => [record.rev, record.sealed])).toEqual([[queued.rev, queued.sealed]])
      expect((useContactStore.getState().contacts.find((contact) => contact.id === item.uid) as any)?.photoUrl).toBe(photoData)
      expect((await serverContact(account, collection, item.uid)).photoUrl ?? null).toBeNull()
    })
  })
})
