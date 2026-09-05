#!/usr/bin/env node
// Nonproduction transport proof for the annual Stage B artifact simplification.
//
// It evidences one thing: a payload signed BEFORE upload with a key that never leaves
// the job, uploaded through the pinned official actions/upload-artifact, can be consumed
// independently by its exact finalized artifact ID through the GitHub API with archive
// digest, run, attempt, head SHA, repository, and producer workflow bindings. The signed
// body never names its own storage artifact ID. Nothing here touches a production path,
// verifier, key, secret, environment, or deployment.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, inflateRawSync } from 'node:zlib'
import { buildStoredZipArchive } from './publish-annual-public-served-attestation.mjs'

export const PROOF_ENTRY_NAME = 'annual-artifact-transport-proof.json'
export const PROOF_PREDICATE_TYPE = 'https://silentsuite.io/attestations/annual-artifact-transport-proof/v1'
export const PROOF_WORKFLOW_PATH = '.github/workflows/annual-artifact-transport-proof.yml'
export const PROOF_PAYLOAD_KEYS = ['schemaVersion', 'predicateType', 'repository', 'sourceSha', 'run', 'workflowPath', 'artifactName', 'predecessorDigest', 'servedIdentities', 'clientServedAt', 'verifiedAt', 'signature']
const MAX_ENTRY_BYTES = 64 * 1024
const sha = /^[0-9a-f]{40}$/
const hex64 = /^[0-9a-f]{64}$/
const repositoryPattern = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
const entryNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const timestamp = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/

