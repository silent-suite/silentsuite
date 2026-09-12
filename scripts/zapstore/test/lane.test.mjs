// Behavioural tests for the dormant Zapstore lane. They use the recorded
// unsigned zsp output, the recorded relay snapshot (real signatures), fake
// GitHub and relay transports, and synthetic apksigner text. Nothing here
// touches the network, a signer, or a secret.

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import { classifyRelease, selectScheduleCandidates } from '../lib/eligibility.mjs'
import { activationState, requireOwnerSender, requireProtectedRef, validateDispatchPayload } from '../lib/dispatch.mjs'
import { bindReleaseAssets, createGitHubClient, EnumerationIncomplete, hashFromChecksumText } from '../lib/github.mjs'
import { buildBinding, revalidateBinding, verifyApkHashes } from '../lib/binding.mjs'
import { parseApksignerOutput, requireSignedBy } from '../lib/apksigner.mjs'
import { generateConfig, loadTemplate, parseZapstoreYaml, resolveChangelog, stageMedia } from '../lib/metadata.mjs'
import { eventId, InvalidRelayEvent, loadSchnorr, queryRelay, RelayIncomplete, verifyEvent } from '../lib/nostr.mjs'
import { assessRelayState, expectedSet } from '../lib/reconcile.mjs'
import { apkFactsFromEvent, parseEventsJsonl, requireApkIdentity, zspArgs, zspEnv, ZSP } from '../lib/zsp.mjs'
import { materializeClientKey } from '../lib/bunker-key.mjs'
import { redact } from '../lib/redact.mjs'
import { buildIssue, createIssueWithReadback } from '../lib/notify.mjs'
import { verifyReferencedBlobs } from '../lib/cdn.mjs'

const here = resolve(new URL('.', import.meta.url).pathname)
const root = resolve(here, '..', '..', '..')
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8')
const unsigned = expectedSet(parseEventsJsonl(fixture('zsp-unsigned-offline-v0.5.6-beta.jsonl')))
const observed = JSON.parse(fixture('relay-observed-2026-09-12.json'))
const schnorr = await loadSchnorr()
const SHA = '3111352dbccfaaeee3b83ad325906e591343cfa3'
const APK_SHA = '3007b51474f8d646c652576b924aef540e46a200b1db2b283d3b772cd309fdd4'
const CERT = '8035a4ff1511e2045c579c905d26e93af6009b239e741ef78542ae04e7a7ca79'

const release = (over = {}) => ({ id: 383603104, tag_name: 'v0.5.6-beta', draft: false, prerelease: false, published_at: '2026-09-06T10:00:00Z', assets: [
  { id: 547273876, name: 'silentsuite-android-v0.5.6-beta.apk', size: 26916361, digest: `sha256:${APK_SHA}` },
  { id: 547273877, name: 'silentsuite-android-v0.5.6-beta-installer.sha256' },
  { id: 547273878, name: 'SHA256SUMS.txt' },
  { id: 547273879, name: 'silentsuite-android-v0.5.6-beta.aab' },
], ...over })

test('eligibility: stable and -beta (either GitHub prerelease flag) pass; drafts and other prereleases are refused', () => {
  assert.equal(classifyRelease(release()).eligible, true)
  assert.equal(classifyRelease(release({ prerelease: true })).eligible, true)
  assert.equal(classifyRelease(release({ tag_name: 'v1.2.3' })).kind, 'stable')
  assert.equal(classifyRelease(release()).channel, 'main')
  assert.equal(classifyRelease(release({ draft: true })).eligible, false)
  assert.equal(classifyRelease(release({ tag_name: 'v1.2.3', prerelease: true })).eligible, false)
  for (const tag of ['v1.2.3-rc1', 'v1.2.3-alpha', 'nightly-2026', 'v1.2', '1.2.3', 'v1.2.3-beta.1']) assert.equal(classifyRelease(release({ tag_name: tag })).eligible, false, tag)
  assert.equal(classifyRelease(release({ published_at: null })).eligible, false)
})

test('schedule candidates are bounded to the window and every omission carries a reason', () => {
  const now = Date.parse('2026-09-12T00:00:00Z')
  const { candidates, omitted } = selectScheduleCandidates([release(), release({ id: 5, tag_name: 'v0.5.4-beta', published_at: '2026-01-01T00:00:00Z' }), release({ id: 6, tag_name: 'v0.5.5-rc1' })], { now })
  assert.deepEqual(candidates.map((c) => c.releaseId), [383603104])
  assert.equal(omitted.length, 2)
  assert.ok(omitted.every((o) => o.reason))
})

