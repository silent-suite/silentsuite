// /retry-ci: lets one named contributor rerun the failed jobs of his own fork
// pull request's build/test runs, as often as he likes, once every run on the
// head commit has finished. Run by .github/workflows/retry-ci.yml from the
// default branch; nothing here comes from the pull request. Every check fails
// closed: nothing is rerun unless all of them pass, and a failed rerun request
// stops the command. The pull request, its history and each target run are
// re-read before every rerun request, and after each request the job waits
// until GitHub shows the new attempt, so the next comment (held by the
// concurrency group until then) cannot ask for the same rerun twice.
//
// Why this is safe: it only reruns existing `pull_request` runs from a fork.
// GitHub reruns them in their original event context (read-only token, no
// secrets), so the contributor can re-execute only what already ran for him
// under the same restrictions. The allowlist keeps it to CI workflows.

import { pathToFileURL } from 'node:url'

export const CONTRIBUTOR_ID = 313311150 // intigenesis
export const REPOSITORY = 'silent-suite/silentsuite'
export const REPOSITORY_ID = 1186208712
export const BASE_REF = 'main'
export const COMMAND = '/retry-ci'

// CI workflows that run for fork pull requests to main. preview-web.yml
// (preview deploy), commit-metadata.yml (policy check) and
// ci-umbrel-candidate.yml (skips forks) are deliberately absent, as is every
// workflow added later until it is listed here. A failed run is retried as a
// whole with rerun-failed-jobs, which includes the jobs that depend on the
// failed ones; that can include a policy check inside a listed workflow
// (Dependency Audit, Enforce Android signing boundary), all of it under the
// original fork pull_request token.
export const ALLOWED_WORKFLOWS = Object.freeze([
  '.github/workflows/android-upgrade-sync-check.yml',
  '.github/workflows/bridge-sdk-continuity.yml',
  '.github/workflows/build-android.yml',
  '.github/workflows/ci-server.yml',
  '.github/workflows/ci.yml',
  '.github/workflows/libre-workspace-addon.yml',
  '.github/workflows/test-bridge-linux.yml',
  '.github/workflows/test-bridge-macos.yml',
  '.github/workflows/test-bridge-tray.yml',
  '.github/workflows/test-bridge-windows.yml',
])

const RETRYABLE_CONCLUSIONS = new Set(['failure', 'timed_out'])
const SHA = /^[0-9a-f]{40}$/
const MAX_RUNS = 100

const refuse = reason => ({ ok: false, reason })

export function checkComment({ userId, body }) {
  if (Number(userId) !== CONTRIBUTOR_ID) return refuse('the comment is not from the allowed contributor')
  // The workflow starts only on comments that begin with the command, so
  // leading whitespace never gets here; only trailing whitespace is allowed.
  if (typeof body !== 'string' || body.trimEnd() !== COMMAND) return refuse(`the comment must be exactly ${COMMAND}`)
  return { ok: true }
}

export function checkPull(pr) {
  if (!pr || typeof pr !== 'object') return refuse('the pull request could not be read')
  if (pr.state !== 'open' || pr.merged === true) return refuse('the pull request is not open')
  if (pr.user?.id !== CONTRIBUTOR_ID) return refuse('the pull request is not by the allowed contributor')
  if (pr.base?.repo?.id !== REPOSITORY_ID || pr.base?.ref !== BASE_REF) {
    return refuse(`the pull request does not target ${BASE_REF} of this repository`)
  }
  const head = pr.head
  if (!head?.repo || typeof head.repo.id !== 'number') return refuse('the pull request head repository is gone')
  if (head.repo.id === REPOSITORY_ID) return refuse('the pull request head is not a fork')
  if (head.repo.owner?.id !== CONTRIBUTOR_ID) return refuse("the pull request head is not the contributor's fork")
  if (typeof head.ref !== 'string' || !head.ref) return refuse('the pull request head branch is missing')
  if (typeof head.sha !== 'string' || !SHA.test(head.sha)) return refuse('the pull request head commit is not an exact SHA')
  if (typeof head.label !== 'string' || !head.label.endsWith(`:${head.ref}`)) return refuse('the pull request head label is missing')
  return { ok: true }
}

// A listing entry must carry every field the decision reads; one malformed
// entry anywhere refuses the whole command rather than being filtered away.
function wellFormedRun(run) {
  return (
    run !== null &&
    typeof run === 'object' &&
    Number.isSafeInteger(run.id) &&
    run.id > 0 &&
    typeof run.path === 'string' &&
    typeof run.event === 'string' &&
    typeof run.head_sha === 'string' &&
    typeof run.head_branch === 'string' &&
    Number.isSafeInteger(run.head_repository?.id) &&
    Number.isSafeInteger(run.run_attempt) &&
    typeof run.status === 'string' &&
    (run.status !== 'completed' || typeof run.conclusion === 'string') &&
    Number.isFinite(Date.parse(run.created_at))
  )
}

