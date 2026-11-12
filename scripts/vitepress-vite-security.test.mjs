import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

// Vite GHSA-8g5g-mxqh-grgj / CVE-2026-118662: `server.fs.deny` is bypassed with query suffixes on
// the dev server. Affected is exactly 6.4.4; 6.4.5 is the first patched release. Only the VitePress
// docs toolchain resolves Vite 6 here. The installed-consumer checks for both VitePress edges and
// the Vite 8 consumers live in dependency-compatibility-smoke.test.mjs; this file checks the
// committed manifest and lock bytes, so it needs no installed tree.
const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const lock = readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8')

test('the VitePress Vite override is exactly 6.4.5 in the manifest and the lock', () => {
  assert.equal(manifest.pnpm.overrides['vitepress>vite'], '6.4.5')
  const overrides = /\noverrides:\n((?: {2}.*\n)+)/.exec(lock)?.[1]
  assert.ok(overrides, 'pnpm-lock.yaml has no overrides block')
  assert.deepEqual(overrides.split('\n').filter((line) => line.startsWith('  vitepress>vite:')), ['  vitepress>vite: 6.4.5'])
})

test('the lock resolves the patched Vite 6.4.5 package, snapshot and consumer edge', () => {
  assert.match(lock, /\n {2}vite@6\.4\.5:\n {4}resolution: \{integrity: sha512-[A-Za-z0-9+/]{86}==\}\n/)
  assert.match(lock, /\n {2}vite@6\.4\.5\(.*\):\n/)
  assert.match(lock, /\n {6}vite: 6\.4\.5\(.*\)\n/)
})

test('no locked package, snapshot or edge resolves the affected Vite 6.4.4', () => {
  assert.doesNotMatch(lock, /vite@6\.4\.4(?![0-9])/)
  assert.doesNotMatch(lock, /\n +vite: '?6\.4\.4(?![0-9])/)
})
