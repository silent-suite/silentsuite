import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync,
  unlinkSync, writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import test from 'node:test'
import {
  consumerChains, packageRootOf, patchDigest, preflight, probeBraces, verifyBracesRemediation,
} from './braces-byte-preflight.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const preflightScript = join(import.meta.dirname, 'braces-byte-preflight.mjs')
const installed = preflight()
const installedEntry = join(installed.bracesRoot, 'index.js')
const fillRangeRoot = dirname(createRequire(installedEntry).resolve('fill-range/package.json'))
const sentinelCode = 'require("node:fs").writeFileSync(process.argv[1], "loaded")'
const walkerGuard = [
  '    if (node.nodes && depth > MAX_DEPTH) {',
  '      throw new RangeError(`AST depth exceeds max depth (${MAX_DEPTH})`);',
  '    }',
  '',
  '',
].join('\n')

// The pinned etebase SDK patch, the only patch allowed beside braces.
const etebaseKey = 'etebase@0.43.1'
const etebasePatch = 'patches/etebase@0.43.1.patch'
const etebaseDigest = '78084d835e90b41b34784e7f037bfa8ca5ee715d614a39d2779539293a8fcb02'
const etebaseLockEntry = `  ${etebaseKey}:\n    hash: ${etebaseDigest}\n    path: ${etebasePatch}\n`

const temps = []
test.after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

function edit(file, change) {
  writeFileSync(file, change(readFileSync(file, 'utf8')))
}

// An isolated root: copies of the root manifest, lock, patch and apps/web manifest; every consumer
// hop mirrored with its real manifest and an empty entry file (resolution never executes it); and a
// full copy of the installed patched braces. The real install is never touched.
function fixtureRoot({ nodeModules = true } = {}) {
  const root = tempDir('braces-preflight-root-')
  for (const file of ['package.json', 'pnpm-lock.yaml', 'patches/braces@3.0.3.patch', etebasePatch, 'apps/web/package.json']) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    copyFileSync(join(repoRoot, file), join(root, file))
  }
  if (!nodeModules) return root
  for (const chain of consumerChains) {
    let realParent = join(repoRoot, 'apps/web/package.json')
    let dir = join(root, 'apps/web')
    for (const [name] of chain.slice(0, -1)) {
      const realEntry = createRequire(realParent).resolve(name)
      const realRoot = packageRootOf(realEntry, name)
      dir = join(dir, 'node_modules', name)
      mkdirSync(dirname(join(dir, relative(realRoot, realEntry))), { recursive: true })
      copyFileSync(join(realRoot, 'package.json'), join(dir, 'package.json'))
      writeFileSync(join(dir, relative(realRoot, realEntry)), '')
      realParent = realEntry
    }
  }
  cpSync(installed.bracesRoot, join(root, 'node_modules/braces'), { recursive: true })
  return root
}

test('accepts the real patched install on all eight consumer chains', () => {
  assert.deepEqual(installed.failures, [])
  assert.equal(installed.ok, true)
  assert.equal(consumerChains.length, 8)
})

test('accepts an isolated fixture root that mirrors the reviewed install', () => {
  assert.deepEqual(preflight({ root: fixtureRoot() }).failures, [])
})

function declare(root, entries) {
  edit(join(root, 'package.json'), (text) => {
    const manifest = JSON.parse(text)
    manifest.pnpm.patchedDependencies = Object.fromEntries(entries)
    return JSON.stringify(manifest, null, 2)
  })
}

const bracesDeclaration = ['braces@3.0.3', 'patches/braces@3.0.3.patch']
const etebaseDeclaration = [etebaseKey, etebasePatch]

test('accepts the real dual declaration: the reviewed braces patch plus the pinned etebase SDK patch', () => {
  const root = fixtureRoot()
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.pnpm.patchedDependencies, Object.fromEntries([bracesDeclaration, etebaseDeclaration]))
  assert.ok(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8').includes(etebaseLockEntry))
  assert.deepEqual(preflight({ root }).failures, [])
})

