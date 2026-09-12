// Failure notification as a GitHub issue, created by an isolated job holding
// only `issues: write`, then read back and compared.

import { TAG_GRAMMAR } from './eligibility.mjs'
import { redact } from './redact.mjs'

export const ISSUE_LABEL = 'zapstore-automation'

const cleanText = (value, max) => redact(String(value ?? ''))
  .replace(/[^\P{C}\n]/gu, '')
  .replace(/```/g, '` ` `')
  .slice(0, max)

export function publicationClaim({ publishAttempted, signExit, readbackOutcome }) {
  if (!publishAttempted) {
    if (readbackOutcome === 'complete-match') return 'already-published'
    return 'not-attempted'
  }
  if (readbackOutcome === 'complete-match') return 'published'
  if (signExit === 0 && readbackOutcome === 'partial') return 'partial'
  return 'unknown'
}

export function retryInstructions({ releaseId, tag, sourceSha }) {
  const safeTag = typeof tag === 'string' && TAG_GRAMMAR.test(tag) ? tag : '<tag>'
  const safeId = /^[1-9][0-9]{0,15}$/.test(String(releaseId)) ? String(releaseId) : '<release-id>'
  const sha = typeof sourceSha === 'string' && /^[0-9a-f]{40}$/.test(sourceSha) ? sourceSha : '<40-hex tag commit>'
  return [
    'This lane has no repository_dispatch or workflow_dispatch retry (those would be a second control plane or a selected-ref load).',
    'Exact retry of this release: wait for the next protected-main schedule (04:17 UTC), or as the owner edit the GitHub release so GitHub delivers release: edited. The workflow YAML is loaded from the default branch and the job checks out refs/heads/main, never the tag.',
    `  tag ${safeTag}`,
    `  GitHub release id ${safeId}`,
    `  source commit ${sha}`,
    'Owner-only, string fields only:',
    `gh api repos/silent-suite/silentsuite/releases/${safeId} -X PATCH -f tag_name='${safeTag}'`,
  ].join('\n')
}

export function buildIssue({ releaseId, tag, sourceSha, runUrl, phase, outcome, detail, publication, retry }) {
  const safeTag = typeof tag === 'string' && TAG_GRAMMAR.test(tag) ? tag : '[tag failed validation]'
  const safeId = /^[1-9][0-9]{0,15}$/.test(String(releaseId)) ? String(releaseId) : '[unknown]'
  const safeSha = typeof sourceSha === 'string' && /^[0-9a-f]{40}$/.test(sourceSha) ? sourceSha : '[source sha unknown]'
  const safeRun = typeof runUrl === 'string' && /^https:\/\/github\.com\/silent-suite\/silentsuite\/actions\/runs\/[0-9]+(\/attempts\/[0-9]+)?$/.test(runUrl) ? runUrl : '[run url failed validation]'
  const safePhase = cleanText(phase, 60).replace(/[^a-z0-9 _-]/gi, '')
  const safeOutcome = cleanText(outcome, 40).replace(/[^a-z0-9-]/gi, '')
  const claim = publication || 'unknown'
  const title = `Zapstore publication failed: ${safeTag} (release ${safeId})`
  const claimLine = {
    'already-published': 'Relay read-back already reports a complete match; this failure is after publication.',
    'published': 'Read-back reports the exact set is now on the relay.',
    'partial': 'Read-back reports a partial set. Treat relay/CDN state as incomplete, not absent.',
    'not-attempted': 'No signer/upload attempt ran for this candidate.',
    'unknown': 'Publication state is unknown: a signer/upload attempt may have written events. Do not assume nothing was published.',
  }[claim] || 'Publication state is unknown. Do not assume nothing was published.'
  const body = [
    '## Zapstore publication did not complete',
    '',
    claimLine,
    '',
    `- Release: ${safeTag} (GitHub release id ${safeId})`,
    `- Source commit: ${safeSha}`,
    `- Run: ${safeRun}`,
    `- Phase: ${safePhase || '[unknown]'}`,
    `- Outcome: ${safeOutcome || '[unknown]'}`,
    `- Publication claim: ${claim}`,
    '',
    '### Detail (untrusted text, quoted)',
    '',
    '```text',
    cleanText(detail, 1500) || '[no detail]',
    '```',
    '',
    '### Exact retry',
    '',
    'Follow `runbooks/zapstore-automation.md` section 5 for the outcome above.',
    '',
    '```',
    retry || retryInstructions({ releaseId: safeId === '[unknown]' ? '' : safeId, tag: safeTag === '[tag failed validation]' ? '' : safeTag, sourceSha: safeSha === '[source sha unknown]' ? '' : safeSha }),
    '```',
  ].join('\n')
  return { title, body, labels: [ISSUE_LABEL] }
}

async function githubJson(fetchImpl, url, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'silentsuite-zapstore-lane' }
  if (body) headers['Content-Type'] = 'application/json'
  const response = await fetchImpl(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
  return { status: response.status, json: await response.json().catch(() => ({})) }
}

export async function findOpenIssueWithTitle({ fetchImpl = globalThis.fetch, token, repository = 'silent-suite/silentsuite', apiBase = 'https://api.github.com', title }) {
  const url = `${apiBase}/repos/${repository}/issues?labels=${encodeURIComponent(ISSUE_LABEL)}&state=open&per_page=100`
  const { status, json } = await githubJson(fetchImpl, url, { token })
  if (status !== 200 || !Array.isArray(json)) throw new Error(`open-issue listing returned ${status}`)
  return json.find((issue) => issue.title === title) ?? null
}

export async function createIssueWithReadback({ fetchImpl = globalThis.fetch, token, repository = 'silent-suite/silentsuite', apiBase = 'https://api.github.com', issue }) {
  const existing = await findOpenIssueWithTitle({ fetchImpl, token, repository, apiBase, title: issue.title })
  if (existing) return { number: existing.number, url: existing.html_url, deduped: true }
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'silentsuite-zapstore-lane', 'Content-Type': 'application/json' }
  const created = await fetchImpl(`${apiBase}/repos/${repository}/issues`, { method: 'POST', headers, body: JSON.stringify(issue) })
  if (created.status !== 201) throw new Error(`issue creation returned ${created.status}`)
  const { number } = await created.json()
  if (!Number.isInteger(number)) throw new Error('issue creation returned no number')
  const back = await fetchImpl(`${apiBase}/repos/${repository}/issues/${number}`, { headers })
  if (back.status !== 200) throw new Error(`issue read-back returned ${back.status}`)
  const stored = await back.json()
  if (stored.title !== issue.title || stored.body !== issue.body) throw new Error(`issue #${number} read back with different content`)
  return { number, url: stored.html_url, deduped: false }
}
