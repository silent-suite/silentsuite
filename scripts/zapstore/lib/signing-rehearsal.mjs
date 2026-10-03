// Environment-gated signing rehearsal: connection, Blossom upload
// authorization and release signing are exercised and reported separately, and
// nothing is published. Every collaborator is injected so the boundary can be
// tested without a signer, a relay or the publisher.
//
// Signed events never leave this module: the verdict holds counters, kinds and
// the account pubkey only. The caller shreds the publisher's raw output.

import { closeSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs'

import { eventId, KINDS, verifyEvent } from './nostr.mjs'
import { canonicalTags } from './reconcile.mjs'
import { parseEventsJsonl } from './zsp.mjs'
import { redact } from './redact.mjs'

// Same comparison as `cli drift`: only the timestamp-dependent identities (the
// created_at, the id and the release's single link to its own APK) may differ;
// signatures are compared separately by verifyEvent.
function comparable(events) {
  if (events.length !== 3 || Object.values(KINDS).some((kind) => events.filter((e) => e.kind === kind).length !== 1)) throw new Error('event set must contain exactly one app, release and APK')
  const apkId = events.find((e) => e.kind === KINDS.APK).id
  return events.map((original) => {
    const { sig: _sig, ...event } = structuredClone(original)
    if (event.id !== eventId(event)) throw new Error('event identity does not match its content')
    if (event.kind === KINDS.RELEASE) {
      const links = event.tags.filter((tag) => tag[0] === 'e')
      if (links.length !== 1 || links[0][1] !== apkId) throw new Error('release must link its own APK exactly once')
      event.tags = event.tags.map((tag) => tag[0] === 'e' ? [tag[0], '<apk-event-id>', ...tag.slice(2)] : tag)
    }
    event.tags = canonicalTags(event.tags)
    delete event.created_at
    delete event.id
    return JSON.stringify(event)
  }).sort()
}

export function verifySignedReleaseSet(signed, { expectedEvents, expectedPubkeyHex, schnorr }) {
  if (signed.length !== 3) throw new Error(`publisher emitted ${signed.length} events, expected exactly 3`)
  for (const event of signed) {
    try { verifyEvent(event, schnorr) } catch { throw new Error(`signed kind ${event?.kind} event failed id or signature verification`) }
    if (event.pubkey !== expectedPubkeyHex) throw new Error(`signed kind ${event.kind} event is not attributed to the approved publisher`)
  }
  if (JSON.stringify(comparable(signed)) !== JSON.stringify(comparable(expectedEvents))) throw new Error('signed events differ from the prepared exact-release metadata')
  return { kinds: signed.map((e) => e.kind).sort((a, b) => a - b) }
}

export function shredFile(path) {
  if (!path) return
  try {
    const size = statSync(path).size
    const fd = openSync(path, 'r+')
    try { writeSync(fd, Buffer.alloc(size)) } finally { closeSync(fd) }
  } catch { /* best effort */ }
  try { unlinkSync(path) } catch { /* already gone */ }
}

const failure = (error) => ({ status: 'failure', detail: redact(error?.message ?? String(error)).slice(0, 300) })
const notRun = (reason) => ({ status: 'not-run', detail: reason })

export async function runSigningRehearsal({ expectedEvents, expectedPubkeyHex, schnorr, preflight, uploadAuth, signRelease, relayObserved, clock = () => Date.now() }) {
  const verdict = {
    connection: notRun('not attempted'),
    uploadAuthorization: notRun('connection did not bind the approved publisher'),
    releaseSigning: notRun('connection did not bind the approved publisher'),
    relayPostCheck: notRun('no signed release events to look for'),
    publication: 'none: offline signing only; no EVENT to any public relay and no Blossom request',
    unattended: false,
    unattendedNote: 'Run gated by protected-environment approval; signer prompt state is not observable. Not evidence of unattended availability.',
  }

  try {
    const account = await preflight()
    if (account?.accountPubkey !== expectedPubkeyHex) throw new Error('preflight did not bind the approved publisher')
    verdict.connection = { status: 'success', accountPubkey: account.accountPubkey, method: 'connect + get_public_key' }
  } catch (error) {
    verdict.connection = failure(error)
  }

  if (verdict.connection.status === 'success') {
    try {
      const auth = await uploadAuth()
      if (auth?.accountPubkey !== expectedPubkeyHex || auth.signatureValid !== true || auth.transmitted !== false) throw new Error('upload authorization was not verified for the approved publisher')
      verdict.uploadAuthorization = { status: 'success', kind: auth.kind, signatureValid: true, lifetimeSeconds: auth.lifetimeSeconds, latencyMs: auth.latencyMs, scope: 'one unpreimageable blob hash', transmitted: false, retained: false }
    } catch (error) {
      verdict.uploadAuthorization = failure(error)
    }

    let ids = []
    const started = clock()
    try {
      const run = await signRelease()
      const base = { publisherExit: run.status, stdoutBytes: run.stdoutBytes, stderrBytes: run.stderrBytes, durationMs: clock() - started }
      let events = []
      try { events = parseEventsJsonl(run.stdout) } catch { /* reported below */ }
      ids = events.map((e) => e?.id).filter((id) => /^[0-9a-f]{64}$/.test(id ?? ''))
      try {
        if (run.status !== 0) throw new Error(`pinned publisher exited ${run.status} in signed-offline mode`)
        const { kinds } = verifySignedReleaseSet(events, { expectedEvents, expectedPubkeyHex, schnorr })
        verdict.releaseSigning = { status: 'success', ...base, signedEvents: events.length, kinds, signaturesValid: true, accountMatches: true, metadataExact: true, retained: false }
      } catch (error) {
        verdict.releaseSigning = { ...failure(error), ...base, signedEvents: events.length, retained: false }
      }
    } catch (error) {
      verdict.releaseSigning = failure(error)
    }

    if (ids.length) {
      try {
        const observed = await relayObserved(ids)
        verdict.relayPostCheck = { status: observed === 0 ? 'success' : 'failure', signedIdsQueried: ids.length, signedIdsObserved: observed }
      } catch (error) {
        verdict.relayPostCheck = { ...failure(error), signedIdsQueried: ids.length, signedIdsObserved: null }
      }
    }
  }

  const ok = ['connection', 'uploadAuthorization', 'releaseSigning', 'relayPostCheck'].every((phase) => verdict[phase].status === 'success')
  return { status: ok ? 'success' : 'failure', ...verdict }
}
