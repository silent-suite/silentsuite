// The exact-release binding: what one run is allowed to publish, and the
// revalidation performed immediately before signing.

import { classifyRelease } from './eligibility.mjs'
import { bindReleaseAssets } from './github.mjs'

export async function buildBinding({ client, releaseId, expectedTag = null, expectedSourceSha = null }) {
  const release = await client.getReleaseById(releaseId)
  const verdict = classifyRelease(release)
  if (!verdict.eligible) throw new Error(`release ${releaseId} is not eligible: ${verdict.reason}`)
  if (expectedTag !== null && release.tag_name !== expectedTag) throw new Error(`release ${releaseId} is tagged ${release.tag_name}, dispatch said ${expectedTag}`)
  const tagCommit = await client.getTagCommit(release.tag_name)
  if (expectedSourceSha !== null && tagCommit !== expectedSourceSha) throw new Error(`tag ${release.tag_name} resolves to ${tagCommit}, dispatch said ${expectedSourceSha}`)
  const assets = bindReleaseAssets(release, release.tag_name)
  return {
    releaseId: release.id,
    tag: release.tag_name,
    version: verdict.version,
    kind: verdict.kind,
    channel: verdict.channel,
    githubPrerelease: verdict.githubPrerelease,
    publishedAt: release.published_at,
    sourceSha: tagCommit,
    assets,
  }
}

// Same reads, compared field by field. Any drift (moved tag, replaced asset,
// un-published release) stops the run before a signature is requested.
export async function revalidateBinding({ client, binding }) {
  const fresh = await buildBinding({ client, releaseId: binding.releaseId, expectedTag: binding.tag, expectedSourceSha: binding.sourceSha })
  const drift = []
  for (const key of ['releaseId', 'tag', 'version', 'channel', 'sourceSha']) if (fresh[key] !== binding[key]) drift.push(key)
  for (const key of ['id', 'name', 'size', 'sha256']) if (fresh.assets.apk[key] !== binding.assets.apk[key]) drift.push(`assets.apk.${key}`)
  if (fresh.assets.sidecar.id !== binding.assets.sidecar.id) drift.push('assets.sidecar.id')
  if (fresh.assets.sums.id !== binding.assets.sums.id) drift.push('assets.sums.id')
  if (drift.length) throw new Error(`release binding drifted before signing: ${drift.join(', ')}`)
  return fresh
}

// The three independent statements about the APK bytes must agree with the
// locally computed hash: GitHub's digest, the -installer.sha256 sidecar and the
// SHA256SUMS.txt manifest.
export function verifyApkHashes({ binding, localSha256, localSize, sidecarSha256, sumsSha256 }) {
  const expected = binding.assets.apk.sha256
  const problems = []
  if (localSha256 !== expected) problems.push('local bytes do not match the GitHub asset digest')
  if (localSize !== binding.assets.apk.size) problems.push('local size does not match the GitHub asset size')
  if (sidecarSha256 !== expected) problems.push('-installer.sha256 sidecar disagrees with the asset digest')
  if (sumsSha256 !== expected) problems.push('SHA256SUMS.txt disagrees with the asset digest')
  if (problems.length) throw new Error(`APK hash binding failed: ${problems.join('; ')}`)
  return true
}