const assert = (value, message) => { if (!value) throw new Error(message) }
const positive = (value) => Number.isInteger(value) && value > 0
const positiveEnv = (value) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : undefined
const exactKeys = (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
const validTimestamp = (value) => typeof value === 'string' && timestamp.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().replace(/\.000Z$/, 'Z') === value
const utcSeconds = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

export const bytesDigest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
// The official action's `artifact-digest` output and the GitHub API `digest` member may
// differ only by the `sha256:` prefix; both canonicalize to the prefixed lowercase form.
export function canonicalDigest(value) { if (typeof value !== 'string') return undefined; const raw = value.startsWith('sha256:') ? value.slice(7) : value; return hex64.test(raw) ? `sha256:${raw}` : undefined }
export function proofArtifactName({ runId, runAttempt } = {}) { assert(positive(runId) && positive(runAttempt), 'Proof run identity is invalid'); return `annual-artifact-transport-proof-${runId}-${runAttempt}` }
const signPayload = (key, unsigned) => createHmac('sha256', key).update(bytesDigest(Buffer.from(JSON.stringify(unsigned)))).digest('hex')
function verifyServedIdentities(value, sourceSha) { assert(exactKeys(value, ['web', 'docs']), 'Served identities are malformed'); for (const surface of ['web', 'docs']) { assert(exactKeys(value[surface], ['publicSha']) && value[surface].publicSha === sourceSha, `Served identity for ${surface} is not the source SHA`) } }
function verifyBindings({ repository, sourceSha, run, workflowPath, predecessorDigest, servedIdentities }) {
  assert(typeof repository === 'string' && repositoryPattern.test(repository), 'Proof repository is invalid')
  assert(typeof sourceSha === 'string' && sha.test(sourceSha), 'Proof source SHA is invalid')
  assert(exactKeys(run, ['runId', 'runAttempt']) && positive(run.runId) && positive(run.runAttempt), 'Proof run identity is invalid')
  assert(typeof workflowPath === 'string' && /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(workflowPath), 'Proof workflow path is invalid')
  assert(canonicalDigest(predecessorDigest) === predecessorDigest, 'Proof predecessor digest is invalid')
  verifyServedIdentities(servedIdentities, sourceSha)
}

export function buildProofPayload({ key, repository, sourceSha, run, workflowPath, predecessorDigest, servedIdentities, clientServedAt, verifiedAt }) {
  assert(typeof key === 'string' && hex64.test(key), 'Proof key must be 32 random bytes in lowercase hex')
  verifyBindings({ repository, sourceSha, run, workflowPath, predecessorDigest, servedIdentities })
  assert(validTimestamp(clientServedAt) && validTimestamp(verifiedAt) && Date.parse(verifiedAt) >= Date.parse(clientServedAt), 'Proof timestamps are invalid')
  // Deliberately no storage artifact ID: the consumer binds the finalized ID through the
  // GitHub API, so signing can happen before any artifact exists.
  const unsigned = { schemaVersion: 1, predicateType: PROOF_PREDICATE_TYPE, repository, sourceSha, run: { runId: run.runId, runAttempt: run.runAttempt }, workflowPath, artifactName: proofArtifactName(run), predecessorDigest, servedIdentities, clientServedAt, verifiedAt }
  const payload = { ...unsigned, signature: signPayload(key, unsigned) }
  return { payload, bytes: Buffer.from(`${JSON.stringify(payload)}\n`) }
}

// Bounded extraction of the one expected entry. Reads only the end record, the single
// central-directory entry, and the local header it points at; rejects anything else
// (multiple entries, other names, path separators, encryption, unknown methods,
// oversize, inconsistent offsets, size or CRC mismatch). Supports stored (method 0, the
// in-process production builder) and deflate (method 8, the official action's archiver,
// which uses data descriptors so sizes come from the central directory).
export function readSingleEntryArchive(bytes, expectedName, { maxBytes = MAX_ENTRY_BYTES } = {}) {
  assert(typeof expectedName === 'string' && entryNamePattern.test(expectedName) && !expectedName.includes('..'), 'Expected archive entry name is invalid')
  assert(Buffer.isBuffer(bytes) && bytes.length >= 22 + 46 + 30, 'Archive is truncated')
  let end = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 22 - 0xffff); offset -= 1) { if (bytes.readUInt32LE(offset) === 0x06054b50) { end = offset; break } }
  assert(end >= 0, 'Archive end record is missing')
  assert(bytes.readUInt16LE(end + 20) === bytes.length - end - 22, 'Archive end record comment length is inconsistent')
  assert(bytes.readUInt16LE(end + 8) === 1 && bytes.readUInt16LE(end + 10) === 1, 'Archive must contain exactly one entry')
  const centralSize = bytes.readUInt32LE(end + 12); const centralOffset = bytes.readUInt32LE(end + 16)
  assert(centralOffset + centralSize === end && centralSize >= 46, 'Archive central directory is inconsistent')
  assert(bytes.readUInt32LE(centralOffset) === 0x02014b50, 'Archive central directory header is invalid')
  const flags = bytes.readUInt16LE(centralOffset + 8); const method = bytes.readUInt16LE(centralOffset + 10); const checksum = bytes.readUInt32LE(centralOffset + 16)
  const compressedSize = bytes.readUInt32LE(centralOffset + 20); const uncompressedSize = bytes.readUInt32LE(centralOffset + 24)
  const nameLength = bytes.readUInt16LE(centralOffset + 28); const extraLength = bytes.readUInt16LE(centralOffset + 30); const commentLength = bytes.readUInt16LE(centralOffset + 32); const localOffset = bytes.readUInt32LE(centralOffset + 42)
  assert(46 + nameLength + extraLength + commentLength === centralSize, 'Archive central directory size is inconsistent')
  assert((flags & 0x1) === 0, 'Archive entry is encrypted')
  assert(method === 0 || method === 8, 'Archive entry compression method is unsupported')
  assert(bytes.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString('utf8') === expectedName, 'Archive entry name is not the exact expected file')
  assert(compressedSize <= maxBytes && uncompressedSize <= maxBytes && uncompressedSize > 0, 'Archive entry exceeds the bounded size')
  assert(localOffset + 30 <= centralOffset && bytes.readUInt32LE(localOffset) === 0x04034b50, 'Archive local header is invalid')
  const localNameLength = bytes.readUInt16LE(localOffset + 26); const localExtraLength = bytes.readUInt16LE(localOffset + 28)
  assert(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8') === expectedName, 'Archive local entry name differs from the central directory')
  const dataStart = localOffset + 30 + localNameLength + localExtraLength
  assert(dataStart + compressedSize <= centralOffset, 'Archive entry data overruns the central directory')
  const compressed = bytes.subarray(dataStart, dataStart + compressedSize)
  let content
  try { content = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: maxBytes }) } catch { throw new Error('Archive entry could not be inflated within the bounded size') }
  assert(content.length === uncompressedSize, 'Archive entry size does not match its header')
  assert((crc32(content) >>> 0) === checksum, 'Archive entry checksum does not match')
  return content
}

