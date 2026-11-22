// Tests for /retry-ci (scripts/retry-ci/retry-ci.mjs, .github/workflows/retry-ci.yml).
// Run: node --test scripts/retry-ci/retry-ci.test.mjs
//
// The workflow checks are textual, like deploy-secret-scope.test.mjs: the root
// has no YAML parser, and retry-ci.yml is short enough to pin line by line.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

import {
  ALLOWED_WORKFLOWS,
  CONTRIBUTOR_ID,
  REPOSITORY_ID,
  checkComment,
  checkPull,
  retryCi,
  selectRuns as selectRunsAt,
} from './retry-ci.mjs'

const HEAD = 'b21261304559b22243e5989d6eab374fe4d74184'
const FORK_ID = 1355512174
const BRANCH = 'feat/android-note-delete'

const COMMENTED_AT = '2026-11-21T12:00:00Z'
const pull = (overrides = {}) => ({
  number: 1115,
  state: 'open',
  merged: false,
  user: { id: CONTRIBUTOR_ID },
  base: { ref: 'main', repo: { id: REPOSITORY_ID } },
  head: { label: `intigenesis:${BRANCH}`, ref: BRANCH, sha: HEAD, repo: { id: FORK_ID, owner: { id: CONTRIBUTOR_ID } } },
  ...overrides,
})

let nextId = 43827172000
// Shaped like run 43827172180: fork pull_request run with an empty pull_requests list.
const run = (workflow, overrides = {}) => ({
  id: nextId++,
  name: workflow,
  path: `.github/workflows/${workflow}.yml`,
  event: 'pull_request',
  status: 'completed',
  conclusion: 'success',
  run_attempt: 1,
  head_sha: HEAD,
  head_branch: BRANCH,
  head_repository: { id: FORK_ID, full_name: 'intigenesis/silentsuite', owner: { id: CONTRIBUTOR_ID } },
  pull_requests: [],
  created_at: '2026-11-21T10:00:00Z',
  ...overrides,
})
const listing = runs => ({ total_count: runs.length, workflow_runs: runs })
const selectRuns = (pr, runs, at = COMMENTED_AT) => selectRunsAt(pr, runs, at)

// --- comment -----------------------------------------------------------------

test('only the exact command from the contributor is accepted', () => {
  assert.equal(checkComment({ userId: String(CONTRIBUTOR_ID), body: '/retry-ci' }).ok, true)
  assert.equal(checkComment({ userId: String(CONTRIBUTOR_ID), body: '/retry-ci \r\n' }).ok, true)
  // The workflow's startsWith gate never passes leading whitespace; neither does this.
  assert.equal(checkComment({ userId: String(CONTRIBUTOR_ID), body: ' /retry-ci' }).ok, false)
  assert.equal(checkComment({ userId: '265568982', body: '/retry-ci' }).ok, false)
  assert.equal(checkComment({ userId: String(CONTRIBUTOR_ID), body: '/retry-ci please' }).ok, false)
  assert.equal(checkComment({ userId: String(CONTRIBUTOR_ID), body: '/RETRY-CI' }).ok, false)
  assert.equal(checkComment({ userId: String(CONTRIBUTOR_ID), body: undefined }).ok, false)
})

// --- pull request ------------------------------------------------------------

test('accepts the contributor\'s open fork pull request to main', () => {
  assert.deepEqual(checkPull(pull()), { ok: true })
})

test('refuses pull requests outside the approved scope', () => {
  const cases = {
    closed: pull({ state: 'closed' }),
    merged: pull({ merged: true }),
    'another author': pull({ user: { id: 1 } }),
    'another base branch': pull({ base: { ref: 'dev', repo: { id: REPOSITORY_ID } } }),
    'another base repository': pull({ base: { ref: 'main', repo: { id: 1 } } }),
    'head in this repository': pull({ head: { ...pull().head, repo: { id: REPOSITORY_ID, owner: { id: CONTRIBUTOR_ID } } } }),
    "someone else's fork": pull({ head: { ...pull().head, repo: { id: FORK_ID, owner: { id: 1 } } } }),
    'deleted fork': pull({ head: { ...pull().head, repo: null } }),
    'short head sha': pull({ head: { ...pull().head, sha: 'b2126130' } }),
    'no head branch': pull({ head: { ...pull().head, ref: '' } }),
    'no head label': pull({ head: { ...pull().head, label: undefined } }),
    unreadable: null,
  }
  for (const [label, pr] of Object.entries(cases)) assert.equal(checkPull(pr).ok, false, label)
})

