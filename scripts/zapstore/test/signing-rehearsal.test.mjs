// Signing rehearsal boundary: admission, the kind-24242 request bounds, the
// offline-signed release check, separate phase reporting and the no-publication
// contract. Everything runs against in-process fakes; no signer, relay or
// publisher is contacted.

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { schnorr } from '@noble/curves/secp256k1.js'

import { bytesToHex, conversationKey, decrypt, encrypt, hexToBytes } from '../lib/nip44.mjs'
import { BunkerConversation, KIND_NOSTR_CONNECT, MAX_UPLOAD_AUTH_LIFETIME_SECONDS, READ_ONLY_METHODS, requireUploadAuthTemplate, UPLOAD_AUTH_METHODS } from '../lib/nip46.mjs'
import { rehearseUploadAuthorization, unpreimageableHash, uploadAuthTemplate } from '../lib/upload-auth.mjs'
import { runSigningRehearsal, verifySignedReleaseSet } from '../lib/signing-rehearsal.mjs'
import { requireManualRehearsal, requireManualSigningRehearsal, requireProtectedSchedule, SIGNING_REHEARSAL_WORKFLOW_PATH } from '../lib/dispatch.mjs'
import { eventId, verifyEvent } from '../lib/nostr.mjs'
import { zspArgs, zspEnv } from '../lib/zsp.mjs'

const here = resolve(new URL('.', import.meta.url).pathname)
const cli = join(here, '..', 'cli.mjs')
const pub = (sec) => bytesToHex(schnorr.getPublicKey(hexToBytes(sec)))
const RESPONDER = '1'.repeat(64)
const CLIENT = '2'.repeat(64)
const ACCOUNT_SEC = '3'.repeat(64)
const ACCOUNT = pub(ACCOUNT_SEC)
const OTHER_SEC = '4'.repeat(64)
const SIGNER_RELAY = 'wss://signer-relay.example'
const bunkerUrl = `bunker://${pub(RESPONDER)}?relay=${encodeURIComponent(SIGNER_RELAY)}&secret=s3cret`
const NOW = 1_790_000_000

function signAs(event, sec) {
  const signed = { ...event, pubkey: pub(sec) }
  signed.id = eventId(signed)
  signed.sig = bytesToHex(schnorr.sign(hexToBytes(signed.id), hexToBytes(sec)))
  return signed
}

// ---------------------------------------------------------------- admission

test('signing rehearsal admission: only a main workflow_dispatch of its own file; other admissions refuse it', () => {
  const repository = 'silent-suite/silentsuite'
  const sha = 'c'.repeat(40)
  const base = { eventName: 'workflow_dispatch', ref: 'refs/heads/main', workflowRef: `${repository}/${SIGNING_REHEARSAL_WORKFLOW_PATH}@refs/heads/main`, sha, workflowSha: sha, repository }
  assert.deepEqual(requireManualSigningRehearsal(base), { revision: sha })
  const refusals = [
    [{ eventName: 'schedule' }, /is not workflow_dispatch/],
    [{ eventName: 'repository_dispatch' }, /is not workflow_dispatch/],
    [{ ref: 'refs/heads/feat' }, /is not refs\/heads\/main/],
    [{ ref: 'refs/tags/v0.5.6-beta' }, /is not refs\/heads\/main/],
    [{ workflowRef: `${repository}/.github/workflows/zapstore-rehearsal.yml@refs/heads/main` }, /GITHUB_WORKFLOW_REF/],
    [{ workflowRef: `${repository}/.github/workflows/zapstore-publish.yml@refs/heads/main` }, /GITHUB_WORKFLOW_REF/],
    [{ workflowRef: `${repository}/${SIGNING_REHEARSAL_WORKFLOW_PATH}@refs/heads/feat` }, /GITHUB_WORKFLOW_REF/],
    [{ workflowSha: 'a'.repeat(40) }, /is not the run commit/],
    [{ sha: 'nothex', workflowSha: 'nothex' }, /40-hex/],
  ]
  for (const [override, pattern] of refusals) assert.throws(() => requireManualSigningRehearsal({ ...base, ...override }), pattern, JSON.stringify(override))
  assert.throws(() => requireManualRehearsal(base), /GITHUB_WORKFLOW_REF/, 'the assessment rehearsal refuses the signing file')
  assert.throws(() => requireProtectedSchedule({ ...base, eventName: 'schedule' }), /zapstore-publish\.yml/, 'the scheduled admission refuses the signing file')
})