// Fork runs come back with an empty `pull_requests` list, so a run belongs to
// this pull request only when event, commit, fork and branch all match it, and
// (checked by the caller) this is the only pull request ever opened from that
// branch and its base never changed. Every listed workflow filters
// pull_request to main. The same commit running CI from another branch of the
// fork refuses, and only runs created before the comment count.
export function selectRuns(pr, listing, commentCreatedAt) {
  if (!listing || !Array.isArray(listing.workflow_runs) || !Number.isSafeInteger(listing.total_count)) {
    return refuse('the workflow runs could not be read')
  }
  if (listing.total_count > MAX_RUNS || listing.workflow_runs.length !== listing.total_count) {
    return refuse('too many workflow runs on this commit to decide safely')
  }
  if (!listing.workflow_runs.every(wellFormedRun)) return refuse('the workflow runs could not be read')
  const commentTime = Date.parse(commentCreatedAt)
  if (!Number.isFinite(commentTime)) return refuse('the comment time could not be read')
  const allowed = new Set(ALLOWED_WORKFLOWS)
  const runs = listing.workflow_runs.filter(
    run =>
      run.event === 'pull_request' &&
      run.head_sha === pr.head.sha &&
      run.head_repository.id === pr.head.repo.id &&
      allowed.has(run.path),
  )
  if (runs.length === 0) return refuse('no build or test run was found for the head commit')
  if (runs.some(run => run.head_branch !== pr.head.ref)) {
    return refuse('this commit also ran CI from another branch; ask a maintainer')
  }

  const perWorkflow = new Map()
  for (const run of runs) perWorkflow.set(run.path, (perWorkflow.get(run.path) ?? 0) + 1)
  const duplicated = [...perWorkflow].filter(([, count]) => count > 1).map(([path]) => path)
  if (duplicated.length) {
    return refuse(`more than one run of ${duplicated.join(', ')} on this commit (reopened?); ask a maintainer`)
  }
  // Strictly earlier: a run created in the same second as the comment may
  // belong to a push the contributor had not seen.
  if (runs.some(run => !(Date.parse(run.created_at) < commentTime))) {
    return refuse('CI started again around or after the comment; comment /retry-ci again once it has finished')
  }
  const unfinished = runs.filter(run => run.status !== 'completed')
  if (unfinished.length) {
    return refuse(`wait until every run has finished (${unfinished.map(run => run.name).join(', ')})`)
  }
  const failed = runs.filter(run => RETRYABLE_CONCLUSIONS.has(run.conclusion))
  if (failed.length === 0) return refuse('no failed build or test run to retry on the head commit')
  return { ok: true, runs: failed, since: Math.min(...runs.map(run => Date.parse(run.created_at))) }
}

// The pull request's own history (timeline plus issue events: GitHub documents
// base_ref_changed under issue events): a base change means a run may come from
// an earlier target, and a force push after the runs started means the commit
// may have left and come back. Either refuses, as does history that cannot be
// read.
export function checkTimeline(events, since) {
  if (!Array.isArray(events) || !events.every(event => event && typeof event.event === 'string')) {
    return refuse('the pull request history could not be read')
  }
  if (events.some(event => event.event === 'base_ref_changed')) {
    return refuse('the pull request changed its target branch; ask a maintainer')
  }
  const forcePushes = events.filter(event => event.event === 'head_ref_force_pushed')
  if (forcePushes.some(event => !(Date.parse(event.created_at) < since))) {
    return refuse('the branch was force-pushed after CI started; push a new commit or ask a maintainer')
  }
  return { ok: true }
}

