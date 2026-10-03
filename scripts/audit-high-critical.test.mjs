import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { runAudit } from './audit-high-critical.mjs'

const fixtures = resolve(import.meta.dirname, 'test-fixtures/audit-high-critical')
const quiet = { log: () => {}, error: () => {} }

function report(name) {
  return readFileSync(resolve(fixtures, name), 'utf8')
}

function fakeResult({ status = 0, stdout, stderr = '', signal = null, error } = {}) {
  return () => ({ status, stdout, stderr, signal, error })
}

test('accepts a clean status 0 audit report', () => {
  assert.equal(runAudit({ spawn: fakeResult({ stdout: report('clean.json') }), ...quiet }), 0)
})

test('evaluates a structurally valid advisory report returned with status 1', () => {
  assert.equal(runAudit({ spawn: fakeResult({ status: 1, stdout: report('advisory-status-1.json') }), ...quiet }), 0)
})

test('fails closed for malformed JSON and top-level error responses', () => {
  assert.equal(runAudit({ spawn: fakeResult({ stdout: '' }), ...quiet }), 1)
  assert.equal(runAudit({ spawn: fakeResult({ stdout: '{not json' }), ...quiet }), 1)
  assert.equal(runAudit({ spawn: fakeResult({ status: 1, stdout: report('top-level-error.json') }), ...quiet }), 1)
})

test('fails closed for malformed metadata, advisory identity, severity, and high/critical count contradictions', () => {
  for (const fixture of [
    'missing-metadata.json',
    'malformed-metadata.json',
    'empty-advisory-identity.json',
    'malformed-advisory-identity.json',
    'unknown-severity.json',
    'high-record-with-zero-metadata.json',
    'high-metadata-without-record.json',
    'critical-record-with-zero-metadata.json',
    'critical-metadata-without-record.json',
  ]) {
    assert.equal(runAudit({ spawn: fakeResult({ status: 1, stdout: report(fixture) }), ...quiet }), 1, fixture)
  }
})

test('fails closed for unknown high and critical advisories', () => {
  assert.equal(runAudit({ spawn: fakeResult({ status: 1, stdout: report('unknown-high.json') }), ...quiet }), 1)
  assert.equal(runAudit({ spawn: fakeResult({ status: 1, stdout: report('unknown-critical.json') }), ...quiet }), 1)
})

const bracesExpiry = Date.parse('2026-10-10T00:00:00Z')

function bracesReport(mutate = () => {}) {
  const parsed = JSON.parse(report('braces-excepted.json'))
  mutate(parsed, parsed.advisories['1240992'])
  return JSON.stringify(parsed)
}

function auditBraces(stdout, now = bracesExpiry - 1) {
  return runAudit({ spawn: fakeResult({ status: 1, stdout }), now: () => now, ...quiet })
}

test('accepts only the exact braces 3.0.3 tooling advisory before its expiry', () => {
  assert.equal(auditBraces(bracesReport()), 0)
})

test('fails closed unless the braces finding reports exactly the reviewed tooling path set', () => {
  for (const [name, mutate] of [
    ['path subset', (parsed, advisory) => { advisory.findings[0].paths = advisory.findings[0].paths.slice(0, 1) }],
    ['duplicate path replacing a reviewed path', (parsed, advisory) => {
      advisory.findings[0].paths[1] = advisory.findings[0].paths[0]
    }],
    ['duplicate path appended', (parsed, advisory) => { advisory.findings[0].paths.push(advisory.findings[0].paths[0]) }],
    ['second finding', (parsed, advisory) => {
      advisory.findings.push({ ...advisory.findings[0] })
      parsed.metadata.vulnerabilities.high = 2
    }],
  ]) {
    assert.equal(auditBraces(bracesReport(mutate)), 1, name)
  }
})

test('reconciles pnpm 10.6.5 policy-severity counts with advisory findings before excepting braces', () => {
  for (const [name, mutate] of [
    ['excess high count', (parsed) => { parsed.metadata.vulnerabilities.high = 2 }],
    ['excess critical count', (parsed) => { parsed.metadata.vulnerabilities.critical = 1 }],
    ['negative high count', (parsed) => { parsed.metadata.vulnerabilities.high = -1 }],
    ['high record without findings beside braces', (parsed) => {
      parsed.advisories['2'] = JSON.parse(report('unknown-high.json')).advisories['1']
      parsed.metadata.vulnerabilities.high = 2
    }],
    ['high record with findings and a short count', (parsed) => {
      parsed.advisories['2'] = {
        ...JSON.parse(report('unknown-high.json')).advisories['1'],
        findings: [{ version: '1.0.0', paths: ['apps/web > unexpected-package@1.0.0'] }],
      }
    }],
    ['duplicate finding versions', (parsed, advisory) => {
      advisory.findings.push({ version: '3.0.3', paths: ['apps/web > tailwindcss@3.4.19 > micromatch@4.0.8 > braces@3.0.3'] })
      parsed.metadata.vulnerabilities.high = 2
    }],
  ]) {
    assert.equal(auditBraces(bracesReport(mutate)), 1, name)
  }
  assert.equal(auditBraces(bracesReport((parsed) => { parsed.metadata.vulnerabilities.moderate = 3 })), 0)
})

