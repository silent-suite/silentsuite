#!/usr/bin/env node
// Builds the static copy of the web app that Android debug builds carry.
// See README.md in this folder for what the bundle is and what it leaves out.
//
//   node android-bundle/build.mjs            build, then package into dist/
//   node android-bundle/build.mjs --package  package an existing out/ only
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ALLOWED_PAGE_PREFIXES,
  CONTENT_TYPES,
  contentSecurityPolicy,
  inlineScriptHashes,
  isBundledPath,
  urlPathFor,
} from './bundle-contract.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.dirname(here)
const exportDir = path.join(webRoot, 'out')
const distDir = path.join(here, 'dist', 'webapp')

// The bundle talks to the hosted service only; self-hosted accounts are not
// supported in this view yet.
const SYNC_SERVER = 'https://server.silentsuite.io'
const BILLING_API = 'https://api.silentsuite.io'

function build() {
  rmSync(exportDir, { recursive: true, force: true })
  const env = {
    ...process.env,
    SILENTSUITE_ANDROID_BUNDLE: '1',
    NEXT_TELEMETRY_DISABLED: '1',
    NEXT_PUBLIC_ETEBASE_SERVER_URL: SYNC_SERVER,
    NEXT_PUBLIC_BILLING_API_URL: BILLING_API,
    NEXT_PUBLIC_SENTRY_DSN: '',
    NEXT_PUBLIC_WEB_VITALS_ENABLED: 'false',
  }
  delete env.NEXT_PUBLIC_SELF_HOSTED
  const result = spawnSync('pnpm', ['exec', 'next', 'build'], { cwd: webRoot, env, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function walk(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entry) => {
      const full = path.join(dir, entry.name)
      return entry.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join('/')]
    })
}

function packageBundle() {
  if (!existsSync(path.join(exportDir, 'index.html'))) {
    throw new Error(`no static export at ${exportDir}; run the build first`)
  }
  rmSync(distDir, { recursive: true, force: true })
  mkdirSync(path.join(distDir, 'files'), { recursive: true })

  const files = {}
  let bytes = 0
  for (const relative of walk(exportDir)) {
    if (!isBundledPath(relative)) continue
    const extension = path.extname(relative).toLowerCase()
    const contentType = CONTENT_TYPES[extension]
    if (!contentType) throw new Error(`no content type for bundled file ${relative}`)
    const content = readFileSync(path.join(exportDir, relative))
    const sha256 = createHash('sha256').update(content).digest('hex')
    // Files are stored under their hash: the Android packager drops folders
    // whose names start with an underscore, which is where Next keeps scripts.
    const asset = `files/${sha256}${extension}`
    writeFileSync(path.join(distDir, asset), content)
    const entry = { asset, contentType, sha256 }
    if (extension === '.html') {
      entry.contentSecurityPolicy = contentSecurityPolicy({
        scriptHashes: inlineScriptHashes(content.toString('utf8')),
        connectSources: [SYNC_SERVER, SYNC_SERVER.replace('https://', 'wss://'), BILLING_API],
      })
    }
    const urlPath = urlPathFor(relative)
    if (files[urlPath]) throw new Error(`two bundled files answer ${urlPath}`)
    files[urlPath] = entry
    bytes += statSync(path.join(exportDir, relative)).size
  }

  for (const prefix of ALLOWED_PAGE_PREFIXES) {
    if (!files[prefix]) throw new Error(`the export has no page for ${prefix}`)
  }

  const manifest = {
    schemaVersion: 1,
    origin: 'https://app.silentsuite.io',
    startPath: '/login/',
    notFoundPath: '/404.html',
    syncServerOrigin: SYNC_SERVER,
    connectOrigins: [SYNC_SERVER, BILLING_API],
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  }
  writeFileSync(path.join(distDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  // Licence texts for the bundled web code (AGPL-3.0-only) travel with it.
  cpSync(path.join(webRoot, '..', '..', 'LICENSE'), path.join(distDir, 'LICENSE-AGPL-3.0.txt'))
  console.log(`android bundle: ${Object.keys(files).length} files, ${(bytes / 1024 / 1024).toFixed(2)} MB in ${path.relative(webRoot, distDir)}`)
}

if (!process.argv.includes('--package')) build()
packageBundle()
