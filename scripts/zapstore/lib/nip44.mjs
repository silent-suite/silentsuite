// NIP-44 v2 encrypted payloads, used only for the read-only NIP-46 handshake.
// secp256k1 ECDH x-coordinate -> HKDF-extract (salt "nip44-v2") conversation
// key; per-message HKDF-expand(nonce, 76) -> ChaCha20 key/nonce + HMAC key;
// padded plaintext; base64(version 2 || nonce || ciphertext || mac).
// Verified in tests against the published NIP-44 test vectors.

import { chacha20 } from '@noble/ciphers/chacha.js'
import { extract, expand } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { timingSafeEqual } from 'node:crypto'

const VERSION = 2
const MIN_PLAINTEXT = 1
const MAX_PLAINTEXT = 65535
const utf8 = new TextEncoder()
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

export const hexToBytes = (hex) => {
  if (typeof hex !== 'string' || !/^[0-9a-f]*$/.test(hex) || hex.length % 2) throw new Error('not lowercase hex')
  return Uint8Array.from(Buffer.from(hex, 'hex'))
}
export const bytesToHex = (bytes) => Buffer.from(bytes).toString('hex')

export function conversationKey(privateKeyHex, publicKeyHex) {
  const shared = secp256k1.getSharedSecret(hexToBytes(privateKeyHex), hexToBytes('02' + publicKeyHex), true)
  return extract(sha256, shared.subarray(1, 33), utf8.encode('nip44-v2'))
}

export function messageKeys(key, nonce) {
  if (key.length !== 32) throw new Error('conversation key must be 32 bytes')
  if (nonce.length !== 32) throw new Error('nonce must be 32 bytes')
  const material = expand(sha256, key, nonce, 76)
  return { chachaKey: material.subarray(0, 32), chachaNonce: material.subarray(32, 44), hmacKey: material.subarray(44, 76) }
}

export function calcPaddedLen(length) {
  if (!Number.isInteger(length) || length < 1) throw new Error('expected positive integer')
  if (length <= 32) return 32
  const nextPower = 1 << (Math.floor(Math.log2(length - 1)) + 1)
  const chunk = nextPower <= 256 ? 32 : nextPower / 8
  return chunk * (Math.floor((length - 1) / chunk) + 1)
}

function pad(plaintext) {
  const bytes = utf8.encode(plaintext)
  if (bytes.length < MIN_PLAINTEXT || bytes.length > MAX_PLAINTEXT) throw new Error('invalid plaintext size')
  const out = new Uint8Array(2 + calcPaddedLen(bytes.length))
  out[0] = bytes.length >> 8
  out[1] = bytes.length & 0xff
  out.set(bytes, 2)
  return out
}

function unpad(padded) {
  const length = (padded[0] << 8) | padded[1]
  if (length < MIN_PLAINTEXT || length > MAX_PLAINTEXT || padded.length !== 2 + calcPaddedLen(length)) throw new Error('invalid padding')
  return utf8Decoder.decode(padded.subarray(2, 2 + length))
}

function mac(hmacKey, nonce, ciphertext) {
  const aad = new Uint8Array(nonce.length + ciphertext.length)
  aad.set(nonce, 0)
  aad.set(ciphertext, nonce.length)
  return hmac(sha256, hmacKey, aad)
}

export function encrypt(plaintext, key, nonce) {
  if (!(nonce instanceof Uint8Array) || nonce.length !== 32) throw new Error('a 32-byte nonce is required')
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(key, nonce)
  const ciphertext = chacha20(chachaKey, chachaNonce, pad(plaintext))
  const tag = mac(hmacKey, nonce, ciphertext)
  const payload = new Uint8Array(1 + 32 + ciphertext.length + 32)
  payload[0] = VERSION
  payload.set(nonce, 1)
  payload.set(ciphertext, 33)
  payload.set(tag, 33 + ciphertext.length)
  return Buffer.from(payload).toString('base64')
}

export function decrypt(payload, key) {
  if (typeof payload !== 'string') throw new Error('payload must be a string')
  if (payload.startsWith('#')) throw new Error('unknown encryption version')
  if (payload.length < 132 || payload.length > 87472) throw new Error('invalid payload length')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) throw new Error('invalid base64')
  const bytes = Uint8Array.from(Buffer.from(payload, 'base64'))
  if (bytes.length < 99 || bytes.length > 65603) throw new Error('invalid data length')
  if (bytes[0] !== VERSION) throw new Error('unknown encryption version')
  const nonce = bytes.subarray(1, 33)
  const ciphertext = bytes.subarray(33, bytes.length - 32)
  const tag = bytes.subarray(bytes.length - 32)
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(key, nonce)
  const expected = mac(hmacKey, nonce, ciphertext)
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(tag))) throw new Error('invalid MAC')
  return unpad(chacha20(chachaKey, chachaNonce, ciphertext))
}
