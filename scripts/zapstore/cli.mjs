#!/usr/bin/env node
// Orchestrator for the dormant Zapstore lane. Every subcommand reads its inputs
// from files or the run context, writes structured results to files, and prints
// only redacted, structured text. Secrets never reach stdout. The signing
// modules are imported only inside `publish`, so no other job loads them.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, statSync, readdirSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

import { selectScheduleCandidates } from './lib/eligibility.mjs'
import { activationState, requireProtectedSchedule } from './lib/dispatch.mjs'
import { createGitHubClient, hashFromChecksumText } from './lib/github.mjs'
import { buildBinding, revalidateBinding, verifyApkHashes } from './lib/binding.mjs'
import { parseApksignerOutput, requireSignedBy } from './lib/apksigner.mjs'
import { generateConfig, loadTemplate, resolveChangelog, stageMedia } from './lib/metadata.mjs'
import { eventId, KINDS, loadSchnorr, packageFilters, queryRelay, RELAY_URL } from './lib/nostr.mjs'
import { assessRelayState, expectedSet, publicationAction, requireReadbackComplete } from './lib/reconcile.mjs'
import { apkFactsFromEvent, parseEventsJsonl, requireApkIdentity, ZSP, zspArgs, zspEnv } from './lib/zsp.mjs'
import { materializeClientKey } from './lib/bunker-key.mjs'
import { redact, summarizeSignerRun } from './lib/redact.mjs'
import { buildIssue, createIssueWithReadback } from './lib/notify.mjs'
import { verifyReferencedBlobs } from './lib/cdn.mjs'
import { parseSourceBuildMetadata, SOURCE_BUILD_GRADLE } from './lib/source-metadata.mjs'
import { ASSESS_PHASES, buildPlan, collectFailures, PUBLISH_PHASES, recordResult } from './lib/results.mjs'

