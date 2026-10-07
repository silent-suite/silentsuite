import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'

function requireFrom(packagePath) {
  return createRequire(resolve(import.meta.dirname, '..', packagePath))
}

// Bounded wait: rejects instead of hanging when a handshake never settles, and always
// clears its timer so a settled wait cannot keep the test process alive.
function boundedWait(promise, ms, message) {
  let timer
  const expiration = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, expiration]).finally(() => clearTimeout(timer))
}

const minimatch3Require = requireFrom('node_modules/.pnpm/minimatch@3.1.5/node_modules/minimatch/package.json')
const minimatch5Require = requireFrom('node_modules/.pnpm/minimatch@5.1.9/node_modules/minimatch/package.json')
const minimatch10Require = requireFrom('node_modules/.pnpm/minimatch@10.2.4/node_modules/minimatch/package.json')
const minimatch3 = minimatch3Require('.')
const minimatch5 = minimatch5Require('.')
const minimatch10 = minimatch10Require('.').minimatch
const ajvRequire = requireFrom('node_modules/.pnpm/ajv@8.18.0/node_modules/ajv/package.json')
const Ajv = ajvRequire('.')
const addFormats = requireFrom('node_modules/.pnpm/ajv-formats@2.1.1_ajv@8.18.0/node_modules/ajv-formats/package.json')('.')
const { JSDOM } = requireFrom('apps/web/package.json')('jsdom')
const undiciRequire = createRequire(requireFrom('apps/web/package.json').resolve('jsdom'))
const undici = undiciRequire('undici')
const eslintRequire = createRequire(requireFrom('apps/web/package.json').resolve('eslint/package.json'))
const yamlRequire = createRequire(eslintRequire.resolve('@eslint/eslintrc'))
const yaml = yamlRequire('js-yaml')
const { customAlphabet, nanoid } = requireFrom('node_modules/.pnpm/nanoid@3.3.18/node_modules/nanoid/package.json')('.')
const browserslist = requireFrom('node_modules/.pnpm/browserslist@4.28.8/node_modules/browserslist/package.json')('.')
const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8'))

for (const [line, minimatch] of [['3', minimatch3], ['5', minimatch5], ['10', minimatch10]]) {
  test(`minimatch ${line} preserves brace alternation, ranges, escapes, matches, and non-matches`, () => {
    assert.equal(minimatch('src/a.js', 'src/{a,b}.js'), true)
    assert.equal(minimatch('file3.txt', 'file{1..3}.txt'), true)
    assert.equal(minimatch('file4.txt', 'file{1..3}.txt'), false)
    assert.equal(minimatch('literal{a}.txt', 'literal\\{a\\}.txt'), true)
    assert.equal(minimatch('src/c.js', 'src/{a,b}.js'), false)
  })
}

for (const [line, minimatch, minimatchRequire, braceVersion] of [
  ['3', minimatch3, minimatch3Require, '1.1.21'],
  ['5', minimatch5, minimatch5Require, '2.1.7'],
  ['10', minimatch10, minimatch10Require, '5.0.12'],
]) {
  test(`minimatch ${line} expands deeply nested brace groups without exhausting the stack`, () => {
    assert.equal(minimatchRequire('brace-expansion/package.json').version, braceVersion)
    const depth = 30000
    const pattern = `${'{'.repeat(depth)}a,b${'}'.repeat(depth)}`
    assert.equal(minimatch('src/a.js', pattern), false)
  })
}

