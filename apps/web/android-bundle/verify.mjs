#!/usr/bin/env node
// Checks a packaged bundle (dist/webapp) against the rules in bundle-contract.mjs:
// every file is listed and matches its hash, nothing else is present, every
// page carries its policy, and only the allowed pages are there.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALLOWED_PAGE_PREFIXES, inlineScriptHashes } from './bundle-contract.mjs'

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist', 'webapp')
const manifest = JSON.parse(readFileSync(path.join(dist, 'manifest.json'), 'utf8'))
const problems = []
const listed = new Set()
const pages = []

for (const [urlPath, entry] of Object.entries(manifest.files)) {
  listed.add(path.basename(entry.asset))
  const content = readFileSync(path.join(dist, entry.asset))
  const sha256 = createHash('sha256').update(content).digest('hex')
  if (sha256 !== entry.sha256 || !entry.asset.startsWith(`files/${sha256}.`)) problems.push(`${urlPath}: content does not match its hash`)
  if (entry.contentType !== 'text/html') {
    if (entry.contentSecurityPolicy) problems.push(`${urlPath}: only pages carry a policy`)
    continue
  }
  pages.push(urlPath)
  const policy = entry.contentSecurityPolicy ?? ''
  if (!policy.startsWith("default-src 'none'; ")) problems.push(`${urlPath}: page without a deny-by-default policy`)
  if (/'unsafe-eval'|script-src[^;]*'unsafe-inline'|script-src[^;]*https?:/.test(policy)) problems.push(`${urlPath}: policy lets foreign or injected scripts run`)
  for (const hash of inlineScriptHashes(content.toString('utf8'))) {
    if (!policy.includes(hash)) problems.push(`${urlPath}: an inline script is not covered by the policy`)
  }
  const connect = /connect-src ([^;]*)/.exec(policy)?.[1].split(' ') ?? []
  const allowed = new Set(["'self'", 'data:', ...manifest.connectOrigins, manifest.syncServerOrigin.replace('https://', 'wss://')])
  for (const source of connect) if (!allowed.has(source)) problems.push(`${urlPath}: policy lets the page reach ${source}`)
}

const expectedPages = ['/', '/404.html', '/404/', ...ALLOWED_PAGE_PREFIXES].sort()
if (JSON.stringify(pages.sort()) !== JSON.stringify(expectedPages)) problems.push(`pages are ${pages.join(' ')}, expected ${expectedPages.join(' ')}`)
for (const name of readdirSync(path.join(dist, 'files'))) {
  if (!listed.has(name)) problems.push(`files/${name} is not in the manifest`)
}
for (const name of readdirSync(dist)) {
  if (!['files', 'manifest.json', 'LICENSE-AGPL-3.0.txt'].includes(name)) problems.push(`unexpected ${name} in the bundle`)
}

if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log(`android bundle verified: ${Object.keys(manifest.files).length} files, pages ${pages.join(' ')}`)