test('fails closed for the braces exception at and after its expiry boundary', () => {
  assert.equal(auditBraces(bracesReport(), bracesExpiry), 1)
  assert.equal(auditBraces(bracesReport(), bracesExpiry + 1), 1)
  assert.equal(auditBraces(bracesReport(), Number.NaN), 1)
})

test('does not except other braces advisories, versions, packages, severities, or ranges', () => {
  for (const [name, mutate] of [
    ['older braces advisory', (parsed, advisory) => {
      advisory.github_advisory_id = 'GHSA-grv7-fg5c-xmjg'
      advisory.url = 'https://github.com/advisories/GHSA-grv7-fg5c-xmjg'
      advisory.vulnerable_versions = '<3.0.3'
    }],
    ['mismatched url', (parsed, advisory) => { advisory.url = 'https://github.com/advisories/GHSA-grv7-fg5c-xmjg' }],
    ['missing advisory id', (parsed, advisory) => { delete advisory.github_advisory_id }],
    ['other braces version', (parsed, advisory) => {
      advisory.findings[0].version = '3.0.2'
      advisory.findings[0].paths = advisory.findings[0].paths.map((path) => path.replace('braces@3.0.3', 'braces@3.0.2'))
    }],
    ['other package', (parsed, advisory) => { advisory.module_name = 'micromatch' }],
    ['critical severity', (parsed, advisory) => {
      advisory.severity = 'critical'
      parsed.metadata.vulnerabilities = { critical: 1, high: 0, moderate: 0, low: 0 }
    }],
    ['widened range', (parsed, advisory) => { advisory.vulnerable_versions = '<=3.0.4' }],
    ['missing findings', (parsed, advisory) => { delete advisory.findings }],
    ['empty findings', (parsed, advisory) => { advisory.findings = [] }],
    ['empty paths', (parsed, advisory) => { advisory.findings[0].paths = [] }],
    ['malformed finding', (parsed, advisory) => { advisory.findings = ['3.0.3'] }],
  ]) {
    assert.equal(auditBraces(bracesReport(mutate)), 1, name)
  }
})

test('fails closed when braces 3.0.3 gains a dependency edge outside the reviewed tooling paths', () => {
  for (const path of [
    'apps/web > next@15.5.24 > micromatch@4.0.8 > braces@3.0.3',
    'packages/core > micromatch@4.0.8 > braces@3.0.3',
    'apps/web > tailwindcss@3.4.20 > micromatch@4.0.8 > braces@3.0.3',
    'apps/web > @ducanh2912/next-pwa@10.2.9 > fast-glob@3.3.2 > micromatch@4.0.8 > braces@3.0.3 > extra',
  ]) {
    assert.equal(auditBraces(bracesReport((parsed, advisory) => { advisory.findings[0].paths.push(path) })), 1, path)
  }
})

test('keeps blocking unknown high/critical advisories and malformed reports beside the braces exception', () => {
  assert.equal(auditBraces(bracesReport((parsed) => {
    parsed.advisories['2'] = JSON.parse(report('unknown-high.json')).advisories['1']
  })), 1)
  assert.equal(auditBraces(bracesReport((parsed) => {
    parsed.advisories['2'] = JSON.parse(report('unknown-critical.json')).advisories['1']
    parsed.metadata.vulnerabilities.critical = 1
  })), 1)
  assert.equal(auditBraces(bracesReport((parsed) => { parsed.metadata.vulnerabilities.high = 0 })), 1)
  assert.equal(auditBraces(bracesReport((parsed) => { parsed.error = { code: 'ENOTFOUND' } })), 1)
  assert.equal(runAudit({ spawn: fakeResult({ status: 2, stdout: bracesReport() }), now: () => bracesExpiry - 1, ...quiet }), 1)
})

test('fails closed for spawn errors, signals, and unexpected statuses', () => {
  assert.equal(runAudit({ spawn: () => { throw new Error('ENOENT') }, ...quiet }), 1)
  assert.equal(runAudit({ spawn: fakeResult({ stdout: report('clean.json'), error: new Error('ENOENT') }), ...quiet }), 1)
  assert.equal(runAudit({ spawn: fakeResult({ stdout: report('clean.json'), signal: 'SIGTERM' }), ...quiet }), 1)
  assert.equal(runAudit({ spawn: fakeResult({ status: 2, stdout: report('clean.json') }), ...quiet }), 1)
})
