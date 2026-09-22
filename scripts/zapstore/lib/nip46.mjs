// Read-only NIP-46 handshake: `connect` and `get_public_key` only.
//
// The bunker URL names the *remote signer* transport key; the account that will
// sign is whatever `get_public_key` returns. This module resolves that account
// with the job's client key so the lane can refuse before any signature or
// upload authorisation is requested. It deliberately has no sign_event, no
// encryption proxy, and no other method: the publisher itself is the only
// component that asks the signer to sign.

import { randomBytes } from 'node:crypto'
import { schnorr } from '@noble/curves/secp256k1.js'

import { eventId, verifyEvent } from './nostr.mjs'
import { bytesToHex, conversationKey, decrypt, encrypt, hexToBytes } from './nip44.mjs'

export const KIND_NOSTR_CONNECT = 24133
export const READ_ONLY_METHODS = ['connect', 'get_public_key']

export function parseBunkerUrl(bunkerUrl) {
  let parsed
  try { parsed = new URL(bunkerUrl) } catch { throw new Error('bunker URL is not a URL') }
  if (parsed.protocol !== 'bunker:') throw new Error('signer URL must use the bunker:// scheme')
  const remoteSigner = parsed.hostname.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(remoteSigner)) throw new Error('bunker URL does not name a 64-hex remote signer public key')
  const relays = parsed.searchParams.getAll('relay').filter((r) => /^wss:\/\//.test(r))
  if (relays.length === 0) throw new Error('bunker URL names no wss:// relay')
  return { remoteSigner, relays, secret: parsed.searchParams.get('secret') ?? '' }
}

function signEvent(event, privateKeyHex) {
  const signed = { ...event, pubkey: bytesToHex(schnorr.getPublicKey(hexToBytes(privateKeyHex))) }
  signed.id = eventId(signed)
  signed.sig = bytesToHex(schnorr.sign(hexToBytes(signed.id), hexToBytes(privateKeyHex)))
  return signed
}

// One relay connection carrying encrypted request/response events.
export class BunkerConversation {
  constructor({ relay, clientKeyHex, remoteSigner, WebSocketImpl = globalThis.WebSocket, timeoutMs = 20000, now = () => Math.floor(Date.now() / 1000) }) {
    if (typeof WebSocketImpl !== 'function') throw new Error('no WebSocket implementation available; pin Node 22 or newer')
    if (!/^[0-9a-f]{64}$/.test(clientKeyHex ?? '')) throw new Error('client key must be 64-hex')
    this.relay = relay
    this.clientKeyHex = clientKeyHex
    this.clientPubkey = bytesToHex(schnorr.getPublicKey(hexToBytes(clientKeyHex)))
    this.remoteSigner = remoteSigner
    this.key = conversationKey(clientKeyHex, remoteSigner)
    this.timeoutMs = timeoutMs
    this.now = now
    this.WebSocketImpl = WebSocketImpl
    this.pending = new Map()
    this.subscription = randomBytes(8).toString('hex')
    this.socket = null
  }

