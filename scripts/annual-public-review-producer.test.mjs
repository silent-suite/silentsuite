import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('the protected public review producer is a dispatch-only exact-main closed v2 producer', () => {
  const workflow = readFileSync('.github/workflows/annual-only-public-review.yml', 'utf8')
  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /expected_sha:/)
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/)
  assert.match(workflow, /github\.sha == inputs\.expected_sha/)
  assert.match(workflow, /environment: annual-public-review/)
  assert.match(workflow, /ANNUAL_PUBLIC_REVIEW_HMAC_KEY/)
  assert.match(workflow, /persist-credentials: false/)
  assert.match(workflow, /git fetch --no-tags origin \+refs\/heads\/main/)
  assert.doesNotMatch(workflow, /deploy|cloudflare|ssh-action|create-github-app-token/i)
  assert.match(workflow, /annual-only-public-review-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/)
})

test('the signed v2 review does not contain an artifact id and emits exactly two files', () => {
  const producer = readFileSync('scripts/sign-annual-public-review.mjs', 'utf8')
  assert.match(producer, /schemaVersion: 2/)
  assert.match(producer, /annual-only-public-review\/v2/)
  assert.match(producer, /disclosureDigest/)
  assert.doesNotMatch(producer, /artifactId|process\.argv|console\.log\([^)]*KEY/i)
  assert.match(producer, /annual-only-public-review\.json/)
  assert.match(producer, /annual-only-public-disclosure\.json/)
})

test('the executable signer emits the exact prefixed-digest wire format', () => {
  const output = mkdtempSync(path.join(tmpdir(), 'annual-public-review-signer-'))
  try {
    const vector = JSON.parse(readFileSync('contracts/annual-only-public-review-v2.wire-vector.json'))
    const key = vector.hmacKey
    const env = { ...process.env, PUBLIC_SHA: vector.publicSha, PUBLIC_RUN_ID: String(vector.runId), PUBLIC_RUN_ATTEMPT: String(vector.runAttempt), ANNUAL_PUBLIC_REVIEW_HMAC_KEY: key, ANNUAL_PUBLIC_REVIEW_OUTPUT_DIRECTORY: output }
    const result = spawnSync(process.execPath, ['scripts/sign-annual-public-review.mjs'], { env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(readdirSync(output).sort(), ['annual-only-public-disclosure.json', 'annual-only-public-review.json'])
    const disclosureBytes = readFileSync(path.join(output, 'annual-only-public-disclosure.json'))
    const disclosure = JSON.parse(disclosureBytes)
    const review = JSON.parse(readFileSync(path.join(output, 'annual-only-public-review.json')))
    const unsigned = value => Object.fromEntries(Object.entries(value).filter(([name]) => name !== 'signature'))
    const serializedDigest = value => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
    const sign = value => createHmac('sha256', key).update(serializedDigest(value)).digest('hex')
    assert.deepEqual(Object.keys(disclosure).sort(), ['disclosure', 'predicateType', 'publicSha', 'schemaVersion', 'signature'])
    assert.deepEqual(Object.keys(review).sort(), ['disclosureDigest', 'predicateType', 'publicSha', 'repository', 'runAttempt', 'runId', 'schemaVersion', 'signature'])
    assert.equal(disclosure.signature, vector.disclosureSignature)
    assert.equal(review.signature, vector.reviewSignature)
    assert.equal(disclosure.signature, sign(unsigned(disclosure)))
    assert.equal(review.signature, sign(unsigned(review)))
    assert.equal(review.repository, 'silent-suite/silentsuite')
    assert.equal(review.publicSha, vector.publicSha)
    assert.equal(review.runId, vector.runId)
    assert.equal(review.runAttempt, vector.runAttempt)
    assert.equal(review.disclosureDigest, vector.disclosureDigest)
    assert.equal(review.disclosureDigest, `sha256:${createHash('sha256').update(disclosureBytes).digest('hex')}`)
    assert.equal(disclosure.disclosure.sourceDigest, vector.sourceDigest)
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
})