test('dispatch admission: owner id, exact payload grammar, protected ref, activation states', () => {
  assert.ok(requireOwnerSender('265568982'))
  assert.throws(() => requireOwnerSender('1'), /not the release owner/)
  assert.throws(() => requireOwnerSender(''), /no numeric sender/)
  assert.throws(() => requireProtectedRef('refs/heads/feature'), /not refs\/heads\/main/)
  assert.throws(() => requireProtectedRef('refs/tags/v0.5.6-beta'))
  assert.deepEqual(validateDispatchPayload({ release_id: '383603104', release_tag: 'v0.5.6-beta', source_sha: SHA }), { releaseId: 383603104, tag: 'v0.5.6-beta', sourceSha: SHA })
  assert.throws(() => validateDispatchPayload({ release_id: '1', release_tag: 'v0.5.6-beta', source_sha: SHA, extra: 1 }), /payload keys/)
  assert.throws(() => validateDispatchPayload({ release_id: 'latest', release_tag: 'v0.5.6-beta', source_sha: SHA }), /release_id/)
  assert.throws(() => validateDispatchPayload({ release_id: '1', release_tag: 'v0.5.6-rc1', source_sha: SHA }), /release_tag/)
  assert.throws(() => validateDispatchPayload({ release_id: '1', release_tag: 'v0.5.6-beta', source_sha: 'main' }), /source_sha/)
  assert.equal(activationState(undefined).active, false)
  assert.match(activationState(undefined).label, /DISABLED/)
  assert.equal(activationState('true').active, false)
  assert.equal(activationState('rehearsal').active, false)
  assert.equal(activationState('enabled').active, true)
})

function fakeGitHub(routes) {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    const path = url.replace('https://api.github.com/repos/silent-suite/silentsuite', '')
    const hit = routes[path]
    if (hit === undefined) return { status: 404, json: async () => ({}), text: async () => '' }
    return { status: 200, json: async () => hit, text: async () => (typeof hit === 'string' ? hit : JSON.stringify(hit)) }
  }
  return { client: createGitHubClient({ fetchImpl }), calls }
}

test('binding uses exact release id and dereferenced tag commit; never latest', async () => {
  const { client, calls } = fakeGitHub({
    '/releases/383603104': release(),
    '/git/ref/tags/v0.5.6-beta': { ref: 'refs/tags/v0.5.6-beta', object: { type: 'tag', sha: 'a'.repeat(40) } },
    [`/git/tags/${'a'.repeat(40)}`]: { object: { type: 'commit', sha: SHA } },
  })
  const binding = await buildBinding({ client, releaseId: 383603104, expectedTag: 'v0.5.6-beta', expectedSourceSha: SHA })
  assert.equal(binding.sourceSha, SHA)
  assert.equal(binding.assets.apk.id, 547273876)
  assert.equal(binding.assets.apk.sha256, APK_SHA)
  assert.ok(calls.every((url) => !url.includes('/releases/latest')))
  await assert.rejects(buildBinding({ client, releaseId: 383603104, expectedSourceSha: 'b'.repeat(40) }), /dispatch said/)
  await assert.rejects(buildBinding({ client, releaseId: 383603104, expectedTag: 'v0.5.7' }), /tagged v0.5.6-beta/)
  // Revalidation catches a replaced asset just before signing.
  const drifted = fakeGitHub({ '/releases/383603104': release({ assets: [...release().assets.map((a) => (a.name.endsWith('.apk') ? { ...a, id: 999 } : a))] }), '/git/ref/tags/v0.5.6-beta': { ref: 'refs/tags/v0.5.6-beta', object: { type: 'commit', sha: SHA } } })
  await assert.rejects(revalidateBinding({ client: drifted.client, binding }), /drifted before signing: assets.apk.id/)
})

