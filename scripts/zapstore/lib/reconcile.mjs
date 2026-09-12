// Relay-first reconciliation.
//
// Input: the three *expected* events (produced by the official zsp in unsigned
// offline mode from the exact local APK and trusted metadata) and the observed
// relay events for this publisher and package. Output: one of
//   complete-match   the exact release, APK and matching app metadata exist
//   absent           nothing for this version exists; publishing is safe
//   partial          some of the set exists and the present events match
//   conflict         same version, different bytes, extra tags, or extra links
//   superseded       nothing for this version; relay already has a newer code
// Anything with an invalid signature or id throws before a verdict.
//
// Same-version events are classified before any newer-version skip: an already
// complete historical release is complete-match, not a downgrade incident.

import { KINDS, tagValue, tagValues, verifyEvent } from './nostr.mjs'

const APK_SCALARS = ['i', 'x', 'version', 'version_code', 'size', 'm', 'min_platform_version', 'target_platform_version', 'apk_certificate_hash', 'url', 'commit', 'filename']
const APP_SCALARS = ['d', 'name', 'summary', 'url', 'repository', 'license', 'icon']
const RELEASE_SCALARS = ['i', 'version', 'd', 'c']

const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const countTags = (event, name) => event.tags.filter((tag) => tag[0] === name).length

function compareScalars(expected, observed, fields, label) {
  const diffs = []
  for (const field of fields) {
    if (countTags(observed, field) !== countTags(expected, field) || countTags(expected, field) !== 1) diffs.push(`${label}.${field}.cardinality`)
    else if (tagValue(expected, field) !== tagValue(observed, field)) diffs.push(`${label}.${field}`)
  }
  return diffs
}

export function compareApk(expected, observed) {
  const diffs = compareScalars(expected, observed, APK_SCALARS, 'apk')
  if (!sameSet(tagValues(expected, 'f'), tagValues(observed, 'f'))) diffs.push('apk.platforms')
  return diffs
}

export function compareRelease(expected, observed, apkEventId) {
  const diffs = compareScalars(expected, observed, RELEASE_SCALARS, 'release')
  if (observed.content !== expected.content) diffs.push('release.content')
  if (!sameSet(tagValues(expected, 'f'), tagValues(observed, 'f'))) diffs.push('release.platforms')
  const linked = tagValues(observed, 'e')
  if (linked.length !== 1 || linked[0] !== apkEventId) diffs.push('release.e-link')
  return diffs
}

