// Manual publication lane (.github/workflows/zapstore-manual-publish.yml):
// admission, explicit newest-only selection, four-way approved binding and the
// final freshness check before signing. Everything goes through the CLI front
// door against a local fake GitHub API; the trusted identity helper is replaced
// by a recording stub resolved from the command's working directory, because
// its live reads are CI-only. No signer, relay or live GitHub is involved.

import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const here = resolve(new URL('.', import.meta.url).pathname)
const cli = join(here, '..', 'cli.mjs')
const REPOSITORY = 'silent-suite/silentsuite'
const MANUAL_REF = `${REPOSITORY}/.github/workflows/zapstore-manual-publish.yml@refs/heads/main`
const SCHEDULE_REF = `${REPOSITORY}/.github/workflows/zapstore-publish.yml@refs/heads/main`
const REHEARSAL_REF = `${REPOSITORY}/.github/workflows/zapstore-rehearsal.yml@refs/heads/main`
const SIGNING_REHEARSAL_REF = `${REPOSITORY}/.github/workflows/zapstore-signing-rehearsal.yml@refs/heads/main`

// The owner-approved release identity.
const APPROVED = {
  releaseId: '403959789',
  tag: 'v0.5.12-beta',
  sourceSha: '1eee02f8459743bcfee67d64d7450384e5411d65',
  apkAssetId: '613253303',
  apkSha256: 'f30f8cadfed980c87f21300d851e15ba263553da872566e386b25f8dacf025e1',
}

// The fake transport serves fixture bytes, so API-backed tests bind the hash of
// those bytes; the ids, tag and source commit stay the approved ones.
const FIXTURE_APK = Buffer.from('synthetic APK bytes for the manual publication regression')
const FIXTURE_APK_SHA256 = createHash('sha256').update(FIXTURE_APK).digest('hex')
const HISTORICAL = { id: 400000001, tag: 'v0.5.11-beta', sourceSha: 'c'.repeat(40) }
const NEWER = { id: 410000001, tag: 'v0.5.13-beta', sourceSha: 'd'.repeat(40) }

function requestEnv(overrides = {}) {
  return {
    MANUAL_RELEASE_ID: APPROVED.releaseId,
    MANUAL_EXPECTED_SOURCE_SHA: APPROVED.sourceSha,
    MANUAL_EXPECTED_APK_ASSET_ID: APPROVED.apkAssetId,
    MANUAL_EXPECTED_APK_SHA256: FIXTURE_APK_SHA256,
    ...overrides,
  }
}

function run(command, extraArgs = [], env = {}, { cwd } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zapstore-manual-cli-'))
  const out = join(dir, 'out'); const sum = join(dir, 'summary')
  writeFileSync(out, ''); writeFileSync(sum, '')
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cli, command, ...extraArgs], { cwd, env: { PATH: process.env.PATH, HOME: dir, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum, ...env } })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('close', (status) => resolvePromise({ status, stdout, stderr, outputs: readFileSync(out, 'utf8'), summary: readFileSync(sum, 'utf8') }))
  })
}

const outputValue = (outputs, key) => outputs.split('\n').find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1)

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'zapstore-manual-repo-'))
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example' } })
  git('init', '-q')
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  git('add', 'a.txt')
  git('commit', '-q', '-m', 'one')
  return { dir, head: git('rev-parse', 'HEAD').trim() }
}

function admitEnv(head, overrides = {}) {
  return {
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_WORKFLOW_REF: MANUAL_REF,
    GITHUB_SHA: head,
    GITHUB_WORKFLOW_SHA: head,
    ZAPSTORE_AUTOMATION_ENABLED: 'enabled',
    ...requestEnv({ MANUAL_EXPECTED_APK_SHA256: APPROVED.apkSha256 }),
    MANUAL_EXPECTED_WORKFLOW_SHA: head,
    ...overrides,
  }
}