export function verifyProofArchive(archiveBytes, { key, repository, sourceSha, run, workflowPath, predecessorDigest, servedIdentities, payloadDigest }) {
  assert(typeof key === 'string' && hex64.test(key), 'Proof key is invalid')
  verifyBindings({ repository, sourceSha, run, workflowPath, predecessorDigest, servedIdentities })
  const content = readSingleEntryArchive(archiveBytes, PROOF_ENTRY_NAME)
  if (payloadDigest !== undefined) assert(bytesDigest(content) === payloadDigest, 'Extracted payload bytes differ from the produced payload digest')
  let payload
  try { payload = JSON.parse(content.toString('utf8')) } catch { throw new Error('Proof payload is not JSON') }
  assert(exactKeys(payload, PROOF_PAYLOAD_KEYS), 'Proof payload is malformed')
  const { signature, ...unsigned } = payload
  assert(typeof signature === 'string' && hex64.test(signature), 'Proof signature is malformed')
  assert(timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(signPayload(key, unsigned), 'hex')), 'Proof signature does not verify')
  assert(payload.schemaVersion === 1 && payload.predicateType === PROOF_PREDICATE_TYPE, 'Proof predicate is not the transport proof')
  assert(payload.repository === repository, 'Proof repository binding differs')
  assert(payload.sourceSha === sourceSha, 'Proof source SHA binding differs')
  assert(exactKeys(payload.run, ['runId', 'runAttempt']) && payload.run.runId === run.runId && payload.run.runAttempt === run.runAttempt, 'Proof run binding differs')
  assert(payload.workflowPath === workflowPath, 'Proof workflow path binding differs')
  assert(payload.artifactName === proofArtifactName(run), 'Proof artifact name binding differs')
  assert(payload.predecessorDigest === predecessorDigest, 'Proof predecessor digest binding differs')
  assert(JSON.stringify(payload.servedIdentities) === JSON.stringify(servedIdentities), 'Proof served identities differ')
  assert(validTimestamp(payload.clientServedAt) && validTimestamp(payload.verifiedAt) && Date.parse(payload.verifiedAt) >= Date.parse(payload.clientServedAt), 'Proof timestamps are invalid')
  return payload
}

