// Failure notification as a GitHub issue, created by an isolated job holding
// only `issues: write`, then read back and compared.

import { TAG_GRAMMAR } from './eligibility.mjs'
import { redact } from './redact.mjs'

export const ISSUE_LABEL = 'zapstore-automation'

const cleanText = (value, max) => redact(String(value ?? ''))
  .replace(/[^\P{C}\n]/gu, '')
  .replace(/```/g, '` ` `')
  .slice(0, max)

export function buildIssue({ releaseId, tag, runUrl, phase, outcome, detail, retry }) {
  const safeTag = typeof tag === 'string' && TAG_GRAMMAR.test(tag) ? tag : '[tag failed validation]'
  const safeId = /^[0-9]+$/.test(String(releaseId)) ? String(releaseId) : '[unknown]'
  const safeRun = typeof runUrl === 'string' && /^https:\/\/github\.com\/silent-suite\/silentsuite\/actions\/runs\/[0-9]+(\/attempts\/[0-9]+)?$/.test(runUrl) ? runUrl : '[run url failed validation]'
  const safePhase = cleanText(phase, 60).replace(/[^a-z0-9 _-]/gi, '')
  const safeOutcome = cleanText(outcome, 40).replace(/[^a-z0-9-]/gi, '')
  const title = `Zapstore publication failed: ${safeTag} (release ${safeId})`
  const body = [
    '## Zapstore publication did not complete',
    '',
    'Nothing was published for this release unless the read-back section of the run says otherwise.',
    '',
    `- Release: ${safeTag} (GitHub release id ${safeId})`,
    `- Run: ${safeRun}`,
    `- Phase: ${safePhase || '[unknown]'}`,
    `- Outcome: ${safeOutcome || '[unknown]'}`,
    '',
    '### Detail (untrusted text, quoted)',
    '',
    '```text',
    cleanText(detail, 1500) || '[no detail]',
    '```',
    '',
    '### Exact retry',
    '',
    'Follow `runbooks/zapstore-automation.md` section 5 for the outcome above. To retry exactly this release after the cause is fixed:',
    '',
    '```',
    ...(retry ? [cleanText(retry, 600)] : [
      'gh api repos/silent-suite/silentsuite/dispatches \\',
      '  -f event_type=silentsuite_zapstore_publish \\',
      `  -F 'client_payload[release_id]=${safeId}' \\`,
      `  -F 'client_payload[release_tag]=${safeTag}' \\`,
      "  -F 'client_payload[source_sha]=<40-hex tag commit>'",
    ]),
    '```',
  ].join('\n')
  return { title, body, labels: [ISSUE_LABEL] }
}

export async function createIssueWithReadback({ fetchImpl = globalThis.fetch, token, repository = 'silent-suite/silentsuite', apiBase = 'https://api.github.com', issue }) {
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'silentsuite-zapstore-lane', 'Content-Type': 'application/json' }
  const created = await fetchImpl(`${apiBase}/repos/${repository}/issues`, { method: 'POST', headers, body: JSON.stringify(issue) })
  if (created.status !== 201) throw new Error(`issue creation returned ${created.status}`)
  const { number } = await created.json()
  if (!Number.isInteger(number)) throw new Error('issue creation returned no number')
  const back = await fetchImpl(`${apiBase}/repos/${repository}/issues/${number}`, { headers })
  if (back.status !== 200) throw new Error(`issue read-back returned ${back.status}`)
  const stored = await back.json()
  if (stored.title !== issue.title || stored.body !== issue.body) throw new Error(`issue #${number} read back with different content`)
  return { number, url: stored.html_url }
}