test('asset binding refuses missing assets, ambiguous names and missing digests', () => {
  assert.throws(() => bindReleaseAssets(release({ assets: release().assets.filter((a) => !a.name.endsWith('.apk')) }), 'v0.5.6-beta'), /exactly one asset named silentsuite-android-v0.5.6-beta.apk, found 0/)
  assert.throws(() => bindReleaseAssets(release({ assets: release().assets.filter((a) => a.name !== 'SHA256SUMS.txt') }), 'v0.5.6-beta'), /SHA256SUMS.txt/)
  assert.throws(() => bindReleaseAssets(release({ assets: release().assets.map((a) => ({ ...a, digest: undefined })) }), 'v0.5.6-beta'), /no sha256 digest/)
  assert.equal(hashFromChecksumText(`${APK_SHA}  silentsuite-android-v0.5.6-beta.apk\n`), APK_SHA)
  assert.equal(hashFromChecksumText(`${'b'.repeat(64)}  other.aab\n${APK_SHA}  silentsuite-android-v0.5.6-beta.apk\n`, { fileName: 'silentsuite-android-v0.5.6-beta.apk' }), APK_SHA)
  assert.throws(() => hashFromChecksumText('nothing here'), /found 0/)
})

test('APK hash binding requires local bytes, GitHub digest, sidecar and manifest to agree', () => {
  const binding = { assets: { apk: { sha256: APK_SHA, size: 26916361 } } }
  assert.ok(verifyApkHashes({ binding, localSha256: APK_SHA, localSize: 26916361, sidecarSha256: APK_SHA, sumsSha256: APK_SHA }))
  assert.throws(() => verifyApkHashes({ binding, localSha256: 'c'.repeat(64), localSize: 26916361, sidecarSha256: APK_SHA, sumsSha256: APK_SHA }), /local bytes/)
  assert.throws(() => verifyApkHashes({ binding, localSha256: APK_SHA, localSize: 1, sidecarSha256: APK_SHA, sumsSha256: APK_SHA }), /size/)
  assert.throws(() => verifyApkHashes({ binding, localSha256: APK_SHA, localSize: 26916361, sidecarSha256: 'c'.repeat(64), sumsSha256: APK_SHA }), /sidecar/)
})

test('release enumeration paginates with a bound and fails instead of truncating', async () => {
  const page = (n, count) => Array.from({ length: count }, (_, i) => release({ id: n * 1000 + i }))
  const ok = fakeGitHub({ '/releases?per_page=100&page=1': page(1, 100), '/releases?per_page=100&page=2': page(2, 3) })
  const listing = await ok.client.listPublishedReleases()
  assert.equal(listing.releases.length, 103)
  assert.equal(listing.complete, true)
  const full = fakeGitHub(Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`/releases?per_page=100&page=${n}`, page(n, 100)])))
  await assert.rejects(full.client.listPublishedReleases(), EnumerationIncomplete)
})

