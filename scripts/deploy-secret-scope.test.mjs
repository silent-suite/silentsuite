// Production deploy credentials must be readable only from jobs bound to a
// main-only production environment, and preview jobs must use their own
// preview credentials (silent-suite/silentsuite-internal#1035).
//
// A job without `environment:` reads repository-level secrets, and any branch
// push can run such a job, so the production SSH key and Cloudflare token are
// meant to exist only as environment secrets. This test keeps every workflow
// referencing them inside those environments; the environments' branch
// policies and secret placement are GitHub settings and are not visible here.
//
// Bounded structural check like preview-notification-policy.test.mjs: the
// root has no YAML parser, so jobs are split on the fixed two-space indent.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

const workflowsDir = new URL('../.github/workflows/', import.meta.url)
const read = name => readFileSync(new URL(name, workflowsDir), 'utf8')
const workflowNames = () => readdirSync(workflowsDir).filter(name => /\.ya?ml$/.test(name)).sort()

const PRODUCTION_SECRETS = ['VPS_HOST', 'VPS_USER', 'VPS_SSH_KEY', 'VPS_SSH_FINGERPRINT', 'CLOUDFLARE_API_TOKEN']
const PRODUCTION_ENVIRONMENTS = ['web-production', 'server-production', 'docs-production']
// Each preview secret is allowed in exactly one job, bound to its own environment.
const PREVIEW_SECRETS = {
  PREVIEW_VPS_HOST: 'preview-web.yml#publish-and-deploy-preview@web-preview',
  PREVIEW_VPS_USER: 'preview-web.yml#publish-and-deploy-preview@web-preview',
  PREVIEW_VPS_SSH_KEY: 'preview-web.yml#publish-and-deploy-preview@web-preview',
  PREVIEW_CLOUDFLARE_API_TOKEN: 'preview-docs.yml#deploy-preview@docs-preview',
}
// Reusable-workflow callers may map production secrets through; the callee's
// own jobs bind the production environment, whose secrets take precedence.
const REUSABLE_CALLEES = new Set(['./.github/workflows/deploy-web.yml', './.github/workflows/deploy-docs.yml'])

function split(text) {
  const marker = text.indexOf('\njobs:\n')
  assert.ok(marker >= 0, 'workflow must declare jobs')
  const header = text.slice(0, marker + 1)
  const body = text.slice(marker + '\njobs:\n'.length)
  const heads = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):\n/gm)]
  // Fail closed: every two-space line must be a plain job ID this splitter
  // understands, so a quoted or flow-style job cannot hide from the scan.
  const unsupported = body.split('\n').filter(line => /^ {2}\S/.test(line) && !/^ {2}#/.test(line) && !/^ {2}[A-Za-z0-9_-]+:$/.test(line))
  assert.deepEqual(unsupported, [], 'jobs must use plain unquoted IDs on their own line')
  const indents = body.split('\n').filter(line => line.trim() && !line.trim().startsWith('#')).map(line => line.match(/^ */)[0].length)
  assert.equal(Math.min(...indents), 2, 'jobs must be indented by exactly two spaces')
  const jobs = new Map(heads.map((head, i) => [
    head[1],
    body.slice(head.index + head[0].length, i + 1 < heads.length ? heads[i + 1].index : body.length),
  ]))
  return { header, jobs }
}

// Expression contexts, property names and functions are case-insensitive.
const referenced = (text, names) => names.filter(name =>
  new RegExp(`secrets\\s*(?:\\.\\s*${name}\\b|\\[\\s*['"]${name}['"]\\s*\\])`, 'i').test(text))

