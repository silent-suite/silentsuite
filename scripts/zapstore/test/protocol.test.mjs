// NIP-44 v2 conformance against the published test vectors, and the read-only
// NIP-46 handshake against an in-process responder that implements the same
// protocol (kind 24133, NIP-44 payloads, connect / get_public_key). The
// responder proves the client side of the protocol; it is not a signer product.
// Nothing here opens a network socket or requests a signature.

import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { schnorr } from '@noble/curves/secp256k1.js'

import { bytesToHex, calcPaddedLen, conversationKey, decrypt, encrypt, hexToBytes, messageKeys } from '../lib/nip44.mjs'
import { BunkerConversation, KIND_NOSTR_CONNECT, parseBunkerUrl, requireSigningAccount } from '../lib/nip46.mjs'
import { publishWithPreflight } from '../lib/publish.mjs'
import { eventId, verifyEvent } from '../lib/nostr.mjs'

const here = resolve(new URL('.', import.meta.url).pathname)
const vectors = JSON.parse(readFileSync(join(here, 'fixtures', 'nip44.vectors.json'), 'utf8')).v2
const pub = (sec) => bytesToHex(schnorr.getPublicKey(hexToBytes(sec)))
const sha256hex = (text) => createHash('sha256').update(text).digest('hex')

test('NIP-44: conversation keys, message keys and padding match the published vectors', () => {
  for (const v of vectors.valid.get_conversation_key) assert.equal(bytesToHex(conversationKey(v.sec1, v.pub2)), v.conversation_key)
  const { conversation_key, keys } = vectors.valid.get_message_keys
  for (const k of keys) {
    const derived = messageKeys(hexToBytes(conversation_key), hexToBytes(k.nonce))
    assert.equal(bytesToHex(derived.chachaKey), k.chacha_key)
    assert.equal(bytesToHex(derived.chachaNonce), k.chacha_nonce)
    assert.equal(bytesToHex(derived.hmacKey), k.hmac_key)
  }
  for (const [length, padded] of vectors.valid.calc_padded_len) assert.equal(calcPaddedLen(length), padded, `padded length for ${length}`)
  for (const v of vectors.invalid.get_conversation_key) assert.throws(() => conversationKey(v.sec1, v.pub2), Error, v.note)
})

test('NIP-44: encrypt and decrypt reproduce every published payload and reject every invalid one', () => {
  for (const v of vectors.valid.encrypt_decrypt) {
    const key = conversationKey(v.sec1, pub(v.sec2))
    assert.equal(bytesToHex(key), v.conversation_key)
    assert.equal(bytesToHex(conversationKey(v.sec2, pub(v.sec1))), v.conversation_key, 'the key is symmetric')
    assert.equal(encrypt(v.plaintext, key, hexToBytes(v.nonce)), v.payload)
    assert.equal(decrypt(v.payload, key), v.plaintext)
  }
  for (const v of vectors.valid.encrypt_decrypt_long_msg) {
    const plaintext = v.pattern.repeat(v.repeat)
    assert.equal(sha256hex(plaintext), v.plaintext_sha256)
    const payload = encrypt(plaintext, hexToBytes(v.conversation_key), hexToBytes(v.nonce))
    assert.equal(sha256hex(payload), v.payload_sha256)
    assert.equal(decrypt(payload, hexToBytes(v.conversation_key)), plaintext)
  }
  const key = hexToBytes(vectors.valid.encrypt_decrypt[0].conversation_key)
  for (const length of vectors.invalid.encrypt_msg_lengths) assert.throws(() => encrypt("x".repeat(length), key, new Uint8Array(32)), Error, `length ${length}`)
  for (const v of vectors.invalid.decrypt) assert.throws(() => decrypt(v.payload, hexToBytes(v.conversation_key)), Error, v.note)
  const tampered = vectors.valid.encrypt_decrypt[0]
  const bytes = Buffer.from(tampered.payload, 'base64')
  bytes[40] ^= 0x01
  assert.throws(() => decrypt(bytes.toString('base64'), hexToBytes(tampered.conversation_key)), /MAC/)
})

function sign(event, secHex) {
  const signed = { ...event, pubkey: pub(secHex) }
  signed.id = eventId(signed)
  signed.sig = bytesToHex(schnorr.sign(hexToBytes(signed.id), hexToBytes(secHex)))
  return signed
}