function release({ id, tag, apkAssetId = id + 1, apkSha256 = FIXTURE_APK_SHA256, publishedAt = '2026-10-04T12:00:00Z' }) {
  return {
    id,
    tag_name: tag,
    draft: false,
    prerelease: false,
    published_at: publishedAt,
    assets: [
      { id: apkAssetId, name: `silentsuite-android-${tag}.apk`, size: FIXTURE_APK.length, digest: `sha256:${apkSha256}` },
      { id: apkAssetId + 1, name: `silentsuite-android-${tag}-installer.sha256`, size: 120 },
    ],
  }
}

const approvedRelease = (overrides = {}) => release({ id: Number(APPROVED.releaseId), tag: APPROVED.tag, apkAssetId: Number(APPROVED.apkAssetId), ...overrides })
const historicalRelease = () => release({ id: HISTORICAL.id, tag: HISTORICAL.tag, publishedAt: '2026-10-01T12:00:00Z' })
const newerRelease = () => release({ id: NEWER.id, tag: NEWER.tag, publishedAt: '2026-10-05T12:00:00Z' })

// Mutable fake of the three exact-identity reads the lane performs.
function fakeGitHub() {
  const state = {
    releases: [historicalRelease(), approvedRelease()],
    tagCommits: { [APPROVED.tag]: APPROVED.sourceSha, [HISTORICAL.tag]: HISTORICAL.sourceSha, [NEWER.tag]: NEWER.sourceSha },
    requests: [],
  }
  const prefix = `/repos/${REPOSITORY}`
  const server = createServer((request, response) => {
    state.requests.push(request.url)
    const reply = (status, json) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(json)) }
    if (request.method !== 'GET') return reply(405, {})
    if (request.url.startsWith(`${prefix}/releases?`)) return reply(200, state.releases)
    const byId = new RegExp(`^${prefix}/releases/(\\d+)$`).exec(request.url)
    if (byId) {
      const found = state.releases.find((r) => String(r.id) === byId[1])
      return found ? reply(200, found) : reply(404, {})
    }
    const byTag = new RegExp(`^${prefix}/git/ref/tags/(.+)$`).exec(request.url)
    if (byTag) {
      const tag = decodeURIComponent(byTag[1])
      return state.tagCommits[tag] ? reply(200, { ref: `refs/tags/${tag}`, object: { type: 'commit', sha: state.tagCommits[tag] } }) : reply(404, {})
    }
    reply(404, {})
  })
  return new Promise((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise({
    state,
    apiBase: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  })))
}

// A working directory whose scripts/verify-release-identity.sh records its
// arguments and admits; `calls()` is every identity check that was requested.
function identityStub() {
  const dir = mkdtempSync(join(tmpdir(), 'zapstore-manual-identity-'))
  mkdirSync(join(dir, 'scripts'))
  writeFileSync(join(dir, 'scripts', 'verify-release-identity.sh'), 'printf \'%s\\n\' "$*" >> "$(dirname "$0")/../identity.log"\n')
  const log = join(dir, 'identity.log')
  return { dir, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) }
}

const apiEnv = (gh, overrides = {}) => ({ GITHUB_API_URL: gh.apiBase, GITHUB_TOKEN: 't', GITHUB_REPOSITORY: REPOSITORY, GITHUB_REF: 'refs/heads/main', ...requestEnv(overrides) })

function writeApk(dir, bytes = FIXTURE_APK) {
  const path = join(dir, `silentsuite-android-${APPROVED.tag}.apk`)
  writeFileSync(path, bytes)
  return path
}