test('apksigner output must say Verifies with only the direct-release certificate', () => {
  const good = parseApksignerOutput(fixture('apksigner-verifies.txt'))
  assert.ok(requireSignedBy(good, CERT))
  assert.throws(() => requireSignedBy(parseApksignerOutput(fixture('apksigner-foreign-signer.txt')), CERT), /signer #2/)
  assert.throws(() => requireSignedBy(parseApksignerOutput(`DOES NOT VERIFY\nERROR: No signature\nSigner #1 certificate SHA-256 digest: ${CERT}`), CERT), /Verifies/)
  assert.throws(() => requireSignedBy(good, 'd'.repeat(64)), /not the direct-release certificate/)
  assert.throws(() => requireSignedBy(parseApksignerOutput('Verifies\nVerified using v1 scheme (JAR signing): true\nSigner #1 certificate SHA-256 digest: ' + CERT), CERT), /neither v2 nor v3/)
})

test('template is repository-relative, carries the six approved screenshots and matches zapstore.yaml copy byte for byte', () => {
  const template = loadTemplate(join(here, '..', 'release-template.json'))
  const store = parseZapstoreYaml(readFileSync(join(root, 'zapstore.yaml'), 'utf8'))
  for (const key of ['name', 'summary', 'description', 'license', 'website', 'repository', 'pubkey']) assert.equal(template[key], store[key], key)
  assert.deepEqual(template.tags, store.tags)
  assert.deepEqual(store.images.map((url) => url.split('/').pop()), template.images.map((p) => p.split('/').pop()))
  assert.equal(store.icon.split('/').pop(), template.icon.split('/').pop())
  assert.equal(template.description, unsigned.app.content, 'description equals the content zsp emitted from the same copy')
  assert.equal(template.pubkeyHex, unsigned.app.pubkey)
  const dir = mkdtempSync(join(tmpdir(), 'zapstore-template-'))
  const bad = { ...template, images: template.images.slice(0, 5) }
  writeFileSync(join(dir, 'five.json'), JSON.stringify(bad))
  assert.throws(() => loadTemplate(join(dir, 'five.json')), /six approved names/)
  writeFileSync(join(dir, 'url.json'), JSON.stringify({ ...template, icon: 'https://raw.githubusercontent.com/x/y/main/icon.png' }))
  assert.throws(() => loadTemplate(join(dir, 'url.json')), /repository-relative/)
  writeFileSync(join(dir, 'chan.json'), JSON.stringify({ ...template, channel: 'beta' }))
  assert.throws(() => loadTemplate(join(dir, 'chan.json')), /channel must stay main/)
})

test('media staged from the checkout hash to the recorded approved hashes; changelog is bound by version code and source commit', () => {
  const template = loadTemplate(join(here, '..', 'release-template.json'))
  const inputs = JSON.parse(fixture('zsp-unsigned-offline-inputs.json'))
  const dir = mkdtempSync(join(tmpdir(), 'zapstore-media-'))
  const media = stageMedia({ template, sourceRoot: root, outDir: join(dir, 'media') })
  const recorded = Object.fromEntries(inputs.map((i) => [i.path, i.sha256]))
  assert.equal(media.icon.sha256, recorded[template.icon])
  media.images.forEach((image, i) => assert.equal(image.sha256, recorded[template.images[i]], template.images[i]))
  const reads = []
  const changelog = resolveChangelog({ template, versionCode: 20, sourceSha: SHA, outDir: dir, readAtSource: (sha, path) => { reads.push([sha, path]); return readFileSync(join(root, path), 'utf8') } })
  assert.deepEqual(reads, [[SHA, 'android/fastlane/metadata/android/en-US/changelogs/20.txt']])
  assert.equal(changelog.sha256, recorded['android/fastlane/metadata/android/en-US/changelogs/20.txt'])
  assert.equal(changelog.text, unsigned.release.content)
  assert.throws(() => resolveChangelog({ template, versionCode: 21, sourceSha: SHA, outDir: dir, readAtSource: () => '   \n' }), /missing or empty/)
  assert.throws(() => resolveChangelog({ template, versionCode: 0, sourceSha: SHA, outDir: dir, readAtSource: () => 'x' }), /positive integer/)
  const { config, text } = generateConfig({ template, apkPath: join(dir, 'silentsuite-android-v0.5.6-beta.apk'), media, changelog })
  assert.equal(config.release_source, join(dir, 'silentsuite-android-v0.5.6-beta.apk'))
  assert.equal(config.images.length, 6)
  assert.doesNotMatch(text, /raw\.githubusercontent|releases\/download/)
  assert.equal(config.description, template.description)
})

test('zsp invocation is exact: pinned binary facts, flags, unsigned vs live, bunker-only signing', () => {
  assert.equal(ZSP.version, '0.4.17')
  assert.equal(ZSP.sha256, '3f241da6a5dc7a85fe851d3b42b77790b651bd36c7029382a701262bda832d20')
  assert.deepEqual(zspArgs({ configPath: '/w/c.yaml', commit: SHA, mode: 'unsigned' }), ['publish', '--json', '--quiet', '--skip-preview', '--skip-metadata', '--no-compress', '--skip-certificate-linking', '--commit', SHA, '--channel', 'main', '--offline', '/w/c.yaml'])
  const live = zspArgs({ configPath: '/w/c.yaml', commit: SHA, mode: 'live' })
  assert.ok(live.includes('--overwrite-release') && !live.includes('--offline') && !live.includes('--indexer-mode') && !live.includes('--pre-release'))
  assert.throws(() => zspArgs({ configPath: '/w/c.yaml', commit: SHA, mode: 'live', channel: 'beta' }), /channel must stay main/)
  assert.throws(() => zspArgs({ configPath: '/w/c.yaml', commit: 'main', mode: 'live' }), /40-hex/)
  const npub = 'npub1zuusadlzq6vehhaqhqpup0mhnx70q9cnf9hs48t79g6qn4wpg2eqsy8m35'
  assert.equal(zspEnv({ mode: 'unsigned', npub, xdgConfigHome: '/w/xdg' }).SIGN_WITH, npub)
  assert.throws(() => zspEnv({ mode: 'live', signWith: undefined, xdgConfigHome: '/w/xdg' }), /missing; refusing/)
  assert.throws(() => zspEnv({ mode: 'live', signWith: 'nsec1' + 'q'.repeat(58), xdgConfigHome: '/w/xdg' }), /must be a bunker:\/\/ URL/)
  assert.equal(zspEnv({ mode: 'live', signWith: 'bunker://' + 'a'.repeat(64) + '?relay=wss://r&secret=s', xdgConfigHome: '/w/xdg' }).SIGN_WITH.startsWith('bunker://'), true)
  assert.throws(() => zspEnv({ mode: 'live', signWith: 'bunker://x', xdgConfigHome: '' }), /XDG_CONFIG_HOME/)
})

test('APK identity from the official parser output is bound to package, version, hash, size, certificate, filename and commit', () => {
  const facts = apkFactsFromEvent(unsigned.apk)
  assert.equal(facts.versionCode, 20)
  const expected = { packageId: 'io.silentsuite.android', version: '0.5.6-beta', sha256: APK_SHA, size: 26916361, certificateSha256: CERT, filename: 'ss-zapstore-source.apk', commit: SHA }
  assert.ok(requireApkIdentity(facts, expected))
  assert.throws(() => requireApkIdentity(facts, { ...expected, filename: 'silentsuite-android-v0.5.6-beta.apk' }), /filename ss-zapstore-source.apk/)
  assert.throws(() => requireApkIdentity(facts, { ...expected, certificateSha256: 'd'.repeat(64) }), /direct-release certificate/)
  assert.throws(() => requireApkIdentity(facts, { ...expected, sha256: 'd'.repeat(64) }), /hash mismatch/)
  assert.throws(() => requireApkIdentity(facts, { ...expected, packageId: 'io.other' }), /package/)
  assert.throws(() => requireApkIdentity(facts, { ...expected, version: '0.5.7' }), /version 0.5.6-beta/)
})

test('real relay events verify; tampered ids, signatures or content are refused', () => {
  assert.equal(observed.length, 20)
  for (const event of observed) assert.ok(verifyEvent(event, schnorr))
  const tampered = { ...observed[0], content: 'changed' }
  assert.throws(() => verifyEvent(tampered, schnorr), InvalidRelayEvent)
  const badSig = { ...observed[0], sig: observed[0].sig.replace(/^./, (c) => (c === '0' ? '1' : '0')) }
  assert.throws(() => verifyEvent(badSig, schnorr), /invalid signature/)
  const rekeyed = { ...observed[0], pubkey: 'b'.repeat(64) }
  rekeyed.id = eventId(rekeyed)
  assert.throws(() => verifyEvent(rekeyed, schnorr), /invalid signature/)
  assert.throws(() => verifyEvent({ ...observed[0], sig: undefined }, schnorr), /sig missing/)
})

// Fake relay socket: scripted frames, optional truncation.
function fakeSocketFactory(script) {
  return class FakeSocket {
    constructor() {
      this.listeners = {}
      queueMicrotask(() => this.emit('open', {}))
    }
    addEventListener(name, fn) { this.listeners[name] = fn }
    emit(name, payload) { this.listeners[name]?.(payload) }
    send(raw) {
      const [, sub] = JSON.parse(raw)
      const frames = script(sub)
      for (const frame of frames) {
        if (frame === 'CLOSE') { this.emit('close', {}); return }
        if (frame === 'HANG') return
        this.emit('message', { data: JSON.stringify(frame) })
      }
    }
    close() {}
  }
}

test('relay subscription completes only on EOSE; timeout, close and truncation are incomplete, never absent', async () => {
  const filters = [{ kinds: [3063] }]
  const complete = await queryRelay({ filters, WebSocketImpl: fakeSocketFactory((sub) => [['EVENT', sub, observed[0]], ['EOSE', sub]]) })
  assert.equal(complete.events.length, 1)
  await assert.rejects(queryRelay({ filters, timeoutMs: 50, WebSocketImpl: fakeSocketFactory((sub) => [['EVENT', sub, observed[0]], 'HANG']) }), RelayIncomplete)
  await assert.rejects(queryRelay({ filters, WebSocketImpl: fakeSocketFactory(() => ['CLOSE']) }), /closed before EOSE/)
  await assert.rejects(queryRelay({ filters, limit: 1, WebSocketImpl: fakeSocketFactory((sub) => [['EVENT', sub, observed[0]], ['EOSE', sub]]) }), /truncated/)
  await assert.rejects(queryRelay({ filters, WebSocketImpl: fakeSocketFactory((sub) => [['CLOSED', sub, 'auth-required']]) }), /closed the subscription/)
})

// Signed copies of the unsigned expected set, produced with a throwaway key so
// the reconciliation can be exercised against structurally real events.
async function signedCopies(mutate = (e) => e) {
  const { secp256k1 } = await import('@noble/curves/secp256k1.js')
  const priv = Uint8Array.from(Buffer.from('1'.repeat(64), 'hex'))
  const pub = Buffer.from(schnorr.getPublicKey(priv)).toString('hex')
  const sign = (event) => { const e = { ...event, pubkey: pub }; e.id = eventId(e); e.sig = Buffer.from(schnorr.sign(Uint8Array.from(Buffer.from(e.id, 'hex')), priv)).toString('hex'); return e }
  void secp256k1
  const apk = sign(mutate({ ...unsigned.apk, tags: unsigned.apk.tags.map((t) => [...t]) }, 'apk'))
  const releaseTags = unsigned.release.tags.map((t) => (t[0] === 'e' ? ['e', apk.id, t[2]] : [...t]))
  const rel = sign(mutate({ ...unsigned.release, tags: releaseTags }, 'release'))
  const app = sign(mutate({ ...unsigned.app, tags: unsigned.app.tags.map((t) => [...t]) }, 'app'))
  const expected = { app: { ...unsigned.app, pubkey: pub }, release: { ...unsigned.release, pubkey: pub }, apk: { ...unsigned.apk, pubkey: pub } }
  return { expected, apk, release: rel, app, pub, sign }
}

test('reconciliation: absent, complete-match, partial, conflict, downgrade and invalid signatures', async () => {
  const { expected, apk, release: rel, app, sign } = await signedCopies()
  assert.equal(assessRelayState({ expected, observed: [], schnorr }).outcome, 'absent')
  assert.equal(assessRelayState({ expected, observed: [app], schnorr }).outcome, 'absent', 'existing app metadata alone does not block a new version')
  assert.equal(assessRelayState({ expected, observed: [app, rel, apk], schnorr }).outcome, 'complete-match')
  assert.equal(assessRelayState({ expected, observed: [apk], schnorr }).outcome, 'partial')
  assert.equal(assessRelayState({ expected, observed: [rel, apk], schnorr }).outcome, 'partial')
  const otherHash = sign({ ...unsigned.apk, tags: unsigned.apk.tags.map((t) => (t[0] === 'x' ? ['x', 'e'.repeat(64)] : [...t])) })
  assert.equal(assessRelayState({ expected, observed: [otherHash], schnorr }).outcome, 'conflict')
  const staleApp = sign({ ...unsigned.app, content: 'older description' })
  const stale = assessRelayState({ expected, observed: [staleApp, rel, apk], schnorr })
  assert.equal(stale.outcome, 'conflict')
  assert.match(stale.detail, /app.description/)
  const newer = sign({ ...unsigned.apk, tags: unsigned.apk.tags.map((t) => (t[0] === 'version_code' ? ['version_code', '21'] : t[0] === 'version' ? ['version', '0.5.7-beta'] : t[0] === 'x' ? ['x', 'f'.repeat(64)] : [...t])) })
  assert.equal(assessRelayState({ expected, observed: [newer], schnorr }).outcome, 'downgrade-refused')
  assert.equal(assessRelayState({ expected, observed: [newer, app, rel, apk], schnorr }).outcome, 'downgrade-refused', 'a stale retry never wins over newer metadata')
  const foreign = { ...apk, pubkey: observed[0].pubkey }
  assert.throws(() => assessRelayState({ expected, observed: [foreign], schnorr }), InvalidRelayEvent, 'a foreign pubkey with our signature is corrupt, not ignorable')
  assert.throws(() => assessRelayState({ expected, observed: [{ ...apk, sig: 'a'.repeat(128) }], schnorr }), /invalid signature/)
  // Real relay snapshot: 0.5.6-beta is not on the relay, and 0.5.4-beta (code 18) is older, so it is absent, not a downgrade.
  const realExpected = unsigned
  assert.equal(assessRelayState({ expected: realExpected, observed, schnorr }).outcome, 'absent')
})

test('CDN read-back fetches every referenced blob and compares hashes', async () => {
  const { createHash } = await import('node:crypto')
  const blobs = new Map()
  const put = (bytes) => { const h = createHash('sha256').update(bytes).digest('hex'); blobs.set(`https://cdn.zapstore.dev/${h}`, bytes); return h }
  const apkBytes = Buffer.from('apk'); const iconBytes = Buffer.from('icon'); const shot = Buffer.from('shot')
  const app = { tags: [['icon', `https://cdn.zapstore.dev/${put(iconBytes)}`], ['image', `https://cdn.zapstore.dev/${put(shot)}`]] }
  const apk = { tags: [['x', put(apkBytes)], ['url', `https://cdn.zapstore.dev/${createHash('sha256').update(apkBytes).digest('hex')}`]] }
  const fetchImpl = async (url) => (blobs.has(url) ? { status: 200, arrayBuffer: async () => blobs.get(url) } : { status: 404 })
  const results = await verifyReferencedBlobs({ app, apk, fetchImpl })
  assert.equal(results.length, 3)
  const corrupt = async (url) => ({ status: 200, arrayBuffer: async () => Buffer.from('wrong') })
  await assert.rejects(verifyReferencedBlobs({ app, apk, fetchImpl: corrupt }), /hash to/)
  await assert.rejects(verifyReferencedBlobs({ app, apk: { tags: [['x', 'a'.repeat(64)], ['url', 'https://example.com/x']] }, fetchImpl }), /not a Zapstore CDN URL/)
})

test('bunker client key is written 0600 under the zsp path, refuses bad input, and is destroyed on cleanup', () => {
  const xdg = mkdtempSync(join(tmpdir(), 'zapstore-xdg-'))
  const target = 'c'.repeat(64)
  const bunkerUrl = `bunker://${target}?relay=wss%3A%2F%2Frelay.example&secret=s3`
  assert.throws(() => materializeClientKey({ xdgConfigHome: xdg, bunkerUrl, clientKey: 'short' }), /64-hex/)
  assert.throws(() => materializeClientKey({ xdgConfigHome: xdg, bunkerUrl: `nsec://${target}`, clientKey: 'a'.repeat(64) }), /bunker:\/\/ scheme/)
  const key = materializeClientKey({ xdgConfigHome: xdg, bunkerUrl, clientKey: 'a'.repeat(64) })
  assert.equal(key.path, join(xdg, 'zsp', 'bunker-keys', `${target}.key`))
  assert.equal(statSync(key.path).mode & 0o777, 0o600)
  assert.equal(readFileSync(key.path, 'utf8'), 'a'.repeat(64) + '\n')
  assert.throws(() => materializeClientKey({ xdgConfigHome: xdg, bunkerUrl, clientKey: 'b'.repeat(64) }), /already exists/)
  key.cleanup()
  assert.equal(existsSync(key.path), false)
})

test('redaction removes bunker URLs, connection requests, nsec and secrets from any text', () => {
  const raw = `Bunker connection request: nostrconnect://abc?relay=wss://r&secret=zzz\nSIGN_WITH=bunker://${'a'.repeat(64)}?relay=wss://relay.example&secret=topsecret failed nsec1qqqq`
  const out = redact(raw)
  assert.doesNotMatch(out, /topsecret|zzz|nsec1qqqq|nostrconnect:\/\/abc/)
  assert.match(out, /SIGN_WITH=\[redacted\]/)
  assert.equal(redact(`failed to connect to bunker://${'a'.repeat(64)}?relay=wss://relay.example&secret=topsecret`), 'failed to connect to bunker://[redacted]')
  assert.equal(redact('event 3007b514 ok'), 'event 3007b514 ok')
})

test('failure issue is structured, quotes untrusted text safely, and is read back', async () => {
  const issue = buildIssue({ releaseId: '383603104', tag: 'v0.5.6-beta', runUrl: 'https://github.com/silent-suite/silentsuite/actions/runs/1/attempts/2', phase: 'publish', outcome: 'partial', detail: 'x ``` @owner bunker://' + 'a'.repeat(64) + '?secret=s' })
  assert.equal(issue.title, 'Zapstore publication failed: v0.5.6-beta (release 383603104)')
  assert.doesNotMatch(issue.body, /secret=s\b/)
  assert.doesNotMatch(issue.body, /\n```\n@owner/)
  assert.match(issue.body, /client_payload\[release_id\]=383603104/)
  const hostile = buildIssue({ releaseId: 'x', tag: 'v1.0.0; rm -rf', runUrl: 'https://evil', phase: '<script>', outcome: 'ok', detail: '' })
  assert.match(hostile.body, /\[tag failed validation\]/)
  assert.match(hostile.body, /\[run url failed validation\]/)
  assert.doesNotMatch(hostile.body, /<script>/)
  const stored = {}
  const fetchImpl = async (url, init) => {
    if (init?.method === 'POST') { stored.issue = JSON.parse(init.body); return { status: 201, json: async () => ({ number: 7 }) } }
    return { status: 200, json: async () => ({ ...stored.issue, html_url: 'https://github.com/silent-suite/silentsuite/issues/7' }) }
  }
  const created = await createIssueWithReadback({ fetchImpl, token: 't', issue })
  assert.equal(created.number, 7)
  const drift = async (url, init) => (init?.method === 'POST' ? { status: 201, json: async () => ({ number: 8 }) } : { status: 200, json: async () => ({ title: 'other', body: 'other' }) })
  await assert.rejects(createIssueWithReadback({ fetchImpl: drift, token: 't', issue }), /different content/)
})

test('cli admit: disabled state is reported loudly and dispatch gates hold end to end', () => {
  const run = (env) => {
    const dir = mkdtempSync(join(tmpdir(), 'zapstore-cli-'))
    const out = join(dir, 'out'); const sum = join(dir, 'summary')
    writeFileSync(out, ''); writeFileSync(sum, '')
    const result = spawnSync(process.execPath, [join(here, '..', 'cli.mjs'), 'admit'], { env: { PATH: process.env.PATH, HOME: dir, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum, GITHUB_REF: 'refs/heads/main', ...env }, encoding: 'utf8' })
    return { ...result, outputs: readFileSync(out, 'utf8'), summary: readFileSync(sum, 'utf8') }
  }
  const disabled = run({ GITHUB_EVENT_NAME: 'schedule' })
  assert.equal(disabled.status, 0)
  assert.match(disabled.outputs, /active=false/)
  assert.match(disabled.summary, /DISABLED/)
  const wrongRef = run({ GITHUB_EVENT_NAME: 'schedule', GITHUB_REF: 'refs/heads/feat' })
  assert.notEqual(wrongRef.status, 0)
  const nonOwner = run({ GITHUB_EVENT_NAME: 'repository_dispatch', SENDER_ID: '42', DISPATCH_PAYLOAD: JSON.stringify({ release_id: '1', release_tag: 'v1.0.0', source_sha: SHA }), ZAPSTORE_AUTOMATION_ENABLED: 'enabled' })
  assert.notEqual(nonOwner.status, 0)
  assert.match(nonOwner.stderr, /not the release owner/)
  const owner = run({ GITHUB_EVENT_NAME: 'repository_dispatch', SENDER_ID: '265568982', DISPATCH_PAYLOAD: JSON.stringify({ release_id: '383603104', release_tag: 'v0.5.6-beta', source_sha: SHA }), ZAPSTORE_AUTOMATION_ENABLED: 'enabled' })
  assert.equal(owner.status, 0, owner.stderr)
  assert.match(owner.outputs, /active=true/)
  assert.match(owner.outputs, /release_id=383603104/)
  const badPayload = run({ GITHUB_EVENT_NAME: 'repository_dispatch', SENDER_ID: '265568982', DISPATCH_PAYLOAD: JSON.stringify({ release_id: '383603104', release_tag: 'v0.5.6-beta', source_sha: SHA, ref: 'refs/heads/evil' }) })
  assert.notEqual(badPayload.status, 0)
  const noCreds = spawnSync(process.execPath, [join(here, '..', 'cli.mjs'), 'publish', '--binding', '/nonexistent.json', '--config', 'x', '--zsp', 'x', '--work-dir', tmpdir()], { env: { PATH: process.env.PATH }, encoding: 'utf8' })
  assert.notEqual(noCreds.status, 0)
})
