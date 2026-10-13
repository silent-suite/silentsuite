import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { runAudit } from './audit-high-critical.mjs'

const fixture = readFileSync(resolve(import.meta.dirname, 'test-fixtures/audit-high-critical/braces-excepted.json'), 'utf8')
const beforeOldExpiry = Date.parse('2026-10-13T00:00:00Z')
const quiet = { log: () => {}, error: () => {} }
const reviewedPaths = [
  'apps/web > @ducanh2912/next-pwa@10.2.9 > fast-glob@3.3.2 > micromatch@4.0.8 > braces@3.0.3',
  'apps/web > eslint-config-next@15.5.24 > @next/eslint-plugin-next@15.5.24 > fast-glob@3.3.1 > micromatch@4.0.8 > braces@3.0.3',
  'apps/web > tailwindcss@3.4.19 > chokidar@3.6.0 > braces@3.0.3',
  'apps/web > tailwindcss@3.4.19 > fast-glob@3.3.3 > micromatch@4.0.8 > braces@3.0.3',
  'apps/web > tailwindcss@3.4.19 > micromatch@4.0.8 > braces@3.0.3',
  'apps/web > tailwindcss-animate@1.0.7 > tailwindcss@3.4.19 > chokidar@3.6.0 > braces@3.0.3',
  'apps/web > tailwindcss-animate@1.0.7 > tailwindcss@3.4.19 > fast-glob@3.3.3 > micromatch@4.0.8 > braces@3.0.3',
  'apps/web > tailwindcss-animate@1.0.7 > tailwindcss@3.4.19 > micromatch@4.0.8 > braces@3.0.3',
]

test('uses the exact braces advisory fixture with the no-patched-release marker and eight paths', () => {
  const report = JSON.parse(fixture)
  const advisories = Object.values(report.advisories)
  assert.equal(advisories.length, 1)
  const [advisory] = advisories
  assert.equal(advisory.github_advisory_id, 'GHSA-vfj7-8cjw-p6xm')
  assert.equal(advisory.url, 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm')
  assert.equal(advisory.module_name, 'braces')
  assert.equal(advisory.severity, 'high')
  assert.equal(advisory.vulnerable_versions, '<=3.0.3')
  assert.equal(advisory.patched_versions, '<0.0.0')
  assert.equal(advisory.findings.length, 1)
  assert.equal(advisory.findings[0].version, '3.0.3')
  assert.deepEqual(advisory.findings[0].paths, reviewedPaths)
  assert.deepEqual(report.metadata.vulnerabilities, { critical: 0, high: 1, moderate: 0, low: 0 })
})

test('rejects the exact braces advisory before the old expiry unless a verified remediation backs it', () => {
  const calls = []
  const spawn = (command, args) => {
    calls.push([command, args])
    return { status: 1, stdout: fixture, stderr: '', signal: null }
  }
  const exitCode = runAudit({ spawn, now: () => beforeOldExpiry, ...quiet })
  assert.deepEqual(calls, [['pnpm', ['audit', '--audit-level=high', '--json']]])
  assert.equal(exitCode, 1, 'runAudit accepted the braces advisory without verifying the installed code')
})
