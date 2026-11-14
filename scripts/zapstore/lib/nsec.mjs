// Local signing-account preflight for an `nsec1…` publisher key (owner decision
// 2026-11-14: unattended publication with the key as a `zapstore-production`
// environment secret instead of a NIP-46 bunker). The key is decoded in memory,
// its public key derived and compared with the approved publisher before the
// pinned publisher runs. Errors never echo key material.

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

function polymod(values) {
  let chk = 1
  for (const value of values) {
    const top = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ value
    for (let i = 0; i < 5; i += 1) if ((top >>> i) & 1) chk ^= GENERATORS[i]
  }
  return chk
}

const hrpExpand = (hrp) => [...[...hrp].map((c) => c.charCodeAt(0) >>> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)]

// Strict BIP-173 bech32 decode of exactly one 32-byte `nsec` payload.
export function decodeNsec(nsec) {
  if (typeof nsec !== 'string' || !/^nsec1[02-9ac-hj-np-z]{58}$/.test(nsec)) throw new Error('signing key is not a well-formed nsec1 key')
  const data = [...nsec.slice(5)].map((c) => CHARSET.indexOf(c))
  if (polymod([...hrpExpand('nsec'), ...data]) !== 1) throw new Error('signing key checksum is invalid')
  const words = data.slice(0, -6)
  let acc = 0
  let bits = 0
  const bytes = []
  for (const word of words) {
    acc = (acc << 5) | word
    bits += 5
    while (bits >= 8) {
      bits -= 8
      bytes.push((acc >>> bits) & 0xff)
    }
  }
  if (bytes.length !== 32 || bits >= 5 || (acc & ((1 << bits) - 1)) !== 0) throw new Error('signing key payload is not 32 bytes')
  return Uint8Array.from(bytes)
}

export function nsecPublicKeyHex(nsec, schnorr) {
  const secret = decodeNsec(nsec)
  try {
    return Buffer.from(schnorr.getPublicKey(secret)).toString('hex')
  } catch {
    throw new Error('signing key is not a valid secp256k1 private key')
  } finally {
    secret.fill(0)
  }
}

// Same contract as nip46.requireSigningAccount: resolves the signing account or
// throws before anything is signed.
export async function requireNsecAccount({ nsec, expectedPubkeyHex, schnorr }) {
  const accountPubkey = nsecPublicKeyHex(nsec, schnorr)
  if (accountPubkey !== expectedPubkeyHex) throw new Error(`signing key belongs to ${accountPubkey}, not the approved publisher ${expectedPubkeyHex}; refusing to publish`)
  return { accountPubkey, remoteSigner: 'local nsec' }
}
