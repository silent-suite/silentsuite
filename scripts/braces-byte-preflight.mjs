#!/usr/bin/env node
// Pre-execution byte boundary for the locally patched braces@3.0.3 (GHSA-vfj7-8cjw-p6xm).
// It reads, hashes and resolves files only and never loads braces or a consumer package, so it can
// run before anything else in `pnpm run audit:security`. The expected values were derived offline
// from the SHA512-verified registry tarball plus the reviewed patch; they are never computed from
// the installed tree. Record: docs/security/braces-ghsa-vfj7-8cjw-p6xm-exception.md
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

export const defaultRoot = resolve(import.meta.dirname, '..')
export const patchPath = 'patches/braces@3.0.3.patch'
// sha256 of the patch with CRLF normalized to LF, the rule pnpm 10.6.5 uses for its lock hash.
export const patchDigest = '00379a6565da333c7a8a7d701771eb7bfbfecd1627bcab191ced1b94fc3e3ea6'
export const canonicalIntegrity = 'sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA=='
// Every path in the canonical braces@3.0.3 tarball with its sha256 after the reviewed patch.
export const expectedFiles = Object.freeze({
  LICENSE: '35bdd8a44339719441900fb50fbefc5e2dca1ca662cbaed7a687de842c8b70f2',
  'README.md': '947b0fc3cc12eaaa070207126213fbdf9ab2bf8cd13dcc6e4007b36b79309866',
  'index.js': '332ea07c7b006361aad12aa994ca75dc1db8e8382b884909e2f38f10b85c88a4',
  'lib/compile.js': 'f0ec2cf18f9455e7104345c0e18c8e76342009b9cf2c9b0c8ddba0862ea4451d',
  'lib/constants.js': 'f9fb688959232eee3e6ad7906a5b0e3234815db49ee857ef86983d65b917dc7c',
  'lib/expand.js': 'e7184fa82f52ab315d10d43771311b5e06eca8f58d4de9a94ae6a810c21422c3',
  'lib/parse.js': 'd2284c63fa7364433d771b1531f4dca1a9ebaeec2cf98197e880aed57a7af276',
  'lib/stringify.js': '8461f118bc1b7c18f053a1293ed1feecf48dadb8d8967baf1526421606fa9746',
  'lib/utils.js': 'b5a7596aa67730412b3c029ef09e84e6b67b8e445cffd35d1d295549c89066c7',
  'package.json': '56f08b888a4f30dc7cf8a7dbb36ffe92b737912ba36abe9d069d32167c957ac7',
})
// The eight reviewed consumer chains from apps/web, resolved one hop at a time from each parent's
// exported entry, never by a shortened lookup.
export const consumerChains = Object.freeze([
  [['@ducanh2912/next-pwa', '10.2.9'], ['fast-glob', '3.3.2'], ['micromatch', '4.0.8'], ['braces', '3.0.3']],
  [['eslint-config-next', '15.5.28'], ['@next/eslint-plugin-next', '15.5.28'], ['fast-glob', '3.3.1'],
    ['micromatch', '4.0.8'], ['braces', '3.0.3']],
  [['tailwindcss', '3.4.19'], ['chokidar', '3.6.0'], ['braces', '3.0.3']],
  [['tailwindcss', '3.4.19'], ['fast-glob', '3.3.3'], ['micromatch', '4.0.8'], ['braces', '3.0.3']],
  [['tailwindcss', '3.4.19'], ['micromatch', '4.0.8'], ['braces', '3.0.3']],
  [['tailwindcss-animate', '1.0.7'], ['tailwindcss', '3.4.19'], ['chokidar', '3.6.0'], ['braces', '3.0.3']],
  [['tailwindcss-animate', '1.0.7'], ['tailwindcss', '3.4.19'], ['fast-glob', '3.3.3'], ['micromatch', '4.0.8'],
    ['braces', '3.0.3']],
  [['tailwindcss-animate', '1.0.7'], ['tailwindcss', '3.4.19'], ['micromatch', '4.0.8'], ['braces', '3.0.3']],
])

const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const chainPath = (chain) => ['apps/web', ...chain.map(([name, version]) => `${name}@${version}`)].join(' > ')

export function packageRootOf(entry, name) {
  let dir = dirname(entry)
  for (;;) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`no ${name} manifest above ${entry}`)
    dir = parent
  }
}

