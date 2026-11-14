import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, createVerify, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { bindPlayAssets, runLane } from '../cli.mjs'
import { accessToken, createPlayClient, parseServiceAccount, signedAssertion } from '../lib/play-api.mjs'
import { newestRelease, releaseNotes, trackDecision, versionFromGradle } from '../lib/plan.mjs'

const root = resolve(new URL('.', import.meta.url).pathname, '..', '..', '..')
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const COMMIT = 'a'.repeat(40)
const TAG = 'v0.5.19-beta.2'
const BUNDLE = Buffer.from('signed bundle bytes')
const SYMBOLS = Buffer.from('native symbols zip')
const GRADLE = '        versionCode 35\n        versionName "0.5.19-beta.2"\n'

const release = (id, tag, extra = {}) => ({ id, tag_name: tag, draft: false, prerelease: false, published_at: '2026-11-14T10:00:00Z', ...extra })

test('newest release follows the shared tag order and ignores drafts', () => {
  const releases = [release(1, 'v0.5.18-beta.2'), release(2, 'v0.5.19-beta', { draft: true }), release(3, 'v0.5.17-beta'), release(4, 'v0.5.18-rc1')]
  assert.equal(newestRelease(releases).tag, 'v0.5.18-beta.2')
  assert.equal(newestRelease([release(5, 'nightly')]), null)
})

test('versionCode and versionName come from the tag commit and must match the tag', () => {
  assert.deepEqual(versionFromGradle(GRADLE, TAG), { versionCode: 35, versionName: '0.5.19-beta.2' })
  assert.throws(() => versionFromGradle(GRADLE, 'v0.5.19-beta'), /does not match tag/)
  assert.throws(() => versionFromGradle(`${GRADLE}versionCode 36\n`, TAG), /expected one versionCode/)
})

test('release notes must be present and fit Play', () => {
  assert.equal(releaseNotes('  Fixes a crash.\n', 35), 'Fixes a crash.')
  assert.throws(() => releaseNotes(' \n', 35), /empty/)
  assert.throws(() => releaseNotes('x'.repeat(501), 35), /500/)
})

test('track decision: present, superseded or publish', () => {
  const tracks = [{ track: 'internal', releases: [{ versionCodes: ['40'] }] }, { track: 'production', releases: [{ status: 'completed', versionCodes: ['33'] }] }]
  assert.deepEqual(trackDecision(tracks, 33), { action: 'present', status: 'completed' })
  assert.deepEqual(trackDecision(tracks, 32), { action: 'superseded', highest: 33 })
  assert.deepEqual(trackDecision(tracks, 35), { action: 'publish', highest: 33 })
  assert.deepEqual(trackDecision([], 1), { action: 'publish', highest: null })
})

test('the service-account assertion is RS256-signed and the token exchange never echoes the key', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const account = parseServiceAccount(JSON.stringify({ type: 'service_account', client_email: 'p@x.iam.gserviceaccount.com', private_key: pem }))
  const [header, claims, signature] = signedAssertion(account, 1000).split('.')
  assert.ok(createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, 'base64url')))
  const body = JSON.parse(Buffer.from(claims, 'base64url').toString())
  assert.deepEqual(body, { iss: 'p@x.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/androidpublisher', aud: 'https://oauth2.googleapis.com/token', iat: 1000, exp: 4600 })
  assert.throws(() => parseServiceAccount('{"type":"authorized_user"}'), /not a service-account key/)
  assert.throws(() => parseServiceAccount('not json'), /not valid JSON/)
  const denied = async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }), { status: 400 })
  await assert.rejects(accessToken(account, { fetchImpl: denied }), (error) => /400: Invalid JWT Signature/.test(error.message) && !error.message.includes('PRIVATE KEY'))
})

test('commit refuses to cancel a pending review and edits are addressed by package', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push(`${init.method} ${url}`)
    return new Response(init.method === 'DELETE' ? null : '{"id":"e1"}', { status: init.method === 'DELETE' ? 204 : 200 })
  }
  const play = createPlayClient({ token: 't', fetchImpl })
  await play.commitEdit('e1')
  await play.deleteEdit('e1')
  assert.deepEqual(calls, [
    'POST https://androidpublisher.googleapis.com/androidpublisher/v3/applications/io.silentsuite.android/edits/e1:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW',
    'DELETE https://androidpublisher.googleapis.com/androidpublisher/v3/applications/io.silentsuite.android/edits/e1',
  ])
})

