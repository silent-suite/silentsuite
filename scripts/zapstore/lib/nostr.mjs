// Nostr event verification and relay subscriptions.
//
// Event ids are recomputed with Node's crypto; Schnorr signatures are checked
// with the pinned @noble/curves package. Relay reads run until EOSE; anything
// else (timeout, close, error) is `RelayIncomplete`, which callers must never
// treat as "absent".

import { createHash, randomBytes } from 'node:crypto'

export const RELAY_URL = 'wss://relay.zapstore.dev'
export const KINDS = { APP: 32267, RELEASE: 30063, APK: 3063 }

export class RelayIncomplete extends Error {}
export class InvalidRelayEvent extends Error {}

export function serializeForId(event) {
  return JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])
}

export function eventId(event) {
  return createHash('sha256').update(serializeForId(event)).digest('hex')
}

export async function loadSchnorr() {
  const { schnorr } = await import('@noble/curves/secp256k1.js')
  return schnorr
}

const hexToBytes = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'))

export function verifyEvent(event, schnorr) {
  if (!event || typeof event !== 'object') throw new InvalidRelayEvent('event is not an object')
  for (const key of ['id', 'pubkey', 'sig']) if (typeof event[key] !== 'string') throw new InvalidRelayEvent(`event ${key} missing`)
  if (!/^[0-9a-f]{64}$/.test(event.id) || !/^[0-9a-f]{64}$/.test(event.pubkey) || !/^[0-9a-f]{128}$/.test(event.sig)) throw new InvalidRelayEvent('event id/pubkey/sig are not well-formed hex')
  if (!Number.isInteger(event.kind) || !Number.isInteger(event.created_at) || !Array.isArray(event.tags) || typeof event.content !== 'string') throw new InvalidRelayEvent('event fields malformed')
  if (eventId(event) !== event.id) throw new InvalidRelayEvent(`event ${event.id} id does not match its content`)
  let ok = false
  try { ok = schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey)) } catch { ok = false }
  if (!ok) throw new InvalidRelayEvent(`event ${event.id} carries an invalid signature`)
  return true
}

export const tagValue = (event, name) => (event.tags.find((tag) => tag[0] === name) ?? [])[1]
export const tagValues = (event, name) => event.tags.filter((tag) => tag[0] === name).map((tag) => tag[1])

// One REQ, collect EVENT frames until EOSE. `limit` results is treated as a
// possibly truncated answer and reported as incomplete.
export function queryRelay({ url = RELAY_URL, filters, timeoutMs = 20000, limit = 500, WebSocketImpl = globalThis.WebSocket }) {
  if (typeof WebSocketImpl !== 'function') throw new Error('no WebSocket implementation available; pin Node 22 or newer')
  return new Promise((resolvePromise, rejectPromise) => {
    const subscription = randomBytes(8).toString('hex')
    const events = []
    let settled = false
    const socket = new WebSocketImpl(url)
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch { /* already closed */ }
      fn(value)
    }
    const timer = setTimeout(() => finish(rejectPromise, new RelayIncomplete(`relay ${url} did not send EOSE within ${timeoutMs} ms`)), timeoutMs)
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify(['REQ', subscription, ...filters.map((f) => ({ ...f, limit }))]))
    })
    socket.addEventListener('message', (message) => {
      let frame
      try { frame = JSON.parse(typeof message.data === 'string' ? message.data : Buffer.from(message.data).toString('utf8')) } catch { return finish(rejectPromise, new RelayIncomplete('relay sent a non-JSON frame')) }
      if (!Array.isArray(frame)) return finish(rejectPromise, new RelayIncomplete('relay sent a non-array frame'))
      if (frame[0] === 'EVENT' && frame[1] === subscription) events.push(frame[2])
      else if (frame[0] === 'EOSE' && frame[1] === subscription) {
        if (events.length >= limit) return finish(rejectPromise, new RelayIncomplete(`relay returned ${events.length} events, reaching the limit; result may be truncated`))
        finish(resolvePromise, { events, eose: true })
      } else if (frame[0] === 'CLOSED' && frame[1] === subscription) finish(rejectPromise, new RelayIncomplete(`relay closed the subscription: ${String(frame[2] ?? '')}`))
      else if (frame[0] === 'NOTICE') { /* informational */ }
    })
    socket.addEventListener('error', () => finish(rejectPromise, new RelayIncomplete(`relay ${url} socket error`)))
    socket.addEventListener('close', () => finish(rejectPromise, new RelayIncomplete(`relay ${url} closed before EOSE`)))
  })
}

export function packageFilters({ pubkeyHex, packageId }) {
  return [
    { kinds: [KINDS.APP], authors: [pubkeyHex], '#d': [packageId] },
    { kinds: [KINDS.RELEASE, KINDS.APK], authors: [pubkeyHex], '#i': [packageId] },
  ]
}
