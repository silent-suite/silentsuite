import assert from 'node:assert/strict'
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
  assert.equal(sharp.versions.sharp, '0.35.4')
  assert.equal(sharp.versions.heif, '1.23.2')
  assert.equal(requireFrom('package.json')('sharp').versions.sharp, '0.35.4')
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