test('cli admit-manual-publish: a main workflow_dispatch of the manual file bound to its checkout is admitted with the validated request, in every activation state', async () => {
  const { dir, head } = tempRepo()
  const enabled = await run('admit-manual-publish', ['--workspace', dir], admitEnv(head))
  assert.equal(enabled.status, 0, enabled.stderr)
  assert.equal(outputValue(enabled.outputs, 'active'), 'true')
  assert.equal(outputValue(enabled.outputs, 'rehearsal'), 'false')
  assert.equal(outputValue(enabled.outputs, 'revision'), head)
  assert.equal(outputValue(enabled.outputs, 'release_id'), APPROVED.releaseId)
  assert.equal(outputValue(enabled.outputs, 'expected_source_sha'), APPROVED.sourceSha)
  assert.equal(outputValue(enabled.outputs, 'expected_apk_asset_id'), APPROVED.apkAssetId)
  assert.equal(outputValue(enabled.outputs, 'expected_apk_sha256'), APPROVED.apkSha256)
  assert.equal(outputValue(enabled.outputs, 'expected_workflow_sha'), head)
  assert.equal(enabled.outputs.trim().split('\n').length, 8, 'exactly the three admission outputs and the five validated inputs')

  const rehearsal = await run('admit-manual-publish', ['--workspace', dir], admitEnv(head, { ZAPSTORE_AUTOMATION_ENABLED: 'rehearsal' }))
  assert.equal(rehearsal.status, 0, rehearsal.stderr)
  assert.equal(outputValue(rehearsal.outputs, 'active'), 'false')
  assert.equal(outputValue(rehearsal.outputs, 'rehearsal'), 'true')

  for (const value of ['', 'true', 'ENABLED', 'disabled']) {
    const disabled = await run('admit-manual-publish', ['--workspace', dir], admitEnv(head, { ZAPSTORE_AUTOMATION_ENABLED: value }))
    assert.equal(disabled.status, 0, disabled.stderr)
    assert.equal(outputValue(disabled.outputs, 'active'), 'false', `activation ${JSON.stringify(value)}`)
    assert.equal(outputValue(disabled.outputs, 'rehearsal'), 'false', `activation ${JSON.stringify(value)}`)
  }
})

test('cli admit-manual-publish refuses every other trigger, ref, definition and checkout; the schedule and rehearsal admissions refuse the manual definition', async () => {
  const { dir, head } = tempRepo()
  const cases = [
    ['schedule', { GITHUB_EVENT_NAME: 'schedule' }, /is not workflow_dispatch/],
    ['schedule with the production definition', { GITHUB_EVENT_NAME: 'schedule', GITHUB_WORKFLOW_REF: SCHEDULE_REF }, /is not workflow_dispatch/],
    ['repository_dispatch', { GITHUB_EVENT_NAME: 'repository_dispatch' }, /is not workflow_dispatch/],
    ['release', { GITHUB_EVENT_NAME: 'release' }, /is not workflow_dispatch/],
    ['missing event', { GITHUB_EVENT_NAME: '' }, /is not workflow_dispatch/],
    ['feature branch', { GITHUB_REF: 'refs/heads/feat', GITHUB_WORKFLOW_REF: MANUAL_REF.replace('refs/heads/main', 'refs/heads/feat') }, /is not refs\/heads\/main/],
    ['tag', { GITHUB_REF: `refs/tags/${APPROVED.tag}`, GITHUB_WORKFLOW_REF: MANUAL_REF.replace('refs/heads/main', `refs/tags/${APPROVED.tag}`) }, /is not refs\/heads\/main/],
    ['definition from another ref', { GITHUB_WORKFLOW_REF: MANUAL_REF.replace('refs/heads/main', 'refs/heads/feat') }, /GITHUB_WORKFLOW_REF/],
    ['production definition', { GITHUB_WORKFLOW_REF: SCHEDULE_REF }, /GITHUB_WORKFLOW_REF/],
    ['rehearsal definition', { GITHUB_WORKFLOW_REF: REHEARSAL_REF }, /GITHUB_WORKFLOW_REF/],
    ['signing rehearsal definition', { GITHUB_WORKFLOW_REF: SIGNING_REHEARSAL_REF }, /GITHUB_WORKFLOW_REF/],
    ['another repository', { GITHUB_WORKFLOW_REF: MANUAL_REF.replace(REPOSITORY, 'attacker/silentsuite') }, /GITHUB_WORKFLOW_REF/],
    ['malformed repository', { GITHUB_REPOSITORY: '' }, /GITHUB_REPOSITORY/],
    ['definition drift', { GITHUB_WORKFLOW_SHA: 'a'.repeat(40) }, /GITHUB_WORKFLOW_SHA .* is not the run commit/],
    ['missing definition sha', { GITHUB_WORKFLOW_SHA: '' }, /GITHUB_WORKFLOW_SHA/],
    ['wrong checkout', { GITHUB_SHA: 'b'.repeat(40), GITHUB_WORKFLOW_SHA: 'b'.repeat(40), MANUAL_EXPECTED_WORKFLOW_SHA: 'b'.repeat(40) }, /not the admitted protected revision/],
  ]
  for (const [label, env, pattern] of cases) {
    const refused = await run('admit-manual-publish', ['--workspace', dir], admitEnv(head, env))
    assert.equal(refused.status, 1, `${label}: ${refused.stderr}`)
    assert.match(refused.stderr, pattern, label)
    assert.equal(refused.outputs, '', `${label} emits nothing`)
  }
  const noWorkspace = await run('admit-manual-publish', [], admitEnv(head))
  assert.equal(noWorkspace.status, 1, noWorkspace.stderr)
  assert.match(noWorkspace.stderr, /requires --workspace/)
  assert.equal(noWorkspace.outputs, '')

  // The older admissions keep their own contracts.
  const scheduled = await run('admit', ['--workspace', dir], admitEnv(head))
  assert.equal(scheduled.status, 1)
  assert.match(scheduled.stderr, /unsupported event workflow_dispatch/)
  const spoofed = await run('admit', ['--workspace', dir], admitEnv(head, { GITHUB_EVENT_NAME: 'schedule' }))
  assert.equal(spoofed.status, 1)
  assert.match(spoofed.stderr, /is not \.github\/workflows\/zapstore-publish\.yml/)
  for (const command of ['admit-rehearsal', 'admit-signing-rehearsal']) {
    const other = await run(command, ['--workspace', dir], admitEnv(head))
    assert.equal(other.status, 1, command)
    assert.match(other.stderr, /GITHUB_WORKFLOW_REF/, command)
    assert.equal(other.outputs, '', command)
  }
})

