#!/usr/bin/env node
// Read-only, bounded evidence collector for the temporary braces GHSA-vfj7-8cjw-p6xm exception.
// Usage: node scripts/verify-braces-tooling-exposure.mjs <out-dir> [compare-ref] [--runtime-smoke]
// Run after a frozen install and the Dockerfile.web build steps (core, ui, web). Exits 1 unless
// every check below holds; writes summary.json and standalone-inventory.tsv to <out-dir>.
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { bracesException } from './audit-high-critical.mjs'

const root = resolve(import.meta.dirname, '..')
const nextDir = join(root, 'apps/web/.next')
const standalone = join(nextDir, 'standalone')
const consumers = ['braces', 'micromatch', 'fast-glob', 'chokidar', 'tailwindcss', 'tailwindcss-animate',
  '@ducanh2912/next-pwa', 'eslint-config-next', '@next/eslint-plugin-next']
// String literals from braces lib/parse.js and lib/expand.js; minifiers keep string literals
// and (by default) property names, so these survive bundling of braces source.
const signatures = ['exceeds max characters (', 'rangeLimit']
// next@15.5.24 vendors @vercel/nft, which bundles an unversioned braces copy (not braces@3.0.3 and
// outside this exception), for build-time output tracing. Only this exact file and content is
// tolerated; a changed bundle or any other file carrying the signatures fails the check.
export const toleratedSignatureFiles = Object.freeze([Object.freeze({
  file: 'apps/web/.next/standalone/node_modules/.pnpm/next@15.5.24_@babel+core@7.29.0_@opentelemetry+api@1.9.1_@types+node@20.19.37_babel-plu_645be988d9e529a02f3844286daf8410/node_modules/next/dist/compiled/@vercel/nft/index.js',
  sha256: '19e4e6ea76d56deed0da625b0d9cbe5f5a761cf87a1c502bbb09c9406a70527e',
})])
// Every module on the static load chains of the vendored nft bundle in next@15.5.24: the nft bundle,
// its only requirer, its only loader (webpack-config), webpack-config's requirers, and the dev
// bundler modules that reach them.
const buildOnlyModules = /(^|\/)next\/dist\/(compiled\/@vercel\/nft\/|build\/webpack\/plugins\/next-trace-entrypoints-plugin\.js|build\/webpack-config\.js|build\/create-compiler-aliases\.js|build\/handle-externals\.js|build\/webpack\/config\/blocks\/images\/index\.js|server\/lib\/router-utils\/setup-dev-bundler\.js|server\/dev\/hot-reloader-(webpack|turbopack)\.js)/
const smokeRoutes = ['/', '/login', '/offline', '/calendar', '/settings', '/api/deployment-identity', '/braces-smoke-not-found']
const productionInputs = ['Dockerfile.web', '.dockerignore', '.npmrc', 'package.json', 'pnpm-lock.yaml',
  'pnpm-workspace.yaml', 'turbo.json', 'apps/web', 'packages']
const maxFiles = 100000
const maxScanBytes = 64 * 1024 * 1024
const smokeTimeoutMs = 60000

const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const consumerPathPatterns = consumers.map((name) => new RegExp(
  `(^|/)node_modules/${escape(name)}(/|$)|(^|/)\\.pnpm/${escape(name.replace('/', '+'))}@`))
const namesConsumer = (path) => consumerPathPatterns.some((pattern) => pattern.test(path))

export function unexplainedSignatureHits(hits) {
  return hits.filter((hit) => !toleratedSignatureFiles.some((tolerated) => tolerated.file === hit.file
    && tolerated.sha256 === hit.sha256))
}

export function forbiddenRuntimeModules(modules) {
  return modules.filter((path) => buildOnlyModules.test(path) || namesConsumer(path))
}

function identity(compareRef, failures) {
  const trackedInputs = git('ls-files', '-s', '--', ...productionInputs)
  const result = {
    head: git('rev-parse', 'HEAD').trim(),
    tree: git('rev-parse', 'HEAD^{tree}').trim(),
    dirtyPaths: git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean),
    productionInputPaths: productionInputs,
    productionInputIndexDigest: sha256(trackedInputs),
    node: process.version,
    pnpm: execFileSync('pnpm', ['--version'], { cwd: root, encoding: 'utf8' }).trim(),
  }
  const dirtyInputs = git('status', '--porcelain', '--', ...productionInputs).split('\n').filter(Boolean)
  if (dirtyInputs.length > 0) failures.push(`production inputs differ from HEAD: ${dirtyInputs.join(', ')}`)
  if (compareRef) {
    result.compareRef = git('rev-parse', compareRef).trim()
    result.productionInputsChangedSinceCompareRef = git('diff', '--name-only', compareRef, 'HEAD', '--', ...productionInputs)
      .split('\n').filter(Boolean)
  }
  return result
}