// --- runs --------------------------------------------------------------------

test('retries only the failed allowlisted runs, matched without pull_requests', () => {
  const ci = run('ci', { conclusion: 'failure' })
  const android = run('build-android', { conclusion: 'timed_out' })
  const result = selectRuns(pull(), listing([
    run('preview-web', { conclusion: 'failure' }),
    run('commit-metadata', { conclusion: 'failure' }),
    ci,
    android,
    run('ci-server'),
  ]))
  assert.equal(result.ok, true)
  assert.deepEqual(result.runs.map(r => r.id), [ci.id, android.id])
})

test('ignores runs of other forks, commits and events', () => {
  const mine = run('ci', { conclusion: 'failure' })
  const result = selectRuns(pull(), listing([
    mine,
    run('build-android', { conclusion: 'failure', head_repository: { id: 999, owner: { id: 999 } } }),
    run('test-bridge-linux', { conclusion: 'failure', head_sha: 'c'.repeat(40) }),
    run('test-bridge-macos', { conclusion: 'failure', event: 'pull_request_target' }),
    run('test-bridge-windows', { conclusion: 'failure', event: 'push' }),
  ]))
  assert.deepEqual(result.runs.map(r => r.id), [mine.id])
})

test('refuses a commit that also ran CI from another branch of the fork', () => {
  // A run from another branch may belong to another pull request.
  const result = selectRuns(pull(), listing([
    run('ci', { conclusion: 'failure' }),
    run('ci-server', { conclusion: 'failure', head_branch: 'other' }),
  ]))
  assert.equal(result.ok, false)
  assert.match(result.reason, /another branch/)
  const retriedElsewhere = selectRuns(pull(), listing([run('ci', { conclusion: 'failure', head_branch: 'other', run_attempt: 2 })]))
  assert.equal(retriedElsewhere.ok, false)
})

test('retries only runs that existed when the comment was written', () => {
  const later = selectRuns(pull(), listing([run('ci', { conclusion: 'failure', created_at: '2026-11-21T12:00:01Z' })]))
  assert.equal(later.ok, false)
  assert.match(later.reason, /after the comment/)
  assert.equal(selectRuns(pull(), listing([run('ci', { conclusion: 'failure', created_at: COMMENTED_AT })])).ok, false, 'same second')
  assert.equal(selectRuns(pull(), listing([run('ci', { conclusion: 'failure', created_at: '2026-11-21T11:59:59Z' })])).ok, true)
  assert.equal(selectRuns(pull(), listing([run('ci', { conclusion: 'failure', created_at: undefined })])).ok, false)
  assert.equal(selectRuns(pull(), listing([run('ci', { conclusion: 'failure' })]), 'not a time').ok, false)
})

test('retries a commit again after earlier reruns, by anyone (run 43827172180)', () => {
  const android = run('build-android', { id: 43827172180, run_attempt: 3, conclusion: 'failure' })
  const result = selectRuns(pull(), listing([run('ci', { run_attempt: 2 }), android]))
  assert.equal(result.ok, true)
  assert.deepEqual(result.runs.map(r => r.id), [43827172180])
})

test('waits while an earlier rerun is still queued or running', () => {
  for (const status of ['queued', 'in_progress']) {
    const result = selectRuns(pull(), listing([run('ci', { status, conclusion: null, run_attempt: 2 })]))
    assert.equal(result.ok, false, status)
    assert.match(result.reason, /wait until every run has finished/, status)
  }
})

test('refuses when a workflow ran more than once on the commit', () => {
  const result = selectRuns(pull(), listing([run('ci', { conclusion: 'failure' }), run('ci', { conclusion: 'failure' })]))
  assert.equal(result.ok, false)
  assert.match(result.reason, /more than one run/)
})

test('waits for every run to finish', () => {
  const result = selectRuns(pull(), listing([
    run('ci', { conclusion: 'failure' }),
    run('build-android', { status: 'in_progress', conclusion: null }),
  ]))
  assert.equal(result.ok, false)
  assert.match(result.reason, /wait until every run has finished/)
})

