import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { crc32, deflateRawSync } from 'node:zlib'
import { buildStoredZipArchive } from './publish-annual-public-served-attestation.mjs'
import { PROOF_ENTRY_NAME, PROOF_PAYLOAD_KEYS, PROOF_WORKFLOW_PATH, buildProofPayload, bytesDigest, canonicalDigest, consumeProof, produceProof, proofArtifactName, readSingleEntryArchive, runNegatives, runProofCli, verifyProofArchive, verifyPublishedArtifact } from './annual-artifact-transport-proof.mjs'

const key = 'a1'.repeat(32)
const sourceSha = 'b'.repeat(40)
const run = { runId: 33962000001, runAttempt: 1 }
const repository = 'silent-suite/silentsuite'
const predecessorDigest = `sha256:${'c'.repeat(64)}`
const servedIdentities = { web: { publicSha: sourceSha }, docs: { publicSha: sourceSha } }
const bindings = { key, repository, sourceSha, run, workflowPath: PROOF_WORKFLOW_PATH, predecessorDigest, servedIdentities }
const times = { clientServedAt: '2026-09-05T12:00:00Z', verifiedAt: '2026-09-05T12:00:01Z' }
const tokenSentinel = 'API-TOKEN-SENTINEL-3f9c'

// Mimics the official action's archiver output: deflate, general-purpose bit 3 (sizes and
// CRC only in the data descriptor and central directory), one entry per file.
function buildDeflatedArchive(entries, { encrypted = false, method = 8, declaredSize } = {}) {
  const locals = []; const centrals = []; let offset = 0
  for (const [entryName, content] of entries) {
    const name = Buffer.from(entryName, 'utf8'); const body = Buffer.from(content); const compressed = method === 8 ? deflateRawSync(body) : body; const checksum = crc32(body) >>> 0
    const flags = 0x0008 | (encrypted ? 0x0001 : 0)
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8); local.writeUInt16LE(name.length, 26)
    const descriptor = Buffer.alloc(16); descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE(checksum, 4); descriptor.writeUInt32LE(compressed.length, 8); descriptor.writeUInt32LE(body.length, 12)
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(declaredSize ?? body.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42)
    locals.push(local, name, compressed, descriptor); centrals.push(central, name); offset += local.length + name.length + compressed.length + descriptor.length
  }
  const centralBytes = Buffer.concat(centrals)
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBytes, end])
}

// Stands in for the GitHub API with the exact members the consumer reads. Every response is
// derived from one mutable fixture so a test can substitute a single fact at a time.
function fixture({ archive, artifactId = 9001, workflowId = 777, redirect = true } = {}) {
  const bytes = archive ?? buildDeflatedArchive([[PROOF_ENTRY_NAME, buildProofPayload({ ...bindings, ...times }).bytes]])
  const state = {
    archive: bytes, redirect, requests: [],
    artifact: { id: artifactId, name: proofArtifactName(run), expired: false, digest: bytesDigest(bytes), workflow_run: { id: run.runId, head_sha: sourceSha } },
    run: { id: run.runId, run_attempt: run.runAttempt, head_sha: sourceSha, event: 'pull_request', workflow_id: workflowId, repository: { full_name: repository }, head_repository: { full_name: repository } },
    workflow: { id: workflowId, path: PROOF_WORKFLOW_PATH },
  }
  const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
  state.fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input)); const authorization = init.headers?.Authorization
    state.requests.push({ host: url.host, path: url.pathname, authorized: typeof authorization === 'string' && authorization.includes(tokenSentinel) })
    if (url.host === 'blob.invalid') { assert.equal(authorization, undefined, 'credential must not reach the storage host'); return new Response(state.archive, { status: 200 }) }
    assert.equal(url.origin, 'https://api.github.com'); assert.ok(typeof authorization === 'string' && authorization.includes(tokenSentinel), 'API calls must carry the token')
    const prefix = `/repos/${repository}/`
    if (!url.pathname.startsWith(prefix)) return new Response('{}', { status: 404 })
    const route = url.pathname.slice(prefix.length)
    if (route === `actions/artifacts/${state.artifact.id}`) return json(state.artifact)
    if (route === `actions/artifacts/${state.artifact.id}/zip`) return state.redirect ? new Response(null, { status: 302, headers: { location: 'https://blob.invalid/archive?sig=x' } }) : new Response(state.archive, { status: 200 })
    if (route === `actions/runs/${state.run.id}`) return json(state.run)
    if (route === `actions/workflows/${state.workflow.id}`) return json(state.workflow)
    return new Response('{}', { status: 404 })
  }
  state.verify = (patch = {}) => verifyPublishedArtifact({ fetchImpl: state.fetchImpl, token: tokenSentinel, repository, artifactId: state.artifact.id, uploadDigest: state.artifact.digest, ...bindings, ...patch })
  return state
}

