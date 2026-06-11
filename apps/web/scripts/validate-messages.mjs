#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const messagesDir = path.resolve(scriptDir, '..', 'messages')
const sourceLocale = 'en'
const sourceFile = `${sourceLocale}.json`
const placeholderPattern = /\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:,[^}]*)?\}/g

function usage() {
  console.log(`Usage: node scripts/validate-messages.mjs [--check|--report]

Checks web app message catalogs in apps/web/messages.

--check   Validate locale files and exit non-zero on problems (default)
--report  Print completeness details; exits non-zero only for malformed catalogs`)
}

function parseArgs(argv) {
  const args = new Set(argv)
  if (args.has('--help') || args.has('-h')) {
    usage()
    process.exit(0)
  }

  const allowed = new Set(['--check', '--report'])
  for (const arg of args) {
    if (!allowed.has(arg)) {
      console.error(`Unknown argument: ${arg}`)
      usage()
      process.exit(2)
    }
  }

  return {
    report: args.has('--report'),
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    return { __parseError: error }
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function flattenMessages(value, prefix = '', result = {}, shapeErrors = []) {
  if (typeof value === 'string') {
    result[prefix] = value
    return { result, shapeErrors }
  }

  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (key.includes('.')) {
        const location = prefix ? `${prefix}.${key}` : key
        shapeErrors.push(`${location} must use nested JSON objects instead of dots in key names`)
      }
      const nextPrefix = prefix ? `${prefix}.${key}` : key
      flattenMessages(child, nextPrefix, result, shapeErrors)
    }
    return { result, shapeErrors }
  }

  const location = prefix || '<root>'
  shapeErrors.push(`${location} must be a string or nested object, got ${Array.isArray(value) ? 'array' : typeof value}`)
  return { result, shapeErrors }
}

function extractPlaceholders(message) {
  const placeholders = new Set()
  for (const match of message.matchAll(placeholderPattern)) {
    placeholders.add(match[1])
  }
  return [...placeholders].sort()
}

function isValidLocaleCode(locale) {
  try {
    // Intl.Locale accepts BCP 47-style tags such as en, de, pt-BR, and zh-Hans.
    // Keep this intentionally light so maintainers can still decide which valid locales to enable.
    new Intl.Locale(locale)
    return true
  } catch {
    return false
  }
}

function difference(left, right) {
  const rightSet = new Set(right)
  return left.filter((item) => !rightSet.has(item))
}

function percent(part, whole) {
  if (whole === 0) return '100.0%'
  return `${((part / whole) * 100).toFixed(1)}%`
}

function formatList(items, indent = '    ') {
  return items.map((item) => `${indent}- ${item}`).join('\n')
}

