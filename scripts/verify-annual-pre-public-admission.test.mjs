import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { verifyPrePublicAdmission } from './verify-annual-pre-public-admission.mjs'

const admissionKey = 'private-admission-test-key'
// Producer identity (the private run head) and deployed identity are deliberately
// different values: a Stage A re-attestation from a later private main is the case.
const privateSha = 'a'.repeat(40); const deployedSha = '5'.repeat(40); const publicSha = 'b'.repeat(40)
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`
const sign = (value) => createHmac('sha256', admissionKey).update(digest(JSON.stringify(value))).digest('hex')
const sourceArtifact = { repository: 'silent-suite/silentsuite-internal', runId: 918273645, runAttempt: 2, artifactId: 881, name: 'annual-only-pre-public-admission-918273645-2' }
const deploymentRun = { runId: 33368609150, runAttempt: 1 }
const reviewUnsigned = { schemaVersion: 2, predicateType: 'https://silentsuite.io/attestations/annual-only-public-review/v2', repository: 'silent-suite/silentsuite', publicSha, runId: 44, runAttempt: 2, disclosureDigest: `sha256:${'2'.repeat(64)}` }
const deployedRuntime = () => ({ privateSha: deployedSha, imageDigest: `sha256:${'c'.repeat(64)}`, phase: 'additive', deployedAt: '2026-08-30T10:00:00Z', observedAt: '2026-08-31T09:00:00Z', reobservedAt: '2026-08-31T09:00:05Z' })
const unsigned = () => ({ schemaVersion: 2, predicateType: 'https://silentsuite.io/attestations/annual-only-pre-public-admission/v2', privateSha, expectedPublicSha: publicSha, billingImageDigest: `sha256:${'c'.repeat(64)}`, rollbackImageDigest: `sha256:${'d'.repeat(64)}`, buildAttestationDigest: `sha256:${'e'.repeat(64)}`, qaAttestationDigest: `sha256:${'f'.repeat(64)}`, providerRegistryDigest: `sha256:${'1'.repeat(64)}`, providerAdmission: { artifactId: 88, archiveDigest: `sha256:${'3'.repeat(64)}`, statementDigest: `sha256:${'4'.repeat(64)}`, ...deploymentRun }, disclosureDigest: `sha256:${'2'.repeat(64)}`, producerRun: { runId: sourceArtifact.runId, runAttempt: sourceArtifact.runAttempt }, deployedRuntime: deployedRuntime(), publicReview: { ...reviewUnsigned, signature: sign(reviewUnsigned) } })
const legacyV1 = () => { const value = unsigned(); delete value.producerRun; delete value.deployedRuntime; return { ...value, schemaVersion: 1, predicateType: 'https://silentsuite.io/attestations/annual-only-pre-public-admission/v1', privateDeploymentRun: { runId: sourceArtifact.runId, runAttempt: sourceArtifact.runAttempt } } }
function fixture(mutate = (value) => value) { const value = mutate(unsigned()); const bytes = Buffer.from(`${JSON.stringify({ ...value, signature: sign(value) })}\n`); return { bytes, digest: digest(bytes) } }
function verify(overrides = {}) { const value = fixture(); return verifyPrePublicAdmission({ admissionBytes: value.bytes, expectedAdmissionDigest: value.digest, expectedPublicSha: publicSha, expectedSourcePrivateSha: privateSha, expectedSourceArtifact: sourceArtifact, expectedPublicRepository: 'silent-suite/silentsuite', hmacKey: admissionKey, publicReviewHmacKey: admissionKey, ...overrides }) }
const verifyMutated = (mutate, overrides = {}) => { const value = fixture(mutate); return verify({ admissionBytes: value.bytes, expectedAdmissionDigest: value.digest, ...overrides }) }

test('accepts only the closed canonical v2 Stage A whose producer is the immutable source run and whose deployed identity is separately bound', () => {
  assert.deepEqual(verify(), { privateSha, expectedPublicSha: publicSha, billingImageDigest: `sha256:${'c'.repeat(64)}`, disclosureDigest: `sha256:${'2'.repeat(64)}`, producerRun: { runId: sourceArtifact.runId, runAttempt: sourceArtifact.runAttempt }, deployedRuntime: deployedRuntime(), privateAdmissionDigest: fixture().digest })
  // The provider admission belongs to the deployment run, which is not the producer run
  // of a re-attestation; that is the truthful shape, not a substitution.
  assert.notDeepEqual(verify().producerRun, deploymentRun)
})
test('rejects the retired v1 wire explicitly and never reinterprets privateDeploymentRun as a producer or deployed identity', () => {
  const value = legacyV1(); const bytes = Buffer.from(`${JSON.stringify({ ...value, signature: sign(value) })}\n`)
  assert.throws(() => verify({ admissionBytes: bytes, expectedAdmissionDigest: digest(bytes) }), /v1 is retired/i)
  assert.throws(() => verifyMutated((admission) => ({ ...admission, privateDeploymentRun: { runId: sourceArtifact.runId, runAttempt: sourceArtifact.runAttempt } })), /closed schema/i)
})
test('binds the deployed runtime to a twice-observed additive identity of the admitted image', () => {
  assert.throws(() => verifyMutated((admission) => ({ ...admission, deployedRuntime: { ...admission.deployedRuntime, imageDigest: `sha256:${'9'.repeat(64)}` } })), /admitted image/i)
  assert.throws(() => verifyMutated((admission) => ({ ...admission, deployedRuntime: { ...admission.deployedRuntime, phase: 'baseline' } })), /additive/i)
  assert.throws(() => verifyMutated((admission) => ({ ...admission, deployedRuntime: { ...admission.deployedRuntime, phase: 'enforcement' } })), /additive/i)
  assert.throws(() => verifyMutated((admission) => ({ ...admission, deployedRuntime: { ...admission.deployedRuntime, reobservedAt: '2026-08-31T08:59:59Z' } })), /observation order/i)
  assert.throws(() => verifyMutated((admission) => ({ ...admission, deployedRuntime: { ...admission.deployedRuntime, deployedAt: '2026-08-31T09:00:01Z' } })), /observation order/i)
  assert.throws(() => verifyMutated((admission) => ({ ...admission, deployedRuntime: { ...admission.deployedRuntime, privateSha: 'main' } })), /deployed runtime/i)
  assert.throws(() => verifyMutated((admission) => ({ ...admission, deployedRuntime: { ...admission.deployedRuntime, unexpected: true } })), /deployed runtime/i)
  const missing = unsigned(); delete missing.deployedRuntime.reobservedAt
  const bytes = Buffer.from(`${JSON.stringify({ ...missing, signature: sign(missing) })}\n`)
  assert.throws(() => verify({ admissionBytes: bytes, expectedAdmissionDigest: digest(bytes) }), /deployed runtime/i)
})
test('fails closed for extra/missing fields, signature/digest/SHA/repository/run/attempt/artifact mismatch, and forbidden served claims', () => {
  assert.throws(() => verify({ expectedAdmissionDigest: `sha256:${'0'.repeat(64)}` }), /digest/i)
  assert.throws(() => verify({ expectedPublicSha: 'f'.repeat(40) }), /exact public SHA/i)
  assert.throws(() => verify({ expectedSourcePrivateSha: 'f'.repeat(40) }), /private SHA/i)
  assert.throws(() => verify({ expectedSourcePrivateSha: deployedSha }), /private SHA/i)
  assert.throws(() => verify({ expectedSourceArtifact: { ...sourceArtifact, runId: 9, name: 'annual-only-pre-public-admission-9-2' } }), /producer run/i)
  assert.throws(() => verify({ expectedSourceArtifact: { ...sourceArtifact, runAttempt: 9, name: 'annual-only-pre-public-admission-918273645-9' } }), /producer run/i)
  assert.throws(() => verify({ expectedSourceArtifact: { ...sourceArtifact, artifactId: 0 } }), /source artifact/i)
  assert.throws(() => verify({ expectedSourceArtifact: { ...sourceArtifact, name: 'main' } }), /source artifact/i)
  const wrongSignature = JSON.parse(fixture().bytes); wrongSignature.signature = '0'.repeat(64); const wrongSignatureBytes = Buffer.from(`${JSON.stringify(wrongSignature)}\n`)
  assert.throws(() => verify({ admissionBytes: wrongSignatureBytes, expectedAdmissionDigest: digest(wrongSignatureBytes) }), /signature/i)
  for (const [mutate, expected] of [[(value) => ({ ...value, publicReview: { ...value.publicReview, repository: 'silent-suite/other' } }), /review repository/i], [(value) => ({ ...value, clientServedAt: '2026-01-01T00:00:00Z' }), /closed schema/i], [(value) => ({ ...value, verifiedAt: '2026-01-01T00:00:00Z' }), /closed schema/i], [(value) => ({ ...value, extra: true }), /closed schema/i]]) assert.throws(() => verifyMutated(mutate), expected)
  for (const key of Object.keys(unsigned())) { const value = unsigned(); delete value[key]; const bytes = Buffer.from(`${JSON.stringify({ ...value, signature: sign(value) })}\n`); assert.throws(() => verify({ admissionBytes: bytes, expectedAdmissionDigest: digest(bytes) }), /closed schema|retired/i, `missing ${key}`) }
})
test('rejects validly signed body-provenance substitutions from the exact GitHub source artifact', () => {
  for (const [mutate, expected] of [
    [(value) => ({ ...value, privateSha: 'f'.repeat(40) }), /private SHA/i],
    [(value) => ({ ...value, privateSha: deployedSha }), /private SHA/i],
    [(value) => ({ ...value, expectedPublicSha: 'f'.repeat(40) }), /exact public SHA/i],
    [(value) => ({ ...value, producerRun: { runId: 19, runAttempt: sourceArtifact.runAttempt } }), /producer run/i],
    [(value) => ({ ...value, producerRun: { runId: sourceArtifact.runId, runAttempt: 19 } }), /producer run/i],
    [(value) => ({ ...value, providerAdmission: { ...value.providerAdmission, runId: 0 } }), /provider admission/i],
  ]) assert.throws(() => verifyMutated(mutate), expected)
})
test('pins byte-identical canonical Stage A and Stage B schemas', () => {
  assert.equal(createHash('sha256').update(readFileSync(resolve('contracts/annual-only-pre-public-admission.schema.json'))).digest('hex'), '1d104603298e53f4dd6eb10bdcffbf72cf139bfb49b53106eb547369f77175d1')
  assert.equal(createHash('sha256').update(readFileSync(resolve('contracts/annual-only-public-served-attestation.schema.json'))).digest('hex'), '9990a6fce91f0468dadde0b89b95dbff523f2eaaebb20376dbc1ba5c98c3ef43')
})