test('braces 3.0.3 expands the static apps/web tailwind content globs through its tooling consumers', () => {
  const webRequire = requireFrom('apps/web/package.json')
  const tailwindRequire = createRequire(webRequire.resolve('tailwindcss/package.json'))
  const pwaRequire = createRequire(webRequire.resolve('@ducanh2912/next-pwa'))
  for (const consumerRequire of [
    createRequire(tailwindRequire.resolve('micromatch')),
    createRequire(tailwindRequire.resolve('chokidar')),
    createRequire(pwaRequire.resolve('fast-glob')),
  ]) {
    const consumerBraces = consumerRequire.resolve('braces/package.json')
    assert.equal(JSON.parse(readFileSync(consumerBraces, 'utf8')).version, '3.0.3')
  }

  const micromatch = tailwindRequire('micromatch')
  const fastGlob = tailwindRequire('fast-glob')
  const pattern = 'app/**/*.{js,ts,jsx,tsx,mdx}'
  assert.equal(micromatch.isMatch('app/(app)/settings/page.tsx', pattern), true)
  assert.equal(micromatch.isMatch('app/globals.css', pattern), false)
  const matches = fastGlob.sync(pattern, { cwd: resolve(import.meta.dirname, '..', 'apps/web') })
  assert.ok(matches.includes('app/layout.tsx'))
  assert.ok(matches.every((file) => /\.(js|ts|jsx|tsx|mdx)$/.test(file)))
})

test('AJV 8 validates URI format through patched fast-uri', () => {
  const ajv = new Ajv({ strict: false })
  addFormats(ajv)
  const validate = ajv.compile({ type: 'string', format: 'uri' })
  assert.equal(validate('https://silent-suite.example/path?item=1'), true)
  assert.equal(validate('not a uri'), false)
})

test('AJV 8 resolves schema references through its patched fast-uri resolver', () => {
  assert.equal(ajvRequire('fast-uri/package.json').version, '3.1.8')
  const ajv = new Ajv({ strict: false })
  assert.equal(ajv.opts.uriResolver, ajvRequire('fast-uri'))
  ajv.addSchema({
    $id: 'https://silent-suite.example/schemas/defs.json',
    $defs: { name: { type: 'string', minLength: 1 } },
  })
  const validate = ajv.compile({
    $id: 'https://silent-suite.example/schemas/root.json',
    $ref: 'defs.json#/$defs/name',
  })
  assert.equal(validate('calendar'), true)
  assert.equal(validate(''), false)
})

test('fast-uri 3 rejects authority injection through a malformed serialize port', () => {
  const uri = new Ajv({ strict: false }).opts.uriResolver
  assert.throws(() => uri.serialize({
    scheme: 'https',
    host: 'silent-suite.example',
    port: '443@attacker.example',
    path: '/path',
  }), { name: 'TypeError', message: /port is malformed/ })
  for (const port of [8443, '8443']) {
    assert.equal(
      uri.serialize({ scheme: 'https', host: 'silent-suite.example', port, path: '/path' }),
      'https://silent-suite.example:8443/path',
    )
  }
})

test('fast-uri 3 flags an unclosed bracket host and keeps closed IP literals', () => {
  const uri = new Ajv({ strict: false }).opts.uriResolver
  assert.equal(uri.parse('https://[attacker.example/path').error, 'URI host is malformed.')
  const literal = uri.parse('https://[::1]:8443/path')
  assert.equal(literal.error, undefined)
  assert.equal(literal.host, '::1')
  assert.equal(literal.port, 8443)
})

test('fast-uri 3 folds percent-encoded host octets to one canonical case', () => {
  const uri = new Ajv({ strict: false }).opts.uriResolver
  assert.equal(uri.normalize('https://silent-suite.%45xample/path'), 'https://silent-suite.example/path')
  assert.equal(uri.equal('https://silent-suite.%45xample/path', 'https://silent-suite.example/path'), true)
})

test('jsdom constructs and tears down through its patched undici dependency path', () => {
  const dom = new JSDOM('<!doctype html><p id="status">ready</p>', { url: 'https://silent-suite.example/' })
  assert.equal(dom.window.document.querySelector('#status')?.textContent, 'ready')
  assert.equal(dom.window.location.origin, 'https://silent-suite.example')
  dom.window.close()
})

