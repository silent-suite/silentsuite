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

test('fails closed for spawn errors, signals, and unexpected statuses', () => {
  assert.equal(runAudit({ spawn: () => { throw new Error('ENOENT') }, ...quiet }), 1)
  assert.equal(runAudit({ spawn: fakeResult({ stdout: report('clean.json'), error: new Error('ENOENT') }), ...quiet }), 1)
  assert.equal(runAudit({ spawn: fakeResult({ stdout: report('clean.json'), signal: 'SIGTERM' }), ...quiet }), 1)
  assert.equal(runAudit({ spawn: fakeResult({ status: 2, stdout: report('clean.json') }), ...quiet }), 1)
})
