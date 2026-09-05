import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { artifactName, artifactRuntimeIds, buildStoredZipArchive, selectReservedArtifact } from './publish-annual-public-served-attestation.mjs'
test('derives only the canonical served-attestation artifact name from positive immutable run identity', () => { assert.equal(artifactName({ runId: 123, runAttempt: 4 }), 'annual-only-public-served-attestation-123-4'); assert.throws(() => artifactName({ runId: 0, runAttempt: 4 }), /run/i); assert.throws(() => artifactName({ runId: 123, runAttempt: 0 }), /attempt/i) })
test('uses only the scoped Actions artifact runtime identity and rejects stale, duplicate, or malformed artifact reservations', () => { const payload = Buffer.from(JSON.stringify({ scp: 'Actions.ExampleScope Actions.Results:run-backend:job-backend' })).toString('base64url'); assert.deepEqual(artifactRuntimeIds(`header.${payload}.signature`), { workflowRunBackendId: 'run-backend', workflowJobRunBackendId: 'job-backend' }); assert.throws(() => artifactRuntimeIds('not-a-jwt'), /runtime token/i); const name = 'annual-only-public-served-attestation-123-4'; assert.equal(selectReservedArtifact([{ name, database_id: '77' }], name), 77); assert.throws(() => selectReservedArtifact([], name), /exactly one/i); assert.throws(() => selectReservedArtifact([{ name, database_id: '77' }, { name, database_id: '78' }], name), /exactly one/i); assert.throws(() => selectReservedArtifact([{ name, database_id: '0' }], name), /artifact ID/i) })

// Execution-level coverage of the exact production boundary: the real local JavaScript
// action entrypoint is launched as a child process against a mock Actions artifact
// service, so a broken action wiring, a missing runtime variable, a lost step output, or
// a leaked credential fails here rather than only during a spent-SHA cutover dispatch.
const runtimeTokenSentinel = 'RUNTIME-TOKEN-SENTINEL-6f2a1c'
const resultsUrlSentinel = 'results-receiver-sentinel-9d34b7.invalid'
const privateHmacKeySentinel = 'PRIVATE-ADMISSION-KEY-SENTINEL-41cc9e'
const servedHmacKeySentinel = 'PUBLIC-SERVED-KEY-SENTINEL-7b05fa'
const publicSha = 'b'.repeat(40)
const privateSha = 'a'.repeat(40)
const sourceArtifact = { repository: 'silent-suite/silentsuite-internal', runId: 918273645, runAttempt: 2, artifactId: 881, name: 'annual-only-pre-public-admission-918273645-2' }
const reservedArtifactId = 774
const publicRunId = 33907789637
const publicRunAttempt = 2
const publicArtifactName = `annual-only-public-served-attestation-${publicRunId}-${publicRunAttempt}`
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const signFixture = (key, value) => createHmac('sha256', key).update(`sha256:${sha256(JSON.stringify(value))}`).digest('hex')
const runtimeToken = `header.${Buffer.from(JSON.stringify({ scp: `Actions.Results:${publicRunId}-backend:${publicRunId}-job-backend` })).toString('base64url')}.${runtimeTokenSentinel}`

