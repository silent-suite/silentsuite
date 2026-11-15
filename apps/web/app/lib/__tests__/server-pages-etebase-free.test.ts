// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * The Next server evaluates app page modules at start-up and on request. If one
 * of them reaches the Etebase SDK, two process-wide side effects follow: Etebase
 * sets a placeholder global `document`, and the libsodium it loads calls
 * process.removeAllListeners('uncaughtException') and ('unhandledRejection'),
 * which drops Next's own handlers, so a later unhandled rejection stops the
 * server. Etebase therefore loads only through dynamic import() in the browser
 * (see use-etebase-store and the Birthdays session).
 *
 * This walks the eager imports of every route entry and fails when one reaches
 * Etebase or libsodium. Importing the pages in a test cannot check this: Vite
 * evaluates everything the @silentsuite/core index re-exports, while webpack
 * keeps only the exports a module uses (core is "sideEffects": false), so the
 * core index is followed per imported name here, as the server bundle sees it.
 */

const WEB = path.resolve(__dirname, '../../..')
const CORE = path.resolve(WEB, '../../packages/core/src')
const UI = path.resolve(WEB, '../../packages/ui/src')
const CORE_INDEX = path.join(CORE, 'index.ts')
const FORBIDDEN = new Set(['package:etebase', 'package:libsodium', 'package:libsodium-wrappers'])
const ENTRY = /^(page|layout|template|loading|error|not-found|global-error|default|route)\.tsx?$/
const SCRIPT = /\.(ts|tsx|js|jsx|mjs)$/

type Edge = { specifier: string; names: string[] | 'all' }

function fileAt(base: string): string | null {
  const stem = base.replace(/\.js$/, '')
  const candidates = [`${stem}.ts`, `${stem}.tsx`, base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
}

function resolveSpecifier(specifier: string, from: string): string {
  let local: string | null = null
  if (specifier.startsWith('.')) local = path.resolve(path.dirname(from), specifier)
  else if (specifier.startsWith('@/')) local = path.join(WEB, specifier.slice(2))
  else if (specifier === '@silentsuite/core') return CORE_INDEX
  else if (specifier.startsWith('@silentsuite/core/')) local = path.join(CORE, specifier.slice('@silentsuite/core/'.length))
  else if (specifier === '@silentsuite/ui') local = path.join(UI, 'index')
  else if (specifier.startsWith('@silentsuite/ui/')) local = path.join(UI, specifier.slice('@silentsuite/ui/'.length))
  if (local === null) {
    const parts = specifier.split('/')
    return `package:${specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]}`
  }
  const file = fileAt(local)
  // Fail closed: an import the walker cannot follow could hide an Etebase path.
  if (!file) throw new Error(`cannot resolve ${specifier} from ${path.relative(WEB, from)}`)
  return file
}

function importNames(clause: ts.ImportClause): string[] | 'all' {
  const names: string[] = clause.name ? ['default'] : []
  const bindings = clause.namedBindings
  if (bindings && ts.isNamespaceImport(bindings)) return 'all'
  for (const element of bindings?.elements ?? []) {
    if (!element.isTypeOnly) names.push((element.propertyName ?? element.name).text)
  }
  return names
}

/** `ssr: false` keeps a next/dynamic component out of server rendering; anything else renders it there. */
function serverRendered(options: ts.Expression | undefined): boolean {
  if (!options || !ts.isObjectLiteralExpression(options)) return true
  return !options.properties.some((property) => ts.isPropertyAssignment(property)
    && ts.isIdentifier(property.name) && property.name.text === 'ssr'
    && property.initializer.kind === ts.SyntaxKind.FalseKeyword)
}

const edgeCache = new Map<string, Edge[]>()
function eagerEdges(file: string): Edge[] {
  const cached = edgeCache.get(file)
  if (cached) return cached
  const kind = /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, kind)
  const edges: Edge[] = []
  let dynamicName: string | null = null
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = (statement.moduleSpecifier as ts.StringLiteral).text
      const clause = statement.importClause
      if (!clause) {
        edges.push({ specifier, names: 'all' })
        continue
      }
      if (clause.isTypeOnly) continue
      if (specifier === 'next/dynamic' && clause.name) dynamicName = clause.name.text
      const names = importNames(clause)
      if (names === 'all' || names.length > 0) edges.push({ specifier, names })
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && !statement.isTypeOnly) {
      const specifier = (statement.moduleSpecifier as ts.StringLiteral).text
      const clause = statement.exportClause
      if (!clause || !ts.isNamedExports(clause)) {
        edges.push({ specifier, names: 'all' })
        continue
      }
      const names = clause.elements.filter((element) => !element.isTypeOnly).map((element) => (element.propertyName ?? element.name).text)
      if (names.length > 0) edges.push({ specifier, names })
    }
  }
  if (dynamicName) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === dynamicName
        && serverRendered(node.arguments[1])) {
        const collect = (inner: ts.Node): void => {
          if (ts.isCallExpression(inner) && inner.expression.kind === ts.SyntaxKind.ImportKeyword
            && inner.arguments[0] && ts.isStringLiteral(inner.arguments[0])) {
            edges.push({ specifier: inner.arguments[0].text, names: 'all' })
          }
          ts.forEachChild(inner, collect)
        }
        if (node.arguments[0]) collect(node.arguments[0])
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  edgeCache.set(file, edges)
  return edges
}

