import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { bracesRemediation, runAudit } from './audit-high-critical.mjs'

const fixtures = resolve(import.meta.dirname, 'test-fixtures/audit-high-critical')
const quiet = { log: () => {}, error: () => {} }
// A root with no patch, lock or install: the braces remediation cannot be verified there. The
// default root is this repository, whose verified patched install the other cases rely on.
const unverifiedRoot = mkdtempSync(join(tmpdir(), 'braces-unverified-root-'))
test.after(() => rmSync(unverifiedRoot, { recursive: true, force: true }))

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

const oldExpiry = Date.parse('2026-10-14T00:00:00Z')

function bracesReport(mutate = () => {}) {
  const parsed = JSON.parse(report('braces-excepted.json'))
  mutate(parsed, parsed.advisories['1240992'])
  return JSON.stringify(parsed)
}

function auditBraces(stdout, root) {
  return runAudit({ spawn: fakeResult({ status: 1, stdout }), root, ...quiet })
}

test('accepts the exact braces 3.0.3 tooling advisory only with verified patched code', () => {
  assert.equal(auditBraces(bracesReport()), 0)
  assert.equal(auditBraces(bracesReport(), unverifiedRoot), 1)
})

test('binds the disposition to the no-patched-release marker and the eight reviewed paths, without an expiry', () => {
  assert.equal(bracesRemediation.patchedVersions, '<0.0.0')
  assert.equal(bracesRemediation.paths.size, 8)
  assert.equal(Object.hasOwn(bracesRemediation, 'expiresAt'), false)
})

test('decides by verification, not the clock, before, at and after the old expiry', (t) => {
  for (const instant of [oldExpiry - 1, oldExpiry, oldExpiry + 1]) {
    t.mock.timers.enable({ apis: ['Date'], now: instant })
    assert.equal(Date.now(), instant)
    assert.equal(auditBraces(bracesReport()), 0, `verified at ${instant}`)
    assert.equal(auditBraces(bracesReport(), unverifiedRoot), 1, `unverified at ${instant}`)
    t.mock.timers.reset()
  }
})

test('prints the raw high count and names the verified local remediation', () => {
  const lines = []
  const exitCode = runAudit({ spawn: fakeResult({ status: 1, stdout: bracesReport() }), log: (line) => lines.push(line), error: () => {} })
  assert.equal(exitCode, 0)
  assert.equal(lines[0], 'Dependency audit summary: 0 critical, 1 high, 0 moderate, 0 low.')
  assert.match(lines[1], /^Raw finding locally remediated by the verified patch \(still counted above\): high: braces@3\.0\.3 — GHSA-vfj7-8cjw-p6xm$/)
})