test('jsdom undici 7 fails a WebSocket handshake that selects an unrequested subprotocol', async () => {
  assert.equal(undiciRequire('undici/package.json').version, '7.29.1')
  const upgradeSockets = new Set()
  const server = createServer()
  server.on('upgrade', (request, socket) => {
    upgradeSockets.add(socket)
    socket.on('error', () => {})
    const accept = createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      'Sec-WebSocket-Protocol: unrequested',
      '',
      '',
    ].join('\r\n'))
  })

  const events = []
  let client
  let onOpen
  let onError
  let onClose

  const teardown = () => {
    if (client) {
      client.removeEventListener('open', onOpen)
      client.removeEventListener('error', onError)
      client.removeEventListener('close', onClose)
      try {
        client.close()
      } catch {}
    }
    for (const socket of upgradeSockets) socket.destroy()
    upgradeSockets.clear()
    return server.listening ? new Promise((done) => server.close(() => done())) : Promise.resolve()
  }

  try {
    await boundedWait(new Promise((listening, failed) => {
      server.once('error', failed)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', failed)
        listening()
      })
    }), 2000, 'test server did not start listening')

    client = new undici.WebSocket(`ws://127.0.0.1:${server.address().port}`)
    const opened = new Promise((resolve) => { onOpen = () => { events.push('open'); resolve() } })
    const errored = new Promise((resolve) => { onError = () => { events.push('error'); resolve() } })
    const closed = new Promise((resolve) => { onClose = (event) => resolve(event) })
    client.addEventListener('open', onOpen)
    client.addEventListener('error', onError)
    client.addEventListener('close', onClose)

    await boundedWait(Promise.race([opened, errored]), 5000, 'the rejected handshake neither opened nor errored')
    assert.equal(events.includes('error'), true, 'the rejected handshake must surface an error event')
    const close = await boundedWait(closed, 5000, 'the rejected handshake did not close the socket')
    assert.deepEqual(events, ['error'])
    assert.equal(close.code, 1006)
    assert.equal(client.protocol, '')
  } finally {
    await teardown()
  }
})

test('a peer that accepts the upgrade and never answers is bounded and cleaned up', async () => {
  const acceptedSockets = new Set()
  const server = createServer()
  server.on('upgrade', (request, socket) => {
    acceptedSockets.add(socket)
    socket.on('error', () => {})
    // Deliberately never answer, so the client handshake stays pending.
  })
  const events = []
  let client

  try {
    await boundedWait(new Promise((listening, failed) => {
      server.once('error', failed)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', failed)
        listening()
      })
    }), 2000, 'test server did not start listening')

    client = new undici.WebSocket(`ws://127.0.0.1:${server.address().port}`)
    const settled = new Promise((resolve) => {
      client.addEventListener('open', () => { events.push('open'); resolve() })
      client.addEventListener('error', () => { events.push('error'); resolve() })
    })
    await assert.rejects(
      boundedWait(settled, 250, 'the pending handshake was not bounded'),
      /the pending handshake was not bounded/,
    )
    assert.deepEqual(events, [])
  } finally {
    if (client) {
      try {
        client.close()
      } catch {}
    }
    for (const socket of acceptedSockets) socket.destroy()
    acceptedSockets.clear()
    if (server.listening) await new Promise((done) => server.close(() => done()))
  }
})

test('jsdom undici 7 BalancedPool forwards connect options to its upstream pools', async () => {
  const checkServerIdentity = () => undefined
  const upstreams = []
  const pool = new undici.BalancedPool(['https://silent-suite.example'], {
    connect: { rejectUnauthorized: true, checkServerIdentity },
    factory: (origin, options) => {
      upstreams.push(options)
      return new undici.Pool(origin, options)
    },
  })
  try {
    assert.equal(upstreams.length, 1)
    assert.equal(upstreams[0].connect.rejectUnauthorized, true)
    assert.equal(upstreams[0].connect.checkServerIdentity, checkServerIdentity)
  } finally {
    await pool.close()
  }
})

test('js-yaml 4 parses representative ESLint configuration data', () => {
  assert.deepEqual(yaml.load('rules:\n  no-debugger: error\n'), {
    rules: { 'no-debugger': 'error' },
  })
})

test('js-yaml counts empty merge mappings against the CPU budget', () => {
  assert.equal(yamlRequire('js-yaml/package.json').version, '4.3.2')
  assert.throws(() => yaml.load('arr: &arr [{}, {}, {}]\ntarget: { <<: *arr }\n', {
    maxTotalMergeKeys: 2,
  }), /merge/i)
})

