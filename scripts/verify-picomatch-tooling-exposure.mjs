import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const repository = resolve(import.meta.dirname, '..')
const require = createRequire(resolve(repository, 'apps/web/package.json'))
const reviewedPaths = JSON.parse(readFileSync(new URL('./test-fixtures/audit-high-critical/picomatch-reviewed-paths.json', import.meta.url), 'utf8'))

// The registry quick report lists only one path for this shared package. Check the complete lock
// closure too, including dependency kinds, so an unreported runtime consumer cannot inherit approval.
export function picomatchPaths(lock) {
  assert.equal(lock.lockfileVersion, '9.0')
  assert.deepEqual(Object.keys(lock.snapshots).filter(id => id.startsWith('picomatch@')), ['picomatch@4.0.4'])
  const edges = []
  // An npm alias stores the resolved package name in the version field.
  const target = (name, version) => Object.hasOwn(lock.snapshots, version) ? version : `${name}@${version}`
  for (const [id, snapshot] of Object.entries(lock.snapshots)) {
    for (const group of ['dependencies', 'optionalDependencies']) {
      for (const [name, version] of Object.entries(snapshot[group] ?? {})) {
        edges.push({ from: id, to: target(name, version) })
      }
    }
  }
  for (const [id, importer] of Object.entries(lock.importers)) {
    for (const group of ['dependencies', 'optionalDependencies', 'devDependencies']) {
      for (const [name, dependency] of Object.entries(importer[group] ?? {})) {
        if (!dependency.version.startsWith('link:')) {
          edges.push({ from: `${id} [${group}]`, to: target(name, dependency.version), importer: true })
        }
      }
    }
  }
  const paths = []
  function walk(id, suffix, seen) {
    assert.ok(seen.size <= 30 && paths.length <= 1000, 'picomatch closure exceeds bounds')
    for (const edge of edges.filter(candidate => candidate.to === id)) {
      if (edge.importer) paths.push([edge.from, ...suffix].join(' > '))
      else if (!seen.has(edge.from)) {
        walk(edge.from, [edge.from.replace(/\(.*$/, ''), ...suffix], new Set([...seen, edge.from]))
      }
    }
  }
  walk('picomatch@4.0.4', ['picomatch@4.0.4'], new Set(['picomatch@4.0.4']))
  return [...new Set(paths)].sort()
}

export function verifyPicomatchToolingExposure({ root = repository } = {}) {
  try {
    // yaml is already a pinned web dev dependency; no vulnerable matcher is executed here.
    const lock = require('yaml').parse(readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8'))
    assert.deepEqual(picomatchPaths(lock), reviewedPaths, 'picomatch dependency closure changed')
    return { ok: true, failures: [] }
  } catch {
    return { ok: false, failures: ['Could not verify the reviewed picomatch dependency closure.'] }
  }
}