export function compareApp(expected, observed) {
  const diffs = compareScalars(expected, observed, APP_SCALARS, 'app')
  if (observed.content !== expected.content) diffs.push('app.description')
  if (!sameList(tagValues(expected, 'image'), tagValues(observed, 'image'))) diffs.push('app.images')
  if (!sameList(tagValues(expected, 't'), tagValues(observed, 't'))) diffs.push('app.tags')
  if (!sameSet(tagValues(expected, 'f'), tagValues(observed, 'f'))) diffs.push('app.platforms')
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

  for (const event of observed) verifyEvent(event, schnorr)
  const ours = observed.filter((event) => event.pubkey === pubkey)
  const foreign = observed.length - ours.length

  const apks = ours.filter((e) => e.kind === KINDS.APK && tagValue(e, 'i') === packageId)
  const releases = ours.filter((e) => e.kind === KINDS.RELEASE && tagValue(e, 'i') === packageId)
  const apps = ours.filter((e) => e.kind === KINDS.APP && tagValue(e, 'd') === packageId).sort((a, b) => b.created_at - a.created_at)
  const app = apps[0] ?? null
  const newest = newestVersionCode(apks)

  const sameVersionApks = apks.filter((e) => tagValue(e, 'version') === version)
  const matchingApks = sameVersionApks.filter((e) => tagValue(e, 'x') === tagValue(expApk, 'x'))
  const conflictingApks = sameVersionApks.filter((e) => tagValue(e, 'x') !== tagValue(expApk, 'x'))
  const sameVersionReleases = releases.filter((e) => tagValue(e, 'd') === tagValue(expRelease, 'd')).sort((a, b) => b.created_at - a.created_at)
  const release = sameVersionReleases[0] ?? null

  if (conflictingApks.length) {
    return { outcome: 'conflict', detail: `relay has ${conflictingApks.length} APK event(s) for ${version} with a different hash: ${conflictingApks.map((e) => e.id).join(', ')}`, foreign, newestVersionCode: newest }
  }
  if (matchingApks.length > 1) {
    return { outcome: 'conflict', detail: `relay has ${matchingApks.length} APK events for ${version} with the expected hash; exact match requires one`, foreign, newestVersionCode: newest }
  }

  let apk = matchingApks[0] ?? null
  if (release) {
    const linked = tagValues(release, 'e')
    if (linked.length !== 1) {
      return { outcome: 'conflict', detail: `release ${release.id} e-link cardinality is ${linked.length}, expected exactly one APK reference`, present: { release: release.id, apk: apk?.id, app: app?.id }, foreign, newestVersionCode: newest }
    }
    const linkedId = linked[0]
    if (apk && apk.id !== linkedId) {
      return { outcome: 'conflict', detail: `release ${release.id} e-link ${linkedId} is not the matching APK ${apk.id}`, present: { release: release.id, apk: apk.id, app: app?.id }, foreign, newestVersionCode: newest }
    }
    if (!apk) {
      const pointed = ours.find((event) => event.id === linkedId)
      if (pointed && pointed.kind === KINDS.APK) {
        return { outcome: 'conflict', detail: `release ${release.id} references APK ${linkedId} which is not the verified candidate`, present: { release: release.id, app: app?.id }, foreign, newestVersionCode: newest }
      }
    } else {
      apk = matchingApks.find((event) => event.id === linkedId) ?? null
      if (!apk) {
        return { outcome: 'conflict', detail: `release ${release.id} e-link ${linkedId} does not select the matching APK`, present: { release: release.id, app: app?.id }, foreign, newestVersionCode: newest }
      }
    }
  }

  const missing = []
  if (!apk) missing.push('apk')
  if (!release) missing.push('release')
  if (!app) missing.push('app')

  if (!apk && !release) {
    if (newest > versionCode) {
      return { outcome: 'superseded', detail: `no events for ${version} (code ${versionCode}); relay already carries version_code ${newest}`, foreign, newestVersionCode: newest }
    }
    return { outcome: 'absent', detail: app ? 'no release or APK for this version; app metadata exists and will be refreshed from the trusted template' : 'no events for this package', foreign, newestVersionCode: newest }
  }

  const diffs = []
  if (apk) diffs.push(...compareApk(expApk, apk))
  if (release && apk) diffs.push(...compareRelease(expRelease, release, apk.id))
  else if (release) {
    const withoutE = compareRelease(expRelease, { ...release, tags: release.tags.filter((tag) => tag[0] !== 'e').concat([['e', 'missing-apk']]) }, 'missing-apk')
    diffs.push(...withoutE.filter((diff) => diff !== 'release.e-link'))
  }
  if (app) diffs.push(...compareApp(expApp, app))

  const present = { apk: apk?.id, release: release?.id, app: app?.id }
  if (diffs.length) {
    return { outcome: 'conflict', detail: `published set differs from the verified candidate: ${diffs.join(', ')}`, present, missing, foreign, newestVersionCode: newest }
  }
  if (missing.length) {
    return { outcome: 'partial', detail: `present: ${['apk', 'release', 'app'].filter((k) => !missing.includes(k)).join(', ')}; missing: ${missing.join(', ')}`, present, missing, presentMatches: true, foreign, newestVersionCode: newest }
  }
  return { outcome: 'complete-match', detail: 'release, APK and app metadata already published and verified', present, foreign, newestVersionCode: newest }
}

export function isSafePartialRecovery(assessment) {
  if (!assessment || assessment.outcome !== 'partial' || assessment.presentMatches !== true) return false
  if (!Array.isArray(assessment.missing) || assessment.missing.length === 0) return false
  const versionCode = Number(assessment.candidateVersionCode)
  const newest = Number(assessment.newestVersionCode)
  if (Number.isInteger(versionCode) && Number.isInteger(newest) && newest > versionCode) return false
  return true
}

export function publicationAction({ assessment, triggerMode, candidateVersionCode }) {
  const viewed = { ...assessment, candidateVersionCode: candidateVersionCode ?? assessment.candidateVersionCode }
  switch (viewed.outcome) {
    case 'complete-match':
      return { action: 'skip', reason: 'complete-match', verifyCdn: true }
    case 'absent':
      return { action: 'publish', reason: 'absent', verifyCdn: false }
    case 'superseded':
      if (triggerMode === 'schedule') return { action: 'skip', reason: 'superseded', verifyCdn: false }
      return { action: 'fail', reason: 'downgrade-refused', verifyCdn: false }
    case 'partial':
      if (isSafePartialRecovery(viewed)) return { action: 'publish', reason: 'safe-partial-recovery', verifyCdn: false }
      return { action: 'fail', reason: 'partial', verifyCdn: false }
    case 'incomplete':
      return { action: 'fail', reason: 'incomplete', verifyCdn: false }
    case 'conflict':
      return { action: 'fail', reason: 'conflict', verifyCdn: false }
    default:
      return { action: 'fail', reason: viewed.outcome || 'unknown', verifyCdn: false }
  }
}

export function requireReadbackComplete(assessment) {
  if (assessment.outcome !== 'complete-match') throw new Error(`read-back after publication is ${assessment.outcome}: ${assessment.detail}`)
  return true
}
