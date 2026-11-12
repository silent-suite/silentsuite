// Release eligibility: which published GitHub releases may reach Zapstore.
//
// Allowed: stable `vX.Y.Z`, `vX.Y.Z-beta` and follow-up betas `vX.Y.Z-beta.N`
// with 2 <= N <= 999 written without leading zeros (the cap keeps Number()
// exact, so the order stays total). A plain `-beta` is the first beta
// of its version, so `-beta.1` (and `-beta.0`, `-beta.02`) are refused: each
// position in the order has exactly one spelling. A beta tag is allowed whether
// or not GitHub flags it as a prerelease (existing beta releases carry
// prerelease=false). Everything else, including drafts and other prerelease
// suffixes (rc, alpha, free text), is refused. The relay channel stays `main`
// for all of them, which is the current published behaviour; changing it is a
// separate policy decision.

export const TAG_GRAMMAR = /^v(\d+)\.(\d+)\.(\d+)(-beta(?:\.([2-9]|[1-9]\d{1,2}))?)?$/
export const CHANNEL = 'main'

export function classifyRelease(release) {
  if (!release || typeof release !== 'object') return refuse('release is not an object')
  if (!Number.isInteger(release.id) || release.id <= 0) return refuse('release id is not a positive integer')
  if (typeof release.tag_name !== 'string') return refuse('release has no tag_name')
  if (release.draft === true) return refuse('draft releases are never published', release)
  const match = TAG_GRAMMAR.exec(release.tag_name)
  if (!match) return refuse('tag is outside the vX.Y.Z / vX.Y.Z-beta / vX.Y.Z-beta.N grammar', release)
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

// Owner-retired historical failures (2026-10-13). These exact
// release-specific CDN/publication failures were retired by the owner as
// superseded history and their issues were closed as not planned, so neither
// reconciliation nor failure notification may bring them up again.
// Retirement binds the exact numeric release id AND tag together — either
// alone is a different release, judged by the normal rules — and it applies
// unconditionally, including to a tuple the listing marks as the newest
// eligible release: it never marks an alternate publishable, and it never
// repairs, republishes or re-verifies anything.
export const RETIRED_HISTORICAL_FAILURES = [
  { releaseId: 375729540, tag: 'v0.5.2-beta' },
  { releaseId: 376457006, tag: 'v0.5.3-beta' },
  { releaseId: 403051319, tag: 'v0.5.11-beta' },
]

// Release ids arrive as numbers in the GitHub listing and as canonical decimal
// strings in CLI and matrix output. A malformed spelling is not an alias.
function canonicalReleaseId(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const text = String(value)
  return /^[1-9][0-9]{0,15}$/.test(text) ? text : null
}

export function retiredHistoricalReason(releaseId, tag) {
  if (typeof tag !== 'string') return null
  const id = canonicalReleaseId(releaseId)
  if (id === null) return null
  return RETIRED_HISTORICAL_FAILURES.some((entry) => String(entry.releaseId) === id && entry.tag === tag)
    ? `retired historical failure (release ${id} ${tag}): closed as not planned; not reconciled or notified`
    : null
}

// Scheduled reconciliation candidates. The newest eligible release is always a
// candidate by exact id, however old: it is the only release that can ever be
// published, so it must be retried deterministically by every run until the
// relay holds it. The `windowDays` bound applies only to verify-only history;
// older releases are listed as omitted with a reason so the report never
// silently drops anything. Owner-retired historical failures (above) are
// omitted unconditionally and are never reconciled again; if that leaves no
// publishable candidate, none is chosen.
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
    // Publishability is fixed by the full listing above, before retirement
    // applies, so omitting retired history never promotes an alternate. The
    // retirement decision is unconditional: it covers a tuple the listing
    // marked as the newest eligible release, which then leaves no publishable
    // candidate.
    const retired = retiredHistoricalReason(verdict.releaseId, verdict.tag)
    if (retired) {
      omitted.push({ releaseId: verdict.releaseId, tag: verdict.tag, reason: retired })
      continue
    }
    if (!verdict.publishable && Date.parse(verdict.publishedAt) < cutoff) {
      omitted.push({ releaseId: verdict.releaseId, tag: verdict.tag, reason: `verify-only history published before the ${windowDays}-day window` })
      continue
    }
    candidates.push(verdict)
  }
  candidates.sort((a, b) => a.releaseId - b.releaseId)
  return { candidates, omitted }
}

// Numeric tag order: vX.Y.Z-beta < vX.Y.Z-beta.2 < vX.Y.Z-beta.10 < vX.Y.Z.
// A plain -beta ranks as beta 1; the stable release outranks every beta.
export function compareTags(a, b) {
  const pa = TAG_GRAMMAR.exec(a)
  const pb = TAG_GRAMMAR.exec(b)
  if (!pa || !pb) throw new Error(`cannot order tags outside the release grammar: ${a}, ${b}`)
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(pa[i]) - Number(pb[i])
    if (d !== 0) return d
  }
  // Compared rather than subtracted: two stable ranks are both Infinity.
  const ra = betaRank(pa)
  const rb = betaRank(pb)
  return ra === rb ? 0 : ra < rb ? -1 : 1
}

function betaRank(match) {
  if (!match[4]) return Number.POSITIVE_INFINITY
  return match[5] ? Number(match[5]) : 1
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