function main() {
  const options = parseArgs(process.argv.slice(2))

  if (!fs.existsSync(messagesDir)) {
    console.error(`Messages directory not found: ${messagesDir}`)
    process.exit(1)
  }

  const files = fs.readdirSync(messagesDir).filter((file) => file.endsWith('.json')).sort()

  if (!files.includes(sourceFile)) {
    console.error(`Source locale file is missing: ${path.join(messagesDir, sourceFile)}`)
    process.exit(1)
  }

  const catalogs = new Map()
  const parseErrors = []

  for (const file of files) {
    const filePath = path.join(messagesDir, file)
    const parsed = readJson(filePath)
    if (parsed && parsed.__parseError) {
      parseErrors.push(`${file}: ${parsed.__parseError.message}`)
      continue
    }
    catalogs.set(file, parsed)
  }

  const sourceCatalog = catalogs.get(sourceFile)
  const sourceFlattened = sourceCatalog ? flattenMessages(sourceCatalog) : { result: {}, shapeErrors: [] }
  const sourceMessages = sourceFlattened.result
  const sourceKeys = Object.keys(sourceMessages).sort()
  const sourcePlaceholderMap = new Map(
    sourceKeys.map((key) => [key, extractPlaceholders(sourceMessages[key])]),
  )

  const localeReports = []
  let hasValidationErrors = parseErrors.length > 0 || sourceFlattened.shapeErrors.length > 0
  let hasFatalErrors = parseErrors.length > 0 || sourceFlattened.shapeErrors.length > 0

  for (const file of files) {
    if (!catalogs.has(file)) continue

    const locale = path.basename(file, '.json')
    const flattened = flattenMessages(catalogs.get(file))
    const messages = flattened.result
    const keys = Object.keys(messages).sort()
    const localeCodeErrors = isValidLocaleCode(locale) ? [] : [`invalid locale code: ${locale}`]
    const missing = difference(sourceKeys, keys)
    const extra = difference(keys, sourceKeys)
    const placeholderMismatches = []

    for (const key of keys) {
      if (!sourcePlaceholderMap.has(key)) continue
      const expected = sourcePlaceholderMap.get(key)
      const actual = extractPlaceholders(messages[key])
      const missingPlaceholders = difference(expected, actual)
      const extraPlaceholders = difference(actual, expected)
      if (missingPlaceholders.length > 0 || extraPlaceholders.length > 0) {
        placeholderMismatches.push({ key, missing: missingPlaceholders, extra: extraPlaceholders })
      }
    }

    const errors = [
      ...localeCodeErrors,
      ...flattened.shapeErrors,
      ...missing.map((key) => `missing key: ${key}`),
      ...extra.map((key) => `extra key: ${key}`),
      ...placeholderMismatches.map((item) => {
        const parts = []
        if (item.missing.length > 0) parts.push(`missing placeholders: ${item.missing.join(', ')}`)
        if (item.extra.length > 0) parts.push(`extra placeholders: ${item.extra.join(', ')}`)
        return `placeholder mismatch at ${item.key}: ${parts.join('; ')}`
      }),
    ]

    if (errors.length > 0) hasValidationErrors = true
    if (flattened.shapeErrors.length > 0) hasFatalErrors = true

    localeReports.push({
      locale,
      file,
      keys: keys.length,
      expectedKeys: sourceKeys.length,
      completeness: percent(sourceKeys.length - missing.length, sourceKeys.length),
      localeCodeErrors,
      missing,
      extra,
      shapeErrors: flattened.shapeErrors,
      placeholderMismatches,
      errors,
    })
  }

  console.log('Web translation message validation')
  console.log('')
  console.log(`Messages directory: ${path.relative(process.cwd(), messagesDir) || '.'}`)
  console.log(`Source locale: ${sourceLocale}`)
  console.log(`Reference keys: ${sourceKeys.length}`)
  console.log('')

  if (parseErrors.length > 0) {
    console.log('Parse errors:')
    console.log(formatList(parseErrors))
    console.log('')
  }

  if (sourceFlattened.shapeErrors.length > 0) {
    console.log(`${sourceFile} shape errors:`)
    console.log(formatList(sourceFlattened.shapeErrors))
    console.log('')
  }

  const localeColumnWidth = Math.max('Locale'.length, ...localeReports.map((report) => report.locale.length))
  console.log(`${'Locale'.padEnd(localeColumnWidth)}  Complete  Keys`)
  console.log(`${'-'.repeat(localeColumnWidth)}  --------  ----`)
  for (const report of localeReports) {
    console.log(
      `${report.locale.padEnd(localeColumnWidth)}  ${report.completeness.padStart(8)}  ${String(report.keys).padStart(4)}/${report.expectedKeys}`,
    )
  }
  console.log('')

  for (const report of localeReports) {
    if (!options.report && report.errors.length === 0) continue

    console.log(`${report.file}`)
    console.log(`  completeness: ${report.completeness} (${report.keys}/${report.expectedKeys} keys)`)

    if (report.localeCodeErrors.length > 0) {
      console.log('  locale code errors:')
      console.log(formatList(report.localeCodeErrors, '    '))
    }

    if (report.shapeErrors.length > 0) {
      console.log('  shape errors:')
      console.log(formatList(report.shapeErrors, '    '))
    }

    if (report.missing.length > 0) {
      console.log('  missing keys:')
      console.log(formatList(report.missing, '    '))
    }

    if (report.extra.length > 0) {
      console.log('  extra keys:')
      console.log(formatList(report.extra, '    '))
    }

    if (report.placeholderMismatches.length > 0) {
      console.log('  placeholder mismatches:')
      for (const mismatch of report.placeholderMismatches) {
        console.log(`    - ${mismatch.key}`)
        if (mismatch.missing.length > 0) console.log(`      missing: ${mismatch.missing.join(', ')}`)
        if (mismatch.extra.length > 0) console.log(`      extra: ${mismatch.extra.join(', ')}`)
      }
    }

    if (report.errors.length === 0) {
      console.log('  status: ok')
    }
    console.log('')
  }

  const shouldFail = options.report ? hasFatalErrors : hasValidationErrors

  if (shouldFail) {
    console.error(options.report ? 'i18n report found malformed catalogs.' : 'i18n validation failed.')
    process.exit(1)
  }

  if (options.report && hasValidationErrors) {
    console.log('i18n report complete; run pnpm i18n:check for strict validation status.')
    return
  }

  console.log(options.report ? 'i18n report complete.' : 'i18n validation passed.')
}

main()
