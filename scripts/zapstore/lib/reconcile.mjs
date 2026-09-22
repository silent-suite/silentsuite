// Relay-first reconciliation.
//
// Input: the three *expected* events (official zsp, unsigned offline mode, from
// the exact local APK and trusted metadata) and the observed relay events for
// this publisher and package. Output, one of:
//   complete-match    this lane's exact set exists (full ordered tuple equality)
//   legacy-complete   a pre-lane set (APK without a commit tag) whose identity
//                     tuple matches and whose release links it; never rewritten
//   absent            nothing for this version; app metadata absent or equal
//   app-drift         app metadata on the relay differs from the template
//   partial           some of the set exists. `recoverable` is true only when
//                     no accepted APK event exists for this version: the
//                     official publisher regenerates the whole set, so a
//                     present immutable APK could never be reused and would be
//                     duplicated (upstream events.go BuildEventSet, relay.go
//                     PublishEventSet; a local source carries no timestamp)
//   conflict          same version, different bytes, tuples or links
//   superseded        nothing for this version; a newer version_code exists
// Anything with an invalid signature or id throws before a verdict.
//
// Permitted differences between expected and observed events are exactly id,
// sig, created_at and the release `e` tuple's event id (runbook section 1.4).

import { KINDS, tagValue, tagValues, verifyEvent } from './nostr.mjs'

export const LEGACY_APK_IDENTITY = ['i', 'x', 'version', 'version_code', 'size', 'm', 'url', 'apk_certificate_hash']
export const LEGACY_RELEASE_IDENTITY = ['i', 'version', 'd', 'c']

const tagJson = (tag) => JSON.stringify(tag)

export function compareExact(expected, observed, label, { substitute = (tag) => tag } = {}) {
  const diffs = []
  if (observed.content !== expected.content) diffs.push(`${label}.content`)
  const exp = expected.tags.map(substitute)
  const obs = observed.tags
  for (let i = 0; i < Math.max(exp.length, obs.length); i += 1) {
    const e = exp[i]
    const o = obs[i]
    if (e === undefined) diffs.push(`${label}.tags[${i}] extra ${tagJson(o)}`)
    else if (o === undefined) diffs.push(`${label}.tags[${i}] missing ${tagJson(e)}`)
    else if (tagJson(e) !== tagJson(o)) diffs.push(`${label}.tags[${i}] expected ${tagJson(e)} observed ${tagJson(o)}`)
  }
  return diffs
}

export const compareApk = (expected, observed) => compareExact(expected, observed, 'apk')
export const compareApp = (expected, observed) => compareExact(expected, observed, 'app')
export const compareRelease = (expected, observed, apkEventId) => compareExact(expected, observed, 'release', {
  substitute: (tag) => (tag[0] === 'e' ? [tag[0], apkEventId, ...tag.slice(2)] : tag),
})

// Pre-lane events were published by hand from a GitHub release source, so an
// APK may carry the original download URL beside the CDN URL. The CDN URL (the
// hash-addressed one the lane verifies) must be present; every other identity
// field must be exactly one equal value.
function compareIdentity(expected, observed, fields, label) {
  const diffs = []
  for (const field of fields) {
    const e = tagValues(expected, field)
    const o = tagValues(observed, field)
    if (field === 'url') {
      if (e.length !== 1 || !o.includes(e[0])) diffs.push(`${label}.url`)
      continue
    }
    if (e.length !== 1 || o.length !== 1) diffs.push(`${label}.${field}.cardinality`)
    else if (e[0] !== o[0]) diffs.push(`${label}.${field}`)
  }
  return diffs
}

export function expectedSet(events) {
  const byKind = new Map(events.map((event) => [event.kind, event]))
  for (const kind of Object.values(KINDS)) if (!byKind.has(kind)) throw new Error(`expected event set is missing kind ${kind}`)
  if (events.length !== 3) throw new Error(`expected exactly three events, got ${events.length}`)
  return { app: byKind.get(KINDS.APP), release: byKind.get(KINDS.RELEASE), apk: byKind.get(KINDS.APK) }
}

function newestVersionCode(apks) {
  return Math.max(0, ...apks.map((event) => Number(tagValue(event, 'version_code')) || 0))
}

