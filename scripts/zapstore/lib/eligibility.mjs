// Release eligibility: which published GitHub releases may reach Zapstore.
//
// Allowed: stable `vX.Y.Z` and `vX.Y.Z-beta`. A `-beta` tag is allowed whether
// or not GitHub flags it as a prerelease (existing beta releases carry
// prerelease=false). Everything else, including drafts and other prerelease
// suffixes, is refused. The relay channel stays `main` for both, which is the
// current published behaviour; changing it is a separate policy decision.

export const TAG_GRAMMAR = /^v(\d+)\.(\d+)\.(\d+)(-beta)?$/
export const CHANNEL = 'main'

export function classifyRelease(release) {
  if (!release || typeof release !== 'object') return refuse('release is not an object')
  if (!Number.isInteger(release.id) || release.id <= 0) return refuse('release id is not a positive integer')
  if (typeof release.tag_name !== 'string') return refuse('release has no tag_name')
  if (release.draft === true) return refuse('draft releases are never published', release)
  const match = TAG_GRAMMAR.exec(release.tag_name)
  if (!match) return refuse('tag is outside the vX.Y.Z / vX.Y.Z-beta grammar', release)
  const beta = Boolean(match[4])
  if (release.prerelease === true && !beta) return refuse('GitHub prerelease without a -beta tag', release)
  if (typeof release.published_at !== 'string' || release.published_at === '') return refuse('release is not published', release)
  return {
    eligible: true,
    releaseId: release.id,
    tag: release.tag_name,
    version: release.tag_name.slice(1),
    kind: beta ? 'beta' : 'stable',
    githubPrerelease: release.prerelease === true,
    channel: CHANNEL,
    publishedAt: release.published_at,
  }
}

function refuse(reason, release) {
  return {
    eligible: false,
    reason,
    releaseId: release && Number.isInteger(release.id) ? release.id : null,
    tag: release && typeof release.tag_name === 'string' ? release.tag_name : null,
  }
}

// Scheduled reconciliation candidates. The newest eligible release is always a
// candidate by exact id, however old: it is the only release that can ever be
// published, so it must be retried deterministically by every run until the
// relay holds it. The `windowDays` bound applies only to verify-only history;
// older releases are listed as omitted with a reason so the report never
// silently drops anything.
export function selectScheduleCandidates(releases, { now = Date.now(), windowDays = 45 } = {}) {
  const cutoff = now - windowDays * 24 * 60 * 60 * 1000
  const eligible = []
  const omitted = []
  for (const release of releases) {
    const verdict = classifyRelease(release)
    if (verdict.eligible) eligible.push(verdict)
    else omitted.push({ releaseId: verdict.releaseId, tag: verdict.tag, reason: verdict.reason })
  }
  const marked = markPublishable(eligible)
  const candidates = []
  for (const verdict of marked) {
    if (!verdict.publishable && Date.parse(verdict.publishedAt) < cutoff) {
      omitted.push({ releaseId: verdict.releaseId, tag: verdict.tag, reason: `verify-only history published before the ${windowDays}-day window` })
      continue
    }
    candidates.push(verdict)
  }
  candidates.sort((a, b) => a.releaseId - b.releaseId)
  return { candidates, omitted }
}

// Numeric tag order: vX.Y.Z-beta sorts below the same vX.Y.Z stable.
export function compareTags(a, b) {
  const pa = TAG_GRAMMAR.exec(a)
  const pb = TAG_GRAMMAR.exec(b)
  if (!pa || !pb) throw new Error(`cannot order tags outside the release grammar: ${a}, ${b}`)
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(pa[i]) - Number(pb[i])
    if (d !== 0) return d
  }
  return (pa[4] ? 0 : 1) - (pb[4] ? 0 : 1)
}

// Exactly one candidate, the newest eligible tag, may ever be published; every
// other candidate is verify-only. Two releases with one tag cannot both be
// published, so equal tags are refused rather than guessed at.
export function markPublishable(candidates) {
  if (candidates.length === 0) return candidates
  let newest = candidates[0]
  for (const candidate of candidates.slice(1)) {
    const order = compareTags(candidate.tag, newest.tag)
    if (order === 0) throw new Error(`two eligible releases share tag ${candidate.tag}: ${newest.releaseId} and ${candidate.releaseId}`)
    if (order > 0) newest = candidate
  }
  return candidates.map((candidate) => ({ ...candidate, publishable: candidate === newest }))
}
