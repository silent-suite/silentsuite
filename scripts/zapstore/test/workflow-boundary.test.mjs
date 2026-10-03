// Trust-boundary assertions over the workflow text. These are structural text
// checks (no YAML parser is available without a dependency); the Python
// signing-boundary checker in CI parses the same file structurally.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(new URL('.', import.meta.url).pathname, '..', '..', '..')
const workflow = readFileSync(join(root, '.github', 'workflows', 'zapstore-publish.yml'), 'utf8')
const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const expr = (inner) => '${' + '{ ' + inner + ' }}'
const shaCheckout = 'ref: ' + expr('github.sha')
const rehearsal = readFileSync(join(root, '.github', 'workflows', 'zapstore-rehearsal.yml'), 'utf8')
const jobOf = (text, name) => {
  const start = text.indexOf(`\n  ${name}:\n`)
  assert.ok(start >= 0, `job ${name} exists`)
  const rest = text.slice(start + 1)
  const next = rest.slice(1).search(/\n  [a-z]+:\n/)
  return next < 0 ? rest : rest.slice(0, next + 1)
}
const job = (name) => jobOf(workflow, name)
const code = (text) => text.replace(/^\s*#.*$/gm, '')
const JOBS = ['admit', 'enumerate', 'assess', 'plan', 'publish', 'notify']

test('the only trigger is schedule; the definition revision is the only checkout', () => {
  const on = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\nconcurrency:'))
  assert.match(on, /\non:\n  schedule:\n    - cron: '17 \* \* \* \*'\n/)
  assert.deepEqual(on.match(/^  [a-z_]+:/gm), ['  schedule:'], 'schedule is the only trigger key')
  assert.doesNotMatch(on.replace(/^#.*$/gm, ''), /release|repository_dispatch|workflow_dispatch|pull_request|push|workflow_call|tags:/)
  assert.equal(workflow.split(shaCheckout).length - 1, JOBS.length, 'every job checks out github.sha exactly once')
  assert.equal(workflow.split('actions/checkout@').length - 1, JOBS.length)
  assert.doesNotMatch(workflow, /refs\/heads\/main|refs\/tags|github\.workflow_sha|github\.ref\b|github\.event\.release|github\.head_ref/)
  for (const name of JOBS) {
    const body = job(name)
    assert.match(body, /persist-credentials: false/)
    if (name === 'admit') assert.match(body, /cli\.mjs admit --workspace "\$GITHUB_WORKSPACE"/)
    else assert.match(body, /cli\.mjs checkout-guard --workspace "\$GITHUB_WORKSPACE" --revision "\$REVISION"/, `${name} binds its checkout`)
    if (name !== 'admit') assert.match(body, /REVISION: \$\{\{ needs\.admit\.outputs\.revision \}\}/)
  }
  assert.match(workflow, /prepare[\s\S]*--source-root "\$GITHUB_WORKSPACE" --revision "\$REVISION"/)
})

test('permissions and environment: nothing by default, one environment-bound job, read-only assessment, issues-only notification', () => {
  assert.match(workflow, /\npermissions: \{\}\n/)
  assert.equal((workflow.match(/environment: zapstore-production/g) ?? []).length, 1)
  assert.match(job('publish'), /environment: zapstore-production/)
  for (const name of ['admit', 'enumerate', 'assess', 'plan', 'notify']) assert.doesNotMatch(job(name), /environment:|secrets\.ZAPSTORE/, `${name} has no environment and no signer secret`)
  assert.match(job('admit'), /permissions: \{\}/)
  assert.match(job('plan'), /permissions: \{\}/)
  assert.doesNotMatch(job('plan'), /secrets\./)
  assert.match(job('assess'), /permissions:\n\s+contents: read/)
  assert.match(job('publish'), /permissions:\n\s+contents: read/)
  assert.match(job('notify'), /permissions:\n\s+issues: write/)
  assert.doesNotMatch(workflow, /android-release|ANDROID_KEYSTORE|ANDROID_KEY_ALIAS|secrets: inherit|softprops|contents: write|releases\/latest|-X PATCH|client_payload/)
  assert.doesNotMatch(workflow, /\bgh release\b/)
  assert.match(workflow, /cancel-in-progress: false/)
  assert.equal((workflow.match(/max-parallel: 1/g) ?? []).length, 2)
  assert.equal((workflow.match(/fail-fast: false/g) ?? []).length, 2)
  assert.doesNotMatch(workflow, /actions\/cache/)
})

test('the environment-bound job publishes only what the read-only assessment approved, after preflight, in order', () => {
  assert.match(job('publish'), /needs: \[admit, plan\]/)
  assert.match(job('publish'), /if: needs\.admit\.outputs\.active == 'true' && needs\.plan\.outputs\.count != '0'/)
  assert.match(job('assess'), /if: needs\.enumerate\.outputs\.count != '0'/)
  assert.match(job('plan'), /needs: \[admit, enumerate, assess\]/)
  assert.match(job('publish'), /name: zapstore-assessment-\$\{\{ matrix\.release_id \}\}\n\s+path:/)
  const secretSteps = workflow.split('\n      - name: ').filter((step) => /secrets\.ZAPSTORE_/.test(step))
  assert.equal(secretSteps.length, 1)
  const step = secretSteps[0]
  assert.match(step, /^Verify the signing account, then sign and publish with the pinned publisher/)
  assert.match(step, /if: steps\.reconcile\.outputs\.action == 'publish'/)
  assert.ok(step.includes('ZAPSTORE_SIGN_WITH: ' + expr('secrets.ZAPSTORE_SIGN_WITH')))
  assert.ok(step.includes('ZAPSTORE_BUNKER_CLIENT_KEY: ' + expr('secrets.ZAPSTORE_BUNKER_CLIENT_KEY')))
  assert.match(step, /trap 'rm -rf "\$RUNNER_TEMP\/publish\/signer\/xdg"' EXIT/)
  assert.match(step, /cli\.mjs publish /)
  const order = [
    'Bind the checkout to the admitted revision',
    'Download the approved assessment',
    'Bind the exact release, tag commit and assets',
    'Download the bound APK and check all three digests',
    'Verify the APK signature with apksigner',
    'Generate the exact-release configuration and expected events',
    'Reconcile against the relay immediately before signing',
    'Require the publication input to equal the approved assessment',
    'Revalidate the release identity immediately before signing',
    'Verify the signing account, then sign and publish with the pinned publisher',
    'Read back the published events',
    'Verify CDN bytes',
    'Record the publication result',
    'Upload publication evidence',
  ]
  const publish = job('publish')
  let last = -1
  for (const name of order) {
    const at = publish.indexOf(`- name: ${name}`)
    assert.ok(at > last, `${name} out of order`)
    last = at
  }
  assert.match(publish, /if: always\(\) && \(steps\.sign\.outcome == 'success' \|\| steps\.sign\.outcome == 'failure'\)/)
  assert.match(publish, /reconcile --readback --publishable true/)
  assert.match(publish, /steps\.reconcile\.outputs\.verify_cdn == 'true' \|\| steps\.readback\.outputs\.outcome == 'complete-match'/)
  for (const phase of ['CHECKOUT', 'BIND', 'APK', 'APKSIGNER', 'PREPARE', 'RECONCILE', 'DRIFT', 'REVALIDATE', 'SIGN', 'READBACK', 'CDN']) assert.match(publish, new RegExp(`PHASE_${phase}: \\$\\{\\{ steps\\.[a-z]+\\.outcome \\}\\}`))
  assert.match(publish, /record-result --job publish/)
  assert.match(publish, /if-no-files-found: error/)
  assert.doesNotMatch(workflow, /yes \|/)
})

test('the read-only assessment records every phase and uploads evidence unconditionally', () => {
  const assess = job('assess')
  assert.match(assess, /reconcile --publishable "\$PUBLISHABLE"/)
  assert.match(assess, /PUBLISHABLE: \$\{\{ matrix\.publishable \}\}/)
  assert.match(assess, /if: steps\.reconcile\.outputs\.verify_cdn == 'true'\n\s+run: node scripts\/zapstore\/cli\.mjs verify-cdn/)
  for (const phase of ['CHECKOUT', 'BIND', 'APK', 'APKSIGNER', 'PREPARE', 'RECONCILE', 'CDN']) assert.match(assess, new RegExp(`PHASE_${phase}: \\$\\{\\{ steps\\.[a-z]+\\.outcome \\}\\}`))
  assert.match(assess, /record-result --job assess/)
  assert.match(assess, /name: zapstore-assessment-\$\{\{ matrix\.release_id \}\}\n\s+if-no-files-found: error/)
  assert.match(job('enumerate'), /name: zapstore-candidates/)
  assert.match(job('plan'), /pattern: zapstore-assessment-\*/)
  const notify = job('notify')
  assert.match(notify, /needs: \[admit, enumerate, assess, plan, publish\]/)
  assert.match(notify, /if: always\(\) && needs\.admit\.outputs\.active == 'true'/)
  for (const name of ['ENUMERATE', 'ASSESS', 'PLAN', 'PUBLISH']) assert.match(notify, new RegExp(`JOB_${name}: \\$\\{\\{ needs\\.[a-z]+\\.result \\}\\}`))
  assert.match(notify, /pattern: zapstore-\*/)
})

test('publisher binary is pinned by URL and digest and every action is pinned by commit', () => {
  assert.equal((workflow.match(/zsp-0\.4\.17-linux-amd64/g) ?? []).length, 2)
  assert.equal((workflow.match(/3f241da6a5dc7a85fe851d3b42b77790b651bd36c7029382a701262bda832d20  \$RUNNER_TEMP\/zsp" \| sha256sum -c -/g) ?? []).length, 2)
  for (const uses of workflow.matchAll(/uses: ([^\s]+)/g)) assert.match(uses[1], /@[0-9a-f]{40}$/, uses[1])
  assert.match(workflow, /NODE_VERSION: '22'/)
  assert.ok(workflow.includes('node-version: ' + expr('env.NODE_VERSION')))
  assert.ok(workflow.includes('uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a'))
  assert.ok(workflow.includes('uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c'))
  assert.equal((workflow.match(/npm ci --ignore-scripts --no-audit --no-fund --prefix scripts\/zapstore/g) ?? []).length, 2, 'only the two verification jobs install the crypto package')
})

test('manual rehearsal: workflow_dispatch only, no inputs, its own admission, every job bound to the admitted revision', () => {
  const body = code(rehearsal)
  const on = body.slice(body.indexOf('\non:'), body.indexOf('\nconcurrency:'))
  assert.equal(on.trim(), 'on:\n  workflow_dispatch:')
  assert.deepEqual(body.match(/^  [a-z_]+:$/gm), ['  workflow_dispatch:', '  admit:', '  enumerate:', '  assess:'], 'one trigger and exactly three jobs')
  assert.doesNotMatch(body, /schedule|cron|inputs|repository_dispatch|workflow_call|pull_request|push:|release:|tags:/)
  assert.doesNotMatch(body, /refs\/heads|refs\/tags|github\.workflow_sha|github\.ref\b|github\.head_ref|github\.event/)
  assert.doesNotMatch(body, /^\s+GITHUB_(EVENT_NAME|REF|SHA|WORKFLOW|WORKFLOW_REF|WORKFLOW_SHA|REPOSITORY):/m, 'run context is never overridden')
  assert.doesNotMatch(body, /GITHUB_ENV|GITHUB_PATH/)
  assert.equal(rehearsal.split(shaCheckout).length - 1, 3, 'every job checks out github.sha exactly once')
  assert.equal(rehearsal.split('actions/checkout@').length - 1, 3)
  for (const name of ['admit', 'enumerate', 'assess']) {
    const steps = jobOf(rehearsal, name)
    assert.match(steps, /persist-credentials: false/)
    if (name === 'admit') assert.match(steps, /cli\.mjs admit-rehearsal --workspace "\$GITHUB_WORKSPACE"/)
    else assert.match(steps, /cli\.mjs checkout-guard --workspace "\$GITHUB_WORKSPACE" --revision "\$REVISION"/, `${name} binds its checkout`)
    if (name !== 'admit') assert.match(steps, /REVISION: \$\{\{ needs\.admit\.outputs\.revision \}\}/)
  }
  assert.doesNotMatch(body, /cli\.mjs admit /, 'never the scheduled admission')
  assert.doesNotMatch(jobOf(rehearsal, 'admit'), /outputs\.active|outputs\.rehearsal|vars\./)
  assert.match(rehearsal, /group: zapstore-rehearsal-io-silentsuite-android\n  cancel-in-progress: false/)
  assert.doesNotMatch(rehearsal, /group: zapstore-publish-/)
})

test('manual rehearsal: no environment, no signer, no plan, publication or issue writes; read-only token only', () => {
  const body = code(rehearsal)
  assert.match(body, /\npermissions: \{\}\n/)
  assert.match(jobOf(rehearsal, 'admit'), /permissions: \{\}/)
  assert.deepEqual([...body.matchAll(/^\s+([a-z-]+): (read|write)$/gm)].map((m) => `${m[1]}: ${m[2]}`), ['contents: read', 'contents: read'])
  assert.deepEqual([...new Set([...body.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))], ['GITHUB_TOKEN'])
  assert.doesNotMatch(body, /environment:|zapstore-production|ZAPSTORE_|vars\.|secrets: inherit|issues:|: write\b|id-token|client_payload/)
  for (const command of ['publish', 'plan', 'drift', 'revalidate', 'notify']) assert.doesNotMatch(body, new RegExp(`cli\\.mjs ${command}\\b`), command)
  assert.doesNotMatch(body, /--readback|--publishable true|download-artifact|softprops|\bgh (release|issue|api)\b|android-release|ANDROID_KEYSTORE|actions\/cache/)
  assert.equal((body.match(/\bcurl /g) ?? []).length, 1, 'the only network fetch outside the CLI is the pinned publisher download')
  assert.deepEqual([...body.matchAll(/^\s+"\$RUNNER_TEMP\/zsp" (.*)$/gm)].map((m) => m[1]), ['--version'], 'the publisher is only run unsigned through prepare')
})

test('manual rehearsal reuses the production assessment verbatim and uploads evidence under distinct names', () => {
  assert.equal(jobOf(rehearsal, 'assess').trimEnd(), job('assess').trimEnd().replace('name: zapstore-assessment-', 'name: zapstore-rehearsal-assessment-'))
  const steps = (body) => body.slice(body.indexOf('    steps:\n')).trimEnd()
  assert.equal(steps(jobOf(rehearsal, 'enumerate')), steps(job('enumerate')).replace('name: zapstore-candidates', 'name: zapstore-rehearsal-candidates'))
  assert.match(jobOf(rehearsal, 'enumerate'), /needs: admit\n/)
  const artifacts = [...rehearsal.matchAll(/^\s+name: (zapstore-.+)$/gm)].map((m) => m[1])
  assert.deepEqual(artifacts, ['zapstore-rehearsal-candidates', 'zapstore-rehearsal-assessment-${{ matrix.release_id }}'])
  const productionUses = new Set([...workflow.matchAll(/uses: ([^\s]+)/g)].map((m) => m[1]))
  for (const uses of rehearsal.matchAll(/uses: ([^\s]+)/g)) {
    assert.match(uses[1], /@[0-9a-f]{40}$/, uses[1])
    assert.ok(productionUses.has(uses[1]), `${uses[1]} is pinned exactly as in the production lane`)
  }
  assert.equal((rehearsal.match(/3f241da6a5dc7a85fe851d3b42b77790b651bd36c7029382a701262bda832d20  \$RUNNER_TEMP\/zsp" \| sha256sum -c -/g) ?? []).length, 1)
})

test('the production lane is unchanged by the rehearsal and never references it', () => {
  assert.doesNotMatch(workflow, /zapstore-rehearsal|admit-rehearsal|workflow_dispatch:/)
  assert.match(workflow, /\non:\n  schedule:\n    - cron: '17 \* \* \* \*'\n/)
})

test('the lane tests are wired into continuous integration without secrets', () => {
  for (const file of ['lane', 'protocol', 'orchestration', 'workflow-boundary']) assert.match(rootPackage.scripts['check:zapstore-automation'], new RegExp(`scripts/zapstore/test/${file}\\.test\\.mjs`))
  assert.match(ci, /pnpm run check:zapstore-automation/)
  assert.match(ci, /npm ci --ignore-scripts --no-audit --no-fund --prefix scripts\/zapstore/)
})