function admissionFixtureBytes() {
  const reviewUnsigned = { schemaVersion: 2, predicateType: 'https://silentsuite.io/attestations/annual-only-public-review/v2', repository: 'silent-suite/silentsuite', publicSha, runId: 44, runAttempt: 2, disclosureDigest: `sha256:${'2'.repeat(64)}` }
  const unsigned = {
    schemaVersion: 2,
    predicateType: 'https://silentsuite.io/attestations/annual-only-pre-public-admission/v2',
    privateSha,
    expectedPublicSha: publicSha,
    billingImageDigest: `sha256:${'c'.repeat(64)}`,
    rollbackImageDigest: `sha256:${'d'.repeat(64)}`,
    buildAttestationDigest: `sha256:${'e'.repeat(64)}`,
    qaAttestationDigest: `sha256:${'f'.repeat(64)}`,
    providerRegistryDigest: `sha256:${'1'.repeat(64)}`,
    providerAdmission: { artifactId: 88, archiveDigest: `sha256:${'3'.repeat(64)}`, statementDigest: `sha256:${'4'.repeat(64)}`, runId: 33368609150, runAttempt: 1 },
    disclosureDigest: `sha256:${'2'.repeat(64)}`,
    producerRun: { runId: sourceArtifact.runId, runAttempt: sourceArtifact.runAttempt },
    deployedRuntime: { privateSha: '5'.repeat(40), imageDigest: `sha256:${'c'.repeat(64)}`, phase: 'additive', deployedAt: '2026-08-30T10:00:00Z', observedAt: '2026-08-31T09:00:00Z', reobservedAt: '2026-08-31T09:00:05Z' },
    publicReview: { ...reviewUnsigned, signature: signFixture(privateHmacKeySentinel, reviewUnsigned) },
  }
  return Buffer.from(`${JSON.stringify({ ...unsigned, signature: signFixture(privateHmacKeySentinel, unsigned) })}\n`)
}

// Replaces global fetch inside the spawned action process only. It never records a
// credential: the Authorization header is compared in place and reduced to a boolean.
const mockArtifactServiceSource = (callLogPath, uploadPath) => `import { appendFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const record = (entry) => appendFileSync(${JSON.stringify(callLogPath)}, JSON.stringify(entry) + '\\n')
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
globalThis.fetch = async (input, init = {}) => {
  const url = String(input)
  if (init.method === 'PUT') {
    const bytes = Buffer.from(init.body)
    writeFileSync(${JSON.stringify(uploadPath)}, bytes)
    record({ call: 'upload', url, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), contentType: init.headers?.['Content-Type'] ?? null, blobType: init.headers?.['x-ms-blob-type'] ?? null })
    return new Response('', { status: 200 })
  }
  const call = url.slice(url.lastIndexOf('/') + 1)
  const body = JSON.parse(init.body)
  record({ call, url, bearerIsRuntimeToken: init.headers?.Authorization === 'Bearer ' + process.env.ACTIONS_RUNTIME_TOKEN, workflowRunBackendId: body.workflow_run_backend_id ?? null, workflowJobRunBackendId: body.workflow_job_run_backend_id ?? null, name: body.name ?? null, size: body.size ?? null, hash: body.hash?.value ?? null, version: body.version ?? null })
  if (call === 'CreateArtifact') return json({ ok: true, signed_upload_url: 'https://mock-artifact-blob.invalid/upload' })
  if (call === 'ListArtifacts') return json({ artifacts: [{ name: process.env.ANNUAL_PUBLIC_SERVED_ARTIFACT_NAME, database_id: '${reservedArtifactId}' }] })
  if (call === 'FinalizeArtifact') return json({ ok: true, artifact_id: ${reservedArtifactId} })
  return new Response('', { status: 404 })
}
`