test('refuses when there is nothing to retry', () => {
  for (const conclusion of ['success', 'cancelled', 'skipped', 'action_required', 'neutral']) {
    const result = selectRuns(pull(), listing([run('ci', { conclusion })]))
    assert.equal(result.ok, false, conclusion)
    assert.match(result.reason, /no failed build or test run/)
  }
  assert.match(selectRuns(pull(), listing([run('preview-web', { conclusion: 'failure' })])).reason, /no build or test run/)
})

test('refuses incomplete or oversized listings', () => {
  assert.equal(selectRuns(pull(), { total_count: 101, workflow_runs: [] }).ok, false)
  assert.equal(selectRuns(pull(), { total_count: 2, workflow_runs: [run('ci', { conclusion: 'failure' })] }).ok, false)
  assert.equal(selectRuns(pull(), {}).ok, false)
  for (const run_attempt of [undefined, 0.5, '1']) {
    assert.equal(selectRuns(pull(), listing([run('ci', { conclusion: 'failure', run_attempt })])).ok, false, String(run_attempt))
  }
  assert.equal(selectRuns(pull(), listing([null, run('ci', { conclusion: 'failure' })])).ok, false, 'null entry')
  assert.equal(selectRuns(pull(), listing([run('ci', { conclusion: 'failure', head_repository: null })])).ok, false)
})

// --- API sequence --------------------------------------------------------------

const env = {
  GH_TOKEN: 'test-token',
  REPO: 'silent-suite/silentsuite',
  PR_NUMBER: '1115',
  COMMENT_USER_ID: String(CONTRIBUTOR_ID),
  COMMENT_BODY: '/retry-ci',
  COMMENT_CREATED_AT: COMMENTED_AT,
  GITHUB_API_URL: 'https://api.example',
}

// A stateful stand-in. POST rerun-failed-jobs turns the run into its next
// attempt (queued) the way GitHub shows an accepted rerun, unless `post` says
// the change stays invisible; `finish(id, conclusion)` plays that attempt
// ending.
function fakeGitHub({
  pullAt = () => pull(),
  runs = [],
  fromBranch = [{ number: 1115 }],
  timelineAt = () => [[]],
  eventsAt = () => [[]],
  runAt = null,
  post = () => ({ accepted: true, status: 201 }),
} = {}) {
  const calls = []
  const state = new Map(runs.map(r => [r.id, { ...r }]))
  let posts = 0
  const fetchImpl = async (url, init) => {
    const path = url.replace('https://api.example', '')
    calls.push(`${init.method} ${path}`)
    assert.equal(init.headers.Authorization, 'Bearer test-token')
    assert.equal(init.headers.Accept, 'application/vnd.github+json')
    const answer = (status, body = null) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(body) })
    const query = new URL(url).searchParams
    if (init.method === 'GET' && path.endsWith('/pulls/1115')) return answer(200, pullAt(posts))
    if (init.method === 'GET' && path.includes('/pulls?')) return answer(200, fromBranch)
    if (init.method === 'GET' && path.includes('/actions/runs?')) {
      const list = [...state.values()]
      return answer(200, { total_count: list.length, workflow_runs: list })
    }
    if (init.method === 'GET' && path.includes('/timeline?')) return answer(200, timelineAt(posts)[Number(query.get('page')) - 1] ?? [])
    if (init.method === 'GET' && path.includes('/issues/1115/events?')) return answer(200, eventsAt(posts)[Number(query.get('page')) - 1] ?? [])
    const single = path.match(/\/actions\/runs\/(\d+)$/)
    if (init.method === 'GET' && single) {
      const id = Number(single[1])
      return answer(200, runAt ? runAt(id, posts, state.get(id)) : state.get(id))
    }
    const rerun = path.match(/\/actions\/runs\/(\d+)\/rerun-failed-jobs$/)
    if (init.method === 'POST' && rerun) {
      posts++
      const id = Number(rerun[1])
      const outcome = post(id)
      if (outcome.accepted && outcome.visible !== false) {
        const target = state.get(id)
        Object.assign(target, { run_attempt: target.run_attempt + 1, status: 'queued', conclusion: null })
      }
      return answer(outcome.status)
    }
    return answer(404)
  }
  const finish = (id, conclusion) => Object.assign(state.get(id), { status: 'completed', conclusion })
  return { calls, fetchImpl, state, finish }
}
const posts = github => github.calls.filter(call => call.startsWith('POST'))