export function assessRelayState({ expected, observed, schnorr }) {
  const { app: expApp, release: expRelease, apk: expApk } = expected
  const pubkey = expApk.pubkey
  const packageId = tagValue(expApk, 'i')
  const version = tagValue(expApk, 'version')
  const versionCode = Number(tagValue(expApk, 'version_code'))
  const expectedHash = tagValue(expApk, 'x')

  for (const event of observed) verifyEvent(event, schnorr)
  const ours = observed.filter((event) => event.pubkey === pubkey)
  const foreign = observed.length - ours.length

  const apks = ours.filter((e) => e.kind === KINDS.APK && tagValue(e, 'i') === packageId)
  const releases = ours.filter((e) => e.kind === KINDS.RELEASE && tagValue(e, 'i') === packageId)
  const apps = ours.filter((e) => e.kind === KINDS.APP && tagValue(e, 'd') === packageId).sort((a, b) => b.created_at - a.created_at)
  const app = apps[0] ?? null
  const newest = newestVersionCode(apks)
  const base = { foreign, newestVersionCode: newest, candidateVersionCode: versionCode }
  const verdict = (outcome, detail, extra = {}) => ({ outcome, detail, ...base, ...extra })

  const sameVersionApks = apks.filter((e) => tagValue(e, 'version') === version)
  const sameVersionReleases = releases.filter((e) => tagValue(e, 'd') === tagValue(expRelease, 'd'))
  if (sameVersionReleases.length > 1) {
    return verdict('conflict', `relay returned ${sameVersionReleases.length} release events for ${tagValue(expRelease, 'd')}; a replaceable event must be unique`, { present: { release: sameVersionReleases.map((e) => e.id) } })
  }
  const release = sameVersionReleases[0] ?? null
  const appDiffs = app ? compareApp(expApp, app) : []
  const ids = (events) => events.map((e) => e.id).join(', ')

  if (sameVersionApks.length === 0 && !release) {
    if (newest > versionCode) return verdict('superseded', `no events for ${version} (code ${versionCode}); relay already carries version_code ${newest}`)
    if (app && appDiffs.length) return verdict('app-drift', `app metadata on the relay differs from the trusted template: ${appDiffs.join('; ')}`, { present: { app: app.id }, appDiffs })
    return verdict('absent', app ? 'no release or APK for this version; app metadata equals the trusted template' : 'no events for this package', { present: { app: app?.id } })
  }

  const conflicting = sameVersionApks.filter((e) => tagValue(e, 'x') !== expectedHash)
  if (conflicting.length) return verdict('conflict', `relay has ${conflicting.length} APK event(s) for ${version} with a different hash: ${ids(conflicting)}`, { present: { apk: ids(conflicting) } })

  const matching = sameVersionApks
  const withoutCommit = matching.filter((e) => tagValues(e, 'commit').length === 0)
  const legacy = matching.length > 0 && withoutCommit.length === matching.length
  if (matching.length > 0 && !legacy && withoutCommit.length > 0) {
    return verdict('conflict', `relay mixes lane and pre-lane APK events for ${version}: ${ids(matching)}`, { present: { apk: ids(matching) } })
  }

  if (matching.length > 0 && !legacy) {
    if (matching.length > 1) return verdict('conflict', `relay has ${matching.length} APK events for ${version} with the expected hash; the lane publishes exactly one: ${ids(matching)}`, { present: { apk: ids(matching) } })
    const apk = matching[0]
    const present = { apk: apk.id, release: release?.id, app: app?.id }
    const apkDiffs = compareApk(expApk, apk)
    if (apkDiffs.length) return verdict('conflict', `published APK differs from the verified candidate: ${apkDiffs.join('; ')}`, { present })
    if (!release) return verdict('partial', `present: apk ${apk.id}${app ? `, app ${app.id}` : ''}; missing: release${app ? '' : ', app'}; the accepted APK event cannot be reused by the official publisher`, { present, missing: app ? ['release'] : ['release', 'app'], recoverable: false })
    const linked = tagValues(release, 'e')
    if (linked.length !== 1 || linked[0] !== apk.id) return verdict('conflict', `release ${release.id} e-links [${linked.join(', ')}], expected exactly the matching APK ${apk.id}`, { present })
    const releaseDiffs = compareRelease(expRelease, release, apk.id)
    if (releaseDiffs.length) return verdict('conflict', `published release differs from the verified candidate: ${releaseDiffs.join('; ')}`, { present })
    if (!app) return verdict('partial', `present: apk ${apk.id}, release ${release.id}; missing: app; the accepted APK event cannot be reused by the official publisher`, { present, missing: ['app'], recoverable: false })
    if (appDiffs.length) return verdict('app-drift', `release and APK match; app metadata on the relay differs from the trusted template: ${appDiffs.join('; ')}`, { present, appDiffs })
    return verdict('complete-match', 'release, APK and app metadata already published and verified tuple for tuple', { present })
  }

  if (legacy) {
    const bad = matching.map((e) => [e, compareIdentity(expApk, e, LEGACY_APK_IDENTITY, 'apk')]).filter(([, diffs]) => diffs.length)
    if (bad.length) return verdict('conflict', `pre-lane APK identity differs: ${bad.map(([e, diffs]) => `${e.id}: ${diffs.join(', ')}`).join('; ')}`, { present: { apk: ids(matching) } })
    if (!release) return verdict('partial', `present: pre-lane apk ${ids(matching)}${app ? `, app ${app.id}` : ''}; missing: release${app ? '' : ', app'}; the accepted APK event cannot be reused by the official publisher`, { present: { apk: ids(matching), app: app?.id }, missing: app ? ['release'] : ['release', 'app'], recoverable: false })
    const linked = tagValues(release, 'e')
    if (linked.length !== 1) return verdict('conflict', `release ${release.id} e-link cardinality is ${linked.length}, expected exactly one APK reference`, { present: { apk: ids(matching), release: release.id, app: app?.id } })
    const apk = matching.find((e) => e.id === linked[0])
    if (!apk) return verdict('conflict', `release ${release.id} e-link ${linked[0]} does not select a matching APK (${ids(matching)})`, { present: { apk: ids(matching), release: release.id, app: app?.id } })
    const releaseDiffs = compareIdentity(expRelease, release, LEGACY_RELEASE_IDENTITY, 'release')
    if (releaseDiffs.length) return verdict('conflict', `pre-lane release identity differs: ${releaseDiffs.join(', ')}`, { present: { apk: apk.id, release: release.id, app: app?.id } })
    const present = { apk: apk.id, release: release.id, app: app?.id }
    if (!app) return verdict('partial', `present: pre-lane apk ${apk.id}, release ${release.id}; missing: app; the accepted APK event cannot be reused by the official publisher`, { present, missing: ['app'], recoverable: false })
    if (appDiffs.length) return verdict('app-drift', `pre-lane release and APK verified; app metadata on the relay differs from the trusted template: ${appDiffs.join('; ')}`, { present, appDiffs })
    return verdict('legacy-complete', `pre-lane publication verified: ${matching.length} APK event(s) with the expected hash, release links ${apk.id}; never rewritten`, { present, duplicateApks: matching.length - 1 })
  }

  // Release present, no APK event for this version. Nothing immutable exists
  // to preserve, so one publisher run can complete the set: the regenerated
  // release supersedes this one (same d tag, newer created_at) and links the
  // new APK event. The present events must already equal the expected tuples,
  // the e-link excepted because its target is missing.
  const linked = tagValues(release, 'e')
  const pointed = ours.filter((event) => linked.includes(event.id) && event.kind === KINDS.APK)
  if (pointed.length) return verdict('conflict', `release ${release.id} references APK ${ids(pointed)} which is not the verified candidate`, { present: { release: release.id, app: app?.id } })
  const present = { release: release.id, app: app?.id }
  if (linked.length !== 1) return verdict('conflict', `release ${release.id} e-links [${linked.join(', ')}], expected exactly one APK reference`, { present })
  const releaseDiffs = compareRelease(expRelease, release, linked[0])
  if (releaseDiffs.length) return verdict('conflict', `published release differs from the verified candidate: ${releaseDiffs.join('; ')}`, { present })
  if (app && appDiffs.length) return verdict('app-drift', `release present without its APK; app metadata on the relay differs from the trusted template: ${appDiffs.join('; ')}`, { present, appDiffs })
  if (newest > versionCode) return verdict('partial', `present: release ${release.id}${app ? `, app ${app.id}` : ''}; missing: apk; relay already carries version_code ${newest}, recovery would regress the listing`, { present, missing: ['apk'], recoverable: false })
  return verdict('partial', `present: release ${release.id}${app ? `, app ${app.id}` : ''}; missing: apk${app ? '' : ', app'}; no accepted APK event exists, one publisher run completes the set`, { present, missing: app ? ['apk'] : ['apk', 'app'], recoverable: true })
}

