// The one signing path: account preflight strictly before the publisher runs.

import { requireSigningAccount } from './nip46.mjs'

export async function publishWithPreflight({ bunkerUrl, clientKeyHex, expectedPubkeyHex, preflight = requireSigningAccount, runPublisher }) {
  if (typeof runPublisher !== 'function') throw new Error('runPublisher is required')
  const account = await preflight({ bunkerUrl, clientKeyHex, expectedPubkeyHex })
  if (account?.accountPubkey !== expectedPubkeyHex) throw new Error('preflight did not bind the approved publisher; refusing to run the publisher')
  const run = await runPublisher(account)
  return { account, run }
}
