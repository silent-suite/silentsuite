// Routine successful preview runs must not post or edit PR comments, because
// each new bot comment emails the PR's participants. Their results go to the
// job summary instead. Failure alerts that open issues (Zapstore) must stay.
//
// This is a bounded structural check of the real workflow files. The root has
// no YAML parser dependency, so it splits on the repository's fixed two-space
// job and six-space step indentation, like check-billing-copy-workflow.test.mjs.
// Full workflow semantics are left to GitHub Actions and review.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

const workflowsDir = new URL('../.github/workflows/', import.meta.url)
const read = name => readFileSync(new URL(name, workflowsDir), 'utf8')
const workflowNames = () => readdirSync(workflowsDir).filter(name => /\.ya?ml$/.test(name)).sort()

function split(text) {
  const marker = text.indexOf('\njobs:\n')
  assert.ok(marker >= 0, 'workflow must declare jobs')
  const header = text.slice(0, marker + 1)
  const body = text.slice(marker + '\njobs:\n'.length)
  const heads = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):\n/gm)]
  const jobs = new Map(heads.map((head, i) => [
    head[1],
    body.slice(head.index + head[0].length, i + 1 < heads.length ? heads[i + 1].index : body.length),
  ]))
  return { header, jobs }
}

function permissions(block, indent) {
  const pad = ' '.repeat(indent)
  const match = block.match(new RegExp(`^${pad}permissions:(?: *(\\S[^\\n]*))?\\n((?:${pad}  [^\\n]*\\n)*)`, 'm'))
  if (!match) return null
  if (match[1]) return [match[1].trim()]
  return match[2].split('\n').map(line => line.trim()).filter(Boolean)
}

function steps(job) {
  const start = job.search(/^ {4}steps:\n/m)
  assert.ok(start >= 0, 'job must declare steps')
  return job.slice(start).split(/^ {6}- /m).slice(1)
}

const stepName = step => step.match(/^name: (.+)$/m)?.[1]?.trim()

const commentWriter = /createComment|updateComment|deleteComment|createReview|submitReview|createReviewComment|gh\s+(?:pr|issue)\s+(?:comment|review)/

test('no workflow posts, edits or reviews PR and issue comments', () => {
  for (const name of workflowNames()) {
    assert.doesNotMatch(read(name), commentWriter, `${name} must not write PR or issue comments`)
  }
})

test('only the Zapstore failure notifiers hold issue or pull-request write access', () => {
  const holders = []
  for (const name of workflowNames()) {
    const { header, jobs } = split(read(name))
    const writes = perms => (perms ?? []).some(line => /^(?:issues|pull-requests): write$|^write-all$/.test(line))
    if (writes(permissions(header, 0))) holders.push(`${name}#workflow`)
    for (const [job, block] of jobs) if (writes(permissions(block, 4))) holders.push(`${name}#${job}`)
  }
  assert.deepEqual(holders, ['zapstore-manual-publish.yml#notify', 'zapstore-publish.yml#notify'])
})

test('Zapstore failure issues remain an actionable alert path', () => {
  for (const name of ['zapstore-publish.yml', 'zapstore-manual-publish.yml']) {
    const notify = split(read(name)).jobs.get('notify')
    assert.ok(notify, `${name} must keep its notify job`)
    assert.match(notify, /^ {4}name: Open issues for failures$/m)
    assert.match(notify, /^ {4}if: always\(\) && needs\.admit\.outputs\.active == 'true'$/m)
    assert.deepEqual(permissions(notify, 4), ['issues: write'])
    assert.match(notify, /node scripts\/zapstore\/cli\.mjs notify/)
  }
})