  open() {
    return new Promise((resolvePromise, rejectPromise) => {
      const socket = new this.WebSocketImpl(this.relay)
      const timer = setTimeout(() => { try { socket.close() } catch { /* closed */ } rejectPromise(new Error(`relay ${this.relay} did not open within ${this.timeoutMs} ms`)) }, this.timeoutMs)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        this.socket = socket
        socket.send(JSON.stringify(['REQ', this.subscription, { kinds: [KIND_NOSTR_CONNECT], '#p': [this.clientPubkey], since: this.now() - 60 }]))
        resolvePromise(this)
      })
      socket.addEventListener('message', (message) => this.onMessage(message))
      socket.addEventListener('error', () => { clearTimeout(timer); rejectPromise(new Error(`relay ${this.relay} socket error`)); this.failAll(new Error('relay socket error')) })
      socket.addEventListener('close', () => { clearTimeout(timer); rejectPromise(new Error(`relay ${this.relay} closed`)); this.failAll(new Error('relay closed before the signer answered')) })
    })
  }

  failAll(error) {
    for (const [id, waiter] of this.pending) { this.pending.delete(id); waiter.reject(error) }
  }

  onMessage(message) {
    let frame
    try { frame = JSON.parse(typeof message.data === 'string' ? message.data : Buffer.from(message.data).toString('utf8')) } catch { return }
    if (!Array.isArray(frame) || frame[0] !== 'EVENT' || frame[1] !== this.subscription) return
    const event = frame[2]
    if (!event || event.kind !== KIND_NOSTR_CONNECT || event.pubkey !== this.remoteSigner) return
    try { verifyEvent(event, schnorr) } catch { return }
    let response
    try { response = JSON.parse(decrypt(event.content, this.key)) } catch { return }
    const waiter = this.pending.get(response?.id)
    if (!waiter) return
    this.pending.delete(response.id)
    waiter.resolve(response)
  }

  rpc(method, params) {
    if (!READ_ONLY_METHODS.includes(method)) throw new Error(`method ${method} is not a read-only handshake method`)
    if (!this.socket) throw new Error('conversation is not open')
    const id = randomBytes(8).toString('hex')
    const request = signEvent({
      kind: KIND_NOSTR_CONNECT,
      created_at: this.now(),
      tags: [['p', this.remoteSigner]],
      content: encrypt(JSON.stringify({ id, method, params }), this.key, randomBytes(32)),
    }, this.clientKeyHex)
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => { this.pending.delete(id); rejectPromise(new Error(`signer did not answer ${method} within ${this.timeoutMs} ms`)) }, this.timeoutMs)
      this.pending.set(id, {
        resolve: (response) => { clearTimeout(timer); resolvePromise(response) },
        reject: (error) => { clearTimeout(timer); rejectPromise(error) },
      })
      this.socket.send(JSON.stringify(['EVENT', request]))
    })
  }

  close() {
    try { this.socket?.send(JSON.stringify(['CLOSE', this.subscription])) } catch { /* closed */ }
    try { this.socket?.close() } catch { /* closed */ }
  }
}

// Resolves the signing account behind a bunker URL and requires it to be the
// approved publisher. Throws before returning on any mismatch, interactive
// approval demand, error or timeout. Never requests a signature.
export async function requireSigningAccount({ bunkerUrl, clientKeyHex, expectedPubkeyHex, WebSocketImpl, timeoutMs = 20000, now }) {
  if (!/^[0-9a-f]{64}$/.test(expectedPubkeyHex ?? '')) throw new Error('expected publisher pubkey must be 64-hex')
  const { remoteSigner, relays, secret } = parseBunkerUrl(bunkerUrl)
  let lastError = null
  for (const relay of relays) {
    const conversation = new BunkerConversation({ relay, clientKeyHex, remoteSigner, WebSocketImpl, timeoutMs, now })
    try {
      await conversation.open()
    } catch (error) {
      lastError = error
      continue
    }
    try {
      const connect = await conversation.rpc('connect', secret ? [remoteSigner, secret] : [remoteSigner])
      if (connect.result === 'auth_url') throw new Error('signer requires interactive approval; unattended publication refused')
      if (connect.error && !/already connected/i.test(String(connect.error))) throw new Error(`signer refused connect: ${String(connect.error).slice(0, 200)}`)
      const answer = await conversation.rpc('get_public_key', [])
      if (answer.result === 'auth_url') throw new Error('signer requires interactive approval; unattended publication refused')
      if (answer.error) throw new Error(`signer refused get_public_key: ${String(answer.error).slice(0, 200)}`)
      const account = String(answer.result ?? '').toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(account)) throw new Error('signer returned a malformed account pubkey')
      if (account !== expectedPubkeyHex) throw new Error(`signing account ${account} is not the approved publisher ${expectedPubkeyHex}; refusing before any signature or upload`)
      return { accountPubkey: account, remoteSigner, relay }
    } finally {
      conversation.close()
    }
  }
  throw lastError ?? new Error('no bunker relay could be reached')
}