test('accepts the braces-only declaration and either declaration order', () => {
  const bracesOnly = fixtureRoot()
  declare(bracesOnly, [bracesDeclaration])
  edit(join(bracesOnly, 'pnpm-lock.yaml'), (text) => text.replace(etebaseLockEntry, ''))
  unlinkSync(join(bracesOnly, etebasePatch))
  assert.deepEqual(preflight({ root: bracesOnly }).failures, [])
  const reordered = fixtureRoot()
  declare(reordered, [etebaseDeclaration, bracesDeclaration])
  assert.deepEqual(preflight({ root: reordered }).failures, [])
})

test('rejects any other patch set, a changed etebase binding and a manifest/lock mismatch', () => {
  const lock = (root) => join(root, 'pnpm-lock.yaml')
  const otherDigest = 'a'.repeat(64)
  const otherLockEntry = `  lodash@4.17.21:\n    hash: ${otherDigest}\n    path: patches/lodash@4.17.21.patch\n`
  for (const [label, mutate] of [
    ['unknown additional patch', (root) => {
      declare(root, [bracesDeclaration, etebaseDeclaration, ['lodash@4.17.21', 'patches/lodash@4.17.21.patch']])
      writeFileSync(join(root, 'patches/lodash@4.17.21.patch'), '')
      edit(lock(root), (text) => text.replace(etebaseLockEntry, etebaseLockEntry + otherLockEntry))
    }],
    ['unknown patch instead of etebase', (root) => {
      declare(root, [bracesDeclaration, ['lodash@4.17.21', 'patches/lodash@4.17.21.patch']])
      edit(lock(root), (text) => text.replace(etebaseLockEntry, otherLockEntry))
    }],
    ['etebase without braces', (root) => declare(root, [etebaseDeclaration])],
    ['other etebase version', (root) => declare(root, [bracesDeclaration, ['etebase@0.43.2', etebasePatch]])],
    ['wrong etebase path', (root) => declare(root, [bracesDeclaration, [etebaseKey, 'patches/etebase.patch']])],
    ['etebase lock hash', (root) => edit(lock(root), (text) => text.replace(`hash: ${etebaseDigest}`, `hash: ${otherDigest}`))],
    ['etebase patch bytes', (root) => appendFileSync(join(root, etebasePatch), '\n')],
    ['etebase patch missing', (root) => unlinkSync(join(root, etebasePatch))],
    ['etebase declared, not locked', (root) => edit(lock(root), (text) => text.replace(etebaseLockEntry, ''))],
    ['etebase locked, not declared', (root) => declare(root, [bracesDeclaration])],
    ['duplicate lock binding', (root) => edit(lock(root), (text) => text.replace('\nimporters:\n',
      `\npatchedDependencies:\n  braces@3.0.3:\n    hash: ${patchDigest}\n    path: patches/braces@3.0.3.patch\n\nimporters:\n`))],
    ['non-object declaration', (root) => edit(join(root, 'package.json'), (text) => {
      const manifest = JSON.parse(text)
      manifest.pnpm.patchedDependencies = [bracesDeclaration, etebaseDeclaration]
      return JSON.stringify(manifest)
    })],
  ]) {
    const root = fixtureRoot()
    mutate(root)
    assert.equal(preflight({ root }).ok, false, label)
  }
})

test('rejects an extensionless shadow before any package code runs', () => {
  const root = fixtureRoot()
  const braces = join(root, 'node_modules/braces')
  const sentinel = join(root, 'shadow-loaded')
  writeFileSync(join(braces, 'lib/compile'), `${sentinelCode.replace('process.argv[1]', JSON.stringify(sentinel))}\n`)
  // Node tries the exact path before adding .js, so this file, not lib/compile.js, would load.
  assert.equal(realpathSync(createRequire(join(braces, 'index.js')).resolve('./lib/compile')),
    realpathSync(join(braces, 'lib/compile')))
  const result = preflight({ root })
  assert.equal(result.ok, false, 'preflight accepted an extensionless shadow')
  assert.ok(result.failures.some((failure) => failure.includes('lib/compile')), result.failures.join('; '))
  assert.equal(existsSync(sentinel), false)
})