test('the signed proof payload carries exact bindings and never its own storage artifact ID', () => {
  const { payload, bytes } = buildProofPayload({ ...bindings, ...times })
  assert.deepEqual(Object.keys(payload), PROOF_PAYLOAD_KEYS)
  assert.equal(payload.artifactName, `annual-artifact-transport-proof-${run.runId}-${run.runAttempt}`)
  assert.doesNotMatch(bytes.toString('utf8'), /artifactId|databaseId|artifact_id/)
  assert.match(payload.signature, /^[0-9a-f]{64}$/)
  assert.throws(() => buildProofPayload({ ...bindings, ...times, key: 'short' }), /key/i)
  assert.throws(() => buildProofPayload({ ...bindings, ...times, servedIdentities: { web: { publicSha: sourceSha }, docs: { publicSha: 'f'.repeat(40) } } }), /docs/)
  assert.throws(() => buildProofPayload({ ...bindings, clientServedAt: times.verifiedAt, verifiedAt: times.clientServedAt }), /timestamps/i)
  assert.throws(() => proofArtifactName({ runId: 0, runAttempt: 1 }), /run identity/i)
})
test('digests from the official action output and the GitHub API canonicalize to one prefixed form', () => {
  assert.equal(canonicalDigest('d'.repeat(64)), `sha256:${'d'.repeat(64)}`); assert.equal(canonicalDigest(`sha256:${'d'.repeat(64)}`), `sha256:${'d'.repeat(64)}`)
  for (const bad of ['D'.repeat(64), 'sha1:' + 'd'.repeat(40), '', undefined, 42]) assert.equal(canonicalDigest(bad), undefined)
})
test('bounded extraction accepts exactly one stored or deflated entry with the exact name and rejects every other archive shape', () => {
  const content = buildProofPayload({ ...bindings, ...times }).bytes
  assert.deepEqual(readSingleEntryArchive(buildStoredZipArchive(PROOF_ENTRY_NAME, content), PROOF_ENTRY_NAME), content)
  assert.deepEqual(readSingleEntryArchive(buildDeflatedArchive([[PROOF_ENTRY_NAME, content]]), PROOF_ENTRY_NAME), content)
  const rejects = [
    ['two entries', buildDeflatedArchive([[PROOF_ENTRY_NAME, content], ['second.json', '{}']]), /exactly one entry/],
    ['different name', buildDeflatedArchive([['other.json', content]]), /exact expected file/],
    ['path traversal name', buildDeflatedArchive([[`../${PROOF_ENTRY_NAME}`, content]]), /exact expected file/],
    ['nested name', buildDeflatedArchive([[`dir/${PROOF_ENTRY_NAME}`, content]]), /exact expected file/],
    ['encrypted entry', buildDeflatedArchive([[PROOF_ENTRY_NAME, content]], { encrypted: true }), /encrypted/],
    ['unsupported method', buildDeflatedArchive([[PROOF_ENTRY_NAME, content]], { method: 12 }), /unsupported/],
    ['declared size mismatch', buildDeflatedArchive([[PROOF_ENTRY_NAME, content]], { declaredSize: content.length + 1 }), /size does not match/],
    ['oversize entry', buildDeflatedArchive([[PROOF_ENTRY_NAME, Buffer.alloc(70 * 1024, 0x20)]]), /bounded size/],
    ['truncated', buildDeflatedArchive([[PROOF_ENTRY_NAME, content]]).subarray(0, 60), /truncated|end record/],
  ]
  for (const [name, archive, pattern] of rejects) assert.throws(() => readSingleEntryArchive(archive, PROOF_ENTRY_NAME), pattern, name)
  const corrupted = Buffer.from(buildStoredZipArchive(PROOF_ENTRY_NAME, content)); corrupted[30 + PROOF_ENTRY_NAME.length + 5] ^= 0xff
  assert.throws(() => readSingleEntryArchive(corrupted, PROOF_ENTRY_NAME), /checksum/)
  assert.throws(() => readSingleEntryArchive(buildStoredZipArchive(PROOF_ENTRY_NAME, content), '../escape.json'), /entry name is invalid/)
})
test('archive verification binds signature, payload digest, and every identity, and rejects an altered signed payload or wrong key', () => {
  const built = buildProofPayload({ ...bindings, ...times }); const archive = buildDeflatedArchive([[PROOF_ENTRY_NAME, built.bytes]])
  assert.equal(verifyProofArchive(archive, { ...bindings, payloadDigest: bytesDigest(built.bytes) }).artifactName, built.payload.artifactName)
  const altered = { ...built.payload, predecessorDigest: `sha256:${'e'.repeat(64)}` }
  assert.throws(() => verifyProofArchive(buildDeflatedArchive([[PROOF_ENTRY_NAME, `${JSON.stringify(altered)}\n`]]), { ...bindings, predecessorDigest: altered.predecessorDigest }), /signature does not verify/)
  assert.throws(() => verifyProofArchive(archive, { ...bindings, key: 'f'.repeat(64) }), /signature does not verify/)
  assert.throws(() => verifyProofArchive(archive, { ...bindings, payloadDigest: `sha256:${'0'.repeat(64)}` }), /produced payload digest/)
  assert.throws(() => verifyProofArchive(archive, { ...bindings, run: { runId: run.runId, runAttempt: 2 } }), /run binding/)
  assert.throws(() => verifyProofArchive(archive, { ...bindings, workflowPath: '.github/workflows/ci.yml' }), /workflow path binding/)
  const extraKey = { ...built.payload, artifactId: 1 }
  assert.throws(() => verifyProofArchive(buildDeflatedArchive([[PROOF_ENTRY_NAME, `${JSON.stringify(extraKey)}\n`]]), bindings), /malformed/)
})
test('independent consumption reads only the GitHub API, follows one redirect without the credential, and admits the exact finalized artifact', async () => {
  for (const redirect of [true, false]) {
    const state = fixture({ redirect })
    const result = await state.verify()
    assert.equal(result.artifactId, 9001); assert.equal(result.digest, bytesDigest(state.archive)); assert.equal(result.payload.sourceSha, sourceSha)
    assert.deepEqual(state.requests.map((request) => request.path.replace(`/repos/${repository}/`, '')), redirect ? ['actions/artifacts/9001', `actions/runs/${run.runId}`, 'actions/workflows/777', 'actions/artifacts/9001/zip', '/archive'] : ['actions/artifacts/9001', `actions/runs/${run.runId}`, 'actions/workflows/777', 'actions/artifacts/9001/zip'])
    assert.equal(state.requests.filter((request) => request.host === 'blob.invalid' && request.authorized).length, 0)
  }
  const bare = fixture(); bare.artifact.digest = bare.artifact.digest.slice(7)
  assert.equal((await bare.verify({ uploadDigest: bare.artifact.digest })).digest, bytesDigest(bare.archive))
})
test('every GitHub API provenance, digest, identity, or key substitution is rejected before the payload can be admitted', async () => {
  const substitutions = [
    ['artifact ID', (state) => state.verify({ artifactId: 9002 }), /HTTP 404/],
    ['upload digest', (state) => state.verify({ uploadDigest: `sha256:${'0'.repeat(64)}` }), /API artifact digest differs/],
    ['API artifact digest', (state) => { const uploadDigest = state.artifact.digest; state.artifact.digest = `sha256:${'0'.repeat(64)}`; return state.verify({ uploadDigest }) }, /API artifact digest differs/],
    ['archive bytes', (state) => { state.archive = Buffer.concat([state.archive, Buffer.from('x')]); return state.verify() }, /Downloaded archive SHA-256 differs/],
    ['artifact name', (state) => { state.artifact.name = 'annual-artifact-transport-proof-1-1'; return state.verify() }, /exact run-scoped proof name/],
    ['expired artifact', (state) => { state.artifact.expired = true; return state.verify() }, /expired/],
    ['artifact run', (state) => { state.artifact.workflow_run.id = 5; return state.verify() }, /exact run/],
    ['artifact head', (state) => { state.artifact.workflow_run.head_sha = 'f'.repeat(40); return state.verify() }, /run head differs/],
    ['run ID', (state) => state.verify({ run: { runId: run.runId + 1, runAttempt: 1 } }), /run-scoped proof name/],
    // The expected name is derived from run and attempt, so a substituted attempt is
    // rejected at the artifact-name binding before the run API is even consulted.
    ['run attempt', (state) => state.verify({ run: { runId: run.runId, runAttempt: 2 } }), /run-scoped proof name/],
    ['API run attempt', (state) => { state.run.run_attempt = 2; return state.verify() }, /attempt differs/],
    ['run head', (state) => { state.run.head_sha = 'f'.repeat(40); return state.verify() }, /Run head differs/],
    ['run event', (state) => { state.run.event = 'workflow_dispatch'; return state.verify() }, /expected trigger/],
    ['fork head repository', (state) => { state.run.head_repository.full_name = 'someone/silentsuite'; return state.verify() }, /same repository/],
    ['producer workflow path', (state) => { state.workflow.path = '.github/workflows/ci.yml'; return state.verify() }, /workflow path differs/],
    ['expected workflow path', (state) => state.verify({ workflowPath: '.github/workflows/annual-only-public-cutover.yml' }), /workflow path differs/],
    ['source SHA', (state) => state.verify({ sourceSha: 'f'.repeat(40), servedIdentities: { web: { publicSha: 'f'.repeat(40) }, docs: { publicSha: 'f'.repeat(40) } } }), /head differs/],
    ['predecessor digest', (state) => state.verify({ predecessorDigest: `sha256:${'0'.repeat(64)}` }), /predecessor digest binding/],
    ['signing key', (state) => state.verify({ key: 'f'.repeat(64) }), /signature does not verify/],
    ['insecure redirect', (state) => { state.fetchImpl = ((original) => async (input, init) => { const response = await original(input, init); return response.status === 302 ? new Response(null, { status: 302, headers: { location: 'http://blob.invalid/archive' } }) : response })(state.fetchImpl); return state.verify() }, /redirect is invalid/],
    ['missing token', (state) => verifyPublishedArtifact({ fetchImpl: state.fetchImpl, token: '', repository, artifactId: 9001, uploadDigest: state.artifact.digest, ...bindings }), /token is missing/],
  ]
  for (const [name, attempt, pattern] of substitutions) await assert.rejects(() => attempt(fixture()), pattern, name)
})

