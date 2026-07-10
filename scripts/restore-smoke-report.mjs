#!/usr/bin/env node
import fs from 'node:fs'

const REQUIRED_PHASES = [
  'sessionRead',
  'restoreSession',
  'ensureCollections',
  'hydrateLists',
  'listItems:calendar',
  'listItems:tasks',
  'listItems:contacts',
  'syncEngineTrackCollections',
  'syncEngineStart',
]

const VISIBLE_COLLECTION_TYPES = new Set(['calendar', 'tasks', 'contacts'])

function usage() {
  return [
    'Usage:',
    '  node scripts/restore-smoke-report.mjs <diagnostics-json-file|->',
    '  node scripts/restore-smoke-report.mjs --self-test',
    '',
    'Input must be the redacted JSON from sessionStorage key silentsuite.restore-diagnostics.v1.',
    'The report intentionally prints only phase/status/count metadata, never session blobs, item ids, or content.',
  ].join('\n')
}

function readInput(path) {
  if (!path || path === '--help' || path === '-h') {
    console.log(usage())
    process.exit(path ? 0 : 2)
  }
  if (path === '-') return fs.readFileSync(0, 'utf8')
  return fs.readFileSync(path, 'utf8')
}

function parseSnapshot(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`Input is not valid JSON: ${err.message}`)
  }
  if (parsed?.version !== 1) throw new Error('Unsupported or missing diagnostics version')
  if (!Array.isArray(parsed.entries)) throw new Error('Diagnostics entries must be an array')
  return parsed
}

function phaseEntries(snapshot, phase) {
  return snapshot.entries.filter((entry) => entry.phase === phase)
}

function phaseOk(snapshot, phase) {
  return phaseEntries(snapshot, phase).some((entry) => entry.status === 'ok')
}

function sumForPhase(snapshot, phase, field) {
  return phaseEntries(snapshot, phase).reduce((sum, entry) => sum + (Number.isFinite(entry[field]) ? entry[field] : 0), 0)
}

function assessSnapshot(snapshot) {
  const findings = []
  const missing = []
  const failed = []
  const nonOk = []

  for (const phase of REQUIRED_PHASES) {
    const entries = phaseEntries(snapshot, phase)
    if (entries.length === 0) {
      missing.push(phase)
      continue
    }
    if (entries.some((entry) => entry.status === 'failed')) failed.push(phase)
    if (entries.some((entry) => entry.status !== 'ok')) nonOk.push(phase)
  }

  if (snapshot.source !== 'restore') findings.push(`source is ${String(snapshot.source ?? 'unknown')}, expected restore`)
  if (snapshot.failedPhase !== null) findings.push(`failedPhase is ${String(snapshot.failedPhase)}`)
  if (missing.length > 0) findings.push(`missing phases: ${missing.join(', ')}`)
  if (failed.length > 0) findings.push(`failed phases: ${failed.join(', ')}`)
  if (nonOk.length > 0) findings.push(`non-ok phases: ${[...new Set(nonOk)].join(', ')}`)

  for (const type of VISIBLE_COLLECTION_TYPES) {
    const phase = `listItems:${type}`
    const collectionCount = sumForPhase(snapshot, phase, 'collectionCount')
    if (phaseOk(snapshot, phase) && collectionCount < 1) {
      findings.push(`${phase} reported no collections`)
    }
  }

  const pass = findings.length === 0
  return { pass, findings }
}

function safeHost(host) {
  return typeof host === 'string' && host.length > 0 ? host : 'unknown'
}

function report(snapshot) {
  const { pass, findings } = assessSnapshot(snapshot)
  const lines = []
  lines.push(`Authenticated restore smoke: ${pass ? 'PASS' : 'FAIL'}`)
  lines.push(`source: ${snapshot.source ?? 'unknown'}`)
  lines.push(`etebaseHost: ${safeHost(snapshot.etebaseHost)}`)
  lines.push(`billingHost: ${safeHost(snapshot.billingHost)}`)
  lines.push(`failedPhase: ${snapshot.failedPhase === null ? 'null' : String(snapshot.failedPhase)}`)
  lines.push('phases:')
  for (const phase of REQUIRED_PHASES) {
    const entries = phaseEntries(snapshot, phase)
    if (entries.length === 0) {
      lines.push(`  - ${phase}: missing`)
      continue
    }
    const status = entries.map((entry) => entry.status).join('/')
    const countBits = []
    const collectionCount = sumForPhase(snapshot, phase, 'collectionCount')
    const itemCount = sumForPhase(snapshot, phase, 'itemCount')
    const pageCount = sumForPhase(snapshot, phase, 'pageCount')
    if (collectionCount) countBits.push(`collections=${collectionCount}`)
    if (itemCount) countBits.push(`items=${itemCount}`)
    if (pageCount) countBits.push(`pages=${pageCount}`)
    lines.push(`  - ${phase}: ${status}${countBits.length ? ` (${countBits.join(', ')})` : ''}`)
  }
  if (findings.length > 0) {
    lines.push('findings:')
    for (const finding of findings) lines.push(`  - ${finding}`)
  }
  return lines.join('\n')
}