test('rejects closed-inventory violations: .json and .node siblings, a symlinked file, a missing file and an extra directory', () => {
  for (const [label, mutate] of [
    ['lib/compile.json', (braces) => writeFileSync(join(braces, 'lib/compile.json'), '{}')],
    ['lib/compile.node', (braces) => writeFileSync(join(braces, 'lib/compile.node'), '')],
    ['symlinked lib/utils.js', (braces) => {
      const target = join(dirname(braces), 'utils-copy.js')
      copyFileSync(join(braces, 'lib/utils.js'), target)
      unlinkSync(join(braces, 'lib/utils.js'))
      symlinkSync(target, join(braces, 'lib/utils.js'))
    }],
    ['missing README.md', (braces) => unlinkSync(join(braces, 'README.md'))],
    ['extra directory', (braces) => mkdirSync(join(braces, 'extra'))],
  ]) {
    const root = fixtureRoot()
    mutate(join(root, 'node_modules/braces'))
    assert.equal(preflight({ root }).ok, false, label)
  }
})

test('rejects coordinated patch and lock drift away from the reviewed digest', () => {
  const root = fixtureRoot()
  const patch = join(root, 'patches/braces@3.0.3.patch')
  appendFileSync(patch, '\n')
  const drifted = createHash('sha256').update(readFileSync(patch, 'utf8').replace(/\r\n/g, '\n')).digest('hex')
  assert.notEqual(drifted, patchDigest)
  edit(join(root, 'pnpm-lock.yaml'), (text) => text.replaceAll(patchDigest, drifted))
  assert.equal(preflight({ root }).ok, false,
    'preflight accepted a patch and lock that agree with each other but not with the reviewed digest')
})

test('canonical command order: a failing preflight stops the && chain before any later step', () => {
  const run = (root, sentinel) => spawnSync('sh', ['-c',
    `'${process.execPath}' '${preflightScript}' '${root}' && '${process.execPath}' -e '${sentinelCode}' '${sentinel}'`],
  { encoding: 'utf8', timeout: 60000 })
  const altered = fixtureRoot()
  appendFileSync(join(altered, 'node_modules/braces/lib/compile.js'), '\n// altered\n')
  const blocked = join(altered, 'later-step-ran')
  assert.notEqual(run(altered, blocked).status, 0)
  assert.equal(existsSync(blocked), false)
  // Positive load control: after a passing preflight the later step really runs.
  const clean = fixtureRoot()
  const allowed = join(clean, 'later-step-ran')
  const passed = run(clean, allowed)
  assert.equal(passed.status, 0, passed.stderr)
  assert.equal(existsSync(allowed), true)
  const { scripts } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  assert.equal(scripts['audit:security'],
    'node scripts/braces-byte-preflight.mjs && pnpm run test:dependency-security && node scripts/audit-high-critical.mjs')
})

test('rejects a missing or changed patch, non-canonical integrity, unpatched or second snapshots and a missing declaration', () => {
  const lock = (root) => join(root, 'pnpm-lock.yaml')
  for (const [label, mutate] of [
    ['missing patch', (root) => unlinkSync(join(root, 'patches/braces@3.0.3.patch'))],
    ['changed patch only', (root) => appendFileSync(join(root, 'patches/braces@3.0.3.patch'), '\n')],
    ['integrity', (root) => edit(lock(root), (text) => text.replace('{integrity: sha512-yQbX', '{integrity: sha512-AQbX'))],
    ['unpatched snapshot', (root) => edit(lock(root), (text) => text.replaceAll(`3.0.3(patch_hash=${patchDigest})`, '3.0.3'))],
    ['second snapshot', (root) => edit(lock(root), (text) => text.replace(`\n  braces@3.0.3(patch_hash=${patchDigest}):\n`,
      `\n  braces@3.0.2:\n    dependencies:\n      fill-range: 7.1.1\n\n  braces@3.0.3(patch_hash=${patchDigest}):\n`))],
    ['declaration removed', (root) => edit(join(root, 'package.json'), (text) => {
      const manifest = JSON.parse(text)
      delete manifest.pnpm.patchedDependencies
      return JSON.stringify(manifest)
    })],
  ]) {
    const root = fixtureRoot()
    mutate(root)
    assert.equal(preflight({ root }).ok, false, label)
  }
})

