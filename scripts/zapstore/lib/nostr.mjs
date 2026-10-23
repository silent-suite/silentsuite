// Nostr event verification and relay subscriptions.
//
// Event ids are recomputed with Node's crypto; Schnorr signatures are checked
// with the pinned @noble/curves package. Relay reads run until EOSE; anything
// else (timeout, close, error) is `RelayIncomplete`, which callers must never
// treat as "absent". Read-only transport failures (no EOSE in time, socket
// error, close before EOSE) are retried a fixed number of times on a fresh
// socket and subscription; a partial answer is discarded, never merged.

import { createHash, randomBytes } from 'node:crypto'

export const RELAY_URL = 'wss://relay.zapstore.dev'
export const KINDS = { APP: 32267, RELEASE: 30063, APK: 3063 }

// Worst case per read: 3 × 20 s EOSE timeout + 2 × 5 s delay = 70 s.
export const RELAY_READ_ATTEMPTS = 3
export const RELAY_RETRY_DELAY_MS = 5000

// `transient` marks transport failures only. Relay refusals (CLOSED),
// malformed frames and a truncated answer are not retried.
export class RelayIncomplete extends Error {
  constructor(message, { transient = false } = {}) {
    super(message)
    this.transient = transient
  }
}
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

// One REQ per attempt, collect EVENT frames until EOSE. `limit` results is
// treated as a possibly truncated answer and reported as incomplete.
export async function queryRelay({ url = RELAY_URL, filters, timeoutMs = 20000, limit = 500, attempts = RELAY_READ_ATTEMPTS, retryDelayMs = RELAY_RETRY_DELAY_MS, WebSocketImpl = globalThis.WebSocket }) {
  if (typeof WebSocketImpl !== 'function') throw new Error('no WebSocket implementation available; pin Node 22 or newer')
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await queryRelayOnce({ url, filters, timeoutMs, limit, WebSocketImpl })
    } catch (error) {
      if (!(error instanceof RelayIncomplete) || !error.transient) throw error
      if (attempt >= attempts) throw new RelayIncomplete(`${error.message} (${attempt} of ${attempts} read-only attempts)`, { transient: true })
      await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelayMs))
    }
  }
}

function queryRelayOnce({ url, filters, timeoutMs, limit, WebSocketImpl }) {
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
    const timer = setTimeout(() => finish(rejectPromise, new RelayIncomplete(`relay ${url} did not send EOSE within ${timeoutMs} ms`, { transient: true })), timeoutMs)
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
    socket.addEventListener('error', () => finish(rejectPromise, new RelayIncomplete(`relay ${url} socket error`, { transient: true })))
    socket.addEventListener('close', () => finish(rejectPromise, new RelayIncomplete(`relay ${url} closed before EOSE`, { transient: true })))
  })
}

export function packageFilters({ pubkeyHex, packageId }) {
  return [
    { kinds: [KINDS.APP], authors: [pubkeyHex], '#d': [packageId] },
    { kinds: [KINDS.RELEASE, KINDS.APK], authors: [pubkeyHex], '#i': [packageId] },
  ]
}