function sourceImports(failures) {
  const pattern = `(from|require\\(|import\\()[[:space:]]*['"](${consumers.map(escape).join('|')})(/[^'"]*)?['"]`
  let output = ''
  try {
    output = git('grep', '-n', '-E', pattern, '--', '.', ':!pnpm-lock.yaml')
  } catch (error) {
    if (error.status !== 1) throw error
  }
  const hits = output.split('\n').filter(Boolean)
  const allowed = ['apps/web/next.config.js:', 'apps/web/tailwind.config.ts:', 'scripts/']
  const unexpected = hits.filter((hit) => !allowed.some((prefix) => hit.startsWith(prefix)))
  if (unexpected.length > 0) failures.push(`unexpected source imports: ${unexpected.join('; ')}`)
  return { pattern, hits, unexpected }
}

function configs() {
  const files = ['apps/web/tailwind.config.ts', 'apps/web/postcss.config.js', 'apps/web/.eslintrc.json',
    'apps/web/next.config.js', 'Dockerfile.web']
  return Object.fromEntries(files.map((file) => {
    const text = readFileSync(join(root, file), 'utf8')
    return [file, { sha256: sha256(text), text }]
  }))
}

function stripPeers(id) {
  return id.replace(/\(.*$/, '')
}

// Reverse dependency closure of every locked braces snapshot to workspace importers.
function lockClosure(failures) {
  const edges = []
  let section, node, group, importer, importerDep
  for (const line of readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8').split('\n')) {
    let match
    if (/^\S/.test(line)) { section = line.replace(/:.*$/, ''); node = undefined; continue }
    if (section === 'snapshots') {
      if ((match = /^ {2}(\S.*?):( \{\})?$/.exec(line))) { node = match[1].replace(/^'|'$/g, ''); group = undefined }
      else if ((match = /^ {4}(\w+):$/.exec(line))) group = match[1]
      else if (node && /^(dependencies|optionalDependencies)$/.test(group)
        && (match = /^ {6}'?([^:']+)'?: '?([^']+)'?$/.exec(line))) {
        edges.push({ from: node, to: `${match[1]}@${match[2]}` })
      }
    } else if (section === 'importers') {
      if ((match = /^ {2}(\S.*?):( \{\})?$/.exec(line))) importer = match[1].replace(/^'|'$/g, '')
      else if ((match = /^ {4}(\w+):$/.exec(line))) group = match[1]
      else if ((match = /^ {6}'?([^:']+)'?:$/.exec(line))) importerDep = match[1]
      else if ((match = /^ {8}version: '?([^']+)'?$/.exec(line)) && !match[1].startsWith('link:')) {
        edges.push({ from: `importer:${importer}`, kind: group, to: `${importerDep}@${match[1]}` })
      }
    }
  }
  const lockedBraces = [...new Set(edges.map((edge) => edge.to).filter((id) => id.startsWith('braces@')))]
  const paths = []
  const importerKinds = new Set()
  const walk = (id, suffix, seen) => {
    if (paths.length > 1000 || seen.size > 30) throw new Error('lock closure exceeded bounds')
    for (const edge of edges.filter((candidate) => candidate.to === id)) {
      if (edge.from.startsWith('importer:')) {
        importerKinds.add(`${edge.from.slice(9)} ${edge.kind} ${stripPeers(id)}`)
        paths.push([edge.from.slice(9), ...suffix].join(' > '))
      } else if (!seen.has(edge.from)) {
        walk(edge.from, [stripPeers(edge.from), ...suffix], new Set([...seen, edge.from]))
      }
    }
  }
  for (const id of lockedBraces) walk(id, [stripPeers(id)], new Set([id]))
  const unique = [...new Set(paths)].sort()
  const expected = [...bracesException.paths].sort()
  if (JSON.stringify(lockedBraces) !== JSON.stringify([`braces@${bracesException.version}`])) {
    failures.push(`locked braces versions: ${lockedBraces.join(', ')}`)
  }
  if (JSON.stringify(unique) !== JSON.stringify(expected)) failures.push('lock closure differs from reviewed paths')
  return { edgeCount: edges.length, lockedBraces, importerEntryPoints: [...importerKinds].sort(), paths: unique }
}