test('fails closed when the remediation cannot be verified, even for a clean report', () => {
  assert.equal(runAudit({ spawn: fakeResult({ stdout: report('clean.json') }), root: unverifiedRoot, ...quiet }), 1)
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

test('reconciles registry audit policy-severity counts with advisory findings before remediating braces', () => {
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

test('does not remediate other braces advisories, versions, packages, severities, ranges or patched-version markers', () => {
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
    ['malformed marker', (parsed, advisory) => { advisory.patched_versions = '<0.0.0>' }],
    ['published fix', (parsed, advisory) => { advisory.patched_versions = '>=3.0.4' }],
    ['missing marker', (parsed, advisory) => { delete advisory.patched_versions }],
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

test('keeps blocking unknown high/critical advisories and malformed reports beside the verified braces finding', () => {
  assert.equal(auditBraces(bracesReport((parsed) => {
    parsed.advisories['2'] = JSON.parse(report('unknown-high.json')).advisories['1']
  })), 1)
  assert.equal(auditBraces(bracesReport((parsed) => {
    parsed.advisories['2'] = JSON.parse(report('unknown-critical.json')).advisories['1']
    parsed.metadata.vulnerabilities.critical = 1
  })), 1)
  assert.equal(auditBraces(bracesReport((parsed) => { parsed.metadata.vulnerabilities.high = 0 })), 1)
  assert.equal(auditBraces(bracesReport((parsed) => { parsed.error = { code: 'ENOTFOUND' } })), 1)
  assert.equal(runAudit({ spawn: fakeResult({ status: 2, stdout: bracesReport() }), ...quiet }), 1)
})

test('fails closed for spawn errors, signals, and unexpected statuses', () => {
  assert.equal(runAudit({ spawn: () => { throw new Error('ENOENT') }, ...quiet }), 1)
  assert.equal(runAudit({ spawn: fakeResult({ stdout: report('clean.json'), error: new Error('ENOENT') }), ...quiet }), 1)
  assert.equal(runAudit({ spawn: fakeResult({ stdout: report('clean.json'), signal: 'SIGTERM' }), ...quiet }), 1)
  assert.equal(runAudit({ spawn: fakeResult({ status: 2, stdout: report('clean.json') }), ...quiet }), 1)
})

function picomatchReport(mutate = () => {}) {
  const parsed = JSON.parse(report('picomatch-excepted.json'))
  mutate(parsed, parsed.advisories['1247710'])
  return JSON.stringify(parsed)
}

test('accepts exactly the observed picomatch advisory and reports an exception, without claiming a patch', () => {
  const lines = []
  assert.equal(runAudit({ spawn: fakeResult({ status: 1, stdout: picomatchReport() }),
    log: line => lines.push(line), error: () => {} }), 0)
  assert.equal(lines[0], 'Dependency audit summary: 0 critical, 1 high, 2 moderate, 2 low.')
  assert.match(lines[1], /^Raw finding accepted as an exception \(still counted above\): high: picomatch@4\.0\.4 — GHSA-fc5q-39xc-vjpf$/)
  assert.ok(lines.every(line => !line.includes('verified patch') && !line.includes('unremediated')))
})

test('rejects every change to the picomatch identity, no-fix marker, version and reviewed registry paths', () => {
  for (const [name, mutate] of [
    ['different id', (r, a) => { a.github_advisory_id = 'GHSA-other-advisory' }],
    ['missing id', (r, a) => { delete a.github_advisory_id }],
    ['different URL', (r, a) => { a.url += '/other' }],
    ['different module', (r, a) => { a.module_name = 'other' }],
    ['critical', (r, a) => { a.severity = 'critical'; r.metadata.vulnerabilities.high = 0; r.metadata.vulnerabilities.critical = 1 }],
    ['moderate', (r, a) => { a.severity = 'moderate'; r.metadata.vulnerabilities.high = 0 }],
    ['changed range', (r, a) => { a.vulnerable_versions = '<=4.0.8' }],
    ['published fix', (r, a) => { a.patched_versions = '>=4.0.8' }],
    ['malformed marker', (r, a) => { a.patched_versions = '<0.0.0>' }],
    ['missing marker', (r, a) => { delete a.patched_versions }],
    ['other version', (r, a) => { a.findings[0].version = '4.0.7' }],
    ['new path', (r, a) => { a.findings[0].paths.push('apps__web>picomatch') }],
    ['removed path', (r, a) => { a.findings[0].paths = [] }],
    ['replaced path', (r, a) => { a.findings[0].paths = ['packages__core>picomatch'] }],
    ['duplicate path', (r, a) => { a.findings[0].paths.push(a.findings[0].paths[0]) }],
    ['versioned path', (r, a) => { a.findings[0].paths = ['apps/docs > vitepress@1.6.4 > vite@6.4.5 > picomatch@4.0.4'] }],
    ['missing paths', (r, a) => { delete a.findings[0].paths }],
    ['null path', (r, a) => { a.findings[0].paths = [null] }],
    ['missing findings', (r, a) => { delete a.findings }],
    ['empty findings', (r, a) => { a.findings = [] }],
    ['null finding', (r, a) => { a.findings = [null] }],
    ['string finding', (r, a) => { a.findings = ['4.0.4'] }],
    ['second finding', (r, a) => { a.findings.push({ version: '4.0.3', paths: a.findings[0].paths }); r.metadata.vulnerabilities.high = 2 }],
    ['duplicate finding', (r, a) => { a.findings.push(structuredClone(a.findings[0])); r.metadata.vulnerabilities.high = 2 }],
  ]) assert.equal(auditBraces(picomatchReport(mutate)), 1, name)
})

test('rejects a second picomatch advisory, even a duplicate or lower severity record', () => {
  for (const severity of ['high', 'critical', 'moderate', 'low']) {
    assert.equal(auditBraces(picomatchReport((r, a) => {
      r.advisories['2'] = { ...structuredClone(a), severity, github_advisory_id: 'GHSA-other-advisory' }
      r.metadata.vulnerabilities[severity]++
    })), 1, severity)
  }
  assert.equal(auditBraces(picomatchReport((r, a) => {
    r.advisories['2'] = structuredClone(a)
    r.metadata.vulnerabilities.high++
  })), 1)
})

test('reconciles high and critical counts before accepting picomatch', () => {
  for (const mutate of [
    r => { r.metadata.vulnerabilities.high = 2 },
    r => { r.metadata.vulnerabilities.critical = 1 },
    r => { r.advisories['2'] = JSON.parse(report('unknown-high.json')).advisories['1']; r.metadata.vulnerabilities.high++ },
    r => { r.advisories['2'] = { ...JSON.parse(report('unknown-critical.json')).advisories['1'], findings: [{ version: '1.0.0', paths: ['other'] }] }; r.metadata.vulnerabilities.critical = 2 },
  ]) assert.equal(auditBraces(picomatchReport(mutate)), 1)
})

test('accepts braces and picomatch together but still requires braces verification', () => {
  const combined = picomatchReport(r => {
    Object.assign(r.advisories, JSON.parse(bracesReport()).advisories)
    r.metadata.vulnerabilities.high = 2
  })
  const lines = []
  assert.equal(runAudit({ spawn: fakeResult({ status: 1, stdout: combined }),
    log: line => lines.push(line), error: () => {} }), 0)
  assert.ok(lines.some(line => line.includes('verified patch') && line.includes('GHSA-vfj7-8cjw-p6xm')))
  assert.ok(lines.some(line => line.includes('accepted as an exception') && line.includes('GHSA-fc5q-39xc-vjpf')))
  assert.equal(auditBraces(combined, unverifiedRoot), 1)
  assert.equal(auditBraces(picomatchReport(), unverifiedRoot), 1)
})
