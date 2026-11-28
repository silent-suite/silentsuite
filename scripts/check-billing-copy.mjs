#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, extname, relative, resolve, sep } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// This is deliberately an inventory rather than an allowlist of the current UI.
// New billing code often lands first in a helper, root config, static asset, Android
// entry point, authoring document, workflow, or script. Tests and fixtures are only
// exempt when the production import graph proves they are unreachable.
const inventoryRoots = [
  'apps/web',
  'apps/docs',
  'docs',
  'android',
  'README.md',
  'runbooks',
  'scripts',
  '.github/scripts',
  '.github/workflows',
  'package.json',
  'Dockerfile.web',
]

const disclosureFiles = [
  'README.md',
  'apps/docs/user-guide/getting-started.md',
  'apps/docs/user-guide/faq.md',
]
const androidStrings = 'android/app/src/main/res/values/strings.xml'
const androidManager = 'android/app/src/main/java/io/silentsuite/sync/billing/BillingManager.kt'
const textExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.md', '.mdx', '.kt', '.kts', '.java', '.xml', '.yml', '.yaml', '.json', '.css', '.svg', '.html', '.txt', '.sh', '.py', '.rb', '.gradle', '.properties', '.pro'])

const prohibitedHostedCopy = /monthly and annual plans|pick monthly or annual|paid plans \(monthly or annual\)|change your payment info, plan|settings\/billing/i
const requiredHostedDisclosure = [
  /annual only/i,
  /€36/,
  /€48/,
  /7-day/i,
  /30-day/i,
  /cancel/i,
  /refund/i,
  /self.host/i,
  /free/i,
  /every feature/i,
]