function assetsFor(tag, overrides = {}) {
  const asset = (id, name, bytes) => ({ id, name, digest: bytes ? `sha256:${sha(bytes)}` : null })
  return [
    asset(11, `silentsuite-android-${tag}.aab`, overrides.bundle ?? BUNDLE),
    asset(12, `silentsuite-android-${tag}-bundle.sha256`),
    asset(13, `silentsuite-android-${tag}-native-debug-symbols.zip`, SYMBOLS),
    asset(14, `silentsuite-android-${tag}-native-debug-symbols.sha256`),
  ]
}

function fakeGitHub({ releases = [release(7, TAG)], bundle = BUNDLE, sidecarBundle = bundle } = {}) {
  const files = { 11: bundle, 13: SYMBOLS }
  const sidecars = { 12: `${sha(sidecarBundle)}  silentsuite-android-${TAG}.aab\n`, 14: `${sha(SYMBOLS)}  silentsuite-android-${TAG}-native-debug-symbols.zip\n` }
  return {
    listPublishedReleases: async () => ({ releases }),
    getTagCommit: async (tag) => (tag === TAG ? COMMIT : 'b'.repeat(40)),
    getReleaseById: async (id) => ({ ...releases.find((r) => r.id === id), assets: assetsFor(TAG, { bundle: BUNDLE }) }),
    getText: async (path) => sidecars[Number(path.split('/').pop())],
    downloadAsset: async (id, destination) => {
      writeFileSync(destination, files[id])
      return { sha256: sha(files[id]), size: files[id].length }
    },
  }
}

function fakePlay({ production = [{ status: 'completed', versionCodes: ['33'] }], bundles = [], uploaded = { versionCode: 35, sha256: sha(BUNDLE) }, commitFails = false } = {}) {
  const calls = []
  let committedTrack = null
  let pending = null
  let edits = 0
  return {
    calls,
    insertEdit: async () => { calls.push('insert'); edits += 1; return `e${edits}` },
    listTracks: async () => { calls.push('tracks'); return [{ track: 'production', releases: committedTrack ?? production }] },
    listBundles: async () => { calls.push('bundles'); return bundles },
    uploadBundle: async (_id, bytes) => { calls.push(`upload ${bytes.length}`); return uploaded },
    uploadNativeSymbols: async (_id, code, bytes) => { calls.push(`symbols ${code} ${bytes.length}`) },
    updateTrack: async (_id, track, releases) => { calls.push(`track ${track} ${JSON.stringify(releases)}`); pending = releases },
    validateEdit: async () => { calls.push('validate') },
    commitEdit: async () => { calls.push('commit'); if (commitFails) throw new Error('edits.commit returned 400: changes are in review'); committedTrack = pending },
    deleteEdit: async (id) => { calls.push(`delete ${id}`) },
  }
}
const readAtCommit = (notes = 'Fixes the launch deadlock.') => (commit, path) => {
  assert.equal(commit, COMMIT)
  if (path === 'android/app/build.gradle') return GRADLE
  if (path === 'android/fastlane/metadata/android/en-US/changelogs/35.txt') return notes
  throw new Error(`unexpected read ${path}`)
}
const workDir = () => mkdtempSync(join(tmpdir(), 'play-test-'))

test('publish uploads the verified bundle and symbols, sets production and reads it back', async () => {
  const play = fakePlay()
  const result = await runLane({ mode: 'publish', github: fakeGitHub(), play, readAtCommit: readAtCommit(), workDir: workDir() })
  assert.equal(result.outcome, 'published')
  assert.deepEqual(play.calls, [
    'insert', 'tracks', 'bundles', `upload ${BUNDLE.length}`, `symbols 35 ${SYMBOLS.length}`,
    'track production [{"name":"35 (0.5.19-beta.2)","versionCodes":["35"],"status":"completed","releaseNotes":[{"language":"en-US","text":"Fixes the launch deadlock."}]}]',
    'validate', 'commit', 'insert', 'tracks', 'delete e2',
  ])
})

test('validate mode discards the edit and never commits', async () => {
  const play = fakePlay()
  const result = await runLane({ mode: 'validate', github: fakeGitHub(), play, readAtCommit: readAtCommit(), workDir: workDir() })
  assert.equal(result.outcome, 'validated')
  assert.ok(!play.calls.includes('commit'))
  assert.equal(play.calls.at(-1), 'delete e1')
})

