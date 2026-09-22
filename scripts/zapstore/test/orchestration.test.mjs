// Wired control paths through the real CLI: revision binding on a temporary
// git repository, per-candidate evidence, the publication plan, and failure
// notification end to end against a local fake GitHub API. No network, no
// signer, no secret.

import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { buildPlan, collectFailures, recordResult } from '../lib/results.mjs'
import { eventId } from '../lib/nostr.mjs'

const here = resolve(new URL('.', import.meta.url).pathname)
const cli = join(here, '..', 'cli.mjs')
const SHA = '3111352dbccfaaeee3b83ad325906e591343cfa3'
const WORKFLOW_REF = 'silent-suite/silentsuite/.github/workflows/zapstore-publish.yml@refs/heads/main'

function run(command, extraArgs = [], env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zapstore-cli-'))
  const out = join(dir, 'out'); const sum = join(dir, 'summary')
  writeFileSync(out, ''); writeFileSync(sum, '')
  const result = spawnSync(process.execPath, [cli, command, ...extraArgs], { env: { PATH: process.env.PATH, HOME: dir, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum, ...env }, encoding: 'utf8' })
  return { ...result, outputs: readFileSync(out, 'utf8'), summary: readFileSync(sum, 'utf8') }
}

// The fake GitHub API lives in this process, so commands that talk to it must
// not block the event loop: spawn asynchronously and await exit.
function runAsync(command, extraArgs = [], env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zapstore-cli-'))
  const out = join(dir, 'out'); const sum = join(dir, 'summary')
  writeFileSync(out, ''); writeFileSync(sum, '')
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cli, command, ...extraArgs], { env: { PATH: process.env.PATH, HOME: dir, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum, ...env } })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('close', (status) => resolvePromise({ status, stdout, stderr, outputs: readFileSync(out, 'utf8'), summary: readFileSync(sum, 'utf8') }))
  })
}

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'zapstore-repo-'))
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example' } })
  git('init', '-q')
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  git('add', 'a.txt')
  git('commit', '-q', '-m', 'one')
  return { dir, head: git('rev-parse', 'HEAD').trim() }
}

test('cli admit: only a protected-main schedule with workflow_sha == sha is admitted; release and dispatch events are refused', () => {
  const { dir, head } = tempRepo()
  const base = { GITHUB_EVENT_NAME: 'schedule', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'silent-suite/silentsuite', GITHUB_WORKFLOW_REF: WORKFLOW_REF, GITHUB_SHA: head, GITHUB_WORKFLOW_SHA: head }
  const disabled = run('admit', ['--workspace', dir], base)
  assert.equal(disabled.status, 0, disabled.stderr)
  assert.match(disabled.outputs, /active=false/)
  assert.match(disabled.outputs, new RegExp(`revision=${head}`))
  assert.match(disabled.summary, /DISABLED/)
  const enabled = run('admit', ['--workspace', dir], { ...base, ZAPSTORE_AUTOMATION_ENABLED: 'enabled' })
  assert.equal(enabled.status, 0, enabled.stderr)
  assert.match(enabled.outputs, /active=true/)
  const release = run('admit', ['--workspace', dir], { ...base, GITHUB_EVENT_NAME: 'release', GITHUB_REF: 'refs/tags/v0.5.6-beta', GITHUB_WORKFLOW_REF: WORKFLOW_REF.replace('refs/heads/main', 'refs/tags/v0.5.6-beta'), ZAPSTORE_AUTOMATION_ENABLED: 'enabled' })
  assert.notEqual(release.status, 0)
  assert.match(release.stderr, /unsupported event release/)
  for (const event of ['repository_dispatch', 'workflow_dispatch', 'push']) assert.notEqual(run('admit', [], { ...base, GITHUB_EVENT_NAME: event }).status, 0, event)
  assert.notEqual(run('admit', [], { ...base, GITHUB_REF: 'refs/heads/feat' }).status, 0)
  assert.notEqual(run('admit', [], { ...base, GITHUB_WORKFLOW_REF: WORKFLOW_REF.replace('refs/heads/main', 'refs/heads/feat') }).status, 0)
  const drift = run('admit', [], { ...base, GITHUB_WORKFLOW_SHA: 'a'.repeat(40) })
  assert.notEqual(drift.status, 0)
  assert.match(drift.stderr, /GITHUB_WORKFLOW_SHA .* is not the run commit/)
  const wrongCheckout = run('admit', ['--workspace', dir], { ...base, GITHUB_SHA: 'b'.repeat(40), GITHUB_WORKFLOW_SHA: 'b'.repeat(40) })
  assert.notEqual(wrongCheckout.status, 0)
  assert.match(wrongCheckout.stderr, /not the admitted protected revision/)
})