function walkFiles(dir, visit) {
  let count = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry)
      if (++count > maxFiles) throw new Error(`file walk exceeded ${maxFiles} entries under ${dir}`)
      const stat = lstatSync(path)
      if (stat.isDirectory()) stack.push(path)
      else visit(path, stat)
    }
  }
}

function artifacts(outDir, failures) {
  if (!existsSync(join(standalone, 'apps/web/server.js'))) {
    failures.push('missing standalone build output')
    return {}
  }
  const inventory = []
  const consumerPaths = []
  const signatureHits = []
  const unscanned = []
  const scan = (path, stat) => {
    if (stat.size > maxScanBytes) { unscanned.push(relative(root, path)); return undefined }
    const content = readFileSync(path)
    const digest = sha256(content)
    const text = content.toString('latin1')
    for (const signature of signatures) {
      if (text.includes(signature)) signatureHits.push({ file: relative(root, path), signature, sha256: digest })
    }
    return digest
  }
  walkFiles(standalone, (path, stat) => {
    const rel = relative(standalone, path)
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path)
      inventory.push(`link\t${rel}\t${target}`)
      if (namesConsumer(rel) || namesConsumer(target)) consumerPaths.push(rel)
      return
    }
    inventory.push(`file\t${rel}\t${stat.size}\t${scan(path, stat) ?? 'unscanned'}`)
    if (namesConsumer(rel)) consumerPaths.push(rel)
  })
  // Browser-served assets are copied beside the standalone server by Dockerfile.web.
  let servedFiles = 0
  for (const dir of [join(nextDir, 'static'), join(root, 'apps/web/public')]) {
    walkFiles(dir, (path, stat) => { if (stat.isFile()) { servedFiles++; scan(path, stat) } })
  }
  const traces = []
  walkFiles(nextDir, (path) => {
    if (!path.endsWith('.nft.json') || path.startsWith(standalone)) return
    const files = JSON.parse(readFileSync(path, 'utf8')).files
    if (!Array.isArray(files)) throw new Error(`malformed trace ${path}`)
    traces.push({ trace: relative(root, path), entries: files.length, consumerEntries: files.filter(namesConsumer) })
  })
  const inventoryText = `${inventory.join('\n')}\n`
  writeFileSync(join(outDir, 'standalone-inventory.tsv'), inventoryText)
  const unexplained = unexplainedSignatureHits(signatureHits)
  const traceHits = traces.filter((trace) => trace.consumerEntries.length > 0)
  if (consumerPaths.length > 0) failures.push(`standalone contains consumer packages: ${consumerPaths.join(', ')}`)
  if (traceHits.length > 0) failures.push(`traces reference consumer packages: ${traceHits.map((trace) => trace.trace).join(', ')}`)
  if (unexplained.length > 0) failures.push('braces source signatures outside the pinned vendored nft bundle')
  if (unscanned.length > 0) failures.push(`unscanned large files: ${unscanned.join(', ')}`)
  if (traces.length === 0) failures.push('no .nft.json traces found')
  return {
    standaloneEntries: inventory.length,
    standaloneInventorySha256: sha256(inventoryText),
    servedAssetFilesScanned: servedFiles,
    consumerPaths,
    traceCount: traces.length,
    traceEntryCount: traces.reduce((sum, trace) => sum + trace.entries, 0),
    traceHits,
    signatures,
    signatureHits,
    toleratedSignatureFiles,
    unexplainedSignatures: unexplained,
    unscanned,
  }
}

// Preloaded into the standalone server: records every resolved module and refuses non-loopback
// sockets and fetches. Nothing from the environment or responses is written.
const runtimePreload = `'use strict'
const fs = require('node:fs')
const net = require('node:net')
const Module = require('node:module')
const loaded = new Set()
const blocked = []
const loopback = (host) => host == null || host === '' || host === 'localhost' || /^127\\./.test(host)
  || host === '::1' || host === '[::1]' || host === '::ffff:127.0.0.1'
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  const exported = originalLoad.apply(this, arguments)
  try { loaded.add(Module._resolveFilename(request, parent, isMain)) } catch {}
  return exported
}
const originalConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  let options = args[0]
  if (Array.isArray(options)) options = options[0]
  if (options === null || typeof options !== 'object') options = { port: args[0], host: args[1] }
  if (options.path === undefined && !loopback(options.host)) {
    blocked.push(String(options.host))
    process.nextTick(() => this.destroy(new Error('outbound blocked by braces runtime smoke')))
    return this
  }
  return originalConnect.apply(this, args)
}
const originalFetch = globalThis.fetch
globalThis.fetch = function (input, init) {
  const host = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).hostname
  if (!loopback(host)) { blocked.push(host); return Promise.reject(new Error('outbound blocked by braces runtime smoke')) }
  return originalFetch.call(this, input, init)
}
process.on('SIGTERM', () => {
  const modules = [...new Set([...loaded, ...Object.keys(require.cache)])].sort()
  fs.writeFileSync(require('node:path').join(process.env.BRACES_SMOKE_OUT, 'runtime-modules-' + process.pid + '.json'),
    JSON.stringify({ pid: process.pid, modules, blockedOutbound: blocked }, null, 2))
  process.exit(0)
})
`

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })
}