// publishable: this candidate is the newest eligible published GitHub release.
export function publicationAction({ assessment, publishable }) {
  const newest = publishable === true || publishable === 'true'
  switch (assessment.outcome) {
    case 'complete-match':
    case 'legacy-complete':
      return { action: 'skip', reason: assessment.outcome, verifyCdn: true }
    case 'absent':
      if (newest) return { action: 'publish', reason: 'absent', verifyCdn: false }
      return { action: 'skip', reason: 'not-newest-eligible', verifyCdn: false }
    case 'superseded':
      return { action: 'skip', reason: 'superseded', verifyCdn: false }
    case 'app-drift':
      if (newest) return { action: 'fail', reason: 'app-drift', verifyCdn: false }
      return { action: 'skip', reason: 'app-drift-reported', verifyCdn: false }
    case 'partial':
      if (assessment.recoverable !== true) return { action: 'fail', reason: 'partial-unrecoverable', verifyCdn: false }
      if (newest) return { action: 'publish', reason: 'partial-recovery', verifyCdn: false }
      return { action: 'fail', reason: 'partial-not-newest', verifyCdn: false }
    case 'incomplete':
      return { action: 'fail', reason: 'incomplete', verifyCdn: false }
    case 'conflict':
      return { action: 'fail', reason: 'conflict', verifyCdn: false }
    default:
      return { action: 'fail', reason: assessment.outcome || 'unknown', verifyCdn: false }
  }
}

export function requireReadbackComplete(assessment) {
  if (assessment.outcome !== 'complete-match') throw new Error(`read-back after publication is ${assessment.outcome}: ${assessment.detail}`)
  return true
}
