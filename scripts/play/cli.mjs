#!/usr/bin/env node
// Google Play publication lane: puts the newest published GitHub release on the
// production track. See runbooks/play-automation.md.
//
// Each run: pick the newest eligible GitHub release, read its versionCode and
// English release notes from the tag's own commit, and ask Play what the
// production track holds. Only when production has neither this versionCode
// nor a newer one does the run upload the release's signed AAB and native
// symbols (both checked against GitHub's digest and the release's .sha256
// files), set the production release and validate the edit. Mode `validate`
// then discards the edit; mode `publish` commits it, which sends it to Google's
// review, and reads the track back.

import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createGitHubClient, hashFromChecksumText, HEX64 } from '../zapstore/lib/github.mjs'
import { accessToken, createPlayClient, parseServiceAccount } from './lib/play-api.mjs'
import { newestRelease, productionRelease, releaseNotes, TRACK, trackDecision, versionFromGradle } from './lib/plan.mjs'

export const MODES = ['validate', 'publish']

export function playAssetNames(tag) {
  return {
    bundle: `silentsuite-android-${tag}.aab`,
    bundleSidecar: `silentsuite-android-${tag}-bundle.sha256`,
    symbols: `silentsuite-android-${tag}-native-debug-symbols.zip`,
    symbolsSidecar: `silentsuite-android-${tag}-native-debug-symbols.sha256`,
  }
}

// Exactly one of each asset; payloads need GitHub's own sha256 digest.
export function bindPlayAssets(release, tag) {
  const names = playAssetNames(tag)
  const pick = (name, needsDigest) => {
    const matches = (release.assets ?? []).filter((asset) => asset.name === name)
    if (matches.length !== 1) throw new Error(`expected exactly one asset named ${name}, found ${matches.length}`)
    const asset = matches[0]
    if (!needsDigest) return { id: asset.id, name }
    const digest = typeof asset.digest === 'string' && asset.digest.startsWith('sha256:') ? asset.digest.slice(7) : null
    if (!digest || !HEX64.test(digest)) throw new Error(`asset ${name} has no sha256 digest from GitHub`)
    return { id: asset.id, name, sha256: digest }
  }
  return {
    bundle: pick(names.bundle, true),
    bundleSidecar: pick(names.bundleSidecar, false),
    symbols: pick(names.symbols, true),
    symbolsSidecar: pick(names.symbolsSidecar, false),
  }
}

// Downloads one payload and requires its hash to equal both GitHub's digest and
// the release's own checksum file.
async function fetchVerified(github, payload, sidecar, dir) {
  const expected = hashFromChecksumText(await github.getText(`/releases/assets/${sidecar.id}`), { fileName: payload.name, sidecar: true })
  if (expected !== payload.sha256) throw new Error(`${sidecar.name} does not match GitHub's digest for ${payload.name}`)
  const path = join(dir, payload.name)
  const { sha256 } = await github.downloadAsset(payload.id, path)
  if (sha256 !== payload.sha256) throw new Error(`downloaded ${payload.name} hash ${sha256} does not match ${payload.sha256}`)
  return readFileSync(path)
}

