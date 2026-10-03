#!/usr/bin/env node
import { spawnSync } from 'node:child_process'

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Owner-approved temporary exception for one leaf advisory with no patched release. It covers
// only braces 3.0.3 reached through the reviewed build/lint tooling paths and fails closed at
// expiry. Evidence and expiry remediation: docs/security/braces-ghsa-vfj7-8cjw-p6xm-exception.md
export const bracesException = Object.freeze({
  githubAdvisoryId: 'GHSA-vfj7-8cjw-p6xm',
  moduleName: 'braces',
  severity: 'high',
  vulnerableVersions: '<=3.0.3',
  version: '3.0.3',
  expiresAt: '2026-10-10T00:00:00Z',
  paths: new Set([
    'apps/web > @ducanh2912/next-pwa@10.2.9 > fast-glob@3.3.2 > micromatch@4.0.8 > braces@3.0.3',
    'apps/web > eslint-config-next@15.5.24 > @next/eslint-plugin-next@15.5.24 > fast-glob@3.3.1 > micromatch@4.0.8 > braces@3.0.3',
    'apps/web > tailwindcss@3.4.19 > chokidar@3.6.0 > braces@3.0.3',
    'apps/web > tailwindcss@3.4.19 > fast-glob@3.3.3 > micromatch@4.0.8 > braces@3.0.3',
    'apps/web > tailwindcss@3.4.19 > micromatch@4.0.8 > braces@3.0.3',
    'apps/web > tailwindcss-animate@1.0.7 > tailwindcss@3.4.19 > chokidar@3.6.0 > braces@3.0.3',
    'apps/web > tailwindcss-animate@1.0.7 > tailwindcss@3.4.19 > fast-glob@3.3.3 > micromatch@4.0.8 > braces@3.0.3',
    'apps/web > tailwindcss-animate@1.0.7 > tailwindcss@3.4.19 > micromatch@4.0.8 > braces@3.0.3',
  ]),
})

function isExcepted(advisory, now) {
  const exception = bracesException
  return Number.isFinite(now) && now < Date.parse(exception.expiresAt)
    && advisory.github_advisory_id === exception.githubAdvisoryId
    && advisory.url === `https://github.com/advisories/${exception.githubAdvisoryId}`
    && advisory.module_name === exception.moduleName
    && advisory.severity === exception.severity
    && advisory.vulnerable_versions === exception.vulnerableVersions
    && Array.isArray(advisory.findings) && advisory.findings.length === 1
    && isObject(advisory.findings[0])
    && advisory.findings[0].version === exception.version
    && Array.isArray(advisory.findings[0].paths)
    && advisory.findings[0].paths.length === exception.paths.size
    && new Set(advisory.findings[0].paths).size === exception.paths.size
    && advisory.findings[0].paths.every((path) => exception.paths.has(path))
}

// pnpm 10.6.5 posts the lockfile tree to the registry's /-/npm/v1/security/audits endpoint and
// returns its report unchanged; that report counts one vulnerability per (advisory, installed
// version) finding. Policy severities must reconcile exactly before anything is excepted.
function findingCount(advisory) {
  if (!Array.isArray(advisory.findings) || advisory.findings.length === 0) return undefined
  const versions = new Set()
  for (const finding of advisory.findings) {
    if (!isObject(finding) || typeof finding.version !== 'string' || finding.version.trim() === ''
      || versions.has(finding.version)
      || !Array.isArray(finding.paths) || finding.paths.length === 0
      || !finding.paths.every((path) => typeof path === 'string' && path.trim() !== '')) return undefined
    versions.add(finding.version)
  }
  return versions.size
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

  // Reconciliation is only required once an exception could suppress a policy-severity record.
  if (advisories.some((advisory) => advisory.github_advisory_id === bracesException.githubAdvisoryId)) {
    for (const severity of ['critical', 'high']) {
      let findings = 0
      for (const advisory of advisories.filter((candidate) => candidate.severity === severity)) {
        const count = findingCount(advisory)
        if (count === undefined) return `Audit report has malformed ${severity} advisory findings.`
        findings += count
      }
      if (findings !== report.metadata.vulnerabilities[severity]) {
        return `Audit report ${severity} vulnerability count does not match its advisory findings.`
      }
    }
  }

  return undefined
}

export function runAudit({ spawn = spawnSync, log = console.log, error = console.error, now = Date.now } = {}) {
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
  const currentTime = now()
  const highCritical = advisories.filter((advisory) => ['high', 'critical'].includes(advisory.severity)
    && !isExcepted(advisory, currentTime))
  const excepted = advisories.filter((advisory) => isExcepted(advisory, currentTime))
  const counts = report.metadata.vulnerabilities

  log(`Dependency audit summary: ${counts.critical} critical, ${counts.high} high, ${counts.moderate} moderate, ${counts.low} low.`)
  for (const advisory of excepted) {
    log(`Temporary exception until ${bracesException.expiresAt}: ${advisory.severity}: ${advisory.module_name}@${bracesException.version} — ${advisory.github_advisory_id}`)
  }

  if (highCritical.length > 0) {
    error('')
    error('High or critical dependency advisories found:')
    for (const advisory of highCritical) error(`- ${advisory.severity}: ${advisory.module_name} — ${advisory.title}`)
    return 1
  }

  log(excepted.length > 0 ? 'No unexcepted high or critical advisories found.' : 'No high or critical advisories found.')
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = runAudit()