// An in-process NIP-46 responder behind a fake relay socket. `behaviour`
// decides how it answers; `responderKey` signs its responses and is the key the
// bunker URL names; `accountPubkey` is what get_public_key returns.
function fakeBunkerSocket({ responderKey, accountPubkey, behaviour = 'ok', log = [] }) {
  return class FakeSocket {
    constructor(url) {
      this.url = url
      this.listeners = {}
      this.subscription = null
      queueMicrotask(() => this.listeners.open?.({}))
    }
    addEventListener(name, fn) { this.listeners[name] = fn }
    close() { this.listeners.close?.({}) }
    send(raw) {
      const frame = JSON.parse(raw)
      log.push(frame)
      if (frame[0] === 'REQ') { this.subscription = frame[1]; return }
      if (frame[0] !== 'EVENT') return
      const request = frame[1]
      assert.ok(verifyEvent(request, schnorr), 'client requests are signed')
      assert.equal(request.kind, KIND_NOSTR_CONNECT)
      assert.deepEqual(request.tags, [['p', pub(responderKey)]])
      const key = conversationKey(responderKey, request.pubkey)
      const rpc = JSON.parse(decrypt(request.content, key))
      assert.ok(['connect', 'get_public_key'].includes(rpc.method), `read-only method only, got ${rpc.method}`)
      let body
      if (behaviour === 'silent') return
      if (behaviour === 'auth_url') body = { id: rpc.id, result: 'auth_url', error: 'https://signer.example/authorize' }
      else if (behaviour === 'error') body = { id: rpc.id, result: '', error: 'no permission' }
      else if (rpc.method === 'connect') body = { id: rpc.id, result: behaviour === 'already' ? '' : 'ack', error: behaviour === 'already' ? 'already connected' : '' }
      else body = { id: rpc.id, result: accountPubkey, error: '' }
      const signer = behaviour === 'wrong-signer' ? 'e'.repeat(64) : responderKey
      const response = sign({ kind: KIND_NOSTR_CONNECT, created_at: Math.floor(Date.now() / 1000), tags: [['p', request.pubkey]], content: encrypt(JSON.stringify(body), conversationKey(signer, request.pubkey), new Uint8Array(32).fill(7)) }, signer)
      queueMicrotask(() => this.listeners.message?.({ data: JSON.stringify(['EVENT', this.subscription, response]) }))
    }
  }
}

const RESPONDER = '1'.repeat(64)
const CLIENT = '2'.repeat(64)
const ACCOUNT = pub('3'.repeat(64))
const bunkerUrl = `bunker://${pub(RESPONDER)}?relay=wss%3A%2F%2Fsigner-relay.example&secret=s3cret`

test('NIP-46: bunker URL parsing separates transport signer, relays and secret', () => {
  assert.deepEqual(parseBunkerUrl(bunkerUrl), { remoteSigner: pub(RESPONDER), relays: ['wss://signer-relay.example'], secret: 's3cret' })
  assert.throws(() => parseBunkerUrl(`bunker://${pub(RESPONDER)}?relay=ws://plain.example`), /wss/)
  assert.throws(() => parseBunkerUrl(`nsec://${pub(RESPONDER)}?relay=wss://x`), /bunker:\/\/ scheme/)
  assert.throws(() => parseBunkerUrl('bunker://short?relay=wss://x'), /64-hex/)
})