function runPublishAction(environmentOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'annual-stage-b-action-'))
  const callLogPath = join(root, 'artifact-service-calls.jsonl')
  const uploadPath = join(root, 'uploaded-artifact.zip')
  const admissionPath = join(root, 'annual-only-pre-public-admission.json')
  const mockPath = join(root, 'mock-artifact-service.mjs')
  const githubEnv = join(root, 'github-env')
  const githubOutput = join(root, 'github-output')
  const outputDirectory = join(root, 'public-served')
  writeFileSync(callLogPath, '')
  writeFileSync(githubEnv, '')
  writeFileSync(githubOutput, '')
  writeFileSync(admissionPath, admissionFixtureBytes())
  writeFileSync(mockPath, mockArtifactServiceSource(callLogPath, uploadPath))
  const environment = {
    PATH: process.env.PATH ?? '',
    NODE_OPTIONS: `--import ${pathToFileURL(mockPath).href}`,
    GITHUB_RUN_ID: String(publicRunId),
    GITHUB_RUN_ATTEMPT: String(publicRunAttempt),
    GITHUB_REPOSITORY: 'silent-suite/silentsuite',
    GITHUB_ENV: githubEnv,
    GITHUB_OUTPUT: githubOutput,
    ACTIONS_RESULTS_URL: `https://${resultsUrlSentinel}/`,
    ACTIONS_RUNTIME_TOKEN: runtimeToken,
    ANNUAL_DEPLOYMENT_VERIFIED: 'true',
    ANNUAL_PUBLIC_SERVED_ARTIFACT_NAME: publicArtifactName,
    ANNUAL_PUBLIC_SERVED_OUTPUT_DIRECTORY: outputDirectory,
    ANNUAL_PUBLIC_SERVED_CLIENT_SERVED_AT: '2026-08-11T12:00:05Z',
    ANNUAL_PRE_PUBLIC_ADMISSION: admissionPath,
    ANNUAL_PRIVATE_ADMISSION_REPOSITORY: sourceArtifact.repository,
    ANNUAL_PRIVATE_ADMISSION_RUN_ID: String(sourceArtifact.runId),
    ANNUAL_PRIVATE_ADMISSION_RUN_ATTEMPT: String(sourceArtifact.runAttempt),
    ANNUAL_PRIVATE_ADMISSION_ARTIFACT_ID: String(sourceArtifact.artifactId),
    ANNUAL_PRIVATE_ADMISSION_ARTIFACT_NAME: sourceArtifact.name,
    ANNUAL_PRIVATE_ADMISSION_SOURCE_SHA: privateSha,
    ANNUAL_PRIVATE_ADMISSION_HMAC_KEY: privateHmacKeySentinel,
    ANNUAL_PUBLIC_REVIEW_HMAC_KEY: privateHmacKeySentinel,
    ANNUAL_PUBLIC_SERVED_HMAC_KEY: servedHmacKeySentinel,
    EXPECTED_PUBLIC_SHA: publicSha,
  }
  for (const [key, value] of Object.entries(environmentOverrides)) { if (value === undefined) delete environment[key]; else environment[key] = value }
  const result = spawnSync(process.execPath, [resolve('.github/actions/publish-annual-public-served-attestation/index.mjs')], { cwd: resolve('.'), encoding: 'utf8', env: environment })
  const calls = readFileSync(callLogPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const emitted = `${result.stdout}${result.stderr}${readFileSync(githubEnv, 'utf8')}${readFileSync(githubOutput, 'utf8')}`
  const outputs = Object.fromEntries(readFileSync(githubOutput, 'utf8').split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
  const uploaded = existsSync(uploadPath) ? readFileSync(uploadPath) : undefined
  const attestationPath = join(outputDirectory, 'annual-only-public-served-attestation.json')
  const attestation = existsSync(attestationPath) ? JSON.parse(readFileSync(attestationPath, 'utf8')) : undefined
  rmSync(root, { recursive: true, force: true })
  return { result, calls, emitted, outputs, uploaded, attestation }
}

// Reads the archive back with `unzip`, an implementation this repository does not own, so
// a hand-written ZIP that only our own reader can parse cannot pass.
function inspectArchive(bytes) {
  const root = mkdtempSync(join(tmpdir(), 'annual-stage-b-archive-'))
  const archivePath = join(root, 'archive.zip')
  writeFileSync(archivePath, bytes)
  const unzip = (...args) => spawnSync('unzip', [...args, archivePath], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  const integrity = unzip('-t')
  const listing = unzip('-Z1')
  const names = listing.stdout.split('\n').filter(Boolean)
  const body = names.length === 1 ? unzip('-p') : { stdout: '', status: 0, stderr: '' }
  rmSync(root, { recursive: true, force: true })
  assert.equal(integrity.status, 0, `archive failed unzip integrity test: ${integrity.stderr}${integrity.stdout}`)
  assert.equal(listing.status, 0, listing.stderr)
  assert.equal(body.status, 0, body.stderr)
  return { names, body: body.stdout }
}

const forbiddenSentinels = new RegExp([runtimeTokenSentinel, resultsUrlSentinel, privateHmacKeySentinel, servedHmacKeySentinel].join('|'))

test('the real local JavaScript action entrypoint receives the Actions runtime variables, reserves before signing, finalizes exactly one artifact, and propagates its exact identity', () => {
  const { result, calls, outputs, uploaded, attestation, emitted } = runPublishAction()
  assert.equal(result.status, 0, `action entrypoint failed: ${result.stderr}`)
  assert.deepEqual(calls.map((call) => call.call), ['CreateArtifact', 'ListArtifacts', 'upload', 'FinalizeArtifact'])
  const [create, list, upload, finalize] = calls
  // Runtime env actually reached the publisher process through the action runtime.
  assert.equal(create.url, `https://${resultsUrlSentinel}/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact`)
  for (const call of [create, list, finalize]) { assert.equal(call.bearerIsRuntimeToken, true); assert.equal(call.workflowRunBackendId, `${publicRunId}-backend`); assert.equal(call.workflowJobRunBackendId, `${publicRunId}-job-backend`) }
  // Reservation happens before any signed content exists, and the identity never changes.
  assert.equal(create.name, publicArtifactName); assert.equal(create.version, 7)
  assert.equal(finalize.name, publicArtifactName)
  assert.equal(upload.url, 'https://mock-artifact-blob.invalid/upload'); assert.equal(upload.contentType, 'application/zip'); assert.equal(upload.blobType, 'BlockBlob')
  assert.equal(finalize.hash, `sha256:${upload.sha256}`); assert.equal(finalize.size, String(uploaded.length))
  assert.deepEqual(outputs, { artifact_id: String(reservedArtifactId), artifact_digest: `sha256:${sha256(uploaded)}` })
  assert.equal(attestation.publicArtifact.artifactId, reservedArtifactId)
  assert.equal(attestation.publicSha, publicSha)
  assert.deepEqual(attestation.publicDeploymentRun, { runId: publicRunId, runAttempt: publicRunAttempt })
  assert.doesNotMatch(emitted, forbiddenSentinels)
  // The uploaded bytes are a readable single-entry archive holding exactly the signed attestation.
  const archive = inspectArchive(uploaded)
  assert.deepEqual(archive.names, ['annual-only-public-served-attestation.json'])
  assert.equal(archive.body, `${JSON.stringify(attestation)}\n`)
})

test('the publisher creates the artifact archive in process, so no credential is ever exposed to a child process environment', () => {
  const publisher = readFileSync(resolve('scripts/publish-annual-public-served-attestation.mjs'), 'utf8')
  assert.doesNotMatch(publisher, /child_process|execFile|spawn|exec\(/)
  const archive = inspectArchive(buildStoredZipArchive('annual-only-public-served-attestation.json', Buffer.from('{"schemaVersion":2}\n')))
  assert.deepEqual(archive, { names: ['annual-only-public-served-attestation.json'], body: '{"schemaVersion":2}\n' })
  assert.deepEqual(buildStoredZipArchive('a.json', Buffer.from('x')), buildStoredZipArchive('a.json', Buffer.from('x')))
})

test('an unverified deployment fails closed before the artifact is ever reserved and leaks no credential', () => {
  const { result, calls, emitted, outputs } = runPublishAction({ ANNUAL_DEPLOYMENT_VERIFIED: undefined })
  assert.notEqual(result.status, 0)
  assert.deepEqual(calls, [])
  assert.deepEqual(outputs, {})
  assert.match(result.stderr, /Public served attestation publication rejected/)
  assert.doesNotMatch(emitted, forbiddenSentinels)
})
