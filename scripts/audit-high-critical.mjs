#!/usr/bin/env node
import { spawnSync } from 'node:child_process'

const ALLOWLIST = [
  {
    advisory: 'GHSA-r5fr-rjxr-66jc',
    module: 'lodash',
    severity: 'high',
    expires: '2026-07-14',
    rationale: 'Transitive via @ducanh2912/next-pwa -> workbox-build. pnpm audit reports patched >=4.18.0, but npm lodash currently has no 4.18.x release to resolve to. Keep visible and fail once expired or if any new high/critical appears.',
  },
  {
    advisory: 'GHSA-gv7w-rqvm-qjhr',
    module: 'esbuild',
    severity: 'high',
    expires: '2026-07-14',
    rationale: 'Transitive build-tool exposure from Vite/Webpack paths. The patched esbuild 0.28.x line currently breaks VitePress production builds in this workspace, so keep this visible while upstream-compatible patches are evaluated. No runtime browser/server dependency on esbuild is introduced by this allowlist.',
  },
]

function advisoryId(advisory) {
  const url = String(advisory.url ?? '')
  return url.match(/GHSA-[a-z0-9-]+/i)?.[0] ?? String(advisory.id ?? advisory.title ?? 'unknown')
}

function isExpired(entry) {
  return Date.now() > Date.parse(`${entry.expires}T23:59:59Z`)
}

function isAllowed(advisory) {
  const id = advisoryId(advisory)
  return ALLOWLIST.some((entry) => {
    return !isExpired(entry)
      && entry.advisory === id
      && entry.module === advisory.module_name
      && entry.severity === advisory.severity
  })
}

const result = spawnSync('pnpm', ['audit', '--audit-level=high', '--json'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
})

let report
try {
  report = JSON.parse(result.stdout)
} catch (err) {
  console.error('Could not parse pnpm audit JSON output.')
  if (result.stderr) console.error(result.stderr)
  process.exit(1)
}

const advisories = Object.values(report.advisories ?? {})
const highCritical = advisories.filter((advisory) => ['high', 'critical'].includes(advisory.severity))
const unallowed = highCritical.filter((advisory) => !isAllowed(advisory))
const allowed = highCritical.filter((advisory) => isAllowed(advisory))
const counts = report.metadata?.vulnerabilities ?? {}

console.log(`Dependency audit summary: ${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ${counts.moderate ?? 0} moderate, ${counts.low ?? 0} low.`)

if (allowed.length > 0) {
  console.log('')
  console.log('Temporarily allowlisted high/critical advisories:')
  for (const advisory of allowed) {
    const id = advisoryId(advisory)
    const entry = ALLOWLIST.find((item) => item.advisory === id && item.module === advisory.module_name)
    console.log(`- ${advisory.severity}: ${advisory.module_name} ${id}; expires ${entry?.expires}; ${entry?.rationale}`)
  }
}

if (unallowed.length > 0) {
  console.error('')
  console.error('Unallowlisted high/critical dependency advisories found:')
  for (const advisory of unallowed) {
    console.error(`- ${advisory.severity}: ${advisory.module_name} ${advisoryId(advisory)} — ${advisory.title}`)
  }
  process.exit(1)
}

if (highCritical.length === 0) {
  console.log('No high or critical advisories found.')
} else {
  console.log('No unallowlisted high or critical advisories found.')
}