/** Exported name of the core index -> the file that defines it; null for a type-only export. */
const coreExports = new Map<string, string | null>()
for (const statement of ts.createSourceFile(CORE_INDEX, readFileSync(CORE_INDEX, 'utf8'), ts.ScriptTarget.Latest, true).statements) {
  if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) continue
  const clause = statement.exportClause
  if (!clause || !ts.isNamedExports(clause)) throw new Error('the core index re-exports a whole module; map it here')
  const file = resolveSpecifier((statement.moduleSpecifier as ts.StringLiteral).text, CORE_INDEX)
  for (const element of clause.elements) {
    coreExports.set(element.name.text, statement.isTypeOnly || element.isTypeOnly ? null : file)
  }
}

const dependencyCache = new Map<string, string[]>()
function dependencies(file: string): string[] {
  const cached = dependencyCache.get(file)
  if (cached) return cached
  const out = new Set<string>()
  for (const edge of eagerEdges(file)) {
    const target = resolveSpecifier(edge.specifier, file)
    if (target !== CORE_INDEX || file.startsWith(CORE)) {
      out.add(target)
      continue
    }
    const names = edge.names === 'all' ? [...coreExports.keys()] : edge.names
    for (const name of names) {
      if (!coreExports.has(name)) throw new Error(`${path.relative(WEB, file)} imports ${name}, which the core index does not export`)
      const defining = coreExports.get(name)
      if (defining) out.add(defining)
    }
  }
  const list = [...out]
  dependencyCache.set(file, list)
  return list
}

const label = (file: string): string => (file.startsWith('package:') ? file.slice('package:'.length) : path.relative(path.resolve(WEB, '../..'), file).split(path.sep).join('/'))

/** The first eager import chain from a file to Etebase or libsodium, or null. */
function chainToEtebase(start: string): string[] | null {
  const parent = new Map<string, string | null>([[start, null]])
  const queue = [start]
  while (queue.length > 0) {
    const file = queue.shift()!
    for (const next of dependencies(file)) {
      if (parent.has(next)) continue
      parent.set(next, file)
      if (FORBIDDEN.has(next)) {
        const chain: string[] = []
        for (let at: string | null = next; at !== null; at = parent.get(at) ?? null) chain.unshift(label(at))
        return chain
      }
      if (!next.startsWith('package:') && SCRIPT.test(next)) queue.push(next)
    }
  }
  return null
}

function routeEntries(): string[] {
  const entries: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(full)
      } else if (ENTRY.test(entry.name)) {
        entries.push(full)
      }
    }
  }
  walk(path.join(WEB, 'app'))
  for (const extra of ['middleware.ts', 'instrumentation.ts']) {
    if (existsSync(path.join(WEB, extra))) entries.push(path.join(WEB, extra))
  }
  return entries.sort()
}

describe('server page modules do not load Etebase', () => {
  const entries = routeEntries()

  it('finds the app route entries', () => {
    const labels = entries.map(label)
    expect(labels).toContain('apps/web/app/(app)/notes/page.tsx')
    expect(labels).toContain('apps/web/app/(app)/settings/sharing/page.tsx')
    expect(entries.length).toBeGreaterThan(20)
  })

  it('sees Etebase through the core index (control)', () => {
    // The Birthdays transport uses core collection helpers, which import the SDK,
    // so the session loads it with import() when a run starts.
    const chain = chainToEtebase(path.join(WEB, 'app/lib/birthday-calendar/etebase-transport.ts'))
    expect(chain).toContain('packages/core/src/etebase/collections.ts')
    expect(chain?.at(-1)).toBe('etebase')
  })

  it('no route entry reaches Etebase or libsodium through eager imports', () => {
    const offenders = entries
      .map((entry) => chainToEtebase(entry))
      .filter((chain): chain is string[] => chain !== null)
      .map((chain) => chain.join(' > '))
    expect(offenders).toEqual([])
  })
})