test('cli checkout-guard binds a job to the admitted revision', () => {
  const { dir, head } = tempRepo()
  assert.equal(run('checkout-guard', ['--workspace', dir, '--revision', head]).status, 0)
  const wrong = run('checkout-guard', ['--workspace', dir, '--revision', 'c'.repeat(40)])
  assert.notEqual(wrong.status, 0)
  assert.match(wrong.stderr, /not the admitted protected revision/)
  assert.notEqual(run('checkout-guard', ['--workspace', dir, '--revision', 'main']).status, 0)
})

test('cli drift accepts regenerated event identities but rejects changed publication inputs and broken links', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zapstore-drift-'))
  const assessment = join(dir, 'assessment')
  mkdirSync(join(assessment, 'prepare'), { recursive: true })
  const events = readFileSync(join(here, 'fixtures/zsp-unsigned-offline-v0.5.6-beta.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  const regenerated = structuredClone(events)
  for (const event of regenerated) event.created_at += 120
  const apk = regenerated.find((e) => e.kind === 3063)
  apk.id = eventId(apk)
  regenerated.find((e) => e.kind === 30063).tags.find((t) => t[0] === 'e')[1] = apk.id
  for (const event of regenerated) event.id = eventId(event)
  const write = (path, value) => writeFileSync(path, JSON.stringify(value))
  const writeEvents = (path, value) => writeFileSync(path, value.map((e) => JSON.stringify(e)).join('\n') + '\n')
  const bound = { releaseId: 2, tag: 'v0.5.6-beta', version: '0.5.6-beta', channel: 'main', sourceSha: SHA, assets: { apk: { id: 3, name: 'app.apk', size: 123, sha256: 'a'.repeat(64) } } }
  write(join(assessment, 'binding.json'), bound)
  write(join(dir, 'binding.json'), bound)
  write(join(assessment, 'reconcile.json'), { action: 'publish' })
  write(join(dir, 'reconcile.json'), { action: 'publish' })
  write(join(assessment, 'prepare/release-manifest.json'), { protectedRevision: SHA })
  writeEvents(join(assessment, 'prepare/expected-events.jsonl'), events)
  const invoke = (candidate) => {
    writeEvents(join(dir, 'expected.jsonl'), candidate)
    return run('drift', ['--assessment-dir', assessment, '--binding', join(dir, 'binding.json'), '--expected', join(dir, 'expected.jsonl'), '--reconcile', join(dir, 'reconcile.json'), '--revision', SHA])
  }
  const ok = invoke(regenerated)
  assert.equal(ok.status, 0, ok.stderr)
  for (const mutate of [
    (es) => { es.find((e) => e.kind === 30063).content += 'changed' },
    (es) => { es.find((e) => e.kind === 3063).tags.find((t) => t[0] === 'x')[1] = 'b'.repeat(64) },
    (es) => { es.find((e) => e.kind === 30063).tags.find((t) => t[0] === 'e')[2] = 'wss://other.example' },
    (es) => { es.find((e) => e.kind === 30063).tags.find((t) => t[0] === 'e')[1] = 'c'.repeat(64) },
    (es) => { es.find((e) => e.kind === 30063).tags.push(['e', apk.id, 'wss://relay.zapstore.dev']) },
  ]) {
    const changed = structuredClone(regenerated)
    mutate(changed)
    for (const event of changed) event.id = eventId(event)
    assert.notEqual(invoke(changed).status, 0, 'changed input must remain blocked')
  }
  // Synthetic credential-shaped text must be redacted in both output channels.
  write(join(dir, 'reconcile.json'), { action: 'publish', reason: 'bunker://synthetic-review-fixture?secret=not-a-real-secret' })
  const redacted = invoke(regenerated)
  assert.equal(redacted.status, 0, redacted.stderr)
  assert.doesNotMatch(redacted.stdout, /not-a-real-secret/)
  assert.doesNotMatch(redacted.summary, /not-a-real-secret/)
})

const reconcileSkip = { outcome: 'legacy-complete', action: 'skip', reason: 'legacy-complete', verifyCdn: true, detail: 'pre-lane publication verified', present: { apk: 'a'.repeat(64) } }
const reconcilePublish = { outcome: 'absent', action: 'publish', reason: 'absent', verifyCdn: false, detail: 'no events for this package' }
const binding = (id, tag) => ({ releaseId: id, tag, sourceSha: SHA })

test('record-result derives the true status and failed phase for assess and publish jobs', () => {
  const ok = recordResult({ job: 'assess', phases: { checkout: 'success', bind: 'success', apk: 'success', apksigner: 'success', prepare: 'success', reconcile: 'success', cdn: 'success' }, binding: binding(1, 'v0.5.4-beta'), reconcile: reconcileSkip, cdn: { status: 'success', detail: 'ok' } })
  assert.equal(ok.status, 'success')
  assert.equal(ok.failedPhase, null)
  assert.equal(ok.publication, 'not-attempted')
  const cdnFailed = recordResult({ job: 'assess', phases: { ...ok.phases, cdn: 'failure' }, binding: binding(1, 'v0.5.4-beta'), reconcile: reconcileSkip, cdn: { status: 'failure', detail: 'CDN bytes hash to x' } })
  assert.equal(cdnFailed.status, 'failure')
  assert.equal(cdnFailed.failedPhase, 'cdn')
  assert.match(cdnFailed.detail, /CDN bytes hash/)
  const cdnMissing = recordResult({ job: 'assess', phases: { ...ok.phases, cdn: 'skipped' }, binding: binding(1, 'v0.5.4-beta'), reconcile: reconcileSkip, cdn: null })
  assert.equal(cdnMissing.failedPhase, 'cdn', 'a complete relay set without CDN evidence is a failure')
  const bindFailed = recordResult({ job: 'assess', phases: { checkout: 'success', bind: 'failure', apk: 'skipped', apksigner: 'skipped', prepare: 'skipped', reconcile: 'skipped', cdn: 'skipped' }, fallback: { releaseId: '7', tag: 'v0.5.7' } })
  assert.equal(bindFailed.failedPhase, 'bind')
  assert.equal(bindFailed.releaseId, '7')
  const reconcileFail = recordResult({ job: 'assess', phases: { ...ok.phases, reconcile: 'failure', cdn: 'skipped' }, binding: binding(1, 'v0.5.6-beta'), reconcile: { outcome: 'partial', action: 'fail', reason: 'partial', verifyCdn: false, detail: 'present: apk x; missing: release' } })
  assert.equal(reconcileFail.failedPhase, 'reconcile')
  assert.match(reconcileFail.detail, /missing: release/)

  const publishPhases = { checkout: 'success', bind: 'success', apk: 'success', apksigner: 'success', prepare: 'success', reconcile: 'success', drift: 'success', revalidate: 'success', sign: 'success', readback: 'success', cdn: 'success' }
  const published = recordResult({ job: 'publish', phases: publishPhases, binding: binding(2, 'v0.5.6-beta'), reconcile: reconcilePublish, readback: { outcome: 'complete-match', detail: 'ok' }, cdn: { status: 'success' }, signExit: 0 })
  assert.equal(published.status, 'success')
  assert.equal(published.publication, 'published')
  const signFailed = recordResult({ job: 'publish', phases: { ...publishPhases, sign: 'failure', readback: 'failure', cdn: 'skipped' }, binding: binding(2, 'v0.5.6-beta'), reconcile: reconcilePublish, readback: { outcome: 'incomplete', detail: 'no EOSE' }, signExit: 1 })
  assert.equal(signFailed.status, 'failure')
  assert.equal(signFailed.failedPhase, 'sign')
  assert.equal(signFailed.publication, 'unknown')
  const readbackPartial = recordResult({ job: 'publish', phases: { ...publishPhases, readback: 'failure', cdn: 'skipped' }, binding: binding(2, 'v0.5.6-beta'), reconcile: reconcilePublish, readback: { outcome: 'partial', detail: 'present: apk' }, signExit: 0 })
  assert.equal(readbackPartial.failedPhase, 'readback')
  assert.equal(readbackPartial.publication, 'partial')
  const alreadyDone = recordResult({ job: 'publish', phases: { ...publishPhases, revalidate: 'skipped', sign: 'skipped', readback: 'skipped' }, binding: binding(2, 'v0.5.6-beta'), reconcile: { ...reconcileSkip, outcome: 'complete-match', reason: 'complete-match' }, cdn: { status: 'success' } })
  assert.equal(alreadyDone.status, 'success', 'a set published between assessment and approval is verified, not re-signed')
  assert.equal(alreadyDone.publication, 'already-published')
  const alreadyDoneCdnFailed = recordResult({ job: 'publish', phases: { ...publishPhases, revalidate: 'skipped', sign: 'skipped', readback: 'skipped', cdn: 'failure' }, binding: binding(2, 'v0.5.6-beta'), reconcile: { ...reconcileSkip, outcome: 'complete-match' }, cdn: { status: 'failure', detail: 'CDN 404' } })
  assert.equal(alreadyDoneCdnFailed.failedPhase, 'cdn')
  const cdnAfterPublish = recordResult({ job: 'publish', phases: { ...publishPhases, cdn: 'failure' }, binding: binding(2, 'v0.5.6-beta'), reconcile: reconcilePublish, readback: { outcome: 'complete-match', detail: 'ok' }, cdn: { status: 'failure', detail: 'CDN bytes differ' }, signExit: 0 })
  assert.equal(cdnAfterPublish.failedPhase, 'cdn')
  assert.equal(cdnAfterPublish.publication, 'published')
  assert.match(cdnAfterPublish.detail, /CDN bytes differ/)
  assert.throws(() => recordResult({ job: 'other' }), /unknown job/)
})

const candidates = [{ releaseId: 1, tag: 'v0.5.4-beta', publishable: false }, { releaseId: 2, tag: 'v0.5.6-beta', publishable: true }]
const assessA = () => recordResult({ job: 'assess', phases: { checkout: 'success', bind: 'success', apk: 'success', apksigner: 'success', prepare: 'success', reconcile: 'success', cdn: 'success' }, binding: binding(1, 'v0.5.4-beta'), reconcile: reconcileSkip, cdn: { status: 'success' } })
const assessB = () => recordResult({ job: 'assess', phases: { checkout: 'success', bind: 'success', apk: 'success', apksigner: 'success', prepare: 'success', reconcile: 'success', cdn: 'skipped' }, binding: binding(2, 'v0.5.6-beta'), reconcile: reconcilePublish })

test('superseded publication skips signing without reporting a sign failure', () => {
  const result = recordResult({ job: 'publish', phases: { checkout: 'success', bind: 'success', apk: 'success', apksigner: 'success', prepare: 'success', reconcile: 'success', drift: 'success', revalidate: 'skipped', sign: 'skipped', readback: 'skipped', cdn: 'skipped' }, reconcile: { outcome: 'superseded', action: 'skip', reason: 'superseded', verifyCdn: false } })
  assert.equal(result.status, 'success')
  assert.equal(result.failedPhase, null)
  assert.equal(result.publishAttempted, false)
  assert.equal(result.publication, 'not-attempted')
  const failed = recordResult({ job: 'publish', phases: { ...result.phases, drift: 'failure' }, reconcile: { outcome: 'superseded', action: 'skip', reason: 'superseded', verifyCdn: false } })
  assert.equal(failed.failedPhase, 'drift')
})

test('plan admits only assessed candidates whose action is publish and lists missing evidence', () => {
  const plan = buildPlan({ candidates, assessments: [assessA(), assessB()] })
  assert.deepEqual(plan.publish, [{ release_id: '2', tag: 'v0.5.6-beta' }])
  assert.equal(plan.count, 1)
  assert.deepEqual(plan.missing, [])
  const partial = buildPlan({ candidates, assessments: [assessA()] })
  assert.equal(partial.count, 0)
  assert.deepEqual(partial.missing, [{ releaseId: 2, tag: 'v0.5.6-beta' }])
  const failed = buildPlan({ candidates, assessments: [assessA(), { ...assessB(), status: 'failure', failedPhase: 'prepare' }] })
  assert.equal(failed.count, 0, 'a failed assessment never reaches the environment-bound job')
})

test('partial recovery is wired: a recoverable assessment reaches the environment-bound plan; an unrecoverable one never does and is reported with the preserved ids', () => {
  const phasesOk = { checkout: 'success', bind: 'success', apk: 'success', apksigner: 'success', prepare: 'success', reconcile: 'success', cdn: 'skipped' }
  const recoverable = recordResult({ job: 'assess', phases: phasesOk, binding: binding(2, 'v0.5.6-beta'), reconcile: { outcome: 'partial', recoverable: true, action: 'publish', reason: 'partial-recovery', verifyCdn: false, detail: 'present: release r1; missing: apk', present: { release: 'r1' } } })
  assert.equal(recoverable.status, 'success')
  assert.equal(recoverable.publication, 'not-attempted')
  const plan = buildPlan({ candidates, assessments: [assessA(), recoverable] })
  assert.deepEqual(plan.publish, [{ release_id: '2', tag: 'v0.5.6-beta' }])
  const recovered = recordResult({ job: 'publish', phases: { checkout: 'success', bind: 'success', apk: 'success', apksigner: 'success', prepare: 'success', reconcile: 'success', drift: 'success', revalidate: 'success', sign: 'success', readback: 'success', cdn: 'success' }, binding: binding(2, 'v0.5.6-beta'), reconcile: { outcome: 'partial', action: 'publish', reason: 'partial-recovery', verifyCdn: false, detail: 'present: release r1; missing: apk' }, readback: { outcome: 'complete-match', detail: 'ok' }, cdn: { status: 'success' }, signExit: 0 })
  assert.equal(recovered.status, 'success')
  assert.equal(recovered.publication, 'published')
  assert.deepEqual(collectFailures({ candidates, plan, assessments: [assessA(), recoverable], results: [recovered], jobs: { enumerate: 'success', assess: 'success', plan: 'success', publish: 'success' } }), [])
  const stillPartial = recordResult({ job: 'publish', phases: { checkout: 'success', bind: 'success', apk: 'success', apksigner: 'success', prepare: 'success', reconcile: 'success', drift: 'success', revalidate: 'success', sign: 'success', readback: 'failure', cdn: 'skipped' }, binding: binding(2, 'v0.5.6-beta'), reconcile: { outcome: 'partial', action: 'publish', reason: 'partial-recovery', verifyCdn: false, detail: 'x' }, readback: { outcome: 'partial', detail: 'present: apk a1; missing: release' }, signExit: 0 })
  assert.equal(stillPartial.failedPhase, 'readback', 'a recovery that does not read back as an exact match is a failure, never a success')
  assert.equal(stillPartial.publication, 'partial')

  const unrecoverable = recordResult({ job: 'assess', phases: { ...phasesOk, reconcile: 'failure' }, binding: binding(2, 'v0.5.6-beta'), reconcile: { outcome: 'partial', recoverable: false, action: 'fail', reason: 'partial-unrecoverable', verifyCdn: false, detail: `present: apk ${'a'.repeat(64)}; missing: release; the accepted APK event cannot be reused by the official publisher`, present: { apk: 'a'.repeat(64) } } })
  assert.equal(unrecoverable.status, 'failure')
  assert.equal(unrecoverable.failedPhase, 'reconcile')
  const refusedPlan = buildPlan({ candidates, assessments: [assessA(), unrecoverable] })
  assert.equal(refusedPlan.count, 0, 'an accepted APK event is never regenerated')
  const failures = collectFailures({ candidates, plan: refusedPlan, assessments: [assessA(), unrecoverable], results: [], jobs: { enumerate: 'success', assess: 'failure', plan: 'success', publish: 'skipped' } })
  assert.equal(failures.length, 1)
  assert.equal(failures[0].outcome, 'partial')
  assert.match(failures[0].detail, new RegExp('a'.repeat(64)))
  assert.equal(failures[0].publication, 'not-attempted')
})

test('collectFailures reports failures and missing evidence only, never successful siblings', () => {
  const jobs = { enumerate: 'success', assess: 'success', plan: 'success', publish: 'success' }
  const plan = buildPlan({ candidates, assessments: [assessA(), assessB()] })
  const publishedB = recordResult({ job: 'publish', phases: { checkout: 'success', bind: 'success', apk: 'success', apksigner: 'success', prepare: 'success', reconcile: 'success', drift: 'success', revalidate: 'success', sign: 'success', readback: 'success', cdn: 'success' }, binding: binding(2, 'v0.5.6-beta'), reconcile: reconcilePublish, readback: { outcome: 'complete-match', detail: 'ok' }, cdn: { status: 'success' }, signExit: 0 })
  assert.deepEqual(collectFailures({ candidates, plan, assessments: [assessA(), assessB()], results: [publishedB], jobs }), [])
  const cdnFailedA = { ...assessA(), status: 'failure', failedPhase: 'cdn', detail: 'CDN bytes hash to x' }
  const failures = collectFailures({ candidates, plan, assessments: [cdnFailedA, assessB()], results: [publishedB], jobs: { ...jobs, assess: 'failure' } })
  assert.equal(failures.length, 1)
  assert.equal(failures[0].releaseId, 1)
  assert.equal(failures[0].phase, 'cdn')
  assert.equal(failures[0].publication, 'not-attempted')
  const missing = collectFailures({ candidates, plan, assessments: [assessA(), assessB()], results: [], jobs: { ...jobs, publish: 'cancelled' } })
  assert.equal(missing.length, 1)
  assert.equal(missing[0].outcome, 'evidence-missing')
  assert.equal(missing[0].publication, 'unknown')
  assert.match(missing[0].detail, /publish job result: cancelled/)
  const noAssessment = collectFailures({ candidates, plan: null, assessments: [assessA()], results: [], jobs: { ...jobs, assess: 'cancelled' } })
  assert.equal(noAssessment.length, 1)
  assert.equal(noAssessment[0].releaseId, 2)
  const enumerateFailed = collectFailures({ candidates: [], plan: null, assessments: [], results: [], jobs: { enumerate: 'failure' } })
  assert.equal(enumerateFailed.length, 1)
  assert.equal(enumerateFailed[0].phase, 'enumerate')
})

test('fetch-apk verifies the Android sidecar and GitHub digest without relying on the Bridge manifest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zapstore-checksums-'))
  const bytes = Buffer.from('synthetic APK bytes for checksum transport regression')
  const sha = createHash('sha256').update(bytes).digest('hex')
  const name = 'silentsuite-android-v0.5.9-beta.apk'
  const bindingPath = join(dir, 'binding.json')
  writeFileSync(bindingPath, JSON.stringify({ assets: { apk: { id: 1, name, sha256: sha, size: bytes.length }, sidecar: { id: 2, name: 'silentsuite-android-v0.5.9-beta-installer.sha256' }, sums: { id: 3, name: 'SHA256SUMS.txt' } } }))
  let sidecar = `${sha}  ${name}\n`
  let apk = bytes
  const requests = []
  const server = createServer((request, response) => {
    requests.push(request.url)
    const id = request.url.split('/').at(-1)
    if (id === '1') response.end(apk)
    else if (id === '2') response.end(sidecar)
    else if (id === '3') response.end(`${'b'.repeat(64)}  silentsuite-bridge-linux-arm64\n`)
    else { response.writeHead(404); response.end() }
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const invoke = () => runAsync('fetch-apk', ['--binding', bindingPath, '--out-dir', join(dir, 'apk')], { GITHUB_API_URL: `http://127.0.0.1:${server.address().port}` })
  try {
    const ok = await invoke()
    assert.equal(ok.status, 0, ok.stderr)
    assert.ok(!requests.some((url) => url.endsWith('/3')), 'Bridge manifest is not Android authority')
    assert.deepEqual(readFileSync(join(dir, 'apk', name)), bytes)
    for (const invalid of [`${'c'.repeat(64)}  ${name}\n`, `${sha}  other.apk\n`, `${sha}\n`, `${sidecar}${sidecar}`, `${sidecar}malformed checksum\n`]) {
      sidecar = invalid
      const refused = await invoke()
      assert.notEqual(refused.status, 0, 'invalid or mismatched sidecar must fail')
      assert.equal(refused.outputs, '', 'failed verification must not emit an APK path')
    }
    sidecar = `${sha}  ${name}\n`
    apk = Buffer.from('corrupted artifact')
    const corrupted = await invoke()
    assert.notEqual(corrupted.status, 0)
    assert.match(corrupted.stderr, /local bytes/)
  } finally { await new Promise((resolvePromise) => server.close(resolvePromise)) }
})

