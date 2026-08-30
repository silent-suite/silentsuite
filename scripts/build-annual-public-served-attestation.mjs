#!/usr/bin/env node
import { createHash, createHmac } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyPrePublicAdmission } from './verify-annual-pre-public-admission.mjs'

const sha = /^[0-9a-f]{40}$/
const timestamp = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/
const assert = (value, message) => { if (!value) throw new Error(message) }
const bytesDigest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`
const signed = (key, value) => createHmac('sha256', key).update(bytesDigest(JSON.stringify(value))).digest('hex')
const exactKeys = (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
function verifyRun(value, name) { assert(exactKeys(value, ['runId', 'runAttempt']), `${name} is malformed`); assert(Number.isInteger(value.runId) && value.runId > 0 && Number.isInteger(value.runAttempt) && value.runAttempt > 0, `${name} is invalid`) }
function verifyArtifact(value, name) { assert(exactKeys(value, ['repository', 'runId', 'runAttempt', 'artifactId']), `${name} is malformed`); assert(value.repository === 'silent-suite/silentsuite', `${name} repository is invalid`); assert(Number.isInteger(value.runId) && value.runId > 0 && Number.isInteger(value.runAttempt) && value.runAttempt > 0 && Number.isInteger(value.artifactId) && value.artifactId > 0, `${name} is invalid`) }
function validTimestamp(value) { return typeof value === 'string' && timestamp.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().replace(/\.000Z$/, 'Z') === value }
export function buildPublicServedAttestation({ admissionBytes, expectedPublicSha, expectedSourcePrivateSha, expectedSourceArtifact, expectedPublicRepository, privateAdmissionHmacKey, publicReviewHmacKey, publicServedHmacKey, publicDeploymentRun, publicArtifact, publicArtifactName, deploymentVerified, clientServedAt, now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') }) {
  assert(deploymentVerified === true, 'Public served attestation may be built only after verified Web and Docs deployment')
  assert(typeof publicServedHmacKey === 'string' && publicServedHmacKey.length > 0, 'Public served HMAC key is missing')
  assert(typeof expectedPublicSha === 'string' && sha.test(expectedPublicSha), 'Expected public SHA is malformed')
  const admissionDigest = bytesDigest(admissionBytes)
  const admission = verifyPrePublicAdmission({ admissionBytes, expectedAdmissionDigest: admissionDigest, expectedPublicSha, expectedSourcePrivateSha, expectedSourceArtifact, expectedPublicRepository, hmacKey: privateAdmissionHmacKey, publicReviewHmacKey })
  verifyRun(publicDeploymentRun, 'Public deployment run'); verifyArtifact(publicArtifact, 'Public artifact')
  assert(publicArtifact.runId === publicDeploymentRun.runId && publicArtifact.runAttempt === publicDeploymentRun.runAttempt, 'Public artifact must belong to the exact public deployment run and attempt')
  assert(publicArtifactName === `annual-only-public-served-attestation-${publicDeploymentRun.runId}-${publicDeploymentRun.runAttempt}`, 'Public served attestation artifact name is invalid')
  assert(validTimestamp(clientServedAt), 'Public served client timestamp is invalid')
  // The protected job obtains clientServedAt only after fresh Web and Docs
  // probes. All remaining admission, artifact, and signing preconditions are
  // checked above; verifiedAt is derived only after they have passed.
  const verifiedAt = now()
  assert(validTimestamp(verifiedAt), 'Public served verification timestamp is invalid')
  assert(Date.parse(verifiedAt) >= Date.parse(clientServedAt), 'Public served timestamp order is invalid')
  const unsigned = { schemaVersion: 1, predicateType: 'https://silentsuite.io/attestations/annual-only-public-served/v1', privateSha: admission.privateSha, publicSha: expectedPublicSha, privateAdmissionDigest: admissionDigest, billingImageDigest: admission.billingImageDigest, disclosureDigest: admission.disclosureDigest, privateDeploymentRun: admission.privateDeploymentRun, publicDeploymentRun, publicArtifact, clientServedAt, verifiedAt }
  const attestation = { ...unsigned, signature: signed(publicServedHmacKey, unsigned) }
  return { attestation, bytes: Buffer.from(`${JSON.stringify(attestation)}\n`) }
}
const positiveEnv = (value) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : undefined
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const env = process.env; const outputDirectory = env.ANNUAL_PUBLIC_SERVED_OUTPUT_DIRECTORY
    assert(typeof outputDirectory === 'string' && outputDirectory.length > 0, 'Public served output directory is missing')
    const admissionBytes = await readFile(env.ANNUAL_PRE_PUBLIC_ADMISSION ?? ''); const publicDeploymentRun = { runId: positiveEnv(env.GITHUB_RUN_ID), runAttempt: positiveEnv(env.GITHUB_RUN_ATTEMPT) }
    const { bytes } = buildPublicServedAttestation({ admissionBytes, expectedPublicSha: env.EXPECTED_PUBLIC_SHA, expectedSourcePrivateSha: env.ANNUAL_PRIVATE_ADMISSION_SOURCE_SHA, expectedSourceArtifact: { repository: env.ANNUAL_PRIVATE_ADMISSION_REPOSITORY, runId: positiveEnv(env.ANNUAL_PRIVATE_ADMISSION_RUN_ID), runAttempt: positiveEnv(env.ANNUAL_PRIVATE_ADMISSION_RUN_ATTEMPT), artifactId: positiveEnv(env.ANNUAL_PRIVATE_ADMISSION_ARTIFACT_ID), name: env.ANNUAL_PRIVATE_ADMISSION_ARTIFACT_NAME }, expectedPublicRepository: env.GITHUB_REPOSITORY, privateAdmissionHmacKey: env.ANNUAL_PRIVATE_ADMISSION_HMAC_KEY, publicReviewHmacKey: env.ANNUAL_PUBLIC_REVIEW_HMAC_KEY, publicServedHmacKey: env.ANNUAL_PUBLIC_SERVED_HMAC_KEY, publicDeploymentRun, publicArtifact: { repository: env.GITHUB_REPOSITORY, ...publicDeploymentRun, artifactId: positiveEnv(env.ANNUAL_PUBLIC_SERVED_ARTIFACT_ID) }, publicArtifactName: env.ANNUAL_PUBLIC_SERVED_ARTIFACT_NAME, deploymentVerified: env.ANNUAL_DEPLOYMENT_VERIFIED === 'true', clientServedAt: env.ANNUAL_PUBLIC_SERVED_CLIENT_SERVED_AT })
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 }); await writeFile(path.join(outputDirectory, 'annual-only-public-served-attestation.json'), bytes, { mode: 0o600 })
  } catch (error) { process.stderr.write(`Public served attestation rejected: ${error instanceof Error ? error.message : 'unknown error'}\n`); process.exitCode = 1 }
}
