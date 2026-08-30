import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const source = (file) => readFileSync(resolve(file), 'utf8')
test('the shared Stage A consumer fetches only the exact private artifact and validates immutable metadata, archive digest, HMAC, and closed schema', () => {
  const consumer = source('.github/actions/verify-annual-pre-public-admission/action.yml')
  for (const value of ['silent-suite/silentsuite-internal', 'annual-only-pre-public-admission-${PRIVATE_RUN_ID}-${PRIVATE_RUN_ATTEMPT}', 'repos/$PRIVATE_REPOSITORY', 'actions/runs/$PRIVATE_RUN_ID', 'actions/workflows/$PRIVATE_WORKFLOW_ID', '.repository.full_name', '.repository.private', '.repository.fork', '.workflow_id', '.event', '.path', '.workflow_run.id', '.workflow_run.head_sha', '.id', '.run_attempt', '.conclusion', '.expired', '.digest', 'sha256sum', 'verify-annual-pre-public-admission.mjs', 'ANNUAL_PRIVATE_ADMISSION_HMAC_KEY', 'ANNUAL_PUBLIC_REVIEW_HMAC_KEY']) assert.match(consumer, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(consumer, /refs\/heads\/|\/actions\/artifacts\?/)
})
test('the public review signer fetches live main and asserts every identity in the same final signing step', () => {
  const text = source('.github/workflows/annual-only-public-review.yml')
  const fetch = text.indexOf('git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main')
  const sign = text.indexOf('node scripts/sign-annual-public-review.mjs')
  assert.ok(fetch >= 0 && sign > fetch)
  assert.match(text.slice(fetch, sign), /test "\$GITHUB_REF" = refs\/heads\/main/)
  assert.match(text.slice(fetch, sign), /test "\$GITHUB_SHA" = "\$EXPECTED_SHA"/)
  assert.match(text.slice(fetch, sign), /git rev-parse HEAD/)
  assert.equal((text.slice(fetch, sign).match(/\n\s*- name:/g) ?? []).length, 0)
})

const actionRun = source('.github/actions/verify-annual-pre-public-admission/action.yml').match(/\n      run: \|\n([\s\S]+)$/)?.[1].replace(/^ {8}/gm, '')
assert.ok(actionRun, 'Stage A composite action must contain an executable shell program')
const privateSha = 'a'.repeat(40)
const publicSha = 'b'.repeat(40)
const runId = 918273645
const runAttempt = 2
const artifactId = 881
const admissionKey = 'private-admission-test-key'
const archiveDigest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const signAdmission = (value) => createHmac('sha256', admissionKey).update(archiveDigest(Buffer.from(JSON.stringify(value)))).digest('hex')

function runStageAAction(mutate = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'annual-stage-a-action-'))
  const payloadDirectory = join(root, 'payload')
  const fixturesDirectory = join(root, 'fixtures')
  mkdirSync(payloadDirectory, { recursive: true })
  mkdirSync(fixturesDirectory, { recursive: true })
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'scripts', 'verify-annual-pre-public-admission.mjs'), readFileSync(resolve('scripts/verify-annual-pre-public-admission.mjs')))

  const unsignedAdmission = {
    schemaVersion: 1,
    predicateType: 'https://silentsuite.io/attestations/annual-only-pre-public-admission/v1',
    privateSha,
    expectedPublicSha: publicSha,
    billingImageDigest: `sha256:${'c'.repeat(64)}`,
    rollbackImageDigest: `sha256:${'d'.repeat(64)}`,
    buildAttestationDigest: `sha256:${'e'.repeat(64)}`,
    qaAttestationDigest: `sha256:${'f'.repeat(64)}`,
    providerRegistryDigest: `sha256:${'1'.repeat(64)}`,
    disclosureDigest: `sha256:${'2'.repeat(64)}`,
    providerAdmission: { artifactId: 88, archiveDigest: `sha256:${'3'.repeat(64)}`, statementDigest: `sha256:${'4'.repeat(64)}`, runId, runAttempt },
    privateDeploymentRun: { runId, runAttempt },
    publicReview: { schemaVersion: 2, predicateType: 'https://silentsuite.io/attestations/annual-only-public-review/v2', repository: 'silent-suite/silentsuite', publicSha, runId: 44, runAttempt: 2, disclosureDigest: `sha256:${'2'.repeat(64)}`, signature: '0'.repeat(64) },
  }
  const reviewUnsigned = { ...unsignedAdmission.publicReview }; delete reviewUnsigned.signature
  unsignedAdmission.publicReview.signature = createHmac('sha256', admissionKey).update(archiveDigest(Buffer.from(JSON.stringify(reviewUnsigned)))).digest('hex')
  const admission = { ...unsignedAdmission, signature: signAdmission(unsignedAdmission) }
  const admissionFile = join(payloadDirectory, 'annual-only-pre-public-admission.json')
  writeFileSync(admissionFile, `${JSON.stringify(admission)}\n`)
  const archive = join(fixturesDirectory, 'admission.zip')
  writeFileSync(archive, Buffer.from('immutable annual Stage A archive bytes'))

  const fixture = {
    repository: { full_name: 'silent-suite/silentsuite-internal', private: true, fork: false },
    run: {
      id: runId,
      run_attempt: runAttempt,
      conclusion: 'success',
      head_sha: privateSha,
      event: 'workflow_dispatch',
      workflow_id: 54321,
      repository: { full_name: 'silent-suite/silentsuite-internal', private: true, fork: false },
    },
    workflow: { id: 54321, path: '.github/workflows/deploy.yml' },
    artifact: {
      id: artifactId,
      name: `annual-only-pre-public-admission-${runId}-${runAttempt}`,
      expired: false,
      digest: archiveDigest(readFileSync(archive)),
      workflow_run: { id: runId, head_sha: privateSha },
    },
    archive,
  }
  mutate(fixture)
  for (const [name, value] of Object.entries(fixture)) {
    if (name === 'archive') continue
    writeFileSync(join(fixturesDirectory, `${name}.json`), JSON.stringify(value))
  }
  const gh = join(root, 'gh')
  writeFileSync(gh, `#!/bin/sh
set -eu
endpoint=''
for arg in "$@"; do endpoint="$arg"; done
case "$endpoint" in
  repos/silent-suite/silentsuite-internal) cat "$GH_FIXTURE_REPOSITORY" ;;
  repos/silent-suite/silentsuite-internal/actions/runs/${runId}) cat "$GH_FIXTURE_RUN" ;;
  repos/silent-suite/silentsuite-internal/actions/workflows/*) cat "$GH_FIXTURE_WORKFLOW" ;;
  repos/silent-suite/silentsuite-internal/actions/artifacts/${artifactId}) cat "$GH_FIXTURE_ARTIFACT" ;;
  repos/silent-suite/silentsuite-internal/actions/artifacts/${artifactId}/zip) cat "$GH_FIXTURE_ARCHIVE" ;;
  *) printf 'unexpected gh api endpoint: %s\\n' "$endpoint" >&2; exit 64 ;;
esac
`)
  chmodSync(gh, 0o700)
  const unzip = join(root, 'unzip')
  writeFileSync(unzip, `#!/bin/sh
set -eu
destination=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-d' ]; then destination="$2"; shift 2; continue; fi
  shift
done
[ -n "$destination" ]
mkdir -p "$destination"
cp "$GH_FIXTURE_ADMISSION" "$destination/annual-only-pre-public-admission.json"
`)
  chmodSync(unzip, 0o700)
  const result = spawnSync('bash', ['-c', actionRun], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH ?? ''}`,
      GH_TOKEN: 'narrow-actions-read-token',
      PRIVATE_REPOSITORY: 'silent-suite/silentsuite-internal',
      PRIVATE_RUN_ID: String(runId),
      PRIVATE_RUN_ATTEMPT: String(runAttempt),
      PRIVATE_ARTIFACT_ID: String(artifactId),
      EXPECTED_PUBLIC_SHA: publicSha,
      ANNUAL_PRIVATE_ADMISSION_HMAC_KEY: admissionKey,
      ANNUAL_PUBLIC_REVIEW_HMAC_KEY: admissionKey,
      GITHUB_REPOSITORY: 'silent-suite/silentsuite',
      GITHUB_ENV: join(root, 'github-env'),
      GH_FIXTURE_REPOSITORY: join(fixturesDirectory, 'repository.json'),
      GH_FIXTURE_RUN: join(fixturesDirectory, 'run.json'),
      GH_FIXTURE_WORKFLOW: join(fixturesDirectory, 'workflow.json'),
      GH_FIXTURE_ARTIFACT: join(fixturesDirectory, 'artifact.json'),
      GH_FIXTURE_ARCHIVE: fixture.archive,
      GH_FIXTURE_ADMISSION: admissionFile,
    },
  })
  rmSync(root, { recursive: true, force: true })
  return result
}

test('Stage A action rejects each GitHub API provenance and archive substitution before its HMAC verifier can admit deployment', () => {
  assert.equal(runStageAAction().status, 0)
  const substitutes = [
    ['repository full name', (fixture) => { fixture.repository.full_name = 'silent-suite/other' }],
    ['repository privacy', (fixture) => { fixture.repository.private = false }],
    ['repository fork', (fixture) => { fixture.run.repository.fork = true }],
    ['run identity', (fixture) => { fixture.run.id = 99 }],
    ['run attempt', (fixture) => { fixture.run.run_attempt = 99 }],
    ['run conclusion', (fixture) => { fixture.run.conclusion = 'failure' }],
    ['run event', (fixture) => { fixture.run.event = 'push' }],
    ['producer workflow path', (fixture) => { fixture.workflow.path = '.github/workflows/other.yml' }],
    ['run head SHA', (fixture) => { fixture.run.head_sha = 'f'.repeat(40) }],
    ['artifact ID', (fixture) => { fixture.artifact.id = 999 }],
    ['artifact name', (fixture) => { fixture.artifact.name = 'annual-only-pre-public-admission-99-1' }],
    ['artifact workflow run ID', (fixture) => { fixture.artifact.workflow_run.id = 99 }],
    ['artifact head SHA', (fixture) => { fixture.artifact.workflow_run.head_sha = 'f'.repeat(40) }],
    ['artifact API digest', (fixture) => { fixture.artifact.digest = `sha256:${'f'.repeat(64)}` }],
    ['archive bytes', (fixture) => { writeFileSync(fixture.archive, Buffer.concat([readFileSync(fixture.archive), Buffer.from('substitution')])) }],
  ]
  for (const [name, mutate] of substitutes) {
    const result = runStageAAction(mutate)
    assert.notEqual(result.status, 0, `Stage A accepted a ${name} substitution: ${result.stdout}${result.stderr}`)
  }
})
test('Web and Docs gate production deploy before build and immediately before mutation with protected narrow App access', () => {
  for (const workflow of ['.github/workflows/deploy-web.yml', '.github/workflows/deploy-docs.yml']) {
    const text = source(workflow); assert.match(text, /workflow_call:/); assert.doesNotMatch(text, /verify-billing-v2-admission|BILLING_V2_CUTOVER_MANIFEST/); assert.match(text, /actions\/create-github-app-token@0f859bf9e69e887678d5bbfbee594437cb440ffe/); assert.match(text, /repositories: silentsuite-internal/); assert.match(text, /permission-actions: read/); assert.match(text, /verify-annual-pre-public-admission/); assert.match(text, /private_admission_run_id/); assert.match(text, /private_admission_run_attempt/); assert.match(text, /private_admission_artifact_id/); assert.match(text, /secrets:\n(?:[\s\S]*?)ANNUAL_PRIVATE_ADMISSION_APP_ID:/)
  }
})
test('only protected exact-SHA annual cutover can mint Stage B after freshly probing both live served identities', () => {
  const text = source('.github/workflows/annual-only-public-cutover.yml'); const probes = source('scripts/verify-annual-public-served-identities.mjs'); assert.match(text, /workflow_dispatch:/); assert.match(text, /github\.ref == 'refs\/heads\/main'/); assert.match(text, /github\.sha == inputs\.expected_sha/); assert.match(text, /environment: annual-public-cutover/); assert.match(text, /needs: \[deploy-web, deploy-docs\]/); assert.match(text, /ANNUAL_PUBLIC_SERVED_HMAC_KEY/); assert.match(text, /permission-actions: read/); assert.match(text, /Freshly verify exact production Web and Docs served identities before Stage B/); assert.match(text, /verify-annual-public-served-identities\.mjs/); assert.match(probes, /https:\/\/app\.silentsuite\.io\/api\/deployment-identity/); assert.match(probes, /https:\/\/docs\.silentsuite\.io\/deployment-identity\.json/); assert.match(text, /ANNUAL_PUBLIC_SERVED_CLIENT_SERVED_AT/); assert.match(text, /ANNUAL_DEPLOYMENT_VERIFIED: 'true'/); assert.match(text, /annual-only-public-served-attestation-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/); assert.match(text, /publish-annual-public-served-attestation\.mjs/); assert.doesNotMatch(text, /annual-only-final-cutover-manifest\.json/)
  assert.ok(text.indexOf('Freshly verify exact production Web and Docs served identities before Stage B') < text.indexOf('Reserve, sign, and finalize immutable truthful served attestation'))
  assert.match(source('.github/workflows/deploy-web.yml'), /api\/deployment-identity/); assert.match(source('.github/workflows/deploy-docs.yml'), /deployment-identity\.json/)
})
test('reusable cutover callers map only declared secrets and every App token can read Actions only', () => {
  const cutover = source('.github/workflows/annual-only-public-cutover.yml')
  assert.doesNotMatch(cutover, /secrets:\s*inherit/)
  for (const secret of ['ANNUAL_PRIVATE_ADMISSION_APP_ID', 'ANNUAL_PRIVATE_ADMISSION_APP_PRIVATE_KEY', 'ANNUAL_PRIVATE_ADMISSION_HMAC_KEY', 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'VPS_HOST', 'VPS_USER', 'VPS_SSH_KEY', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) assert.match(cutover, new RegExp(`${secret}: \\$\\{\\{ secrets\\.${secret} \\}\\}`))
  for (const workflow of ['.github/workflows/deploy-web.yml', '.github/workflows/deploy-docs.yml', '.github/workflows/annual-only-public-cutover.yml']) {
    const text = source(workflow)
    const appTokenBlocks = text.match(/uses: actions\/create-github-app-token@[\s\S]*?(?=\n\s*- name:|\n\s*$)/g) ?? []
    assert.ok(appTokenBlocks.length > 0, `${workflow} must mint a narrow App token`)
    for (const block of appTokenBlocks) {
      assert.match(block, /owner: silent-suite/)
      assert.match(block, /repositories: silentsuite-internal/)
      assert.match(block, /permission-actions: read/)
      assert.doesNotMatch(block, /\n\s+permission-(?!actions: read)[a-z-]+:/)
    }
  }
})
test('preview and CI never contain a public-served key or artifact path', () => { for (const workflow of ['.github/workflows/preview-web.yml', '.github/workflows/preview-docs.yml', '.github/workflows/ci.yml']) assert.doesNotMatch(source(workflow), /ANNUAL_PUBLIC_SERVED_HMAC_KEY|annual-only-public-served-attestation/) })