test('the web PR build reports to its job summary with read-only access and unchanged trusted jobs', () => {
  const { header, jobs } = split(read('preview-web.yml'))
  assert.match(header, /^ {2}push:\n {4}branches:\n {6}- main\n/m)
  assert.match(header, /^ {2}pull_request:\n {4}branches: \[main\]\n/m)
  assert.match(header, /^ {2}workflow_dispatch:\n {4}inputs:\n {6}pr_number:\n[\s\S]*^ {6}expected_sha:\n/m)
  assert.doesNotMatch(header, /pull_request_target|^permissions:/m)
  assert.deepEqual([...jobs.keys()], ['build-preview', 'resolve-trusted-target', 'build-shared-preview-image', 'publish-and-deploy-preview'])

  const pr = jobs.get('build-preview')
  assert.match(pr, /^ {4}if: github\.event_name == 'pull_request'$/m)
  assert.deepEqual(permissions(pr, 4), ['contents: read'])
  assert.doesNotMatch(pr, /secrets\.|github\.rest\./)
  const prSteps = steps(pr)
  assert.deepEqual(prSteps.map(stepName), [
    'Checkout', 'Setup pnpm', 'Setup Node.js', 'Install dependencies', 'Enforce annual billing copy',
    'Set up Docker Buildx', 'Build preview image', 'Record preview build summary',
  ])
  const summary = prSteps.at(-1)
  assert.match(summary, /uses: actions\/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3 # v9\.0\.0/)
  assert.match(summary, /\*\*Preview build completed\*\*/)
  assert.match(summary, /await core\.summary\.addRaw\(body\)\.write\(\)/)

  assert.deepEqual(permissions(jobs.get('resolve-trusted-target'), 4), ['contents: read', 'pull-requests: read'])
  assert.deepEqual(permissions(jobs.get('build-shared-preview-image'), 4), ['contents: read'])
  const deploy = jobs.get('publish-and-deploy-preview')
  assert.deepEqual(permissions(deploy, 4), ['contents: read', 'packages: write', 'pull-requests: read'])
  assert.match(deploy, /group: preview-web-shared-main\n {6}cancel-in-progress: false/)
  assert.match(deploy, /^ {4}environment: web-preview$/m)
  assert.match(deploy, /key: \$\{\{ secrets\.PREVIEW_VPS_SSH_KEY \}\}/)
})

test('the docs preview reports its URL to the run summary with read-only access', () => {
  const { header, jobs } = split(read('preview-docs.yml'))
  assert.match(header, /^ {2}push:\n {4}branches:\n {6}- main\n {4}paths:\n/m)
  assert.doesNotMatch(header, /branches-ignore|workflow_dispatch/)
  assert.doesNotMatch(header, /pull_request|^permissions:/m)
  assert.match(header, /^concurrency:\n {2}group: preview-docs-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: true\n/m)
  assert.deepEqual([...jobs.keys()], ['deploy-preview'])

  const job = jobs.get('deploy-preview')
  assert.deepEqual(permissions(job, 4), ['contents: read'])
  assert.doesNotMatch(job, /actions\/github-script@|github\.rest\./)
  const jobSteps = steps(job)
  assert.deepEqual(jobSteps.map(stepName), [
    'Checkout', 'Setup pnpm', 'Setup Node.js', 'Install dependencies', 'Enforce annual billing copy',
    'Test Android distribution documentation', 'Build docs', 'Deploy to preview Worker', 'Record preview URL in the run summary',
  ])
  const [deploy, summary] = jobSteps.slice(-2)
  assert.match(deploy, /command: deploy --config wrangler\.preview\.jsonc/)
  assert.match(job, /^ {4}environment: docs-preview$/m)
  assert.match(deploy, /apiToken: \$\{\{ secrets\.PREVIEW_CLOUDFLARE_API_TOKEN \}\}/)
  assert.match(summary, /\*\*Docs preview deployed\*\* to https:\/\/silentsuite-docs-preview\.workers\.dev/)
  assert.match(summary, />> "\$GITHUB_STEP_SUMMARY"/)
  assert.doesNotMatch(summary, /\$\{\{/, 'the summary must not interpolate expressions into the shell')
})
