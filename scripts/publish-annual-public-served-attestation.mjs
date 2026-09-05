#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { crc32 } from 'node:zlib'
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPublicServedAttestation } from './build-annual-public-served-attestation.mjs'

const assert = (value, message) => { if (!value) throw new Error(message) }; const positive = (value) => Number.isInteger(value) && value > 0; const positiveEnv = (value) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : undefined
// Builds the one-entry stored (uncompressed) ZIP in this process. An external archiver
// would inherit this process environment, handing the Actions runtime token, results URL,
// and Stage B signing keys to a substituted binary; keeping it in process keeps every
// credential inside the publisher. Output is deterministic: no timestamps, no extra fields.
export function buildStoredZipArchive(entryName, content) {
  const name = Buffer.from(entryName, 'utf8'); const body = Buffer.from(content); const checksum = crc32(body) >>> 0
  assert(name.length > 0 && !/[\\/]/.test(entryName), 'Public served archive entry name is invalid')
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0o600 << 16, 38)
  const centralOffset = local.length + name.length + body.length; const centralLength = central.length + name.length
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(centralLength, 12); end.writeUInt32LE(centralOffset, 16)
  return Buffer.concat([local, name, body, central, name, end])
}
export function artifactName({ runId, runAttempt }) { assert(positive(runId), 'Public served artifact run ID is invalid'); assert(positive(runAttempt), 'Public served artifact run attempt is invalid'); return `annual-only-public-served-attestation-${runId}-${runAttempt}` }
export function artifactRuntimeIds(token) {
  try { const encoded = token?.split('.')[1]; const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); const scope = String(payload.scp ?? '').split(' ').find((item) => item.startsWith('Actions.Results:')); const parts = scope?.split(':'); assert(parts?.length === 3 && parts[1] && parts[2], 'Actions artifact runtime token is malformed'); return { workflowRunBackendId: parts[1], workflowJobRunBackendId: parts[2] } } catch (error) { if (error instanceof Error && /runtime token/i.test(error.message)) throw error; throw new Error('Actions artifact runtime token is malformed') }
}
export function selectReservedArtifact(artifacts, name) { const matches = Array.isArray(artifacts) ? artifacts.filter((artifact) => artifact?.name === name) : []; assert(matches.length === 1, 'Expected exactly one reserved public served artifact'); const raw = matches[0].database_id ?? matches[0].databaseId; const artifactId = typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : raw; assert(positive(artifactId), 'Reserved public served artifact ID is invalid'); return artifactId }
// Requests are ProtoJSON exactly as the official @actions/artifact client bundled in the
// pinned actions/upload-artifact serializes them: proto field names, int64 as decimal
// strings, and google.protobuf.StringValue wrappers (mime_type, hash) as bare strings, never
// `{ value }`. A rejected call surfaces only the HTTP status and the Twirp error code (a
// closed lowercase token set), never the response body, URL, or token.
const twirpErrorCode = (body) => typeof body?.code === 'string' && /^[a-z_]{1,32}$/.test(body.code) ? body.code : undefined
async function twirp({ resultsUrl, runtimeToken, method, body }) {
  const response = await fetch(new URL(`/twirp/github.actions.results.api.v1.ArtifactService/${method}`, resultsUrl), { method: 'POST', headers: { Authorization: `Bearer ${runtimeToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!response.ok) { const code = twirpErrorCode(await response.json().catch(() => undefined)); throw new Error(`Actions artifact service ${method} failed (HTTP ${response.status}${code ? `, ${code}` : ''})`) }
  return response.json()
}
async function reserveArtifact({ resultsUrl, runtimeToken, ids, name }) {
  const create = await twirp({ resultsUrl, runtimeToken, method: 'CreateArtifact', body: { workflow_run_backend_id: ids.workflowRunBackendId, workflow_job_run_backend_id: ids.workflowJobRunBackendId, name, mime_type: 'application/zip', version: 7 } }); const signedUploadUrl = create.signed_upload_url ?? create.signedUploadUrl; assert(create.ok === true && typeof signedUploadUrl === 'string', 'Actions artifact reservation is invalid')
  for (let attempt = 0; attempt < 3; attempt += 1) { const list = await twirp({ resultsUrl, runtimeToken, method: 'ListArtifacts', body: { workflow_run_backend_id: ids.workflowRunBackendId, workflow_job_run_backend_id: ids.workflowJobRunBackendId } }); try { return { artifactId: selectReservedArtifact(list.artifacts, name), signedUploadUrl } } catch (error) { if (attempt === 2) throw error; await new Promise((resolve) => setTimeout(resolve, 1000)) } }
  throw new Error('Reserved public served artifact was not visible')
}
async function finalizeArtifact({ resultsUrl, runtimeToken, ids, name, zipPath, signedUploadUrl, artifactId }) {
  const bytes = await readFile(zipPath); const upload = await fetch(signedUploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/zip', 'Content-Length': String(bytes.length), 'x-ms-blob-type': 'BlockBlob' }, body: bytes }); assert(upload.ok, `Actions artifact blob upload failed (HTTP ${upload.status})`)
  const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`; const finalized = await twirp({ resultsUrl, runtimeToken, method: 'FinalizeArtifact', body: { workflow_run_backend_id: ids.workflowRunBackendId, workflow_job_run_backend_id: ids.workflowJobRunBackendId, name, size: String(bytes.length), hash } }); assert(finalized.ok === true && Number(finalized.artifact_id ?? finalized.artifactId) === artifactId, 'Finalized public served artifact identity changed'); return { artifactId, digest: hash }
}
async function publish() {
  const env = process.env; const run = { runId: positiveEnv(env.GITHUB_RUN_ID), runAttempt: positiveEnv(env.GITHUB_RUN_ATTEMPT) }; const name = artifactName(run); assert(env.ANNUAL_PUBLIC_SERVED_ARTIFACT_NAME === name, 'Public served artifact name is not the exact run-scoped canonical name'); assert(env.GITHUB_REPOSITORY === 'silent-suite/silentsuite', 'Public served artifact repository is invalid'); assert(typeof env.ACTIONS_RESULTS_URL === 'string' && /^https:\/\//.test(env.ACTIONS_RESULTS_URL), 'Actions artifact results URL is invalid'); assert(typeof env.ACTIONS_RUNTIME_TOKEN === 'string' && env.ACTIONS_RUNTIME_TOKEN.length > 0, 'Actions artifact runtime token is missing'); assert(env.ANNUAL_DEPLOYMENT_VERIFIED === 'true', 'Public served artifact may be published only after verified Web and Docs deployment')
  const ids = artifactRuntimeIds(env.ACTIONS_RUNTIME_TOKEN); const { artifactId, signedUploadUrl } = await reserveArtifact({ resultsUrl: env.ACTIONS_RESULTS_URL, runtimeToken: env.ACTIONS_RUNTIME_TOKEN, ids, name }); const outputDirectory = env.ANNUAL_PUBLIC_SERVED_OUTPUT_DIRECTORY; assert(typeof outputDirectory === 'string' && outputDirectory.length > 0, 'Public served output directory is missing'); await mkdir(outputDirectory, { recursive: true, mode: 0o700 }); const admissionBytes = await readFile(env.ANNUAL_PRE_PUBLIC_ADMISSION ?? '')
  const { bytes } = buildPublicServedAttestation({ admissionBytes, expectedPublicSha: env.EXPECTED_PUBLIC_SHA, expectedSourcePrivateSha: env.ANNUAL_PRIVATE_ADMISSION_SOURCE_SHA, expectedSourceArtifact: { repository: env.ANNUAL_PRIVATE_ADMISSION_REPOSITORY, runId: positiveEnv(env.ANNUAL_PRIVATE_ADMISSION_RUN_ID), runAttempt: positiveEnv(env.ANNUAL_PRIVATE_ADMISSION_RUN_ATTEMPT), artifactId: positiveEnv(env.ANNUAL_PRIVATE_ADMISSION_ARTIFACT_ID), name: env.ANNUAL_PRIVATE_ADMISSION_ARTIFACT_NAME }, expectedPublicRepository: env.GITHUB_REPOSITORY, privateAdmissionHmacKey: env.ANNUAL_PRIVATE_ADMISSION_HMAC_KEY, publicReviewHmacKey: env.ANNUAL_PUBLIC_REVIEW_HMAC_KEY, publicServedHmacKey: env.ANNUAL_PUBLIC_SERVED_HMAC_KEY, publicDeploymentRun: run, publicArtifact: { repository: env.GITHUB_REPOSITORY, ...run, artifactId }, publicArtifactName: name, deploymentVerified: true, clientServedAt: env.ANNUAL_PUBLIC_SERVED_CLIENT_SERVED_AT }); const attestationPath = path.join(outputDirectory, 'annual-only-public-served-attestation.json'); await writeFile(attestationPath, bytes, { mode: 0o600 }); const zipPath = path.join(outputDirectory, 'annual-only-public-served-attestation.zip'); await rm(zipPath, { force: true }); await writeFile(zipPath, buildStoredZipArchive(path.basename(attestationPath), bytes), { mode: 0o600 }); const finalized = await finalizeArtifact({ resultsUrl: env.ACTIONS_RESULTS_URL, runtimeToken: env.ACTIONS_RUNTIME_TOKEN, ids, name, zipPath, signedUploadUrl, artifactId }); if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `artifact_id=${finalized.artifactId}\nartifact_digest=${finalized.digest}\n`, { mode: 0o600 })
}
export async function runPublishCli() { try { await publish() } catch (error) { process.stderr.write(`Public served attestation publication rejected: ${error instanceof Error ? error.message : 'unknown error'}\n`); process.exitCode = 1 } }
if (process.argv[1] === fileURLToPath(import.meta.url)) await runPublishCli()