// One /retry-ci comment end to end.
let slept = 0
const sleep = async () => {
  slept++
}
const comment = (github, extra = {}) => retryCi({ env: { ...env, ...extra }, fetchImpl: github.fetchImpl, sleep })

const DECIDE = [
  'GET /repos/silent-suite/silentsuite/pulls/1115',
  'GET /repos/silent-suite/silentsuite/pulls?state=all&head=intigenesis%3Afeat%2Fandroid-note-delete&per_page=100',
  `GET /repos/silent-suite/silentsuite/actions/runs?head_sha=${HEAD}&event=pull_request&per_page=100`,
  'GET /repos/silent-suite/silentsuite/issues/1115/timeline?per_page=100&page=1',
  'GET /repos/silent-suite/silentsuite/issues/1115/events?per_page=100&page=1',
]
const LIVE = id => [
  'GET /repos/silent-suite/silentsuite/pulls/1115',
  'GET /repos/silent-suite/silentsuite/issues/1115/timeline?per_page=100&page=1',
  'GET /repos/silent-suite/silentsuite/issues/1115/events?per_page=100&page=1',
  `GET /repos/silent-suite/silentsuite/actions/runs/${id}`,
]

test('reruns each failed run after re-reading the pull request and its history', async () => {
  const github = fakeGitHub({
    runs: [run('ci', { id: 11, conclusion: 'failure' }), run('build-android', { id: 12, conclusion: 'failure' }), run('ci-server', { id: 13 })],
  })
  const result = await comment(github)
  assert.equal(result.ok, true)
  assert.equal(result.sha, HEAD)
  assert.deepEqual(result.retried, [11, 12])
  assert.deepEqual(github.calls, [
    ...DECIDE,
    ...LIVE(11),
    'POST /repos/silent-suite/silentsuite/actions/runs/11/rerun-failed-jobs',
    'GET /repos/silent-suite/silentsuite/actions/runs/11',
    ...LIVE(12),
    'POST /repos/silent-suite/silentsuite/actions/runs/12/rerun-failed-jobs',
    'GET /repos/silent-suite/silentsuite/actions/runs/12',
  ])
})

test('makes no API call for a comment outside the scope', async () => {
  const github = fakeGitHub()
  for (const override of [
    { COMMENT_USER_ID: '1' },
    { COMMENT_BODY: '/retry-ci now' },
    { COMMENT_BODY: ' /retry-ci' },
    { PR_NUMBER: '0' },
    { REPO: '../x' },
  ]) {
    const result = await retryCi({ env: { ...env, ...override }, fetchImpl: github.fetchImpl })
    assert.equal(result.ok, false)
  }
  assert.deepEqual(github.calls, [])
})

