#!/usr/bin/env node
// Orchestrator for the dormant Zapstore lane. Every subcommand reads its inputs
// from files or the environment, writes structured results to files, and prints
// only redacted, structured text. Secrets never reach stdout.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, statSync, readdirSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

import { classifyRelease, selectScheduleCandidates } from './lib/eligibility.mjs'
import { activationState, admitTrigger, requireOwnerSender, requireProtectedRef, requireProtectedWorkflow, validateReleaseEvent } from './lib/dispatch.mjs'
import { createGitHubClient, hashFromChecksumText } from './lib/github.mjs'
import { buildBinding, revalidateBinding, verifyApkHashes } from './lib/binding.mjs'
import { parseApksignerOutput, requireSignedBy } from './lib/apksigner.mjs'
import { generateConfig, loadTemplate, resolveChangelog, stageMedia } from './lib/metadata.mjs'
import { loadSchnorr, packageFilters, queryRelay, RELAY_URL } from './lib/nostr.mjs'
import { assessRelayState, expectedSet, publicationAction, requireReadbackComplete } from './lib/reconcile.mjs'
import { apkFactsFromEvent, parseEventsJsonl, requireApkIdentity, ZSP, zspArgs, zspEnv } from './lib/zsp.mjs'
import { materializeClientKey } from './lib/bunker-key.mjs'
import { redact, summarizeSignerRun } from './lib/redact.mjs'
import { buildIssue, createIssueWithReadback, publicationClaim } from './lib/notify.mjs'
import { verifyReferencedBlobs } from './lib/cdn.mjs'
import { parseSourceBuildMetadata, SOURCE_BUILD_GRADLE } from './lib/source-metadata.mjs'