test('Next and its ESLint config stay on the patched compatible release', () => {
  const web = requireFrom('apps/web/package.json')
  assert.equal(web('next/package.json').version, '15.5.24')
  assert.equal(web('eslint-config-next/package.json').version, '15.5.24')
})

test('Next resolves patched Sharp and transforms image data with patched libheif', async () => {
  const web = requireFrom('apps/web/package.json')
  const nextRequire = createRequire(web.resolve('next/package.json'))
  const sharp = nextRequire('sharp')
  assert.equal(sharp.versions.sharp, '0.35.5')
  assert.equal(sharp.versions.heif, '1.23.5')
  assert.equal(requireFrom('package.json')('sharp').versions.sharp, '0.35.5')
  const image = sharp({ create: { width: 4, height: 4, channels: 3, background: '#123456' } })
  const avif = await image.avif().toBuffer()
  const { info } = await sharp(avif).resize(2, 2).png().toBuffer({ resolveWithObject: true })
  assert.equal(info.width, 2)
  assert.equal(info.height, 2)
  assert.equal(info.format, 'png')
})

test('nanoid 3 patched generators preserve normal positive-size behavior', () => {
  assert.equal(nanoid(12).length, 12)
  assert.match(customAlphabet('abc', 8)(), /^[abc]{8}$/)
})

test('browserslist 4 resolves representative production targets', () => {
  const targets = browserslist('last 2 versions')
  assert.ok(targets.length > 0)
  assert.ok(targets.every((target) => typeof target === 'string' && target.length > 0))
})

test('security overrides remain scoped to compatible vulnerable major lines', () => {
  assert.equal(manifest.pnpm.overrides['js-yaml@>=4.0.0 <4.3.2'], '4.3.2')
  assert.equal(manifest.pnpm.overrides['js-yaml@>=3.0.0 <3.15.2'], '3.15.2')
  assert.equal(manifest.pnpm.overrides['nanoid@>=3.0.0 <3.3.18'], '3.3.18')
  assert.equal(manifest.pnpm.overrides['browserslist@>=4.0.0 <4.28.8'], '4.28.8')
  assert.equal(manifest.pnpm.overrides['fast-uri@>=2.0.0 <2.4.7'], '2.4.7')
  assert.equal(manifest.pnpm.overrides['fast-uri@>=3.0.0 <3.1.8'], '3.1.8')
  assert.equal(manifest.pnpm.overrides['fast-uri@>=4.0.0 <4.1.5'], '4.1.5')
  assert.deepEqual(Object.keys(manifest.pnpm.overrides).filter((selector) => selector.startsWith('fast-uri')), [
    'fast-uri@>=2.0.0 <2.4.7',
    'fast-uri@>=3.0.0 <3.1.8',
    'fast-uri@>=4.0.0 <4.1.5',
  ])
  assert.deepEqual(
    Object.entries(manifest.pnpm.overrides).filter(([selector]) => /^(undici|brace-expansion)(@|$)/.test(selector)),
    [
      ['undici@>=7.0.0 <7.29.1', '7.29.1'],
      ['undici@>=8.0.0 <8.10.2', '8.10.2'],
      ['brace-expansion@<1.1.21', '1.1.21'],
      ['brace-expansion@>=2.0.0 <2.1.7', '2.1.7'],
      ['brace-expansion@>=5.0.0 <5.0.12', '5.0.12'],
    ],
  )
  assert.deepEqual(
    Object.keys(manifest.pnpm.overrides).filter((selector) => /^brace-expansion@>=3\./.test(selector)),
    [],
    'no brace-expansion 3.x selector: GHSA-3jxr-9vmj-r5cp spans >=3.0.0 <5.0.7 with no patched 3.x release, so a 3.x consumer must fail the audit instead of being forced across a major',
  )
  assert.equal(Object.hasOwn(manifest.pnpm.overrides, 'brace-expansion@>=3.0.0 <3.0.9'), false)
  assert.equal(Object.hasOwn(manifest.pnpm.overrides, 'js-yaml'), false)
  assert.equal(Object.hasOwn(manifest.pnpm.overrides, 'nanoid@<3.3.18'), false)
  assert.equal(Object.hasOwn(manifest.pnpm.overrides, 'browserslist'), false)
})