function environment(job) {
  const lines = [...job.matchAll(/^ {4}environment:(.*)$/gm)]
  if (lines.length === 0) return null
  assert.equal(lines.length, 1, 'a job declares at most one environment')
  const match = lines[0][1].match(/^ ("?)([a-z0-9-]+)\1$/)
  assert.ok(match, `environment must be a plain name, got "${lines[0][1].trim()}"`)
  return match[2]
}

const reusableCallee = job => job.match(/^ {4}uses: (\S+)$/m)?.[1] ?? null

test('no workflow hands over the whole secrets context', () => {
  for (const name of workflowNames()) {
    const text = read(name)
    assert.doesNotMatch(text, /secrets:\s*inherit|tojson\(\s*secrets\s*\)/i, `${name} must map secrets by name`)
    assert.doesNotMatch(text, /secrets\s*\[\s*[^'"\s]/i, `${name} must not index secrets dynamically`)
  }
})

test('production deploy secrets are read only inside main-only production environments', () => {
  const offenders = []
  for (const name of workflowNames()) {
    const { header, jobs } = split(read(name))
    for (const secret of referenced(header, PRODUCTION_SECRETS)) offenders.push(`${name}#workflow-level ${secret}`)
    for (const [jobName, job] of jobs) {
      const secrets = referenced(job, PRODUCTION_SECRETS)
      if (secrets.length === 0) continue
      const env = environment(job)
      if (env !== null && PRODUCTION_ENVIRONMENTS.includes(env)) continue
      if (env === null && REUSABLE_CALLEES.has(reusableCallee(job))) continue
      offenders.push(`${name}#${jobName}@${env ?? 'no environment'}: ${secrets.join(', ')}`)
    }
  }
  assert.deepEqual(offenders, [])
})

test('reusable production callees bind every secret-reading job to a production environment', () => {
  for (const callee of REUSABLE_CALLEES) {
    const { jobs } = split(read(callee.replace('./.github/workflows/', '')))
    for (const [jobName, job] of jobs) {
      if (referenced(job, PRODUCTION_SECRETS).length === 0) continue
      assert.ok(PRODUCTION_ENVIRONMENTS.includes(environment(job)), `${callee}#${jobName} must bind a production environment`)
    }
  }
})

test('each preview secret is read only by its preview job inside its preview environment', () => {
  const seen = {}
  for (const name of workflowNames()) {
    const { header, jobs } = split(read(name))
    assert.deepEqual(referenced(header, Object.keys(PREVIEW_SECRETS)), [], `${name} must not read preview secrets at workflow level`)
    for (const [jobName, job] of jobs) {
      for (const secret of referenced(job, Object.keys(PREVIEW_SECRETS))) {
        (seen[secret] ??= []).push(`${name}#${jobName}@${environment(job) ?? 'no environment'}`)
      }
    }
  }
  for (const [secret, place] of Object.entries(PREVIEW_SECRETS)) assert.deepEqual(seen[secret], [place], secret)
})

test('the preview jobs read no production deploy secret', () => {
  for (const [name, jobName] of [['preview-web.yml', 'publish-and-deploy-preview'], ['preview-docs.yml', 'deploy-preview']]) {
    const job = split(read(name)).jobs.get(jobName)
    assert.ok(job, `${name} must keep ${jobName}`)
    assert.deepEqual(referenced(job, PRODUCTION_SECRETS), [], `${name}#${jobName}`)
  }
})

test('the job splitter refuses job IDs it cannot scan', () => {
  const unprotected = 'on: push\njobs:\n  JOB:\n    runs-on: ubuntu-latest\n    env:\n      K: ${{ secrets.VPS_SSH_KEY }}\n'
  assert.ok(referenced(split(unprotected.replace('JOB', 'plain')).jobs.get('plain'), PRODUCTION_SECRETS).length === 1)
  for (const id of ['"quoted"', "'single'", 'flow: { runs-on: x }', 'odd id']) {
    assert.throws(() => split(unprotected.replace('JOB:', id.includes(':') ? id : `${id}:`)), /plain unquoted IDs/, id)
  }
  assert.throws(() => split(unprotected.replace(/^ {2}/gm, '    ').replace('JOB', 'deep')), /exactly two spaces/)
})

test('the scanner sees both dot and index secret syntax', () => {
  assert.deepEqual(referenced("a: ${{ secrets.VPS_SSH_KEY }}", PRODUCTION_SECRETS), ['VPS_SSH_KEY'])
  assert.deepEqual(referenced("a: ${{ secrets['CLOUDFLARE_API_TOKEN'] }}", PRODUCTION_SECRETS), ['CLOUDFLARE_API_TOKEN'])
  assert.deepEqual(referenced("a: ${{ secrets.PREVIEW_VPS_SSH_KEY }}", PRODUCTION_SECRETS), [])
  assert.deepEqual(referenced("a: ${{ secrets.VPS_HOSTNAME }}", PRODUCTION_SECRETS), [])
  assert.deepEqual(referenced("a: ${{ SECRETS.vps_ssh_key }}", PRODUCTION_SECRETS), ['VPS_SSH_KEY'])
})