function makePassingFixture() {
  return {
    version: 1,
    source: 'restore',
    generatedAtMs: 1,
    etebaseHost: 'server.silentsuite.io',
    billingHost: 'api.silentsuite.io',
    failedPhase: null,
    entries: [
      { phase: 'sessionRead', status: 'ok', session: { present: true, parseableJson: true, shape: 'json' } },
      { phase: 'restoreSession', status: 'ok', durationMs: 12 },
      { phase: 'ensureCollections', status: 'ok', collectionCount: 3 },
      { phase: 'hydrateLists', status: 'ok' },
      { phase: 'listItems:calendar', status: 'ok', collectionType: 'calendar', collectionCount: 1, itemCount: 2, pageCount: 1 },
      { phase: 'listItems:tasks', status: 'ok', collectionType: 'tasks', collectionCount: 1, itemCount: 0, pageCount: 1 },
      { phase: 'listItems:contacts', status: 'ok', collectionType: 'contacts', collectionCount: 1, itemCount: 0, pageCount: 1 },
      { phase: 'syncEngineTrackCollections', status: 'ok' },
      { phase: 'syncEngineStart', status: 'ok' },
    ],
  }
}

function runSelfTest() {
  const passReport = report(makePassingFixture())
  if (!passReport.startsWith('Authenticated restore smoke: PASS')) {
    throw new Error('expected passing fixture to pass')
  }

  const bogusFixture = makePassingFixture()
  bogusFixture.entries = bogusFixture.entries.map((entry) => (
    entry.phase === 'hydrateLists'
      ? { ...entry, status: 'bogus', collectionUid: 'collection-secret', itemUid: 'item-secret', content: 'plaintext-pim-secret' }
      : entry
  ))
  const bogusReport = report(bogusFixture)
  if (!bogusReport.startsWith('Authenticated restore smoke: FAIL')) {
    throw new Error('expected non-ok status fixture to fail')
  }
  for (const forbidden of ['collection-secret', 'item-secret', 'plaintext-pim-secret']) {
    if (bogusReport.includes(forbidden)) {
      throw new Error(`self-test report leaked forbidden field: ${forbidden}`)
    }
  }

  const failFixture = makePassingFixture()
  failFixture.failedPhase = 'listItems:calendar'
  failFixture.entries = failFixture.entries.map((entry) => (
    entry.phase === 'listItems:calendar' ? { phase: 'listItems:calendar', status: 'failed', errorName: 'Error' } : entry
  ))
  const failReport = report(failFixture)
  if (!failReport.startsWith('Authenticated restore smoke: FAIL')) {
    throw new Error('expected failing fixture to fail')
  }
  if (failReport.includes('session-secret') || failReport.includes('item-uid')) {
    throw new Error('self-test report leaked forbidden fixture data')
  }

  const loginFixture = makePassingFixture()
  loginFixture.source = 'login'
  const loginReport = report(loginFixture)
  if (!loginReport.startsWith('Authenticated restore smoke: FAIL') || !loginReport.includes('source is login, expected restore')) {
    throw new Error('expected login-source fixture to fail restore smoke')
  }
  console.log('restore-smoke-report self-test: PASS')
}

function main() {
  const arg = process.argv[2]
  if (arg === '--self-test') {
    runSelfTest()
    return
  }
  const snapshot = parseSnapshot(readInput(arg))
  const text = report(snapshot)
  console.log(text)
  process.exitCode = text.startsWith('Authenticated restore smoke: PASS') ? 0 : 1
}

try {
  main()
} catch (err) {
  console.error(`restore-smoke-report: ${err.message}`)
  process.exit(2)
}