// Corroboration only: a sampled run of the standalone server, not a proof of all code paths.
async function runtimeSmoke(outDir, failures) {
  const smokeDir = join(outDir, 'runtime-smoke')
  rmSync(smokeDir, { recursive: true, force: true })
  mkdirSync(smokeDir, { recursive: true })
  const preload = join(smokeDir, 'preload.cjs')
  writeFileSync(preload, runtimePreload)
  const home = mkdtempSync(join(tmpdir(), 'braces-smoke-home-'))
  const port = await freePort()
  const env = {
    PATH: process.env.PATH, HOME: home, NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: String(port),
    NEXT_TELEMETRY_DISABLED: '1', NODE_OPTIONS: `--require ${preload}`, BRACES_SMOKE_OUT: smokeDir,
  }
  const child = spawn(process.execPath, ['apps/web/server.js'], { cwd: standalone, env, stdio: 'ignore' })
  const exited = new Promise((resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })))
  const routes = []
  const deadline = Date.now() + smokeTimeoutMs
  try {
    let ready = false
    while (!ready && Date.now() < deadline && child.exitCode === null) {
      try {
        await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual', signal: AbortSignal.timeout(2000) })
        ready = true
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 250))
      }
    }
    if (!ready) failures.push('runtime smoke: standalone server did not become ready')
    else {
      for (const route of smokeRoutes) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}${route}`, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
          await response.arrayBuffer()
          routes.push({ route, status: response.status })
        } catch (error) {
          routes.push({ route, error: error.name })
          failures.push(`runtime smoke: ${route} failed`)
        }
      }
    }
  } finally {
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
    await exited
    clearTimeout(timer)
    rmSync(home, { recursive: true, force: true })
  }
  const dumps = readdirSync(smokeDir).filter((file) => /^runtime-modules-\d+\.json$/.test(file))
  const records = dumps.map((file) => JSON.parse(readFileSync(join(smokeDir, file), 'utf8')))
  const modules = [...new Set(records.flatMap((record) => record.modules))].sort()
  const forbidden = forbiddenRuntimeModules(modules)
  if (records.length === 0) failures.push('runtime smoke: no module record was written')
  if (forbidden.length > 0) failures.push(`runtime smoke loaded build-only modules: ${forbidden.join(', ')}`)
  return {
    port, routes, processes: records.length, modulesLoaded: modules.length,
    nextModulesLoaded: modules.filter((path) => path.includes('/node_modules/next/dist/')).length,
    forbidden, blockedOutbound: records.flatMap((record) => record.blockedOutbound),
  }
}

async function main() {
  const args = process.argv.slice(2)
  const smoke = args.includes('--runtime-smoke')
  const [outArg, compareRef] = args.filter((arg) => arg !== '--runtime-smoke')
  if (!outArg) {
    console.error('Usage: node scripts/verify-braces-tooling-exposure.mjs <out-dir> [compare-ref] [--runtime-smoke]')
    return 2
  }
  const failures = []
  const outDir = resolve(outArg)
  mkdirSync(outDir, { recursive: true })
  const summary = {
    advisory: bracesException.githubAdvisoryId,
    identity: identity(compareRef, failures),
    sourceImports: sourceImports(failures),
    lockClosure: lockClosure(failures),
    artifacts: artifacts(outDir, failures),
    runtimeSmoke: smoke ? await runtimeSmoke(outDir, failures) : 'not run',
    configs: configs(),
  }
  summary.failures = failures
  writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify({ ...summary, configs: Object.keys(summary.configs) }, null, 2))
  return failures.length > 0 ? 1 : 0
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main()
