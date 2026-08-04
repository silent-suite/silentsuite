#!/usr/bin/env node
import { spawnSync } from 'node:child_process'

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasAdvisoryIdentity(advisory) {
  const id = advisory.id
  if ((typeof id === 'string' && id.trim() !== '') || (Number.isInteger(id) && id > 0)) return true

  return typeof advisory.url === 'string' && /GHSA-[a-z0-9-]+/i.test(advisory.url)
}

function validateReport(report) {
  if (!isObject(report) || Object.hasOwn(report, 'error')) return 'Audit returned an error response.'
  if (!isObject(report.advisories)) return 'Audit report is missing advisory metadata.'
  if (!isObject(report.metadata) || !isObject(report.metadata.vulnerabilities)) {
    return 'Audit report is missing vulnerability metadata.'
  }

  for (const severity of ['critical', 'high', 'moderate', 'low']) {
    if (!Number.isInteger(report.metadata.vulnerabilities[severity]) || report.metadata.vulnerabilities[severity] < 0) {
      return `Audit report has invalid ${severity} vulnerability metadata.`
    }
  }

  const advisories = Object.values(report.advisories)
  for (const advisory of advisories) {
    if (!isObject(advisory)
      || !['critical', 'high', 'moderate', 'low'].includes(advisory.severity)
      || typeof advisory.module_name !== 'string' || advisory.module_name.trim() === ''
      || typeof advisory.title !== 'string' || advisory.title.trim() === ''
      || !hasAdvisoryIdentity(advisory)) {
      return 'Audit report has malformed advisory metadata.'
    }
  }

  for (const severity of ['critical', 'high']) {
    const hasAdvisory = advisories.some((advisory) => advisory.severity === severity)
    const metadataHasVulnerability = report.metadata.vulnerabilities[severity] > 0
    if (hasAdvisory !== metadataHasVulnerability) {
      return `Audit report has contradictory ${severity} vulnerability metadata.`
    }
  }

  return undefined
}

export function runAudit({ spawn = spawnSync, log = console.log, error = console.error } = {}) {
  let result
  try {
    result = spawn('pnpm', ['audit', '--audit-level=high', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (cause) {
    error(`Could not start pnpm audit: ${cause.message}`)
    return 1
  }

  if (!result || result.error || result.signal || ![0, 1].includes(result.status)) {
    error('pnpm audit did not complete with an expected exit status.')
    if (result?.stderr) error(result.stderr)
    return 1
  }

  let report
  try {
    if (typeof result.stdout !== 'string' || result.stdout.trim() === '') throw new Error('empty output')
    report = JSON.parse(result.stdout)
  } catch {
    error('Could not parse pnpm audit JSON output.')
    if (result.stderr) error(result.stderr)
    return 1
  }

  const validationError = validateReport(report)
  if (validationError) {
    error(validationError)
    return 1
  }

  const advisories = Object.values(report.advisories)
  const highCritical = advisories.filter((advisory) => ['high', 'critical'].includes(advisory.severity))
  const counts = report.metadata.vulnerabilities

  log(`Dependency audit summary: ${counts.critical} critical, ${counts.high} high, ${counts.moderate} moderate, ${counts.low} low.`)

  if (highCritical.length > 0) {
    error('')
    error('High or critical dependency advisories found:')
    for (const advisory of highCritical) error(`- ${advisory.severity}: ${advisory.module_name} — ${advisory.title}`)
    return 1
  }

  log('No high or critical advisories found.')
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = runAudit()