test('nothing is uploaded when production already has this or a newer versionCode', async () => {
  for (const [codes, outcome] of [[['35'], 'present'], [['36'], 'superseded']]) {
    const play = fakePlay({ production: [{ status: 'completed', versionCodes: codes }] })
    const result = await runLane({ mode: 'publish', github: fakeGitHub(), play, readAtCommit: readAtCommit(), workDir: workDir() })
    assert.equal(result.outcome, outcome)
    assert.deepEqual(play.calls, ['insert', 'tracks', 'delete e1'])
  }
})

test('no eligible release means no Play call at all', async () => {
  const play = fakePlay()
  const result = await runLane({ mode: 'publish', github: fakeGitHub({ releases: [release(7, TAG, { draft: true })] }), play, readAtCommit: readAtCommit(), workDir: workDir() })
  assert.equal(result.outcome, 'none')
  assert.deepEqual(play.calls, [])
})

test('mismatched checksums, wrong uploaded bundle, missing notes and a failed commit all stop with the edit discarded', async () => {
  const cases = [
    [{ github: fakeGitHub({ sidecarBundle: Buffer.from('other') }) }, /does not match GitHub's digest/],
    [{ github: fakeGitHub({ bundle: Buffer.from('tampered'), sidecarBundle: BUNDLE }) }, /downloaded .* hash/],
    [{ play: fakePlay({ uploaded: { versionCode: 34, sha256: sha(BUNDLE) } }) }, /versionCode 34, expected 35/],
    [{ play: fakePlay({ bundles: [{ versionCode: 35, sha256: 'f'.repeat(64) }] }) }, /different bundle/],
    [{ notes: '' }, /empty/],
    [{ play: fakePlay({ commitFails: true }) }, /changes are in review/],
  ]
  for (const [options, pattern] of cases) {
    const play = options.play ?? fakePlay()
    await assert.rejects(runLane({ mode: 'publish', github: options.github ?? fakeGitHub(), play, readAtCommit: readAtCommit(options.notes ?? 'Notes.'), workDir: workDir() }), pattern)
    assert.equal(play.calls.at(-1), 'delete e1', String(pattern))
  }
})

test('an unknown mode is refused before any read', async () => {
  await assert.rejects(runLane({ mode: 'true', github: {}, play: {}, readAtCommit: () => '' }), /must be one of validate, publish/)
})

test('assets bind exactly once and payloads need GitHub digests', () => {
  const bound = bindPlayAssets({ assets: assetsFor(TAG) }, TAG)
  assert.equal(bound.bundle.sha256, sha(BUNDLE))
  assert.throws(() => bindPlayAssets({ assets: [...assetsFor(TAG), assetsFor(TAG)[0]] }, TAG), /exactly one asset/)
  assert.throws(() => bindPlayAssets({ assets: assetsFor(TAG).map((a) => ({ ...a, digest: null })) }, TAG), /no sha256 digest/)
})

test('workflow: main only, protected environment, read-only token, no dependency install', () => {
  const workflow = readFileSync(join(root, '.github', 'workflows', 'play-publish.yml'), 'utf8')
  const code = workflow.replace(/^\s*#.*$/gm, '')
  assert.match(code, /\non:\n  schedule:\n    - cron: '47 \*\/3 \* \* \*'\n  workflow_dispatch:\n\n/)
  assert.match(code, /\npermissions: \{\}\n/)
  assert.match(code, /    if: github\.ref == 'refs\/heads\/main' && \(vars\.PLAY_AUTOMATION_MODE == 'validate' \|\| vars\.PLAY_AUTOMATION_MODE == 'publish'\)\n/)
  assert.match(code, /    environment: play-production\n    permissions:\n      contents: read\n/)
  assert.match(code, /ref: \$\{\{ github\.sha \}\}/)
  assert.match(code, /persist-credentials: false/)
  assert.equal((code.match(/secrets\.PLAY_SERVICE_ACCOUNT_JSON/g) ?? []).length, 1)
  assert.doesNotMatch(code, /npm|pnpm|yarn|pull_request|workflow_run|release:/)
  for (const use of code.match(/uses: \S+/g)) assert.match(use, /@[0-9a-f]{40}$/)
})