test('posts nothing when any check refuses', async () => {
  const failed = () => [run('ci', { id: 31, conclusion: 'failure' })]
  const history = events => () => [events]
  const cases = {
    'another author': { pullAt: () => pull({ user: { id: 1 } }), runs: failed() },
    'earlier rerun still queued': { runs: [run('ci', { status: 'queued', conclusion: null, run_attempt: 2 })] },
    'head moved': { pullAt: () => pull({ head: { ...pull().head, sha: 'd'.repeat(40) } }), runs: failed() },
    'number mismatch': { pullAt: () => pull({ number: 1116 }), runs: failed() },
    'two pull requests from the branch': { fromBranch: [{ number: 1115 }, { number: 1001 }], runs: failed() },
    'other pull request from the branch': { fromBranch: [{ number: 1001 }], runs: failed() },
    'unreadable branch listing': { fromBranch: { message: 'not a list' }, runs: failed() },
    'retargeted (timeline)': { timelineAt: history([{ event: 'base_ref_changed', created_at: '2026-11-21T09:00:00Z' }]), runs: failed() },
    'retargeted (issue events)': { eventsAt: history([{ event: 'base_ref_changed', created_at: '2026-11-21T09:00:00Z' }]), runs: failed() },
    'force-pushed (issue events)': { eventsAt: history([{ event: 'head_ref_force_pushed', created_at: '2026-11-21T11:00:00Z' }]), runs: failed() },
    'unreadable issue events': { eventsAt: () => [{ message: 'not a list' }], runs: failed() },
    'force-pushed after CI started': { timelineAt: history([{ event: 'head_ref_force_pushed', created_at: '2026-11-21T11:00:00Z' }]), runs: failed() },
    'force-pushed in the same second': { timelineAt: history([{ event: 'head_ref_force_pushed', created_at: '2026-11-21T10:00:00Z' }]), runs: failed() },
    'unreadable timeline': { timelineAt: history([{ nope: true }]), runs: failed() },
    'endless timeline': { timelineAt: () => Array.from({ length: 11 }, () => Array.from({ length: 100 }, () => ({ event: 'commented' }))), runs: failed() },
    'malformed entry beside a valid failed run': {
      runs: [...failed(), { ...run('build-android', { conclusion: 'failure', run_attempt: 2 }), head_repository: null }],
    },
    'entry without an id': { runs: [{ ...run('ci', { conclusion: 'failure' }), id: undefined }] },
    'completed entry without a conclusion beside a failed run': { runs: [...failed(), run('ci-server', { conclusion: undefined })] },
  }
  for (const [label, state] of Object.entries(cases)) {
    const github = fakeGitHub(state)
    const result = await comment(github)
    assert.equal(result.ok, false, label)
    assert.deepEqual(result.retried, [], label)
    assert.deepEqual(posts(github), [], label)
  }
})

test('re-reads each target run right before its rerun', async () => {
  const twoRuns = () => [run('ci', { id: 81, conclusion: 'failure' }), run('build-android', { id: 82, conclusion: 'failure' })]
  const changes = {
    'rerun by a maintainer meanwhile': (id, sent, now) => (id === 82 ? { ...now, run_attempt: 2, status: 'queued', conclusion: null } : now),
    'rerun finished and failed again': (id, sent, now) => (id === 82 ? { ...now, run_attempt: 2, conclusion: 'failure' } : now),
    'now a success': (id, sent, now) => (id === 82 ? { ...now, conclusion: 'success' } : now),
    'another run answers': (id, sent, now) => (id === 82 ? { ...now, id: 83 } : now),
    unreadable: (id, sent, now) => (id === 82 ? { id: 82 } : now),
  }
  for (const [label, runAt] of Object.entries(changes)) {
    const github = fakeGitHub({ runs: twoRuns(), runAt })
    const result = await comment(github)
    assert.equal(result.ok, false, label)
    assert.deepEqual(result.retried, [81], label)
    assert.deepEqual(posts(github), ['POST /repos/silent-suite/silentsuite/actions/runs/81/rerun-failed-jobs'], label)
  }
})

test('every later comment retries again once the previous rerun has finished', async () => {
  const github = fakeGitHub({ runs: [run('ci', { id: 61, conclusion: 'failure' }), run('ci-server', { id: 62 })] })
  assert.deepEqual((await comment(github)).retried, [61])
  // While the rerun is queued, a second comment waits instead of stacking another.
  const early = await comment(github)
  assert.match(early.reason, /wait until every run has finished/)
  assert.equal(posts(github).length, 1)
  for (const attempt of [3, 4, 5]) {
    github.finish(61, 'failure')
    assert.deepEqual((await comment(github)).retried, [61])
    assert.equal(github.state.get(61).run_attempt, attempt)
  }
  github.finish(61, 'success')
  assert.match((await comment(github)).reason, /no failed build or test run/)
  assert.equal(posts(github).length, 4)
})