// source-map-js (GHSA-68fv-2mgg-jv7q / CVE-2026-93749): a section's offset.line in an
// indexed source map is untrusted input. The pinned 1.2.1 graph never validates it and
// SourceNode.fromStringWithSourceMap pads generated lines one at a time up to the
// mapping's line, so one tiny section with a huge offset.line becomes attacker-sized
// synchronous work. PostCSS (web tooling) and @vue/compiler-sfc (docs tooling) resolve
// the same locked copy.
const sourceMapJsFromPostcss = createRequire(requireFrom('apps/web/package.json').resolve('postcss'))
const sourceMapJsFromVue = createRequire(
  createRequire(requireFrom('apps/docs/package.json').resolve('vue')).resolve('@vue/compiler-sfc'),
)
const sourceMapJs = sourceMapJsFromPostcss('source-map-js')

test('source-map-js resolves one locked copy through PostCSS and Vue compiler consumers and round-trips valid indexed maps', () => {
  const fromPostcss = sourceMapJsFromPostcss('source-map-js/package.json')
  const fromVue = sourceMapJsFromVue('source-map-js/package.json')
  assert.equal(fromPostcss.name, 'source-map-js')
  assert.equal(fromPostcss.version, fromVue.version, 'the web and docs toolchains must share one source-map-js version')

  const validMap = {
    version: 3,
    file: 'min.js',
    sections: [
      { offset: { line: 0, column: 0 }, map: { version: 3, sources: ['one.js'], sourcesContent: ['one'], names: [], mappings: 'AAAA' } },
      { offset: { line: 2, column: 0 }, map: { version: 3, sources: ['two.js'], sourcesContent: ['two'], names: [], mappings: 'AAAA' } },
    ],
  }
  const consumer = new sourceMapJs.SourceMapConsumer(validMap)
  assert.equal(consumer.originalPositionFor({ line: 1, column: 1 }).source, 'one.js')
  assert.equal(consumer.originalPositionFor({ line: 3, column: 1 }).source, 'two.js')

  const code = 'a\nb\nc\nd\n'
  const node = sourceMapJs.SourceNode.fromStringWithSourceMap(code, new sourceMapJs.SourceMapConsumer(validMap))
  assert.equal(node.toString(), code)
})