function fakeGitHub() {
  const issues = []
  const requests = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, body })
      const reply = (status, json) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(json)) }
      if (request.method === 'GET' && request.url.startsWith('/repos/silent-suite/silentsuite/issues?')) return reply(200, issues.filter((i) => i.state === 'open'))
      if (request.method === 'POST' && request.url === '/repos/silent-suite/silentsuite/issues') {
        const issue = { ...JSON.parse(body), number: issues.length + 1, state: 'open', html_url: `https://github.com/silent-suite/silentsuite/issues/${issues.length + 1}` }
        issues.push(issue)
        return reply(201, { number: issue.number })
      }
      const match = /^\/repos\/silent-suite\/silentsuite\/issues\/(\d+)$/.exec(request.url)
      if (request.method === 'GET' && match) return reply(200, issues[Number(match[1]) - 1] ?? {})
      reply(404, {})
    })
  })
  return new Promise((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise({ server, issues, requests, apiBase: `http://127.0.0.1:${server.address().port}` })))
}

function evidenceDir({ assessments = [], results = [], plan = null }) {
  const dir = mkdtempSync(join(tmpdir(), 'zapstore-evidence-'))
  mkdirSync(join(dir, 'zapstore-candidates'))
  writeFileSync(join(dir, 'zapstore-candidates', 'candidates.json'), JSON.stringify({ candidates, omitted: [] }))
  for (const a of assessments) { mkdirSync(join(dir, `zapstore-assessment-${a.releaseId}`)); writeFileSync(join(dir, `zapstore-assessment-${a.releaseId}`, 'assessment.json'), JSON.stringify(a)) }
  for (const r of results) { mkdirSync(join(dir, `zapstore-result-${r.releaseId}`)); writeFileSync(join(dir, `zapstore-result-${r.releaseId}`, 'result.json'), JSON.stringify(r)) }
  if (plan) { mkdirSync(join(dir, 'zapstore-plan')); writeFileSync(join(dir, 'zapstore-plan', 'plan.json'), JSON.stringify(plan)) }
  return dir
}