test('cli admit-manual-publish rejects missing, malformed and unsafe inputs before emitting anything', async () => {
  const { dir, head } = tempRepo()
  const hex40 = APPROVED.sourceSha
  const hex64 = APPROVED.apkSha256
  const numeric = (value) => [
    ['missing', undefined], ['empty', ''], ['zero', '0'], ['leading zero', `0${value}`], ['negative', `-${value}`], ['decimal', `${value}.0`],
    ['exponent', '4e8'], ['hex', '0x18140a6d'], ['leading space', ` ${value}`], ['trailing newline', `${value}\n`],
    ['shell metacharacters', `${value}; echo pwned`], ['command substitution', '$(id)'], ['seventeen digits', '1'.repeat(17)],
    ['first unsafe integer', '9007199254740992'], ['sixteen-digit maximum', '9999999999999999'],
  ]
  const hex = (value, length) => [
    ['missing', undefined], ['empty', ''], ['uppercase', value.toUpperCase()], ['short', value.slice(1)], ['long', `${value}0`],
    ['non-hex', `g${value.slice(1)}`], ['leading space', ` ${value}`], ['trailing newline', `${value}\n`],
    ['shell metacharacters', `${value.slice(0, length - 9)};echo pwn`], ['abbreviated', value.slice(0, 12)],
  ]
  const fields = [
    ['MANUAL_RELEASE_ID', /release_id/, numeric(APPROVED.releaseId)],
    ['MANUAL_EXPECTED_APK_ASSET_ID', /expected_apk_asset_id/, numeric(APPROVED.apkAssetId)],
    ['MANUAL_EXPECTED_SOURCE_SHA', /expected_source_sha/, hex(hex40, 40)],
    ['MANUAL_EXPECTED_APK_SHA256', /expected_apk_sha256/, hex(hex64, 64)],
    ['MANUAL_EXPECTED_WORKFLOW_SHA', /expected_workflow_sha/, hex(head, 40)],
  ]
  for (const [name, pattern, rows] of fields) {
    for (const [label, value] of rows) {
      const env = admitEnv(head)
      if (value === undefined) delete env[name]
      else env[name] = value
      const refused = await run('admit-manual-publish', ['--workspace', dir], env)
      assert.equal(refused.status, 1, `${name} ${label}: ${refused.stderr}`)
      assert.match(refused.stderr, pattern, `${name} ${label}`)
      assert.equal(refused.outputs, '', `${name} ${label} emits nothing`)
    }
  }
  // The largest safe integer is still an exact identifier.
  const largest = await run('admit-manual-publish', ['--workspace', dir], admitEnv(head, { MANUAL_RELEASE_ID: '9007199254740991' }))
  assert.equal(largest.status, 0, largest.stderr)
  assert.equal(outputValue(largest.outputs, 'release_id'), '9007199254740991')
})