function run(command, extraArgs = [], env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zapstore-cli-'))
  const out = join(dir, 'out'); const sum = join(dir, 'summary')
  writeFileSync(out, ''); writeFileSync(sum, '')
  const result = spawnSync(process.execPath, [cli, command, ...extraArgs], { env: { PATH: process.env.PATH, HOME: dir, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum, ...env }, encoding: 'utf8' })
  return { ...result, outputs: readFileSync(out, 'utf8'), summary: readFileSync(sum, 'utf8') }
}

test('cli admit-signing-rehearsal emits only the revision; select-signing-release binds only the newest eligible release', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zapstore-repo-'))
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example' } })
  git('init', '-q'); writeFileSync(join(dir, 'a.txt'), 'a\n'); git('add', 'a.txt'); git('commit', '-q', '-m', 'one')
  const head = git('rev-parse', 'HEAD').trim()
  const ref = `silent-suite/silentsuite/${SIGNING_REHEARSAL_WORKFLOW_PATH}@refs/heads/main`
  const base = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'silent-suite/silentsuite', GITHUB_WORKFLOW_REF: ref, GITHUB_SHA: head, GITHUB_WORKFLOW_SHA: head }
  const ok = run('admit-signing-rehearsal', ['--workspace', dir], { ...base, ZAPSTORE_AUTOMATION_ENABLED: 'enabled' })
  assert.equal(ok.status, 0, ok.stderr)
  assert.equal(ok.outputs, `revision=${head}\n`)
  assert.match(ok.summary, /NO PUBLICATION/)
  assert.match(ok.summary, /not evidence of unattended signing/)
  for (const [label, env] of [['schedule', { GITHUB_EVENT_NAME: 'schedule' }], ['assessment file', { GITHUB_WORKFLOW_REF: ref.replace('zapstore-signing-rehearsal', 'zapstore-rehearsal') }], ['branch', { GITHUB_REF: 'refs/heads/feat' }], ['wrong checkout', { GITHUB_SHA: 'b'.repeat(40), GITHUB_WORKFLOW_SHA: 'b'.repeat(40) }]]) {
    const refused = run('admit-signing-rehearsal', ['--workspace', dir], { ...base, ...env })
    assert.notEqual(refused.status, 0, label)
    assert.equal(refused.outputs, '', `${label} emits nothing`)
  }
  assert.notEqual(run('admit', ['--workspace', dir], { ...base, GITHUB_EVENT_NAME: 'schedule', ZAPSTORE_AUTOMATION_ENABLED: 'enabled' }).status, 0, 'the scheduled admission refuses this file')

  const candidates = join(dir, 'candidates.json')
  writeFileSync(candidates, JSON.stringify({ candidates: [{ releaseId: 300, tag: 'v0.5.7-beta', publishable: true }, { releaseId: 200, tag: 'v0.5.6-beta', publishable: false }], omitted: [] }))
  const selected = run('select-signing-release', ['--candidates', candidates, '--release-id', '300'])
  assert.equal(selected.status, 0, selected.stderr)
  assert.equal(selected.outputs, 'release_id=300\ntag=v0.5.7-beta\n')
  for (const id of ['200', '0300', '30 0', '-1', '', '300;id']) {
    const refused = run('select-signing-release', ['--candidates', candidates, '--release-id', id])
    assert.notEqual(refused.status, 0, id)
    assert.equal(refused.outputs, '', id)
  }
  writeFileSync(candidates, JSON.stringify({ candidates: [{ releaseId: 300, tag: 'a', publishable: true }, { releaseId: 301, tag: 'b', publishable: true }] }))
  assert.match(run('select-signing-release', ['--candidates', candidates, '--release-id', '300']).stderr, /exactly one newest eligible release, found 2/)
})