const billingRules = [
  ['monthly-or-supporter-pricing', /\b(?:early_monthly|standard_monthly|selfhost_supporter)\b|€\s*4\s*(?:\/|per\s+)month\b(?![^.\n]{0,90}\bbilled annually\b)|\bsupporter\b[^\n]{0,80}\b(?:checkout|subscription|pricing|€\s*4)\b/i],
  ['billing-interval-toggle', /\b(?:setSelectedInterval|onIntervalChange|intervalToggle)\b|\bbillingInterval\s*=\s*["']monthly["']|\b(?:payment|billing|subscription|checkout)[^\n]{0,100}\binterval\s*=\s*monthly\b/i],
  ['promotion-input', /\b(?:promotionCode|promoCode|promotionInput|promoInput|promotionField|promoField)\b/i],
  ['legacy-v1-creation', /\/(?:auth\/provision|auth\/signup\/payment-session|subscription\/setup-card|subscription\/reactivate|subscription\/change-plan)(?!\/v2)\b|\/subscription\/payment-flows(?:["'`?#]|$)(?!\/v2)/i],
  ['client-derived-commerce', /(?:JSON\.stringify\s*\(\s*\{|body\s*:\s*\{)[\s\S]{0,400}\b(?:planId|annualAmountMinor|monthlyEquivalentMinor|customerClass|billingInterval|promotionCode|promoCode)\b(?=\s*(?::|,|\}))/i],
]

function isIgnoredPath(file) {
  return /(?:^|\/)(?:coverage|node_modules|dist|build|\.next|\.turbo)(?:\/|$)/i.test(file)
}

function isTestModule(file) {
  return /(?:^|\/)(?:__tests__|__mocks__)(?:\/|$)|(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/i.test(file)
}

function isFixtureModule(file) {
  return /(?:^|\/)(?:fixtures?|test-fixtures)(?:\/|$)/i.test(file)
}

function isInventoryFile(file) {
  if (isIgnoredPath(file)) return false
  return inventoryRoots.some(entry => file === entry || file.startsWith(`${entry}/`))
    && (file === 'README.md' || file === 'Dockerfile.web' || textExtensions.has(extname(file)))
}

function walkInventory(relativeDirectory, files) {
  const absoluteDirectory = resolve(root, relativeDirectory)
  if (!existsSync(absoluteDirectory)) return
  for (const entry of readdirSync(absoluteDirectory)) {
    const child = `${relativeDirectory}/${entry}`
    if (isIgnoredPath(child)) continue
    const absoluteChild = resolve(root, child)
    if (statSync(absoluteChild).isDirectory()) walkInventory(child, files)
    else if (isInventoryFile(child)) files.add(child)
  }
}

function inventoryFiles(overrides) {
  const files = new Set()
  for (const entry of inventoryRoots) {
    const absolute = resolve(root, entry)
    if (!existsSync(absolute)) continue
    if (statSync(absolute).isDirectory()) walkInventory(entry, files)
    else if (isInventoryFile(entry)) files.add(entry)
  }
  for (const file of Object.keys(overrides)) {
    if (isInventoryFile(file) || (!isIgnoredPath(file) && textExtensions.has(extname(file)))) files.add(file)
  }
  return [...files].sort()
}

function fileContent(file, overrides) {
  return overrides[file] ?? readFileSync(resolve(root, file), 'utf8')
}

function isProductionSource(file) {
  return !isTestModule(file) && !isFixtureModule(file)
}

function isFile(file, overrides) {
  return Object.hasOwn(overrides, file) || existsSync(resolve(root, file))
}

function importSpecifiers(source) {
  const imports = new Set()
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) imports.add(match[1])
  }
  return [...imports]
}

function candidateModules(base) {
  const candidates = [base]
  if (!textExtensions.has(extname(base))) {
    for (const extension of textExtensions) candidates.push(`${base}${extension}`)
    for (const extension of textExtensions) candidates.push(`${base}/index${extension}`)
  }
  return candidates
}

function safeRelative(absolute) {
  const path = relative(root, absolute).split(sep).join('/')
  return path && !path.startsWith('../') && path !== '..' ? path : undefined
}

function workspacePackageRoot(specifier) {
  const packageName = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0]
  const packageDirectory = resolve(root, 'packages')
  if (!existsSync(packageDirectory)) return undefined
  for (const entry of readdirSync(packageDirectory)) {
    const manifest = resolve(packageDirectory, entry, 'package.json')
    if (!existsSync(manifest)) continue
    try {
      if (JSON.parse(readFileSync(manifest, 'utf8')).name === packageName) {
        return { directory: `packages/${entry}`, subpath: specifier.slice(packageName.length).replace(/^\//, '') }
      }
    } catch {
      // An unreadable package manifest cannot establish a trusted production edge.
    }
  }
  return undefined
}

function resolveImport(importer, specifier, overrides) {
  let bases = []
  if (specifier.startsWith('.')) {
    bases = [resolve(root, dirname(importer), specifier)]
  } else if (specifier.startsWith('@/')) {
    bases = [resolve(root, 'apps/web', specifier.slice(2))]
  } else {
    const workspacePackage = workspacePackageRoot(specifier)
    if (!workspacePackage) return undefined
    bases = workspacePackage.subpath
      ? [resolve(root, workspacePackage.directory, 'src', workspacePackage.subpath), resolve(root, workspacePackage.directory, workspacePackage.subpath)]
      : [resolve(root, workspacePackage.directory, 'src/index'), resolve(root, workspacePackage.directory, 'index')]
  }
  for (const base of bases) {
    for (const candidate of candidateModules(base)) {
      const file = safeRelative(candidate)
      if (file && !isIgnoredPath(file) && isFile(file, overrides)) return file
    }
  }
  return undefined
}

function containsProhibitedCommerce(source) {
  return billingRules.some(([, pattern]) => pattern.test(source)) || prohibitedHostedCopy.test(source)
}

function productionImportViolations(productionFiles, overrides) {
  const violations = []
  const seenEdges = new Set()
  const visited = new Set()
  const visit = file => {
    if (visited.has(file)) return
    visited.add(file)
    let source
    try {
      source = fileContent(file, overrides)
    } catch {
      violations.push({ file, rule: 'production-import-unreadable-module' })
      return
    }
    for (const specifier of importSpecifiers(source)) {
      const target = resolveImport(file, specifier, overrides)
      if (!target) continue
      const edge = `${file}->${target}`
      if (seenEdges.has(edge)) continue
      seenEdges.add(edge)
      if (isTestModule(target)) {
        violations.push({ file: target, rule: 'production-imports-excluded-test-module' })
        continue
      }
      if (isFixtureModule(target)) {
        if (containsProhibitedCommerce(fileContent(target, overrides))) {
          violations.push({ file: target, rule: 'production-imports-prohibited-fixture' })
        }
        continue
      }
      visit(target)
    }
  }
  for (const file of productionFiles) visit(file)
  return violations
}

export function collectBillingCopyViolations(overrides = {}) {
  const violations = []
  const files = inventoryFiles(overrides)
  const productionFiles = files.filter(isProductionSource)
  const contentFor = file => fileContent(file, overrides)

  for (const file of disclosureFiles) {
    const content = contentFor(file)
    if (prohibitedHostedCopy.test(content)) violations.push({ file, rule: 'prohibited-hosted-copy' })
    if (!requiredHostedDisclosure.every(rule => rule.test(content))) {
      violations.push({ file, rule: 'missing-complete-hosted-disclosure' })
    }
  }

  const strings = contentFor(androidStrings)
  const manager = contentFor(androidManager)
  if (!strings.includes('payment and account settings') || !manager.includes('https://app.silentsuite.io/settings/subscription')) {
    violations.push({ file: 'android', rule: 'subscription-management-route' })
  }

  for (const file of productionFiles) {
    // The guard necessarily contains the prohibited literals it searches for.
    if (file === 'scripts/check-billing-copy.mjs') continue
    const content = contentFor(file)
    for (const [rule, pattern] of billingRules) {
      if (pattern.test(content)) violations.push({ file, rule })
    }
  }
  violations.push(...productionImportViolations(productionFiles, overrides))
  return violations
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = collectBillingCopyViolations()
  if (violations.length) {
    for (const violation of violations) console.error(`${violation.file}: ${violation.rule}`)
    process.exitCode = 1
  }
}