test('cli admit-manual-publish requires expected_workflow_sha to equal the run commit that supplied the definition', async () => {
  const { dir, head } = tempRepo()
  const flipped = (head[0] === 'a' ? 'b' : 'a') + head.slice(1)
  for (const [label, value] of [['another commit', 'a'.repeat(40)], ['one differing character', flipped], ['the approved source commit', APPROVED.sourceSha]]) {
    const refused = await run('admit-manual-publish', ['--workspace', dir], admitEnv(head, { MANUAL_EXPECTED_WORKFLOW_SHA: value }))
    assert.equal(refused.status, 1, `${label}: ${refused.stderr}`)
    assert.match(refused.stderr, /expected_workflow_sha/, label)
    assert.equal(refused.outputs, '', `${label} emits nothing`)
  }
  const ok = await run('admit-manual-publish', ['--workspace', dir], admitEnv(head))
  assert.equal(ok.status, 0, ok.stderr)
  assert.equal(outputValue(ok.outputs, 'expected_workflow_sha'), head)
})

test('cli enumerate-manual: the candidate file and the matrix hold exactly the requested newest release', async () => {
  const gh = await fakeGitHub()
  const dir = mkdtempSync(join(tmpdir(), 'zapstore-manual-enumerate-'))
  const out = join(dir, 'candidates.json')
  try {
    const result = await run('enumerate-manual', ['--out', out], apiEnv(gh))
    assert.equal(result.status, 0, result.stderr)
    const file = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(file.candidates.length, 1)
    assert.equal(file.candidates[0].releaseId, Number(APPROVED.releaseId))
    assert.equal(file.candidates[0].tag, APPROVED.tag)
    assert.equal(file.candidates[0].publishable, true)
    assert.ok(file.omitted.some((o) => o.releaseId === HISTORICAL.id && typeof o.reason === 'string' && o.reason !== ''), 'history is reported as omitted, never assessed or published by this lane')
    assert.equal(outputValue(result.outputs, 'count'), '1')
    assert.deepEqual(JSON.parse(outputValue(result.outputs, 'matrix')), { include: [{ release_id: APPROVED.releaseId, tag: APPROVED.tag, publishable: 'true' }] })
    assert.ok(!result.outputs.includes(String(HISTORICAL.id)), 'no other release id reaches a job matrix')
  } finally { await gh.close() }
})

test('cli enumerate-manual refuses a request that is not the single newest eligible release and writes no candidates', async () => {
  const gh = await fakeGitHub()
  const dir = mkdtempSync(join(tmpdir(), 'zapstore-manual-enumerate-'))
  const out = join(dir, 'candidates.json')
  const refuse = async (label, env, pattern) => {
    const refused = await run('enumerate-manual', ['--out', out], env)
    assert.equal(refused.status, 1, `${label}: ${refused.stderr}`)
    assert.match(refused.stderr, pattern, label)
    assert.equal(refused.outputs, '', `${label} emits no matrix`)
    assert.equal(existsSync(out), false, `${label} writes no candidate file`)
  }
  try {
    await refuse('historical release', apiEnv(gh, { MANUAL_RELEASE_ID: String(HISTORICAL.id) }), /not the newest eligible release/)
    await refuse('unknown release', apiEnv(gh, { MANUAL_RELEASE_ID: '123456789' }), /not the newest eligible release/)
    await refuse('unsafe release id', apiEnv(gh, { MANUAL_RELEASE_ID: '9007199254740992' }), /release_id/)
    await refuse('malformed release id', apiEnv(gh, { MANUAL_RELEASE_ID: `${APPROVED.releaseId} ` }), /release_id/)
    const missing = apiEnv(gh)
    delete missing.MANUAL_RELEASE_ID
    await refuse('missing release id', missing, /release_id/)

    gh.state.releases = [historicalRelease(), approvedRelease(), newerRelease()]
    await refuse('a newer eligible release exists', apiEnv(gh), /not the newest eligible release/)

    gh.state.releases = [historicalRelease(), approvedRelease({ tag: 'v0.5.12-rc1' })]
    await refuse('requested release is ineligible', apiEnv(gh), /not the newest eligible release/)

    gh.state.releases = [historicalRelease(), { ...approvedRelease(), draft: true }]
    await refuse('requested release is a draft', apiEnv(gh), /not the newest eligible release/)

    gh.state.releases = []
    await refuse('no eligible release', apiEnv(gh), /newest eligible release/)
  } finally { await gh.close() }
})