const notifyArgs = (dir) => ['--candidates', join(dir, 'zapstore-candidates', 'candidates.json'), '--plan', join(dir, 'zapstore-plan', 'plan.json'), '--assessments-dir', dir, '--results-dir', dir]
const runUrl = 'https://github.com/silent-suite/silentsuite/actions/runs/1/attempts/1'

test('cli plan and notify: successful siblings are silent; CDN failure on an already-complete candidate, missing evidence and dedupe are wired end to end', async () => {
  const gh = await fakeGitHub()
  try {
    const okDir = evidenceDir({ assessments: [assessA(), assessB()] })
    const plan = run('plan', ['--candidates', join(okDir, 'zapstore-candidates', 'candidates.json'), '--assessments-dir', okDir, '--out', join(okDir, 'plan.json')])
    assert.equal(plan.status, 0, plan.stderr)
    assert.match(plan.outputs, /count=1/)
    assert.match(plan.outputs, /"release_id":"2","tag":"v0.5.6-beta"/)
    const planJson = JSON.parse(readFileSync(join(okDir, 'plan.json'), 'utf8'))

    const publishedB = recordResult({ job: 'publish', phases: { checkout: 'success', bind: 'success', apk: 'success', apksigner: 'success', prepare: 'success', reconcile: 'success', drift: 'success', revalidate: 'success', sign: 'success', readback: 'success', cdn: 'success' }, binding: binding(2, 'v0.5.6-beta'), reconcile: reconcilePublish, readback: { outcome: 'complete-match', detail: 'ok' }, cdn: { status: 'success' }, signExit: 0 })
    const env = { GITHUB_API_URL: gh.apiBase, GITHUB_TOKEN: 't', RUN_URL: runUrl, JOB_ENUMERATE: 'success', JOB_ASSESS: 'success', JOB_PLAN: 'success', JOB_PUBLISH: 'success' }
    const quiet = await runAsync('notify', notifyArgs(evidenceDir({ assessments: [assessA(), assessB()], results: [publishedB], plan: planJson })), env)
    assert.equal(quiet.status, 0, quiet.stderr)
    assert.match(quiet.summary, /No failure issue required/)
    assert.equal(gh.issues.length, 0)

    const cdnFailedA = { ...assessA(), status: 'failure', failedPhase: 'cdn', detail: 'CDN bytes at https://cdn.zapstore.dev/x hash to y' }
    const one = await runAsync('notify', notifyArgs(evidenceDir({ assessments: [cdnFailedA, assessB()], results: [publishedB], plan: planJson })), { ...env, JOB_ASSESS: 'failure' })
    assert.equal(one.status, 0, one.stderr)
    assert.equal(gh.issues.length, 1)
    assert.equal(gh.issues[0].title, 'Zapstore publication failed: v0.5.4-beta (release 1)')
    assert.match(gh.issues[0].body, /Phase: cdn/)
    assert.match(gh.issues[0].body, /No signer\/upload attempt ran/)
    assert.match(gh.issues[0].body, /Re-run failed jobs/)
    assert.doesNotMatch(gh.issues[0].body, /PATCH|v0\.5\.6-beta/, 'the successful sibling is not mentioned and no tag edit is suggested')

    const again = await runAsync('notify', notifyArgs(evidenceDir({ assessments: [cdnFailedA, assessB()], results: [publishedB], plan: planJson })), { ...env, JOB_ASSESS: 'failure' })
    assert.equal(again.status, 0, again.stderr)
    assert.match(again.summary, /Reused open issue #1/)
    assert.equal(gh.issues.length, 1, 'an open issue with the same title is reused')

    const missing = await runAsync('notify', notifyArgs(evidenceDir({ assessments: [assessA(), assessB()], results: [], plan: planJson })), { ...env, JOB_PUBLISH: 'cancelled' })
    assert.equal(missing.status, 0, missing.stderr)
    assert.equal(gh.issues.length, 2)
    assert.equal(gh.issues[1].title, 'Zapstore publication failed: v0.5.6-beta (release 2)')
    assert.match(gh.issues[1].body, /Outcome: evidence-missing/)
    assert.match(gh.issues[1].body, /Publication state is unknown/)

    // Unsupported partial state through the real CLI: refused at assessment,
    // never planned, reported with the preserved id and stop guidance.
    const apkId = 'a'.repeat(64)
    const unrecoverable = recordResult({ job: 'assess', phases: { checkout: 'success', bind: 'success', apk: 'success', apksigner: 'success', prepare: 'success', reconcile: 'failure', cdn: 'skipped' }, binding: binding(2, 'v0.5.6-beta'), reconcile: { outcome: 'partial', recoverable: false, action: 'fail', reason: 'partial-unrecoverable', verifyCdn: false, detail: `present: apk ${apkId}; missing: release; the accepted APK event cannot be reused by the official publisher`, present: { apk: apkId } } })
    const refusedDir = evidenceDir({ assessments: [assessA(), unrecoverable] })
    const refusedPlan = run('plan', ['--candidates', join(refusedDir, 'zapstore-candidates', 'candidates.json'), '--assessments-dir', refusedDir, '--out', join(refusedDir, 'plan.json')])
    assert.match(refusedPlan.outputs, /count=0/)
    gh.issues.forEach((issue) => { issue.state = 'closed' })
    const before = gh.issues.length
    const stop = await runAsync('notify', notifyArgs(evidenceDir({ assessments: [assessA(), unrecoverable], plan: JSON.parse(readFileSync(join(refusedDir, 'plan.json'), 'utf8')) })), { ...env, JOB_ASSESS: 'failure', JOB_PUBLISH: 'skipped' })
    assert.equal(stop.status, 0, stop.stderr)
    assert.equal(gh.issues.length, before + 1)
    const stopIssue = gh.issues[before]
    assert.equal(stopIssue.title, 'Zapstore publication failed: v0.5.6-beta (release 2)')
    assert.match(stopIssue.body, /- Decision: partial-unrecoverable/)
    assert.match(stopIssue.body, new RegExp(apkId))
    assert.match(stopIssue.body, /STOP: outcome partial-unrecoverable is not fixed by a re-run/)
    assert.match(stopIssue.body, /No signer\/upload attempt ran/)
    assert.doesNotMatch(stopIssue.body, /### Exact retry/)
    stopIssue.state = 'closed'

    const enumerateDown = await runAsync('notify', ['--candidates', '/nonexistent/candidates.json', '--assessments-dir', '/nonexistent', '--results-dir', '/nonexistent'], { ...env, JOB_ENUMERATE: 'failure', JOB_ASSESS: 'skipped', JOB_PLAN: 'skipped', JOB_PUBLISH: 'skipped' })
    assert.equal(enumerateDown.status, 0, enumerateDown.stderr)
    assert.equal(gh.issues.at(-1).title, 'Zapstore lane failed: enumerate')
  } finally {
    gh.server.close()
  }
})
