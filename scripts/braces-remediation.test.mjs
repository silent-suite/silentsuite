import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

// Every braces call runs in its own bounded child so a stack overflow or hang cannot take down
// the test runner. braces is resolved the way Tailwind's micromatch loads it, never by store path.
const webRequire = createRequire(resolve(import.meta.dirname, '..', 'apps/web/package.json'))
const tailwindEntry = webRequire.resolve('tailwindcss')
const micromatchEntry = createRequire(tailwindEntry).resolve('micromatch')
const bracesEntry = createRequire(micromatchEntry).resolve('braces')

const childTimeoutMs = 15000
const marker = '@@braces-remediation-result@@'

function childMain() {
  const { readFileSync } = require('node:fs')
  const request = JSON.parse(readFileSync(0, 'utf8'))
  const frame = (result) => process.stdout.write(`\n${request.marker}${JSON.stringify(result)}\n`)
  let mod
  let loaded = false
  try {
    mod = require(request.entry)
    loaded = true
  } catch (error) {
    frame({ phase: 'load', name: error && error.name, message: String(error && error.message) })
  }
  if (loaded) {
    let result
    try {
      result = { phase: 'call', ok: true, value: new Function('mod', 'args', request.body)(mod, request.args) }
    } catch (error) {
      result = { phase: 'call', ok: false, name: error && error.name, message: String(error && error.message) }
    }
    frame(result)
  }
}

