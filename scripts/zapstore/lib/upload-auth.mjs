// Blossom upload-authorization rehearsal (kind 24242). Never uploaded.
//
// The live publisher asks the signer for a kind-24242 authorization before it
// uploads to Blossom; `zsp --offline` never does. This module requests one such
// signature over the existing encrypted NIP-46 conversation so the signer's
// 24242 permission is exercised without an upload. The authorization names a
// hash whose preimage was discarded at creation, expires within
// MAX_UPLOAD_AUTH_LIFETIME_SECONDS, is verified, and is then dropped: only
// counters leave this module. There is deliberately no HTTP client here.

import { createHash, randomBytes } from 'node:crypto'

import { verifyEvent } from './nostr.mjs'
import { BunkerConversation, KIND_BLOSSOM_AUTH, MAX_UPLOAD_AUTH_LIFETIME_SECONDS, parseBunkerUrl, requireUploadAuthTemplate, UPLOAD_AUTH_METHODS } from './nip46.mjs'

export function uploadAuthTemplate({ now, blobHash, lifetimeSeconds = MAX_UPLOAD_AUTH_LIFETIME_SECONDS }) {
  return requireUploadAuthTemplate({
    kind: KIND_BLOSSOM_AUTH,
    created_at: now,
    content: 'SilentSuite signing rehearsal; never uploaded',
    tags: [['t', 'upload'], ['x', blobHash], ['expiration', String(now + lifetimeSeconds)]],
  })
}

// A blob hash nobody can produce bytes for: the random preimage is zeroed.
export function unpreimageableHash(random = randomBytes) {
  const seed = random(32)
  const hash = createHash('sha256').update(seed).digest('hex')
  seed.fill(0)
  return hash
}

export function requireSignedUploadAuth(signed, { template, expectedPubkeyHex, schnorr }) {
  verifyEvent(signed, schnorr)
  if (signed.pubkey !== expectedPubkeyHex) throw new Error(`upload authorization signed by ${signed.pubkey}, not the approved publisher ${expectedPubkeyHex}`)
  if (signed.kind !== template.kind || signed.created_at !== template.created_at || signed.content !== template.content) throw new Error('signed upload authorization differs from the requested template')
  if (JSON.stringify(signed.tags) !== JSON.stringify(template.tags)) throw new Error('signed upload authorization tags differ from the requested template')
  return { lifetimeSeconds: Number(template.tags[2][1]) - template.created_at }
}

export async function rehearseUploadAuthorization({ bunkerUrl, clientKeyHex, expectedPubkeyHex, schnorr, WebSocketImpl, timeoutMs = 180000, now = () => Math.floor(Date.now() / 1000), random }) {
  if (!/^[0-9a-f]{64}$/.test(expectedPubkeyHex ?? '')) throw new Error('expected publisher pubkey must be 64-hex')
  const { remoteSigner, relays } = parseBunkerUrl(bunkerUrl)
  const template = uploadAuthTemplate({ now: now(), blobHash: unpreimageableHash(random) })
  let lastError = null
  for (const relay of relays) {
    const conversation = new BunkerConversation({ relay, clientKeyHex, remoteSigner, WebSocketImpl, timeoutMs, now, methods: UPLOAD_AUTH_METHODS })
    try {
      await conversation.open()
    } catch (error) {
      lastError = error
      continue
    }
    const started = Date.now()
    try {
      const answer = await conversation.rpc('sign_event', [JSON.stringify(template)])
      if (answer.result === 'auth_url') throw new Error('signer requires interactive approval for kind 24242')
      if (answer.error) throw new Error(`signer refused kind 24242: ${String(answer.error).slice(0, 200)}`)
      let signed
      try { signed = JSON.parse(String(answer.result ?? '')) } catch { throw new Error('signer returned a malformed kind-24242 event') }
      const { lifetimeSeconds } = requireSignedUploadAuth(signed, { template, expectedPubkeyHex, schnorr })
      signed.sig = ''
      return { kind: KIND_BLOSSOM_AUTH, accountPubkey: expectedPubkeyHex, signatureValid: true, lifetimeSeconds, latencyMs: Date.now() - started, transmitted: false }
    } finally {
      conversation.close()
    }
  }
  throw lastError ?? new Error('no bunker relay could be reached')
}