test('cli bind-approved binds the requested release only when release, source, APK asset and hash all equal the approved values', async () => {
  const gh = await fakeGitHub()
  const stub = identityStub()
  const dir = mkdtempSync(join(tmpdir(), 'zapstore-manual-bind-'))
  const out = join(dir, 'binding.json')
  try {
    const result = await run('bind-approved', ['--release-id', APPROVED.releaseId, '--git-ancestry', dir, '--out', out], apiEnv(gh), { cwd: stub.dir })
    assert.equal(result.status, 0, result.stderr)
    const binding = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(binding.releaseId, Number(APPROVED.releaseId))
    assert.equal(binding.tag, APPROVED.tag)
    assert.equal(binding.sourceSha, APPROVED.sourceSha)
    assert.equal(binding.assets.apk.id, Number(APPROVED.apkAssetId))
    assert.equal(binding.assets.apk.sha256, FIXTURE_APK_SHA256)
    assert.equal(outputValue(result.outputs, 'tag'), APPROVED.tag)
    assert.equal(outputValue(result.outputs, 'source_sha'), APPROVED.sourceSha)
    assert.deepEqual(stub.calls(), [`--tag ${APPROVED.tag} --commit ${APPROVED.sourceSha} --stage zapstore-binding --git-ancestry ${dir}`], 'the trusted identity helper still admits the source')
  } finally { await gh.close() }
})

test('cli bind-approved refuses each single mismatch, writes no binding, and the recorded result fails at the bind phase', async () => {
  const gh = await fakeGitHub()
  const dir = mkdtempSync(join(tmpdir(), 'zapstore-manual-bind-'))
  const out = join(dir, 'binding.json')
  const refuse = async (label, { releaseId = APPROVED.releaseId, env = {}, pattern }) => {
    const refused = await run('bind-approved', ['--release-id', releaseId, '--git-ancestry', dir, '--out', out], apiEnv(gh, env), { cwd: identityStub().dir })
    assert.equal(refused.status, 1, `${label}: ${refused.stderr}`)
    assert.match(refused.stderr, pattern, label)
    assert.equal(refused.outputs, '', `${label} emits nothing`)
    assert.equal(existsSync(out), false, `${label} writes no binding`)
  }
  try {
    await refuse('matrix release is not the approved release', { releaseId: String(HISTORICAL.id), pattern: /release/ })
    await refuse('approved source differs from the tag commit', { env: { MANUAL_EXPECTED_SOURCE_SHA: 'e'.repeat(40) }, pattern: new RegExp(`resolves to ${APPROVED.sourceSha}`) })
    await refuse('approved APK asset id differs', { env: { MANUAL_EXPECTED_APK_ASSET_ID: '613253304' }, pattern: /apk asset/i })
    await refuse('approved APK hash differs', { env: { MANUAL_EXPECTED_APK_SHA256: APPROVED.apkSha256 }, pattern: /sha256/ })
    gh.state.tagCommits[APPROVED.tag] = 'e'.repeat(40)
    await refuse('tag moved after approval', { pattern: /resolves to e{40}/ })
    gh.state.tagCommits[APPROVED.tag] = APPROVED.sourceSha
    gh.state.releases = [historicalRelease(), approvedRelease({ apkAssetId: 613253399 })]
    await refuse('APK asset replaced after approval', { pattern: /apk asset/i })
    gh.state.releases = [historicalRelease(), approvedRelease({ apkSha256: 'f'.repeat(64) })]
    await refuse('APK bytes replaced after approval', { pattern: /sha256/ })
    for (const [name, pattern] of [['MANUAL_RELEASE_ID', /release_id/], ['MANUAL_EXPECTED_SOURCE_SHA', /expected_source_sha/], ['MANUAL_EXPECTED_APK_ASSET_ID', /expected_apk_asset_id/], ['MANUAL_EXPECTED_APK_SHA256', /expected_apk_sha256/]]) {
      await refuse(`${name} missing`, { env: { [name]: '' }, pattern })
    }

    const recorded = await run('record-result', ['--job', 'assess', '--binding', out, '--reconcile', join(dir, 'reconcile.json'), '--cdn', join(dir, 'cdn.json'), '--out', join(dir, 'assessment.json')], { PHASE_CHECKOUT: 'success', PHASE_BIND: 'failure', RELEASE_ID: APPROVED.releaseId, RELEASE_TAG: APPROVED.tag, REVISION: 'a'.repeat(40) })
    assert.equal(recorded.status, 0, recorded.stderr)
    const assessment = JSON.parse(readFileSync(join(dir, 'assessment.json'), 'utf8'))
    assert.equal(assessment.status, 'failure')
    assert.equal(assessment.failedPhase, 'bind')
    assert.equal(assessment.releaseId, APPROVED.releaseId)
  } finally { await gh.close() }
})