function produceInto(root, extra = {}) {
  const env = { PROOF_DIRECTORY: join(root, 'proof'), GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: String(run.runId), GITHUB_RUN_ATTEMPT: String(run.runAttempt), PROOF_SOURCE_SHA: sourceSha, ...extra }
  return env
}
test('produce stages one payload, keeps the ephemeral key only in a 0600 file, and prints no key material', async () => {
  const root = mkdtempSync(join(tmpdir(), 'annual-transport-proof-'))
  try {
    const env = produceInto(root)
    const result = spawnSync(process.execPath, [resolve('scripts/annual-artifact-transport-proof.mjs'), 'produce'], { encoding: 'utf8', env: { ...process.env, ...env } })
    assert.equal(result.status, 0, result.stderr)
    const keyValue = readFileSync(join(env.PROOF_DIRECTORY, 'key'), 'utf8')
    assert.match(keyValue, /^[0-9a-f]{64}$/); assert.equal(statSync(join(env.PROOF_DIRECTORY, 'key')).mode & 0o777, 0o600)
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(keyValue)); assert.match(result.stdout, /Proof payload staged for annual-artifact-transport-proof-33962000001-1 \(payload sha256:[0-9a-f]{64}\)/)
    const expected = JSON.parse(readFileSync(join(env.PROOF_DIRECTORY, 'expected.json'), 'utf8'))
    assert.deepEqual(Object.keys(expected).sort(), ['artifactName', 'payloadDigest', 'predecessorDigest', 'repository', 'run', 'servedIdentities', 'sourceSha', 'workflowPath']); assert.doesNotMatch(JSON.stringify(expected), new RegExp(keyValue))
    const staged = readFileSync(join(env.PROOF_DIRECTORY, 'stage', PROOF_ENTRY_NAME))
    assert.equal(bytesDigest(staged), expected.payloadDigest)
    verifyProofArchive(buildDeflatedArchive([[PROOF_ENTRY_NAME, staged]]), { key: keyValue, repository, sourceSha, run, workflowPath: PROOF_WORKFLOW_PATH, predecessorDigest: expected.predecessorDigest, servedIdentities: expected.servedIdentities, payloadDigest: expected.payloadDigest })
    assert.notEqual(spawnSync(process.execPath, [resolve('scripts/annual-artifact-transport-proof.mjs'), 'produce'], { encoding: 'utf8', env: { ...process.env, ...env, PROOF_SOURCE_SHA: 'main' } }).status, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('consume refuses while the staged payload still exists, then admits only through the API, and negatives all reject against the same fixture', async () => {
  const root = mkdtempSync(join(tmpdir(), 'annual-transport-proof-'))
  try {
    const env = produceInto(root)
    const produced = await produceProof({ env })
    const keyValue = readFileSync(join(env.PROOF_DIRECTORY, 'key'), 'utf8')
    const staged = readFileSync(produced.stagedPath)
    const archive = buildDeflatedArchive([[PROOF_ENTRY_NAME, staged]])
    const state = fixture({ archive })
    // Fixture identity must match what produce signed: replace its fixed key with the produced key.
    const consumerEnv = { ...env, GH_TOKEN: tokenSentinel, PROOF_ARTIFACT_ID: '9001', PROOF_UPLOAD_DIGEST: bytesDigest(archive).slice(7) }
    await assert.rejects(() => consumeProof({ env: consumerEnv, fetchImpl: state.fetchImpl }), /Staged payload must be removed/)
    rmSync(join(env.PROOF_DIRECTORY, 'stage'), { recursive: true, force: true }); assert.equal(existsSync(produced.stagedPath), false)
    const consumed = await consumeProof({ env: consumerEnv, fetchImpl: state.fetchImpl })
    assert.deepEqual(consumed, { artifactId: 9001, digest: bytesDigest(archive), artifactName: produced.artifactName, payloadDigest: produced.payloadDigest })
    const results = await runNegatives({ env: consumerEnv, fetchImpl: state.fetchImpl })
    assert.equal(results.length, 10); assert.deepEqual(results.filter((result) => !result.rejected || result.unexpected), [])
    assert.deepEqual(results.map((result) => result.name), ['wrong artifact ID', 'wrong upload digest', 'wrong run ID', 'wrong run attempt', 'wrong source SHA', 'wrong producer workflow path', 'wrong repository', 'wrong predecessor digest', 'wrong signing key', 'altered signed payload'])
    // Every negative must have rejected on its intended binding, not on an incidental error.
    assert.deepEqual(results.map((result) => result.message), [
      'GitHub API actions/artifacts/9002 failed (HTTP 404)', 'GitHub API artifact digest differs from the upload output digest',
      'Artifact name is not the exact run-scoped proof name', 'Artifact name is not the exact run-scoped proof name', 'Artifact run head differs from the source SHA',
      'Producer workflow path differs', 'GitHub API actions/artifacts/9001 failed (HTTP 404)', 'Proof predecessor digest binding differs',
      'Proof signature does not verify', 'Proof signature does not verify',
    ])
    const out = []; const io = { env: consumerEnv, fetchImpl: state.fetchImpl, stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => out.push(text) } }
    assert.equal(await runProofCli('consume', io), 0); assert.equal(await runProofCli('negatives', io), 0); assert.equal(await runProofCli('bogus', io), 1)
    const printed = out.join(''); assert.doesNotMatch(printed, new RegExp(keyValue)); assert.doesNotMatch(printed, new RegExp(tokenSentinel)); assert.match(printed, /Proof consumed independently: artifact 9001 sha256:[0-9a-f]{64}/); assert.equal((printed.match(/^rejected /gm) ?? []).length, 10)
    assert.equal(createHash('sha256').update(staged).digest('hex'), produced.payloadDigest.slice(7))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('negatives fail when the positive succeeds but later API requests error, or when the local tamper fixture itself breaks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'annual-transport-proof-'))
  try {
    const env = produceInto(root)
    const produced = await produceProof({ env })
    const archive = buildDeflatedArchive([[PROOF_ENTRY_NAME, readFileSync(produced.stagedPath)]])
    rmSync(join(env.PROOF_DIRECTORY, 'stage'), { recursive: true, force: true })
    const consumerEnv = { ...env, GH_TOKEN: tokenSentinel, PROOF_ARTIFACT_ID: '9001', PROOF_UPLOAD_DIGEST: bytesDigest(archive) }
    // The positive retrieval (four API calls plus one storage redirect) succeeds; every request after it is an outage.
    const outage = (status) => { const state = fixture({ archive }); let calls = 0; const original = state.fetchImpl; state.fetchImpl = async (input, init) => (calls += 1) > 5 ? new Response('{}', { status }) : original(input, init); return state }
    for (const status of [500, 429]) {
      const state = outage(status)
      const results = await runNegatives({ env: consumerEnv, fetchImpl: state.fetchImpl })
      assert.equal(results.length, 10)
      const remote = results.slice(0, 9)
      assert.deepEqual(remote.map((result) => result.rejected), remote.map(() => false), `HTTP ${status} must not count as a rejection`)
      assert.deepEqual(remote.map((result) => result.unexpected), remote.map(() => true))
      for (const result of remote) assert.match(result.message, new RegExp(`HTTP ${status}`))
      assert.equal(results.at(-1).rejected, true, 'the local tamper case does not depend on the API')
      const out = []; const io = { env: consumerEnv, fetchImpl: outage(status).fetchImpl, stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => out.push(text) } }
      assert.equal(await runProofCli('negatives', io), 1)
      const printed = out.join(''); assert.equal((printed.match(/^UNEXPECTED ERROR /gm) ?? []).length, 9); assert.match(printed, /9 failed for an unexpected reason/); assert.doesNotMatch(printed, new RegExp(tokenSentinel))
    }
    // A network failure after the positive must likewise never count as a rejection.
    const network = fixture({ archive }); let calls = 0; const original = network.fetchImpl; network.fetchImpl = async (input, init) => { if ((calls += 1) > 5) throw new TypeError('fetch failed'); return original(input, init) }
    const networkResults = await runNegatives({ env: consumerEnv, fetchImpl: network.fetchImpl })
    assert.deepEqual(networkResults.slice(0, 9).map((result) => [result.rejected, result.unexpected, result.message]), Array.from({ length: 9 }, () => [false, true, 'fetch failed']))
    // A broken local fixture is an unexpected error, not a signature rejection.
    const healthy = fixture({ archive })
    const broken = await runNegatives({ env: consumerEnv, fetchImpl: healthy.fetchImpl, tamper: () => { throw new Error('Archive entry checksum does not match') } })
    assert.deepEqual(broken.slice(0, 9).filter((result) => !result.rejected), [])
    assert.deepEqual([broken.at(-1).rejected, broken.at(-1).unexpected, broken.at(-1).message], [false, true, 'Archive entry checksum does not match'])
    const io = { env: consumerEnv, fetchImpl: fixture({ archive }).fetchImpl, stdout: { write: () => {} }, stderr: { write: () => {} } }
    assert.equal(await runProofCli('negatives', io), 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
