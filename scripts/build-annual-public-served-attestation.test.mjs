import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { buildPublicServedAttestation, publicServedArtifactName, publicServedEntryName } from './build-annual-public-served-attestation.mjs'

const privateKey = 'private-admission-test-key'; const publicKey = 'public-served-test-key'; const privateSha = 'a'.repeat(40); const deployedSha = '5'.repeat(40); const publicSha = 'b'.repeat(40)
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`; const sign = (key, value) => createHmac('sha256', key).update(digest(JSON.stringify(value))).digest('hex')
const sourceArtifact = { repository: 'silent-suite/silentsuite-internal', runId: 918273645, runAttempt: 2, artifactId: 881, name: 'annual-only-pre-public-admission-918273645-2' }; const run = { runId: 123456789, runAttempt: 3 }; const artifact = { repository: 'silent-suite/silentsuite', runId: run.runId, runAttempt: run.runAttempt }
const deployedRuntime = { privateSha: deployedSha, imageDigest: `sha256:${'c'.repeat(64)}`, phase: 'additive', deployedAt: '2026-08-30T10:00:00Z', observedAt: '2026-08-31T09:00:00Z', reobservedAt: '2026-08-31T09:00:05Z' }
const schema = JSON.parse(readFileSync(resolve('contracts/annual-only-public-served-attestation.schema.json'), 'utf8'))
function admissionBytes(mutate = (value) => value) { const reviewUnsigned = { schemaVersion: 2, predicateType: 'https://silentsuite.io/attestations/annual-only-public-review/v2', repository: 'silent-suite/silentsuite', publicSha, runId: 44, runAttempt: 2, disclosureDigest: `sha256:${'2'.repeat(64)}` }; const review = { ...reviewUnsigned, signature: sign(privateKey, reviewUnsigned) }; const unsigned = mutate({ schemaVersion: 2, predicateType: 'https://silentsuite.io/attestations/annual-only-pre-public-admission/v2', privateSha, expectedPublicSha: publicSha, billingImageDigest: `sha256:${'c'.repeat(64)}`, rollbackImageDigest: `sha256:${'d'.repeat(64)}`, buildAttestationDigest: `sha256:${'e'.repeat(64)}`, qaAttestationDigest: `sha256:${'f'.repeat(64)}`, providerRegistryDigest: `sha256:${'1'.repeat(64)}`, providerAdmission: { artifactId: 88, archiveDigest: `sha256:${'3'.repeat(64)}`, statementDigest: `sha256:${'4'.repeat(64)}`, runId: 33368609150, runAttempt: 1 }, disclosureDigest: `sha256:${'2'.repeat(64)}`, producerRun: { runId: sourceArtifact.runId, runAttempt: sourceArtifact.runAttempt }, deployedRuntime, publicReview: review }); return Buffer.from(`${JSON.stringify({ ...unsigned, signature: sign(privateKey, unsigned) })}\n`) }
function build(overrides = {}) { return buildPublicServedAttestation({ admissionBytes: admissionBytes(), expectedPublicSha: publicSha, expectedSourcePrivateSha: privateSha, expectedSourceArtifact: sourceArtifact, expectedPublicRepository: 'silent-suite/silentsuite', privateAdmissionHmacKey: privateKey, publicReviewHmacKey: privateKey, publicServedHmacKey: publicKey, publicDeploymentRun: run, publicArtifact: artifact, publicArtifactName: 'annual-only-public-served-attestation-123456789-3', deploymentVerified: true, clientServedAt: '2026-08-11T12:00:05Z', now: () => '2026-08-11T12:00:06Z', ...overrides }) }
test('mints a closed canonical v3 Stage B carrying the producer run and the separately bound deployed runtime, with no self artifact ID, only after fresh service checks', () => {
  const { attestation, bytes } = build()
  assert.deepEqual(Object.keys(attestation), schema.required)
  assert.deepEqual(Object.keys(attestation), ['schemaVersion', 'predicateType', 'privateSha', 'publicSha', 'privateAdmissionDigest', 'billingImageDigest', 'disclosureDigest', 'deployedRuntime', 'producerRun', 'publicDeploymentRun', 'publicArtifact', 'clientServedAt', 'verifiedAt', 'signature'])
  assert.equal(attestation.schemaVersion, 3); assert.equal(attestation.predicateType, 'https://silentsuite.io/attestations/annual-only-public-served/v3')
  assert.equal(attestation.schemaVersion, schema.properties.schemaVersion.const); assert.equal(attestation.predicateType, schema.properties.predicateType.const)
  assert.deepEqual(attestation.publicArtifact, { repository: 'silent-suite/silentsuite', runId: 123456789, runAttempt: 3 }); assert.deepEqual(Object.keys(attestation.publicArtifact), schema.$defs.artifact.required)
  assert.equal(JSON.stringify(attestation).includes('artifactId'), false)
  assert.equal(attestation.privateSha, privateSha); assert.deepEqual(attestation.deployedRuntime, deployedRuntime); assert.deepEqual(attestation.producerRun, { runId: sourceArtifact.runId, runAttempt: sourceArtifact.runAttempt })
  assert.equal(attestation.privateAdmissionDigest, digest(admissionBytes())); assert.equal(attestation.clientServedAt, '2026-08-11T12:00:05Z'); assert.equal(attestation.verifiedAt, '2026-08-11T12:00:06Z'); assert.equal(bytes.toString(), `${JSON.stringify(attestation)}\n`)
  const { signature, ...unsigned } = attestation; assert.equal(signature, sign(publicKey, unsigned))
  assert.equal('privateDeploymentRun' in attestation, false)
  assert.equal(publicServedArtifactName(run), 'annual-only-public-served-attestation-123456789-3'); assert.throws(() => publicServedArtifactName({ runId: 0, runAttempt: 1 }), /run/i)
})
test('rejects a retired v1 admission, before-deploy, wrong SHA/artifact/name, a self storage artifact ID, mutable run identity, and timestamp-order fabrication', () => {
  assert.throws(() => build({ admissionBytes: admissionBytes((value) => { const legacy = { ...value, schemaVersion: 1, predicateType: 'https://silentsuite.io/attestations/annual-only-pre-public-admission/v1', privateDeploymentRun: value.producerRun }; delete legacy.producerRun; delete legacy.deployedRuntime; return legacy }) }), /v1 is retired/i)
  assert.throws(() => build({ deploymentVerified: false }), /after verified Web and Docs deployment/i); assert.throws(() => build({ clientServedAt: undefined }), /client timestamp/i); assert.throws(() => build({ clientServedAt: '2026-08-11T12:00:07Z' }), /timestamp order/i); assert.throws(() => build({ expectedPublicSha: 'f'.repeat(40) }), /exact public SHA/i); assert.throws(() => build({ expectedSourcePrivateSha: deployedSha }), /private SHA/i); assert.throws(() => build({ publicArtifact: { ...artifact, repository: 'silent-suite/attacker' } }), /public artifact/i); assert.throws(() => build({ publicArtifact: { ...artifact, runAttempt: 4 } }), /public artifact/i); assert.throws(() => build({ publicArtifact: { ...artifact, runId: 5 } }), /public artifact/i); assert.throws(() => build({ publicArtifactName: 'annual-only-public-served-attestation-main' }), /artifact name/i); assert.throws(() => build({ publicDeploymentRun: { runId: 0, runAttempt: 3 } }), /deployment run/i)
  // The v2 self-referencing storage ID is retired: signing must not depend on a reservation.
  assert.throws(() => build({ publicArtifact: { ...artifact, artifactId: 774 } }), /must not name its own storage artifact ID/i)
  assert.throws(() => build({ publicArtifact: { repository: artifact.repository, runId: artifact.runId } }), /public artifact/i)
})
test('the CLI boundary signs exactly the file the official upload step consumes, from the workflow environment alone, without any artifact ID or Actions runtime variable', () => {
  const root = mkdtempSync(join(tmpdir(), 'annual-stage-b-build-'))
  try {
    const admissionPath = join(root, 'annual-only-pre-public-admission.json'); writeFileSync(admissionPath, admissionBytes())
    const env = { PATH: process.env.PATH ?? '', GITHUB_REPOSITORY: 'silent-suite/silentsuite', GITHUB_RUN_ID: String(run.runId), GITHUB_RUN_ATTEMPT: String(run.runAttempt), ANNUAL_DEPLOYMENT_VERIFIED: 'true', ANNUAL_PRE_PUBLIC_ADMISSION: admissionPath, ANNUAL_PRIVATE_ADMISSION_REPOSITORY: sourceArtifact.repository, ANNUAL_PRIVATE_ADMISSION_RUN_ID: String(sourceArtifact.runId), ANNUAL_PRIVATE_ADMISSION_RUN_ATTEMPT: String(sourceArtifact.runAttempt), ANNUAL_PRIVATE_ADMISSION_ARTIFACT_ID: String(sourceArtifact.artifactId), ANNUAL_PRIVATE_ADMISSION_ARTIFACT_NAME: sourceArtifact.name, ANNUAL_PRIVATE_ADMISSION_SOURCE_SHA: privateSha, ANNUAL_PRIVATE_ADMISSION_HMAC_KEY: privateKey, ANNUAL_PUBLIC_REVIEW_HMAC_KEY: privateKey, ANNUAL_PUBLIC_SERVED_HMAC_KEY: publicKey, ANNUAL_PUBLIC_SERVED_OUTPUT_DIRECTORY: join(root, 'public-served'), ANNUAL_PUBLIC_SERVED_ARTIFACT_NAME: 'annual-only-public-served-attestation-123456789-3', ANNUAL_PUBLIC_SERVED_CLIENT_SERVED_AT: '2026-08-11T12:00:05Z', EXPECTED_PUBLIC_SHA: publicSha }
    const result = spawnSync(process.execPath, [resolve('scripts/build-annual-public-served-attestation.mjs')], { cwd: root, env, encoding: 'utf8' })
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
    const written = JSON.parse(readFileSync(join(root, 'public-served', publicServedEntryName), 'utf8'))
    assert.equal(written.schemaVersion, 3); assert.deepEqual(written.publicArtifact, artifact); assert.deepEqual(written.publicDeploymentRun, run); assert.equal(JSON.stringify(written).includes('artifactId'), false)
    assert.match(result.stdout, /Public served attestation signed at .*annual-only-public-served-attestation\.json \(sha256:[0-9a-f]{64}\)/); assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(publicKey))
    for (const [name, patch, expected] of [['unverified deployment', { ANNUAL_DEPLOYMENT_VERIFIED: 'false' }, /after verified Web and Docs deployment/], ['foreign repository', { GITHUB_REPOSITORY: 'silent-suite/attacker' }, /repository is invalid/], ['non-canonical artifact name', { ANNUAL_PUBLIC_SERVED_ARTIFACT_NAME: 'annual-only-public-served-attestation-main' }, /artifact name/], ['other run attempt', { GITHUB_RUN_ATTEMPT: '4' }, /artifact name/]]) {
      const rejected = spawnSync(process.execPath, [resolve('scripts/build-annual-public-served-attestation.mjs')], { cwd: root, env: { ...env, ...patch }, encoding: 'utf8' })
      assert.equal(rejected.status, 1, `${name} was accepted`); assert.match(rejected.stderr, expected)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
