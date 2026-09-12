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
const shaCheckout = 'ref: ${' + '{ github.sha }}'

test('workflow is schedule plus owner release events, never a second dispatch or tag checkout', () => {
  const on = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\nconcurrency:'))
  assert.match(on, /schedule:/)
  assert.match(on, /cron: '17 4 \* \* \*'/)
  assert.match(on, /release:\n    types: \[published, edited\]/)
  assert.doesNotMatch(on, /repository_dispatch|pull_request|push:|workflow_call|workflow_dispatch|tags:/)
  assert.equal(workflow.split('ref: refs/heads/main').length - 1, 4)
  assert.equal(workflow.split(shaCheckout).length - 1, 0)
  assert.equal(workflow.split('ref: ${' + '{ github.workflow_sha }}').length - 1, 0)
})

test('workflow grants nothing by default, binds only the dedicated environment, and never touches Android signing or release writes', () => {
  assert.match(workflow, /\npermissions: \{\}\n/)
  assert.equal((workflow.match(/environment: zapstore-production/g) ?? []).length, 1)
  assert.doesNotMatch(workflow, /android-release|ANDROID_KEYSTORE|ANDROID_KEY_ALIAS|secrets: inherit|softprops|contents: write|releases\/latest/)
  assert.doesNotMatch(workflow, /\bgh release\b/)
  assert.match(workflow, /cancel-in-progress: false/)
  assert.match(workflow, /max-parallel: 1/)
})

test('secrets reach exactly one step, which runs only when reconcile action is publish, after revalidation, with cleanup', () => {
  const secretSteps = workflow.split('\n      - name: ').filter((step) => /secrets\.ZAPSTORE_/.test(step))
  assert.equal(secretSteps.length, 1)
  const step = secretSteps[0]
  assert.match(step, /^Sign and publish with the pinned publisher/)
  assert.match(step, /if: steps\.reconcile\.outputs\.action == 'publish'/)
  assert.doesNotMatch(step, /outcome == 'absent'/)
  assert.ok(step.includes('ZAPSTORE_SIGN_WITH: ' + expr('secrets.ZAPSTORE_SIGN_WITH')))
  assert.ok(step.includes('ZAPSTORE_BUNKER_CLIENT_KEY: ' + expr('secrets.ZAPSTORE_BUNKER_CLIENT_KEY')))
  assert.match(step, /trap 'rm -rf "\$RUNNER_TEMP\/publish\/xdg"' EXIT/)
  const order = [
    'Bind the exact release',
    'Download the bound APK',
    'Verify the APK signature with apksigner',
    'Generate the exact-release configuration',
    'Reconcile against the relay before signing',
    'Revalidate the release identity immediately before signing',
    'Sign and publish with the pinned publisher',
    'Read back the published events',
    'Verify CDN bytes on complete-match',
  ]
  let last = -1
  for (const name of order) {
    const at = workflow.indexOf(name)
    assert.ok(at > last, `${name} out of order`)
    last = at
  }
  assert.doesNotMatch(workflow, /actions\/cache/)
  assert.match(workflow, /if: always\(\) && \(steps\.sign\.outcome == 'success' \|\| steps\.sign\.outcome == 'failure'\)/)
  assert.match(workflow, /steps\.reconcile\.outputs\.outcome == 'complete-match' \|\| steps\.readback\.outputs\.outcome == 'complete-match'/)
  const publishJob = workflow.slice(workflow.indexOf('\n  publish:'), workflow.indexOf('\n  notify:'))
  assert.doesNotMatch(publishJob, /yes \|/)
  assert.match(publishJob, /sdk-license-acceptance/)
})

test('publisher binary is pinned by URL and digest and every action is pinned by commit', () => {
  assert.match(workflow, /zsp-0\.4\.17-linux-amd64/)
  assert.match(workflow, /3f241da6a5dc7a85fe851d3b42b77790b651bd36c7029382a701262bda832d20  \$RUNNER_TEMP\/zsp" \| sha256sum -c -/)
  for (const uses of workflow.matchAll(/uses: ([^\s]+)/g)) assert.match(uses[1], /@[0-9a-f]{40}$/, uses[1])
  assert.match(workflow, /NODE_VERSION: '22'/)
  assert.ok(workflow.includes('node-version: ' + expr('env.NODE_VERSION')))
  assert.ok(workflow.includes('uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a'))
  assert.ok(workflow.includes('uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c'))
})

test('publish and notify jobs are gated on activation; the notify job holds only issues: write', () => {
  const publish = workflow.slice(workflow.indexOf('\n  publish:'), workflow.indexOf('\n  notify:'))
  assert.match(publish, /if: needs\.admit\.outputs\.active == 'true' && needs\.enumerate\.outputs\.count != '0'/)
  assert.match(publish, /permissions:\n\s+contents: read/)
  const notify = workflow.slice(workflow.indexOf('\n  notify:'))
  assert.match(notify, /needs\.admit\.outputs\.active == 'true'/)
  assert.match(notify, /permissions:\n\s+issues: write/)
  assert.doesNotMatch(notify, /ZAPSTORE_SIGN_WITH|ZAPSTORE_BUNKER_CLIENT_KEY/)
})

test('the lane tests are wired into continuous integration without secrets', () => {
  assert.match(rootPackage.scripts['check:zapstore-automation'], /node --test scripts\/zapstore\/test\/lane\.test\.mjs scripts\/zapstore\/test\/workflow-boundary\.test\.mjs/)
  assert.match(ci, /pnpm run check:zapstore-automation/)
  assert.match(ci, /npm ci --ignore-scripts --no-audit --no-fund --prefix scripts\/zapstore/)
})