test('source-map-js rejects an overwhelming indexed section offset instead of blocking SourceNode.fromStringWithSourceMap', () => {
  // The adversarial operation below can synchronously block inside the pinned graph, so
  // it runs in a child bounded to a 128 MB heap and a hard 3 s SIGKILL. The child reports
  // "ready" through stdout only after resolving the real consumer chain, proving it
  // reached the vulnerable operation before any timeout or crash is judged.
  const childScript = [
    "const fs = require('node:fs');",
    "const { createRequire } = require('node:module');",
    `const webRequire = createRequire(${JSON.stringify(resolve(import.meta.dirname, '..', 'apps/web/package.json'))});`,
    "const postcssRequire = createRequire(webRequire.resolve('postcss'));",
    "const lib = postcssRequire('source-map-js');",
    "const version = postcssRequire('source-map-js/package.json').version;",
    "fs.writeSync(1, '#SMOKE#' + JSON.stringify({ stage: 'ready', version }) + '#SMOKE#');",
    'try {',
    "  const map = { version: 3, sections: [{ offset: { line: 1000000000, column: 0 }, map: { version: 3, sources: ['a.js'], sourcesContent: ['a'], names: [], mappings: 'AAAA' } }] };",
    '  const consumer = new lib.SourceMapConsumer(map);',
    "  const node = lib.SourceNode.fromStringWithSourceMap('var x;', consumer);",
    "  fs.writeSync(1, '#SMOKE#' + JSON.stringify({ stage: 'completed', length: node.toString().length }) + '#SMOKE#');",
    '} catch (error) {',
    "  fs.writeSync(1, '#SMOKE#' + JSON.stringify({ stage: 'rejected', name: error.name, message: error.message }) + '#SMOKE#');",
    '}',
  ].join('')

  const startedAt = Date.now()
  const result = spawnSync(process.execPath, ['--max-old-space-size=128', '-e', childScript], {
    timeout: 3000,
    killSignal: 'SIGKILL',
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })
  const waitedMs = Date.now() - startedAt

  const messages = (result.stdout ?? '')
    .split('#SMOKE#')
    .filter((segment, index) => index % 2 === 1)
    .map((segment) => {
      try {
        return JSON.parse(segment)
      } catch {
        return { stage: 'unparsed', segment: segment.slice(0, 120) }
      }
    })

  const ready = messages.find((message) => message.stage === 'ready')
  assert.ok(
    ready,
    [
      'the bounded source-map-js child never reached the vulnerable operation',
      `exit=${result.status}, signal=${result.signal}, error=${result.error?.code ?? 'none'}`,
      `stdout=${JSON.stringify((result.stdout ?? '').slice(0, 200))}`,
      `stderr=${JSON.stringify((result.stderr ?? '').slice(-200))}`,
    ].join('; '),
  )

  const settled = messages.find((message) => message.stage === 'completed' || message.stage === 'rejected')
  assert.ok(
    settled,
    [
      `a one-section indexed map with offset.line=1000000000 never settled under the bounded child after ${waitedMs} ms`,
      `exit=${result.status}, signal=${result.signal}, error=${result.error?.code ?? 'none'}`,
      `stderr=${JSON.stringify((result.stderr ?? '').slice(-200))}`,
      `the pinned source-map-js ${ready.version} ran attacker-sized synchronous work instead of rejecting the offset`,
    ].join('; '),
  )

  assert.equal(settled.stage, 'rejected', `the overwhelming indexed map must be rejected before any mapping work: ${JSON.stringify(settled)}`)
  assert.match(settled.message, /must not exceed/)
  assert.equal(result.status, 0, `the rejected map must exit cleanly: exit=${result.status}, signal=${result.signal}`)
  assert.equal(result.signal, null, `the rejected map must not be signalled: ${result.signal}`)
  assert.equal(result.error, undefined, `the rejected map must not surface a subprocess error: ${result.error?.code ?? 'none'}`)
})

test('source-map-js enforces bounded indexed section offsets', () => {
  const indexedMap = (offset) => ({
    version: 3,
    sections: [{ offset, map: { version: 3, sources: ['a.js'], sourcesContent: ['a'], names: [], mappings: 'AAAA' } }],
  })

  for (const invalidLine of [-1, 1.5, NaN, Infinity, '1']) {
    assert.throws(
      () => new sourceMapJs.SourceMapConsumer(indexedMap({ line: invalidLine, column: 0 })),
      /non-negative integers/,
      `offset.line=${String(invalidLine)} must be rejected as a non-negative integer`,
    )
  }

  assert.throws(
    () => new sourceMapJs.SourceMapConsumer(indexedMap({ line: 10000001, column: 0 })),
    /must not exceed/,
    'offset.line above the 1e7 bound must be rejected',
  )

  const consumer = new sourceMapJs.SourceMapConsumer(indexedMap({ line: 10000000, column: 0 }))
  assert.equal(consumer.originalPositionFor({ line: 10000001, column: 1 }).source, 'a.js')
})

// sharp (GHSA-wq5f-xc86-pv6w / CVE-2026-96889): the prebuilt sharp binaries bundle
// librsvg inside their @img/sharp-libvips platform packages. sharp <0.35.5 bundles a
// vulnerable librsvg (2.62.x); 0.35.5 provides librsvg 2.63.2 via libvips 1.3.4. This
// is a graph/native-boundary regression, not an exploit reproduction: it pins the
// patched bundled contract through the real Next and root consumers and proves the
// native SVG rasterization boundary still works end to end (alongside the retained
// PNG smoke in the Next/libheif test below).
function atLeastVersion(actual, expected) {
  const actualParts = String(actual).split('.').map(Number)
  const expectedParts = String(expected).split('.').map(Number)
  for (let index = 0; index < Math.max(actualParts.length, expectedParts.length); index++) {
    const left = actualParts[index] ?? 0
    const right = expectedParts[index] ?? 0
    if (left !== right) return left > right
  }
  return true
}

