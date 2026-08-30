import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { verifyPrePublicAdmission } from './verify-annual-pre-public-admission.mjs'

const admissionKey = 'private-admission-test-key'; const privateSha = 'a'.repeat(40); const publicSha = 'b'.repeat(40)
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`
const sign = (value) => createHmac('sha256', admissionKey).update(digest(JSON.stringify(value))).digest('hex')
const sourceArtifact = { repository: 'silent-suite/silentsuite-internal', runId: 918273645, runAttempt: 2, artifactId: 881, name: 'annual-only-pre-public-admission-918273645-2' }
const reviewUnsigned = { schemaVersion: 2, predicateType: 'https://silentsuite.io/attestations/annual-only-public-review/v2', repository: 'silent-suite/silentsuite', publicSha, runId: 44, runAttempt: 2, disclosureDigest: `sha256:${'2'.repeat(64)}` }
const unsigned = () => ({ schemaVersion: 1, predicateType: 'https://silentsuite.io/attestations/annual-only-pre-public-admission/v1', privateSha, expectedPublicSha: publicSha, billingImageDigest: `sha256:${'c'.repeat(64)}`, rollbackImageDigest: `sha256:${'d'.repeat(64)}`, buildAttestationDigest: `sha256:${'e'.repeat(64)}`, qaAttestationDigest: `sha256:${'f'.repeat(64)}`, providerRegistryDigest: `sha256:${'1'.repeat(64)}`, providerAdmission: { artifactId: 88, archiveDigest: `sha256:${'3'.repeat(64)}`, statementDigest: `sha256:${'4'.repeat(64)}`, runId: sourceArtifact.runId, runAttempt: sourceArtifact.runAttempt }, disclosureDigest: `sha256:${'2'.repeat(64)}`, privateDeploymentRun: { runId: sourceArtifact.runId, runAttempt: sourceArtifact.runAttempt }, publicReview: { ...reviewUnsigned, signature: sign(reviewUnsigned) } })
function fixture(mutate = (value) => value) { const value = mutate(unsigned()); const bytes = Buffer.from(`${JSON.stringify({ ...value, signature: sign(value) })}\n`); return { bytes, digest: digest(bytes) } }
function verify(overrides = {}) { const value = fixture(); return verifyPrePublicAdmission({ admissionBytes: value.bytes, expectedAdmissionDigest: value.digest, expectedPublicSha: publicSha, expectedSourcePrivateSha: privateSha, expectedSourceArtifact: sourceArtifact, expectedPublicRepository: 'silent-suite/silentsuite', hmacKey: admissionKey, publicReviewHmacKey: admissionKey, ...overrides }) }

test('accepts only the closed canonical Stage A admission for the exact public SHA and immutable private source run', () => {
  assert.deepEqual(verify(), { privateSha, expectedPublicSha: publicSha, billingImageDigest: `sha256:${'c'.repeat(64)}`, disclosureDigest: `sha256:${'2'.repeat(64)}`, privateDeploymentRun: { runId: sourceArtifact.runId, runAttempt: sourceArtifact.runAttempt }, privateAdmissionDigest: fixture().digest })
})
test('rejects the legacy publicReview artifact identity shape even when Stage A signs it', () => {
  const value = fixture((admission) => { admission.publicReview = { repository: 'silent-suite/silentsuite', runId: 44, runAttempt: 2, artifactId: 77 }; return admission })
  assert.throws(() => verify({ admissionBytes: value.bytes, expectedAdmissionDigest: value.digest }), /signed v2 public review/i)
})
test('fails closed for extra/missing fields, signature/digest/SHA/repository/run/attempt/artifact mismatch, and forbidden served claims', () => {
  assert.throws(() => verify({ expectedAdmissionDigest: `sha256:${'0'.repeat(64)}` }), /digest/i)
  assert.throws(() => verify({ expectedPublicSha: 'f'.repeat(40) }), /exact public SHA/i)
  assert.throws(() => verify({ expectedSourcePrivateSha: 'f'.repeat(40) }), /private SHA/i)
  assert.throws(() => verify({ expectedSourceArtifact: { ...sourceArtifact, runId: 9, name: 'annual-only-pre-public-admission-9-2' } }), /private deployment run/i)
  assert.throws(() => verify({ expectedSourceArtifact: { ...sourceArtifact, runAttempt: 9, name: 'annual-only-pre-public-admission-918273645-9' } }), /private deployment run/i)
  assert.throws(() => verify({ expectedSourceArtifact: { ...sourceArtifact, artifactId: 0 } }), /source artifact/i)
  assert.throws(() => verify({ expectedSourceArtifact: { ...sourceArtifact, name: 'main' } }), /source artifact/i)
  const wrongSignature = JSON.parse(fixture().bytes); wrongSignature.signature = '0'.repeat(64); const wrongSignatureBytes = Buffer.from(`${JSON.stringify(wrongSignature)}\n`)
  assert.throws(() => verify({ admissionBytes: wrongSignatureBytes, expectedAdmissionDigest: digest(wrongSignatureBytes) }), /signature/i)
  for (const [mutate, expected] of [[(value) => ({ ...value, publicReview: { ...value.publicReview, repository: 'silent-suite/other' } }), /review repository/i], [(value) => ({ ...value, clientServedAt: '2026-01-01T00:00:00Z' }), /closed schema/i], [(value) => ({ ...value, verifiedAt: '2026-01-01T00:00:00Z' }), /closed schema/i], [(value) => ({ ...value, extra: true }), /closed schema/i]]) { const value = fixture(mutate); assert.throws(() => verify({ admissionBytes: value.bytes, expectedAdmissionDigest: value.digest }), expected) }
  for (const key of Object.keys(unsigned())) { const value = unsigned(); delete value[key]; const bytes = Buffer.from(`${JSON.stringify({ ...value, signature: sign(value) })}\n`); assert.throws(() => verify({ admissionBytes: bytes, expectedAdmissionDigest: digest(bytes) }), /closed schema/i, `missing ${key}`) }
})
test('rejects validly signed body-provenance substitutions from the exact GitHub source artifact', () => {
  for (const [mutate, expected] of [
    [(value) => ({ ...value, privateSha: 'f'.repeat(40) }), /private SHA/i],
    [(value) => ({ ...value, expectedPublicSha: 'f'.repeat(40) }), /exact public SHA/i],
    [(value) => ({ ...value, privateDeploymentRun: { runId: 19, runAttempt: sourceArtifact.runAttempt } }), /private deployment run/i],
    [(value) => ({ ...value, privateDeploymentRun: { runId: sourceArtifact.runId, runAttempt: 19 } }), /private deployment run/i],
  ]) {
    const value = fixture(mutate)
    assert.throws(() => verify({ admissionBytes: value.bytes, expectedAdmissionDigest: value.digest }), expected)
  }
})
test('pins byte-identical canonical Stage A and Stage B schemas', () => {
  assert.equal(createHash('sha256').update(readFileSync(resolve('contracts/annual-only-pre-public-admission.schema.json'))).digest('hex'), '0d1a15d21d6f6a3f76632c37471efdc3ae0d1974ae2011abe93ddc6fdfde64d1')
  assert.equal(createHash('sha256').update(readFileSync(resolve('contracts/annual-only-public-served-attestation.schema.json'))).digest('hex'), 'b466e16aef5be2e5ff3390e3ba316f5c2cba8f84e6a8291352237e8d216bbcca')
})