test('cli revalidate-manual passes into the existing revalidation while the request is still the newest eligible release', async () => {
  const gh = await fakeGitHub()
  const stub = identityStub()
  const dir = mkdtempSync(join(tmpdir(), 'zapstore-manual-revalidate-'))
  const binding = join(dir, 'binding.json')
  const apk = writeApk(dir)
  try {
    const bound = await run('bind-approved', ['--release-id', APPROVED.releaseId, '--git-ancestry', dir, '--out', binding], apiEnv(gh), { cwd: stub.dir })
    assert.equal(bound.status, 0, bound.stderr)
    gh.state.requests.length = 0
    const result = await run('revalidate-manual', ['--binding', binding, '--apk', apk, '--git-ancestry', dir], apiEnv(gh), { cwd: stub.dir })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(gh.state.requests.some((url) => url.includes('/releases?')), 'a fresh release listing is read immediately before signing')
    assert.ok(gh.state.requests.some((url) => url.endsWith(`/releases/${APPROVED.releaseId}`)), 'the existing exact-release revalidation still runs')
    assert.equal(stub.calls().at(-1), `--tag ${APPROVED.tag} --commit ${APPROVED.sourceSha} --stage zapstore-signing --git-ancestry ${dir}`)

    const changed = await run('revalidate-manual', ['--binding', binding, '--apk', writeApk(dir, Buffer.from('corrupted artifact')), '--git-ancestry', dir], apiEnv(gh), { cwd: stub.dir })
    assert.equal(changed.status, 1, changed.stderr)
    assert.match(changed.stderr, /local APK changed since binding/)
  } finally { await gh.close() }
})