const here = resolve(new URL('.', import.meta.url).pathname)
const args = process.argv.slice(2)
const command = args.shift()
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback }
const has = (name) => args.includes(`--${name}`)
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const readJsonIfPresent = (path) => (path && existsSafe(path) ? readJson(path) : null)
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const output = (key, value) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`) }
const summary = (text) => { const safe = redact(text); if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, safe + '\n'); console.log(safe) }
const client = () => createGitHubClient({ token: process.env.GITHUB_TOKEN ?? '', apiBase: process.env.GITHUB_API_URL || undefined })
const requireRevision = (value) => { if (!/^[0-9a-f]{40}$/.test(value ?? '')) throw new Error('--revision must be the admitted 40-hex protected revision'); return value }
const templatePath = () => opt('template', join(here, 'release-template.json'))

function verifyZspBinary(path) {
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex')
  if (digest !== ZSP.sha256) throw new Error(`zsp binary at ${path} hashes to ${digest}, expected pinned ${ZSP.sha256}`)
  return path
}

function runZsp({ zspPath, mode, configPath, commit, npub, workDir }) {
  const env = zspEnv({ mode, npub, signWith: process.env.ZAPSTORE_SIGN_WITH, xdgConfigHome: join(workDir, 'xdg') })
  mkdirSync(env.XDG_CONFIG_HOME, { recursive: true, mode: 0o700 })
  const argv = zspArgs({ configPath, commit, mode })
  const stdoutPath = join(workDir, `zsp-${mode}.stdout`)
  const stderrPath = join(workDir, `zsp-${mode}.stderr`)
  const out = openSync(stdoutPath, 'w', 0o600)
  const err = openSync(stderrPath, 'w', 0o600)
  let result
  try { result = spawnSync(zspPath, argv, { env, stdio: ['ignore', out, err], timeout: 20 * 60 * 1000 }) } finally { closeSync(out); closeSync(err) }
  const stdout = readFileSync(stdoutPath, 'utf8')
  const stderr = readFileSync(stderrPath, 'utf8')
  return { status: result.status, stdout, stderr, stdoutPath, stderrPath, argv }
}

function readAtSource(sourceRoot, sha, path) {
  return execFileSync('git', ['-C', sourceRoot, 'show', `${sha}:${path}`], { encoding: 'utf8' })
}

function requireCheckout(workspace, revision) {
  requireRevision(revision)
  const head = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (head !== revision) throw new Error(`checkout HEAD ${head} is not the admitted protected revision ${revision}`)
  return head
}

function walkJson(dir, fileName) {
  const found = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === fileName) { try { found.push(readJson(path)) } catch { /* malformed evidence is missing evidence */ } }
    }
  }
  if (dir && existsSafe(dir)) walk(dir)
  return found
}

function phasesFromEnv(order) {
  return Object.fromEntries(order.map((name) => [name, process.env[`PHASE_${name.toUpperCase()}`] || 'not-run']))
}

const commands = {
  admit() {
    const state = activationState(process.env.ZAPSTORE_AUTOMATION_ENABLED)
    const { revision } = requireProtectedSchedule({
      eventName: process.env.GITHUB_EVENT_NAME,
      ref: process.env.GITHUB_REF,
      workflowRef: process.env.GITHUB_WORKFLOW_REF,
      sha: process.env.GITHUB_SHA,
      workflowSha: process.env.GITHUB_WORKFLOW_SHA,
      repository: process.env.GITHUB_REPOSITORY,
    })
    if (opt('workspace')) requireCheckout(opt('workspace'), revision)
    output('active', String(state.active))
    output('rehearsal', String(Boolean(state.rehearsal)))
    output('revision', revision)
    summary(`### Zapstore lane: ${state.label}\n\nProtected revision ${revision} supplied this workflow definition and is the only revision any job checks out. ${state.active ? 'Eligible releases will be reconciled; only the newest eligible release can be published, and only if absent from the relay.' : 'No publication can happen in this run.'}`)
  },

  'checkout-guard'() {
    const head = requireCheckout(opt('workspace'), opt('revision'))
    summary(`Checkout bound to protected revision ${head}`)
  },

  async enumerate() {
    const listing = await client().listPublishedReleases()
    const { candidates, omitted } = selectScheduleCandidates(listing.releases)
    writeJson(opt('out'), { candidates, omitted })
    output('count', String(candidates.length))
    output('matrix', JSON.stringify({ include: candidates.map((c) => ({ release_id: String(c.releaseId), tag: c.tag, publishable: String(c.publishable) })) }))
    summary(['### Release enumeration', '', '| Release id | Tag | Decision |', '|---|---|---|', ...candidates.map((c) => `| ${c.releaseId} | ${c.tag} | ${c.publishable ? 'newest eligible: may publish if absent' : 'verify-only'} (${c.kind}, channel ${c.channel}) |`), ...omitted.map((o) => `| ${o.releaseId ?? '-'} | ${o.tag ?? '-'} | omitted: ${o.reason} |`)].join('\n'))
  },

  async bind() {
    const binding = await buildBinding({ client: client(), releaseId: Number(opt('release-id')), gitAncestry: opt('git-ancestry', null) })
    writeJson(opt('out'), binding)
    output('tag', binding.tag)
    output('source_sha', binding.sourceSha)
    summary(`Bound release ${binding.releaseId} ${binding.tag} at ${binding.sourceSha}; APK asset ${binding.assets.apk.id} sha256 ${binding.assets.apk.sha256}`)
  },

  async 'fetch-apk'() {
    const gh = client()
    const binding = readJson(opt('binding'))
    const dir = opt('out-dir')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const apkPath = join(dir, binding.assets.apk.name)
    const local = await gh.downloadAsset(binding.assets.apk.id, apkPath)
    const sidecar = hashFromChecksumText(await gh.getText(`/releases/assets/${binding.assets.sidecar.id}`))
    const sums = hashFromChecksumText(await gh.getText(`/releases/assets/${binding.assets.sums.id}`), { fileName: binding.assets.apk.name })
    verifyApkHashes({ binding, localSha256: local.sha256, localSize: local.size, sidecarSha256: sidecar, sumsSha256: sums })
    output('apk_path', apkPath)
    summary(`APK ${binding.assets.apk.name}: local sha256, GitHub digest, sidecar and SHA256SUMS.txt all agree (${local.sha256}, ${local.size} bytes)`)
  },

  'verify-apksigner'() {
    const template = loadTemplate(templatePath())
    const parsed = parseApksignerOutput(readFileSync(opt('output'), 'utf8'))
    requireSignedBy(parsed, template.expectedCertificateSha256)
    summary(`apksigner: Verifies; ${parsed.certs.length} signer(s), all ${template.expectedCertificateSha256}`)
  },

  // Trusted template + exact APK -> generated config + expected unsigned events.
  prepare() {
    const template = loadTemplate(templatePath())
    const binding = readJson(opt('binding'))
    const apkPath = opt('apk')
    const workDir = opt('work-dir')
    const zspPath = verifyZspBinary(opt('zsp'))
    const sourceRoot = opt('source-root')
    const revision = requireCheckout(sourceRoot, opt('revision'))
    mkdirSync(workDir, { recursive: true, mode: 0o700 })
    const sourceMeta = parseSourceBuildMetadata(readAtSource(sourceRoot, binding.sourceSha, SOURCE_BUILD_GRADLE))
    if (sourceMeta.versionName !== binding.version) {
      throw new Error(`source ${SOURCE_BUILD_GRADLE} versionName ${sourceMeta.versionName} != bound tag version ${binding.version}`)
    }
    const media = stageMedia({ template, sourceRoot, outDir: join(workDir, 'media') })
    writeFileSync(join(workDir, 'empty.txt'), 'pending\n', { mode: 0o600 })
    generateConfig({ template, apkPath, media, changelog: { localPath: join(workDir, 'empty.txt') }, outPath: join(workDir, 'probe.yaml') })
    const probe = runZsp({ zspPath, mode: 'unsigned', configPath: join(workDir, 'probe.yaml'), commit: binding.sourceSha, npub: template.pubkey, workDir })
    if (probe.status !== 0) throw new Error(`zsp unsigned probe exited ${probe.status}: ${redact(probe.stderr).slice(-600)}`)
    const probeEvents = expectedSet(parseEventsJsonl(probe.stdout))
    const expectedIdentity = {
      packageId: template.package,
      version: sourceMeta.versionName,
      versionCode: sourceMeta.versionCode,
      sha256: binding.assets.apk.sha256,
      size: binding.assets.apk.size,
      certificateSha256: template.expectedCertificateSha256,
      filename: binding.assets.apk.name,
      commit: binding.sourceSha,
    }
    requireApkIdentity(apkFactsFromEvent(probeEvents.apk), expectedIdentity)
    const changelog = resolveChangelog({
      template,
      versionCode: sourceMeta.versionCode,
      sourceSha: binding.sourceSha,
      outDir: workDir,
      readAtSource: (sha, path) => readAtSource(sourceRoot, sha, path),
    })
    const configPath = join(workDir, 'zapstore-release.yaml')
    generateConfig({ template, apkPath, media, changelog, outPath: configPath })
    const expected = runZsp({ zspPath, mode: 'unsigned', configPath, commit: binding.sourceSha, npub: template.pubkey, workDir })
    if (expected.status !== 0) throw new Error(`zsp unsigned run exited ${expected.status}: ${redact(expected.stderr).slice(-600)}`)
    const set = expectedSet(parseEventsJsonl(expected.stdout))
    requireApkIdentity(apkFactsFromEvent(set.apk), expectedIdentity)
    if (set.apk.pubkey !== template.pubkeyHex || set.release.pubkey !== template.pubkeyHex || set.app.pubkey !== template.pubkeyHex) throw new Error('expected events are not attributed to the approved publisher')
    if (set.release.content !== changelog.text) throw new Error('release event content is not the bound changelog text')
    if (set.app.content !== template.description) throw new Error('app event content is not the trusted template description')
    const expectedPath = join(workDir, 'expected-events.jsonl')
    writeFileSync(expectedPath, [set.app, set.release, set.apk].map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 })
    writeJson(join(workDir, 'release-manifest.json'), {
      binding,
      versionCode: sourceMeta.versionCode,
      versionName: sourceMeta.versionName,
      changelog: { path: changelog.path, sourceSha: changelog.sourceSha, sha256: changelog.sha256 },
      media,
      template: { path: templatePath(), sha256: createHash('sha256').update(readFileSync(templatePath())).digest('hex') },
      zsp: ZSP,
      protectedRevision: revision,
    })
    output('config_path', configPath)
    output('expected_events', expectedPath)
    output('version_code', String(sourceMeta.versionCode))
    summary(`Prepared ${binding.tag} at protected revision ${revision}: versionCode ${sourceMeta.versionCode} from ${SOURCE_BUILD_GRADLE}@${binding.sourceSha.slice(0, 12)}, changelog ${changelog.path} (${changelog.sha256}), icon ${media.icon.sha256}, ${media.images.length} screenshots`)
  },

  async reconcile() {
    const expected = expectedSet(parseEventsJsonl(readFileSync(opt('expected'), 'utf8')))
    const schnorr = await loadSchnorr()
    const filters = packageFilters({ pubkeyHex: expected.apk.pubkey, packageId: expected.apk.tags.find((t) => t[0] === 'i')[1] })
    const publishable = opt('publishable', 'false') === 'true'
    let assessment
    try {
      const { events } = await queryRelay({ url: RELAY_URL, filters })
      assessment = assessRelayState({ expected, observed: events, schnorr })
    } catch (error) {
      assessment = { outcome: 'incomplete', detail: redact(error.message) }
    }
    const decision = publicationAction({ assessment, publishable })
    writeJson(opt('out'), { ...assessment, ...decision, publishable })
    output('outcome', assessment.outcome)
    output('action', decision.action)
    output('reason', decision.reason)
    output('verify_cdn', String(decision.verifyCdn))
    summary(`### Relay reconciliation (${RELAY_URL})\n\nOutcome: **${assessment.outcome}** — ${assessment.detail}\nAction: **${decision.action}** (${decision.reason}; candidate ${publishable ? 'is' : 'is not'} the newest eligible release).`)
    if (has('readback')) requireReadbackComplete(assessment)
    else if (decision.action === 'fail') throw new Error(`reconciliation outcome ${assessment.outcome}; see runbook section 5`)
  },

  // The environment-bound job must be publishing exactly what the read-only
  // assessment approved: same release, tag, commit, assets, expected tuples and
  // decision. Any difference stops the run before revalidation and signing.
  drift() {
    const assessmentDir = opt('assessment-dir')
    const previous = readJson(join(assessmentDir, 'binding.json'))
    const current = readJson(opt('binding'))
    const drift = []
    for (const key of ['releaseId', 'tag', 'version', 'channel', 'sourceSha']) if (previous[key] !== current[key]) drift.push(key)
    for (const key of ['id', 'name', 'size', 'sha256']) if (previous.assets.apk[key] !== current.assets.apk[key]) drift.push(`assets.apk.${key}`)
    const normalize = (path) => {
      const events = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse)
      if (events.length !== 3 || Object.values(KINDS).some((kind) => events.filter((e) => e.kind === kind).length !== 1)) throw new Error('expected-events must contain exactly one app, release and APK')
      const apkId = events.find((e) => e.kind === KINDS.APK).id
      return events.map((event) => {
        if (event.id !== eventId(event)) throw new Error('expected-events identity does not match its content')
        if (event.kind === KINDS.RELEASE) {
          const links = event.tags.filter((tag) => tag[0] === 'e')
          if (links.length !== 1 || links[0][1] !== apkId) throw new Error('expected-events release must link its own APK exactly once')
          // Only the validated APK identity is timestamp-dependent. Keep the
          // relay hint, tuple shape, ordering and all other metadata exact.
          event.tags = event.tags.map((tag) => tag[0] === 'e' ? [tag[0], '<apk-event-id>', ...tag.slice(2)] : tag)
        }
        delete event.created_at
        delete event.id
        return JSON.stringify(event)
      })
    }
    const before = normalize(join(assessmentDir, 'prepare', 'expected-events.jsonl'))
    const now = normalize(opt('expected'))
    if (JSON.stringify(before) !== JSON.stringify(now)) drift.push('expected-events')
    const assessed = readJson(join(assessmentDir, 'reconcile.json'))
    const decided = readJson(opt('reconcile'))
    if (assessed.action !== 'publish') drift.push('assessment-action')
    if (decided.action !== 'publish' && decided.action !== 'skip') drift.push('current-action')
    const previousManifest = readJson(join(assessmentDir, 'prepare', 'release-manifest.json'))
    if (previousManifest.protectedRevision !== requireRevision(opt('revision'))) drift.push('protectedRevision')
    if (drift.length) throw new Error(`publication input drifted from the assessment: ${drift.join(', ')}`)
    summary(`Publication input identical to assessment for release ${current.releaseId} ${current.tag} at ${current.sourceSha}; current relay decision ${decided.action} (${decided.reason})`)
  },

  async revalidate() {
    const binding = readJson(opt('binding'))
    await revalidateBinding({ client: client(), binding, gitAncestry: opt('git-ancestry', null) })
    const apk = opt('apk')
    const digest = createHash('sha256').update(readFileSync(apk)).digest('hex')
    if (digest !== binding.assets.apk.sha256 || statSync(apk).size !== binding.assets.apk.size) throw new Error('local APK changed since binding')
    summary(`Revalidated release ${binding.releaseId} ${binding.tag} immediately before signing`)
  },

  async publish() {
    const template = loadTemplate(templatePath())
    const binding = readJson(opt('binding'))
    const workDir = opt('work-dir')
    const zspPath = verifyZspBinary(opt('zsp'))
    const signWith = process.env.ZAPSTORE_SIGN_WITH
    const clientKey = process.env.ZAPSTORE_BUNKER_CLIENT_KEY
    if (!signWith || !clientKey) throw new Error('signer credentials are missing from the environment; refusing to publish')
    const { publishWithPreflight } = await import('./lib/publish.mjs')
    const xdg = join(workDir, 'xdg')
    mkdirSync(xdg, { recursive: true, mode: 0o700 })
    const key = materializeClientKey({ xdgConfigHome: xdg, bunkerUrl: signWith, clientKey })
    let outcome
    try {
      outcome = await publishWithPreflight({
        bunkerUrl: signWith,
        clientKeyHex: clientKey.trim(),
        expectedPubkeyHex: template.pubkeyHex,
        runPublisher: (account) => {
          summary(`Signing account verified: ${account.accountPubkey} is the approved publisher (remote signer ${account.remoteSigner}). Running the pinned publisher.`)
          return runZsp({ zspPath, mode: 'live', configPath: opt('config'), commit: binding.sourceSha, workDir })
        },
      })
    } finally {
      key.cleanup()
    }
    const run = outcome.run
    const report = summarizeSignerRun({ exitCode: run.status, stdoutBytes: Buffer.byteLength(run.stdout), stderrBytes: Buffer.byteLength(run.stderr), stderrTail: run.stderr })
    writeJson(join(workDir, 'signer-run.json'), { ...report, accountPubkey: outcome.account.accountPubkey })
    output('sign_exit', String(report.exitCode ?? 'null'))
    summary(`zsp live run exited ${report.exitCode} (stdout ${report.stdoutBytes} bytes, stderr ${report.stderrBytes} bytes; raw output retained only in the runner temp directory). Read-back decides success; a nonzero exit is not proof that nothing was published.`)
    if (run.status !== 0) throw new Error(`zsp exited ${run.status}; redacted stderr tail: ${report.stderrTail}`)
  },

  async 'verify-cdn'() {
    const expected = expectedSet(parseEventsJsonl(readFileSync(opt('expected'), 'utf8')))
    try {
      const results = await verifyReferencedBlobs({ app: expected.app, apk: expected.apk })
      writeJson(opt('out'), { status: 'success', detail: `CDN bytes verified for ${results.length} blobs`, results })
      summary(`CDN bytes verified for ${results.length} blobs (APK, icon, ${results.length - 2} screenshots)`)
    } catch (error) {
      writeJson(opt('out'), { status: 'failure', detail: redact(error.message) })
      throw error
    }
  },

  'record-result'() {
    const job = opt('job')
    const order = job === 'publish' ? PUBLISH_PHASES : ASSESS_PHASES
    const signExitRaw = process.env.SIGN_EXIT ?? ''
    const result = recordResult({
      job,
      phases: phasesFromEnv(order),
      binding: readJsonIfPresent(opt('binding')),
      reconcile: readJsonIfPresent(opt('reconcile')),
      readback: readJsonIfPresent(opt('readback')),
      cdn: readJsonIfPresent(opt('cdn')),
      signExit: signExitRaw === '' || signExitRaw === 'null' ? null : Number(signExitRaw),
      fallback: { releaseId: process.env.RELEASE_ID || null, tag: process.env.RELEASE_TAG || null, protectedRevision: process.env.REVISION || null },
    })
    writeJson(opt('out'), result)
    output('status', result.status)
    output('failed_phase', result.failedPhase ?? '')
    summary(`Candidate ${result.tag ?? '?'} (release ${result.releaseId ?? '?'}): ${job} ${result.status}${result.failedPhase ? ` at phase ${result.failedPhase}` : ''}; publication ${result.publication}`)
  },

  plan() {
    const { candidates } = readJson(opt('candidates'))
    const assessments = walkJson(opt('assessments-dir'), 'assessment.json')
    const plan = buildPlan({ candidates, assessments })
    writeJson(opt('out'), plan)
    output('count', String(plan.count))
    output('matrix', JSON.stringify({ include: plan.publish }))
    summary(`### Publication plan\n\n${plan.count === 0 ? 'Nothing to publish.' : plan.publish.map((p) => `- ${p.tag} (release ${p.release_id})`).join('\n')}${plan.missing.length ? `\n\nMissing assessment evidence: ${plan.missing.map((m) => `${m.tag} (${m.releaseId})`).join(', ')}` : ''}`)
  },

  async notify() {
    const candidates = readJsonIfPresent(opt('candidates'))?.candidates ?? []
    const plan = readJsonIfPresent(opt('plan'))
    const assessments = walkJson(opt('assessments-dir'), 'assessment.json')
    const results = walkJson(opt('results-dir'), 'result.json')
    const jobs = { enumerate: process.env.JOB_ENUMERATE, assess: process.env.JOB_ASSESS, plan: process.env.JOB_PLAN, publish: process.env.JOB_PUBLISH }
    const failures = collectFailures({ candidates, plan, assessments, results, jobs })
    if (candidates.length === 0 && jobs.enumerate === 'success' && failures.length === 0) summary('No eligible candidates and no failures.')
    const created = []
    for (const failure of failures) {
      const issue = buildIssue({
        releaseId: failure.releaseId,
        tag: failure.tag,
        sourceSha: failure.sourceSha,
        runUrl: process.env.RUN_URL,
        phase: failure.phase,
        outcome: failure.outcome,
        reason: failure.reason,
        detail: failure.detail,
        publication: failure.publication,
      })
      const result = await createIssueWithReadback({ token: process.env.GITHUB_TOKEN, issue, apiBase: process.env.GITHUB_API_URL || undefined })
      created.push(result)
      summary(result.deduped ? `Reused open issue #${result.number} for ${issue.title}` : `Opened and read back issue #${result.number} for ${issue.title}`)
    }
    if (created.length === 0) summary(`No failure issue required (${candidates.length} candidate(s), ${assessments.length} assessment(s), ${results.length} publication result(s), no failures and no missing evidence).`)
  },
}

function existsSafe(path) {
  try { statSync(path); return true } catch { return false }
}

if (!commands[command]) {
  console.error(`unknown command ${String(command)}; known: ${Object.keys(commands).join(', ')}`)
  process.exit(2)
}
Promise.resolve(commands[command]()).catch((error) => {
  console.error(redact(error?.message ?? String(error)))
  process.exit(1)
})