const here = resolve(new URL('.', import.meta.url).pathname)
const args = process.argv.slice(2)
const command = args.shift()
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback }
const has = (name) => args.includes(`--${name}`)
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const output = (key, value) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`) }
const summary = (text) => { if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n'); console.log(redact(text)) }
const client = () => createGitHubClient({ token: process.env.GITHUB_TOKEN ?? '' })

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

const commands = {
  admit() {
    const state = activationState(process.env.ZAPSTORE_AUTOMATION_ENABLED)
    const mode = admitTrigger(process.env.GITHUB_EVENT_NAME)
    let target = null
    if (mode === 'schedule') {
      requireProtectedWorkflow(process.env.GITHUB_WORKFLOW_REF, { repository: process.env.GITHUB_REPOSITORY })
      requireProtectedRef(process.env.GITHUB_REF)
    } else {
      requireOwnerSender(process.env.SENDER_ID)
      target = validateReleaseEvent({
        id: process.env.RELEASE_ID,
        tag: process.env.RELEASE_TAG,
        draft: process.env.RELEASE_DRAFT,
      })
    }
    output('active', String(state.active))
    output('rehearsal', String(Boolean(state.rehearsal)))
    output('mode', mode)
    output('release_id', target ? String(target.releaseId) : '')
    output('release_tag', target ? target.tag : '')
    output('source_sha', target ? (target.sourceSha ?? '') : '')
    summary(`### Zapstore lane: ${state.label}\n\nTrigger: ${mode}${target ? ` for release ${target.releaseId} (${target.tag})` : ''}. ${state.active ? 'Eligible releases will be reconciled and, if absent or safely recoverable on the relay, published.' : 'No publication can happen in this run.'}`)
  },

  async enumerate() {
    const gh = client()
    const out = opt('out')
    const mode = opt('mode')
    let candidates
    let omitted = []
    if (mode === 'release') {
      const release = await gh.getReleaseById(Number(opt('release-id')))
      const verdict = classifyRelease(release)
      if (!verdict.eligible) throw new Error(`release ${release.id} is not eligible: ${verdict.reason}`)
      candidates = [verdict]
    } else if (mode === 'schedule') {
      const listing = await gh.listPublishedReleases()
      ;({ candidates, omitted } = selectScheduleCandidates(listing.releases))
    } else {
      throw new Error(`unsupported enumerate mode ${String(mode)}`)
    }
    writeJson(out, { candidates, omitted })
    output('count', String(candidates.length))
    output('matrix', JSON.stringify({ include: candidates.map((c) => ({ release_id: String(c.releaseId), tag: c.tag })) }))
    summary(['### Release enumeration', '', '| Release id | Tag | Decision |', '|---|---|---|', ...candidates.map((c) => `| ${c.releaseId} | ${c.tag} | candidate (${c.kind}, channel ${c.channel}) |`), ...omitted.map((o) => `| ${o.releaseId ?? '-'} | ${o.tag ?? '-'} | omitted: ${o.reason} |`)].join('\n'))
  },

  async bind() {
    const binding = await buildBinding({
      client: client(),
      releaseId: Number(opt('release-id')),
      expectedTag: opt('tag', null),
      expectedSourceSha: opt('source-sha', null),
      gitAncestry: opt('git-ancestry', null),
    })
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
    const template = loadTemplate(opt('template', join(here, 'release-template.json')))
    const parsed = parseApksignerOutput(readFileSync(opt('output'), 'utf8'))
    requireSignedBy(parsed, template.expectedCertificateSha256)
    summary(`apksigner: Verifies; ${parsed.certs.length} signer(s), all ${template.expectedCertificateSha256}`)
  },

  // Trusted template + exact APK -> generated config + expected unsigned events.
  prepare() {
    const template = loadTemplate(opt('template', join(here, 'release-template.json')))
    const binding = readJson(opt('binding'))
    const apkPath = opt('apk')
    const workDir = opt('work-dir')
    const zspPath = verifyZspBinary(opt('zsp'))
    const sourceRoot = opt('source-root')
    mkdirSync(workDir, { recursive: true, mode: 0o700 })
    const sourceMeta = parseSourceBuildMetadata(readAtSource(sourceRoot, binding.sourceSha, SOURCE_BUILD_GRADLE))
    if (sourceMeta.versionName !== binding.version) {
      throw new Error(`source ${SOURCE_BUILD_GRADLE} versionName ${sourceMeta.versionName} != bound tag version ${binding.version}`)
    }
    const media = stageMedia({ template, sourceRoot, outDir: join(workDir, 'media') })
    const probeConfig = generateConfig({ template, apkPath, media, changelog: { localPath: join(workDir, 'empty.txt') }, outPath: join(workDir, 'probe.yaml') })
    writeFileSync(join(workDir, 'empty.txt'), 'pending\n', { mode: 0o600 })
    void probeConfig
    const probe = runZsp({ zspPath, mode: 'unsigned', configPath: join(workDir, 'probe.yaml'), commit: binding.sourceSha, npub: template.pubkey, workDir })
    if (probe.status !== 0) throw new Error(`zsp unsigned probe exited ${probe.status}: ${redact(probe.stderr).slice(-600)}`)
    const probeEvents = expectedSet(parseEventsJsonl(probe.stdout))
    const facts = apkFactsFromEvent(probeEvents.apk)
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
    requireApkIdentity(facts, expectedIdentity)
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
      template: { sha256: createHash('sha256').update(readFileSync(opt('template', join(here, 'release-template.json')))).digest('hex') },
      zsp: ZSP,
      protectedRevision: process.env.GITHUB_SHA ?? process.env.GITHUB_WORKFLOW_SHA ?? null,
    })
    output('config_path', configPath)
    output('expected_events', expectedPath)
    output('version_code', String(sourceMeta.versionCode))
    summary(`Prepared ${binding.tag}: versionCode ${sourceMeta.versionCode} from ${SOURCE_BUILD_GRADLE}@${binding.sourceSha.slice(0, 12)}, changelog ${changelog.path} (${changelog.sha256}), icon ${media.icon.sha256}, ${media.images.length} screenshots`)
  },

  async reconcile() {
    const expected = expectedSet(parseEventsJsonl(readFileSync(opt('expected'), 'utf8')))
    const schnorr = await loadSchnorr()
    const filters = packageFilters({ pubkeyHex: expected.apk.pubkey, packageId: expected.apk.tags.find((t) => t[0] === 'i')[1] })
    const triggerMode = opt('mode', process.env.MODE || 'schedule')
    const versionCode = Number((expected.apk.tags.find((t) => t[0] === 'version_code') ?? [])[1])
    let assessment
    try {
      const { events } = await queryRelay({ url: RELAY_URL, filters })
      assessment = assessRelayState({ expected, observed: events, schnorr })
    } catch (error) {
      assessment = { outcome: 'incomplete', detail: redact(error.message) }
    }
    assessment.candidateVersionCode = versionCode
    const decision = publicationAction({ assessment, triggerMode, candidateVersionCode: versionCode })
    writeJson(opt('out'), { ...assessment, ...decision })
    output('outcome', assessment.outcome)
    output('action', decision.action)
    output('reason', decision.reason)
    summary(`### Relay reconciliation (${RELAY_URL})\n\nOutcome: **${assessment.outcome}** — ${assessment.detail}\nAction: **${decision.action}** (${decision.reason}).`)
    if (has('readback')) requireReadbackComplete(assessment)
    else if (decision.action === 'fail') throw new Error(`reconciliation outcome ${assessment.outcome}; see runbook section 5`)
  },

  async revalidate() {
    const binding = readJson(opt('binding'))
    await revalidateBinding({ client: client(), binding, gitAncestry: opt('git-ancestry', null) })
    const apk = opt('apk')
    const digest = createHash('sha256').update(readFileSync(apk)).digest('hex')
    if (digest !== binding.assets.apk.sha256 || statSync(apk).size !== binding.assets.apk.size) throw new Error('local APK changed since binding')
    summary(`Revalidated release ${binding.releaseId} ${binding.tag} immediately before signing`)
  },

  publish() {
    const binding = readJson(opt('binding'))
    const workDir = opt('work-dir')
    const zspPath = verifyZspBinary(opt('zsp'))
    const signWith = process.env.ZAPSTORE_SIGN_WITH
    const clientKey = process.env.ZAPSTORE_BUNKER_CLIENT_KEY
    if (!signWith || !clientKey) throw new Error('signer credentials are missing from the environment; refusing to publish')
    const xdg = join(workDir, 'xdg')
    mkdirSync(xdg, { recursive: true, mode: 0o700 })
    const key = materializeClientKey({ xdgConfigHome: xdg, bunkerUrl: signWith, clientKey })
    let run
    try {
      run = runZsp({ zspPath, mode: 'live', configPath: opt('config'), commit: binding.sourceSha, workDir })
    } finally {
      key.cleanup()
    }
    const report = summarizeSignerRun({ exitCode: run.status, stdoutBytes: Buffer.byteLength(run.stdout), stderrBytes: Buffer.byteLength(run.stderr), stderrTail: run.stderr })
    writeJson(join(workDir, 'signer-run.json'), report)
    output('sign_exit', String(report.exitCode ?? 'null'))
    summary(`zsp live run exited ${report.exitCode} (stdout ${report.stdoutBytes} bytes, stderr ${report.stderrBytes} bytes; raw output retained only in the runner temp directory). Read-back decides success; a nonzero exit is not proof that nothing was published.`)
    if (run.status !== 0) throw new Error(`zsp exited ${run.status}; redacted stderr tail: ${report.stderrTail}`)
  },

  async 'verify-cdn'() {
    const expected = expectedSet(parseEventsJsonl(readFileSync(opt('expected'), 'utf8')))
    const results = await verifyReferencedBlobs({ app: expected.app, apk: expected.apk })
    writeJson(opt('out'), results)
    summary(`CDN bytes verified for ${results.length} blobs (APK, icon, ${results.length - 2} screenshots)`)
  },

  'record-result'() {
    const binding = opt('binding') && existsSafe(opt('binding')) ? readJson(opt('binding')) : null
    const reconcile = opt('reconcile') && existsSafe(opt('reconcile')) ? readJson(opt('reconcile')) : null
    const readback = opt('readback') && existsSafe(opt('readback')) ? readJson(opt('readback')) : null
    const signExitRaw = opt('sign-exit', process.env.SIGN_EXIT ?? '')
    const signExit = signExitRaw === '' ? null : Number(signExitRaw)
    const publishAttempted = process.env.PUBLISH_ATTEMPTED === 'true'
    const phase = process.env.FAILED_PHASE || (publishAttempted ? 'publish' : 'reconcile')
    const result = {
      releaseId: binding?.releaseId ?? process.env.RELEASE_ID ?? null,
      tag: binding?.tag ?? process.env.RELEASE_TAG ?? null,
      sourceSha: binding?.sourceSha ?? process.env.SOURCE_SHA ?? null,
      outcome: readback?.outcome ?? reconcile?.outcome ?? process.env.OUTCOME ?? 'unknown',
      action: reconcile?.action ?? null,
      reason: reconcile?.reason ?? null,
      detail: readback?.detail ?? reconcile?.detail ?? process.env.DETAIL ?? '',
      phase,
      publishAttempted,
      signExit,
      publication: publicationClaim({ publishAttempted, signExit, readbackOutcome: readback?.outcome }),
    }
    writeJson(opt('out'), result)
    output('release_id', result.releaseId == null ? '' : String(result.releaseId))
    output('tag', result.tag ?? '')
    output('source_sha', result.sourceSha ?? '')
    output('outcome', result.outcome)
    output('publication', result.publication)
  },

  async notify() {
    const resultsDir = opt('results-dir', '')
    const runUrl = process.env.RUN_URL
    const results = []
    if (resultsDir) {
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name)
          if (entry.isDirectory()) walk(path)
          else if (entry.name === 'result.json' || (entry.name.endsWith('.json') && entry.name.startsWith('result'))) {
            try { results.push(readJson(path)) } catch { /* ignore malformed */ }
          }
        }
      }
      try { walk(resultsDir) } catch { /* no artifacts yet */ }
    }
    if (results.length === 0) {
      results.push({
        releaseId: process.env.RELEASE_ID,
        tag: process.env.RELEASE_TAG,
        sourceSha: process.env.SOURCE_SHA,
        outcome: process.env.OUTCOME,
        phase: process.env.FAILED_PHASE,
        detail: process.env.DETAIL,
        publication: process.env.PUBLICATION || 'unknown',
      })
    }
    const created = []
    for (const row of results) {
      if (row.action === 'skip') continue
      const issue = buildIssue({
        releaseId: row.releaseId,
        tag: row.tag,
        sourceSha: row.sourceSha,
        runUrl,
        phase: row.phase,
        outcome: row.outcome,
        detail: row.detail,
        publication: row.publication,
      })
      const result = await createIssueWithReadback({ token: process.env.GITHUB_TOKEN, issue })
      created.push(result)
      summary(result.deduped ? `Reused open issue #${result.number} for ${issue.title}` : `Opened and read back issue #${result.number}`)
    }
    if (created.length === 0) summary('No failure issue required (no failed candidates with recorded results).')
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