test('holds the lock until GitHub shows the rerun, so a later comment cannot repeat it', async () => {
  const runs = () => [run('ci', { id: 71, conclusion: 'failure' }), run('build-android', { id: 72, conclusion: 'failure' })]
  const runGets = (github, id) => github.calls.filter(call => call === `GET /repos/silent-suite/silentsuite/actions/runs/${id}`).length

  // Accepted but not shown in time: stop, report it as requested, and say to wait.
  slept = 0
  const hidden = fakeGitHub({ runs: runs(), post: () => ({ accepted: true, status: 201, visible: false }) })
  const result = await comment(hidden)
  assert.equal(result.ok, false)
  assert.match(result.reason, /does not show it yet/)
  assert.deepEqual(result.retried, [71])
  assert.equal(posts(hidden).length, 1, 'no request for the next run')
  assert.equal(runGets(hidden, 71), 1 + 20, 'one check before, twenty polls after')
  assert.equal(slept, 19)

  // An error reply whose rerun shows anyway counts as started and goes on.
  const ambiguous = fakeGitHub({ runs: runs(), post: () => ({ accepted: true, status: 502 }) })
  const started = await comment(ambiguous)
  assert.equal(started.ok, true)
  assert.deepEqual(started.retried, [71, 72])

  // An error reply with nothing shown stops as a failed request.
  const refused = fakeGitHub({ runs: runs(), post: () => ({ accepted: false, status: 502 }) })
  const failedRequest = await comment(refused)
  assert.match(failedRequest.reason, /rerun of run 71 failed/)
  assert.deepEqual(failedRequest.retried, [])
  assert.equal(posts(refused).length, 1)
})

test('accepts a force push from before CI started and a long readable timeline', async () => {
  const timeline = [
    Array.from({ length: 100 }, () => ({ event: 'commented', created_at: '2026-11-21T11:30:00Z' })),
    [{ event: 'head_ref_force_pushed', created_at: '2026-11-21T09:59:59Z' }],
  ]
  const github = fakeGitHub({ timelineAt: () => timeline, runs: [run('ci', { id: 41, conclusion: 'failure' })] })
  const result = await comment(github)
  assert.equal(result.ok, true)
  assert.deepEqual(result.retried, [41])
})

test('re-checks the live pull request and its history before every rerun', async () => {
  const twoRuns = () => [run('ci', { id: 51, conclusion: 'failure' }), run('build-android', { id: 52, conclusion: 'failure' })]
  const changes = {
    closed: { pullAt: sent => (sent === 0 ? pull() : pull({ state: 'closed' })) },
    retargeted: { pullAt: sent => (sent === 0 ? pull() : pull({ base: { ref: 'dev', repo: { id: REPOSITORY_ID } } })) },
    // Away and back: the live pull request looks identical, the history does not.
    'force-pushed away and back': {
      timelineAt: sent => (sent === 0 ? [[]] : [[{ event: 'head_ref_force_pushed', created_at: '2026-11-21T12:00:05Z' }]]),
    },
    'retargeted away and back': {
      eventsAt: sent => (sent === 0 ? [[]] : [[{ event: 'base_ref_changed', created_at: '2026-11-21T12:00:05Z' }]]),
    },
  }
  for (const [label, change] of Object.entries(changes)) {
    const github = fakeGitHub({ runs: twoRuns(), ...change })
    const result = await comment(github)
    assert.equal(result.ok, false, label)
    assert.deepEqual(result.retried, [51], label)
    assert.deepEqual(posts(github), ['POST /repos/silent-suite/silentsuite/actions/runs/51/rerun-failed-jobs'], label)
  }
})

test('stops at the first refused rerun and reports what started', async () => {
  const github = fakeGitHub({
    runs: [21, 22, 23].map((id, i) => run(['ci', 'build-android', 'ci-server'][i], { id, conclusion: 'failure' })),
    post: id => (id === 22 ? { accepted: false, status: 403 } : { accepted: true, status: 201 }),
  })
  const result = await comment(github)
  assert.equal(result.ok, false)
  assert.deepEqual(result.retried, [21])
  assert.match(result.reason, /run 22 failed/)
  assert.equal(posts(github).length, 2)
})

test('an unreadable API answer refuses before any rerun', async () => {
  const calls = []
  const failing = async (url, init) => {
    calls.push(init.method)
    return { ok: false, status: 500, json: async () => null }
  }
  await assert.rejects(retryCi({ env, fetchImpl: failing }), /answered 500/)
  assert.deepEqual(calls, ['GET'])
})

// --- workflow contracts --------------------------------------------------------