export async function runLane({ mode, github, play, readAtCommit, log = () => {}, workDir }) {
  if (!MODES.includes(mode)) throw new Error(`PLAY_AUTOMATION_MODE must be one of ${MODES.join(', ')}`)
  const listing = await github.listPublishedReleases()
  const newest = newestRelease(listing.releases)
  if (!newest) return { outcome: 'none', detail: 'no eligible published release' }
  const { tag } = newest
  const commit = await github.getTagCommit(tag)
  const { versionCode, versionName } = versionFromGradle(readAtCommit(commit, 'android/app/build.gradle'), tag)
  const base = { tag, commit, versionCode, versionName }
  log(`newest release ${tag} (${commit}) is versionCode ${versionCode}`)

  const editId = await play.insertEdit()
  let committed = false
  try {
    const decision = trackDecision(await play.listTracks(editId), versionCode)
    if (decision.action === 'present') return { ...base, outcome: 'present', detail: `production already lists versionCode ${versionCode} (status ${decision.status})` }
    if (decision.action === 'superseded') return { ...base, outcome: 'superseded', detail: `production already lists newer versionCode ${decision.highest}` }

    const notes = releaseNotes(readAtCommit(commit, `android/fastlane/metadata/android/en-US/changelogs/${versionCode}.txt`), versionCode)
    const assets = bindPlayAssets(await github.getReleaseById(newest.releaseId), tag)
    const bundleBytes = await fetchVerified(github, assets.bundle, assets.bundleSidecar, workDir)
    const symbolBytes = await fetchVerified(github, assets.symbols, assets.symbolsSidecar, workDir)

    const existing = (await play.listBundles(editId)).find((bundle) => Number(bundle.versionCode) === versionCode)
    if (existing) {
      if (existing.sha256 !== assets.bundle.sha256) throw new Error(`Play already holds a different bundle for versionCode ${versionCode}`)
      log(`Play already holds this bundle for versionCode ${versionCode}; not uploading it again`)
    } else {
      const uploaded = await play.uploadBundle(editId, bundleBytes)
      if (Number(uploaded?.versionCode) !== versionCode) throw new Error(`uploaded bundle is versionCode ${uploaded?.versionCode}, expected ${versionCode}`)
      if (uploaded.sha256 !== assets.bundle.sha256) throw new Error('Play reports a different sha256 for the uploaded bundle')
      log(`uploaded ${assets.bundle.name} (${assets.bundle.sha256})`)
    }
    await play.uploadNativeSymbols(editId, versionCode, symbolBytes)
    await play.updateTrack(editId, TRACK, [productionRelease({ versionCode, versionName, notes })])
    await play.validateEdit(editId)
    if (mode === 'validate') return { ...base, outcome: 'validated', detail: `edit for versionCode ${versionCode} validated and discarded` }

    await play.commitEdit(editId)
    committed = true
    log(`committed versionCode ${versionCode} to ${TRACK}; it is now in Google's review`)
  } finally {
    if (!committed) await play.deleteEdit(editId).catch((error) => log(`could not discard edit: ${error.message}`))
  }

  const readback = await play.insertEdit()
  try {
    const after = trackDecision(await play.listTracks(readback), versionCode)
    if (after.action !== 'present') throw new Error(`read-back: production does not list versionCode ${versionCode} after commit`)
    return { ...base, outcome: 'published', detail: `production lists versionCode ${versionCode} (status ${after.status}); Google review decides when it goes live` }
  } finally {
    await play.deleteEdit(readback).catch((error) => log(`could not discard read-back edit: ${error.message}`))
  }
}

function readAtCommitIn(workspace) {
  return (commit, path) => {
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('tag commit is not a 40-hex sha')
    return execFileSync('git', ['-C', workspace, 'show', `${commit}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  }
}

async function main() {
  const args = process.argv.slice(2)
  const workspace = args[0] === 'run' && args[1] === '--workspace' ? args[2] : null
  if (!workspace) throw new Error('usage: cli.mjs run --workspace <checkout>')
  const event = process.env.GITHUB_EVENT_NAME
  if (event !== 'schedule' && event !== 'workflow_dispatch') throw new Error(`refusing trigger ${event}`)
  if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error(`refusing ref ${process.env.GITHUB_REF}`)
  const account = parseServiceAccount(process.env.PLAY_SERVICE_ACCOUNT_JSON ?? '')
  const play = createPlayClient({ token: await accessToken(account) })
  const github = createGitHubClient({ token: process.env.GITHUB_TOKEN ?? '' })
  const workDir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'play-'))
  try {
    const result = await runLane({ mode: process.env.PLAY_AUTOMATION_MODE, github, play, readAtCommit: readAtCommitIn(workspace), log: (line) => console.log(line), workDir })
    const lines = [`## Google Play publication (${process.env.PLAY_AUTOMATION_MODE})`, '', `- Outcome: **${result.outcome}**`, `- ${result.detail}`]
    if (result.tag) lines.push(`- Release: ${result.tag} at ${result.commit}, versionCode ${result.versionCode}`)
    console.log(lines.join('\n'))
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`::error::${error.message}`)
    process.exit(1)
  })
}