test('cli revalidate-manual refuses before any identity or signer step when a newer release appears during approval, and a failed-job re-run with frozen inputs refuses too', async () => {
  const gh = await fakeGitHub()
  const stub = identityStub()
  const dir = mkdtempSync(join(tmpdir(), 'zapstore-manual-freshness-'))
  const candidates = join(dir, 'candidates.json')
  const binding = join(dir, 'binding.json')
  const apk = writeApk(dir)
  const revalidate = () => run('revalidate-manual', ['--binding', binding, '--apk', apk, '--git-ancestry', dir], apiEnv(gh), { cwd: stub.dir })
  try {
    // Enumeration and binding accept the request while it is the newest.
    const enumerated = await run('enumerate-manual', ['--out', candidates], apiEnv(gh))
    assert.equal(enumerated.status, 0, enumerated.stderr)
    const bound = await run('bind-approved', ['--release-id', APPROVED.releaseId, '--git-ancestry', dir, '--out', binding], apiEnv(gh), { cwd: stub.dir })
    assert.equal(bound.status, 0, bound.stderr)
    const frozenCandidates = readFileSync(candidates, 'utf8')
    const frozenBinding = readFileSync(binding, 'utf8')
    const identityCallsBefore = stub.calls().length

    // A newer eligible release is published while environment approval is pending.
    gh.state.releases = [historicalRelease(), approvedRelease(), newerRelease()]
    const stale = await revalidate()
    assert.equal(stale.status, 1, stale.stderr)
    assert.match(stale.stderr, /not the newest eligible release/)
    assert.match(stale.stderr, new RegExp(String(NEWER.id)))
    assert.equal(stub.calls().length, identityCallsBefore, 'refused before the signing-stage identity check')

    // "Re-run failed jobs": the same frozen candidate list, binding and inputs.
    assert.equal(readFileSync(candidates, 'utf8'), frozenCandidates)
    assert.equal(readFileSync(binding, 'utf8'), frozenBinding)
    const replay = await revalidate()
    assert.equal(replay.status, 1, replay.stderr)
    assert.match(replay.stderr, /not the newest eligible release/)
    assert.equal(stub.calls().length, identityCallsBefore)

    // "Re-run all jobs" re-enumerates and refuses at selection.
    const reenumerated = await run('enumerate-manual', ['--out', join(dir, 'again.json')], apiEnv(gh))
    assert.equal(reenumerated.status, 1, reenumerated.stderr)
    assert.match(reenumerated.stderr, /not the newest eligible release/)
    assert.equal(existsSync(join(dir, 'again.json')), false)

    // The scheduled revalidation contract is unchanged: it has no newest-only check.
    const scheduled = await run('revalidate', ['--binding', binding, '--apk', apk, '--git-ancestry', dir], apiEnv(gh), { cwd: stub.dir })
    assert.equal(scheduled.status, 0, scheduled.stderr)
  } finally { await gh.close() }
})

test('cli revalidate-manual refuses a binding or request that is not the approved one before any identity check', async () => {
  const gh = await fakeGitHub()
  const stub = identityStub()
  const dir = mkdtempSync(join(tmpdir(), 'zapstore-manual-revalidate-'))
  const binding = join(dir, 'binding.json')
  const apk = writeApk(dir)
  try {
    const bound = await run('bind-approved', ['--release-id', APPROVED.releaseId, '--git-ancestry', dir, '--out', binding], apiEnv(gh), { cwd: stub.dir })
    assert.equal(bound.status, 0, bound.stderr)
    const identityCallsBefore = stub.calls().length
    const cases = [
      ['approved source differs', { MANUAL_EXPECTED_SOURCE_SHA: 'e'.repeat(40) }, /source/],
      ['approved APK asset id differs', { MANUAL_EXPECTED_APK_ASSET_ID: '613253304' }, /apk asset/i],
      ['approved APK hash differs', { MANUAL_EXPECTED_APK_SHA256: APPROVED.apkSha256 }, /sha256/],
      ['request is another release', { MANUAL_RELEASE_ID: String(HISTORICAL.id) }, /release/],
      ['unsafe release id', { MANUAL_RELEASE_ID: '9007199254740992' }, /release_id/],
      ['missing approved hash', { MANUAL_EXPECTED_APK_SHA256: '' }, /expected_apk_sha256/],
    ]
    for (const [label, env, pattern] of cases) {
      const refused = await run('revalidate-manual', ['--binding', binding, '--apk', apk, '--git-ancestry', dir], apiEnv(gh, env), { cwd: stub.dir })
      assert.equal(refused.status, 1, `${label}: ${refused.stderr}`)
      assert.match(refused.stderr, pattern, label)
      assert.equal(stub.calls().length, identityCallsBefore, `${label} is refused before the identity check`)
    }
  } finally { await gh.close() }
})
