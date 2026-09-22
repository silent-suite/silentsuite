// Fetch referenced CDN bytes and compare hashes. Zapstore's CDN addresses blobs
// by SHA-256 (https://cdn.zapstore.dev/<hash>), so the URL is also the claim.

import { createHash } from 'node:crypto'

export const CDN_ORIGIN = 'https://cdn.zapstore.dev/'

export async function verifyCdnBlob({ url, expectedSha256, fetchImpl = globalThis.fetch, maxBytes = 200 * 1024 * 1024 }) {
  if (typeof url !== 'string' || !url.startsWith(CDN_ORIGIN)) throw new Error(`not a Zapstore CDN URL: ${String(url)}`)
  if (url.slice(CDN_ORIGIN.length) !== expectedSha256) throw new Error(`CDN URL hash differs from the expected hash for ${url}`)
  const response = await fetchImpl(url)
  if (response.status !== 200) throw new Error(`CDN ${url} returned ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > maxBytes) throw new Error(`CDN blob ${url} exceeds ${maxBytes} bytes`)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expectedSha256) throw new Error(`CDN bytes at ${url} hash to ${actual}, expected ${expectedSha256}`)
  return { url, sha256: actual, size: bytes.length }
}

// Every blob the three events reference: APK, icon, ordered screenshots.
export async function verifyReferencedBlobs({ app, apk, fetchImpl }) {
  const get = (event, name) => event.tags.filter((t) => t[0] === name).map((t) => t[1])
  const results = []
  results.push(await verifyCdnBlob({ url: get(apk, 'url')[0], expectedSha256: get(apk, 'x')[0], fetchImpl }))
  const icon = get(app, 'icon')[0]
  results.push(await verifyCdnBlob({ url: icon, expectedSha256: icon?.slice(CDN_ORIGIN.length), fetchImpl }))
  for (const image of get(app, 'image')) results.push(await verifyCdnBlob({ url: image, expectedSha256: image.slice(CDN_ORIGIN.length), fetchImpl }))
  return results
}