// Independent consumption: every fact comes from the GitHub API, never from the producer's
// working tree. The archive download follows exactly one redirect and sends no credential
// to the storage host. Error messages carry routes, statuses, and IDs only; never a token.
export async function verifyPublishedArtifact({ fetchImpl = fetch, apiBase = 'https://api.github.com', token, repository, artifactId, uploadDigest, expectedEvent = 'pull_request', key, sourceSha, run, workflowPath, predecessorDigest, servedIdentities, payloadDigest }) {
  assert(typeof token === 'string' && token.length > 0, 'GitHub API token is missing')
  assert(positive(artifactId), 'Finalized artifact ID is invalid')
  const digest = canonicalDigest(uploadDigest); assert(digest, 'Upload digest output is malformed')
  verifyBindings({ repository, sourceSha, run, workflowPath, predecessorDigest, servedIdentities })
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  const api = async (route, init = {}) => { const response = await fetchImpl(new URL(`/repos/${repository}/${route}`, apiBase), { headers, redirect: 'manual', ...init }); return response }
  const json = async (route) => { const response = await api(route); assert(response.status === 200, `GitHub API ${route} failed (HTTP ${response.status})`); return response.json() }
  const name = proofArtifactName(run)
  const artifact = await json(`actions/artifacts/${artifactId}`)
  assert(artifact.id === artifactId, 'Artifact identity differs from the finalized ID')
  assert(artifact.name === name, 'Artifact name is not the exact run-scoped proof name')
  assert(artifact.expired === false, 'Artifact is expired')
  assert(canonicalDigest(artifact.digest) === digest, 'GitHub API artifact digest differs from the upload output digest')
  assert(artifact.workflow_run?.id === run.runId, 'Artifact does not belong to the exact run')
  assert(artifact.workflow_run?.head_sha === sourceSha, 'Artifact run head differs from the source SHA')
  const workflowRun = await json(`actions/runs/${run.runId}`)
  assert(workflowRun.id === run.runId && workflowRun.run_attempt === run.runAttempt, 'Run attempt differs from the expected attempt')
  assert(workflowRun.head_sha === sourceSha, 'Run head differs from the source SHA')
  assert(workflowRun.repository?.full_name === repository && workflowRun.head_repository?.full_name === repository, 'Run repository is not the exact same repository')
  assert(workflowRun.event === expectedEvent, 'Run event is not the expected trigger')
  assert(positive(workflowRun.workflow_id), 'Run workflow identity is invalid')
  const workflow = await json(`actions/workflows/${workflowRun.workflow_id}`)
  assert(workflow.id === workflowRun.workflow_id && workflow.path === workflowPath, 'Producer workflow path differs')
  let download = await api(`actions/artifacts/${artifactId}/zip`)
  if ([301, 302, 303, 307, 308].includes(download.status)) { const location = download.headers.get('location'); assert(typeof location === 'string' && /^https:\/\//.test(location), 'Artifact download redirect is invalid'); download = await fetchImpl(location, { redirect: 'manual' }) }
  assert(download.status === 200, `Artifact archive download failed (HTTP ${download.status})`)
  const archive = Buffer.from(await download.arrayBuffer())
  assert(bytesDigest(archive) === digest, 'Downloaded archive SHA-256 differs from the upload output and API digest')
  const payload = verifyProofArchive(archive, { key, repository, sourceSha, run, workflowPath, predecessorDigest, servedIdentities, payloadDigest })
  return { artifactId, digest, archive, payload }
}

// CLI: produce | consume | negatives. The ephemeral key lives only in PROOF_DIRECTORY/key
// (mode 0600) inside the runner's temp directory and is never printed or exported.
function proofDirectory(env) { const directory = env.PROOF_DIRECTORY; assert(typeof directory === 'string' && path.isAbsolute(directory), 'PROOF_DIRECTORY must be an absolute path'); return directory }
export async function produceProof({ env = process.env, random = randomBytes, now = utcSeconds } = {}) {
  const directory = proofDirectory(env)
  const run = { runId: positiveEnv(env.GITHUB_RUN_ID), runAttempt: positiveEnv(env.GITHUB_RUN_ATTEMPT) }
  const key = random(32).toString('hex'); const sourceSha = env.PROOF_SOURCE_SHA; const clientServedAt = now(); const verifiedAt = now()
  const expected = { repository: env.GITHUB_REPOSITORY, sourceSha, run, workflowPath: env.PROOF_WORKFLOW_PATH ?? PROOF_WORKFLOW_PATH, artifactName: undefined, predecessorDigest: bytesDigest(random(32)), servedIdentities: { web: { publicSha: sourceSha }, docs: { publicSha: sourceSha } } }
  const { bytes } = buildProofPayload({ key, ...expected, clientServedAt, verifiedAt })
  expected.artifactName = proofArtifactName(run); expected.payloadDigest = bytesDigest(bytes)
  const stage = path.join(directory, 'stage')
  await mkdir(stage, { recursive: true, mode: 0o700 })
  await writeFile(path.join(stage, PROOF_ENTRY_NAME), bytes, { mode: 0o600 })
  await writeFile(path.join(directory, 'key'), key, { mode: 0o600 })
  await writeFile(path.join(directory, 'expected.json'), `${JSON.stringify(expected)}\n`, { mode: 0o600 })
  return { artifactName: expected.artifactName, payloadDigest: expected.payloadDigest, stagedPath: path.join(stage, PROOF_ENTRY_NAME) }
}
async function consumerInputs(env) {
  const directory = proofDirectory(env)
  assert(!existsSync(path.join(directory, 'stage')), 'Staged payload must be removed before independent consumption')
  const expected = JSON.parse(await readFile(path.join(directory, 'expected.json'), 'utf8'))
  const key = (await readFile(path.join(directory, 'key'), 'utf8')).trim()
  return { token: env.GH_TOKEN, artifactId: positiveEnv(env.PROOF_ARTIFACT_ID), uploadDigest: env.PROOF_UPLOAD_DIGEST, expectedEvent: env.PROOF_EVENT ?? 'pull_request', key, repository: expected.repository, sourceSha: expected.sourceSha, run: expected.run, workflowPath: expected.workflowPath, predecessorDigest: expected.predecessorDigest, servedIdentities: expected.servedIdentities, payloadDigest: expected.payloadDigest }
}
export async function consumeProof({ env = process.env, fetchImpl = fetch } = {}) {
  const inputs = await consumerInputs(env)
  const result = await verifyPublishedArtifact({ fetchImpl, ...inputs })
  return { artifactId: result.artifactId, digest: result.digest, artifactName: result.payload.artifactName, payloadDigest: bytesDigest(Buffer.from(`${JSON.stringify(result.payload)}\n`)) }
}
export function tamperedArchive(archive, mutate) {
  const content = readSingleEntryArchive(archive, PROOF_ENTRY_NAME); const payload = JSON.parse(content.toString('utf8')); mutate(payload)
  return buildStoredZipArchive(PROOF_ENTRY_NAME, `${JSON.stringify(payload)}\n`)
}
export async function runNegatives({ env = process.env, fetchImpl = fetch } = {}) {
  const inputs = await consumerInputs(env)
  const positiveResult = await verifyPublishedArtifact({ fetchImpl, ...inputs })
  const flipDigest = (digest) => `${digest.slice(0, -1)}${digest.endsWith('0') ? '1' : '0'}`
  const otherSha = inputs.sourceSha.endsWith('0') ? `${inputs.sourceSha.slice(0, -1)}1` : `${inputs.sourceSha.slice(0, -1)}0`
  const remote = (name, patch) => [name, () => verifyPublishedArtifact({ fetchImpl, ...inputs, ...patch })]
  const cases = [
    remote('wrong artifact ID', { artifactId: inputs.artifactId + 1 }),
    remote('wrong upload digest', { uploadDigest: flipDigest(inputs.uploadDigest) }),
    remote('wrong run ID', { run: { ...inputs.run, runId: inputs.run.runId + 1 } }),
    remote('wrong run attempt', { run: { ...inputs.run, runAttempt: inputs.run.runAttempt + 1 } }),
    remote('wrong source SHA', { sourceSha: otherSha, servedIdentities: { web: { publicSha: otherSha }, docs: { publicSha: otherSha } } }),
    remote('wrong producer workflow path', { workflowPath: '.github/workflows/annual-only-public-cutover.yml' }),
    remote('wrong repository', { repository: `${inputs.repository}-substitute` }),
    remote('wrong predecessor digest', { predecessorDigest: flipDigest(inputs.predecessorDigest) }),
    remote('wrong signing key', { key: flipDigest(inputs.key) }),
    // The produced-bytes digest is deliberately not supplied here so that the signature,
    // not the byte digest, is what rejects a payload altered after signing.
    ['altered signed payload', () => verifyProofArchive(tamperedArchive(positiveResult.archive, (payload) => { payload.predecessorDigest = flipDigest(payload.predecessorDigest) }), { ...inputs, predecessorDigest: flipDigest(inputs.predecessorDigest), payloadDigest: undefined })],
  ]
  const results = []
  for (const [name, attempt] of cases) { try { await attempt(); results.push({ name, rejected: false, message: 'accepted' }) } catch (error) { results.push({ name, rejected: true, message: error instanceof Error ? error.message : 'unknown error' }) } }
  return results
}
export async function runProofCli(command = process.argv[2], io = { env: process.env, fetchImpl: fetch, stdout: process.stdout, stderr: process.stderr }) {
  try {
    if (command === 'produce') { const result = await produceProof({ env: io.env }); io.stdout.write(`Proof payload staged for ${result.artifactName} (payload ${result.payloadDigest})\n`); return 0 }
    if (command === 'consume') { const result = await consumeProof({ env: io.env, fetchImpl: io.fetchImpl }); io.stdout.write(`Proof consumed independently: artifact ${result.artifactId} ${result.digest} entry ${PROOF_ENTRY_NAME} payload ${result.payloadDigest}\n`); return 0 }
    if (command === 'negatives') {
      const results = await runNegatives({ env: io.env, fetchImpl: io.fetchImpl }); let accepted = 0
      for (const result of results) { io.stdout.write(`${result.rejected ? 'rejected' : 'ACCEPTED'} ${result.name}: ${result.message}\n`); if (!result.rejected) accepted += 1 }
      assert(results.length === 10 && accepted === 0, `${accepted} substitution or replay negative(s) were accepted`); return 0
    }
    throw new Error('Usage: annual-artifact-transport-proof.mjs produce|consume|negatives')
  } catch (error) { io.stderr.write(`Annual artifact transport proof failed: ${error instanceof Error ? error.message : 'unknown error'}\n`); return 1 }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await runProofCli()