test('Next and root Sharp resolve the patched bundled native contract and rasterize a deterministic SVG', async () => {
  const web = requireFrom('apps/web/package.json')
  const nextRequire = createRequire(web.resolve('next/package.json'))
  const rootRequire = requireFrom('package.json')
  const platformPackages = process.platform === 'linux'
    ? [`@img/sharp-libvips-linux-${process.arch}`, `@img/sharp-libvips-linuxmusl-${process.arch}`]
    : [`@img/sharp-libvips-${process.platform}-${process.arch}`]
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#cc0000"/></svg>',
  )

  for (const [label, sharpModule, sharpRequire] of [
    ['next', nextRequire('sharp'), createRequire(nextRequire.resolve('sharp'))],
    ['root', rootRequire('sharp'), createRequire(rootRequire.resolve('sharp'))],
  ]) {
    let libvipsManifest = null
    let libvipsVersions = null
    for (const platformPackage of platformPackages) {
      try {
        libvipsManifest = sharpRequire(`${platformPackage}/package`)
        libvipsVersions = sharpRequire(`${platformPackage}/versions`)
        break
      } catch {}
    }
    assert.ok(libvipsManifest, `${label} consumer must resolve its bundled libvips platform package`)
    assert.ok(
      atLeastVersion(libvipsManifest.version, '1.3.4'),
      `${label} bundled libvips platform package must be at least 1.3.4 (found ${libvipsManifest.version})`,
    )
    assert.ok(
      atLeastVersion(libvipsVersions.rsvg, '2.63.2'),
      `${label} bundled librsvg must be at least 2.63.2 (found ${libvipsVersions.rsvg})`,
    )
    assert.equal(sharpModule.versions.sharp, '0.35.5', `${label} consumer must resolve the patched sharp 0.35.5`)

    const rendered = await sharpModule(svg).png().toBuffer({ resolveWithObject: true })
    assert.equal(rendered.info.width, 16, `${label} SVG rasterization must keep its width`)
    assert.equal(rendered.info.height, 16, `${label} SVG rasterization must keep its height`)
    const decoded = await sharpModule(rendered.data).raw().toBuffer({ resolveWithObject: true })
    const center = (Math.floor(decoded.info.height / 2) * decoded.info.width + Math.floor(decoded.info.width / 2)) * decoded.info.channels
    assert.ok(decoded.info.channels >= 3, `${label} decoded PNG must expose RGB channels`)
    assert.ok(Math.abs(decoded.data[center] - 0xcc) <= 1, `${label} center pixel red channel`)
    assert.ok(Math.abs(decoded.data[center + 1]) <= 1, `${label} center pixel green channel`)
    assert.ok(Math.abs(decoded.data[center + 2]) <= 1, `${label} center pixel blue channel`)
  }
})

// @vue/server-renderer (GHSA-g2v6-rqmx-r4w6): ssrRenderAttrs and ssrRenderDynamicAttr
// screen attribute names against a character blacklist before splicing them into the SSR
// response. The 3.5.30 blacklist misses carriage return (U+000D), so a bound attribute
// name can smuggle CR into the emitted HTML; the fixed blacklist rejects the name and
// skips the attribute instead.
const vueFromDocs = createRequire(requireFrom('apps/docs/package.json').resolve('vue'))
const vueServerRenderer = vueFromDocs('@vue/server-renderer')

test('@vue/server-renderer bound attributes keep escaping valid names and values', () => {
  assert.equal(vueServerRenderer.ssrRenderAttrs({ id: 'safe', title: 'a"b<c' }), ' id="safe" title="a&quot;b&lt;c"')
  assert.equal(vueServerRenderer.ssrRenderDynamicAttr('title', 'a"b<c'), ' title="a&quot;b&lt;c"')
})

test('@vue/server-renderer rejects carriage-return attribute names', () => {
  assert.equal(vueServerRenderer.ssrRenderAttrs({ id: 'safe', ['x\rautofocus\ronfocus']: 'alert(1)' }), ' id="safe"')
  assert.equal(vueServerRenderer.ssrRenderDynamicAttr('x\rautofocus\ronfocus', 'alert(1)'), '')
})
