// Per-candidate evidence: what each phase actually did, the candidate's final
// status, and which candidates lack evidence altogether.

import { publicationClaim } from './notify.mjs'

export const ASSESS_PHASES = ['checkout', 'bind', 'apk', 'apksigner', 'prepare', 'reconcile', 'cdn']
export const PUBLISH_PHASES = ['checkout', 'bind', 'apk', 'apksigner', 'prepare', 'reconcile', 'drift', 'revalidate', 'sign', 'readback', 'cdn']
const FAILED = new Set(['failure', 'cancelled'])

export function recordResult({ job, phases = {}, binding = null, reconcile = null, readback = null, cdn = null, signExit = null, fallback = {} }) {
  if (job !== 'assess' && job !== 'publish') throw new Error(`unknown job ${String(job)}`)
  const order = job === 'assess' ? ASSESS_PHASES : PUBLISH_PHASES
  const outcomes = Object.fromEntries(order.map((name) => [name, phases[name] || 'not-run']))
  let failedPhase = order.find((name) => FAILED.has(outcomes[name])) ?? null
  const publishAttempted = job === 'publish' && (outcomes.sign === 'success' || outcomes.sign === 'failure')
  if (!failedPhase && job === 'assess' && reconcile && reconcile.action === 'fail') failedPhase = 'reconcile'
  if (!failedPhase && job === 'assess' && reconcile && reconcile.verifyCdn === true && outcomes.cdn !== 'success') failedPhase = 'cdn'
  if (!failedPhase && job === 'publish') {
    const skippedBecauseComplete = reconcile && reconcile.action === 'skip' && reconcile.verifyCdn === true && outcomes.sign === 'skipped'
    const skippedBecauseSuperseded = reconcile?.outcome === 'superseded' && reconcile.action === 'skip' && reconcile.verifyCdn === false && outcomes.reconcile === 'success' && outcomes.drift === 'success' && outcomes.sign === 'skipped'
    if (reconcile && reconcile.action === 'fail') failedPhase = 'reconcile'
    else if (skippedBecauseComplete) { if (outcomes.cdn !== 'success') failedPhase = 'cdn' }
    else if (skippedBecauseSuperseded) { /* No signing or CDN check is required for an older release. */ }
    else if (outcomes.sign !== 'success') failedPhase = 'sign'
    else if (readback?.outcome !== 'complete-match') failedPhase = 'readback'
    else if (outcomes.cdn !== 'success') failedPhase = 'cdn'
  }
  const detailSource = failedPhase === 'cdn' ? cdn : failedPhase === 'readback' ? readback : (readback ?? reconcile)
  return {
    job,
    releaseId: binding?.releaseId ?? fallback.releaseId ?? null,
    tag: binding?.tag ?? fallback.tag ?? null,
    sourceSha: binding?.sourceSha ?? fallback.sourceSha ?? null,
    protectedRevision: fallback.protectedRevision ?? null,
    status: failedPhase ? 'failure' : 'success',
    failedPhase,
    phases: outcomes,
    reconcile: reconcile ? { outcome: reconcile.outcome, action: reconcile.action, reason: reconcile.reason, detail: reconcile.detail, present: reconcile.present ?? null } : null,
    readback: readback ? { outcome: readback.outcome, detail: readback.detail } : null,
    cdn: cdn ? { status: cdn.status ?? (cdn.error ? 'failure' : 'success'), detail: cdn.detail ?? cdn.error ?? '' } : null,
    signExit,
    publishAttempted,
    // Without a read-back (nothing was signed) the pre-signing reconciliation
    // is the only relay evidence: complete-match there means already published.
    publication: publicationClaim({ publishAttempted, signExit, readbackOutcome: readback?.outcome ?? reconcile?.outcome }),
    detail: detailSource?.detail ?? detailSource?.error ?? (failedPhase ? `phase ${failedPhase} ended with ${outcomes[failedPhase]}` : ''),
  }
}

// Which enumerated candidates may proceed to the environment-bound job, and
// which lack an assessment.
export function buildPlan({ candidates, assessments }) {
  const byId = new Map(assessments.filter((a) => a && a.releaseId != null).map((a) => [String(a.releaseId), a]))
  const publish = []
  const missing = []
  for (const candidate of candidates) {
    const assessment = byId.get(String(candidate.releaseId))
    if (!assessment) { missing.push({ releaseId: candidate.releaseId, tag: candidate.tag }); continue }
    if (assessment.status === 'success' && assessment.reconcile?.action === 'publish') publish.push({ release_id: String(candidate.releaseId), tag: candidate.tag })
  }
  return { publish, missing, count: publish.length }
}

// Every failure worth an issue, and nothing else.
export function collectFailures({ candidates = [], plan = null, assessments = [], results = [], jobs = {} }) {
  const failures = []
  const assessed = new Map(assessments.filter((a) => a && a.releaseId != null).map((a) => [String(a.releaseId), a]))
  const published = new Map(results.filter((r) => r && r.releaseId != null).map((r) => [String(r.releaseId), r]))
  if (jobs.enumerate && jobs.enumerate !== 'success') {
    failures.push({ kind: 'enumerate', releaseId: null, tag: null, sourceSha: null, phase: 'enumerate', outcome: jobs.enumerate, detail: 'release enumeration did not succeed; no candidate was assessed', publication: 'not-attempted' })
    return failures
  }
  for (const candidate of candidates) {
    const id = String(candidate.releaseId)
    const assessment = assessed.get(id)
    if (!assessment) {
      failures.push({ kind: 'evidence-missing', releaseId: candidate.releaseId, tag: candidate.tag, sourceSha: null, phase: 'assess', outcome: 'evidence-missing', detail: `no assessment evidence was recorded for release ${id} (assess job result: ${jobs.assess ?? 'unknown'})`, publication: 'unknown' })
      continue
    }
    if (assessment.status !== 'success') {
      failures.push({ kind: 'assessment', releaseId: assessment.releaseId, tag: assessment.tag, sourceSha: assessment.sourceSha, phase: assessment.failedPhase, outcome: assessment.reconcile?.outcome ?? assessment.phases?.[assessment.failedPhase] ?? 'failure', reason: assessment.failedPhase === 'reconcile' ? (assessment.reconcile?.reason ?? null) : null, detail: assessment.detail, publication: assessment.publication })
      continue
    }
    const planned = plan?.publish?.some((entry) => String(entry.release_id) === id)
    if (!planned) continue
    const result = published.get(id)
    if (!result) {
      failures.push({ kind: 'evidence-missing', releaseId: candidate.releaseId, tag: candidate.tag, sourceSha: assessment.sourceSha, phase: 'publish', outcome: 'evidence-missing', detail: `publication was planned but no result evidence was recorded (publish job result: ${jobs.publish ?? 'unknown'}); a signer or upload attempt may have run`, publication: 'unknown' })
      continue
    }
    if (result.status !== 'success') {
      failures.push({ kind: 'result', releaseId: result.releaseId, tag: result.tag, sourceSha: result.sourceSha, phase: result.failedPhase, outcome: result.readback?.outcome ?? result.reconcile?.outcome ?? result.phases?.[result.failedPhase] ?? 'failure', reason: result.failedPhase === 'reconcile' ? (result.reconcile?.reason ?? null) : null, detail: result.detail, publication: result.publication })
    }
  }
  if (plan && jobs.plan && jobs.plan !== 'success') {
    failures.push({ kind: 'plan', releaseId: null, tag: null, sourceSha: null, phase: 'plan', outcome: jobs.plan, detail: 'the plan job did not succeed; no publication ran', publication: 'not-attempted' })
  }
  return failures
}