const workflowsDir = new URL('../../.github/workflows/', import.meta.url)
const read = name => readFileSync(new URL(name, workflowsDir), 'utf8')
const workflow = read('retry-ci.yml')
const code = workflow.replace(/^#.*\n/gm, '')

test('retry-ci.yml runs only on new comments, with the narrow token', () => {
  assert.match(workflow, /\non:\n {2}issue_comment:\n {4}types: \[created\]\n\npermissions: \{\}\n\njobs:\n {2}retry:\n/)
  assert.match(workflow, /\n {4}permissions:\n {6}actions: write\n {6}contents: read\n {6}pull-requests: read\n {4}concurrency:/)
  assert.equal(workflow.match(/permissions:/g).length, 2)
  assert.equal(workflow.match(/^ {2}[A-Za-z0-9_-]+:$/gm).length, 2, 'one trigger and one job at two-space indent')
})

test('retry-ci.yml gates on the contributor id before the job starts', () => {
  const gate = workflow.match(/\n {4}if: >-\n((?: {6}.+\n)+)/)
  assert.ok(gate, 'job-level if')
  assert.equal(
    gate[1],
    [
      '      github.event.issue.pull_request &&',
      `      github.event.comment.user.id == ${CONTRIBUTOR_ID} &&`,
      `      github.event.issue.user.id == ${CONTRIBUTOR_ID} &&`,
      "      startsWith(github.event.comment.body, '/retry-ci')",
      '',
    ].join('\n'),
  )
  assert.match(workflow, /\n {6}group: retry-ci\n {6}cancel-in-progress: false\n/)
})

test('retry-ci.yml runs only default-branch code and keeps the comment out of shell', () => {
  assert.match(workflow, /\n {10}ref: \$\{\{ github\.sha \}\}\n {10}persist-credentials: false\n {10}sparse-checkout: scripts\/retry-ci\n/)
  assert.deepEqual(code.match(/uses: \S+/g), [
    'uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  ])
  assert.doesNotMatch(code, /head\.(sha|ref)|refs\/pull|pull_request\.head|secrets\./)
  assert.deepEqual(code.match(/\brun: .*/g), ['run: node scripts/retry-ci/retry-ci.mjs'])
  // The comment body appears in the job gate and in the script step's env, nowhere else.
  assert.equal(code.match(/github\.event\.comment\.body/g).length, 2)
  assert.equal(code.match(/\n {10}COMMENT_BODY: \$\{\{ github\.event\.comment\.body \}\}\n/g).length, 1)
  assert.equal(code.match(/GH_TOKEN: \$\{\{ github\.token \}\}/g).length, 1, 'token only in the script step')
  assert.doesNotMatch(code, /\n {4}env:/, 'no job-level env')
  assert.doesNotMatch(code, /continue-on-error|if: always|if: failure/)
})

test('no other workflow listens to comments or holds actions: write', () => {
  for (const name of readdirSync(workflowsDir).filter(n => /\.ya?ml$/.test(n) && n !== 'retry-ci.yml')) {
    const text = read(name)
    assert.doesNotMatch(text, /issue_comment|actions:\s*write/, name)
  }
})

test('every allowlisted workflow is an unprivileged pull_request build or test', () => {
  assert.deepEqual([...ALLOWED_WORKFLOWS].sort(), [...ALLOWED_WORKFLOWS])
  for (const path of ALLOWED_WORKFLOWS) {
    assert.match(path, /^\.github\/workflows\/[a-z0-9-]+\.yml$/)
    const name = path.slice('.github/workflows/'.length)
    const text = read(name)
    assert.match(text, /\n {2}pull_request:\n {4}branches: \[main\]\n/, `${name} runs on pull_request to main only`)
    assert.doesNotMatch(text, /head\.repo\.(full_name|fork)/, `${name} must run for forks`)
    assert.doesNotMatch(text, /pull_request_target|workflow_run|^\s*environment:/m, name)
    const secrets = [...text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(m => m[1]).filter(s => s !== 'GITHUB_TOKEN')
    assert.deepEqual(secrets, [], `${name} uses no repository secrets`)
  }
  for (const excluded of ['preview-web.yml', 'commit-metadata.yml', 'ci-umbrel-candidate.yml', 'retry-ci.yml']) {
    assert.ok(!ALLOWED_WORKFLOWS.includes(`.github/workflows/${excluded}`), excluded)
  }
})
