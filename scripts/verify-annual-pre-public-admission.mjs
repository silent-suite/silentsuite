#!/usr/bin/env node
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const topLevelKeys = ['schemaVersion', 'predicateType', 'privateSha', 'expectedPublicSha', 'billingImageDigest', 'rollbackImageDigest', 'buildAttestationDigest', 'qaAttestationDigest', 'providerRegistryDigest', 'providerAdmission', 'disclosureDigest', 'privateDeploymentRun', 'publicReview', 'signature']
const sha = /^[0-9a-f]{40}$/
const digest = /^sha256:[0-9a-f]{64}$/
const signature = /^[0-9a-f]{64}$/
const repository = /^silent-suite\/[a-z0-9._-]+$/
const assert = (value, message) => { if (!value) throw new Error(message) }
const exactKeys = (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
const bytesDigest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`
const signed = (key, value) => createHmac('sha256', key).update(bytesDigest(JSON.stringify(value))).digest('hex')
const equal = (left, right) => { const actual = Buffer.from(left ?? ''); const expected = Buffer.from(right ?? ''); return actual.length === expected.length && timingSafeEqual(actual, expected) }
const positive = (value, name) => assert(Number.isInteger(value) && value > 0, `${name} is invalid`)

function verifyRun(value, name) {
  assert(exactKeys(value, ['runId', 'runAttempt']), `${name} has missing or unknown fields`)
  positive(value.runId, `${name}.runId`); positive(value.runAttempt, `${name}.runAttempt`)
}
function verifyPublicReview(value, expectedPublicSha, publicReviewHmacKey) {
  assert(exactKeys(value, ['schemaVersion', 'predicateType', 'repository', 'publicSha', 'runId', 'runAttempt', 'disclosureDigest', 'signature']), 'Pre-public signed v2 public review has missing or unknown fields')
  assert(value.schemaVersion === 2 && value.predicateType === 'https://silentsuite.io/attestations/annual-only-public-review/v2', 'Pre-public signed v2 public review predicate is invalid')
  assert(value.repository === 'silent-suite/silentsuite', 'Pre-public signed v2 public review repository is invalid')
  assert(value.publicSha === expectedPublicSha, 'Pre-public signed v2 public review does not admit the exact public SHA')
  positive(value.runId, 'Pre-public signed v2 public review run ID'); positive(value.runAttempt, 'Pre-public signed v2 public review run attempt')
  assert(digest.test(value.disclosureDigest), 'Pre-public signed v2 public review disclosure digest is invalid')
  assert(typeof publicReviewHmacKey === 'string' && publicReviewHmacKey.length > 0, 'Public review HMAC key is missing')
  const unsigned = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'signature'))
  assert(typeof value.signature === 'string' && signature.test(value.signature) && equal(value.signature, signed(publicReviewHmacKey, unsigned)), 'Pre-public signed v2 public review signature is invalid')
}
function verifyExpectedSourceArtifact(value) {
  assert(exactKeys(value, ['repository', 'runId', 'runAttempt', 'artifactId', 'name']), 'Expected private source artifact is malformed')
  assert(value.repository === 'silent-suite/silentsuite-internal', 'Expected private source artifact repository is invalid')
  positive(value.runId, 'Expected private source artifact run ID'); positive(value.runAttempt, 'Expected private source artifact run attempt'); positive(value.artifactId, 'Expected private source artifact ID')
  assert(value.name === `annual-only-pre-public-admission-${value.runId}-${value.runAttempt}`, 'Expected private source artifact name is invalid')
}

export function verifyPrePublicAdmission({ admissionBytes, expectedAdmissionDigest, expectedPublicSha, expectedSourcePrivateSha, expectedSourceArtifact, expectedPublicRepository, hmacKey, publicReviewHmacKey }) {
  const bytes = Buffer.isBuffer(admissionBytes) ? admissionBytes : Buffer.from(admissionBytes ?? '')
  assert(bytes.length > 0, 'Pre-public admission is missing')
  assert(typeof expectedAdmissionDigest === 'string' && digest.test(expectedAdmissionDigest), 'Pre-public admission digest is malformed')
  assert(equal(bytesDigest(bytes), expectedAdmissionDigest), 'Pre-public admission digest does not match exact downloaded bytes')
  assert(typeof expectedPublicSha === 'string' && sha.test(expectedPublicSha), 'Expected public SHA is malformed')
  assert(typeof expectedSourcePrivateSha === 'string' && sha.test(expectedSourcePrivateSha), 'Expected private source SHA is malformed')
  verifyExpectedSourceArtifact(expectedSourceArtifact)
  assert(expectedPublicRepository === 'silent-suite/silentsuite', 'Expected public repository is invalid')
  assert(typeof hmacKey === 'string' && hmacKey.length > 0, 'Private admission HMAC key is missing')
  let admission
  try { admission = JSON.parse(bytes) } catch { throw new Error('Pre-public admission is not valid JSON') }
  assert(exactKeys(admission, topLevelKeys), 'Pre-public admission must use the exact closed schema')
  assert(admission.schemaVersion === 1 && admission.predicateType === 'https://silentsuite.io/attestations/annual-only-pre-public-admission/v1', 'Pre-public admission predicate is invalid')
  assert(sha.test(admission.privateSha) && sha.test(admission.expectedPublicSha), 'Pre-public admission SHA binding is invalid')
  for (const key of ['billingImageDigest', 'rollbackImageDigest', 'buildAttestationDigest', 'qaAttestationDigest', 'providerRegistryDigest', 'disclosureDigest']) assert(typeof admission[key] === 'string' && digest.test(admission[key]), `Pre-public admission ${key} is invalid`)
  assert(exactKeys(admission.providerAdmission, ['artifactId', 'archiveDigest', 'statementDigest', 'runId', 'runAttempt']), 'Pre-public provider admission has missing or unknown fields')
  positive(admission.providerAdmission.artifactId, 'Pre-public provider admission artifact ID')
  assert(digest.test(admission.providerAdmission.archiveDigest) && digest.test(admission.providerAdmission.statementDigest), 'Pre-public provider admission digest is invalid')
  assert(admission.providerAdmission.runId === admission.privateDeploymentRun.runId && admission.providerAdmission.runAttempt === admission.privateDeploymentRun.runAttempt, 'Pre-public provider admission is not bound to the private deployment run')
  verifyRun(admission.privateDeploymentRun, 'Pre-public private deployment run'); verifyPublicReview(admission.publicReview, expectedPublicSha, publicReviewHmacKey)
  assert(expectedPublicRepository === admission.publicReview.repository, 'Pre-public admission review repository is not this public repository')
  assert(admission.privateDeploymentRun.runId === expectedSourceArtifact.runId && admission.privateDeploymentRun.runAttempt === expectedSourceArtifact.runAttempt, 'Pre-public admission private deployment run does not match its immutable source artifact')
  assert(admission.privateSha === expectedSourcePrivateSha, 'Pre-public admission private SHA does not match its immutable source run')
  assert(typeof admission.signature === 'string' && signature.test(admission.signature), 'Pre-public admission signature is malformed')
  const unsigned = Object.fromEntries(Object.entries(admission).filter(([key]) => key !== 'signature'))
  assert(equal(admission.signature, signed(hmacKey, unsigned)), 'Pre-public admission signature is invalid')
  assert(admission.expectedPublicSha === expectedPublicSha, 'Pre-public admission does not admit this exact public SHA')
  return { privateSha: admission.privateSha, expectedPublicSha: admission.expectedPublicSha, billingImageDigest: admission.billingImageDigest, disclosureDigest: admission.disclosureDigest, privateDeploymentRun: admission.privateDeploymentRun, privateAdmissionDigest: expectedAdmissionDigest }
}
const positiveEnv = (value) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : undefined
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const env = process.env; const admissionBytes = await readFile(env.ANNUAL_PRE_PUBLIC_ADMISSION ?? '')
    const result = verifyPrePublicAdmission({ admissionBytes, expectedAdmissionDigest: env.ANNUAL_PRIVATE_ADMISSION_DIGEST, expectedPublicSha: env.EXPECTED_PUBLIC_SHA, expectedSourcePrivateSha: env.ANNUAL_PRIVATE_ADMISSION_SOURCE_SHA, expectedSourceArtifact: { repository: env.ANNUAL_PRIVATE_ADMISSION_REPOSITORY, runId: positiveEnv(env.ANNUAL_PRIVATE_ADMISSION_RUN_ID), runAttempt: positiveEnv(env.ANNUAL_PRIVATE_ADMISSION_RUN_ATTEMPT), artifactId: positiveEnv(env.ANNUAL_PRIVATE_ADMISSION_ARTIFACT_ID), name: env.ANNUAL_PRIVATE_ADMISSION_ARTIFACT_NAME }, expectedPublicRepository: env.GITHUB_REPOSITORY, hmacKey: env.ANNUAL_PRIVATE_ADMISSION_HMAC_KEY, publicReviewHmacKey: env.ANNUAL_PUBLIC_REVIEW_HMAC_KEY })
    process.stdout.write(`Pre-public admission verified for private ${result.privateSha} and exact public ${result.expectedPublicSha}\n`)
  } catch (error) { process.stderr.write(`Pre-public admission rejected: ${error instanceof Error ? error.message : 'unknown error'}\n`); process.exitCode = 1 }
}
