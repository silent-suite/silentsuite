// NIP-46 client key custody for the duration of one job.
//
// zsp persists its client key at $XDG_CONFIG_HOME/zsp/bunker-keys/<target>.key.
// The key is a client capability (not the Nostr identity key) and is provided
// through a protected environment secret, written with mode 0600 and removed in
// a finally block. It is never cached, printed or uploaded.

import { mkdirSync, openSync, writeSync, closeSync, unlinkSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

export function bunkerTargetPubkey(bunkerUrl) {
  let parsed
  try { parsed = new URL(bunkerUrl) } catch { throw new Error('bunker URL is not a URL') }
  if (parsed.protocol !== 'bunker:') throw new Error('signer URL must use the bunker:// scheme')
  const host = parsed.hostname.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(host)) throw new Error('bunker URL does not name a 64-hex remote signer public key')
  return host
}

export function clientKeyPath({ xdgConfigHome, bunkerUrl }) {
  return join(xdgConfigHome, 'zsp', 'bunker-keys', `${bunkerTargetPubkey(bunkerUrl)}.key`)
}

export function materializeClientKey({ xdgConfigHome, bunkerUrl, clientKey }) {
  if (typeof clientKey !== 'string' || !/^[0-9a-f]{64}$/.test(clientKey.trim())) throw new Error('ZAPSTORE_BUNKER_CLIENT_KEY is missing or not a 64-hex key; refusing to publish')
  const path = clientKeyPath({ xdgConfigHome, bunkerUrl })
  mkdirSync(join(xdgConfigHome, 'zsp', 'bunker-keys'), { recursive: true, mode: 0o700 })
  if (existsSync(path)) throw new Error('client key file already exists; refusing to overwrite')
  const fd = openSync(path, 'wx', 0o600)
  try { writeSync(fd, clientKey.trim() + '\n') } finally { closeSync(fd) }
  const mode = statSync(path).mode & 0o777
  if (mode !== 0o600) { unlinkSync(path); throw new Error(`client key file mode is ${mode.toString(8)}, expected 600`) }
  return {
    path,
    cleanup() {
      try {
        const fdz = openSync(path, 'w')
        try { writeSync(fdz, '0'.repeat(65)) } finally { closeSync(fdz) }
      } catch { /* best effort */ }
      try { unlinkSync(path) } catch { /* already gone */ }
    },
  }
}
