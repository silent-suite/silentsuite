// Pure decisions for the Google Play publication lane. Release eligibility and
// tag order are the Zapstore lane's (scripts/zapstore/lib/eligibility.mjs), so
// both stores agree on which GitHub release is the newest one.

import { classifyRelease, markPublishable } from '../../zapstore/lib/eligibility.mjs'

export const PLAY_NOTES_LIMIT = 500
export const TRACK = 'production'

// The newest eligible published release, or null. Drafts and tags outside the
// release grammar never qualify.
export function newestRelease(releases) {
  const eligible = releases.map(classifyRelease).filter((verdict) => verdict.eligible)
  return markPublishable(eligible).find((verdict) => verdict.publishable) ?? null
}

// The tag's own android/app/build.gradle must name exactly one versionCode and a
// versionName equal to the tag without its leading "v".
export function versionFromGradle(text, tag) {
  const codes = [...text.matchAll(/^\s*versionCode\s+(\d+)\s*$/gm)]
  const names = [...text.matchAll(/^\s*versionName\s+"([^"]+)"\s*$/gm)]
  if (codes.length !== 1 || names.length !== 1) throw new Error(`expected one versionCode and one versionName in build.gradle at ${tag}`)
  const versionCode = Number(codes[0][1])
  const versionName = names[0][1]
  if (!Number.isSafeInteger(versionCode) || versionCode <= 0) throw new Error(`invalid versionCode at ${tag}`)
  if (versionName !== tag.slice(1)) throw new Error(`versionName ${versionName} does not match tag ${tag}`)
  return { versionCode, versionName }
}

export function releaseNotes(text, versionCode) {
  const notes = (text ?? '').trim()
  if (notes === '') throw new Error(`release notes for versionCode ${versionCode} are empty`)
  if ([...notes].length > PLAY_NOTES_LIMIT) throw new Error(`release notes for versionCode ${versionCode} exceed Play's ${PLAY_NOTES_LIMIT} characters`)
  return notes
}

// What the production track already says about this versionCode.
//   present    - some production release (any status) already lists it
//   superseded - production already lists a higher versionCode
//   publish    - neither; this run may add it
export function trackDecision(tracks, versionCode) {
  const production = tracks.find((track) => track.track === TRACK)
  const releases = production?.releases ?? []
  const codes = releases.flatMap((release) => (release.versionCodes ?? []).map(Number))
  const holding = releases.find((release) => (release.versionCodes ?? []).map(Number).includes(versionCode))
  if (holding) return { action: 'present', status: holding.status ?? 'unknown' }
  const highest = codes.length ? Math.max(...codes) : null
  if (highest !== null && highest > versionCode) return { action: 'superseded', highest }
  return { action: 'publish', highest }
}

export function productionRelease({ versionCode, versionName, notes }) {
  return {
    name: `${versionCode} (${versionName})`,
    versionCodes: [String(versionCode)],
    status: 'completed',
    releaseNotes: [{ language: 'en-US', text: notes }],
  }
}