test('rejects a root without node_modules', () => {
  const result = preflight({ root: fixtureRoot({ nodeModules: false }) })
  assert.equal(result.ok, false)
  assert.ok(result.failures.some((failure) => failure.startsWith('consumer chain')), result.failures.join('; '))
})

test('rejects an intermediate consumer edge that resolves other braces bytes even when a shortened lookup does not', () => {
  const root = fixtureRoot()
  const fastGlob = join(root, 'apps/web/node_modules/@ducanh2912/next-pwa/node_modules/fast-glob')
  const nested = join(fastGlob, 'node_modules/micromatch/node_modules/braces')
  cpSync(join(root, 'node_modules/braces'), nested, { recursive: true })
  appendFileSync(join(nested, 'lib/compile.js'), '\n// other bytes\n')
  // Resolving braces directly from fast-glob would still find the reviewed copy.
  assert.equal(realpathSync(createRequire(join(fastGlob, 'package.json')).resolve('braces')),
    realpathSync(join(root, 'node_modules/braces/index.js')))
  assert.equal(preflight({ root }).ok, false)
})

test('rejects altered lib/compile.js bytes before the behavior probe starts, although the probe alone would pass', () => {
  const root = fixtureRoot()
  appendFileSync(join(root, 'node_modules/braces/lib/compile.js'), '\n// still passes every finite probe\n')
  symlinkSync(fillRangeRoot, join(root, 'node_modules/fill-range'))
  let probes = 0
  const result = verifyBracesRemediation({ root, spawn: (...args) => { probes++; return spawnSync(...args) } })
  assert.equal(result.ok, false)
  assert.equal(result.probe, 'not run')
  assert.equal(probes, 0)
  assert.equal(probeBraces(join(root, 'node_modules/braces/index.js')), undefined)
})

test('behavior probe passes the real patched install and verification runs preflight first', () => {
  assert.equal(probeBraces(installedEntry), undefined)
  const result = verifyBracesRemediation()
  assert.deepEqual(result.failures, [])
  assert.equal(result.probe, 'passed')
})

test('behavior probe fails for each removed walker guard, a hang, extra output and a failing load', () => {
  for (const walker of ['compile', 'expand', 'stringify']) {
    const root = tempDir('braces-probe-mutant-')
    const braces = join(root, 'node_modules/braces')
    cpSync(installed.bracesRoot, braces, { recursive: true })
    symlinkSync(fillRangeRoot, join(root, 'node_modules/fill-range'))
    const file = join(braces, 'lib', `${walker}.js`)
    const source = readFileSync(file, 'utf8')
    assert.equal(source.split(walkerGuard).length, 2, walker)
    writeFileSync(file, source.replace(walkerGuard, ''))
    assert.match(probeBraces(join(braces, 'index.js')) ?? 'passed', /depth probe failed/, walker)
  }
  const stubs = tempDir('braces-probe-stub-')
  writeFileSync(join(stubs, 'hang.js'), 'for (;;) {}\n')
  writeFileSync(join(stubs, 'extra.js'), `console.log("extra"); module.exports = require(${JSON.stringify(installedEntry)})\n`)
  writeFileSync(join(stubs, 'throws.js'), 'throw new Error("load failed")\n')
  assert.match(probeBraces(join(stubs, 'hang.js'), { timeoutMs: 2000 }) ?? 'passed', /did not complete/)
  assert.match(probeBraces(join(stubs, 'extra.js')) ?? 'passed', /depth probe failed/)
  assert.match(probeBraces(join(stubs, 'throws.js')) ?? 'passed', /did not complete/)
})
