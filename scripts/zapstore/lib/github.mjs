// Exact-identity GitHub reads. Every function addresses a release by numeric id
// or a tag by name; nothing here ever asks for `latest`.

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

export const REPOSITORY = 'silent-suite/silentsuite'
export const HEX64 = /^[0-9a-f]{64}$/

export class EnumerationIncomplete extends Error {}

export function createGitHubClient({ fetchImpl = globalThis.fetch, token = '', apiBase = 'https://api.github.com', repository = REPOSITORY } = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'silentsuite-zapstore-lane' }
  if (token) headers.Authorization = `Bearer ${token}`

  async function getJson(path) {
    const response = await fetchImpl(`${apiBase}/repos/${repository}${path}`, { headers })
    if (response.status !== 200) throw new Error(`GitHub GET ${path} returned ${response.status}`)
    return response.json()
  }

  return {
    async getReleaseById(releaseId) {
      const release = await getJson(`/releases/${releaseId}`)
      if (release.id !== releaseId) throw new Error(`release id mismatch: asked ${releaseId}, got ${release.id}`)
      return release
    },

    // Dereferences annotated tags so the bound commit is the commit, not the
    // tag object.
    async getTagCommit(tag) {
      const ref = await getJson(`/git/ref/tags/${encodeURIComponent(tag)}`)
      if (ref.ref !== `refs/tags/${tag}`) throw new Error(`tag ref mismatch for ${tag}`)
      if (ref.object?.type === 'commit') return ref.object.sha
      if (ref.object?.type === 'tag') {
        const tagObject = await getJson(`/git/tags/${ref.object.sha}`)
        if (tagObject.object?.type !== 'commit') throw new Error(`annotated tag ${tag} does not point at a commit`)
        return tagObject.object.sha
      }
      throw new Error(`tag ${tag} points at unsupported object type ${String(ref.object?.type)}`)
    },

    // Bounded pagination. If the window is not fully enumerated the caller
    // gets an error, never a shorter list.
    async listPublishedReleases({ perPage = 100, maxPages = 5 } = {}) {
      const releases = []
      for (let page = 1; page <= maxPages; page += 1) {
        const batch = await getJson(`/releases?per_page=${perPage}&page=${page}`)
        if (!Array.isArray(batch)) throw new Error('release list is not an array')
        for (const release of batch) if (release.draft !== true) releases.push(release)
        if (batch.length < perPage) return { releases, pagesFetched: page, complete: true }
      }
      throw new EnumerationIncomplete(`more than ${maxPages * perPage} releases; enumeration window not complete`)
    },

    async getText(path) {
      const response = await fetchImpl(`${apiBase}/repos/${repository}${path}`, { headers: { ...headers, Accept: 'application/octet-stream' } })
      if (response.status !== 200) throw new Error(`GitHub asset GET ${path} returned ${response.status}`)
      return response.text()
    },

    async downloadAsset(assetId, destination) {
      const response = await fetchImpl(`${apiBase}/repos/${repository}/releases/assets/${assetId}`, { headers: { ...headers, Accept: 'application/octet-stream' } })
      if (response.status !== 200) throw new Error(`asset ${assetId} download returned ${response.status}`)
      const hash = createHash('sha256')
      let size = 0
      const body = Readable.fromWeb(response.body)
      body.on('data', (chunk) => { hash.update(chunk); size += chunk.length })
      await pipeline(body, createWriteStream(destination, { mode: 0o600 }))
      return { sha256: hash.digest('hex'), size }
    },
  }
}

export function assetNames(tag) {
  return {
    apk: `silentsuite-android-${tag}.apk`,
    sidecar: `silentsuite-android-${tag}-installer.sha256`,
    sums: 'SHA256SUMS.txt',
  }
}

// Picks exactly one of each required asset and requires GitHub's own digest.
export function bindReleaseAssets(release, tag) {
  const names = assetNames(tag)
  const pick = (name) => {
    const matches = (release.assets ?? []).filter((asset) => asset.name === name)
    if (matches.length !== 1) throw new Error(`expected exactly one asset named ${name}, found ${matches.length}`)
    return matches[0]
  }
  const apk = pick(names.apk)
  const digest = typeof apk.digest === 'string' && apk.digest.startsWith('sha256:') ? apk.digest.slice(7) : null
  if (!digest || !HEX64.test(digest)) throw new Error(`asset ${names.apk} has no sha256 digest from GitHub`)
  if (!Number.isInteger(apk.size) || apk.size <= 0) throw new Error(`asset ${names.apk} has no size`)
  return {
    apk: { id: apk.id, name: apk.name, size: apk.size, sha256: digest },
    sidecar: { id: pick(names.sidecar).id, name: names.sidecar },
    sums: { id: pick(names.sums).id, name: names.sums },
  }
}

// `<hex>  <name>` lines. The sidecar must contain exactly one hash line; the
// SHA256SUMS manifest must name the APK exactly once.
export function hashFromChecksumText(text, { fileName = null } = {}) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const found = []
  for (const line of lines) {
    const match = /^([0-9a-f]{64})(?:\s+\*?(.+))?$/.exec(line)
    if (!match) continue
    if (fileName === null || match[2] === fileName) found.push(match[1])
  }
  if (found.length !== 1) throw new Error(`expected exactly one checksum line${fileName ? ` for ${fileName}` : ''}, found ${found.length}`)
  return found[0]
}