test('cli sign-rehearsal refuses without signer credentials before reading any input', () => {
  const refused = run('sign-rehearsal', ['--binding', '/nonexistent', '--expected', '/nonexistent', '--zsp', '/nonexistent', '--work-dir', '/nonexistent', '--out', '/nonexistent'])
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /signer credentials are missing/)
  assert.equal(refused.outputs, '')
})

// ---------------------------------------------------- pinned publisher mode

test('signed-offline publisher mode is --offline with a bunker only, never a live overwrite', () => {
  const args = zspArgs({ configPath: '/tmp/c.yaml', commit: 'a'.repeat(40), mode: 'signed-offline' })
  assert.ok(args.includes('--offline'))
  assert.ok(!args.includes('--overwrite-release'))
  assert.equal(args.at(-1), '/tmp/c.yaml')
  assert.equal(zspEnv({ mode: 'signed-offline', signWith: bunkerUrl, xdgConfigHome: '/tmp/x' }).SIGN_WITH, bunkerUrl)
  assert.throws(() => zspEnv({ mode: 'signed-offline', signWith: 'nsec1abc', xdgConfigHome: '/tmp/x' }), /bunker:\/\//)
  assert.throws(() => zspEnv({ mode: 'signed-offline', signWith: '', xdgConfigHome: '/tmp/x' }), /missing/)
})

// ------------------------------------------------- kind-24242 request bounds

test('upload authorization template: one kind, one blob hash, upload verb, expiry within 120 s, nothing else', () => {
  const hash = 'ab'.repeat(32)
  const good = uploadAuthTemplate({ now: NOW, blobHash: hash })
  assert.deepEqual(good.tags, [['t', 'upload'], ['x', hash], ['expiration', String(NOW + 120)]])
  assert.equal(MAX_UPLOAD_AUTH_LIFETIME_SECONDS, 120)
  const bad = [
    [{ ...good, kind: 30063 }, /only 24242/],
    [{ ...good, kind: 1 }, /only 24242/],
    [{ ...good, pubkey: ACCOUNT }, /unexpected fields/],
    [{ ...good, tags: [['t', 'upload'], ['x', hash], ['expiration', String(NOW + 121)]] }, /lifetime 121/],
    [{ ...good, tags: [['t', 'upload'], ['x', hash], ['expiration', String(NOW)]] }, /lifetime 0/],
    [{ ...good, tags: [['t', 'delete'], ['x', hash], ['expiration', String(NOW + 60)]] }, /upload verb/],
    [{ ...good, tags: [['t', 'upload'], ['x', 'zz'], ['expiration', String(NOW + 60)]] }, /one blob hash/],
    [{ ...good, tags: [['t', 'upload'], ['x', hash], ['x', hash], ['expiration', String(NOW + 60)]] }, /exactly the t, x and expiration/],
    [{ ...good, tags: [['t', 'upload'], ['x', hash]] }, /exactly the t, x and expiration/],
    [{ ...good, tags: [['t', 'upload'], ['x', hash], ['expiration', '1e10']] }, /expiration/],
  ]
  for (const [template, pattern] of bad) assert.throws(() => requireUploadAuthTemplate(template), pattern, JSON.stringify(template.tags ?? template.kind))
  const a = unpreimageableHash(); const b = unpreimageableHash()
  assert.match(a, /^[0-9a-f]{64}$/)
  assert.notEqual(a, b)
})

// In-process NIP-46 responder. `opened` records every socket URL; `variant`
// decides how a sign_event is answered.
function fakeSigner({ variant = 'ok', log = [], opened = [] } = {}) {
  return class FakeSocket {
    constructor(url) {
      opened.push(url)
      this.listeners = {}
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
      assert.ok(verifyEvent(request, schnorr))
      assert.equal(request.kind, KIND_NOSTR_CONNECT)
      const rpc = JSON.parse(decrypt(request.content, conversationKey(RESPONDER, request.pubkey)))
      assert.equal(rpc.method, 'sign_event')
      const template = JSON.parse(rpc.params[0])
      let body
      if (variant === 'auth_url') body = { id: rpc.id, result: 'auth_url', error: 'https://signer.example/approve' }
      else if (variant === 'refuse') body = { id: rpc.id, result: '', error: 'kind 24242 not allowed' }
      else if (variant === 'garbage') body = { id: rpc.id, result: 'not json', error: '' }
      else {
        let event = { ...template }
        if (variant === 'widened') event.tags = [['t', 'upload'], ['expiration', String(template.created_at + 86400)]]
        let signed = signAs(event, variant === 'other-account' ? OTHER_SEC : ACCOUNT_SEC)
        if (variant === 'bad-sig') signed = { ...signed, sig: signed.sig.replace(/^./, (c) => (c === '0' ? '1' : '0')) }
        body = { id: rpc.id, result: JSON.stringify(signed), error: '' }
      }
      const response = signAs({ kind: KIND_NOSTR_CONNECT, created_at: NOW, tags: [['p', request.pubkey]], content: encrypt(JSON.stringify(body), conversationKey(RESPONDER, request.pubkey), new Uint8Array(32).fill(9)) }, RESPONDER)
      queueMicrotask(() => this.listeners.message?.({ data: JSON.stringify(['EVENT', this.subscription, response]) }))
    }
  }
}

test('conversation method sets are closed: read-only by default, upload-auth sends only bounded kind-24242 sign_event', async () => {
  assert.throws(() => new BunkerConversation({ relay: SIGNER_RELAY, clientKeyHex: CLIENT, remoteSigner: pub(RESPONDER), WebSocketImpl: fakeSigner(), methods: ['sign_event'] }), /READ_ONLY_METHODS or UPLOAD_AUTH_METHODS/)
  const readOnly = new BunkerConversation({ relay: SIGNER_RELAY, clientKeyHex: CLIENT, remoteSigner: pub(RESPONDER), WebSocketImpl: fakeSigner() })
  assert.equal(readOnly.methods, READ_ONLY_METHODS)
  await readOnly.open()
  assert.throws(() => readOnly.rpc('sign_event', [JSON.stringify(uploadAuthTemplate({ now: NOW, blobHash: 'ab'.repeat(32) }))]), /not a read-only handshake method/)
  readOnly.close()
  const log = []
  const auth = new BunkerConversation({ relay: SIGNER_RELAY, clientKeyHex: CLIENT, remoteSigner: pub(RESPONDER), WebSocketImpl: fakeSigner({ log }), methods: UPLOAD_AUTH_METHODS })
  await auth.open()
  for (const method of ['connect', 'get_public_key', 'nip44_encrypt', 'nip04_decrypt']) assert.throws(() => auth.rpc(method, []), /not permitted on this conversation/, method)
  const release = { kind: 30063, created_at: NOW, content: '', tags: [['t', 'upload'], ['x', 'ab'.repeat(32)], ['expiration', String(NOW + 60)]] }
  assert.throws(() => auth.rpc('sign_event', [JSON.stringify(release)]), /only 24242/)
  assert.throws(() => auth.rpc('sign_event', [{ kind: 24242 }]), /exactly one serialized template/)
  assert.throws(() => auth.rpc('sign_event', ['{']), /not JSON/)
  auth.close()
  assert.equal(log.filter((f) => f[0] === 'EVENT').length, 0, 'refused requests never reach the signer')
})

test('upload authorization rehearsal: verified, bounded, never transmitted beyond the signer relay; every bad answer is refused', async () => {
  const log = []; const opened = []
  const ok = await rehearseUploadAuthorization({ bunkerUrl, clientKeyHex: CLIENT, expectedPubkeyHex: ACCOUNT, schnorr, WebSocketImpl: fakeSigner({ log, opened }), timeoutMs: 500, now: () => NOW })
  assert.deepEqual(Object.keys(ok).sort(), ['accountPubkey', 'kind', 'latencyMs', 'lifetimeSeconds', 'signatureValid', 'transmitted'])
  assert.equal(ok.kind, 24242)
  assert.equal(ok.lifetimeSeconds, 120)
  assert.equal(ok.transmitted, false)
  assert.deepEqual(opened, [SIGNER_RELAY], 'only the signer relay is ever opened; no Blossom or public relay')
  const sent = log.filter((f) => f[0] === 'EVENT')
  assert.equal(sent.length, 1)
  assert.equal(sent[0][1].kind, KIND_NOSTR_CONNECT, 'the only outbound event is the encrypted signer request')
  const cases = [['other-account', /not the approved publisher/], ['widened', /tags differ/], ['bad-sig', /invalid signature/], ['auth_url', /interactive approval/], ['refuse', /refused kind 24242/], ['garbage', /malformed kind-24242/]]
  for (const [variant, pattern] of cases) {
    await assert.rejects(rehearseUploadAuthorization({ bunkerUrl, clientKeyHex: CLIENT, expectedPubkeyHex: ACCOUNT, schnorr, WebSocketImpl: fakeSigner({ variant }), timeoutMs: 500, now: () => NOW }), pattern, variant)
  }
})

// --------------------------------------------- offline-signed release check

function eventSet({ createdAt, sec, content = 'SilentSuite description' }) {
  const finalize = (event) => {
    const e = { ...event, pubkey: pub(sec), created_at: createdAt }
    e.id = eventId(e)
    return e
  }
  const apk = finalize({ kind: 3063, tags: [['i', 'io.silentsuite.android'], ['x', 'a'.repeat(64)], ['f', 'android-arm64-v8a'], ['f', 'android-x86_64']], content: '' })
  const release = finalize({ kind: 30063, tags: [['d', 'io.silentsuite.android@0.5.7-beta'], ['i', 'io.silentsuite.android'], ['e', apk.id, 'wss://relay.zapstore.dev']], content: 'notes' })
  const app = finalize({ kind: 32267, tags: [['d', 'io.silentsuite.android'], ['name', 'SilentSuite']], content })
  return [app, release, apk]
}
const signSet = (events, sec) => events.map((e) => ({ ...e, sig: bytesToHex(schnorr.sign(hexToBytes(e.id), hexToBytes(sec))) }))

test('offline-signed release set must be valid, signed by the publisher, and equal to the prepared metadata', () => {
  const expected = eventSet({ createdAt: NOW, sec: ACCOUNT_SEC })
  const signed = signSet(eventSet({ createdAt: NOW + 30, sec: ACCOUNT_SEC }), ACCOUNT_SEC)
  assert.deepEqual(verifySignedReleaseSet([signed[2], signed[0], signed[1]], { expectedEvents: expected, expectedPubkeyHex: ACCOUNT, schnorr }), { kinds: [3063, 30063, 32267] })
  assert.throws(() => verifySignedReleaseSet(signed.slice(0, 2), { expectedEvents: expected, expectedPubkeyHex: ACCOUNT, schnorr }), /emitted 2 events/)
  const tampered = signed.map((e, i) => (i === 0 ? { ...e, sig: e.sig.replace(/^./, (c) => (c === '0' ? '1' : '0')) } : e))
  assert.throws(() => verifySignedReleaseSet(tampered, { expectedEvents: expected, expectedPubkeyHex: ACCOUNT, schnorr }), /signature verification/)
  const foreign = signSet(eventSet({ createdAt: NOW + 30, sec: OTHER_SEC }), OTHER_SEC)
  assert.throws(() => verifySignedReleaseSet(foreign, { expectedEvents: expected, expectedPubkeyHex: ACCOUNT, schnorr }), /not attributed to the approved publisher/)
  const drifted = signSet(eventSet({ createdAt: NOW + 30, sec: ACCOUNT_SEC, content: 'other copy' }), ACCOUNT_SEC)
  assert.throws(() => verifySignedReleaseSet(drifted, { expectedEvents: expected, expectedPubkeyHex: ACCOUNT, schnorr }), /differ from the prepared exact-release metadata/)
})

test('phases are reported separately, fail closed, and the verdict never carries signed material', async () => {
  const expected = eventSet({ createdAt: NOW, sec: ACCOUNT_SEC })
  const signed = signSet(eventSet({ createdAt: NOW + 30, sec: ACCOUNT_SEC }), ACCOUNT_SEC)
  const stdout = signed.map((e) => JSON.stringify(e)).join('\n') + '\n'
  const calls = []
  const deps = (overrides = {}) => ({
    expectedEvents: expected,
    expectedPubkeyHex: ACCOUNT,
    schnorr,
    preflight: async () => { calls.push('preflight'); return { accountPubkey: ACCOUNT } },
    uploadAuth: async () => { calls.push('uploadAuth'); return { kind: 24242, accountPubkey: ACCOUNT, signatureValid: true, lifetimeSeconds: 120, latencyMs: 5, transmitted: false } },
    signRelease: async () => { calls.push('signRelease'); return { status: 0, stdout, stdoutBytes: stdout.length, stderrBytes: 0 } },
    relayObserved: async (ids) => { calls.push(`relay:${ids.length}`); return 0 },
    ...overrides,
  })
  const ok = await runSigningRehearsal(deps())
  assert.equal(ok.status, 'success')
  assert.deepEqual(calls, ['preflight', 'uploadAuth', 'signRelease', 'relay:3'])
  assert.equal(ok.unattended, false)
  assert.match(ok.publication, /^none/)
  assert.equal(ok.releaseSigning.metadataExact, true)
  assert.equal(ok.uploadAuthorization.transmitted, false)
  const text = JSON.stringify(ok)
  for (const event of signed) {
    assert.ok(!text.includes(event.sig), 'no signature in the verdict')
    assert.ok(!text.includes(event.id), 'no signed event id in the verdict')
  }

  calls.length = 0
  const noConnection = await runSigningRehearsal(deps({ preflight: async () => { calls.push('preflight'); throw new Error('signing account f is not the approved publisher') } }))
  assert.equal(noConnection.status, 'failure')
  assert.equal(noConnection.connection.status, 'failure')
  assert.equal(noConnection.uploadAuthorization.status, 'not-run')
  assert.equal(noConnection.releaseSigning.status, 'not-run')
  assert.deepEqual(calls, ['preflight'], 'nothing is signed without a bound account')

  const wrongAccount = await runSigningRehearsal(deps({ preflight: async () => ({ accountPubkey: pub(OTHER_SEC) }) }))
  assert.equal(wrongAccount.connection.status, 'failure')
  assert.equal(wrongAccount.releaseSigning.status, 'not-run')

  const authOnlyFails = await runSigningRehearsal(deps({ uploadAuth: async () => { throw new Error('signer requires interactive approval for kind 24242') } }))
  assert.equal(authOnlyFails.status, 'failure')
  assert.equal(authOnlyFails.uploadAuthorization.status, 'failure')
  assert.equal(authOnlyFails.releaseSigning.status, 'success', 'release signing is still exercised and reported on its own')

  const transmitted = await runSigningRehearsal(deps({ uploadAuth: async () => ({ kind: 24242, accountPubkey: ACCOUNT, signatureValid: true, transmitted: true }) }))
  assert.equal(transmitted.uploadAuthorization.status, 'failure')

  const exitNonzero = await runSigningRehearsal(deps({ signRelease: async () => ({ status: 1, stdout: '', stdoutBytes: 0, stderrBytes: 10 }) }))
  assert.equal(exitNonzero.releaseSigning.status, 'failure')
  assert.equal(exitNonzero.relayPostCheck.status, 'not-run')

  const published = await runSigningRehearsal(deps({ relayObserved: async () => 1 }))
  assert.equal(published.status, 'failure')
  assert.equal(published.relayPostCheck.signedIdsObserved, 1)

  const relayDown = await runSigningRehearsal(deps({ relayObserved: async () => { throw new Error('relay closed before EOSE') } }))
  assert.equal(relayDown.status, 'failure')
  assert.equal(relayDown.relayPostCheck.signedIdsObserved, null)

  const leakyError = await runSigningRehearsal(deps({ preflight: async () => { throw new Error(`boom ${bunkerUrl}`) } }))
  assert.doesNotMatch(JSON.stringify(leakyError), /s3cret|bunker:\/\/[0-9a-f]/)
})
