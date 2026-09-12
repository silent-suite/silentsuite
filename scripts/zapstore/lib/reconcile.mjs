// Relay-first reconciliation.
//
// Input: the three *expected* events (produced by the official zsp in unsigned
// offline mode from the exact local APK and trusted metadata) and the observed
// relay events for this publisher and package. Output: one of
//   complete-match   the exact release, APK and matching app metadata exist
//   absent           nothing for this version exists; publishing is safe
//   partial          some of the set exists; fail closed
//   conflict         same version, different bytes or metadata; fail closed
//   downgrade-refused the relay already carries a newer version; fail closed
// Anything with an invalid signature or id throws before a verdict.

import { KINDS, tagValue, tagValues, verifyEvent } from './nostr.mjs'

const APK_FIELDS = ['x', 'version', 'version_code', 'size', 'm', 'min_platform_version', 'target_platform_version', 'apk_certificate_hash', 'url', 'commit', 'filename']
const APP_FIELDS = ['name', 'summary', 'url', 'repository', 'license', 'icon']
const RELEASE_FIELDS = ['version', 'd', 'c']

const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function compareTags(expected, observed, fields, label) {
  const diffs = []
  for (const field of fields) if (tagValue(expected, field) !== tagValue(observed, field)) diffs.push(`${label}.${field}`)
  if (!sameSet(tagValues(expected, 'f'), tagValues(observed, 'f'))) diffs.push(`${label}.platforms`)
  return diffs
}

export function compareApk(expected, observed) {
  const diffs = compareTags(expected, observed, APK_FIELDS, 'apk')
  if (tagValue(observed, 'i') !== tagValue(expected, 'i')) diffs.push('apk.package')
  return diffs
}

export function compareRelease(expected, observed, apkEventId) {
  const diffs = compareTags(expected, observed, RELEASE_FIELDS, 'release')
  if (observed.content !== expected.content) diffs.push('release.content')
  if (tagValue(observed, 'i') !== tagValue(expected, 'i')) diffs.push('release.package')
  if (!tagValues(observed, 'e').includes(apkEventId)) diffs.push('release.e-link')
  return diffs
}

export function compareApp(expected, observed) {
  const diffs = compareTags(expected, observed, APP_FIELDS, 'app')
  if (observed.content !== expected.content) diffs.push('app.description')
  if (!sameList(tagValues(expected, 'image'), tagValues(observed, 'image'))) diffs.push('app.images')
  if (!sameList(tagValues(expected, 't'), tagValues(observed, 't'))) diffs.push('app.tags')
  if (tagValue(observed, 'd') !== tagValue(expected, 'd')) diffs.push('app.package')
  return diffs
}

export function expectedSet(events) {
  const byKind = new Map(events.map((event) => [event.kind, event]))
  for (const kind of Object.values(KINDS)) if (!byKind.has(kind)) throw new Error(`expected event set is missing kind ${kind}`)
  if (events.length !== 3) throw new Error(`expected exactly three events, got ${events.length}`)
  return { app: byKind.get(KINDS.APP), release: byKind.get(KINDS.RELEASE), apk: byKind.get(KINDS.APK) }
}

export function assessRelayState({ expected, observed, schnorr }) {
  const { app: expApp, release: expRelease, apk: expApk } = expected
  const pubkey = expApk.pubkey
  const packageId = tagValue(expApk, 'i')
  const version = tagValue(expApk, 'version')
  const versionCode = Number(tagValue(expApk, 'version_code'))

  for (const event of observed) verifyEvent(event, schnorr)
  const ours = observed.filter((event) => event.pubkey === pubkey)
  const foreign = observed.length - ours.length

  const apks = ours.filter((e) => e.kind === KINDS.APK && tagValue(e, 'i') === packageId)
  const releases = ours.filter((e) => e.kind === KINDS.RELEASE && tagValue(e, 'i') === packageId)
  const apps = ours.filter((e) => e.kind === KINDS.APP && tagValue(e, 'd') === packageId).sort((a, b) => b.created_at - a.created_at)
  const app = apps[0] ?? null

  const newest = Math.max(0, ...apks.map((e) => Number(tagValue(e, 'version_code')) || 0))
  if (newest > versionCode) {
    return { outcome: 'downgrade-refused', detail: `relay already carries version_code ${newest}, candidate is ${versionCode}`, foreign }
  }

  const sameVersionApks = apks.filter((e) => tagValue(e, 'version') === version)
  const matchingApks = sameVersionApks.filter((e) => tagValue(e, 'x') === tagValue(expApk, 'x'))
  const conflictingApks = sameVersionApks.filter((e) => tagValue(e, 'x') !== tagValue(expApk, 'x'))
  const ourReleases = releases.filter((e) => tagValue(e, 'd') === tagValue(expRelease, 'd')).sort((a, b) => b.created_at - a.created_at)

  if (conflictingApks.length) {
    return { outcome: 'conflict', detail: `relay has ${conflictingApks.length} APK event(s) for ${version} with a different hash: ${conflictingApks.map((e) => e.id).join(', ')}`, foreign }
  }
  if (matchingApks.length === 0 && ourReleases.length === 0) {
    return { outcome: 'absent', detail: app ? 'no release or APK for this version; app metadata exists and will be refreshed from the trusted template' : 'no events for this package', foreign }
  }
  const apk = matchingApks[0]
  const release = ourReleases[0]
  const missing = []
  if (!apk) missing.push('apk')
  if (!release) missing.push('release')
  if (!app) missing.push('app')
  if (missing.length) {
    return { outcome: 'partial', detail: `present: ${['apk', 'release', 'app'].filter((k) => !missing.includes(k)).join(', ')}; missing: ${missing.join(', ')}`, present: { apk: apk?.id, release: release?.id, app: app?.id }, foreign }
  }
  const diffs = [...compareApk(expApk, apk), ...compareRelease(expRelease, release, apk.id), ...compareApp(expApp, app)]
  if (diffs.length) {
    return { outcome: 'conflict', detail: `published set differs from the verified candidate: ${diffs.join(', ')}`, present: { apk: apk.id, release: release.id, app: app.id }, foreign }
  }
  return { outcome: 'complete-match', detail: 'release, APK and app metadata already published and verified', present: { apk: apk.id, release: release.id, app: app.id }, foreign }
}

// After a live publish the same assessment must be complete-match.
export function requireReadbackComplete(assessment) {
  if (assessment.outcome !== 'complete-match') throw new Error(`read-back after publication is ${assessment.outcome}: ${assessment.detail}`)
  return true
}