function checkBinding(root, failures) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (JSON.stringify(manifest.pnpm?.patchedDependencies) !== JSON.stringify({ 'braces@3.0.3': patchPath })) {
    failures.push('package.json patchedDependencies is not exactly the reviewed braces patch')
  }
  if (!existsSync(join(root, patchPath))) {
    failures.push(`missing ${patchPath}`)
    return
  }
  // A patch and lock that agree with each other but not with the reviewed digest still fail.
  if (sha256(readFileSync(join(root, patchPath), 'utf8').replace(/\r\n/g, '\n')) !== patchDigest) {
    failures.push(`${patchPath} differs from the reviewed patch`)
  }
  const digest = patchDigest
  const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')
  if (!lock.includes(`\npatchedDependencies:\n  braces@3.0.3:\n    hash: ${digest}\n    path: ${patchPath}\n\nimporters:\n`)) {
    failures.push('pnpm-lock.yaml patch binding is not exactly the reviewed braces patch')
  }
  if (!lock.includes(`\n  braces@3.0.3:\n    resolution: {integrity: ${canonicalIntegrity}}\n`)) {
    failures.push('pnpm-lock.yaml braces integrity is not the canonical registry tarball')
  }
  const lines = lock.split('\n')
  // The patchedDependencies entry, the packages entry and the single patched snapshot.
  const keys = lines.filter((line) => line.startsWith('  braces@'))
  if (JSON.stringify(keys) !== JSON.stringify(['  braces@3.0.3:', '  braces@3.0.3:', `  braces@3.0.3(patch_hash=${digest}):`])) {
    failures.push('pnpm-lock.yaml braces entries are not the single patched snapshot')
  }
  const refs = lines.filter((line) => /^ +braces: /.test(line))
  if (refs.length !== 2 || refs.some((line) => line !== `      braces: 3.0.3(patch_hash=${digest})`)) {
    failures.push('pnpm-lock.yaml braces references are not exactly the two patched parent edges')
  }
}

function resolveChains(root, failures) {
  const bracesRoots = new Set()
  let complete = true
  for (const chain of consumerChains) {
    let parent = join(root, 'apps/web/package.json')
    try {
      for (const [name, version] of chain) {
        const entry = createRequire(parent).resolve(name)
        const packageRoot = packageRootOf(entry, name)
        const actual = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version
        if (actual !== version) throw new Error(`${name} resolved to ${actual}, expected ${version}`)
        if (name === 'braces') bracesRoots.add(realpathSync(packageRoot))
        parent = entry
      }
    } catch (cause) {
      complete = false
      failures.push(`consumer chain ${chainPath(chain)} failed: ${cause.message}`)
    }
  }
  if (bracesRoots.size > 1) failures.push('consumer chains resolve braces to different package directories')
  return complete && bracesRoots.size === 1 ? [...bracesRoots][0] : undefined
}

// Closed inventory: exactly the tarball's paths as regular files with the reviewed bytes, and only
// the lib directory. Any extra name (an extensionless lib/compile, .json, .node, ...), missing file,
// symlink or other entry type fails, because Node may resolve such a name before the reviewed file.
function checkInventory(packageRoot, failures) {
  const files = new Map()
  const dirs = []
  const pending = ['']
  let entries = 0
  while (pending.length > 0) {
    const dir = pending.pop()
    for (const name of readdirSync(join(packageRoot, dir))) {
      if (++entries > 1000) throw new Error('braces package has too many entries')
      const path = dir ? `${dir}/${name}` : name
      const stat = lstatSync(join(packageRoot, path))
      if (stat.isDirectory()) {
        dirs.push(path)
        pending.push(path)
      } else if (stat.isFile()) {
        files.set(path, sha256(readFileSync(join(packageRoot, path))))
      } else {
        failures.push(`braces package entry is not a regular file or directory: ${path}`)
      }
    }
  }
  for (const path of files.keys()) {
    if (!Object.hasOwn(expectedFiles, path)) failures.push(`unexpected braces package file: ${path}`)
  }
  for (const [path, digest] of Object.entries(expectedFiles)) {
    if (!files.has(path)) failures.push(`missing braces package file: ${path}`)
    else if (files.get(path) !== digest) failures.push(`braces package file differs from the reviewed bytes: ${path}`)
  }
  if (JSON.stringify(dirs.sort()) !== JSON.stringify(['lib'])) {
    failures.push(`unexpected braces package directories: ${dirs.join(', ')}`)
  }
}

// Package-internal relative requires in the reviewed sources and the file each must resolve to.
const internalRequires = Object.freeze({
  'index.js': { './lib/stringify': 'lib/stringify.js', './lib/compile': 'lib/compile.js',
    './lib/expand': 'lib/expand.js', './lib/parse': 'lib/parse.js' },
  'lib/compile.js': { './utils': 'lib/utils.js', './constants': 'lib/constants.js' },
  'lib/expand.js': { './stringify': 'lib/stringify.js', './utils': 'lib/utils.js', './constants': 'lib/constants.js' },
  'lib/parse.js': { './stringify': 'lib/stringify.js', './constants': 'lib/constants.js' },
  'lib/stringify.js': { './utils': 'lib/utils.js', './constants': 'lib/constants.js' },
})

