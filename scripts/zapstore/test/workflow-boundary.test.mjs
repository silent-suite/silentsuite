// Trust-boundary assertions over the workflow. The publication predicate uses
// the effective YAML job; existing checks also inspect source text. The Python
// signing-boundary checker in CI parses the same file structurally.

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseDocument, visit } from 'yaml'

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

test('publication survives a historical assessment failure but requires successful admission and planning and an uncancelled run', () => {
  const document = parseDocument(workflow, { uniqueKeys: true })
  assert.deepEqual(document.errors, [], 'workflow must parse without duplicate keys')
  const publish = document.toJS().jobs.publish
  assert.deepEqual(publish.needs, ['admit', 'plan'])
  const condition = publish.if.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
  const hasStatusCheck = /\b(?:always|cancelled|failure|success)\s*\(/.test(condition)
  assert.ok(hasStatusCheck, 'an explicit status function must override the implicit ancestor success() check')
  assert.equal(condition, "!cancelled() && needs.admit.result == 'success' && needs.plan.result == 'success' && needs.admit.outputs.active == 'true' && needs.plan.outputs.count != '0'", 'only the reviewed publication predicate is evaluated')
  const evaluate = new Function('needs', 'cancelled', `return (${condition})`)
  for (const historicalResult of ['success', 'failure', 'skipped']) {
    for (const admitResult of ['success', 'failure', 'skipped', 'cancelled']) {
      for (const planResult of ['success', 'failure', 'skipped', 'cancelled']) {
        for (const active of ['true', 'false']) {
          for (const count of ['0', '1']) {
            for (const cancelled of [false, true]) {
              const needs = { admit: { result: admitResult, outputs: { active } }, plan: { result: planResult, outputs: { count } } }
              const implicitSuccess = historicalResult === 'success' && admitResult === 'success' && planResult === 'success'
              const actual = (hasStatusCheck || implicitSuccess) && evaluate(needs, () => cancelled)
              const expected = !cancelled && admitResult === 'success' && planResult === 'success' && active === 'true' && count === '1'
              assert.equal(actual, expected, JSON.stringify({ historicalResult, admitResult, planResult, active, count, cancelled }))
            }
          }
        }
      }
    }
  }
})

test('the only trigger is schedule; the definition revision is the only checkout', () => {
  const on = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\nconcurrency:'))
  assert.match(on, /\non:\n  schedule:\n    - cron: '17 \*\/6 \* \* \*'\n/)
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
  assert.match(job('publish'), /if: \$\{\{ !cancelled\(\) && needs\.admit\.result == 'success' && needs\.plan\.result == 'success' && needs\.admit\.outputs\.active == 'true' && needs\.plan\.outputs\.count != '0' \}\}/)
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
  assert.match(workflow, /\non:\n  schedule:\n    - cron: '17 \*\/6 \* \* \*'\n/)
})

const signing = readFileSync(join(root, '.github', 'workflows', 'zapstore-signing-rehearsal.yml'), 'utf8')

test('signing rehearsal: main-only workflow_dispatch with its own admission and one release-id input read through env', () => {
  const body = code(signing)
  const on = body.slice(body.indexOf('\non:'), body.indexOf('\nconcurrency:'))
  assert.deepEqual(on.match(/^  [a-z_]+:/gm), ['  workflow_dispatch:'])
  assert.deepEqual(body.match(/^  [a-z_]+:$/gm), ['  workflow_dispatch:', '  admit:', '  sign:'], 'one trigger and exactly two jobs')
  assert.doesNotMatch(body, /schedule|cron|repository_dispatch|workflow_call|pull_request|push:|release:|tags:/)
  assert.doesNotMatch(body, /refs\/heads|refs\/tags|github\.workflow_sha|github\.ref\b|github\.head_ref|github\.event/)
  assert.doesNotMatch(body, /^\s+GITHUB_(EVENT_NAME|REF|SHA|WORKFLOW|WORKFLOW_REF|WORKFLOW_SHA|REPOSITORY):/m)
  assert.doesNotMatch(body, /GITHUB_ENV|GITHUB_PATH/)
  assert.equal((signing.match(/inputs\.release_id/g) ?? []).length, 1, 'the input is read once, into an environment variable')
  assert.ok(signing.includes('RELEASE_ID: ' + expr('inputs.release_id')))
  assert.equal(signing.split(shaCheckout).length - 1, 2)
  assert.match(jobOf(signing, 'admit'), /cli\.mjs admit-signing-rehearsal --workspace "\$GITHUB_WORKSPACE"/)
  assert.doesNotMatch(body, /cli\.mjs admit(-rehearsal)? /, 'never another admission')
  assert.match(jobOf(signing, 'sign'), /cli\.mjs checkout-guard --workspace "\$GITHUB_WORKSPACE" --revision "\$REVISION"/)
  assert.match(jobOf(signing, 'sign'), /needs: admit\n/)
  assert.match(signing, /group: zapstore-publish-io-silentsuite-android\n  cancel-in-progress: false/, 'serialized with the publication lane')
})

test('signing rehearsal: one environment job, one secret step, no publication or upload path, counters-only artifact', () => {
  const body = code(signing)
  assert.match(body, /\npermissions: \{\}\n/)
  assert.match(jobOf(signing, 'admit'), /permissions: \{\}/)
  assert.doesNotMatch(jobOf(body, 'admit'), /environment:|secrets\./)
  assert.equal((body.match(/environment: zapstore-production/g) ?? []).length, 1)
  assert.match(jobOf(signing, 'sign'), /environment: zapstore-production/)
  assert.deepEqual([...body.matchAll(/^\s+([a-z-]+): (read|write)$/gm)].map((m) => `${m[1]}: ${m[2]}`), ['contents: read'])
  assert.deepEqual([...new Set([...body.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))].sort(), ['GITHUB_TOKEN', 'ZAPSTORE_BUNKER_CLIENT_KEY', 'ZAPSTORE_SIGN_WITH'])
  const secretSteps = signing.split('\n      - name: ').filter((step) => /secrets\.ZAPSTORE_/.test(step))
  assert.equal(secretSteps.length, 1)
  assert.match(secretSteps[0], /^Verify the signing account, then sign offline without publishing/)
  assert.match(secretSteps[0], /trap 'rm -rf "\$RUNNER_TEMP\/signing\/signer"' EXIT/)
  assert.match(secretSteps[0], /cli\.mjs sign-rehearsal /)
  assert.match(secretSteps[0], /--work-dir "\$RUNNER_TEMP\/signing\/signer"/)
  for (const command of ['publish', 'plan', 'drift', 'revalidate', 'notify', 'reconcile', 'verify-cdn']) assert.doesNotMatch(body, new RegExp(`cli\\.mjs ${command}\\b`), command)
  assert.doesNotMatch(body, /--overwrite-release|--readback|vars\.|ZAPSTORE_AUTOMATION_ENABLED|issues:|: write\b|id-token|secrets: inherit|download-artifact|actions\/cache|blossom|cdn\.zapstore|\bgh (release|issue|api)\b|android-release|ANDROID_KEYSTORE/i)
  assert.deepEqual([...body.matchAll(/^\s+"\$RUNNER_TEMP\/zsp" (.*)$/gm)].map((m) => m[1]), ['--version'], 'the publisher only runs through the CLI')
  assert.equal((body.match(/\bcurl /g) ?? []).length, 1)
  const sign = jobOf(signing, 'sign')
  const order = [
    'Bind the checkout to the admitted revision',
    'Fetch and pin the official publisher',
    'Install apksigner from the fixed build-tools',
    'List and classify published releases by exact id',
    'Require the dispatched release to be the newest eligible release',
    'Bind the exact release, tag commit and assets',
    'Download the bound APK and check all three digests',
    'Verify the APK signature with apksigner',
    'Generate the exact-release configuration and expected events',
    'Verify the signing account, then sign offline without publishing',
    'Remove signer material whatever the outcome',
    'Upload the counters-only verdict',
  ]
  let last = -1
  for (const name of order) {
    const at = sign.indexOf(`- name: ${name}`)
    assert.ok(at > last, `${name} out of order`)
    last = at
  }
  assert.match(sign, /- name: Remove signer material whatever the outcome\n\s+if: always\(\)\n\s+run: rm -rf "\$RUNNER_TEMP\/signing\/signer"/)
  const upload = sign.slice(sign.indexOf('- name: Upload the counters-only verdict'))
  assert.deepEqual([...upload.matchAll(/\$\{\{ runner\.temp \}\}\/(\S+)/g)].map((m) => m[1]), ['signing/signing-rehearsal.json', 'signing/binding.json', 'signing/prepare/release-manifest.json', 'signing/prepare/expected-events.jsonl'], 'never the signer directory')
  const productionUses = new Set([...workflow.matchAll(/uses: ([^\s]+)/g)].map((m) => m[1]))
  for (const uses of signing.matchAll(/uses: ([^\s]+)/g)) assert.ok(productionUses.has(uses[1]), `${uses[1]} is pinned exactly as in the production lane`)
  assert.equal((signing.match(/3f241da6a5dc7a85fe851d3b42b77790b651bd36c7029382a701262bda832d20  \$RUNNER_TEMP\/zsp" \| sha256sum -c -/g) ?? []).length, 1)
  assert.doesNotMatch(workflow, /zapstore-signing-rehearsal|admit-signing-rehearsal|sign-rehearsal/, 'the production lane never references it')
  assert.doesNotMatch(rehearsal, /sign-rehearsal|zapstore-production|ZAPSTORE_/, 'the assessment rehearsal stays secret-free')
})

test('the lane tests are wired into continuous integration without secrets', () => {
  for (const file of ['lane', 'protocol', 'orchestration', 'workflow-boundary', 'signing-rehearsal']) assert.match(rootPackage.scripts['check:zapstore-automation'], new RegExp(`scripts/zapstore/test/${file}\\.test\\.mjs`))
  assert.match(ci, /pnpm run check:zapstore-automation/)
  assert.match(ci, /npm ci --ignore-scripts --no-audit --no-fund --prefix scripts\/zapstore/)
})

// Manual publication lane (.github/workflows/zapstore-manual-publish.yml). The
// assertions are over the effective parsed documents, not source text. While
// the manual definition is absent the scheduled one stands in, so the failure
// reads as a missing dispatch contract rather than a missing file.
const manualPath = join(root, '.github', 'workflows', 'zapstore-manual-publish.yml')
const manualSource = existsSync(manualPath) ? readFileSync(manualPath, 'utf8') : workflow
const MANUAL_INPUTS = ['release_id', 'expected_source_sha', 'expected_apk_asset_id', 'expected_apk_sha256', 'expected_workflow_sha']
const MANUAL_BINDING_ENV = {
  MANUAL_RELEASE_ID: expr('needs.admit.outputs.release_id'),
  MANUAL_EXPECTED_SOURCE_SHA: expr('needs.admit.outputs.expected_source_sha'),
  MANUAL_EXPECTED_APK_ASSET_ID: expr('needs.admit.outputs.expected_apk_asset_id'),
  MANUAL_EXPECTED_APK_SHA256: expr('needs.admit.outputs.expected_apk_sha256'),
}

// Duplicate keys, anchors, aliases and merge keys are refused: the effective
// document must be exactly what the text shows.
function strictWorkflow(text, label) {
  const document = parseDocument(text, { uniqueKeys: true, merge: false })
  assert.deepEqual(document.errors, [], `${label} must parse without duplicate keys`)
  visit(document, {
    Alias() { assert.fail(`${label} must not use YAML aliases`) },
    Node(_, node) { assert.equal(node.anchor, undefined, `${label} must not use YAML anchors`) },
    Pair(_, pair) { assert.notEqual(pair.key?.value, '<<', `${label} must not use YAML merge keys`) },
  })
  return document.toJS()
}

const stepById = (jobBody, id) => {
  const step = jobBody.steps.find((s) => s.id === id)
  assert.ok(step, `step ${id} exists`)
  return step
}
const stepByRun = (jobBody, fragment) => {
  const steps = jobBody.steps.filter((s) => typeof s.run === 'string' && s.run.includes(fragment))
  assert.equal(steps.length, 1, `exactly one step runs ${fragment}`)
  return steps[0]
}

// The complete allowlist of differences from the scheduled definition, applied
// to the scheduled document to produce the only acceptable manual document.
function expectedManualDocument() {
  const expected = strictWorkflow(workflow, 'scheduled workflow')
  expected.name = 'Zapstore Manual Publication'
  expected.on = { workflow_dispatch: { inputs: Object.fromEntries(MANUAL_INPUTS.map((name) => [name, { description: MANUAL_INPUT_DESCRIPTIONS[name], required: true, type: 'string' }])) } }
  const { admit, enumerate, assess, publish } = expected.jobs
  admit.name = 'Admit the manual publication request'
  for (const name of MANUAL_INPUTS) admit.outputs[name] = expr(`steps.admit.outputs.${name}`)
  const admitStep = stepById(admit, 'admit')
  admitStep.env = {
    ...admitStep.env,
    MANUAL_RELEASE_ID: expr('inputs.release_id'),
    MANUAL_EXPECTED_SOURCE_SHA: expr('inputs.expected_source_sha'),
    MANUAL_EXPECTED_APK_ASSET_ID: expr('inputs.expected_apk_asset_id'),
    MANUAL_EXPECTED_APK_SHA256: expr('inputs.expected_apk_sha256'),
    MANUAL_EXPECTED_WORKFLOW_SHA: expr('inputs.expected_workflow_sha'),
  }
  admitStep.run = admitStep.run.replace('cli.mjs admit --workspace', 'cli.mjs admit-manual-publish --workspace')
  const enumerateStep = stepById(enumerate, 'enumerate')
  enumerateStep.env = { ...enumerateStep.env, MANUAL_RELEASE_ID: MANUAL_BINDING_ENV.MANUAL_RELEASE_ID }
  enumerateStep.run = enumerateStep.run.replace('cli.mjs enumerate --out', 'cli.mjs enumerate-manual --out')
  for (const jobBody of [assess, publish]) {
    const bind = stepById(jobBody, 'bind')
    bind.env = { ...bind.env, ...MANUAL_BINDING_ENV }
    bind.run = bind.run.replace('cli.mjs bind --release-id', 'cli.mjs bind-approved --release-id')
  }
  const revalidate = stepById(publish, 'revalidate')
  revalidate.env = { ...revalidate.env, ...MANUAL_BINDING_ENV }
  revalidate.run = revalidate.run.replace('cli.mjs revalidate --binding', 'cli.mjs revalidate-manual --binding')
  return expected
}

const MANUAL_INPUT_DESCRIPTIONS = {
  release_id: 'Exact GitHub release id; must be the single newest eligible release',
  expected_source_sha: 'Owner-approved 40-hex source commit of the release tag',
  expected_apk_asset_id: 'Owner-approved GitHub asset id of the release APK',
  expected_apk_sha256: 'Owner-approved 64-hex SHA-256 of the release APK',
  expected_workflow_sha: '40-hex protected-main commit this run must be loaded from and execute',
}

test('manual publication: workflow_dispatch is the only trigger, with exactly the five required string inputs', () => {
  const manual = strictWorkflow(manualSource, 'manual workflow')
  assert.deepEqual(Object.keys(manual.on), ['workflow_dispatch'], 'workflow_dispatch is the only trigger; no schedule, release or repository_dispatch')
  const inputs = manual.on.workflow_dispatch.inputs
  assert.deepEqual(Object.keys(inputs), MANUAL_INPUTS)
  for (const name of MANUAL_INPUTS) {
    assert.deepEqual(Object.keys(inputs[name]).sort(), ['description', 'required', 'type'], `${name} has no default and no options`)
    assert.equal(inputs[name].required, true, name)
    assert.equal(inputs[name].type, 'string', name)
  }
})

test('manual publication: the effective document equals the scheduled lane after the exact allowlisted differences', () => {
  const manual = strictWorkflow(manualSource, 'manual workflow')
  const expected = expectedManualDocument()
  assert.deepEqual(Object.keys(manual.jobs), JOBS, 'the same six-job topology')
  for (const name of JOBS) assert.deepEqual(manual.jobs[name], expected.jobs[name], `job ${name} is the scheduled job apart from the allowlisted differences`)
  assert.deepEqual(manual, expected)
  const scheduled = strictWorkflow(workflow, 'scheduled workflow')
  assert.deepEqual(manual.concurrency, scheduled.concurrency, 'one global concurrency group, never cancelling')
  assert.deepEqual(manual.permissions, {})
  for (const name of ['plan', 'notify']) assert.deepEqual(manual.jobs[name], scheduled.jobs[name], `${name} is untouched`)
})

test('manual publication: inputs reach only the admit step environment; later jobs see only validated admit outputs', () => {
  const manual = strictWorkflow(manualSource, 'manual workflow')
  const admitStep = stepByRun(manual.jobs.admit, 'cli.mjs admit-manual-publish --workspace "$GITHUB_WORKSPACE"')
  assert.equal(admitStep.id, 'admit')
  const direct = []
  const walk = (value, path) => {
    if (typeof value === 'string') { if (/\binputs\.|github\.event\.inputs|toJSON\(\s*(?:github|inputs)/.test(value)) direct.push({ path: path.join('.'), value }) }
    else if (Array.isArray(value)) value.forEach((item, index) => walk(item, [...path, index]))
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) walk(item, [...path, key])
  }
  walk(manual.jobs, ['jobs'])
  walk(manual.concurrency, ['concurrency'])
  walk(manual.env, ['env'])
  const admitIndex = manual.jobs.admit.steps.indexOf(admitStep)
  assert.deepEqual(direct.map((d) => d.path).sort(), ['MANUAL_EXPECTED_APK_ASSET_ID', 'MANUAL_EXPECTED_APK_SHA256', 'MANUAL_EXPECTED_SOURCE_SHA', 'MANUAL_EXPECTED_WORKFLOW_SHA', 'MANUAL_RELEASE_ID'].map((name) => `jobs.admit.steps.${admitIndex}.env.${name}`), 'the only input expressions are the five admit environment entries')
  for (const [name, jobBody] of Object.entries(manual.jobs)) {
    for (const step of jobBody.steps) {
      assert.doesNotMatch(step.run ?? '', /\$\{\{/, `${name}: no expression is interpolated into shell code`)
      assert.doesNotMatch(JSON.stringify(step.with ?? {}), /inputs\.|admit\.outputs\.(?:release_id|expected_)/, `${name}: request values never reach an action input`)
    }
  }
  for (const name of MANUAL_INPUTS) assert.equal(manual.jobs.admit.outputs[name], expr(`steps.admit.outputs.${name}`))
  assert.deepEqual(stepByRun(manual.jobs.enumerate, 'cli.mjs enumerate-manual --out').env.MANUAL_RELEASE_ID, MANUAL_BINDING_ENV.MANUAL_RELEASE_ID)
  for (const name of ['assess', 'publish']) {
    const bind = stepByRun(manual.jobs[name], 'cli.mjs bind-approved --release-id "$RELEASE_ID"')
    assert.equal(bind.id, 'bind', `${name}: a refused approval is recorded as the bind phase`)
    for (const [key, value] of Object.entries(MANUAL_BINDING_ENV)) assert.equal(bind.env[key], value, `${name} ${key}`)
  }
})

test('manual publication: one environment-bound job, one secret step, and the manual freshness check immediately before it', () => {
  const manual = strictWorkflow(manualSource, 'manual workflow')
  assert.deepEqual(Object.entries(manual.jobs).filter(([, jobBody]) => jobBody.environment !== undefined).map(([name, jobBody]) => [name, jobBody.environment]), [['publish', 'zapstore-production']])
  const secretSteps = []
  for (const [name, jobBody] of Object.entries(manual.jobs)) {
    for (const step of jobBody.steps) if (/secrets\.(?!GITHUB_TOKEN\b)/.test(JSON.stringify(step))) secretSteps.push(`${name}.${step.id}`)
  }
  assert.deepEqual(secretSteps, ['publish.sign'])
  assert.deepEqual(manual.jobs.publish.permissions, { contents: 'read' })
  assert.deepEqual(manual.jobs.notify.permissions, { issues: 'write' })
  const steps = manual.jobs.publish.steps
  const revalidate = stepByRun(manual.jobs.publish, 'cli.mjs revalidate-manual --binding')
  assert.equal(revalidate.id, 'revalidate')
  assert.equal(revalidate.if, "steps.reconcile.outputs.action == 'publish'")
  assert.equal(steps[steps.indexOf(revalidate) + 1].id, 'sign', 'nothing runs between the freshness check and the signer step')
  for (const [key, value] of Object.entries(MANUAL_BINDING_ENV)) assert.equal(revalidate.env[key], value, key)
  for (const jobBody of Object.values(manual.jobs)) {
    const checkouts = jobBody.steps.filter((step) => String(step.uses ?? '').startsWith('actions/checkout@'))
    assert.equal(checkouts.length, 1)
    assert.equal(checkouts[0].with.ref, expr('github.sha'))
    assert.equal(checkouts[0].with['persist-credentials'], false)
  }
})

test('manual publication: every CLI command the workflow runs exists, and the scheduled lane and rehearsals never reference the manual lane', () => {
  const manual = strictWorkflow(manualSource, 'manual workflow')
  const cliSource = readFileSync(join(root, 'scripts', 'zapstore', 'cli.mjs'), 'utf8')
  const referenced = new Set()
  for (const jobBody of Object.values(manual.jobs)) for (const step of jobBody.steps) for (const match of (step.run ?? '').matchAll(/cli\.mjs ([a-z-]+)/g)) referenced.add(match[1])
  for (const command of ['admit-manual-publish', 'enumerate-manual', 'bind-approved', 'revalidate-manual']) assert.ok(referenced.has(command), `the manual workflow runs ${command}`)
  for (const command of ['admit', 'enumerate', 'bind', 'revalidate']) assert.ok(!referenced.has(command), `the manual workflow never runs the scheduled ${command}`)
  for (const command of referenced) assert.match(cliSource, new RegExp(`\\n  (?:async )?(?:'${command}'|${command})\\(\\) \\{`), `cli.mjs defines ${command}`)
  const signingRehearsal = readFileSync(join(root, '.github', 'workflows', 'zapstore-signing-rehearsal.yml'), 'utf8')
  for (const [label, text] of [['scheduled lane', workflow], ['assessment rehearsal', rehearsal], ['signing rehearsal', signingRehearsal]]) {
    assert.doesNotMatch(text, /manual-publish|enumerate-manual|bind-approved|revalidate-manual|MANUAL_/, `${label} never references the manual lane`)
  }
  assert.match(rootPackage.scripts['check:zapstore-automation'], /scripts\/zapstore\/test\/manual-publish\.test\.mjs/)
})