function client({ token, fetchImpl, api }) {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'silentsuite-retry-ci',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  return async (method, path) => {
    const response = await fetchImpl(`${api}${path}`, { method, headers })
    if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}`)
    return response.status === 204 || response.status === 201 ? null : response.json()
  }
}

const TIMELINE_PAGES = 10
const VISIBLE_TRIES = 20
const VISIBLE_WAIT_MS = 2000
const samePull = (a, b) =>
  a.number === b.number && a.head.sha === b.head.sha && a.head.ref === b.head.ref && a.head.repo.id === b.head.repo.id

// The target run as it is right before its rerun request: still the selected
// run, still a finished failure. A rerun started by someone else in between
// makes it refuse instead of stacking a second one.
export function checkTarget(now, selected) {
  if (
    !wellFormedRun(now) ||
    now.id !== selected.id ||
    now.path !== selected.path ||
    now.event !== 'pull_request' ||
    now.head_sha !== selected.head_sha ||
    now.head_branch !== selected.head_branch ||
    now.head_repository.id !== selected.head_repository.id
  ) {
    return refuse(`run ${selected.id} could not be re-read`)
  }
  if (now.run_attempt !== selected.run_attempt || now.status !== 'completed' || !RETRYABLE_CONCLUSIONS.has(now.conclusion)) {
    return refuse(`run ${selected.id} changed since the check (rerun by someone else?)`)
  }
  return { ok: true }
}

// Returns { ok, reason?, sha?, runs?, retried: [run ids] }. Throws only on
// API errors before any rerun was requested.
export async function retryCi({ env, fetchImpl = fetch, sleep = ms => new Promise(done => setTimeout(done, ms)) }) {
  const comment = checkComment({ userId: env.COMMENT_USER_ID, body: env.COMMENT_BODY })
  if (!comment.ok) return { ...comment, retried: [] }
  if (!/^[1-9][0-9]*$/.test(env.PR_NUMBER ?? '')) return { ...refuse('no pull request number'), retried: [] }
  if (env.REPO !== REPOSITORY) return { ...refuse(`only ${REPOSITORY} is supported`), retried: [] }

  const call = client({ token: env.GH_TOKEN, fetchImpl, api: env.GITHUB_API_URL || 'https://api.github.com' })
  const repo = `/repos/${env.REPO}`
  const readPull = async () => {
    const pull = await call('GET', `${repo}/pulls/${env.PR_NUMBER}`)
    const checked = checkPull(pull)
    if (!checked.ok) return checked
    if (String(pull.number) !== env.PR_NUMBER) return refuse('the pull request number does not match')
    return { ok: true, pull }
  }
  const readHistory = async since => {
    const events = []
    for (const source of ['timeline', 'events']) {
      for (let page = 1; ; page++) {
        if (page > TIMELINE_PAGES) return refuse('the pull request history is too long to check; ask a maintainer')
        const batch = await call('GET', `${repo}/issues/${env.PR_NUMBER}/${source}?per_page=100&page=${page}`)
        if (!Array.isArray(batch)) return refuse('the pull request history could not be read')
        events.push(...batch)
        if (batch.length < 100) break
      }
    }
    return checkTimeline(events, since)
  }

  const rerunVisible = async selected => {
    for (let tries = 0; tries < VISIBLE_TRIES; tries++) {
      if (tries) await sleep(VISIBLE_WAIT_MS)
      try {
        const now = await call('GET', `${repo}/actions/runs/${selected.id}`)
        if (now?.id === selected.id && Number.isSafeInteger(now.run_attempt) && now.run_attempt > selected.run_attempt) return true
      } catch {
        // keep waiting; an unreadable answer is not a visible rerun
      }
    }
    return false
  }

  const first = await readPull()
  if (!first.ok) return { ...first, retried: [] }
  const pull = first.pull

  const fromBranch = await call(
    'GET',
    `${repo}/pulls?state=all&head=${encodeURIComponent(pull.head.label)}&per_page=${MAX_RUNS}`,
  )
  if (!Array.isArray(fromBranch) || fromBranch.length !== 1 || fromBranch[0]?.number !== pull.number) {
    return { ...refuse('another pull request was opened from the same branch; ask a maintainer'), retried: [] }
  }

  const listing = await call(
    'GET',
    `${repo}/actions/runs?head_sha=${pull.head.sha}&event=pull_request&per_page=${MAX_RUNS}`,
  )
  const selection = selectRuns(pull, listing, env.COMMENT_CREATED_AT)
  if (!selection.ok) return { ...selection, retried: [] }
  const history = await readHistory(selection.since)
  if (!history.ok) return { ...history, retried: [] }

  const retried = []
  const stop = reason => ({ ok: false, reason, retried })
  for (const run of selection.runs) {
    try {
      const live = await readPull()
      if (!live.ok) return stop(live.reason)
      if (!samePull(live.pull, pull)) return stop('the pull request head changed; try again')
      const again = await readHistory(selection.since)
      if (!again.ok) return stop(again.reason)
      const target = checkTarget(await call('GET', `${repo}/actions/runs/${run.id}`), run)
      if (!target.ok) return stop(target.reason)
    } catch (error) {
      return stop(`the pull request or run could not be re-read: ${error.message}`)
    }
    let postError = null
    try {
      await call('POST', `${repo}/actions/runs/${run.id}/rerun-failed-jobs`)
    } catch (error) {
      postError = error
    }
    // Hold the concurrency group until the new attempt shows. An error reply
    // whose rerun shows anyway counts as started.
    if (!(await rerunVisible(run))) {
      if (postError) return stop(`rerun of run ${run.id} failed: ${postError.message}`)
      retried.push(run.id)
      return stop(`rerun of run ${run.id} was requested but GitHub does not show it yet; wait for it to start before commenting again`)
    }
    retried.push(run.id)
  }
  return { ok: true, sha: pull.head.sha, retried, runs: selection.runs }
}

async function main() {
  const { appendFileSync } = await import('node:fs')
  const summary = line => {
    console.log(line)
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`)
  }
  let result
  try {
    result = await retryCi({ env: process.env })
  } catch (error) {
    result = { ok: false, reason: error.message, retried: [] }
  }
  const server = process.env.GITHUB_SERVER_URL || 'https://github.com'
  if (result.ok) {
    summary(`Retrying failed jobs on PR #${process.env.PR_NUMBER} at ${result.sha}:`)
    for (const run of result.runs) summary(`- ${run.name}: ${server}/${process.env.REPO}/actions/runs/${run.id}`)
    return
  }
  summary(`/retry-ci refused on PR #${process.env.PR_NUMBER}: ${result.reason}`)
  if (result.retried.length) summary(`Reruns already started: ${result.retried.join(', ')}`)
  console.log(`::error::/retry-ci refused: ${result.reason}`)
  process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