// Resolver identity: Node's own resolution (exact path, then .js, .json, .node) must select the
// hashed file. Resolving does not execute anything.
function checkInternalRequires(packageRoot, failures) {
  for (const [file, requests] of Object.entries(internalRequires)) {
    const require = createRequire(join(packageRoot, file))
    for (const [request, target] of Object.entries(requests)) {
      let resolved
      try {
        resolved = realpathSync(require.resolve(request))
      } catch {
        failures.push(`braces ${file} cannot resolve ${request}`)
        continue
      }
      if (resolved !== join(packageRoot, target)) failures.push(`braces ${file} resolves ${request} to ${resolved}, not ${target}`)
    }
  }
}

// Byte and resolver identity only; nothing here loads package code.
export function preflight({ root = defaultRoot } = {}) {
  const failures = []
  let bracesRoot
  try {
    checkBinding(root, failures)
    bracesRoot = resolveChains(root, failures)
    if (bracesRoot) {
      checkInventory(bracesRoot, failures)
      checkInternalRequires(bracesRoot, failures)
    }
  } catch (cause) {
    failures.push(`preflight could not complete: ${cause.message}`)
  }
  return { ok: failures.length === 0, failures, bracesRoot }
}

const probeToken = 'braces-depth-probe-ok'
// Finite behavior corroboration, run in a bounded child only after the byte preflight passed.
const probeSource = `
const braces = require(process.argv[1])
const nest = (depth, open, close, inner) => open.repeat(depth) + inner + close.repeat(depth)
const ast = (depth) => {
  let node = { type: 'text', value: 'a' }
  for (let level = 0; level < depth; level++) {
    node = { type: 'brace', nodes: [{ type: 'open', value: '{' }, node, { type: 'close', value: '}' }] }
  }
  return { type: 'root', nodes: [node] }
}
const marked = (depth, marker) => {
  const tree = ast(depth)
  tree.nodes[0][marker] = true
  return tree
}
const rejects = (call, name) => {
  try { call() } catch (error) { return error.name === name && /exceeds max depth/.test(error.message) }
  return false
}
const checks = [nest(101, '{', '}', 'a,b'), nest(101, '(', ')', 'a'), nest(4998, '{', '}', 'a,b')].flatMap((input) => [
  rejects(() => braces(input), 'SyntaxError'), rejects(() => braces.parse(input), 'SyntaxError'),
  rejects(() => braces.compile(input), 'SyntaxError'), rejects(() => braces.expand(input), 'SyntaxError'),
  rejects(() => braces.stringify(input), 'SyntaxError'),
]).concat([
  rejects(() => braces.compile(ast(101)), 'RangeError'),
  rejects(() => braces.expand(ast(101)), 'RangeError'),
  rejects(() => braces.stringify(ast(101)), 'RangeError'),
  rejects(() => braces.expand(marked(101, 'dollar')), 'RangeError'),
  rejects(() => braces.expand(marked(101, 'invalid')), 'RangeError'),
  braces.compile(ast(100)) === nest(100, '{', '}', 'a'),
  JSON.stringify(braces(nest(100, '{', '}', 'a,b'))) === JSON.stringify([nest(99, '{', '}', '(a|b)')]),
])
process.stdout.write(checks.every(Boolean) ? '${probeToken}' : 'braces-depth-probe-failed:' + checks.map(Number).join(''))
`

export function probeBraces(entry, { spawn = spawnSync, timeoutMs = 15000 } = {}) {
  const result = spawn(process.execPath, ['-e', probeSource, entry], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
  })
  if (!result || result.error || result.signal || result.status !== 0) {
    return `depth probe did not complete (${result?.error?.code ?? result?.signal ?? result?.status})`
  }
  if (result.stderr !== '' || result.stdout !== probeToken) return `depth probe failed: ${String(result.stdout).slice(0, 200)}`
  return undefined
}

// The audit's verification: byte and resolver preflight first, behavior probe only after it passed.
export function verifyBracesRemediation({ root = defaultRoot, spawn = spawnSync } = {}) {
  const checked = preflight({ root })
  if (!checked.ok) return { ...checked, probe: 'not run' }
  const failure = probeBraces(join(checked.bracesRoot, 'index.js'), { spawn })
  if (failure) return { ok: false, failures: [failure], bracesRoot: checked.bracesRoot, probe: 'failed' }
  return { ...checked, probe: 'passed' }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = preflight({ root: process.argv[2] ? resolve(process.argv[2]) : defaultRoot })
  if (result.ok) {
    console.log(`braces byte preflight passed: ${patchPath} and the installed braces@3.0.3 match the reviewed bytes on all ${consumerChains.length} consumer chains.`)
  } else {
    console.error('braces byte preflight failed:')
    for (const failure of result.failures) console.error(`- ${failure}`)
  }
  process.exitCode = result.ok ? 0 : 1
}
