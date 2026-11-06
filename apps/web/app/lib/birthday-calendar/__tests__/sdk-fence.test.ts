// @vitest-environment node
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { birthdayMarkerContent } from '@silentsuite/core'
import { createEtebaseBirthdayTransport } from '../etebase-transport'

// Pinned etebase@0.43.1 as resolved by @silentsuite/core, not a shape mock.
const requireFromCore = createRequire(path.resolve(__dirname, '../../../../../../packages/core/package.json'))
const Etebase = requireFromCore('etebase')
const EtebaseRequest = requireFromCore('etebase/dist/lib-cjs/Request')
const { msgpackDecode, msgpackEncode } = requireFromCore('etebase/dist/lib-cjs/Helpers')
const etebasePackage = requireFromCore('etebase/package.json')

const originalRequest = EtebaseRequest.default

function respond(status: number, body: unknown) {
  return { type: 'default', status, statusText: '', ok: status >= 200 && status < 300, body: msgpackEncode(body) }
}

/** A local SDK account and saved calendar. No signup and no server. */
async function savedCalendar() {
  await Etebase.ready
  const version = Etebase.CURRENT_VERSION
  const mainKey = Etebase.randomBytes(32)
  const SdkBytes = Etebase.randomBytes(1).constructor as Uint8ArrayConstructor
  const accountContent = new SdkBytes(64)
  accountContent.set(Etebase.randomBytes(32), 0)
  accountContent.set(Etebase.randomBytes(32), 32)
  const account = new Etebase.Account(mainKey, version)
  account.user = {
    username: 'birthday-sdk',
    email: 'birthday-sdk@example.invalid',
    pubkey: new SdkBytes(32),
    encryptedContent: Etebase.getMainCryptoManager(mainKey, version).encrypt(accountContent),
  }
  account.serverUrl = 'https://etebase.invalid/'
  account.authToken = 'birthday-sdk-token'
  const collection = await account.getCollectionManager().create('etebase.vevent', { name: 'Birthdays', mtime: 1 }, '')
  collection.encryptedCollection.__markSaved()
  const item = await account.getCollectionManager().getItemManager(collection).create({ mtime: 1 }, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')
  return { account, collection, item }
}

describe('pinned etebase 0.43.1 collection-root dependency', () => {
  afterEach(() => {
    EtebaseRequest.default = originalRequest
  })

  it('serializes collection.item as the transaction dependency', async () => {
    expect(etebasePackage.version).toBe('0.43.1')
    const { account, collection, item } = await savedCalendar()
    const captured: Array<{ url: string; body: any }> = []
    EtebaseRequest.default = (url: string, options: { body?: Uint8Array } = {}) => {
      if (options.body) captured.push({ url, body: msgpackDecode(options.body) })
      return respond(200, {})
    }

    await account.getCollectionManager().getItemManager(collection).transaction([item], [collection.item])

    const transaction = captured.find((call) => call.url.includes('/item/transaction'))
    expect(transaction).toBeTruthy()
    expect(collection.item.uid).toBe(collection.uid)
    expect(collection.item.encryptedItem.lastEtag).toBeTruthy()
    expect(transaction!.body.deps).toEqual([
      { uid: collection.item.uid, etag: collection.item.encryptedItem.lastEtag },
    ])
    expect(transaction!.body.items.map((written: { uid: string }) => written.uid)).toEqual([item.uid])
    expect(transaction!.body.items.map((written: { uid: string }) => written.uid)).not.toContain(collection.uid)
  })

  it('adapter applyChanges puts the fresh collection root in the serialized dependency', async () => {
    const { account, collection } = await savedCalendar()
    const captured: Array<{ url: string; body: any }> = []
    EtebaseRequest.default = (url: string, options: { method?: string; body?: Uint8Array } = {}) => {
      const method = String(options.method ?? 'get').toLowerCase()
      if (options.body) captured.push({ url, body: msgpackDecode(options.body) })
      else captured.push({ url, body: null })
      if (method === 'post' && url.includes('/collection/list_multi')) {
        const serialized = collection.encryptedCollection.serialize()
        return respond(200, {
          data: [{ ...serialized, accessLevel: 1, stoken: 'list-1' }],
          stoken: 'list-1',
          done: true,
        })
      }
      if (method === 'get' && url.includes('/member')) {
        return respond(200, { data: [{ username: account.user.username, accessLevel: 1 }], done: true })
      }
      if (method === 'post' && url.includes('/item/transaction')) return respond(200, {})
      return respond(500, { detail: 'unregistered' })
    }

    const transport = createEtebaseBirthdayTransport(account, {
      accountEpoch: 1,
      isCurrentEpoch: () => true,
      canWrite: () => true,
      isOnline: () => true,
      hasSubtleCrypto: () => true,
    })
    const inventory = await transport.listInventory()
    const listed = inventory.collections.find((candidate) => candidate.uid === collection.uid)
    const root = listed?.root ?? collection.item
    await transport.applyChanges({
      collectionUid: collection.uid,
      rootRevision: listed?.rootRevision ?? collection.item.encryptedItem.lastEtag,
      root,
      changes: [{ op: 'create', content: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' }],
    })

    const transaction = captured.find((call) => call.url.includes('/item/transaction'))
    expect(transaction?.body.deps).toEqual([
      { uid: root.uid, etag: root.encryptedItem.lastEtag },
    ])
  })

  it('retires by uploading the saved root etag, then exposes a new root', async () => {
    const { account, collection } = await savedCalendar()
    const captured: Array<{ url: string; body: any }> = []
    EtebaseRequest.default = (url: string, options: { method?: string; body?: Uint8Array } = {}) => {
      const method = String(options.method ?? 'get').toLowerCase()
      if (options.body) captured.push({ url, body: msgpackDecode(options.body) })
      if (method === 'post' && url.includes('/collection/list_multi')) {
        const serialized = collection.encryptedCollection.serialize()
        return respond(200, {
          data: [{ ...serialized, accessLevel: 1, stoken: 'list-1' }],
          stoken: 'list-1',
          done: true,
        })
      }
      if (method === 'get' && url.includes('/member')) {
        return respond(200, { data: [{ username: account.user.username, accessLevel: 1 }], done: true })
      }
      if (method === 'post' && (url.includes('/item/batch') || url.includes('/item/transaction'))) return respond(200, {})
      return respond(500, { detail: 'unregistered' })
    }
    const transport = createEtebaseBirthdayTransport(account, {
      accountEpoch: 1,
      isCurrentEpoch: () => true,
      canWrite: () => true,
      isOnline: () => true,
      hasSubtleCrypto: () => true,
    })
    const inventory = await transport.listInventory()
    const listed = inventory.collections.find((candidate) => candidate.uid === collection.uid)
    expect(listed?.rootRevision).toBeTruthy()
    const oldEtag = listed!.root.encryptedItem.lastEtag

    const retired = await transport.retireCalendar!({
      collectionUid: collection.uid,
      rootRevision: listed!.rootRevision,
      root: listed!.root,
      content: birthdayMarkerContent('retired'),
    })

    const upload = captured.find((call) => call.url.includes('/item/batch'))
    expect(upload?.body.items.map((item: { etag: string; uid: string }) => ({ uid: item.uid, etag: item.etag }))).toEqual([
      { uid: collection.uid, etag: oldEtag },
    ])
    expect(retired.kind).toBe('retired')
    if (retired.kind !== 'retired') return
    expect(retired.rootRevision).not.toBe(oldEtag)
    expect(retired.root.encryptedItem.lastEtag).toBe(retired.rootRevision)
  })
})