function runChild(body, args = [], entry = bracesEntry) {
  const child = spawnSync(process.execPath, ['-e', `(${childMain})()`], {
    input: JSON.stringify({ marker, entry, body, args }),
    encoding: 'utf8',
    timeout: childTimeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (child.error?.code === 'ETIMEDOUT' || child.signal) {
    throw new Error(`child did not finish within ${childTimeoutMs} ms (${child.signal ?? child.error.code})`)
  }
  if (child.error) throw child.error
  if (child.status !== 0) throw new Error(`child exited ${child.status}: ${child.stderr}`)
  if (child.stderr !== '') throw new Error(`unexpected child stderr: ${child.stderr}`)
  const frames = []
  for (const line of child.stdout.split('\n')) {
    if (line === '') continue
    if (line.startsWith(marker)) frames.push(JSON.parse(line.slice(marker.length)))
    // braces 3.0.3 lib/compile.js:19 logs this line for unclosed braces; it is not a result.
    else if (!line.startsWith('node.isClose ')) throw new Error(`unexpected child output: ${line.slice(0, 120)}`)
  }
  if (frames.length !== 1) throw new Error(`expected one result frame, got ${frames.length}`)
  if (frames[0].phase === 'load') throw new Error(`child could not load ${entry}: ${frames[0].message}`)
  return frames[0]
}

function preview(value) {
  const text = JSON.stringify(value) ?? String(value)
  return text.length > 80 ? `${text.slice(0, 80)}… (${text.length} chars)` : text
}

function assertValue(result, expected) {
  assert.equal(result.ok, true, `threw ${result.name}: ${result.message}`)
  assert.deepEqual(result.value, expected)
}

function assertDepthRejected(result, errorName) {
  assert.equal(result.ok, false, `accepted: ${preview(result.value)}`)
  assert.doesNotMatch(result.message, /Maximum call stack size exceeded/, `${result.name}: ${result.message}`)
  assert.equal(result.name, errorName, result.message)
  assert.match(result.message, /exceeds max depth/)
}

const apis = {
  'braces()': 'return mod(args[0])',
  'braces.parse': 'return mod.parse(args[0]).type',
  'braces.compile': 'return mod.compile(args[0])',
  'braces.expand': 'return mod.expand(args[0])',
  'braces.stringify': 'return mod.stringify(args[0])',
}

const nestedBraces = (depth) => `${'{'.repeat(depth)}a,b${'}'.repeat(depth)}`
const nestedParens = (depth) => `${'('.repeat(depth)}a${')'.repeat(depth)}`
function alternating(depth) {
  const openers = Array.from({ length: depth }, (_, index) => (index % 2 === 0 ? '{' : '(')).join('')
  const closers = [...openers].reverse().map((opener) => (opener === '{' ? '}' : ')')).join('')
  return `${openers}a,b${closers}`
}

// Ordinary acyclic AST in the parser's shape: depth 0 is the root passed to the walker, each
// brace (levels 1..depth) carries open/close leaves around its child, and the innermost child
// is a text leaf without nodes. Built fresh in every child because the walkers mark nodes.
const directAst = `
  let node = { type: 'text', value: 'a' }
  for (let level = 0; level < args[0]; level++) {
    node = { type: 'brace', nodes: [{ type: 'open', value: '{' }, node, { type: 'close', value: '}' }] }
  }
  const ast = { type: 'root', nodes: [node] }
`
const astWalkers = {
  'braces.compile': `${directAst} return mod.compile(ast)`,
  'braces.expand': `${directAst} return mod.expand(ast)`,
  'braces.stringify': `${directAst} return mod.stringify(ast)`,
}

test('harness resolves braces 3.0.3 through Tailwind micromatch', () => {
  let dir = dirname(bracesEntry)
  while (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name !== 'braces') dir = dirname(dir)
  assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version, '3.0.3')
})

test('harness runs a depth-3 call to completion', () => {
  assertValue(runChild('return mod(args[0])', ['{{{a,b}}}']), ['{{(a|b)}}'])
})

test('harness reports an injected throw as that throw', () => {
  const result = runChild("throw new TypeError('injected harness failure')")
  assert.equal(result.ok, false)
  assert.equal(result.name, 'TypeError')
  assert.equal(result.message, 'injected harness failure')
})

test('harness kills a hung child at the 15s bound and fails', () => {
  assert.throws(() => runChild('for (;;) {}'), /child did not finish within 15000 ms/)
})

test('harness fails on unexpected child output and on a module that cannot load', () => {
  assert.throws(() => runChild("console.log('stray'); return 1"), /unexpected child output: stray/)
  assert.throws(() => runChild('return 1', [], join(import.meta.dirname, 'missing-braces-entry.js')), /child could not load/)
})

test('preserves depth-3 string results on every API', () => {
  assertValue(runChild(apis['braces()'], ['{{{a}}}']), ['{{{a}}}'])
  assertValue(runChild(apis['braces.parse'], ['{{{a}}}']), 'root')
  assertValue(runChild(apis['braces.compile'], ['{{{a}}}']), '{{{a}}}')
  assertValue(runChild(apis['braces.expand'], ['{{{a}}}']), ['{{{a}}}'])
  assertValue(runChild(apis['braces.stringify'], ['{{{a}}}']), '{{{a}}}')
})

test('preserves depth-100 string results on every API', () => {
  const input = nestedBraces(100)
  assert.equal(input.length, 203)
  const enclosed = (inner) => `${'{'.repeat(99)}${inner}${'}'.repeat(99)}`
  assertValue(runChild(apis['braces()'], [input]), [enclosed('(a|b)')])
  assertValue(runChild(apis['braces.parse'], [input]), 'root')
  assertValue(runChild(apis['braces.compile'], [input]), enclosed('(a|b)'))
  assertValue(runChild(apis['braces.expand'], [input]), [enclosed('a'), enclosed('b')])
  assertValue(runChild(apis['braces.stringify'], [input]), input)
  assertValue(runChild(apis['braces.parse'], [nestedParens(100)]), 'root')
  assertValue(runChild(apis['braces.parse'], [alternating(100)]), 'root')
})

for (const [api, body] of Object.entries(astWalkers)) {
  test(`preserves ${api} output for an ordinary depth-100 direct AST`, () => {
    const expected = `${'{'.repeat(100)}a${'}'.repeat(100)}`
    assertValue(runChild(body, [100]), api === 'braces.expand' ? [expected] : expected)
    assertValue(runChild(body, [3]), api === 'braces.expand' ? ['{{{a}}}'] : '{{{a}}}')
  })
}

test('preserves ordinary alternation, range, escape, nesting and bracket results', () => {
  assertValue(runChild(apis['braces()'], ['a/{b,c}/d']), ['a/(b|c)/d'])
  assertValue(runChild(apis['braces.compile'], ['a/{b,c}/d']), 'a/(b|c)/d')
  assertValue(runChild(apis['braces.expand'], ['a/{b,c}/d']), ['a/b/d', 'a/c/d'])
  assertValue(runChild(apis['braces.stringify'], ['a/{b,c}/d']), 'a/{b,c}/d')
  assertValue(runChild(apis['braces()'], ['{1..3}']), ['([1-3])'])
  assertValue(runChild(apis['braces()'], ['\\{a\\}']), ['{a}'])
  assertValue(runChild(apis['braces()'], ['{a,{b,c}}']), ['(a|(b|c))'])
  assertValue(runChild(apis['braces()'], ['foo/{a,[bc],d}/bar']), ['foo/(a|[bc]|d)/bar'])
  assertValue(runChild(apis['braces()'], ['src/[abc].js']), ['src/[abc].js'])
})

test('preserves escaped, quoted and bracketed brace runs as text beyond depth 100', () => {
  const run = '{'.repeat(150)
  assertValue(runChild(apis['braces()'], ['\\{'.repeat(150)]), [run])
  assertValue(runChild(apis['braces()'], [`"${run}"`]), [run])
  assertValue(runChild(apis['braces()'], [`[${run}]`]), [`[${run}]`])
})

test('preserves quote, escapeInvalid, nodupes and noempty options', () => {
  assertValue(runChild(apis['braces()'], ['a/{"b"}/c']), ['a/{b}/c'])
  assertValue(runChild("return mod(args[0], { keepQuotes: true })", ['a/{"b"}/c']), ['a/{"b"}/c'])
  assertValue(runChild("return mod(args[0], { escapeInvalid: true })", ['a/{b}/c']), ['a/\\{b\\}/c'])
  assertValue(runChild("return mod(args[0], { expand: true, nodupes: true })", ['{a,a}']), ['a'])
  assertValue(runChild("return mod.expand(args[0], { noempty: true })", ['{a,}']), ['a'])
})

test('preserves the Tailwind content glob through braces and micromatch', () => {
  const glob = 'app/**/*.{js,ts,jsx,tsx,mdx}'
  assertValue(runChild(apis['braces()'], [glob]), ['app/**/*.(js|ts|jsx|tsx|mdx)'])
  assertValue(runChild(apis['braces.compile'], [glob]), 'app/**/*.(js|ts|jsx|tsx|mdx)')
  assertValue(runChild(apis['braces.expand'], [glob]),
    ['app/**/*.js', 'app/**/*.ts', 'app/**/*.jsx', 'app/**/*.tsx', 'app/**/*.mdx'])
  assertValue(runChild('return mod.isMatch(args[0], args[1])', ['app/(app)/settings/page.tsx', glob], micromatchEntry), true)
  assertValue(runChild('return mod.isMatch(args[0], args[1])', ['app/globals.css', glob], micromatchEntry), false)
})

test('preserves fast-glob and chokidar consumer option objects', () => {
  // fast-glob 3.3.1, then 3.3.2/3.3.3 (keepEscaping), via micromatch.braces; chokidar calls
  // braces.expand(path) without options.
  assertValue(runChild('return mod.braces(args[0], { expand: true, nodupes: true })', ['a/{b,c}/d'], micromatchEntry),
    ['a/b/d', 'a/c/d'])
  const fastGlob33 = 'return mod.braces(args[0], { expand: true, nodupes: true, keepEscaping: true })'
  assertValue(runChild(fastGlob33, ['a/{b,c}/d'], micromatchEntry), ['a/b/d', 'a/c/d'])
  assertValue(runChild(fastGlob33, ['\\{a,b\\}'], micromatchEntry), ['\\{a,b\\}'])
  assertValue(runChild('return mod.expand(args[0])', ['a/{b,c}/d']), ['a/b/d', 'a/c/d'])
})

test('preserves the maxLength 10000/10001, lowered and raised contract', () => {
  assertValue(runChild(apis['braces.parse'], ['a'.repeat(10000)]), 'root')
  const tooLong = runChild(apis['braces.parse'], ['a'.repeat(10001)])
  assert.deepEqual([tooLong.name, tooLong.message], ['SyntaxError', 'Input length (10001), exceeds max characters (10000)'])
  const lowered = runChild('return mod.parse(args[0], { maxLength: 5 }).type', ['abcdef'])
  assert.deepEqual([lowered.name, lowered.message], ['SyntaxError', 'Input length (6), exceeds max characters (5)'])
  const raised = runChild('return mod.parse(args[0], { maxLength: 20000 }).type', ['a'.repeat(10001)])
  assert.deepEqual([raised.name, raised.message], ['SyntaxError', 'Input length (10001), exceeds max characters (10000)'])
})

test('preserves the non-string TypeError and rangeLimit RangeError', () => {
  const type = runChild('return mod.parse(42)')
  assert.deepEqual([type.name, type.message], ['TypeError', 'Expected a string'])
  const range = runChild(apis['braces.expand'], ['{1..1001}'])
  assert.deepEqual([range.name, range.message], ['RangeError',
    'expanded array length exceeds range limit. Use options.rangeLimit to increase or disable the limit.'])
  assertValue(runChild('return mod.expand(args[0]).length', ['{1..1000}']), 1000)
  assertValue(runChild(apis['braces()'], ['{1..1001}']), ['([1-9]|[1-9][0-9]{1,2}|100[01])'])
})

for (const [shape, input] of [
  ['brace', nestedBraces(101)],
  ['paren', nestedParens(101)],
  ['alternating brace/paren', alternating(101)],
]) {
  for (const [api, body] of Object.entries(apis)) {
    test(`rejects depth-101 ${shape} nesting through ${api}`, () => {
      assertDepthRejected(runChild(body, [input]), 'SyntaxError')
    })
  }
}

for (const [api, body] of Object.entries(apis)) {
  test(`rejects the 9999-character, 4998-deep pattern through ${api} without stack overflow`, () => {
    const input = nestedBraces(4998)
    assert.equal(input.length, 9999)
    assertDepthRejected(runChild(body, [input]), 'SyntaxError')
  })
}

for (const [api, body] of Object.entries(astWalkers)) {
  test(`rejects an ordinary depth-101 direct AST through ${api} without parsing`, () => {
    assertDepthRejected(runChild(body, [101]), 'RangeError')
  })
}
