// @vitest-environment node
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetForTests as resetOfflineQueue, insertIfNoOutstanding, replay } from '@/app/lib/offline-queue'
import { _resetForTests as resetDataCache } from '@/app/lib/data-cache'
import { bumpAccountEpoch } from '@/app/lib/account-epoch'
import { deserializeContact, serializeContact } from '@silentsuite/core'

const toastMock = vi.hoisted(() => ({ showErrorToast: vi.fn() }))
vi.mock('@/app/stores/use-toast-store', () => toastMock)
vi.mock('@/app/stores/use-label-suggestions-store', () => ({
  useLabelSuggestionsStore: { getState: () => ({ recordUsage: vi.fn() }) },
}))

import { useEtebaseStore } from '../use-etebase-store'
import { useContactStore } from '../use-contact-store'
import { useContactListStore } from '../use-contact-list-store'
import { useAuthStore } from '../use-auth-store'
import {
  EtebaseRequest,
  ReferenceServer,
  deleteDatabase,
  installContactAccount,
  makeSavedContact,
  queueGuard,
  serverText,
} from './web744-sdk-fixture'

vi.setConfig({ testTimeout: 20_000 })

const BASE_GIVEN = 'Base Person 744'
const PEER_GIVEN = 'Peer Person A 744'

function contactVcard(uid: string, given: string, extra: Record<string, unknown> = {}): string {
  const at = new Date(1000)
  return serializeContact({
    id: uid, uid, displayName: given, name: { prefix: '', given, family: '', suffix: '' },
    phones: [], emails: [], addresses: [], organization: '', title: '', notes: '', birthday: null,
    photoUrl: null, categories: [], favorite: false, created_at: at, updated_at: at, ...extra,
  } as any)
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

describe('#744 the contact store saves through the captured record base', () => {
  const originalRequest = EtebaseRequest.default
  const onLineDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, 'onLine')
  let server: ReferenceServer

  beforeEach(async () => {
    await resetOfflineQueue()
    await resetDataCache()
    await deleteDatabase('silentsuite-offline-queue')
    await deleteDatabase('silentsuite-data-cache')
    toastMock.showErrorToast.mockReset()
    server = new ReferenceServer()
    EtebaseRequest.default = (url: string, options: unknown) => server.handle(url, options)
    Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, get: () => true })
    useAuthStore.setState({ canWrite: () => true } as any)
  })

  afterEach(() => {
    EtebaseRequest.default = originalRequest
    if (onLineDescriptor) Object.defineProperty(globalThis.navigator, 'onLine', onLineDescriptor)
    else delete (globalThis.navigator as any).onLine
    useEtebaseStore.setState(useEtebaseStore.getInitialState(), true)
    useContactStore.setState({ contacts: [] } as any)
  })

  async function shownSavedContact() {
    const probe = await makeSavedContact('')
    const vcard = contactVcard('vcard-uid-744', BASE_GIVEN)
    const item = await probe.account.getCollectionManager().getItemManager(probe.collection).create({ mtime: 1 }, vcard)
    item.encryptedItem.__markSaved()
    const { account, collection } = probe
    server.seed(collection, [item])
    installContactAccount(account, collection, item)
    useContactListStore.setState({ lists: [{ id: collection.uid, name: 'Address book 744', color: '#fff', visible: true, accessLevel: 2 }], activeListId: 'all' } as any)
    useContactStore.setState({
      contacts: [{ ...deserializeContact(vcard), id: item.uid, listId: collection.uid, revision: item.etag }],
    } as any)
    return { account, collection, item, vcard }
  }

  function stored(id: string): any {
    return useContactStore.getState().contacts.find((contact) => contact.id === id)
  }

  async function peerWrites(account: any, collection: any, source: any, given: string) {
    const peerItem = source._clone()
    await peerItem.setContent(contactVcard('vcard-uid-744', given))
    await account.getCollectionManager().getItemManager(collection).transaction([peerItem])
    return peerItem
  }

  const isItemWrite = (method: string, path: string) => method === 'post' && /item\/(batch|transaction)$/.test(path)
  const isItemGet = (uid: string) => (method: string, path: string) => method === 'get' && path.endsWith(`item/${uid}`)

  it('#744 refuses an edit captured on R0 after this context cached acknowledged A, and A stays', async () => {
    const { account, collection, item } = await shownSavedContact()
    const peerItem = await peerWrites(account, collection, item, PEER_GIVEN)
    // The SDK cache already holds A; the store still shows R0.
    useEtebaseStore.setState({ itemCache: new Map([[item.uid, peerItem]]) })

    await useContactStore.getState().updateContact(item.uid, { organization: 'PRIVATE ORG 744' })

    // 744 wired boundary
    expect(deserializeContact((await serverText(account, collection, item.uid))!).name.given).toBe(PEER_GIVEN)

    expect(deserializeContact((await serverText(account, collection, item.uid))!).organization).toBe('')
  })

  it('#744 refuses an ordinary edit while sealed custody is outstanding and keeps its bytes', async () => {
    const { account, collection, item, vcard } = await shownSavedContact()
    expect(await insertIfNoOutstanding(
      { type: 'sealed-update', collectionType: 'contacts', collectionUid: collection.uid, itemUid: item.uid, sealed: { iv: [1], ct: [2] }, rev: 1 },
      queueGuard(),
    )).toBe(true)

    await useContactStore.getState().updateContact(item.uid, { notes: 'PRIVATE NOTE 744' })

    // 744 wired boundary
    expect(await serverText(account, collection, item.uid)).toBe(vcard)

    const records = await readAllRecords('silentsuite-offline-queue', 'mutations')
    expect(records.map((record) => [record.rev, record.sealed])).toEqual([[1, { iv: [1], ct: [2] }]])
  })

  it('#744 seals an own offline favorite and its descendant in custody, never plaintext', async () => {
    const { item } = await shownSavedContact()
    server.offline = true

    await useContactStore.getState().setContactFavorite(item.uid, true)
    const first = await readAllRecords('silentsuite-offline-queue', 'mutations')

    // 744 wired boundary
    expect(first.map((record) => [record.type, record.rev, Boolean(record.sealed)])).toEqual([['sealed-update', 1, true]])

    expect(stored(item.uid).favorite).toBe(true)
    await useContactStore.getState().setContactFavorite(item.uid, false)
    const second = await readAllRecords('silentsuite-offline-queue', 'mutations')
    expect(second.map((record) => [record.type, record.rev])).toEqual([['sealed-update', 2]])
    expect(stored(item.uid).favorite).toBe(false)
    expect(JSON.stringify(second)).not.toContain(BASE_GIVEN)
  })

  it('#744 saves consecutive own edits and favorites and pairs the saved revision', async () => {
    const { account, collection, item } = await shownSavedContact()

    await useContactStore.getState().updateContact(item.uid, { organization: 'First org 744' })
    await useContactStore.getState().updateContact(item.uid, { organization: 'Second org 744' })
    await useContactStore.getState().setContactFavorite(item.uid, true)
    await useContactStore.getState().setContactFavorite(item.uid, false)
    const serverItem = await account.getCollectionManager().getItemManager(collection).fetch(item.uid)

    // 744 wired boundary
    expect(stored(item.uid).revision).toBe(serverItem.etag)

    const onServer = deserializeContact((await serverText(account, collection, item.uid))!)
    expect([onServer.organization, onServer.favorite]).toEqual(['Second org 744', false])
  })

  it('#744 publishes created and imported contacts with the revision of their committed items', async () => {
    const { account, collection } = await shownSavedContact()

    const created = await useContactStore.getState().createContact({ displayName: 'Created 744', name: { given: 'Created 744' }, listId: collection.uid })
    const imported = await useContactStore.getState().importContacts([{ displayName: 'Imported 744', name: { given: 'Imported 744' }, listId: collection.uid }])
    const importedRecord = useContactStore.getState().contacts.find((contact) => contact.displayName === 'Imported 744') as any
    const manager = account.getCollectionManager().getItemManager(collection)

    // 744 wired boundary
    expect([stored(created.id).revision, importedRecord?.revision]).toEqual([
      (await manager.fetch(created.id)).etag,
      importedRecord ? (await manager.fetch(importedRecord.id)).etag : 'not imported',
    ])

    expect(imported).toBe(1)
  })

  it('#744 never publishes a create into the account that replaced its origin', async () => {
    const { collection } = await shownSavedContact()
    const write = server.holdNext(isItemWrite)
    const creating = useContactStore.getState().createContact({ displayName: 'Origin 744', name: { given: 'Origin 744' }, listId: collection.uid })
    await write.arrived
    const nextAccountContacts: any[] = []
    bumpAccountEpoch()
    useContactStore.setState({ contacts: nextAccountContacts } as any)

    write.release(false)
    await creating.then(() => undefined, () => undefined)

    // 744 wired boundary
    expect(useContactStore.getState().contacts).toBe(nextAccountContacts)
  })

  it('#744 never lets an older accepted edit retire or stamp a newer refused draft', async () => {
    const { account, collection, item } = await shownSavedContact()
    const firstWrite = server.holdNext(isItemWrite)
    const first = useContactStore.getState().updateContact(item.uid, { organization: 'Older org 744' })
    await firstWrite.arrived
    const second = useContactStore.getState().updateContact(item.uid, { organization: 'Newer org 744' })
    const secondRead = server.holdNext(isItemGet(item.uid))
    firstWrite.release(false)
    await first
    await secondRead.arrived
    // Another device writes before the newer draft's fresh read completes.
    const own = await account.getCollectionManager().getItemManager(collection).fetch(item.uid)
    await peerWrites(account, collection, own, PEER_GIVEN)
    secondRead.release(false)
    await second

    // 744 wired boundary
    expect([stored(item.uid).organization, stored(item.uid).revision, (useContactStore.getState() as any).contactSaveStates?.[item.uid]])
      .toEqual(['Newer org 744', null, 'refused'])

    expect(deserializeContact((await serverText(account, collection, item.uid))!).name.given).toBe(PEER_GIVEN)
  })

  it('#744 never mutates or dispatches a contact save without an account fingerprint', async () => {
    const { account, collection, item, vcard } = await shownSavedContact()
    useEtebaseStore.setState({ accountFingerprint: null } as any)
    const mutated: boolean[] = []
    const unsubscribe = useContactStore.subscribe((state) => {
      const record: any = state.contacts.find((contact) => contact.id === item.uid)
      mutated.push(record?.favorite === true || record?.notes === 'UNGUARDED 744')
    })
    const before = server.transactions.length

    await useContactStore.getState().setContactFavorite(item.uid, true)
    await useContactStore.getState().updateContact(item.uid, { notes: 'UNGUARDED 744' })
    unsubscribe()

    // 744 wired boundary
    expect(mutated).not.toContain(true)

    expect(server.transactions.length).toBe(before)
    expect(await serverText(account, collection, item.uid)).toBe(vcard)
  })

  it('#744 sends two immediate favorite intents in order so the latest reaches the server last', async () => {
    const { account, collection, item } = await shownSavedContact()
    const firstWrite = server.holdNext(isItemWrite)
    const before = server.transactions.length

    const favorite = useContactStore.getState().setContactFavorite(item.uid, true)
    const unfavorite = useContactStore.getState().setContactFavorite(item.uid, false)
    await firstWrite.arrived
    firstWrite.release(false)
    await Promise.all([favorite, unfavorite])

    // 744 wired boundary
    expect(deserializeContact((await serverText(account, collection, item.uid))!).favorite).toBe(false)

    expect(stored(item.uid).favorite).toBe(false)
    expect(server.transactions.length - before).toBe(2)
  })

  it('#744 reverts only its own star on a favorite refusal and retires a star-only draft', async () => {
    const { account, collection, item } = await shownSavedContact()
    await peerWrites(account, collection, item, PEER_GIVEN)

    await useContactStore.getState().setContactFavorite(item.uid, true)

    // 744 wired boundary
    expect([stored(item.uid).favorite, (useContactStore.getState() as any).contactSaveStates?.[item.uid]]).toEqual([false, undefined])

    expect(toastMock.showErrorToast).toHaveBeenCalledWith('Failed to update favorite. Please try again.')
    // A refused ordinary draft stays when a later favorite on it is refused too.
    await useContactStore.getState().updateContact(item.uid, { organization: 'Refused org 744' })
    await useContactStore.getState().setContactFavorite(item.uid, true)
    expect([stored(item.uid).organization, stored(item.uid).favorite, (useContactStore.getState() as any).contactSaveStates?.[item.uid]])
      .toEqual(['Refused org 744', false, 'refused'])
  })

  it('#744 publishes a created contact under an explicit temp identity before commit, then its own revision', async () => {
    const { account, collection } = await shownSavedContact()
    const write = server.holdNext(isItemWrite)
    const creating = useContactStore.getState().createContact({ displayName: 'Pending 744', name: { given: 'Pending 744' }, listId: collection.uid })
    await write.arrived
    const pending: any = useContactStore.getState().contacts.find((contact) => contact.displayName === 'Pending 744')
    write.release(false)
    const created = await creating
    const serverItem = await account.getCollectionManager().getItemManager(collection).fetch(created.id)

    // 744 wired boundary
    expect([pending?.revision, pending?.id === created.id, stored(created.id).revision]).toEqual([null, false, serverItem.etag])

    expect(useContactStore.getState().contacts.filter((contact) => contact.displayName === 'Pending 744')).toHaveLength(1)
  })

  it('#744 never publishes an import into the account that replaced its origin', async () => {
    const { collection } = await shownSavedContact()
    const write = server.holdNext(isItemWrite)
    const importing = useContactStore.getState().importContacts([{ displayName: 'Origin import 744', name: { given: 'Origin import 744' }, listId: collection.uid }])
    await write.arrived
    const nextAccountContacts: any[] = []
    bumpAccountEpoch()
    useContactStore.setState({ contacts: nextAccountContacts } as any)

    write.release(false)
    await importing.then(() => undefined, () => undefined)

    // 744 wired boundary
    expect(useContactStore.getState().contacts).toBe(nextAccountContacts)
  })

  it('#744 keeps a retained draft over a remote refresh and appends it when the refresh omits it', async () => {
    const { account, collection, item } = await shownSavedContact()
    await peerWrites(account, collection, item, PEER_GIVEN)
    await useContactStore.getState().updateContact(item.uid, { organization: 'Kept org 744' })

    useContactStore.getState().syncFromRemote([])

    // 744 wired boundary
    expect(useContactStore.getState().contacts.map((contact) => [contact.id, contact.organization])).toEqual([[item.uid, 'Kept org 744']])
  })

  async function replayQueue() {
    const guard = queueGuard()
    return replay((queued, checkpoint) => useEtebaseStore.getState().replayQueuedMutation(queued, guard, checkpoint), guard)
  }

  async function serverFavorite(account: any, collection: any, uid: string): Promise<boolean> {
    return deserializeContact((await serverText(account, collection, uid))!).favorite === true
  }

  it('#744 replays an offline favorite at its unchanged base and acknowledges it', async () => {
    const { account, collection, item } = await shownSavedContact()
    server.offline = true
    await useContactStore.getState().setContactFavorite(item.uid, true)
    server.offline = false
    const sent = server.transactions.length

    await replayQueue()

    // 744 wired boundary
    expect(await serverFavorite(account, collection, item.uid)).toBe(true)

    expect(await readAllRecords('silentsuite-offline-queue', 'mutations')).toEqual([])
    // The write carried the collection's main item as a dependency.
    expect(server.transactions.slice(sent).map((write) => write.deps?.map((dep: any) => dep.uid))).toEqual([[collection.uid]])
  })

  it('#744 holds an offline favorite as base-changed and sends nothing when an unseen peer replaced its base', async () => {
    const { account, collection, item } = await shownSavedContact()
    server.offline = true
    await useContactStore.getState().setContactFavorite(item.uid, true)
    const [queued] = await readAllRecords('silentsuite-offline-queue', 'mutations')
    server.offline = false
    await peerWrites(account, collection, item, PEER_GIVEN)
    const sent = server.transactions.length

    await replayQueue()
    const [held] = await readAllRecords('silentsuite-offline-queue', 'mutations')

    // 744 wired boundary
    expect(held?.held).toBe('base-changed')

    expect(held?.sealed).toEqual(queued?.sealed)
    expect(server.transactions.length).toBe(sent)
    expect(deserializeContact((await serverText(account, collection, item.uid))!).name.given).toBe(PEER_GIVEN)
  })

  it('#744 keeps a descendant that replaced the record during replay, then replays it through its prior', async () => {
    const { account, collection, item } = await shownSavedContact()
    server.offline = true
    await useContactStore.getState().setContactFavorite(item.uid, true)
    server.offline = false
    const write = server.holdNext(isItemWrite)
    const replaying = replayQueue()
    await write.arrived
    // The own rapid descendant replaces the record before the first replay's acknowledgement.
    await useContactStore.getState().setContactFavorite(item.uid, false)
    write.release(false)
    await replaying
    const kept = await readAllRecords('silentsuite-offline-queue', 'mutations')

    // 744 wired boundary
    expect([kept.map((record) => record.rev), await serverFavorite(account, collection, item.uid)]).toEqual([[2], true])

    await replayQueue()
    expect(await serverFavorite(account, collection, item.uid)).toBe(false)
    expect(await readAllRecords('silentsuite-offline-queue', 'mutations')).toEqual([])
  })

  it('#744 holds an offline favorite as target-missing when its collection is tombstoned between read and write', async () => {
    const { account, collection, item } = await shownSavedContact()
    server.offline = true
    await useContactStore.getState().setContactFavorite(item.uid, true)
    const [queued] = await readAllRecords('silentsuite-offline-queue', 'mutations')
    server.offline = false
    const write = server.holdNext(isItemWrite)
    const replaying = replayQueue()
    await write.arrived
    const remote = await account.getCollectionManager().fetch(collection.uid)
    remote.delete()
    server.replaceCollection(remote)
    write.release(false)
    await replaying
    const [held] = await readAllRecords('silentsuite-offline-queue', 'mutations')

    // 744 wired boundary
    expect(held?.held).toBe('target-missing')

    expect(held?.sealed).toEqual(queued?.sealed)
    expect(await serverFavorite(account, collection, item.uid)).toBe(false)
  })
})