test('NIP-46: the handshake binds the account pubkey and refuses a signer serving another account', async () => {
  const log = []
  const ok = await requireSigningAccount({ bunkerUrl, clientKeyHex: CLIENT, expectedPubkeyHex: ACCOUNT, WebSocketImpl: fakeBunkerSocket({ responderKey: RESPONDER, accountPubkey: ACCOUNT, log }), timeoutMs: 500 })
  assert.equal(ok.accountPubkey, ACCOUNT)
  assert.equal(ok.remoteSigner, pub(RESPONDER))
  assert.notEqual(ok.accountPubkey, ok.remoteSigner, 'transport key and account differ; only the account is compared')
  const methods = log.filter((f) => f[0] === "EVENT").map((f) => JSON.parse(decrypt(f[1].content, conversationKey(RESPONDER, pub(CLIENT)))).method)
  assert.deepEqual(methods, ['connect', 'get_public_key'])
  assert.ok(log.some((f) => f[0] === 'CLOSE'), 'the subscription is closed afterwards')
  const other = pub('4'.repeat(64))
  await assert.rejects(requireSigningAccount({ bunkerUrl, clientKeyHex: CLIENT, expectedPubkeyHex: ACCOUNT, WebSocketImpl: fakeBunkerSocket({ responderKey: RESPONDER, accountPubkey: other }), timeoutMs: 500 }), new RegExp(`signing account ${other} is not the approved publisher`))
  await assert.rejects(requireSigningAccount({ bunkerUrl, clientKeyHex: CLIENT, expectedPubkeyHex: ACCOUNT, WebSocketImpl: fakeBunkerSocket({ responderKey: RESPONDER, accountPubkey: ACCOUNT, behaviour: 'auth_url' }), timeoutMs: 500 }), /interactive approval/)
  await assert.rejects(requireSigningAccount({ bunkerUrl, clientKeyHex: CLIENT, expectedPubkeyHex: ACCOUNT, WebSocketImpl: fakeBunkerSocket({ responderKey: RESPONDER, accountPubkey: ACCOUNT, behaviour: 'error' }), timeoutMs: 500 }), /refused connect: no permission/)
  await assert.rejects(requireSigningAccount({ bunkerUrl, clientKeyHex: CLIENT, expectedPubkeyHex: ACCOUNT, WebSocketImpl: fakeBunkerSocket({ responderKey: RESPONDER, accountPubkey: ACCOUNT, behaviour: 'silent' }), timeoutMs: 100 }), /did not answer connect within/)
  await assert.rejects(requireSigningAccount({ bunkerUrl, clientKeyHex: CLIENT, expectedPubkeyHex: ACCOUNT, WebSocketImpl: fakeBunkerSocket({ responderKey: RESPONDER, accountPubkey: ACCOUNT, behaviour: 'wrong-signer' }), timeoutMs: 100 }), /did not answer/, 'responses not signed by the named signer are ignored')
  const already = await requireSigningAccount({ bunkerUrl, clientKeyHex: CLIENT, expectedPubkeyHex: ACCOUNT, WebSocketImpl: fakeBunkerSocket({ responderKey: RESPONDER, accountPubkey: ACCOUNT, behaviour: 'already' }), timeoutMs: 500 })
  assert.equal(already.accountPubkey, ACCOUNT, 'a previously connected client key is still accepted')
  await assert.rejects(requireSigningAccount({ bunkerUrl, clientKeyHex: CLIENT, expectedPubkeyHex: 'nothex', WebSocketImpl: fakeBunkerSocket({ responderKey: RESPONDER, accountPubkey: ACCOUNT }) }), /64-hex/)
})

test('NIP-46: the conversation refuses every method except connect and get_public_key', async () => {
  const conversation = new BunkerConversation({ relay: 'wss://signer-relay.example', clientKeyHex: CLIENT, remoteSigner: pub(RESPONDER), WebSocketImpl: fakeBunkerSocket({ responderKey: RESPONDER, accountPubkey: ACCOUNT }), timeoutMs: 500 })
  await conversation.open()
  assert.throws(() => conversation.rpc('sign_event', ['{}']), /not a read-only handshake method/)
  assert.throws(() => conversation.rpc('nip44_encrypt', []), /not a read-only handshake method/)
  conversation.close()
})

test('the publisher is never started unless the preflight bound the approved account', async () => {
  const runs = []
  const runPublisher = async (account) => { runs.push(account.accountPubkey); return { status: 0 } }
  const good = await publishWithPreflight({ bunkerUrl, clientKeyHex: CLIENT, expectedPubkeyHex: ACCOUNT, preflight: async () => ({ accountPubkey: ACCOUNT }), runPublisher })
  assert.deepEqual(runs, [ACCOUNT])
  assert.equal(good.run.status, 0)
  await assert.rejects(publishWithPreflight({ bunkerUrl, clientKeyHex: CLIENT, expectedPubkeyHex: ACCOUNT, preflight: async () => { throw new Error('signing account mismatch') }, runPublisher }), /mismatch/)
  await assert.rejects(publishWithPreflight({ bunkerUrl, clientKeyHex: CLIENT, expectedPubkeyHex: ACCOUNT, preflight: async () => ({ accountPubkey: 'f'.repeat(64) }), runPublisher }), /did not bind the approved publisher/)
  assert.deepEqual(runs, [ACCOUNT], 'no publisher run after a failed or lying preflight')
  const real = await publishWithPreflight({ bunkerUrl, clientKeyHex: CLIENT, expectedPubkeyHex: ACCOUNT, preflight: (o) => requireSigningAccount({ ...o, WebSocketImpl: fakeBunkerSocket({ responderKey: RESPONDER, accountPubkey: ACCOUNT }), timeoutMs: 500 }), runPublisher })
  assert.equal(real.account.accountPubkey, ACCOUNT)
})
